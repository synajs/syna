// 1.0.0-rc.1 (the first public candidate): no current file recommends a package that will not be on the registry.
// The runtime is `syna` and the presets are `@synajs/tsconfig`; the temporary identities `@syna/core` and
// `@syna/tsconfig` belong to the record — the history, the migrations, the recorded gate runs, the ledgers under work/
// and the benchmark records keep them (scripts/lib/package-name-scan.mjs lists them). The two current lines that spell
// an old name on purpose — the runtime's own nominal package identity, which is serialized and therefore frozen, and
// the sentence of docs/API_STABILITY.md that says which name the surface was frozen under — are allowed by literal and
// reported, so the allow-list is visible in every run.
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ALLOWED_LITERALS, isHistorical, scanPackageNames } from '../lib/package-name-scan.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('no current file installs, imports or extends the temporary package identities', () => {
  const { files, hits, allowed, marked } = scanPackageNames(root)
  assert.ok(files.length > 100, `scanned ${files.length} files`)
  for (const file of ['README.md', 'README.zh-CN.md', 'package.json', 'package-lock.json', 'packages/core/package.json',
    'packages/core/README.md', 'packages/tsconfig/package.json', 'docs/API_REFERENCE.md', 'docs/PACKAGE_AUTHORING.md',
    'apps/01-basics/src/index.ts', 'apps/01-basics/tsconfig.json', 'scripts/verify-release.mjs']) {
    assert.ok(files.includes(file), `${file} is scanned`)
  }
  assert.deepEqual(hits, [], `the temporary package identity is still recommended:\n${hits.map(hit => `${hit.file}:${hit.line} [${hit.name}] ${hit.text}`).join('\n')}`)
  const usedLiterals = new Set(allowed.map(item => item.literal))
  assert.deepEqual(ALLOWED_LITERALS.map(item => item.literal).filter(literal => !usedLiterals.has(literal)), [],
    'allowed literals no longer present anywhere: the exception is stale')
  assert.deepEqual([...new Set(allowed.map(item => item.file))].sort(), ['docs/API_STABILITY.md', 'packages/core/src/runtime.ts'],
    'the exceptions are the frozen nominal identity and the sentence that records the earlier name')
  // The marker is for lines that explain the rename; nothing else may carry it.
  assert.deepEqual([...new Set(marked.map(item => item.file))].sort(), ['CONTRIBUTING.md', 'docs/API_STABILITY.md', 'scripts/validation-doc.mjs', 'scripts/verify-release.mjs'],
    `marked lines outside the two paragraphs that record the rename, the gate and the document it generates: ${marked.map(item => `${item.file}:${item.line}`).join(', ')}`)
})

test('the current line names the public packages', () => {
  const manifest = JSON.parse(readFile('packages/core/package.json'))
  assert.equal(manifest.name, 'syna')
  const presets = JSON.parse(readFile('packages/tsconfig/package.json'))
  assert.equal(presets.name, '@synajs/tsconfig')
  assert.equal(manifest.version, presets.version, 'the two packages are released in lockstep')
  // A runtime consumer never needs the presets: they are a package-author tool (docs/PACKAGE_AUTHORING.md).
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.ok(!Object.keys(manifest[field] ?? {}).includes('@synajs/tsconfig'), `@synajs/tsconfig is not a runtime ${field}`)
  }
  assert.ok(readFile('README.md').includes('npm install syna@rc'), 'the README installs the public package')
  // The release profile is what the gate packs and audits: it must declare the packages this tree actually has.
  const workspaceVersion = JSON.parse(readFile('package.json')).version
  const profile = JSON.parse(readFile(`scripts/release-profiles/${workspaceVersion}.json`))
  assert.deepEqual(profile.constants.packages, {
    runtime: { directory: 'packages/core', name: manifest.name, version: manifest.version },
    tsconfig: { directory: 'packages/tsconfig', name: presets.name, version: presets.version },
  })
})

test('the historical set is what it says: existing records, never the current line', () => {
  for (const file of ['docs/HISTORY.md', 'docs/MIGRATION_V07_TO_V08.md', 'CHANGELOG.md', 'RELEASE_MANIFEST.json',
    'scripts/release-profiles/1.0.0-rc.5.json', 'benchmarks/results-v1.0.0-rc.4-baseline-same-machine.json',
    'validation/v1.0.0-rc.5-release/manifest.json', 'docs/audit/audit-3-backends-delivery/p1-pg-transaction-silent-rollback.mjs']) {
    assert.ok(isHistorical(file), `${file} is a record of the earlier identity`)
  }
  for (const file of ['README.md', 'README.zh-CN.md', 'packages/core/README.md', 'docs/API_REFERENCE.md',
    'docs/API_STABILITY.md', 'docs/PACKAGE_AUTHORING.md', 'scripts/verify-release.mjs', 'package.json',
    'scripts/release-profiles/1.0.0-rc.6.json', '.github/workflows/ci.yml']) {
    assert.equal(isHistorical(file), false, `${file} is current`)
  }
})

function readFile(relative) {
  return process.getBuiltinModule('node:fs').readFileSync(path.join(root, relative), 'utf8')
}
