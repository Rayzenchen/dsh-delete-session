/**
 * Integration test for the host half's deletion core.
 *
 * Runs against a throwaway fake DSH home inside the system temp directory — it
 * never reads or writes `~/.dsh`. Covers the happy path, the work-in-flight
 * refusals and the stop-then-delete hop, loaded-but-idle sessions, subagent
 * descendants, fork protection, traversal attempts and path containment.
 *
 *   node tools/verify-delete.mjs
 */
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Keep this suite's synthetic deletions out of the real host diagnostic channel.
process.env.DSH_DELETE_SESSION_DIAGNOSTICS = join(tmpdir(), `dsh-delete-session-test-${Date.now()}.jsonl`)
const { deleteSession, projectKey, ROUTE_PATH, BUILD, ghostIds, ghostsFor } = await import('../index.js')

let failures = 0
function check(ok, label) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) failures++
}

/** Build a fake session directory the way the shipped JSONL backend lays it out. */
async function makeSession(root, id, cwd, extra = {}) {
  const dir = join(root, cwd === undefined ? '_no-cwd' : projectKey(cwd), id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.lock'), '')
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 7))
  return {
    id,
    dir,
    header: {
      id,
      cwd,
      ...(extra.parentSession === undefined ? {} : { parentSession: extra.parentSession }),
      ...(extra.origin === undefined ? {} : { origin: extra.origin }),
      delegationDepth: extra.delegationDepth ?? 0,
    },
  }
}

/**
 * Fake plugin context.
 *
 * @param root - session root the fake persistence backend reports.
 * @param snapshots - stored session snapshots.
 * @param services - service overrides plus test spies: `agents` (id → Agent-like),
 *   `live` (id → live Session-like), `activity`, `onStop`.
 */
function makeCtx(root, snapshots, services = {}) {
  const emitted = []
  const flushed = []
  const stopped = []
  const ctx = {
    get(name) {
      if (name === 'sessionPersistence') return { root, list: async () => snapshots }
      if (name === 'agents') return services.agents
      if (name === 'sessions') {
        return {
          get: (id) => services.live?.[id],
          flush: async (session) => {
            flushed.push(session.id ?? session)
          },
        }
      }
      return services[name]
    },
    waterfall: async () => services.activity ?? [],
    parallel: async (event, payload) => {
      stopped.push([event, payload.sessionId])
      if (typeof services.onStop === 'function') services.onStop(payload.sessionId)
    },
    emit: (event, id) => emitted.push([event, id]),
    logger: { info() {}, warn() {} },
  }
  return { ctx, emitted, flushed, stopped }
}

const home = await mkdtemp(join(tmpdir(), 'dsh-delete-session-test-'))
const root = join(home, 'sessions')
const cwd = '/Users/example/project'

