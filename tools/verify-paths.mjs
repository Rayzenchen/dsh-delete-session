/**
 * Path derivation and containment checks for the Host half.
 *
 * Everything that needs a filesystem runs inside a throwaway directory under the
 * system temp dir, so this suite is reproducible on any machine. The one section
 * that looks at the real `~/.dsh/sessions` tree is optional: it verifies every
 * stored Session directory still resolves, and prints SKIP when there is nothing
 * to check (a fresh clone, CI, another user's machine).
 *
 *   node tools/verify-paths.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { projectKey, locateSessionDir, sessionsRoot, encodeSegment } from '../index.js'

const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
const liveRoot = join(dshHome, 'sessions')
let failures = 0
let skips = 0
const check = (ok, label) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) failures++
}
const skip = (label) => {
  console.log('SKIP  ' + label)
  skips++
}

/* ---------------- 1. pure derivation ---------------- */

// Fixtures, not this machine: the encoding must be reproducible everywhere.
check(projectKey('/Users/example/project') === '--Users-example-project--',
  'projectKey: plain path')
check(projectKey('/Users/example/My Project') === '--Users-example-My~0020Project--',
  'projectKey: a space becomes ~0020')
check(projectKey('/Users/example/LaTeX撰写') === '--Users-example-LaTeX~64B0~5199--',
  'projectKey: non-ASCII becomes ~<hex>')
check(projectKey('/') === '--root--',
  'projectKey: the filesystem root falls back to "root"')

check(encodeSegment('..') === '~002E~002E' && encodeSegment('.') === '~002E',
  'encodeSegment: traversal names are neutralized')
check(encodeSegment('session-094baf57-0738-4a95-8b4c-aed0dff8267c') === 'session-094baf57-0738-4a95-8b4c-aed0dff8267c',
  'encodeSegment: a uuid-like id is unchanged')
check(encodeSegment('a b') === 'a~0020b',
  'encodeSegment: a space is encoded, not dropped')

/* ---------------- 2. a synthetic sessions root ---------------- */

const fixtureCwd = '/Users/example/My Project'
const scratch = await mkdtemp(join(tmpdir(), 'dsh-paths-'))
const root = join(scratch, 'sessions')
const projectDir = join(root, projectKey(fixtureCwd))
const sessionDir = join(projectDir, 'session-alpha')
await mkdir(sessionDir, { recursive: true })
await writeFile(join(sessionDir, 'session.v1.jsonl.zstd'), '')

try {
  check((await locateSessionDir(root, 'session-alpha', undefined)) === sessionDir,
    'locateSessionDir: resolves by scanning the projects')
  check((await locateSessionDir(root, 'session-alpha', fixtureCwd)) === sessionDir,
    'locateSessionDir: resolves through header.cwd (preferred path)')
  check((await locateSessionDir(root, 'session-alpha', '/Users/example/other')) === sessionDir,
    'locateSessionDir: a wrong cwd falls back to the scan')

  check((await locateSessionDir(root, '..', undefined)) === null,
    'locateSessionDir: a traversal id matches nothing')
  check((await locateSessionDir(root, '../../..', undefined)) === null,
    'locateSessionDir: a multi-level traversal id matches nothing')
  check((await locateSessionDir(root, 'session-not-there', undefined)) === null,
    'locateSessionDir: a missing session is reported as absent')

  // Finder drops `.DS_Store` in the sessions root; joining it into a candidate
  // path used to throw ENOTDIR and abort the whole scan.
  await writeFile(join(root, '.DS_Store'), '')
  check((await locateSessionDir(root, 'session-alpha', undefined)) === sessionDir,
    'locateSessionDir: a stray file in the root does not abort the scan')

  // The same encoded id under two projects is ambiguous, and must refuse rather
  // than guess (deleting the wrong directory would be unrecoverable).
  const secondProject = join(root, projectKey('/Users/example/another'))
  await mkdir(join(secondProject, 'session-alpha'), { recursive: true })
  const ambiguous = await locateSessionDir(root, 'session-alpha', undefined).catch((error) => error)
  check(ambiguous?.code === 'ambiguous-location' && ambiguous?.status === 409,
    'locateSessionDir: two matching directories refuse with ambiguous-location')

  // A symlinked project directory must not be followed out of the root.
  const outside = await mkdtemp(join(tmpdir(), 'dsh-paths-outside-'))
  try {
    await mkdir(join(outside, 'session-escape'), { recursive: true })
    const linkProject = join(root, '--linked--')
    try {
      await (await import('node:fs/promises')).symlink(outside, linkProject, 'dir')
      const escaped = await locateSessionDir(root, 'session-escape', undefined)
      check(escaped === null, 'locateSessionDir: a symlinked project does not expose an outside session')
    } catch (error) {
      skip(`symlink containment not exercised (${error.code ?? error.message})`)
    }
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}

/* ---------------- 3. sessionsRoot ---------------- */

const fakeCtx = { get: () => undefined }
check(sessionsRoot(fakeCtx) === join(dshHome, 'sessions'), 'sessionsRoot: falls back to DSH_HOME')

/* ---------------- 4. the live tree (optional) ---------------- */

/**
 * Resolve every Session this machine actually stores.
 *
 * Skipped when there is nothing to look at: the point of the suite is the
 * derivation code, and requiring a populated `~/.dsh` would make it unportable.
 */
async function liveSection() {
  let projects
  try {
    projects = readdirSync(liveRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch (error) {
    skip(`no live sessions root at ${liveRoot} (${error.code ?? 'unreadable'})`)
    return
  }
  let checked = 0
  for (const project of projects) {
    let entries
    try {
      entries = readdirSync(join(liveRoot, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(liveRoot, project.name, entry.name)
      let files
      try {
        files = readdirSync(dir)
      } catch {
        continue
      }
      if (!files.includes('session.lock') && !files.some((name) => name.startsWith('session.v'))) continue
      const resolved = await locateSessionDir(liveRoot, entry.name, undefined).catch((error) => `ERR:${error.code ?? error.message}`)
      if (resolved !== dir) {
        check(false, `live: ${entry.name} resolved to ${resolved} instead of ${dir}`)
        continue
      }
      checked++
    }
  }
  if (checked === 0) skip('no stored Session directories under the live root')
  else check(true, `live: ${checked} stored Session directories resolve through containment`)
}

await liveSection()

if (failures === 0) {
  console.log(`\nALL PATH CHECKS PASSED${skips > 0 ? ` (${skips} skipped)` : ''}`)
} else {
  console.log(`\n${failures} CHECK(S) FAILED${skips > 0 ? `, ${skips} skipped` : ''}`)
}
process.exit(failures === 0 ? 0 : 1)
