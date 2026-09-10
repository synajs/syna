// The README's programs (1.0.0-rc.1, the first public candidate) are compiled and executed exactly as printed. The
// `package.json`, `tsconfig.json` and the two `src/*.ts` blocks are written to a scratch package that resolves `syna`
// through this workspace's node_modules and is built with the workspace TypeScript under **the README's own
// tsconfig.json** — a plain standalone one, no preset package: what a reader copies is what runs here. Each program's
// stdout must equal the output block that follows it.
//
// The same document is the npm README (packages/core/README.md is a byte-identical copy, asserted below and again from
// inside the packed tarball by the release gate) and README.zh-CN.md carries the same code and output blocks.
//
// The snippets that are not whole programs are checked for invented names instead: every name the README imports from
// `syna` is an export of the built package, and every `define.`/`runtime.`/`env.` call it shows is a declared member.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { declaredExports, importedNames, interfaceMembers, memberCalls, readmePrograms } from '../lib/readme-programs.mjs'

const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const programs = readmePrograms(readme)
const PROGRAMS = [
  { file: 'src/main.ts', built: 'dist/main.js' },
  { file: 'src/tenants.ts', built: 'dist/tenants.js' },
]

test('the README carries the files of its programs, their outputs, and the Chinese README carries the same blocks', () => {
  assert.deepEqual(programs.files.map(item => item.file), ['package.json', 'tsconfig.json', 'src/main.ts', 'src/tenants.ts'])
  const manifest = JSON.parse(programs.files[0].code)
  assert.deepEqual(manifest.imports, { '#syna/package': './package.json' }, 'the package.json of the Quick Start maps #syna/package')
  const compilerOptions = JSON.parse(programs.files[1].code).compilerOptions
  assert.equal(compilerOptions.module, 'NodeNext')
  assert.equal(compilerOptions.resolveJsonModule, true)
  for (const { file } of PROGRAMS) assert.ok(programs.outputs.get(file), `${file} is followed by the output it prints`)
  // The Quick Start is the first program and introduces the five names of the model, nothing else.
  const quickStart = programs.files[2].code
  for (const call of ['define.input<', 'define.service(', 'define.entry(', 'createRuntime(', '.load()', 'onDispose(', 'runtime.run(']) {
    assert.ok(quickStart.includes(call), `the Quick Start uses ${call}`)
  }
  for (const later of ['define.contract', 'define.binding', 'override(', 'reuse:']) {
    assert.ok(!quickStart.includes(later), `the Quick Start leaves ${later} to a later section`)
  }
  const chinese = readmePrograms(readFileSync(join(root, 'README.zh-CN.md'), 'utf8'))
  assert.deepEqual(chinese.files, programs.files, 'README.zh-CN.md carries the same files (code is not translated)')
  assert.deepEqual([...chinese.outputs], [...programs.outputs], 'README.zh-CN.md carries the same outputs')
})

test('the npm README is the canonical README, byte for byte', () => {
  assert.equal(readFileSync(join(root, 'packages/core/README.md'), 'utf8'), readme,
    'packages/core/README.md is a copy of the root README (npm and GitHub show one document); copy it again')
})

test('the README names only what the built package declares', () => {
  const index = readFileSync(join(root, 'packages/core/dist/index.d.ts'), 'utf8')
  const descriptors = readFileSync(join(root, 'packages/core/dist/descriptors.d.ts'), 'utf8')
  const exported = declaredExports(index)
  for (const name of importedNames(readme)) {
    assert.ok(exported.has(name), `the README imports ${name} from 'syna', which the package does not export`)
  }
  const members = {
    define: interfaceMembers(descriptors, 'PackageDefinitions'),
    runtime: interfaceMembers(descriptors, 'Runtime'),
    env: interfaceMembers(descriptors, 'Env'),
  }
  for (const call of memberCalls(readme, Object.keys(members))) {
    const [receiver, member] = call.split('.')
    assert.ok(members[receiver].has(member), `the README calls ${call}(), which is not a member of the built package`)
  }
})

test('the README programs compile under the README tsconfig and print the documented output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'syna-readme-'))
  try {
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
    for (const { file, code } of programs.files) {
      mkdirSync(join(directory, dirname(file)), { recursive: true })
      writeFileSync(join(directory, file), code)
    }
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--pretty', 'false'],
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    for (const { file, built } of PROGRAMS) {
      const stdout = execFileSync(process.execPath, [built], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 })
      assert.equal(stdout, programs.outputs.get(file), `${file} prints what the README says it prints`)
    }
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
