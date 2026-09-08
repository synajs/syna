// The core suite has one entry (`scripts/core-tests.mjs`) and two callers: `npm test` at the root and
// `npm --prefix packages/core test`. The package-local one used to be `node --test tests/*.test.mjs`,
// which stopped matching anything when the suites moved into behaviour-domain directories in
// 1.0.0-rc.5 — and reported success with zero tests. What is asserted here is that the entry finds
// every case that is there, that both callers go through it, and that finding nothing is a failure.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const entry = path.join(root, 'scripts/core-tests.mjs')
const run = (args, options = {}) => execFileSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8', ...options })

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
  const empty = mkdtempSync(path.join(tmpdir(), 'syna-core-tests-'))
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
