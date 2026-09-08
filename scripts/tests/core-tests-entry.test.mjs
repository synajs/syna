// The core suite has one entry (`scripts/core-tests.mjs`) and two callers: `npm test` at the root and
// `npm --prefix packages/core test`. The package-local one used to be `node --test tests/*.test.mjs`,
// which stopped matching anything when the suites moved into behaviour-domain directories in
// 1.0.0-rc.5 — and reported success with zero tests. What is asserted here is that the entry finds
// every case that is there, that both callers go through it, and that finding nothing is a failure.
// And that what a caller puts behind `--` reaches `node --test` intact: the entry consumes `--list`
// and `--dir <path>` and forwards the rest, which for a while meant forwarding all but the first.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const entry = path.join(root, 'scripts/core-tests.mjs')
/**
 * These cases read what the `node --test` the entry spawns writes, and this file is itself running
 * under `node --test`, which marks its children with `NODE_TEST_CONTEXT`. Inherited that far down,
 * it puts the grandchild on the runner's serializer channel and its stdout stays empty. The entry
 * passes its environment on untouched, so the mark is dropped here, at the top of the chain.
 */
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
const launch = (args, options = {}) => execFileSync(process.execPath, args, { encoding: 'utf8', env, ...options })
const run = (args, options = {}) => launch([entry, ...args], { cwd: root, ...options })

/**
 * Two cases that announce which of them ran. `--test-name-pattern` skips the body of the one it does
 * not match, so what reaches stdout says whether the pattern arrived at `node --test` — an exit code
 * would not: both cases pass either way.
 */
const fixture = (at) => {
  mkdirSync(at, { recursive: true })
  for (const name of ['alpha', 'beta']) {
    writeFileSync(path.join(at, `${name}.test.mjs`),
      `import test from 'node:test'\ntest('${name}', () => { console.log('RAN ${name}') })\n`)
  }
  return at
}
const temporary = () => mkdtempSync(path.join(tmpdir(), 'syna-core-tests-'))

test('an argument is forwarded when no --dir precedes it: the first one is not eaten', () => {
  // The default discovery root is `packages/core/tests` under the entry's own directory, so the entry
  // is copied — the file itself, not a second implementation of it — beside a tree of its own. That
  // is the shape `npm --prefix packages/core test -- --test-name-pattern=…` takes: no `--dir` at all,
  // and the pattern first. `indexOf('--dir')` is -1 there, and an index test against `dirFlag + 1`
  // dropped argv[0]; the pattern never reached `node --test` and every case ran.
  const home = temporary()
  try {
    mkdirSync(path.join(home, 'scripts'), { recursive: true })
    copyFileSync(entry, path.join(home, 'scripts/core-tests.mjs'))
    fixture(path.join(home, 'packages/core/tests'))
    const output = launch([path.join(home, 'scripts/core-tests.mjs'), '--test-name-pattern=^alpha$', '--test-reporter=tap'], { cwd: home })
    assert.match(output, /RAN alpha/, 'the case the pattern names ran')
    assert.doesNotMatch(output, /RAN beta/, 'the pattern reached node --test: the other case did not run')
  }
  finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an invalid first argument fails the run rather than disappearing', () => {
  // The same drop with an option `node --test` rejects: it went missing, the suite ran to the end and
  // the command exited 0 — a run that should have failed reported success.
  assert.throws(() => run(['--definitely-invalid-option'], { stdio: 'pipe' }), error => {
    assert.notEqual(error.status, 0, 'exit code')
    assert.match(String(error.stderr), /--definitely-invalid-option/, 'node saw the option and rejected it')
    return true
  })
})

test('--dir points discovery elsewhere and the arguments behind it are still forwarded', () => {
  const home = temporary()
  try {
    fixture(home)
    const output = run(['--dir', home, '--test-name-pattern=^alpha$', '--test-reporter=tap'])
    assert.match(output, /RAN alpha/, 'the case the pattern names ran')
    assert.doesNotMatch(output, /RAN beta/, 'and only that one')
    assert.doesNotMatch(output, /--dir/, '`--dir` and its path were consumed, not passed on')
  }
  finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--list prints what --dir discovered and runs none of it', () => {
  const home = temporary()
  try {
    fixture(home)
    const output = run(['--list', '--dir', home])
    assert.deepEqual(output.trim().split('\n').map(file => path.basename(file)), ['alpha.test.mjs', 'beta.test.mjs'])
    assert.doesNotMatch(output, /RAN /, 'nothing ran')
  }
  finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the entry discovers every core test file, recursively, and nothing else', () => {
  const walk = (dir) => readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(item =>
    item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)])
  const present = walk('packages/core/tests').filter(file => file.endsWith('.test.mjs')).sort()
  const discovered = run(['--list']).trim().split('\n')
  assert.ok(present.length > 0, 'the suite is not empty')
  assert.deepEqual(discovered, present, 'the entry runs exactly the test files in the tree')
  assert.ok(discovered.some(file => file.split('/').length > 4), 'the cases live in subdirectories; discovery recurses')
})

test('both callers go through the entry: no second, drifting list of test files', () => {
  const scriptOf = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8')).scripts.test
  assert.match(scriptOf('package.json'), /node scripts\/core-tests\.mjs/, 'the workspace test script')
  assert.match(scriptOf('packages/core/package.json'), /node \.\.\/\.\.\/scripts\/core-tests\.mjs/, 'the package test script')
  for (const file of ['package.json', 'packages/core/package.json']) {
    assert.doesNotMatch(scriptOf(file), /--test .*tests\//, `${file} does not list test files of its own`)
  }
})

test('discovering nothing exits non-zero: a run without tests is a failure, not a pass', () => {
  const empty = temporary()
  try {
    assert.throws(() => run(['--dir', empty], { stdio: 'pipe' }), error => {
      assert.equal(error.status, 1, 'exit code')
      assert.match(String(error.stderr), /discovers nothing is a failure/)
      return true
    })
  }
  finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
