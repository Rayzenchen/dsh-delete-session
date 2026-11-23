/**
 * Host half of `@local/dsh-delete-session`.
 *
 * Purpose: permanently remove one stored Session (its whole on-disk session
 * directory, its projection-cache record and its workspace-registry records)
 * when the user confirms the delete action in the sidebar's session menu.
 *
 * The Harness still has no delete API, so this plugin owns the storage side
 * itself and takes the same safety posture the shipped archive path takes.
 * Re-verified against 0.2.2-rc.5: `sessionPersistence` is
 * create/open/flush/stat/list; `sessionController` exposes 19 methods (list,
 * search, create, selectModel, rename, fork, prompt, attachment, updateQueue,
 * cancel, events, observeEvent, observeProjections, state, observeState, wait,
 * follow, projections, control) and none of them deletes or disposes a Session;
 * `Agent` exposes only `id`. Both package READMEs still describe pruning stored
 * Sessions as out-of-band maintenance. That is also why the live-object
 * bookkeeping below (`ghostIds`) cannot be replaced by a dispose call.
 *
 *   - every refusal happens BEFORE anything is touched;
 *   - a session that is actually WORKING refuses by default — a running Agent, or
 *     work reported through the shipped `workspace/session-activity` waterfall
 *     (turn, job, subagent, schedule) — and the UI then offers to stop that work
 *     and continue. Merely having been opened is not work: a loaded but idle
 *     session deletes normally, without a restart;
 *   - before the bytes go, every live Session among the targets is flushed
 *     (`ctx.sessions.flush`) so no buffered event is stranded on a path that is
 *     about to disappear (the JSONL write path re-opens the log per append), and
 *     a `stopActivity` delete waits, bounded, for the cancelled turn to unwind;
 *   - the session id is re-validated and the target directory is resolved from
 *     the stored header (never from client-supplied paths), then proven to be a
 *     real directory inside the sessions root, with symlinks rejected;
 *   - after the bytes are gone the plugin emits `api-session/removed`, the
 *     documented Host→Client notice the session controller itself emits on
 *     `session/disposed`, so the sidebar row disappears without a reload;
 *   - the route reuses the deployment's own request trust model through
 *     `connection.admit()` when that service is mounted, so it does not invent a
 *     second security policy beside the shipped `/api` carrier.
 *
 * The Client half calls the single POST route below.
 */
import { closeSync, constants as fsConstants, lstatSync, openSync, realpathSync, writeSync } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/** Cordis plugin name (also the loader row id used by `cordis.patch.yml`). */
export const name = 'dsh-delete-session'

/** The one service this plugin cannot work without: the browser HTTP carrier. */
export const inject = ['webServer']

/** Endpoint the Client half POSTs to. */
const ROUTE_PATH = '/plugins/dsh-delete-session/delete'
/** Custom header a cross-site caller cannot send without a preflight we never answer. */
const REQUIRED_HEADER = 'dsh-delete-session'
/** Sessions ids are opaque branded strings; the storage layer escapes them, but we refuse anything else outright. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/
const MAX_BODY_BYTES = 4096
/**
 * Plugin version, reported on every response and in every diagnostic line.
 *
 * Kept identical to `package.json` `version` and to the Client half's `CLIENT_BUILD`
 * so that a probe (or a log line) identifies exactly one released generation. Bump
 * all three together: a Host/page mismatch then means a stale browser bundle.
 */
const BUILD = '1.0.0'

/**
 * Ids this host run deleted.
 *
 * A resumed Session is owned by the Agent registry's own long-lived context
 * (`agents.resume` registers on the service context), so no plugin can dispose it,
 * and `sessionQuery.listSessions()` merges live Sessions with the stored ones —
 * a Session whose bytes are gone but whose object is still live keeps being listed.
 *
 * Every deleted id is remembered, not only the ones that happened to look live at
 * the end of the delete: liveness can change at any point during the request (the
 * Client releases retention as soon as it learns the Session is gone), and an id
 * that was cold can be resumed later. Session ids are never reused, so remembering
 * all of them is safe; `ghostsFor` then re-checks the filesystem, which is the
 * fact that actually matters.
 */
const ghostIds = new Set()

/** Append-only diagnostics under the system temp dir; capped, best effort, never fatal. */
const DIAGNOSTICS_PATH = typeof process.env.DSH_DELETE_SESSION_DIAGNOSTICS === 'string' && process.env.DSH_DELETE_SESSION_DIAGNOSTICS.length > 0
  ? process.env.DSH_DELETE_SESSION_DIAGNOSTICS
  : join(tmpdir(), 'dsh-delete-session-diagnostics.jsonl')
