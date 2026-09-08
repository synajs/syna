// v0.7 (Phase C, S7): INVALID_DESCRIPTOR keeps one code and gets one `details` shape,
// `{ descriptor, problem, site?, path? }`, at every one of its 36 throw sites (28 in 0.7; 0.8 added six by the read-path shape check and two by the catalog.revisions() argument check). `problem` is a token of a closed
// vocabulary; `descriptor` names the expected kind, the option, or the offending id / key. Messages are the
// 0.6 ones. The table below has one row per site: the row's `file` is the module that throws (asserted from
// the stack, so the two pairs of sites that share a message are told apart), and the compiled sources are
// counted so that no site exists outside the table.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntime, definePackage, forward, isSynaError, override } from '../../dist/index.js'
import { DefinitionCompiler } from '../../dist/internal/definition-compiler.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '../../dist')
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v07/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })

const SHAPE = ['descriptor', 'problem', 'site', 'path']
const VOCABULARY = [
  'not-an-object', 'not-an-array', 'wrong-kind', 'unknown-kind', 'empty-contract-id', 'self-override', 'override-cycle',
  'forward-cycle', 'not-service-revisions', 'parameters-not-an-object', 'invalid-assignment', 'not-from-this-runtime',
  'policy-result-not-an-array', 'policy-result-not-a-permutation',
  // 0.8 (F9): the one serialized shape of an implementation reference
  'malformed-implementation-ref',
]
// Throw sites per compiled module (the table's rows are counted against these).
const SITES_PER_FILE = {
  'definition.js': 3,
  'definition-compiler.js': 12,
  'entry-planner.js': 4,
  'graph-builder.js': 1,
  'identity.js': 4,
  'implementation-directory.js': 9,
  'runtime.js': 3,
}

const capture = async run => {
  try { await run() }
  catch (error) { return error }
  assert.fail('expected a throw or a rejection')
}

/** The module of the first stack frame outside errors.js: the throw site. */
const throwSite = error => {
  for (const line of error.stack.split('\n').slice(1)) {
    const match = /\/([\w-]+\.js):\d+:\d+/.exec(line)
    if (match && match[1] !== 'errors.js') return match[1]
  }
  return undefined
}

const world = () => {
  const define = makeDefine('s7-descriptor')
  const Capability = define.contract('capability')
  const Db = define.service('db', { setup: () => ({}) })
  const Fake = define.service('fake', { setup: () => ({}) })
  const Auth = define.binding('auth', Capability)
  const WithAuth = define.entry('with-auth', { parameters: { auth: Auth } })
  const Root = define.entry('root', { requires: { db: Db } })
  const Child = define.entry('child', { requires: { db: Db } })
  return { define, Capability, Db, Fake, Auth, WithAuth, Root, Child }
}

