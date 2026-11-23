/**
 * Tests the Host half's `sessionQuery.listSessions` filter.
 *
 * The filter is what keeps a deleted-but-still-live Session out of the sidebar from
 * the HOST side (the client ledger is only a backstop for the same fact). It is
 * installed as a Cordis member accessor, so this drives it the way cordis does:
 * a fake context provides `inject`/`effect`/`accessor`, the registered accessor's
 * `get()` yields the wrapper, and the wrapper is called against a fake engine that
 * returns one ghost (its directory is gone) and one healthy Session.
 *
 *   node tools/verify-host-filter.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The plugin writes its diagnostics where the LIVE host does; this fixture must not
// land in the real file, so redirect it before index.js is loaded (it reads the
// variable at import time). `session-deleted-1` in a real log means this file ran.
const scratch = await mkdtemp(join(tmpdir(), 'dsh-host-filter-'))
process.env.DSH_DELETE_SESSION_DIAGNOSTICS = join(scratch, 'diagnostics.jsonl')
const { installGhostFilter, ghostIds, projectKey, BUILD } = await import('../index.js')

let failures = 0
function check(ok, label) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) failures++
}

/* ---------------- a throwaway sessions root ---------------- */

const home = await mkdtemp(join(tmpdir(), 'dsh-host-filter-root-'))
const root = join(home, 'sessions')
const cwd = '/Users/example/project'

/** Create a real, materialized session directory the way the JSONL backend does. */
async function makeStoredSession(id) {
  const dir = join(root, projectKey(cwd), id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.lock'), '')
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(64))
  return dir
}

const deletedId = 'session-deleted-1'
const healthyId = 'session-healthy-1'
const deletedDir = await makeStoredSession(deletedId)
await makeStoredSession(healthyId)

/* ---------------- fake cordis context ---------------- */

const accessors = new Map()
const injected = []
const warnings = []
const effects = []

const ctx = {
  logger: { warn: (...args) => warnings.push(args.join(' ')), info() {} },
  get(name) {
    if (name === 'sessionPersistence') return { root, list: async () => [] }
    if (name === 'sessionQuery') return engine
    return undefined
  },
  inject(names, callback) {
    injected.push(names)
    callback(ctx)
    return () => {}
  },
  effect(callback) {
    effects.push(callback())
    return () => {}
  },
  accessor(name, options) {
    if (accessors.has(name)) throw new Error(`property "${name}" is already declared as accessor`)
    accessors.set(name, options)
    return () => accessors.delete(name)
  },
}

const calls = []
const engine = {
  async listSessions(...args) {
    calls.push(args)
    return [
      { header: { id: deletedId, cwd }, revision: 'r1' },
      { header: { id: healthyId, cwd }, revision: 'r1' },
    ]
  },
}

/* ---------------- install ---------------- */

installGhostFilter(ctx)
check(injected.some((names) => names.includes('sessionQuery')), 'waits for the sessionQuery service instead of assuming load order')
check(accessors.has('sessionQuery.listSessions'), 'registers the member accessor on sessionQuery.listSessions')

const wrapper = accessors.get('sessionQuery.listSessions').get()
check(typeof wrapper === 'function', 'the accessor yields a callable')

/* ---------------- the filter itself ---------------- */

// Nothing deleted yet: the listing must pass through untouched.
let records = await wrapper('signal-under-test')
check(records.length === 2 && calls[0][0] === 'signal-under-test', 'with no deletions the listing is returned verbatim')
check(calls.length === 1, 'the engine is called exactly once per read (no re-entry through the accessor)')

// The delete happened: its bytes are gone, the other Session is intact.
await rm(deletedDir, { recursive: true, force: true })
ghostIds.add(deletedId)
records = await wrapper()
check(records.length === 1 && records[0].header.id === healthyId,
  `a deleted Session is dropped from the listing (kept: ${records.map((r) => r.header.id).join(',') || 'nothing'})`)
check(!records.some((r) => r.header.id === deletedId), 'the ghost itself is gone')

// A directory that comes back (a re-created Session) must be listed again.
await makeStoredSession(deletedId)
records = await wrapper()
check(records.length === 2, 'a Session whose directory came back is listed again')

// Only ids THIS run deleted are ever filtered: bytes gone again, ledger empty.
await rm(join(root, projectKey(cwd), deletedId), { recursive: true, force: true })
ghostIds.clear()
records = await wrapper()
check(records.length === 2, 'an id this run never deleted is never hidden, even when its bytes are gone')

// Fail open: an engine failure is the caller's error, and a broken filter keeps rows.
ghostIds.add(deletedId)
const brokenEngine = { listSessions: async () => { throw new Error('engine down') } }
const saved = ctx.get
ctx.get = (name) => (name === 'sessionQuery' ? brokenEngine : saved.call(ctx, name))
let engineError = null
await wrapper().catch((error) => { engineError = error })
check(engineError?.message === 'engine down', 'an engine failure is propagated, not swallowed')
ctx.get = saved
ghostIds.clear()

console.log(`\nbuild: ${BUILD}`)
await rm(home, { recursive: true, force: true })
console.log(failures === 0 ? 'ALL HOST FILTER CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