const DIAGNOSTICS_MAX_BYTES = 256 * 1024

function diagnose(entry) {
  // O_NOFOLLOW: a symlink planted at the diagnostics path must never redirect the
  // truncate/append onto another file; the open then fails and diagnostics are skipped.
  const { O_WRONLY, O_APPEND, O_CREAT, O_TRUNC, O_NOFOLLOW } = fsConstants
  let flags = O_WRONLY | O_APPEND | O_CREAT | (O_NOFOLLOW ?? 0)
  try {
    if (lstatSync(DIAGNOSTICS_PATH).size > DIAGNOSTICS_MAX_BYTES) flags |= O_TRUNC
  } catch {
    /* absent file: nothing to truncate */
  }
  let fd
  try {
    fd = openSync(DIAGNOSTICS_PATH, flags, 0o600)
    writeSync(fd, JSON.stringify({ t: new Date().toISOString(), build: BUILD, ...entry }) + '\n')
  } catch {
    /* diagnostics never break the operation */
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Path encoding
 *
 * Copied verbatim from the shipped JSONL backend
 * (`@deepseek-ai/dsh-session-persistence-jsonl`), which does not export
 * these helpers. Session directories are
 *   <root>/<projectKey(header.cwd) | '_no-cwd'>/<encodeSegment(sessionId)>/
 * and the same encoding must be reproduced exactly or we would look at the
 * wrong directory.
 * ------------------------------------------------------------------ */

/** Encode an arbitrary string as one safe path segment (injective over all JS strings). */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** Build the human-navigable project directory name for a session's cwd. */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/* ------------------------------------------------------------------ *
 * Filesystem helpers
 * ------------------------------------------------------------------ */

/** The configured session root, read from the mounted backend when possible. */
function sessionsRoot(ctx) {
  const mounted = ctx.get('sessionPersistence')
  const configured = mounted === undefined ? undefined : mounted.root
  if (typeof configured === 'string' && configured.length > 0) return resolve(configured)
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return resolve(join(home, 'sessions'))
}

function isMissing(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT'
}

/** The errno-style code of an fs error, or 'error' (never a path or message). */
function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'error'
}

/** Real path, or `null` when the entry does not exist. */
function realPathOrNull(path) {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/** Whether `path` is an existing directory that is not itself a symlink. */
async function isRealDirectory(path) {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch (error) {
    // ENOENT: nothing there. ENOTDIR: this entry (or a parent) is not a directory —
    // a stray file such as `.DS_Store` in the sessions root. Neither is a session
    // directory, and neither may abort a scan.
    if (isMissing(error) || (typeof error === 'object' && error !== null && error.code === 'ENOTDIR')) return false
    throw error
  }
}

/** Whether anything (file, directory or symlink) still exists at `path`. */
async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/** Recursive byte size of a directory, best effort. */
async function directoryBytes(path) {
  let total = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    try {
      if (entry.isDirectory()) total += await directoryBytes(child)
      else if (entry.isFile()) total += (await lstat(child)).size
    } catch {
      /* a file that vanished mid-walk contributes nothing */
    }
  }
  return total
}

/**
 * Resolve the on-disk directory of one session.
 *
 * The stored header's `cwd` selects the project directory; when the header is
 * unavailable the root is scanned for exactly one `<project>/<encoded id>`
 * match. Anything ambiguous, missing, symlinked, or outside the root refuses.
 *
 * @returns the absolute session directory path.
 */
async function locateSessionDir(root, sessionId, cwd) {
  const segment = encodeSegment(sessionId)
  const candidates = []
  if (typeof cwd === 'string' && cwd.length > 0) {
    const preferred = join(root, projectKey(cwd), segment)
    if (await isRealDirectory(preferred)) candidates.push(preferred)
  }
  if (candidates.length === 0) {
    let projects = []
    try {
      // Only real directories can hold a session: a stray file in the sessions root
      // (`.DS_Store` appears in the wild) must never be joined into a candidate path.
      projects = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const candidate = join(root, project.name, segment)
      if (await isRealDirectory(candidate)) candidates.push(candidate)
    }
  }
  if (candidates.length === 0) return null
  if (candidates.length > 1) throw new DeleteRefusal(409, 'ambiguous-location', '找到了多个同名会话目录，已拒绝删除')

  const dir = candidates[0]
  const rootReal = realPathOrNull(root)
  const parentReal = realPathOrNull(dirname(dir))
  if (rootReal === null || parentReal === null) {
    throw new DeleteRefusal(404, 'not-found', '会话目录已不存在')
  }
  // The shipped containment shape (`pointsInto` in dsh-app-boot): compare real
  // paths and require a separator, so `sessions-evil` cannot pass as a child.
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    throw new DeleteRefusal(403, 'outside-root', '会话目录不在会话根目录内，已拒绝删除')
  }
  return dir
}

