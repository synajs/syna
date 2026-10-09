// 1.0.0-rc.1 (the first public candidate): no current file recommends a package that will not be on the registry.
// The runtime is `synajs` and the presets are `@synajs/tsconfig`; the temporary identities `@syna/core` and
// `@syna/tsconfig` belong to the record — the history, the migrations, the recorded gate runs, the ledgers under work/
// and the benchmark records keep them (scripts/lib/package-name-scan.mjs lists them) — and so does the unscoped `syna`
// the candidate was first prepared as: npm rejected that name under its package-name similarity policy before anything
// was published, the preparation's run is `validation/public/syna-v1.0.0-rc.1-release/`, and a current file that still
// installs, imports, depends on or names `syna` as a package is a hit. The two current lines that spell
// an old name on purpose — the runtime's own nominal package identity, which is serialized and therefore frozen, and
// the sentence of docs/API_STABILITY.md that says which name the surface was frozen under — are allowed by literal and
// reported, so the allow-list is visible in every run.
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ALLOWED_LITERALS, PATTERNS, isHistorical, scanPackageNames } from '../lib/package-name-scan.mjs'

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
  assert.equal(manifest.name, 'synajs')
  const presets = JSON.parse(readFile('packages/tsconfig/package.json'))
  assert.equal(presets.name, '@synajs/tsconfig')
  assert.equal(manifest.version, presets.version, 'the two packages are released in lockstep')
  // A runtime consumer never needs the presets: they are a package-author tool (docs/PACKAGE_AUTHORING.md).
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.ok(!Object.keys(manifest[field] ?? {}).includes('@synajs/tsconfig'), `@synajs/tsconfig is not a runtime ${field}`)
  }
  for (const file of ['README.md', 'README.zh-CN.md', 'packages/core/README.md']) {
    assert.ok(readFile(file).includes('npm install synajs@rc'), `${file} installs the public package`)
    assert.ok(readFile(file).includes("from 'synajs'"), `${file} imports the public package`)
  }
  assert.equal(readFile('README.md'), readFile('packages/core/README.md'), 'the runtime README is the canonical root README, byte for byte')
  // The lockfile links the workspace to the runtime under its public name and under no other.
  const lock = JSON.parse(readFile('package-lock.json'))
  assert.equal(lock.packages['node_modules/synajs']?.resolved, 'packages/core')
  assert.equal(lock.packages['node_modules/syna'], undefined)
  assert.equal(lock.packages['packages/core']?.name, 'synajs')
  // The release profile is what the gate packs and audits: it must declare the packages this tree actually has.
  const workspaceVersion = JSON.parse(readFile('package.json')).version
  const profile = JSON.parse(readFile(`scripts/release-profiles/${workspaceVersion}.json`))
  assert.deepEqual(profile.constants.packages, {
    runtime: { directory: 'packages/core', name: manifest.name, version: manifest.version },
    tsconfig: { directory: 'packages/tsconfig', name: presets.name, version: presets.version },
  })
})

test('the unscoped `syna` is a hit in the forms a package is used in, and in no other', () => {
  const hits = line => PATTERNS.filter(item => item.pattern.test(line)).map(item => item.name)
  // Each of these is what a current file would carry if the rename had been missed.
  for (const line of [
    "import { createRuntime, definePackage } from 'syna'", 'import type { Env } from "syna"', "const runtime = await import('syna')", "require('syna')",
    '    "syna": "1.0.0-rc.1"', '  "name": "syna",', 'npm install syna@rc', 'npm install -D syna', 'npm i syna', '`syna@1.0.0-rc.1`', 'syna@latest',
    'syna-1.0.0-rc.1.tgz', '"node_modules/syna": {', 'node_modules/syna/dist/index.js',
  ]) assert.notDeepEqual(hits(line), [], `a hit: ${line}`)
  // Each of these is the current line, or the word in a role that is not a package: the product's name, the Syna
  // manifest field, the subpath import of a consumer's own package.json, a tag of the blog fixtures, the user of the
  // test cluster, the source archive, the tsconfig tarball and the recorded run of the unpublished preparation.
  for (const line of [
    "import { createRuntime, definePackage } from 'synajs'", "import packageJson from '#syna/package' with { type: 'json' }", "imports: { '#syna/package': './package.json' },",
    '  "syna": {', "syna: { id: 'smoke.consumer' },", '    "synajs": "1.0.0-rc.1"', '  "name": "synajs",', '  "name": "syna-workspace",',
    'npm install synajs@rc', 'npm install -D @synajs/tsconfig', '`synajs@1.0.0-rc.1`', 'postgres://syna@127.0.0.1:54329/postgres',
    "const user = 'syna'", "tags: ['syna'],", '{ "slug": "syna", "name": "Syna" }', 'synajs-tsconfig-1.0.0-rc.1.tgz', 'syna-v1.0.0-rc.6-source.tar.gz',
    '"node_modules/synajs": {', 'node_modules/@syna-demo/logger', 'validation/public/syna-v1.0.0-rc.1-release/', 'The product is Syna; the package is `synajs`.',
  ]) assert.deepEqual(hits(line), [], `not a hit: ${line}`)
})

test('the historical set is what it says: existing records, never the current line', () => {
  for (const file of ['docs/HISTORY.md', 'docs/MIGRATION_V07_TO_V08.md', 'CHANGELOG.md', 'RELEASE_MANIFEST.json',
    'scripts/release-profiles/1.0.0-rc.5.json', 'benchmarks/results-v1.0.0-rc.4-baseline-same-machine.json',
    'validation/v1.0.0-rc.5-release/manifest.json', 'validation/public/syna-v1.0.0-rc.1-release/manifest.json',
    'validation/public/synajs-v1.0.0-rc.1-release/manifest.json',
    'docs/audit/audit-3-backends-delivery/p1-pg-transaction-silent-rollback.mjs']) {
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
