// 1.0.0-rc.3: `scripts/benchmark-compare.mjs compare --faster-ok` lets a release register the rows it is faster on than
// the baseline by more than the tolerance (scripts/verify-release.mjs holds the list and the reason). A registration
// accounts for an improvement and can never hide a regression: the same row still fails when it is slower, an
// unregistered row still fails when it is faster, and a registered row fails when it is faster than the floor.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
const script = path.join(root, 'scripts/benchmark-compare.mjs')
const REGISTERED = 'cases.subject.timing.p95Ms'

const environment = {
  platform: 'darwin', arch: 'arm64', cpu: 'Apple M4 Pro', cpuCount: 14, node: 'v26.0.0',
  nodeOptions: ['--expose-gc', '--no-maglev'],
}
/** One median record with two cases: `subject` (the registered row) and `other` (never registered). */
const record = ({ subjectP95, otherP95 }) => JSON.stringify({
  environment,
  cases: [
    { name: 'subject', timing: { p50Ms: 0.1, p95Ms: subjectP95 }, serviceCount: 300 },
    { name: 'other', timing: { p50Ms: 0.1, p95Ms: otherP95 } },
  ],
})

/** Runs `compare` on two written medians and returns `{ ok, stdout }`; a non-zero exit is a failed comparison, not a crash. */
const compare = (baseline, current, extra = []) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'syna-benchmark-registered-'))
  try {
    const baselineFile = path.join(dir, 'baseline.json')
    const currentFile = path.join(dir, 'current.json')
    writeFileSync(baselineFile, record(baseline))
    writeFileSync(currentFile, record(current))
    const argv = [script, 'compare', '--baseline', baselineFile, '--current', currentFile, '--tolerance', '0.10', ...extra]
    try {
      const stdout = execFileSync(process.execPath, argv, { cwd: root, encoding: 'utf8' })
      return { ok: true, stdout }
    }
    catch (error) {
      return { ok: false, stdout: String(error.stdout ?? '') }
    }
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

const registered = ['--faster-ok', REGISTERED, '--faster-floor', '0.30']

test('a registered row that is faster than the baseline by more than the tolerance passes, and says so', () => {
  const result = compare({ subjectP95: 0.3, otherP95: 0.2 }, { subjectP95: 0.246, otherP95: 0.2 }, registered)
  assert.equal(result.ok, true, result.stdout)
  assert.match(result.stdout, /BENCHMARK COMPARISON OK/)
  assert.match(result.stdout, /registered improvement/)
  assert.match(result.stdout, /1 of them registered improvements: cases\.subject\.timing\.p95Ms -18\.0%/)
})

test('the same row still fails when it is slower than the baseline by more than the tolerance', () => {
  const result = compare({ subjectP95: 0.3 }, { subjectP95: 0.36 }, registered)
  assert.equal(result.ok, false, result.stdout)
  assert.match(result.stdout, /BENCHMARK COMPARISON FAILED/)
  assert.match(result.stdout, /cases\.subject\.timing\.p95Ms \| ±10% \| 0\.3000 \| 0\.3600 \| 20\.0% \| NO \|/)
})

test('a row that is not registered still fails when it is faster than the baseline by more than the tolerance', () => {
  const result = compare({ subjectP95: 0.3, otherP95: 0.3 }, { subjectP95: 0.3, otherP95: 0.24 }, registered)
  assert.equal(result.ok, false, result.stdout)
  assert.match(result.stdout, /cases\.other\.timing\.p95Ms \| ±10% \| 0\.3000 \| 0\.2400 \| -20\.0% \| NO \|/)
})

test('a registered row fails when it is faster than the floor: an improvement is accounted for, not unbounded', () => {
  const result = compare({ subjectP95: 0.3 }, { subjectP95: 0.2 }, registered)
  assert.equal(result.ok, false, result.stdout)
  assert.match(result.stdout, /cases\.subject\.timing\.p95Ms \| ±10% \| 0\.3000 \| 0\.2000 \| -33\.3% \| NO \|/)
})

test('without --faster-ok the comparison is the two-sided ±tolerance it has always been', () => {
  const faster = compare({ subjectP95: 0.3 }, { subjectP95: 0.246 })
  assert.equal(faster.ok, false, faster.stdout)
  const within = compare({ subjectP95: 0.3 }, { subjectP95: 0.29 })
  assert.equal(within.ok, true, within.stdout)
})

test('the release gate of 1.0.0-rc.4 registers no row at all, and keeps the floor', () => {
  // Read, never imported: the gate script runs its whole verification when it is loaded.
  const source = readFileSync(path.join(root, 'scripts/verify-release.mjs'), 'utf8')
  const list = source.match(/const BENCHMARK_REGISTERED_FASTER = \[([^\]]*)\]/)
  assert.ok(list, 'the gate names the registered rows')
  const rows = [...list[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  assert.deepEqual(rows, [], 'a correctness round registers nothing: every row is expected within ±10 %')
  assert.match(source, /const BENCHMARK_REGISTERED_FASTER_FLOOR = '0\.30'/)
})

test('an empty registration is the two-sided comparison: a faster row still fails', () => {
  const result = compare({ subjectP95: 0.3 }, { subjectP95: 0.246 }, ['--faster-ok', '', '--faster-floor', '0.30'])
  assert.equal(result.ok, false, result.stdout)
  assert.match(result.stdout, /BENCHMARK COMPARISON FAILED/)
})