/* ------------------------------------------------------------------ *
 * Deletion
 * ------------------------------------------------------------------ */

class DeleteRefusal extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Session headers known to the mounted persistence backend (empty when absent). */
async function storedSessions(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || typeof persistence.list !== 'function') return []
  try {
    return await persistence.list()
  } catch (error) {
    // Fail closed: without the list the subagent descendants are unknown, and a
    // "successful" delete would silently strand them.
    ctx.logger?.warn?.(`delete-session: session list failed: ${String(error)}`)
    throw new DeleteRefusal(503, 'check-failed', '无法读取会话列表，已拒绝删除，请稍后再试')
  }
}

/** Close relatives of one session: its subagent descendants, never forks. */
function subagentDescendants(snapshots, sessionId) {
  const children = new Map()
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    if (header === undefined || header === null) continue
    const parent = header.parentSession
    if (typeof parent !== 'string') continue
    const list = children.get(parent) ?? []
    list.push(header)
    children.set(parent, list)
  }
  const found = []
  const queue = [sessionId]
  const seen = new Set(queue)
  while (queue.length > 0) {
    const current = queue.shift()
    for (const header of children.get(current) ?? []) {
      if (seen.has(header.id)) continue
      seen.add(header.id)
      // Only `origin: 'subagent'` marks a session that exists only as another
      // session's delegation. A fork also records a parent, but it is an
      // independent, user-visible session and must survive.
      if (header.origin !== 'subagent') continue
      found.push(header)
      queue.push(header.id)
    }
  }
  return found
}

/** Reported work for one session (`workspace/session-activity` waterfall). */
async function reportedActivity(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return []
  try {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return Array.isArray(activity) ? activity : []
  } catch (error) {
    // Fail closed: an unanswerable activity check must not read as "idle".
    ctx.logger?.warn?.(`delete-session: activity check failed: ${String(error)}`)
    throw new DeleteRefusal(503, 'check-failed', '无法确认会话是否空闲，已拒绝删除，请稍后再试')
  }
}

/** Ask the shipped stop providers to end this session's work (same dispatch the archive path uses). */
async function stopActivity(ctx, sessionId) {
  if (typeof ctx.parallel !== 'function') return
  try {
    await ctx.parallel('workspace/session-stop', { sessionId })
  } catch (error) {
    ctx.logger?.warn?.(`delete-session: stopping session '${sessionId}' failed: ${String(error)}`)
  }
}

/**
 * Whether this session has work in flight right now.
 *
 * `agent.status === 'running'` is the synchronous truth the shipped turn
 * admission reads; the activity waterfall adds the work that outlives a turn
 * (jobs, subagents, armed schedules).
 */
async function hasWorkInFlight(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (typeof agents?.get === 'function' && agents.get(sessionId)?.status === 'running') return true
  const activity = await reportedActivity(ctx, sessionId)
  return activity.length > 0
}

/**
 * Wait, bounded, for one cancelled turn to unwind before its directory vanishes.
 *
 * `workspace/session-stop` only asks; nothing is awaited to settlement there, and
 * a turn that keeps appending after the directory is gone would fail on a path
 * that no longer exists.
 *
 * @returns whether the Agent stopped running (or no Agent is left).
 */
async function waitForAgentIdle(ctx, sessionId, timeoutMs = 15000) {
  const agents = ctx.get('agents')
  if (typeof agents?.get !== 'function') return true
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const agent = agents.get(sessionId)
    if (agent === undefined || agent.status !== 'running') return true
    if (Date.now() >= deadline) return false
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
}

/** Ids with a delete in progress: two windows deleting the same session must not race. */
const deletesInFlight = new Set()

/** Whether every one of `ids` is idle (no running Agent, no reported activity), re-polled until `timeoutMs`. */
async function waitForAllIdle(ctx, ids, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let busy = null
    for (const id of ids) {
      if (await hasWorkInFlight(ctx, id)) {
        busy = id
        break
      }
    }
    if (busy === null) return null
    if (Date.now() >= deadline) return busy
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
}

