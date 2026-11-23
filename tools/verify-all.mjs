/**
 * Runs every verification suite in one go and prints a summary.
 *
 * Each suite is a self-contained `node` script that prints `PASS` / `FAIL` / `SKIP`
 * lines and exits non-zero on failure. This runner aggregates them so `npm test`
 * (and CI) has one entry point and one exit code.
 *
 *   npm test
 *   node tools/verify-all.mjs
 *   VERBOSE=1 node tools/verify-all.mjs   # stream each suite's output
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const verbose = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true'

const suites = [
  ['verify-paths.mjs', 'path derivation and containment'],
  ['verify-delete.mjs', 'deletion core'],
  ['verify-host-filter.mjs', 'session-list ghost filter'],
  ['verify-rollback-fault.mjs', 'rollback after an fs fault'],
  ['verify-client-ghosts.mjs', 'client ghost suppression'],
  ['verify-client-dialog.mjs', 'client menu and dialog rendering'],
]

const results = []
for (const [file, label] of suites) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [join(here, file)], {
    cwd: join(here, '..'),
    encoding: 'utf8',
    env: process.env,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const count = (tag) => output.split('\n').filter((line) => line.startsWith(tag)).length
  const result = {
    file,
    label,
    pass: count('PASS'),
    fail: count('FAIL'),
    skip: count('SKIP'),
    status: run.status,
    seconds: (Date.now() - started) / 1000,
    output,
  }
  results.push(result)

  const verdict = run.status === 0 && result.fail === 0 ? 'ok  ' : 'FAIL'
  const parts = [`${result.pass} pass`, `${result.fail} fail`, `${result.skip} skip`]
  console.log(`${verdict}  ${file.padEnd(26)} ${parts.join('  ').padEnd(28)} ${result.seconds.toFixed(1)}s  ${label}`)

  if (verbose || run.status !== 0 || result.fail > 0) {
    for (const line of output.split('\n')) {
      if (line.trim().length > 0) console.log(`      ${line}`)
    }
  }
}

const totals = results.reduce((accumulator, result) => ({
  pass: accumulator.pass + result.pass,
  fail: accumulator.fail + result.fail,
  skip: accumulator.skip + result.skip,
}), { pass: 0, fail: 0, skip: 0 })
const broken = results.filter((result) => result.status !== 0 || result.fail > 0)

console.log('')
console.log(`${totals.pass} passed, ${totals.fail} failed, ${totals.skip} skipped across ${results.length} suites`)
if (broken.length > 0) {
  console.log(`\n${broken.length} suite(s) did not pass: ${broken.map((result) => result.file).join(', ')}`)
  process.exit(1)
}
if (totals.skip > 0) {
  console.log('Skipped suites need optional dev dependencies (`npm install`) or a populated ~/.dsh.')
}
process.exit(0)
