// Compile and run the three connected README snippets as the reader's src/mailers.ts.
// The definitions, admitted services and Entry arguments must come from the document;
// the harness supplies no declarations to make an incomplete snippet type-check.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readmePrograms } from '../lib/readme-programs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const programs = readmePrograms(readFileSync(path.join(root, 'README.md'), 'utf8'))

test('English and Chinese READMEs carry the same connected TypeScript snippets', () => {
  const chinese = readmePrograms(readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8'))
  assert.equal(programs.snippets.length, 3, 'selection, override and diagnostics')
  assert.deepEqual(chinese.snippets, programs.snippets, 'code has one meaning in both languages')
})

test('README selection, override and diagnostics compile and run without hidden scaffolding', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'syna-readme-snippets-'))
  try {
    symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir')
    for (const file of ['package.json', 'tsconfig.json']) {
      const item = programs.files.find(item => item.file === file)
      assert.ok(item, `${file} is declared in the README`)
      writeFileSync(path.join(directory, file), item.code)
    }
    mkdirSync(path.join(directory, 'src'))
    // These are result assertions, not helper definitions for the snippets.
    const assertions = `
import assert from 'node:assert/strict'
assert.deepEqual(recorded, ['owner@example.test: hello'], 'the fake handled the request exactly once')
assert.equal(runtime.inspect().liveEnvCount, 0, 'selection example closed its environments')
assert.equal(testRuntime.inspect().liveEnvCount, 0, 'override example closed its environments')
assert.equal(diagnosticRuntime.inspect().liveEnvCount, 0, 'diagnostics closed its environment')
console.log('README snippets: OK')
`
    writeFileSync(path.join(directory, 'src/mailers.ts'), programs.snippets.join('\n') + assertions)
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--pretty', 'false'], {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    })
    const stdout = execFileSync(process.execPath, ['dist/mailers.js'], {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    })
    assert.match(stdout, /^acme: API -> owner@example\.test: hello$/m, 'the stored choice selected the API provider')
    assert.doesNotMatch(stdout, /MISSING_(?:SERVICE|INPUT|BINDING|IMPLEMENTATION)/, 'the diagnostics plan is satisfiable')
    assert.match(stdout, /^README snippets: OK$/m)
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