/**
 * Fence the session against new work before its bytes go.
 *
 * The shipped archive set is what the session controller's `agent/pre-step` gate
 * reads (it also covers subagent-origin descendants), so writing the archive first
 * blocks every wake — a finished job, a schedule firing, a message from another
 * window — between the checks and the `rm`. This is the same order the shipped
 * archive path uses for `stopActivity`.
 *
 * @returns `rollback()`, which restores the archive/pin state when the delete is refused or fails.
 */
async function fenceSession(ctx, sessionId, relatives, stop) {
  const registry = ctx.get('workspaceRegistry')
  const canArchive = typeof registry?.archiveSession === 'function'
  const wasArchived = canArchive && Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(sessionId)
  const wasPinned = canArchive && Array.isArray(registry.pinnedSessionIds) && registry.pinnedSessionIds.includes(sessionId)
  let archivedHere = false
  const rollback = async () => {
    if (!archivedHere) return
    try {
      await registry.unarchiveSession?.(sessionId)
      if (wasPinned) await registry.pinSession?.(sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`delete-session: restoring archive state failed: ${String(error)}`)
    }
  }
  const ids = [sessionId, ...relatives.map((relative) => relative.id)]

  if (!stop) {
    for (const id of ids) {
      if (await hasWorkInFlight(ctx, id)) {
        throw id === sessionId
          ? new DeleteRefusal(409, 'active', '该会话仍有正在进行的任务，可选择「停止任务并删除」')
          : new DeleteRefusal(409, 'descendant-running', '该会话的子代理仍在运行，可选择「停止任务并删除」')
      }
    }
  }

  if (canArchive && !wasArchived) {
    try {
      // Without stopActivity the registry re-asks the activity waterfall inside its
      // own operation queue, closing the window between our check and the write.
      await registry.archiveSession(sessionId, { stopActivity: stop })
      archivedHere = true
    } catch (error) {
      if (error?.name === 'WorkspaceActiveSessionError') {
        throw new DeleteRefusal(409, 'active', '该会话仍有正在进行的任务，可选择「停止任务并删除」')
      }
      // An unknown session (bytes only, no registry record) cannot be fenced; the
      // checks below still guard it. Anything else is unexpected: refuse.
      if (error?.name !== 'WorkspaceUnknownSessionError') {
        ctx.logger?.warn?.(`delete-session: archive fence failed: ${String(error)}`)
        throw new DeleteRefusal(503, 'check-failed', '无法在删除前锁定该会话，已拒绝删除，请稍后再试')
      }
    }
  }
  // Already archived (archiveSession would return without stopping) or no registry:
  // issue the stops ourselves.
  if (stop && !archivedHere) await stopActivity(ctx, sessionId)

  try {
    if (stop) {
      // Stops are requests, not settlements: wait for the turn AND for jobs,
      // subagents and schedules of every target to actually report idle.
      const busy = await waitForAllIdle(ctx, ids)
      if (busy !== null) {
        // 'active' keeps the Client's "stop work and delete" retry available.
        throw new DeleteRefusal(409, busy === sessionId ? 'active' : 'descendant-running',
          '已请求停止，但该会话还没有结束收尾，请稍后再试')
      }
    } else {
      // A turn admitted between the first check and the archive write.
      const busy = await waitForAllIdle(ctx, ids, 0)
      if (busy !== null) throw new DeleteRefusal(409, 'active', '该会话刚刚开始了新的任务，已拒绝删除')
    }
  } catch (error) {
    await rollback()
    throw error
  }
  return rollback
}

/**
 * Drain one live Session's buffered events.
 *
 * A loaded Session holds a persistence write handle whose append re-opens the log
 * by path, so anything still buffered when the directory disappears would fail
 * later. Flushing now leaves nothing pending behind the deletion.
 */
async function flushLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (typeof sessions?.flush !== 'function') return
  const agents = ctx.get('agents')
  const session = (typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined)
    ?? (typeof agents?.get === 'function' ? agents.get(sessionId)?.session : undefined)
  if (session === undefined || session === null) return
  try {
    await sessions.flush(session)
  } catch (error) {
    ctx.logger?.warn?.(`delete-session: flushing '${sessionId}' failed: ${String(error)}`)
  }
}

