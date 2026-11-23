/**
 * P1 regression gate — "a filesystem fault must not leave the session archived".
 *
 * WHAT IT DOES
 *   `deleteSessionLocked` fences the session by writing the archive record, then
 *   removes bytes, then rolls back if the main directory survived. Before the
 *   fix, the rollback was only reached when the removal loop completed normally:
 *   the `pathExists()` re-check rethrew any non-ENOENT error (EACCES, EPERM,
 *   ELOOP …), so an fs fault in that window skipped the rollback and the session
 *   stayed archived with its pin dropped.
 *
 *   Nothing can inject that fault from outside — `lstat` is a module import — so
 *   this script copies the real `index.js` to a temp file, rewrites only its
 *   `node:fs/promises` import into a shim that reports EACCES once the target path
 *   is gone, and runs the real deletion core against a throwaway fake DSH home.
 *   The copy is generated from the shipped source on every run, so this stays a
 *   test of the shipped code, not of a fixture. It stays green only while the
 *   removal loop is wrapped in `try { … } finally { … }` and the rollback is
 *   exception-safe.
 *
 * EXPECTED RESULT
 *   RED  (exit 1) while the gap is unfixed — the failure output names the patch.
 *   GREEN (exit 0) once the removal loop is wrapped in `try { … } finally { … }`.
 *
 *   node tools/verify-rollback-fault.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../index.js', import.meta.url)
const IMPORT_LINE = "import { lstat, readdir, rm } from 'node:fs/promises'"
const SHIM = `import { lstat as __lstat, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
let __faultPath = null
export function __setFaultPath(path) { __faultPath = path }
const lstat = async (path, ...rest) => {
  if (__faultPath !== null && String(path) === __faultPath && !existsSync(__faultPath)) {
    const error = new Error('EACCES (injected by verify-rollback-fault)')
    error.code = 'EACCES'
    throw error
  }
  return __lstat(path, ...rest)
}`

const workdir = await mkdtemp(join(tmpdir(), 'dsh-rollback-fault-'))
let failures = 0
const check = (ok, label) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) failures++
}

try {
  /* ---------------- generate a fault-injecting copy of the shipped host half ---------------- */
  const source = readFileSync(SOURCE, 'utf8')
  if (!source.includes(IMPORT_LINE)) {
    console.log('FAIL  the host half no longer imports node:fs/promises the way this harness rewrites')
    process.exit(1)
  }
  const modulePath = join(workdir, 'index-under-test.mjs')
  writeFileSync(modulePath, source.replace(IMPORT_LINE, SHIM))
  // Keep this synthetic deletion out of the host's real diagnostic channel.
  process.env.DSH_DELETE_SESSION_DIAGNOSTICS = join(workdir, 'diagnostics.jsonl')
  const { deleteSession, projectKey, __setFaultPath } = await import(modulePath)

  /* ---------------- a throwaway fake DSH home ---------------- */
  const home = join(workdir, 'home')
  const root = join(home, 'sessions')
  const cwd = '/Users/example/project'
  const sessionId = 'session-fault-1'
  const dir = join(root, projectKey(cwd), sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.lock'), '')
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(1024))

  const calls = []
  const registry = {
    archivedSessionIds: [],
    pinnedSessionIds: [sessionId],
    async archiveSession(id, options) {
      calls.push(['archive', id, options?.stopActivity === true])
      this.archivedSessionIds = [...this.archivedSessionIds, id]
      this.pinnedSessionIds = this.pinnedSessionIds.filter((entry) => entry !== id)
    },
    async unarchiveSession(id) {
      calls.push(['unarchive', id])
      this.archivedSessionIds = this.archivedSessionIds.filter((entry) => entry !== id)
    },
    async pinSession(id) {
      calls.push(['pin', id])
      this.pinnedSessionIds = [...this.pinnedSessionIds, id]
    },
    async unpinSession() {},
    list: () => [],
  }
  const ctx = {
    get(name) {
      if (name === 'sessionPersistence') return { root, list: async () => [{ header: { id: sessionId, cwd, delegationDepth: 0 }, revision: 'r1' }] }
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessions') return { get: () => undefined, flush: async () => {} }
      return undefined
    },
    waterfall: async () => [],
    parallel: async () => {},
    emit: () => {},
    logger: { info() {}, warn() {} },
  }

  /* ---------------- run with the fault planted exactly at the re-check ---------------- */
  __setFaultPath(dir)
  let outcome
  try {
    const result = await deleteSession(ctx, { sessionId })
    outcome = `resolved (${result.deletedIds.length} deleted)`
  } catch (error) {
    outcome = `threw ${error.code ?? error.name}`
  }

  console.log(`injected fault    : EACCES on lstat("${sessionId}") after its directory was removed`)
  console.log(`delete outcome    : ${outcome}`)
  console.log(`directory removed : ${!existsSync(dir)}`)
  console.log(`archived after    : ${registry.archivedSessionIds.includes(sessionId)}`)
  console.log(`pin restored      : ${registry.pinnedSessionIds.includes(sessionId)}`)
  console.log('')

  check(!existsSync(dir), 'the injected fault fired after the directory was removed')
  check(!registry.archivedSessionIds.includes(sessionId),
    'a fault while removing bytes must not leave the session archived')
  check(registry.pinnedSessionIds.includes(sessionId),
    'a fault while removing bytes must restore the dropped pin')

  if (failures > 0) {
    console.log('\nP1 REPRODUCED: the rollback at index.js:702 is unreachable when the removal loop throws.')
    console.log('Fix: wrap the removal loop in try/finally so `if (!mainGone) await rollback()` always runs,')
    console.log('     e.g.  let mainGone = false')
    console.log('           try { for (const entry of targets) { … } mainGone = deletedIds.includes(sessionId) }')
    console.log('           finally { if (!mainGone) await rollback() }')
    console.log('See DSH删除会话插件-验收反馈-20261001.md §4/P1.')
  } else {
    console.log('\nROLLBACK FAULT GATE PASSED')
  }
} catch (error) {
  console.error('harness error:', error)
  failures++
} finally {
  await rm(workdir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
