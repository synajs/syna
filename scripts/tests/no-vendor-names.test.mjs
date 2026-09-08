// 1.0.0-rc.2 (A04, §2.6): no real vendor name as a fictional component name and no pre-rc.2 name of the reference
// application as a component name or path — `OpenAI`, `Claude`, `hyla-mini` — anywhere in the current line: sources,
// tests, examples, benchmarks, scripts, workflow, current documents and package metadata. Historical documents, the
// ledgers under work/, the recorded evidence under validation/ and the earlier gates are records and keep their words
// (scripts/lib/vendor-name-scan.mjs lists them). The reference application's own literals that the rename left alone
// (the manifest tag, the advisory-lock namespaces, the log prefixes, the schema default) are allowed by name and
// reported, so the allow-list is visible in every run.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ALLOWED_LITERALS, isHistorical, scanVendorNames } from '../lib/vendor-name-scan.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('no vendor name or pre-rc.2 application name as a component name or path outside the historical records', () => {
  const { files, hits, allowed } = scanVendorNames(root)
  assert.ok(files.length > 100, `scanned ${files.length} files`)
  assert.ok(files.includes('package.json') && files.includes('README.md') && files.includes('docs/API_REFERENCE.md'), 'the current documents and metadata are scanned')
  assert.ok(files.some(file => file.startsWith('apps/multitenant-blog/src/')) && files.some(file => file.startsWith('apps/01-basics/')), 'the application and the examples are scanned')
  assert.deepEqual(hits, [], `vendor or old names found:\n${hits.map(hit => `${hit.file}:${hit.line} [${hit.name}] ${hit.text}`).join('\n')}`)
  // Every allowed literal is one the application still writes or checks; an allowance nobody uses is stale.
  const usedLiterals = new Set(allowed.map(item => item.literal))
  const unused = ALLOWED_LITERALS.map(item => item.literal).filter(literal => !usedLiterals.has(literal))
  assert.deepEqual(unused, [], 'allowed literals no longer present anywhere')
  assert.ok(allowed.every(item => item.file.startsWith('apps/multitenant-blog/') || item.file === 'docs/MULTITENANT_BLOG.md'), `allowed literals outside the application: ${allowed.filter(item => !item.file.startsWith('apps/multitenant-blog/') && item.file !== 'docs/MULTITENANT_BLOG.md').map(item => `${item.file}:${item.line}`).join(', ')}`)
})

test('the historical set is what it says: existing records, never the current documents', () => {
  for (const file of ['docs/AUDIT.md', 'docs/HISTORY.md', 'docs/MIGRATION_V07_TO_V08.md', 'CHANGELOG.md', 'scripts/release-profiles/0.8.0.json', 'scripts/release-profiles/1.0.0-rc.1.json', 'scripts/any-baseline-v0.7.0.json', 'benchmarks/results-v0.8.0-baseline-same-machine.json', 'validation/v1.0.0-rc.1-release/manifest.json', 'validation/v1.0.0-rc.2-dev/logs/build.log']) {
    assert.ok(isHistorical(file), `${file} is historical`)
    if (existsSync(path.join(root, file))) assert.ok(true)
  }
  for (const file of ['README.md', 'docs/API_REFERENCE.md', 'docs/EXAMPLES.md', 'docs/MULTITENANT_BLOG.md', 'docs/DEFERRED.md', 'scripts/verify-release.mjs', 'scripts/release-profiles/1.0.0-rc.5.json', 'scripts/validation-doc.mjs', '.github/workflows/ci.yml', 'package.json', 'benchmarks/results-v1.0.0-rc.2-baseline-same-machine.json', 'validation/README.md']) {
    assert.equal(isHistorical(file), false, `${file} is current`)
  }
})