try {
  /* ---------------- happy path ---------------- */
  const a = await makeSession(root, 'session-aaaa-1', cwd)
  const { ctx, emitted } = makeCtx(root, [{ header: a.header, revision: 'r1' }])
  const result = await deleteSession(ctx, { sessionId: 'session-aaaa-1' })
  check(!existsSync(a.dir), 'deletes the session directory')
  check(result.deletedIds.length === 1 && result.deletedIds[0] === 'session-aaaa-1', 'reports the deleted id')
  check(result.freedBytes > 2000, `reports freed bytes (${result.freedBytes})`)
  check(emitted.length === 1 && emitted[0][0] === 'api-session/removed' && emitted[0][1] === 'session-aaaa-1',
    'emits api-session/removed so the sidebar row disappears')
  check(typeof BUILD === 'string' && BUILD.length > 0, `reports its build (${BUILD})`)
  check(ghostIds.has('session-aaaa-1'), 'every deleted id is remembered, whether live at the time or not')

  /* ---------------- loaded but idle is NOT refused ---------------- */
  const loaded = await makeSession(root, 'session-loaded-9', cwd)
  const live = makeCtx(root, [{ header: loaded.header, revision: 'r1' }], {
    live: { 'session-loaded-9': { id: 'session-loaded-9' } },
  })
  const loadedResult = await deleteSession(live.ctx, { sessionId: 'session-loaded-9' })
  check(loadedResult.deletedIds[0] === 'session-loaded-9' && !existsSync(loaded.dir),
    'deletes a session the host merely has loaded (no restart needed)')
  check(live.flushed.length === 1 && live.flushed[0] === 'session-loaded-9',
    'flushes the live handle before removing its bytes')
  check(ghostIds.has('session-loaded-9'),
    'a session deleted while still live is remembered so the Client keeps hiding its row')

  /* ---------------- work in flight refuses ---------------- */
  const running = await makeSession(root, 'session-bbbb-2', cwd)
  const busyStore = [{ header: running.header, revision: 'r1' }]
  const busy = makeCtx(root, busyStore, { agents: { get: () => ({ status: 'running' }) } })
  const busyResult = await deleteSession(busy.ctx, { sessionId: 'session-bbbb-2' }).then(() => 'deleted', (error) => error.code)
  check(busyResult === 'active', `refuses a running turn with the stoppable code (${busyResult})`)
  check(existsSync(running.dir), 'running refusal left the directory untouched')

  const active = makeCtx(root, busyStore, { activity: [{ kind: 'schedule' }] })
  const activeResult = await deleteSession(active.ctx, { sessionId: 'session-bbbb-2' }).then(() => 'deleted', (error) => error.code)
  check(activeResult === 'active', `refuses a session with an armed schedule (${activeResult})`)
  check(active.stopped.length === 0, 'the refusing path never calls the stop providers')

  /* ---------------- stop, then delete ---------------- */
  let status = 'running'
  const stoppable = makeCtx(root, busyStore, {
    agents: { get: () => ({ status }) },
    onStop: () => {
      status = 'idle'
    },
  })
  const stoppableResult = await deleteSession(stoppable.ctx, { sessionId: 'session-bbbb-2', stopActivity: true })
  check(stoppable.stopped.length === 1 && stoppable.stopped[0][0] === 'workspace/session-stop',
    'stopActivity asks the shipped stop providers')
  check(stoppableResult.deletedIds[0] === 'session-bbbb-2' && !existsSync(running.dir),
    'deletes after the cancelled turn unwinds')

  const stuck = await makeSession(root, 'session-bbbb-8', cwd)
  const never = makeCtx(root, [{ header: stuck.header, revision: 'r1' }], {
    agents: { get: () => ({ status: 'running' }) },
  })
  const neverResult = await deleteSession(never.ctx, { sessionId: 'session-bbbb-8', stopActivity: true })
    .then(() => 'deleted', (error) => error.code)
  check(neverResult === 'active', `refuses when a stopped turn never settles (${neverResult})`)
  check(existsSync(stuck.dir), 'an unsettled stop left the directory untouched')

  /* ---------------- unknown and traversal ids ---------------- */
  const unknown = makeCtx(root, [])
  const unknownResult = await deleteSession(unknown.ctx, { sessionId: 'session-cccc-3' }).then(() => 'deleted', (error) => error.code)
  check(unknownResult === 'not-found', `refuses an unknown session (${unknownResult})`)

  /* A Session the host still knows but whose bytes are gone reports success. */
  const already = makeCtx(root, [], { live: { 'session-ghost-gone': { id: 'session-ghost-gone' } } })
  const alreadyResult = await deleteSession(already.ctx, { sessionId: 'session-ghost-gone' })
  check(alreadyResult.alreadyGone === true, 're-deleting a byte-less Session succeeds instead of "storage not found"')
  check(already.emitted.some(([event, id]) => event === 'api-session/removed' && id === 'session-ghost-gone'),
    'the already-gone path still tells the browser to drop the row')

  const guard = makeCtx(root, [])
  const guardResult = await deleteSession(guard.ctx, { sessionId: '..' }).then(() => 'deleted', (error) => error.code)
  check(guardResult === 'not-found', `refuses a traversal id (${guardResult})`)
  check(existsSync(root), 'traversal attempt left the sessions root intact')
  check(existsSync(join(root, '..')), 'traversal attempt left the parent directory intact')

  /* ---------------- subagent descendants ---------------- */
  const parent = await makeSession(root, 'session-dddd-4', cwd)
  const child = await makeSession(root, 'child-eeee-5', cwd, { parentSession: 'session-dddd-4', origin: 'subagent', delegationDepth: 1 })
  const grandchild = await makeSession(root, 'grand-ffff-6', cwd, { parentSession: 'child-eeee-5', origin: 'subagent', delegationDepth: 2 })
  const fork = await makeSession(root, 'fork-9999-7', cwd, { parentSession: 'session-dddd-4' })
  const treeStore = [parent, child, grandchild, fork].map((entry) => ({ header: entry.header, revision: 'r1' }))
  const tree = makeCtx(root, treeStore)
  const treeResult = await deleteSession(tree.ctx, { sessionId: 'session-dddd-4' })
  check(!existsSync(parent.dir) && !existsSync(child.dir) && !existsSync(grandchild.dir), 'deletes subagent descendants')
  check(treeResult.descendants === 2, `reports 2 descendants (${treeResult.descendants})`)
  check(existsSync(fork.dir), 'leaves an independent fork alone')
  check(tree.emitted.length === 3, 'emits one removal notice per deleted session')

  const busyParent = await makeSession(root, 'session-dddd-8', cwd)
  const busyKid = await makeSession(root, 'child-eeee-9', cwd, { parentSession: 'session-dddd-8', origin: 'subagent', delegationDepth: 1 })
  const guarded = makeCtx(root, [busyParent, busyKid].map((entry) => ({ header: entry.header, revision: 'r1' })), {
    agents: { get: (id) => (id === 'child-eeee-9' ? { status: 'running' } : undefined) },
  })
  const guardedResult = await deleteSession(guarded.ctx, { sessionId: 'session-dddd-8' }).then(() => 'deleted', (error) => error.code)
  check(guardedResult === 'descendant-running', `refuses while a subagent descendant runs (${guardedResult})`)
  check(existsSync(busyParent.dir) && existsSync(busyKid.dir), 'descendant refusal left both directories untouched')

  /* ---------------- the ghost answer follows the filesystem ---------------- */
  const ghostId = 'session-ghost-1'
  const ghostSeed = await makeSession(root, ghostId, cwd)
  const ghostCtx = makeCtx(root, [{ header: ghostSeed.header, revision: 'r1' }])
  await deleteSession(ghostCtx.ctx, { sessionId: ghostId })
  const reported = await ghostsFor(ghostCtx.ctx)
  check(reported.includes(ghostId), 'a remembered id whose bytes are gone is reported as a ghost')
  check(!reported.includes('session-dddd-8'), 'a session that was never deleted is never reported')
  await makeSession(root, ghostId, cwd)
  const afterRecreate = await ghostsFor(ghostCtx.ctx)
  check(!afterRecreate.includes(ghostId), 'an id whose directory came back is no longer hidden')

  /* ---------------- fail closed: an unanswerable check never reads as "idle" ---------------- */
  const listFails = await makeSession(root, 'session-fail-1', cwd)
  const listCtx = makeCtx(root, [])
  listCtx.ctx.get = ((original) => (name) => (name === 'sessionPersistence'
    ? { root, list: async () => { throw new Error('boom') } }
    : original(name)))(listCtx.ctx.get)
  const listResult = await deleteSession(listCtx.ctx, { sessionId: 'session-fail-1' }).then(() => 'deleted', (error) => error.code)
  check(listResult === 'check-failed', `refuses when the session list cannot be read (${listResult})`)
  const waterfallCtx = makeCtx(root, [{ header: listFails.header, revision: 'r1' }])
  waterfallCtx.ctx.waterfall = async () => { throw new Error('boom') }
  const waterfallResult = await deleteSession(waterfallCtx.ctx, { sessionId: 'session-fail-1' }).then(() => 'deleted', (error) => error.code)
  check(waterfallResult === 'check-failed', `refuses when the activity check throws (${waterfallResult})`)
  check(existsSync(listFails.dir), 'failed checks left the directory untouched')

  /* ---------------- one delete per session at a time ---------------- */
  const racy = await makeSession(root, 'session-race-1', cwd)
  let releaseFlush
  const racyCtx = makeCtx(root, [{ header: racy.header, revision: 'r1' }], { live: { 'session-race-1': { id: 'session-race-1' } } })
  const sessionsService = racyCtx.ctx.get('sessions')
  racyCtx.ctx.get = ((original) => (name) => (name === 'sessions'
    ? { ...sessionsService, flush: () => new Promise((resolveFlush) => { releaseFlush = resolveFlush }) }
    : original(name)))(racyCtx.ctx.get)
  const first = deleteSession(racyCtx.ctx, { sessionId: 'session-race-1' })
  while (releaseFlush === undefined) await new Promise((resolveTick) => setTimeout(resolveTick, 5))
  const second = await deleteSession(racyCtx.ctx, { sessionId: 'session-race-1' }).then(() => 'deleted', (error) => error.code)
  releaseFlush()
  const firstResult = await first
  check(second === 'busy', `a concurrent second delete is refused as busy (${second})`)
  check(firstResult.deletedIds.includes('session-race-1') && !existsSync(racy.dir), 'the first delete still completes')

  /* ---------------- archive fence: written before the bytes go, restored on refusal ---------------- */
  function makeRegistry({ pinned = [], activeAfterArchive = false } = {}) {
    const calls = []
    const registry = {
      archivedSessionIds: [],
      pinnedSessionIds: [...pinned],
      async archiveSession(id, options) {
        calls.push(['archive', id, options?.stopActivity === true])
        this.archivedSessionIds = [...this.archivedSessionIds, id]
        this.pinnedSessionIds = this.pinnedSessionIds.filter((entry) => entry !== id)
        registry.archivedAt = calls.length
      },
      async unarchiveSession(id) {
        calls.push(['unarchive', id])
        this.archivedSessionIds = this.archivedSessionIds.filter((entry) => entry !== id)
      },
      async pinSession(id) {
        calls.push(['pin', id])
        this.pinnedSessionIds = [...this.pinnedSessionIds, id]
      },
      async unpinSession(id) {
        calls.push(['unpin', id])
      },
      list: () => [],
      activeAfterArchive,
    }
    return { registry, calls }
  }
  const fenced = await makeSession(root, 'session-fence-1', cwd)
  const fence = makeRegistry()
  let sawArchiveBeforeRm = false
  const fenceCtx = makeCtx(root, [{ header: fenced.header, revision: 'r1' }], {
    workspaceRegistry: fence.registry,
    live: { 'session-fence-1': { id: 'session-fence-1' } },
  })
  fenceCtx.ctx.get = ((original) => (name) => (name === 'sessions'
    ? { get: () => ({ id: 'session-fence-1' }), flush: async () => { sawArchiveBeforeRm = fence.registry.archivedSessionIds.includes('session-fence-1') } }
    : original(name)))(fenceCtx.ctx.get)
  await deleteSession(fenceCtx.ctx, { sessionId: 'session-fence-1' })
  check(sawArchiveBeforeRm, 'the session is archived (wakes blocked) before its bytes are removed')
  check(fence.calls.some(([op]) => op === 'unarchive'), 'the archive record is dropped again after a successful delete')

  // A turn that slips in after the archive write: refuse and restore archive + pin.
  const slipped = await makeSession(root, 'session-fence-2', cwd)
  const slip = makeRegistry({ pinned: ['session-fence-2'] })
  let archived = false
  slip.registry.archiveSession = async function (id, options) {
    slip.calls.push(['archive', id, options?.stopActivity === true])
    archived = true
    this.archivedSessionIds = [...this.archivedSessionIds, id]
    this.pinnedSessionIds = this.pinnedSessionIds.filter((entry) => entry !== id)
  }
  const slipCtx = makeCtx(root, [{ header: slipped.header, revision: 'r1' }], {
    workspaceRegistry: slip.registry,
    agents: { get: (id) => (archived && id === 'session-fence-2' ? { status: 'running' } : undefined) },
  })
  const slipResult = await deleteSession(slipCtx.ctx, { sessionId: 'session-fence-2' }).then(() => 'deleted', (error) => error.code)
  check(slipResult === 'active', `a turn admitted after the first check still refuses (${slipResult})`)
  check(existsSync(slipped.dir), 'that refusal left the directory untouched')
  check(slip.registry.archivedSessionIds.length === 0 && slip.registry.pinnedSessionIds.includes('session-fence-2'),
    'the refusal restored the archive and pin state')

  // stopActivity goes through the registry's own archive-then-stop path.
  const stopFenced = await makeSession(root, 'session-fence-3', cwd)
  const stopFence = makeRegistry()
  const stopFenceCtx = makeCtx(root, [{ header: stopFenced.header, revision: 'r1' }], { workspaceRegistry: stopFence.registry })
  await deleteSession(stopFenceCtx.ctx, { sessionId: 'session-fence-3', stopActivity: true })
  check(stopFence.calls[0]?.[0] === 'archive' && stopFence.calls[0]?.[2] === true, 'stop-and-delete archives with stopActivity first')
  check(!existsSync(stopFenced.dir), 'stop-and-delete then removes the directory')

  /* ---------------- a failed removal never half-deletes the visible session ---------------- */
  const stubborn = await makeSession(root, 'session-stuck-2', cwd)
  const stubKid = await makeSession(root, 'child-stuck-3', cwd, { parentSession: 'session-stuck-2', origin: 'subagent', delegationDepth: 1 })
  const stuckFence = makeRegistry()
  const stuckCtx = makeCtx(root, [stubborn, stubKid].map((entry) => ({ header: entry.header, revision: 'r1' })), { workspaceRegistry: stuckFence.registry })
  await chmod(stubborn.dir, 0o555)
  const stuckResult = await deleteSession(stuckCtx.ctx, { sessionId: 'session-stuck-2' }).then(() => null, (error) => error)
  await chmod(stubborn.dir, 0o755)
  check(stuckResult?.code === 'partial', `an unremovable session directory reports a partial failure (${stuckResult?.code})`)
  check(existsSync(stubborn.dir), 'the visible session survived the failed removal')
  check(!existsSync(stubKid.dir) && stuckResult?.extra?.deletedIds?.includes('child-stuck-3'),
    'the descendant that did go is reported as deleted')
  check(stuckCtx.emitted.some(([, id]) => id === 'child-stuck-3') && !stuckCtx.emitted.some(([, id]) => id === 'session-stuck-2'),
    'removal notices are sent only for what actually went')
  check(stuckFence.registry.archivedSessionIds.length === 0, 'the surviving session was un-archived again')
  check(!String(stuckResult?.message).includes(root), 'the refusal message carries no absolute path')

  /* ---------------- cleanup ---------------- */
  await rm(home, { recursive: true, force: true })
  await rm(process.env.DSH_DELETE_SESSION_DIAGNOSTICS, { force: true })
  console.log(`\nroute: ${ROUTE_PATH}  build: ${BUILD}`)
  console.log(failures === 0 ? 'ALL DELETION CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
} catch (error) {
  console.error(error)
  await rm(home, { recursive: true, force: true })
  failures++
}

process.exit(failures === 0 ? 0 : 1)