/** Every site, in source order, with the public call that reaches it (site 3 is reached through the compiler directly). */
const table = () => {
  const { define, Capability, Db, Fake, Auth, WithAuth, Root, Child } = world()
  const rows = []
  const row = (site, file, message, details, run) => rows.push({ site, file, message, details, run })

  // definition-compiler.ts -------------------------------------------------------------
  row(1, 'definition-compiler.js', 'createRuntime() requires a services array.',
    { descriptor: 'CreateRuntimeOptions.services', problem: 'not-an-array' },
    () => createRuntime({ services: 'nope' }))
  row(2, 'definition-compiler.js', 'Expected a Contract descriptor.',
    { descriptor: 'Contract', problem: 'wrong-kind' },
    () => createRuntime({ services: [{ ...Db, provides: [{ kind: 'nope', id: 'x' }] }] }))
  // registerEntry() is reached by the planner only after the Runtime's own Entry check (site 28) and by the
  // compiler only for dependencies whose kind is already `entry`: the site is exercised on the compiler itself.
  row(3, 'definition-compiler.js', 'Expected an Entry descriptor.',
    { descriptor: 'Entry', problem: 'wrong-kind' },
    () => new DefinitionCompiler([], [], () => 'signature').registerEntry({ kind: 'nope' }))
  row(4, 'definition-compiler.js', 'createRuntime() overrides must be an array.',
    { descriptor: 'CreateRuntimeOptions.overrides', problem: 'not-an-array' },
    () => createRuntime({ services: [Db], overrides: 'nope' }))
  row(5, 'definition-compiler.js', 'Invalid Runtime service override descriptor.',
    { descriptor: 'ServiceOverride', problem: 'wrong-kind' },
    () => createRuntime({ services: [Db], overrides: [{ kind: 'nope' }] }))
  row(6, 'definition-compiler.js', 'override() expects two ServiceRevision descriptors.',
    { descriptor: 'ServiceOverride', problem: 'not-service-revisions' },
    () => createRuntime({ services: [Db], overrides: [{ kind: 'service-override', from: Db, to: 'nope' }] }))
  row(7, 'definition-compiler.js', `Service ${Db.id} cannot override itself.`,
    { descriptor: Db.id, problem: 'self-override' },
    () => createRuntime({ services: [Db], overrides: [override(Db, Db)] }))
  row(8, 'definition-compiler.js', `Runtime service overrides contain a cycle at ${Db.id}.`,
    { descriptor: Db.id, problem: 'override-cycle', path: [Db.id, Fake.id, Db.id] },
    () => createRuntime({ services: [Db], overrides: [override(Db, Fake), override(Fake, Db)] }))
  row(9, 'definition-compiler.js', 'Runtime services must be ServiceRevision descriptors.',
    { descriptor: 'ServiceRevision', problem: 'wrong-kind' },
    () => createRuntime({ services: [{ kind: 'nope' }] }))
  row(10, 'definition-compiler.js', 'A Service dependency must be a ServiceRevision descriptor.',
    { descriptor: 'ServiceRevision', problem: 'wrong-kind' },
    () => {
      const range = { kind: 'service-range', family: Db.family, range: '^1', origin: { kind: 'nope' }, requiredContractIds: [] }
      const User = define.service('range-user', { requires: { db: range }, setup: () => ({}) })
      createRuntime({ services: [Db, User] })
    })
  row(11, 'definition-compiler.js', 'Unknown dependency descriptor kind weird.',
    { descriptor: 'Dependency', problem: 'unknown-kind' },
    () => createRuntime({ services: [define.service('odd-service', { requires: { dep: { kind: 'weird' } }, setup: () => ({}) })] }))
  row(12, 'definition-compiler.js', `${define.service('empty-contract', { setup: () => ({}) }).id} provides a Contract with an empty id.`,
    { descriptor: `${define.service('empty-contract', { setup: () => ({}) }).id}`, problem: 'empty-contract-id' },
    () => createRuntime({ services: [define.service('empty-contract', { provides: [{ kind: 'contract', id: ' ', metadata: {} }], setup: () => ({}) })] }))

  // entry-planner.ts --------------------------------------------------------------------
  row(13, 'entry-planner.js', 'Reuse targets must be Service revisions or families.',
    { descriptor: 'ReuseTarget', problem: 'not-an-object' },
    async () => {
      const runtime = createRuntime({ services: [Db] })
      const root = await runtime.enter(Root)
      try { await root.enter(Child, undefined, { reuse: { fresh: ['nope'] } }) }
      finally { await runtime.dispose() }
    })
  row(14, 'entry-planner.js', `Entry ${Child.id} parameters must be an object.`,
    { descriptor: Child.id, problem: 'parameters-not-an-object' },
    async () => {
      const runtime = createRuntime({ services: [Db] })
      try { await runtime.enter(Child, 'flag') }
      finally { await runtime.dispose() }
    })
  row(15, 'entry-planner.js', `Invalid assignment for Binding ${Auth.id}.`,
    { descriptor: Auth.id, problem: 'invalid-assignment' },
    async () => {
      const runtime = createRuntime({ services: [Db] })
      try { await runtime.enter(WithAuth, { auth: { kind: 'nope' } }) }
      finally { await runtime.dispose() }
    })

  // graph-builder.ts --------------------------------------------------------------------
  // A forward() target is read at every plan: one that is a Service at createRuntime() and something else at
  // plan time is met by the graph builder, at the site it was building.
  {
    let target = Db
    const Leaf = define.service('forward-leaf', { requires: { dep: forward(() => target) }, setup: () => ({}) })
    const LeafRoot = define.entry('forward-root', { requires: { leaf: Leaf } })
    const site = `service:${Leaf.id}/dependency:dep`
    row(16, 'graph-builder.js', `Unknown dependency descriptor at ${site}.`,
      { descriptor: 'Dependency', problem: 'unknown-kind', site },
      async () => {
        const runtime = createRuntime({ services: [Db, Leaf] })
        target = { kind: 'weird' }
        try { await runtime.enter(LeafRoot) }
        finally { await runtime.dispose() }
      })
  }

  // identity.ts -------------------------------------------------------------------------
  row(17, 'identity.js', 'A dependency must be a descriptor object.',
    { descriptor: 'Dependency', problem: 'not-an-object' },
    () => createRuntime({ services: [define.service('string-dep', { requires: { dep: 'nope' }, setup: () => ({}) })] }))
  row(18, 'identity.js', 'A forward dependency descriptor resolves to itself.',
    { descriptor: 'ForwardDependency', problem: 'forward-cycle' },
    () => {
      const loop = forward(() => loop)
      createRuntime({ services: [define.service('forward-loop', { requires: { dep: loop }, setup: () => ({}) })] })
    })
  row(19, 'identity.js', 'A forward dependency resolved to a non-descriptor value.',
    { descriptor: 'ForwardDependency', problem: 'not-an-object' },
    () => createRuntime({ services: [define.service('forward-string', { requires: { dep: forward(() => 'nope') }, setup: () => ({}) })] }))
  row(20, 'identity.js', 'Unknown dependency descriptor kind weird.',
    { descriptor: 'Dependency', problem: 'unknown-kind' },
    async () => {
      // An Entry's requirements are identified (for its definition signature) before the graph is built.
      const runtime = createRuntime({ services: [Db] })
      try { await runtime.enter(define.entry('odd-entry', { requires: { dep: { kind: 'weird' } } })) }
      finally { await runtime.dispose() }
    })

  // implementation-directory.ts ---------------------------------------------------------
  row(21, 'implementation-directory.js', 'catalog.implementations() expects a Contract descriptor.',
    { descriptor: 'Contract', problem: 'wrong-kind' },
    () => createRuntime({ services: [Db] }).catalog.implementations('nope'))
  row(22, 'implementation-directory.js', 'catalog.resolve() expects an implementation reference.',
    { descriptor: 'ImplementationRef', problem: 'wrong-kind' },
    () => createRuntime({ services: [Db] }).catalog.resolve({ kind: 'nope' }))
  {
    const V1 = makeDefine('s7-versioned', '1.0.0').service({ setup: () => ({}) })
    const V2 = makeDefine('s7-versioned', '2.0.0').service({ setup: () => ({}) })
    const RangeUser = define.service('version-user', { requires: { v: V1.range('*') }, setup: () => ({}) })
    const RangeRoot = define.entry('version-root', { requires: { user: RangeUser } })
    const site = `service:${RangeUser.id}/dependency:v`
    const withPolicy = async orderVersionCandidates => {
      const runtime = createRuntime({ services: [V1, V2, RangeUser], policy: { orderVersionCandidates } })
      try { await runtime.enter(RangeRoot) }
      finally { await runtime.dispose() }
    }
    row(23, 'implementation-directory.js', `Resolution policy must return an array of candidates at ${site}.`,
      { descriptor: 'RuntimePolicy', problem: 'policy-result-not-an-array', site },
      () => withPolicy(() => 'nope'))
    row(24, 'implementation-directory.js', `Resolution policy must return every candidate exactly once at ${site}.`,
      { descriptor: 'RuntimePolicy', problem: 'policy-result-not-a-permutation', site },
      () => withPolicy(candidates => [candidates[0], candidates[0]]))
  }
  {
    const A = makeDefine('s7-impl-a').service({ provides: [Capability], setup: () => ({ id: 'a' }) })
    const B = makeDefine('s7-impl-b').service({ provides: [Capability], setup: () => ({ id: 'b' }) })
    const Host = define.service('all-host', { requires: { all: Capability.all }, setup: ({ all }) => ({ all }) })
    const AllRoot = define.entry('all-root', { requires: { host: Host } })
    const withSet = async use => {
      const runtime = createRuntime({ services: [A, B, Host] })
      const env = await runtime.enter(AllRoot)
      try { await use(await (await env.deps.host.load()).all.load()) }
      finally { await runtime.dispose() }
    }
    row(25, 'implementation-directory.js', 'resolve() expects an implementation reference.',
      { descriptor: 'ImplementationRef', problem: 'wrong-kind' },
      () => withSet(set => set.resolve(set.candidates[0].candidateRef)))
    row(26, 'implementation-directory.js', 'Expected a candidate, candidate ref or implementation ref.',
      { descriptor: 'ImplementationCandidate', problem: 'not-an-object' },
      () => withSet(set => set.load('nope')))
    row(27, 'implementation-directory.js', 'Expected a CandidateRef created by this Runtime.',
      { descriptor: 'CandidateRef', problem: 'not-from-this-runtime' },
      () => withSet(set => set.load({ kind: 'candidate-ref' })))
  }

  // runtime.ts --------------------------------------------------------------------------
  row(28, 'runtime.js', 'Expected an Entry descriptor.',
    { descriptor: 'Entry', problem: 'wrong-kind' },
    async () => {
      const runtime = createRuntime({ services: [Db] })
      try { await runtime.enter({ kind: 'service-revision' }) }
      finally { await runtime.dispose() }
    })

  // 0.8 (F9): parse() and every Runtime read path accept the one serialized shape of an implementation reference
  // ({ kind: 'implementation-ref', contractId, familyId, range }) and refuse the rest — the sites added in 0.8.
  row(29, 'definition.js', 'An implementation reference must be an object.',
    { descriptor: 'ImplementationRef', problem: 'not-an-object' },
    () => Auth.parse('nope'))
  row(30, 'definition.js', `Invalid implementation reference for Contract ${Capability.id}: kind must be "implementation-ref".`,
    { descriptor: 'ImplementationRef', problem: 'wrong-kind' },
    () => Auth.parse({ kind: 'nope', contractId: Capability.id, familyId: 'x', range: '^1.0.0' }))
  row(31, 'definition.js', `Invalid implementation reference for Contract ${Capability.id}.`,
    { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' },
    () => Auth.parse({ kind: 'implementation-ref', contractId: Capability.id, familyId: 'x', range: 'not a range' }))
  row(32, 'implementation-directory.js', 'catalog.resolve() received a malformed implementation reference.',
    { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' },
    () => createRuntime({ services: [Db] }).catalog.resolve({ kind: 'implementation-ref', contractId: Capability.id, range: '^1.0.0' }))
  row(33, 'implementation-directory.js', 'resolve() received a malformed implementation reference.',
    { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' },
    async () => {
      const Host = define.service('host-33', { requires: { all: Capability.all }, setup: ({ all }) => ({ all }) })
      const Entry = define.entry('entry-33', { requires: { host: Host } })
      const runtime = createRuntime({ services: [Db, Host] })
      try {
        const set = await (await (await runtime.enter(Entry)).deps.host.load()).all.load()
        set.resolve({ kind: 'implementation-ref', contractId: Capability.id, familyId: 'x' })
      }
      finally { await runtime.dispose() }
    })
  row(34, 'entry-planner.js', `Malformed implementation reference assigned to Binding ${Auth.id}.`,
    { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' },
    async () => {
      const runtime = createRuntime({ services: [Db] })
      try { await runtime.enter(WithAuth, { auth: { kind: 'implementation-ref', contractId: Capability.id, familyId: '', range: '^1.0.0' } }) }
      finally { await runtime.dispose() }
    })

  // 0.8 (S2): catalog.revisions() takes the ServiceFamily descriptor; the 0.7 family-id argument and any other descriptor are refused.
  row(35, 'runtime.js', 'catalog.revisions() expects a ServiceFamily descriptor (revision.family), not a family id.',
    { descriptor: 'ServiceFamily', problem: 'not-an-object' },
    async () => {
      const runtime = createRuntime({ services: [Db] })
      try { runtime.catalog.revisions(Db.family.id) } // codemod-v08: skip — the 0.7 argument form is the point of this row
      finally { await runtime.dispose() }
    })
  row(36, 'runtime.js', 'catalog.revisions() expects a ServiceFamily descriptor.',
    { descriptor: 'ServiceFamily', problem: 'wrong-kind' },
    async () => {
      const runtime = createRuntime({ services: [Db] })
      try { runtime.catalog.revisions(Db) } // codemod-v08: skip — a revision where the Family descriptor belongs (wrong-kind)
      finally { await runtime.dispose() }
    })
  return rows
}

test('INVALID_DESCRIPTOR: every one of the 36 throw sites carries { descriptor, problem, site?, path? } with the 0.6 message', async () => {
  const rows = table()
  assert.equal(rows.length, 36)
  assert.deepEqual(rows.map(row => row.site), Array.from({ length: 36 }, (_, index) => index + 1))
  const seenProblems = new Set()
  const perFile = {}
  for (const { site, file, message, details, run } of rows) {
    const error = await capture(run)
    assert.ok(isSynaError(error), `site ${site}: expected a SynaError, got ${error?.stack ?? error}`)
    assert.equal(error.code, 'INVALID_DESCRIPTOR', `site ${site}: ${error.message}`)
    assert.equal(error.message, message, `site ${site}`)
    assert.deepEqual(error.details, details, `site ${site}`)
    assert.ok(Object.isFrozen(error.details), `site ${site}: details are frozen`)
    const keys = Object.keys(error.details)
    assert.ok(keys.length >= 2, `site ${site}: details are never empty`)
    assert.ok(keys.every(key => SHAPE.includes(key)), `site ${site}: keys ${keys.join(',')}`)
    assert.ok(typeof error.details.descriptor === 'string' && error.details.descriptor.length > 0, `site ${site}: descriptor`)
    assert.ok(VOCABULARY.includes(error.details.problem), `site ${site}: problem ${error.details.problem}`)
    if ('site' in error.details) assert.ok(typeof error.details.site === 'string' && error.details.site.length > 0, `site ${site}: site`)
    if ('path' in error.details) assert.ok(Array.isArray(error.details.path) && error.details.path.length >= 2, `site ${site}: path`)
    assert.equal(throwSite(error), file, `site ${site}: thrown from ${throwSite(error)}\n${error.stack}`)
    seenProblems.add(error.details.problem)
    perFile[file] = (perFile[file] ?? 0) + 1
  }
  assert.deepEqual([...seenProblems].sort(), [...VOCABULARY].sort(), 'every token of the vocabulary is produced by some site')
  assert.deepEqual(perFile, SITES_PER_FILE)
})

test('INVALID_DESCRIPTOR: the compiled sources have exactly the 36 throw sites of the table, and each passes details', () => {
  const counts = {}
  const files = [
    ...readdirSync(dist).filter(name => name.endsWith('.js')).map(name => path.join(dist, name)),
    ...readdirSync(path.join(dist, 'internal')).filter(name => name.endsWith('.js')).map(name => path.join(dist, 'internal', name)),
  ]
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const sites = [...source.matchAll(/new SynaError\('INVALID_DESCRIPTOR', ([^;]*?)\)\s*[;\n]/gs)]
    if (sites.length === 0) continue
    counts[path.basename(file)] = sites.length
    for (const [, args] of sites) {
      assert.match(args, /\bdescriptor: /, `${path.basename(file)}: a site passes no descriptor: ${args}`)
      assert.match(args, /\bproblem: '/, `${path.basename(file)}: a site passes no problem: ${args}`)
    }
  }
  assert.deepEqual(counts, SITES_PER_FILE)
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 36)
})

test('INVALID_DESCRIPTOR: the CandidateRef check covers revisionKey (Q8) and a foreign collection is still FOREIGN_CANDIDATE_REF', async () => {
  const define = makeDefine('s7-candidate-ref')
  const Capability = define.contract('capability')
  const A = makeDefine('s7-ref-a').service({ provides: [Capability], setup: () => ({ id: 'a' }) })
  const Host = define.service('host', { requires: { all: Capability.all }, setup: ({ all }) => ({ all }) })
  const Entry = define.entry('entry', { requires: { host: Host } })
  const runtime = createRuntime({ services: [A, Host] })
  const env = await runtime.enter(Entry)
  const set = await (await env.deps.host.load()).all.load()
  const foreign = await capture(() => set.load({ kind: 'candidate-ref', sourceSlotId: 'slot-0', revisionKey: A.id }))
  assert.equal(foreign.code, 'FOREIGN_CANDIDATE_REF')
  const own = foreign.details.expectedSourceSlot
  // Not a string, or not the `family@version` key every Runtime writes: not a CandidateRef of any Runtime.
  for (const revisionKey of [undefined, 7, null, 'no-version', '@1.0.0', 'family@']) {
    const error = await capture(() => set.load({ kind: 'candidate-ref', sourceSlotId: own, revisionKey }))
    assert.equal(error.code, 'INVALID_DESCRIPTOR', String(revisionKey))
    assert.deepEqual(error.details, { descriptor: 'CandidateRef', problem: 'not-from-this-runtime' })
  }
  // A well-formed key this collection does not hold is a missing implementation (S8 has the details).
  const unknown = await capture(() => set.load({ kind: 'candidate-ref', sourceSlotId: own, revisionKey: 'nobody@1.0.0' }))
  assert.equal(unknown.code, 'MISSING_IMPLEMENTATION')
  assert.equal((await set.load({ kind: 'candidate-ref', sourceSlotId: own, revisionKey: A.id })).id, 'a')
  await runtime.dispose()
})
