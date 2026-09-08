#!/usr/bin/env node
// Mutation audit — a manual check that the tests can still reject a wrong implementation.
//
// The third independent review of 1.0.0-rc.4 injected two errors into an isolated
// compiled copy of the core and found that the suite passed anyway: a re-entering
// observer that fulfils instead of joining the close (55/55 green), and every waiter
// deadline armed for four times its configured timeout (8/8 green). Both are recorded
// here as the standing counter-examples the relevant tests must reject.
//
// This runs on demand, never as part of the gate: the gate reads the record this
// writes (`work/rc5/mutations/RESULTS.json`) and checks that the sources and tests it
// was produced from are still the ones in the tree.
//
//   node scripts/mutation-audit.mjs             # both mutants, exit 1 if one survives
//   node scripts/mutation-audit.mjs --only=m1   # one of them
//   node scripts/mutation-audit.mjs --expect-survival
//         # the rc.4 baseline: record the run and exit 0 even when nothing is killed
//
// The working copies live under `work/mutations/` (untracked). Neither the sources nor
// the compiled output of the workspace is modified.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = join(ROOT, 'packages/core')
const RUNS = join(ROOT, 'work/mutations')
const RECORD_DIR = join(ROOT, 'work/rc5/mutations')
const RECORD = join(RECORD_DIR, 'RESULTS.json')

/**
 * Each mutant names the compiled statement it rewrites — located by scanning the
 * compiled tree, so that moving a function between modules does not silently turn the
 * audit into a no-op — and the tests that are supposed to reject it.
 */
export const MUTANTS = [
  {
    id: 'm1',
    name: 'join-premature',
    title: 'a re-entering observer fulfils instead of joining the close',
    find: 'await this.disposePromise;',
    replace: 'return; /* MUTANT M1 */',
    occurrences: 2,
    files: 1,
    source: 'packages/core/src/runtime.ts',
    explanation:
      'Both `joinClose()` methods yield one microtask and then fulfil. The real close still '
      + 'runs to the end and still reports its cleanup failure to the caller that started it; '
      + 'only the re-entering observer is answered early, with success. A test kills this by '
      + 'asserting the inner observer\'s own outcome, not just that the cleanup ran once.',
    tests: [
      'disposal/close-reentry.test.mjs',
      'disposal/cleanup-phase.test.mjs',
    ],
  },
  {
    id: 'm2',
    name: 'deadline-4x',
    title: 'every waiter deadline is armed for four times its configured timeout',
    find: 'deadlines.add(waiter, performance.now() + Math.max(0, deadlineMs));',
    replace: 'deadlines.add(waiter, performance.now() + Math.max(0, deadlineMs * 4)); /* MUTANT M2 */',
    occurrences: 1,
    files: 1,
    source: 'packages/core/src/internal/deadline-queue.ts',
    explanation:
      'A waiter is armed at four times its `loadTimeoutMs`; the error it eventually reports '
      + 'still names the configured value. A test kills this only by observing when the '
      + 'deadline fires — a controlled clock, or the phase the run has reached — rather than '
      + 'by an upper bound wide enough to hold both.',
    tests: [
      'materialization/waiter-termination.test.mjs',
      'materialization/deadline-clock.test.mjs',
    ],
  },
]

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])

/** The one compiled file that carries the statement this mutant rewrites. */
const locate = mutant => {
  const hits = walk(join(CORE, 'dist'))
    .filter(path => path.endsWith('.js'))
    .map(path => ({ path, count: readFileSync(path, 'utf8').split(mutant.find).length - 1 }))
    .filter(hit => hit.count > 0)
  const total = hits.reduce((sum, hit) => sum + hit.count, 0)
  if (hits.length !== mutant.files || total !== mutant.occurrences) {
    throw new Error(`${mutant.name}: expected ${mutant.occurrences} occurrence(s) in ${mutant.files} compiled file(s), `
      + `found ${total} in ${hits.length} (${hits.map(hit => relative(CORE, hit.path)).join(', ') || 'none'}). `
      + 'Rebuild, or update the anchor in scripts/mutation-audit.mjs.')
  }
  return hits[0].path
}

/** An isolated copy of the compiled core and the tests, with the mutation applied. */
const build = (mutant, compiled) => {
  const tree = join(RUNS, mutant.name)
  rmSync(tree, { recursive: true, force: true })
  mkdirSync(join(tree, 'packages/core'), { recursive: true })
  cpSync(join(CORE, 'dist'), join(tree, 'packages/core/dist'), { recursive: true })
  cpSync(join(CORE, 'package.json'), join(tree, 'packages/core/package.json'))
  for (const test of mutant.tests) {
    const target = join(tree, 'packages/core/tests', test)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(CORE, 'tests', test), target)
  }
  const helpers = join(CORE, 'tests/helpers')
  if (existsDir(helpers)) cpSync(helpers, join(tree, 'packages/core/tests/helpers'), { recursive: true })
  symlinkSync(join(ROOT, 'node_modules'), join(tree, 'node_modules'), 'dir')

  const target = join(tree, 'packages/core', relative(CORE, compiled))
  const before = readFileSync(target, 'utf8')
  const after = before.replaceAll(mutant.find, mutant.replace)
  if (after === before) throw new Error(`${mutant.name}: the copied file does not carry the statement`)
  writeFileSync(target, after)
  return { tree, patch: unifiedDiff(relative(CORE, compiled), before, after) }
}