/** Drop the session id from the workspace registry (all three calls are idempotent). */
async function detachFromRegistry(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  for (const [method, label] of [['unarchiveSession', 'unarchive'], ['unpinSession', 'unpin']]) {
    if (typeof registry[method] !== 'function') continue
    try {
      await registry[method](sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`delete-session: ${label} failed: ${String(error)}`)
    }
  }
  if (typeof registry.list !== 'function') return
  try {
    for (const workspace of registry.list()) {
      if (typeof workspace?.detachSession !== 'function') continue
      try {
        await workspace.detachSession(sessionId)
      } catch (error) {
        ctx.logger?.warn?.(`delete-session: detach failed: ${String(error)}`)
      }
    }
  } catch (error) {
    ctx.logger?.warn?.(`delete-session: workspace list failed: ${String(error)}`)
  }
}

/** Drop one projection-cache record (pure hygiene; a stale record is refused by its own identity check). */
async function dropProjectionCache(ctx, sessionId) {
  let domain
  try {
    domain = ctx.get('storageDomain')?.get?.('session_projcache')
  } catch {
    return
  }
  if (domain === undefined || domain === null) return
  try {
    const table = typeof domain.table === 'function' ? domain.table('sessions') : undefined
    if (typeof table?.delete === 'function') await table.delete(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`delete-session: projection cache cleanup failed: ${String(error)}`)
  }
}

/**
 * Whether the host still holds this Session — or its Agent — in memory.
 *
 * @param ctx - plugin context.
 * @param sessionId - session to test.
 * @returns true while the Session is live.
 */
function isLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (typeof sessions?.get === 'function' && sessions.get(sessionId) !== undefined) return true
  const agents = ctx.get('agents')
  return typeof agents?.get === 'function' && agents.get(sessionId) !== undefined
}

/** Every id the host currently holds live, for diagnostics (bounded). */
function liveIds(ctx) {
  const sessions = ctx.get('sessions')
  if (typeof sessions?.list !== 'function') return []
  try {
    return sessions.list().slice(0, 40).map((session) => session.id)
  } catch {
    return []
  }
}

/** Diagnostic view of liveness for a set of ids (which store still holds it, and how busy). */
function describeLive(ctx, ids) {
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const out = {}
  for (const id of ids) {
    const session = typeof sessions?.get === 'function' ? sessions.get(id) : undefined
    const agent = typeof agents?.get === 'function' ? agents.get(id) : undefined
    out[id] = { session: session !== undefined, agent: agent !== undefined, status: agent === undefined ? undefined : agent.status }
  }
  return out
}

/**
 * The remembered deletions whose bytes are still missing.
 *
 * Re-checking the filesystem keeps the answer honest rather than trusting the
 * bookkeeping alone: an id whose directory came back (a Session re-created with a
 * recycled id) is not hidden, and every id whose bytes are gone is.
 *
 * @param ctx - plugin context.
 * @returns the ids the Client must keep out of the sidebar.
 */
