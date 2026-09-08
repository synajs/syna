// v0.6 (Phase D) / v0.7 (A11) / v0.8 (the last rename): the applications, demos, benchmarks, scripts, workflow and
// the core test suites use the current names only. The 0.5 names deleted in 0.6, the 0.6 aliases removed in 0.7.0
// and the 0.7 names renamed in 0.8.0 — types, fields, values, error codes, event names, serialized keys, structures —
// exist nowhere in the public API (api-inventory.test.mjs, deprecations.test.mjs); the only places allowed to spell an
// old name are files or lines marked `syna-v05-compat` or `syna-v08-rename` (the tests that assert an expired form is
// refused, the rename codemod and its fixture test, a gate step that scans for the old tokens), and, in the current
// documentation, lines that explain the removal or the rename. The core source is scanned too, for the deleted names.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
const MARKER = 'syna-v05-compat'
// v0.8: the rename codemod (it spells every pre-0.8 name on purpose: it is the migration) and the tests that assert
// a pre-0.8 form is refused carry this marker instead.
const RENAME_MARKER = 'syna-v08-rename'
const marked = line => line.includes(MARKER) || line.includes(RENAME_MARKER)

// Old name → what replaced it (the message names the replacement).
const OLD_NAMES = [
  [/\bSynaRuntime\b/, 'Runtime'],
  [/\bBoundEntry\b/, 'AnchoredEntry'],
  [/\.bind\([A-Z]\w*\)/, 'env.anchor(entry)'],
  [/\bDependencyRef\b/, 'ServiceRef'],
  [/\bPersistentImplementationRef\b/, 'ImplementationRef'],
  [/\bimplementationId\b/, 'familyId'],
  [/\bDeriveOptions\b/, 'ReuseConstraints'],
  [/\bScopeTarget\b/, 'ReuseTarget'],
  [/\.scope\b/, '.reuse'],
  [/\bscope:\s*[{[]/, 'reuse (definition) or the { reuse } call options'],
  [/\bcontext\.site\b(?!\.)/, 'context.dependencySite'],
  [/\.preload\(/, 'load()'],
  [/(?<!\.)\.selector\b/, 'C.all'],
  [/\bImplementationSelector(Dependency)?\b/, 'ImplementationSet (C.all)'],
  [/\bImplementationLease\b/, 'ImplementationSet (C.all)'],
  [/implementation-selector/, 'the all-collection node kind'],
  [/\bUNAVAILABLE_IMPLEMENTATION\b/, '(deleted with the selector)'],
  [/\bCONSTRAINT_VIOLATION\b/, 'FRESH_CONSTRAINT_FAILED'],
  [/\bserviceRange\b/, 'revision.range()'],
  [/\b(planCache|initialization|disposal|planning):\s*\{/, 'limits: { … }'],
  [/\b(initialization\.deadlineMs|disposal\.graceMs|planning\.searchBudget)\b/, 'limits.<key>'],
  [/\bPlanCacheOptions\b|\bInitializationOptions\b|\bDisposalOptions\b|\bPlanningOptions\b/, 'RuntimeLimits'],
  [/\bEntryParameterValues?\b|\bEntryRunArguments\b/, 'EntryArguments'],
  [/\bEntryParameterMap\b|\bEntryParameter\b/, 'EntryParameters'],
  [/\bNormalizedServiceFailurePolicy\b|\bSetupResult\b|\bDependencyOutput\b/, '(no longer exported)'],
  [/\b__(api|value|publicApi|contract)\b/, '__type'],
  // 0.7 (§2.2): the selector's last remnants
  [/\bCandidateAvailability\b|\bAvailableImplementationCandidate\b/, 'ImplementationCandidate (every C.all candidate is loadable)'],
  [/\.availability\b|\bavailability:\s/, 'set.load(candidate) (the availability field is gone)'],
  // 0.7 (§2.3 S6): the code split by throw site
  [/\bFRESH_CONSTRAINT_FAILED\b/, 'INACTIVE_REUSE_TARGET (inactive fresh/share target), INVALID_INHERITED_CHOICE or FOREIGN_CANDIDATE_REF'],
  // 0.7 (§2.3 S7): the code split by meaning
  [/\bINVALID_ENV_STATE\b/, 'ENV_CLOSED (closing or closed Env), RUNTIME_CLOSED (disposed Runtime), SLOT_NOT_LOADABLE (closed slot) or LIFECYCLE_MISUSE (stale onDispose)'],
  [/\bUNSETTLED_ATTEMPT\b/, 'no error: an abandoned attempt is a ledger entry (runtime.inspect().unsettledAttempts, env.inspect().abandonedAttempts) reported by the attempt-abandoned and runtime-attempts-outstanding events'],
  // 0.8 (§2, the last rename before 1.0): every 0.7 name with its replacement — docs/MIGRATION_V07_TO_V08.md has the table.
  [/\bEnvHandle\b/, 'Env'],
  [/\bEntryDescriptor\b/, 'Entry'],
  [/\bImplementationDescriptor\b/, 'ImplementationRecord'],
  [/\bNodeDisposition\b/, 'NodePlacement'],
  [/\bInputType\b/, 'InputValue'],
  [/\bparentActiveRevisionKeys\b/, 'parentActiveRevisionIds'],
  [/\bselectedKey\b/, 'selectedRevision'],
  [/\bpersistentRef\b/, 'implementationRef'],
  [/\binternalServices\b/, 'privateServices'],
  [/\bbindingsResolved\b/, 'bindingsAssigned'],
  [/\.disposition\b|\bdisposition:\s/, 'placement'],
  [/\brunningForMs\b/, 'elapsedMs'],
  [/\bsetupDeadlineMs\b/, 'loadTimeoutMs'],
  [/\banchorSlot\b|\banchorRevision\b/, 'pinnedSlot / pinnedRevision'],
  [/\beagerInherited\b/, 'eagerReused'],
  [/\bplanCache\.maxEntries\b|\bplanCache:\s*\{[^}]*\bmaxEntries\b/, 'planCache.limit'],
  [/\bINITIALIZATION_TIMEOUT\b/, 'LOAD_TIMEOUT'],
  [/anchor-dependency-mismatch/, 'pinned-dependency-mismatch'],
  [/(['"`])timed-out\1/, "the ledger state 'overdue'"],
  [/late-setup-result|late-setup-failure/, 'attempt-succeeded-late / attempt-failed-late'],
  [/(?<!runtime-)\battempts-outstanding\b/, 'runtime-attempts-outstanding'],
  [/foreign-thenable-setup/, 'setup-returned-thenable'],
  [/legacy-implementation-ref/, '(deleted: no pre-0.8 serialized form is read)'],
  [/persistent-implementation-ref/, "kind 'implementation-ref'"],
  [/\buniqueWithin\b[^\n]*(['"`])none\1/, "uniqueWithin: 'lineage', or undeclared (undefined)"],
  [/\bkind\b\s*(?:===?|!==?|:)\s*(['"`])all\1/, "the node kind 'all-implementations'"],
  [/\b(services|synthetic)\.inherited\b/, 'services.reused / synthetic.reused (inputs.inherited stays)'],
  [/\.derive\(\s*\{\s*(fresh|share)\b/, 'derive({ reuse: { fresh, share } })'],
  [/\.revisions\(\s*['"`]/, 'catalog.revisions(revision.family)'],
]

const CODE_ROOTS = ['apps', 'benchmarks', 'scripts', '.github', 'packages/core/tests', 'packages/core/type-tests']
  .concat(readdirSync(join(root, 'packages')).filter(name => name !== 'core' && name !== 'tsconfig').map(name => `packages/${name}`))
const CODE_EXTENSIONS = ['.ts', '.mjs', '.js', '.cjs', '.yml', '.yaml']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'work', '.tsbuildinfo'])
const SELF = 'scripts/tests/no-old-names.test.mjs'
const DEPRECATIONS_TEST = 'scripts/tests/deprecations.test.mjs'
const INVENTORY_TEST = 'scripts/tests/api-inventory.test.mjs' // asserts the absence of the deleted names, so it spells them

// Current documentation. Ledgers and the migration tables describe history and are not scanned.
const DOCS = [
  'README.md', 'README.zh-CN.md', 'packages/core/README.md',
  'docs/API_REFERENCE.md', 'docs/ARCHITECTURE.md', 'docs/MULTITENANT_BLOG.md', 'docs/PACKAGE_AUTHORING.md', 'docs/PLUGIN_AUTHORING.md', 'docs/SEMANTIC_MODEL.md', 'docs/API_STABILITY.md',
  'docs/GLOSSARY.md', 'docs/DEFERRED.md',
]
const DOC_CONTEXT = /0\.7\.0|0\.8\.0|deprecated|弃用|removed|删除|renamed|改名|0\.5|compat/i

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (CODE_EXTENSIONS.some(extension => name.endsWith(extension))) yield path
  }
}

function codeFiles() {
  const files = []
  for (const codeRoot of CODE_ROOTS) {
    const path = join(root, codeRoot)
    let stats
    try { stats = statSync(path) }
    catch { continue }
    if (stats.isDirectory()) files.push(...walk(path))
    else files.push(path)
  }
  return files.map(path => relative(root, path)).filter(path => path !== SELF && path !== DEPRECATIONS_TEST && path !== INVENTORY_TEST).sort()
}

function scan(file, { allowLine }) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n')
  if (lines.slice(0, 5).some(marked)) return { exempt: true, hits: [] }
  const hits = []
  lines.forEach((line, index) => {
    if (marked(line) || allowLine(line, index, lines)) return
    for (const [pattern, replacement] of OLD_NAMES) {
      if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${pattern.source} → use ${replacement}: ${line.trim().slice(0, 120)}`)
    }
  })
  return { exempt: false, hits }
}

test('no 0.5 name survives in the applications, benchmarks, scripts, workflow and core test suites', () => {
  const files = codeFiles()
  assert.ok(files.length > 100, `scanned ${files.length} files`)
  const hits = []
  const exempt = []
  for (const file of files) {
    const result = scan(file, { allowLine: () => false })
    if (result.exempt) exempt.push(file)
    hits.push(...result.hits)
  }
  assert.deepEqual(hits, [], `old names found:\n${hits.join('\n')}`)
  // The exemptions are the expired-form tests, the codemod and its fixture test, nothing else (0.8: the 0.5
  // stored-document compatibility of the core and of the reference application is gone, and with it every file that carried it).
  assert.deepEqual(exempt, [
    'packages/core/tests/inventory/expired-forms-0.7.test.mjs',
    'packages/core/tests/inventory/expired-forms-0.8.test.mjs',
    'packages/core/type-tests/api.ts',
    'scripts/codemod-v08.mjs',
    'scripts/tests/codemod-v08.test.mjs',
  ])
})

// The names that were un-exported (M2) still exist inside the core as internal types; every other old name is a
// deleted public name and must not survive in the core source either, except on a marked line or in a comment
// that explains the 0.5 compatibility or the removal.
const INTERNAL_REPLACEMENTS = new Set(['EntryArguments', 'EntryParameters', '(no longer exported)'])
const SOURCE_NAMES = OLD_NAMES.filter(([, replacement]) => !INTERNAL_REPLACEMENTS.has(replacement))
const SOURCE_ROOT = 'packages/core/src'

test('the core source spells no deleted public name outside marked lines and removal comments', () => {
  const files = [...walk(join(root, SOURCE_ROOT))].map(path => relative(root, path)).sort()
  assert.ok(files.length > 10, `scanned ${files.length} files`)
  const hits = []
  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    assert.ok(!lines.slice(0, 5).some(marked), `${file} must not carry a file-level ${MARKER} / ${RENAME_MARKER} marker`)
    lines.forEach((line, index) => {
      if (marked(line)) return
      if (/^\s*(\*|\/\/|\/\*)/.test(line) && DOC_CONTEXT.test(line)) return
      // The inspection counters are declared under `planCache`; the removed option record is caught by the inventory test.
      if (/^\s*readonly planCache: \{$/.test(line)) return
      for (const [pattern, replacement] of SOURCE_NAMES) {
        if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${pattern.source} → use ${replacement}: ${line.trim().slice(0, 120)}`)
      }
    })
  }
  assert.deepEqual(hits, [], `deleted names found in the core source:\n${hits.join('\n')}`)
})

test('the current documentation spells old names only in a deprecation or rename section or next to the current name', () => {
  const hits = []
  for (const file of DOCS) {
    try { statSync(join(root, file)) }
    catch { continue }
    let inDeprecationSection = false
    const result = scan(file, {
      allowLine: line => {
        if (/^## /.test(line)) inDeprecationSection = /deprecat|弃用|renam|改名/i.test(line)
        return inDeprecationSection || DOC_CONTEXT.test(line)
      },
    })
    assert.equal(result.exempt, false, `${file} must not carry a file-level ${MARKER} marker`)
    hits.push(...result.hits)
  }
  assert.deepEqual(hits, [], `old names found:\n${hits.join('\n')}`)
})

test('the scanner recognises every old name it is meant to catch', () => {
  const samples = [
    'const runtime: SynaRuntime = createRuntime({ services: [] })',
    'const bound: BoundEntry<typeof Entry> = env.bind(Entry)',
    'const ref: DependencyRef<Db> = deps.db',
    'const persisted: PersistentImplementationRef = { implementationId: "x" }',
    'const options: DeriveOptions = { fresh: [] }; const target: ScopeTarget = Db',
    'define.entry("x", { requires: {}, scope: { fresh: [Db] } })',
    'policy: candidates => candidates.filter(c => context.site === "x")',
    'void deps.db.preload()',
    'requires: { picker: Capability.selector }',
    'if (error.code === "CONSTRAINT_VIOLATION") {}',
    'requires: { db: serviceRange(Db, "^1") }',
    'createRuntime({ services: [], planCache: { maxEntries: 3 } })',
    'const values: EntryParameterValues<typeof Entry> = {}',
    'interface X { readonly __api?: T }',
    'if (candidate.availability.status !== "available") continue',
    'const usable: AvailableImplementationCandidate[] = []',
    'if (error.code === "FRESH_CONSTRAINT_FAILED") {}',
    'if (error.code === "INVALID_ENV_STATE") {}',
    'if (error.code === "UNSETTLED_ATTEMPT") {}',
    // 0.8
    'const env: EnvHandle<{}> = await runtime.enter(Entry)',
    'const entry: EntryDescriptor = define.entry("x")',
    'const record: ImplementationDescriptor = runtime.catalog.resolve(ref)',
    'const placement: NodeDisposition = "new"; type V = InputType<typeof Input>',
    'context.parentActiveRevisionKeys.has(id); error.details.selectedKey',
    'record.persistentRef; inspection.internalServices; explanation.parameters.bindingsResolved',
    'node.disposition === "inherited"',
    'entry.runningForMs; limits: { setupDeadlineMs: 1 }',
    'details.anchorSlot; details.anchorRevision; services.eagerInherited',
    'runtime.inspect().planCache.maxEntries',
    'if (error.code === "INITIALIZATION_TIMEOUT") {}',
    'cause.kind === "anchor-dependency-mismatch"',
    "item.state === 'timed-out'",
    'event.type === "late-setup-result" || event.type === "late-setup-failure"',
    'event.type === "attempts-outstanding"',
    'event.type === "foreign-thenable-setup"; event.type === "legacy-implementation-ref"',
    '{ kind: "persistent-implementation-ref", contractId, familyId, version }',
    "uniqueWithin: 'none'",
    "node.kind === 'all'",
    'explanation.services.inherited + explanation.synthetic.inherited',
    'await env.derive({ fresh: [Db] })',
    "runtime.catalog.revisions('db')",
  ]
  for (const sample of samples) {
    assert.ok(OLD_NAMES.some(([pattern]) => pattern.test(sample)), `not caught: ${sample}`)
  }
  for (const fine of [
    'const runtime: Runtime = createRuntime({ services: [], limits: { planCacheEntries: 3 } })',
    'const anchored = env.anchor(Entry); const fn = this.handle.bind(this)',
    'assert.equal(inFlight.context.site.title, "Alpha")',
    'const providers = makeDefine("test.collection-provider")',
    'const all = [...implementations]',
    'const values: EntryArguments<typeof Entry> = {}',
    // 0.8: the current names, and the words the rename leaves alone
    'const env: Env<{}> = await runtime.enter(Entry); const entry: Entry = define.entry("x")',
    "event.type === 'runtime-attempts-outstanding'; item.state === 'overdue'",
    "node.kind === 'all-implementations'; node.placement === 'reused'",
    'explanation.inputs.inherited; explanation.parameters.inputsInherited',
    'await env.derive({ reuse: { fresh: [Db] } }); runtime.catalog.revisions(Db.family)',
    "uniqueWithin: 'lineage'; response.headers['content-disposition']",
    'cacheStats.maxEntries; { kind: "implementation-ref", contractId, familyId, range }',
  ]) {
    assert.ok(!OLD_NAMES.some(([pattern]) => pattern.test(fine)), `false positive: ${fine}`)
  }
})