const existsDir = path => { try { return statSync(path).isDirectory() } catch { return false } }

/** A one-hunk diff of the single changed line, for the record in work/rc5/mutations/. */
const unifiedDiff = (name, before, after) => {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  const changed = oldLines.flatMap((line, index) => (line === newLines[index] ? [] : [index]))
  const hunks = changed.map(index => {
    const start = Math.max(0, index - 3)
    const end = Math.min(oldLines.length - 1, index + 3)
    const body = []
    for (let line = start; line <= end; line += 1) {
      if (line === index) { body.push(`-${oldLines[line]}`, `+${newLines[line]}`) }
      else body.push(` ${oldLines[line]}`)
    }
    return `@@ -${start + 1},${end - start + 1} +${start + 1},${end - start + 2} @@\n${body.join('\n')}`
  })
  return `--- a/${name}\n+++ b/${name}\n${hunks.join('\n')}\n`
}

/** Node's TAP output, reduced to the counts and the names of the failing tests. */
const parse = output => {
  const counts = Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)]
    .map(([, key, value]) => [key, Number(value)]))
  const failed = [...output.matchAll(/^not ok \d+ - (.*)$/gm)].map(([, name]) => name.trim())
  return { counts, failed }
}

const main = () => {
  const args = process.argv.slice(2)
  const expectSurvival = args.includes('--expect-survival')
  const only = args.find(arg => arg.startsWith('--only='))?.slice('--only='.length)
  const selected = only ? MUTANTS.filter(m => m.id === only || m.name === only) : MUTANTS
  if (selected.length === 0) throw new Error(`no mutant matches --only=${only}`)

  mkdirSync(RECORD_DIR, { recursive: true })
  mkdirSync(RUNS, { recursive: true })

  const inputs = {}
  const results = []
  for (const mutant of selected) {
    const compiled = locate(mutant)
    const { tree, patch } = build(mutant, compiled)
    writeFileSync(join(RECORD_DIR, `${mutant.name}.patch`), patch)

    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
      ...mutant.tests.map(test => join('packages/core/tests', test))],
    { cwd: tree, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 << 20 })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    writeFileSync(join(RECORD_DIR, `${mutant.name}.log`), output)
    const { counts, failed } = parse(output)
    const killed = run.status !== 0 && (counts.fail ?? 0) > 0

    inputs[mutant.source] = sha256(join(ROOT, mutant.source))
    for (const test of mutant.tests) inputs[`packages/core/tests/${test}`] = sha256(join(CORE, 'tests', test))

    results.push({
      id: mutant.id,
      name: mutant.name,
      title: mutant.title,
      explanation: mutant.explanation,
      compiledFile: relative(ROOT, compiled),
      source: mutant.source,
      patch: `work/rc5/mutations/${mutant.name}.patch`,
      log: `work/rc5/mutations/${mutant.name}.log`,
      tests: mutant.tests,
      exit: run.status,
      counts,
      killed,
      killedBy: failed,
      scope: 'isolated compiled copy under work/mutations/; the workspace is not modified',
    })
    const verdict = killed ? `KILLED by ${failed.length} test(s)` : 'SURVIVED'
    process.stdout.write(`${mutant.id} ${mutant.name}: ${verdict} `
      + `(tests ${counts.tests ?? 0}, pass ${counts.pass ?? 0}, fail ${counts.fail ?? 0})\n`)
    for (const name of failed.slice(0, 8)) process.stdout.write(`      ${name}\n`)
    if (failed.length > 8) process.stdout.write(`      … ${failed.length - 8} more\n`)
  }

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim()
  const status = results.every(result => result.killed) ? 'ALL_KILLED' : 'SURVIVED'
  const record = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    commit: head || null,
    partial: selected.length !== MUTANTS.length ? selected.map(m => m.id) : undefined,
    status,
    // The gate re-hashes these: a record produced from other sources is stale, not evidence.
    inputs,
    results,
  }
  const previous = readRecord()
  if (record.partial && previous) {
    // A single-mutant run keeps the other mutant's record instead of dropping it.
    const kept = previous.results?.filter(item => !selected.some(m => m.id === item.id)) ?? []
    record.results = [...record.results, ...kept].sort((a, b) => a.id.localeCompare(b.id))
    record.inputs = { ...previous.inputs, ...inputs }
    record.status = record.results.every(item => item.killed) ? 'ALL_KILLED' : 'SURVIVED'
  }
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`)
  process.stdout.write(`\n${record.status}  →  ${relative(ROOT, RECORD)}\n`)
  if (record.status !== 'ALL_KILLED' && !expectSurvival) process.exitCode = 1
}

const readRecord = () => { try { return JSON.parse(readFileSync(RECORD, 'utf8')) } catch { return undefined } }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