async function ghostsFor(ctx) {
  if (ghostIds.size === 0) return []
  const root = sessionsRoot(ctx)
  const present = new Set()
  let projects = []
  try {
    projects = await readdir(root)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  for (const project of projects) {
    try {
      for (const entry of await readdir(join(root, project))) present.add(entry)
    } catch {
      /* a project directory that vanished mid-scan contributes nothing */
    }
  }
  return [...ghostIds].filter((id) => !present.has(encodeSegment(id)))
}

/**
 * Keep deleted Sessions out of the Host's own listings.
 *
 * `sessionQuery.listSessions()` merges the stored records with whatever Session
 * objects are live, and a live Session outlives its own deletion (an Agent belongs
 * to the app-lifetime registry and a plugin has no API to dispose it). That is why
 * a deleted Session used to come back in the sidebar after every reconnect.
 *
 * Intercepting this one read is the only non-destructive seam a plugin has:
 * re-registering the service is impossible (a second `provide` throws), mutating it
 * is not reversible, and `ctx.accessor` is a fiber-owned effect — unloading this
 * plugin removes it again. The filter is deliberately narrow:
 *
 *   - only ids THIS host run deleted (`ghostIds`);
 *   - re-checked against the filesystem, so a Session whose directory came back is
 *     listed again;
 *   - any failure leaves the listing untouched (fail open): showing a row that was
 *     meant to be gone is recoverable, hiding a live one is not.
 *
 * What this does NOT cover: opening a ghost by id (`observeSession`, `readSession`,
 * a deep link). Those go through `ctx.sessions.get`/`ctx.agents.get`, which cannot
 * be filtered without breaking identity comparisons elsewhere in the host. Making a
 * deleted Session truly unopenable needs a dispose entry point in DSH itself.
 */
function installGhostFilter(ctx) {
  ctx.inject(['sessionQuery'], (queryCtx) => {
    try {
      queryCtx.effect(() => queryCtx.accessor('sessionQuery.listSessions', {
        get() {
          return async function listSessions(...args) {
            // The traceable proxy re-enters this accessor, so delegate to the raw
            // engine unwrapped with cordis's own "original" symbol.
            const service = ctx.get('sessionQuery')
            const engine = service?.[Symbol.for('cordis.original')] ?? service
            const records = await engine.listSessions(...args)
            try {
              if (!Array.isArray(records) || ghostIds.size === 0) return records
              const suspects = records.filter((record) => typeof record?.header?.id === 'string' && ghostIds.has(record.header.id))
              if (suspects.length === 0) return records
              const root = sessionsRoot(ctx)
              const hidden = new Set()
              for (const record of suspects) {
                // A refusal (ambiguous location, fs fault) simply keeps the row.
                const dir = await locateSessionDir(root, record.header.id, record.header.cwd).catch(() => undefined)
                if (dir === null) hidden.add(record.header.id)
              }
              if (hidden.size === 0) return records
              // Evidence, not trust: this line is what proves the root fix fired in
              // a real listing (the client's own ledger is a separate safety net, and
              // only this record separates the two).
              diagnose({ op: 'list-hidden', ids: [...hidden] })
              return records.filter((record) => !hidden.has(record?.header?.id))
            } catch (error) {
              ctx.logger?.warn?.(`delete-session: filtering the session list failed: ${String(error)}`)
              return records
            }
          }
        },
      }), 'delete-session: hide deleted sessions from sessionQuery.listSessions')
    } catch (error) {
      ctx.logger?.warn?.(`delete-session: session list filter not installed: ${String(error)}`)
    }
  })
}

/**
 * Permanently delete one session and its subagent descendants.
 *
 * @param ctx - plugin context.
 * @param request - `{ sessionId, stopActivity }`.
 * @returns `{ deletedIds, freedBytes, descendants }`.
 */
async function deleteSession(ctx, request) {
  const sessionId = request.sessionId
  if (deletesInFlight.has(sessionId)) {
    throw new DeleteRefusal(409, 'busy', '该会话正在被删除，请稍候')
  }
  deletesInFlight.add(sessionId)
  try {
    return await deleteSessionLocked(ctx, request)
  } finally {
    deletesInFlight.delete(sessionId)
  }
}

async function deleteSessionLocked(ctx, request) {
  const sessionId = request.sessionId
  const root = sessionsRoot(ctx)
  const snapshots = await storedSessions(ctx)
  const target = snapshots.find((snapshot) => snapshot?.header?.id === sessionId)
  const relatives = subagentDescendants(snapshots, sessionId)
  const liveAtEntry = describeLive(ctx, [sessionId, ...relatives.map((relative) => relative.id)])

  // ---- locate (read-only): nothing is touched until every guard has passed ----
  const targets = []
  const mainDir = await locateSessionDir(root, sessionId, target?.header?.cwd)
  if (mainDir === null) {
    // Nothing on disk. For a Session the host still knows (live, or one this run
    // already deleted) the user's intent is already satisfied: remember it, tell the
    // browser, and report success instead of the confusing "storage not found".
    if (!isLive(ctx, sessionId) && !ghostIds.has(sessionId)) {
      throw new DeleteRefusal(404, 'not-found', '找不到该会话的存储目录')
    }
    ghostIds.add(sessionId)
    diagnose({ op: 'delete-already-gone', sessionId, liveAtEntry })
    try {
      ctx.emit('api-session/removed', sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`delete-session: removal notice failed: ${String(error)}`)
    }
    return { deletedIds: [], freedBytes: 0, descendants: 0, alreadyGone: true }
  }
  // Descendants first: a failure part-way leaves the user-visible session intact.
  for (const relative of relatives) {
    const dir = await locateSessionDir(root, relative.id, relative.cwd)
    if (dir !== null) targets.push({ id: relative.id, dir })
  }
  targets.push({ id: sessionId, dir: mainDir })

  // ---- fence + refusals ----
  // What must be protected is WORK, not residence: a loaded-but-idle Session is
  // deletable, while a running turn, a job, a subagent or an armed schedule refuses
  // (or, with stopActivity, is stopped and awaited). The archive write blocks every
  // new wake from here until the bytes are gone.
  const rollback = await fenceSession(ctx, sessionId, relatives, request.stopActivity === true)

  // ---- remove bytes; every target is attempted and checked individually ----
  // From the fence on, the rollback must run on EVERY path that leaves the main
  // session in place — including an fs fault thrown mid-loop (EACCES/EPERM/ELOOP
  // on the re-check), which would otherwise leave it archived with its pin dropped.
  let freedBytes = 0
  const deletedIds = []
  const failed = []
  let mainGone = false
  try {
    // Drain every live handle first: nothing buffered may outlive the directory.
    for (const entry of targets) await flushLiveSession(ctx, entry.id)

    for (const entry of targets) {
      let bytes = 0
      try {
        bytes = await directoryBytes(entry.dir)
      } catch (error) {
        // Only the reported size is lost; the removal itself is still attempted.
        ctx.logger?.warn?.(`delete-session: sizing '${entry.id}' failed: ${String(error)}`)
      }
      try {
        await rm(entry.dir, { recursive: true, force: false })
      } catch (error) {
        // ENOENT: someone else removed it first; the outcome is what we wanted.
        if (!isMissing(error)) {
          ctx.logger?.warn?.(`delete-session: removing '${entry.id}' failed: ${String(error)}`)
          failed.push({ id: entry.id, code: errorCode(error) })
        }
      }
      let survived
      try {
        survived = await pathExists(entry.dir)
      } catch (error) {
        // Absence cannot be confirmed: count it as NOT deleted. Keeping a record
        // whose bytes may be gone is recoverable; hiding one that still has bytes is not.
        ctx.logger?.warn?.(`delete-session: re-checking '${entry.id}' failed: ${String(error)}`)
        failed.push({ id: entry.id, code: errorCode(error) })
        survived = true
      }
      if (survived) continue
      freedBytes += bytes
      deletedIds.push(entry.id)
    }
    mainGone = deletedIds.includes(sessionId)
  } finally {
    if (!mainGone) await rollback()
  }

  // ---- settle every record that still names a removed session ----
  for (const id of deletedIds) {
    await detachFromRegistry(ctx, id)
    await dropProjectionCache(ctx, id)
  }

  // ---- tell the browser; this is the shipped Host→Client removal notice ----
  for (const id of deletedIds) {
    // Every deleted id is remembered; `ghostsFor` decides later which of them the
    // Client must still hide (any whose bytes are missing).
    ghostIds.add(id)
    try {
      ctx.emit('api-session/removed', id)
    } catch (error) {
      ctx.logger?.warn?.(`delete-session: removal notice failed: ${String(error)}`)
    }
  }

  diagnose({
    op: 'delete',
    sessionId,
    deletedIds,
    liveAtEntry,
    liveAtEnd: describeLive(ctx, deletedIds),
    liveIds: liveIds(ctx),
    ghosts: [...ghostIds],
  })
  ctx.logger?.info?.(`delete-session: removed ${deletedIds.join(', ') || '(none)'} (${freedBytes} bytes)`)
  if (!mainGone) {
    // The session itself survived (its archive state was restored above); report
    // what did go so the Client can still drop those rows.
    const refusal = new DeleteRefusal(500, 'partial', '删除未完成：会话目录无法完全移除，会话已保留，请稍后重试')
    refusal.extra = { deletedIds, failed }
    throw refusal
  }
  return {
    deletedIds,
    freedBytes,
    descendants: deletedIds.length - 1,
    ...(failed.length > 0 ? { partial: true, failed } : {}),
  }
}

/* ------------------------------------------------------------------ *
 * HTTP surface
 * ------------------------------------------------------------------ */

function loopbackHost(host) {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || /^127\./.test(name)
}

/** Host/Origin fence used when no `connection` service is mounted: our own routes bypass the `/api` admission. */
function localFence(request) {
  const host = request.headers.host
  if (typeof host !== 'string' || host.length === 0) return 'missing host'
  if (!loopbackHost(host)) return 'untrusted host'
  // Browsers mark cross-site requests; an opaque ('null') origin is never ours.
  if (request.headers['sec-fetch-site'] === 'cross-site') return 'cross-site request'
  const origin = request.headers.origin
  if (origin === 'null') return 'opaque origin'
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost
    try {
      originHost = new URL(origin).host
    } catch {
      return 'malformed origin'
    }
    if (originHost !== host) return 'cross-origin request'
  }
  return null
}

/**
 * Decide whether one request may delete.
 *
 * The shipped `/api` carrier already owns the deployment's request trust model
 * (Host/Origin fence, `sec-fetch-site`, persistent browser authentication), and
 * `connection.admit()` is that exact check, so a profile with a `connection`
 * service reuses it instead of inventing a second policy. Without one, the local
 * fence above applies.
 *
 * @returns `null` when admitted, otherwise `{ status, message }`.
 */
function trustRejection(ctx, request) {
  const connection = ctx.get('connection')
  if (connection !== undefined && typeof connection.admit === 'function') {
    const admission = connection.admit(request)
    if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
      const status = admission.rejection === 401 ? 401 : 403
      return {
        status,
        reason: status === 401 ? 'unauthenticated' : 'untrusted-request',
        message: status === 401 ? '未通过浏览器身份校验' : '请求来源不受信任',
      }
    }
  } else {
    const local = localFence(request)
    if (local !== null) return { status: 403, reason: `local-fence:${local}`, message: `已拒绝：${local}` }
  }
  // A cross-site caller cannot send this header without a preflight we never answer.
  if (request.headers['x-dsh-plugin'] !== REQUIRED_HEADER) {
    return { status: 403, reason: 'missing-plugin-header', message: '已拒绝：缺少插件请求头' }
  }
  return null
}

async function readJsonBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new DeleteRefusal(413, 'payload-too-large', '请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new DeleteRefusal(400, 'invalid-json', '请求体不是合法 JSON')
  }
}

function respond(response, status, payload) {
  const body = JSON.stringify({ build: BUILD, ...payload })
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

async function handle(ctx, request, response) {
  try {
    if (request.method !== 'POST') {
      // A rejected request is still a request that REACHED the host: recording it is
      // what separates "never arrived" from "refused here" when a page looks like it
      // never resynced. Reason codes only — never header values.
      diagnose({ op: 'rejected', status: 405, reason: 'method-not-allowed' })
      respond(response, 405, { ok: false, code: 'method-not-allowed', message: '只接受 POST' })
      return
    }
    const rejection = trustRejection(ctx, request)
    if (rejection !== null) {
      diagnose({ op: 'rejected', status: rejection.status, reason: rejection.reason })
      respond(response, rejection.status, { ok: false, code: 'forbidden', message: rejection.message })
      return
    }
    const body = await readJsonBody(request)
    // Read-only companion operation: the ids this host run deleted while they were
    // still live, so a page that (re)loads can keep those rows hidden too.
    if (body.op === 'ghosts') {
      const ghosts = await ghostsFor(ctx)
      // Record which client revision asked, so a page running a stale bundle is
      // distinguishable from a fixed one in the diagnostics.
      const client = typeof body.client === 'string' ? body.client.slice(0, 32) : undefined
      diagnose({ op: 'ghosts', ...(client === undefined ? {} : { client }), ghosts })
      respond(response, 200, { ok: true, ghosts })
      return
    }
    const sessionId = body.sessionId
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId) || sessionId === '.' || sessionId === '..') {
      respond(response, 400, { ok: false, code: 'invalid-session-id', message: '会话 id 不合法' })
      return
    }
    if (body.confirm !== true) {
      respond(response, 400, { ok: false, code: 'unconfirmed', message: '缺少服务端确认标记' })
      return
    }
    const result = await deleteSession(ctx, { sessionId, stopActivity: body.stopActivity === true })
    respond(response, 200, { ok: true, ...result })
  } catch (error) {
    if (error instanceof DeleteRefusal) {
      respond(response, error.status, { ok: false, ...(error.extra ?? {}), code: error.code, message: error.message })
      return
    }
    // Raw fs messages carry absolute paths: keep them in the log, not the response.
    ctx.logger?.warn?.(`delete-session: ${String(error && error.stack ? error.stack : error)}`)
    diagnose({ op: 'internal-error', error: String(error && error.message ? error.message : error) })
    const code = typeof error?.code === 'string' ? error.code : undefined
    respond(response, 500, { ok: false, code: 'internal', message: code ? `删除失败（${code}）` : '删除失败（内部错误）' })
  }
}

/**
 * Register the delete route.
 *
 * @param ctx - host context carrying `webServer`.
 */
export function apply(ctx) {
  diagnose({ op: 'start' })
  installGhostFilter(ctx)
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (request, response) => handle(ctx, request, response),
    }),
    'delete-session: route',
  )
}

/* Exported for local verification only; the Loader reads `apply`, `name` and `inject`. */
export { encodeSegment, projectKey, locateSessionDir, sessionsRoot, deleteSession, isLive, ghostsFor, installGhostFilter, ghostIds, ROUTE_PATH, BUILD, DIAGNOSTICS_PATH }
