// syna-v05-compat: this file spells the expired 0.5/0.6 forms on purpose — to assert that each one is refused or absent.
// v0.7 (Phase B, §2.1): the 23 names deprecated in 0.6 and the 0.5 call form are deleted. Every expired form is
// refused with a TypeError or simply absent, never silently accepted; the 0.6 forms keep the behaviour the deleted
// alias-equivalence suites of the 0.6 line asserted (plans, checks, explanations, anchored entries, policy
// contexts, limits, the compiled declarations).
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { auto, createRuntime, definePackage, defaultRuntimePolicy, loadAll } from '../../dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '../../dist')
const root = path.resolve(here, '../../../..')
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v07/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })

// Explanations and inspections compared without the ids that differ between two otherwise identical worlds.
const shape = value => JSON.parse(JSON.stringify(value, (key, inner) => (key === 'entry' || key === 'parent') ? undefined : inner))
const topology = env => env.inspect().nodes.map(node => ({ nodeId: node.nodeId, kind: node.kind, owned: node.ownerEnvId === env.id, dependencies: Object.keys(node.dependencies).sort() }))

const world = () => {
  const define = makeDefine('expired')
  const Flag = define.input('flag')
  const Db = define.service('db', { setup: () => ({ db: true }) })
  const Cache = define.service('cache', { requires: { db: Db }, setup: () => ({ cache: true }) })
  const Config = define.service('config', { requires: { flag: Flag }, setup: ({ flag }) => ({ flag: flag.read() }) })
  const App = define.service('app', { requires: { db: Db, cache: Cache, config: Config }, setup: () => ({}) })
  const Other = makeDefine('expired-other').service({ setup: () => ({}) })
  const Root = define.entry('root', { requires: { app: App }, parameters: { flag: Flag } })
  const Child = define.entry('child', { requires: { app: App }, parameters: { flag: Flag } })
  return { define, Flag, Db, Cache, Config, App, Other, Root, Child }
}

const declarations = () => readdirSync(dist).filter(name => name.endsWith('.d.ts')).map(name => [name, readFileSync(path.join(dist, name), 'utf8')])

test('the compiled declarations carry no @deprecated tag and none of the expired names', () => {
  const files = declarations()
  assert.ok(files.length > 5, `declaration files: ${files.length}`)
  const expired = [
    /\bSynaRuntime\b/, /\bBoundEntry\b/, /\bDependencyRef\b/, /\bPersistentImplementationRef\b/, /\bDeriveOptions\b/, /\bScopeTarget\b/,
    /\bPlanCacheOptions\b/, /\bInitializationOptions\b/, /\bDisposalOptions\b/, /\bPlanningOptions\b/,
    /\bscope\??:/, /\bbind</, /\bplanCache\?:/, /\binitialization\?:/, /\bdisposal\?:/, /\bplanning\?:/,
    /\bsearchBudget\b/, /\bgraceMs\b/, /\bdeadlineMs\?:/, /\bmaxEntries\?:/, /readonly site: string;\s*readonly parentActiveRevisionIds/,
    // §2.2: the selector's last remnants
    /\bavailability\??:/, /\bCandidateAvailability\b/, /\bAvailableImplementationCandidate\b/,
  ]
  for (const [name, text] of files) {
    assert.ok(!text.includes('@deprecated'), `${name} still carries @deprecated`)
    for (const pattern of expired) assert.ok(!pattern.test(text), `${name} still declares ${pattern.source}`)
  }
  const descriptors = files.find(([name]) => name === 'descriptors.d.ts')[1]
  assert.match(descriptors, /export interface Runtime \{/)
  assert.match(descriptors, /export interface ServiceRef<T> \{\s*load\(options\?: LoadOptions\): Promise<T>;/)
  assert.match(descriptors, /: ServiceRef<DependencyOutput<D>>;/, 'DependencyRefFor maps Service-like dependencies to ServiceRef')
  assert.match(descriptors, /anchor<E extends Entry>\(entry: E\): AnchoredEntry<E>;/)
  assert.match(readFileSync(path.join(dist, 'runtime.d.ts'), 'utf8'), /export declare function createRuntime\(options: CreateRuntimeOptions\): Runtime;/)
  assert.match(readFileSync(path.join(dist, 'loading.d.ts'), 'utf8'), /Refs extends Readonly<Record<string, ServiceRef<unknown>>>/, 'loadAll is constrained to ServiceRef')
})

test('definition: reuse is the one form; the removed scope option is refused; a descriptor has no scope property', () => {
  const { define, App, Cache, Db } = world()
  const viaReuse = define.entry('via-reuse', { requires: { app: App }, reuse: { fresh: [Cache], share: [Db] } })
  assert.deepEqual(viaReuse.reuse, { fresh: [Cache], share: [Db] })
  assert.ok(Object.keys(viaReuse).includes('reuse'))
  assert.equal('scope' in viaReuse, false, 'no alias, enumerable or not')
  assert.equal(Object.getOwnPropertyDescriptor(viaReuse, 'scope'), undefined)
  assert.ok(Object.isFrozen(viaReuse) && Object.isFrozen(viaReuse.reuse) && Object.isFrozen(viaReuse.reuse.fresh))
  const none = define.entry('none', { requires: { app: App } })
  assert.deepEqual(none.reuse, { fresh: [], share: [] })
  assert.throws(
    () => define.entry('expired', { requires: { app: App }, scope: { fresh: [Cache] } }),
    { name: 'TypeError', message: /uses the removed option scope; use reuse/ },
  )
  assert.throws(
    () => define.entry('both', { requires: { app: App }, reuse: { fresh: [Cache] }, scope: { fresh: [Cache] } }),
    { name: 'TypeError', message: /uses the removed option scope; use reuse/ },
  )
  const Flag = define.input('flag2')
  for (const key of ['reuse', 'scope']) {
    assert.throws(
      () => define.entry(`reserved-${key}`, { requires: { app: App }, parameters: { [key]: Flag } }),
      { name: 'TypeError', message: `Entry parameter name "${key}" is reserved by Syna.` },
    )
  }
})

test('call: options.reuse on enter/check/explain/run; scope inside the parameter record is refused, never read', async () => {
  const { Db, Cache, Config, App, Other, Root, Child } = world()
  const runtime = createRuntime({ services: [Db, Cache, App, Config, Other] })
  const root = await runtime.enter(Root, { flag: 1 })

  const explained = await root.explain(Child, { flag: 2 }, { reuse: { fresh: [Cache] } })
  assert.equal(explained.ok, true)
  assert.ok(explained.forks.some(fork => fork.cause?.kind === 'fresh'), 'the constraint was applied')
  const checked = await root.check(Child, { flag: 2 }, { reuse: { share: [Db] } })
  assert.equal(checked.ok, true)

  const env = await root.enter(Child, { flag: 2 }, { reuse: { fresh: [Cache] } })
  assert.notStrictEqual(await env.deps.app.load(), await root.deps.app.load(), 'fresh Cache forks App')
  const cacheNode = env.inspect().nodes.find(node => node.nodeId === `service:${Cache.id}`)
  assert.equal(cacheNode.ownerEnvId, env.id)
  await env.dispose()

  // run(): the callback is always last; two, three and four arguments.
  const seen = []
  await root.run(Child, { flag: 3 }, { reuse: { fresh: [Cache] } }, async (deps, env) => { seen.push(['options', env.inspect().nodes.length, typeof deps.app.load]) })
  await root.run(Child, { flag: 3 }, undefined, async (deps, env) => { seen.push(['undefined-options', env.inspect().nodes.length, typeof deps.app.load]) })
  await root.run(Child, { flag: 3 }, async (deps, env) => { seen.push(['no-options', env.inspect().nodes.length, typeof deps.app.load]) })
  assert.deepEqual(seen.map(([, count, type]) => [count, type]), [[seen[0][1], 'function'], [seen[0][1], 'function'], [seen[0][1], 'function']])

  // Errors: an inactive target, a bad target.
  const inactive = await root.check(Child, { flag: 2 }, { reuse: { fresh: [Other] } })
  assert.equal(inactive.ok, false)
  assert.equal(inactive.error.code, 'INACTIVE_REUSE_TARGET')
  assert.equal(inactive.error.message, `fresh targets inactive Service Revision ${Other.id}.`)
  await assert.rejects(root.enter(Child, { flag: 2 }, { reuse: { fresh: ['not-a-service'] } }), { code: 'INVALID_DESCRIPTOR', message: 'Reuse targets must be Service revisions or families.' })

  // The expired 0.5 call form and the other malformed shapes are TypeErrors, reported as rejections.
  const removed = { name: 'TypeError', message: /scope is no longer a call parameter \(removed in 0\.7\.0\): pass the reuse constraints as the options argument/ }
  await assert.rejects(root.enter(Child, { flag: 2, scope: { fresh: [Cache] } }), removed)
  await assert.rejects(root.enter(Child, { flag: 2, scope: undefined }), removed)
  await assert.rejects(root.enter(Child, { flag: 2, scope: { fresh: [Cache] } }, { reuse: { fresh: [Cache] } }), removed)
  await assert.rejects(root.check(Child, { flag: 2, scope: { share: [Db] } }), removed)
  await assert.rejects(root.explain(Child, { flag: 2, scope: { share: [Db] } }), removed)
  await assert.rejects(root.run(Child, { flag: 3, scope: { fresh: [Cache] } }, async () => 'never'), removed)
  await assert.rejects(root.enter(Child, { flag: 2, reuse: { fresh: [Cache] } }), { name: 'TypeError', message: /reuse is a call option, not a parameter/ })
  await assert.rejects(root.enter(Child, { flag: 2 }, 'fresh'), { name: 'TypeError', message: 'Entry call options must be an object.' })
  await assert.rejects(root.enter(Child, 'flag'), { code: 'INVALID_DESCRIPTOR' })

  // No constraints at all: `{}` options and `undefined` options agree with the two-argument call.
  const plain = shape(await root.explain(Child, { flag: 2 }))
  assert.deepEqual(shape(await root.explain(Child, { flag: 2 }, {})), plain)
  assert.deepEqual(shape(await root.explain(Child, { flag: 2 }, undefined)), plain)
  await runtime.dispose()
})

test('derive(): the argument is ReuseConstraints', async () => {
  const { Db, Cache, Config, App, Root } = world()
  const runtime = createRuntime({ services: [Db, Cache, App, Config] })
  const root = await runtime.enter(Root, { flag: 1 })
  const derived = await root.derive({ reuse: { fresh: [Cache] } })
  assert.equal(derived.inspect().parentId, root.id)
  const cacheNode = derived.inspect().nodes.find(node => node.nodeId === `service:${Cache.id}`)
  assert.equal(cacheNode.ownerEnvId, derived.id)
  await assert.rejects(root.derive({ reuse: { fresh: [makeDefine('expired-unknown').service({ setup: () => ({}) })] } }), { code: 'INACTIVE_REUSE_TARGET' })
  await runtime.dispose()
})

test('anchored entries: env.anchor(entry) is the one form and accepts the same call shapes; env.bind is gone', async () => {
  const { Db, Cache, Config, App, Root, Child } = world()
  const runtime = createRuntime({ services: [Db, Cache, App, Config] })
  const root = await runtime.enter(Root, { flag: 1 })
  assert.equal(typeof root.bind, 'undefined')
  assert.equal('bind' in root, false)
  const anchored = root.anchor(Child)
  assert.deepEqual(Object.keys(anchored).sort(), ['check', 'enter', 'explain', 'run'])
  assert.ok(Object.isFrozen(anchored))
  const direct = shape(await root.explain(Child, { flag: 2 }, { reuse: { fresh: [Cache] } }))
  assert.deepEqual(shape(await anchored.explain({ flag: 2 }, { reuse: { fresh: [Cache] } })), direct)
  assert.deepEqual(await anchored.check({ flag: 2 }, { reuse: { share: [Db] } }), await root.check(Child, { flag: 2 }, { reuse: { share: [Db] } }))
  assert.equal((await anchored.check({})).ok, false)
  const a = await anchored.enter({ flag: 2 }, { reuse: { fresh: [Cache] } })
  const b = await root.enter(Child, { flag: 2 }, { reuse: { fresh: [Cache] } })
  assert.equal(a.inspect().parentId, root.id)
  assert.deepEqual(topology(a), topology(b))
  assert.equal(await anchored.run({ flag: 2 }, async ({ app }) => typeof (await app.load())), 'object')
  assert.equal(await anchored.run({ flag: 3 }, { reuse: { fresh: [Db] } }, async (deps, env) => env.inspect().nodes.find(node => node.nodeId === `service:${Db.id}`).ownerEnvId !== root.id), true)
  await assert.rejects(anchored.enter({ flag: 2, scope: { fresh: [Cache] } }), { name: 'TypeError', message: /scope is no longer a call parameter/ })
  await a.dispose()
  await b.dispose()
  await root.dispose()
  await assert.rejects(anchored.enter({ flag: 1 }), { code: 'ENV_CLOSED' })
  await runtime.dispose()
})

test('anchored entries: private-realm checks and Service-received anchors are unchanged', async () => {
  const define = makeDefine('expired-anchor')
  const Internal = define.service('internal', { setup: () => ({}) })
  const App = define.service('app', { requires: { internal: Internal }, setup: () => ({}) })
  const AppEntry = define.entry('app', { requires: { app: App } })
  const PrivateEntry = define.entry('private', { requires: { internal: Internal } })
  const Db = define.service('db', { setup: () => ({}) })
  const Tx = define.entry('tx', { requires: { db: Db } })
  const UnitOfWork = define.service('unit-of-work', {
    requires: { tx: Tx },
    setup: async ({ tx }) => {
      const entry = await tx.load()
      return { keys: Object.keys(entry).sort(), run: () => entry.run(async (deps, env) => env.inspect().parentId) }
    },
  })
  const Root = define.entry('root', { requires: { uow: UnitOfWork } })
  const runtime = createRuntime({ services: [App, Db, UnitOfWork] })
  const app = await runtime.enter(AppEntry)
  await assert.rejects(app.anchor(PrivateEntry).enter(), { code: 'MISSING_SERVICE' })
  assert.equal((await app.anchor(PrivateEntry).check()).ok, false)
  const root = await runtime.enter(Root)
  const uow = await root.deps.uow.load()
  assert.deepEqual(uow.keys, ['check', 'enter', 'explain', 'run'])
  assert.equal(await uow.run(), root.id, 'the child is anchored at the owner Env of the unit-of-work slot')
  await runtime.dispose()
})

test('createRuntime() returns the documented Runtime surface', async () => {
  const define = makeDefine('expired-runtime')
  const Db = define.service('db', { setup: () => ({}) })
  const runtime = createRuntime({ services: [Db] })
  assert.deepEqual(Object.keys(runtime.catalog).sort(), ['implementations', 'resolve', 'revisions'])
  for (const method of ['enter', 'run', 'check', 'explain', 'inspect', 'dispose']) assert.equal(typeof runtime[method], 'function', method)
  assert.equal(typeof runtime[Symbol.asyncDispose], 'function')
  assert.deepEqual(runtime.inspect().admittedServices, [Db.id])
  await runtime.dispose()
})

test('refs are unchanged objects: a Service ref loads, an Input ref reads, loadAll batches Service refs', async () => {
  const define = makeDefine('expired-refs')
  const Tenant = define.input('tenant')
  const Db = define.service('db', { setup: () => ({ db: true }) })
  const Cache = define.service('cache', { requires: { db: Db }, setup: () => ({ cache: true }) })
  const Root = define.entry('root', { requires: { db: Db, cache: Cache, tenant: Tenant }, parameters: { tenant: Tenant } })
  const runtime = createRuntime({ services: [Db, Cache] })
  const env = await runtime.enter(Root, { tenant: 't1' })
  const { db, cache, tenant } = env.deps
  assert.equal(typeof db.load, 'function')
  assert.equal(typeof tenant.read, 'function')
  assert.equal('then' in db, false, 'a ref is never thenable')
  assert.strictEqual(await Promise.resolve(db), db)
  assert.equal(tenant.read(), 't1')
  const loaded = await loadAll({ db, cache })
  assert.deepEqual(Object.keys(loaded).sort(), ['cache', 'db'])
  assert.strictEqual(loaded.db, await db.load())
  await runtime.dispose()
})

const policyWorld = () => {
  const define = makeDefine('expired-policy')
  const Capability = define.contract()
  const V1 = makeDefine('expired-impl', '1.0.0').service({ provides: [Capability], setup: () => ({ v: 1 }) })
  const V2 = makeDefine('expired-impl', '2.0.0').service({ provides: [Capability], setup: () => ({ v: 2 }) })
  const Other = makeDefine('expired-other-impl').service({ provides: [Capability], setup: () => ({ v: 'other' }) })
  const Choice = define.binding('choice', Capability)
  const Consumer = define.service('consumer', {
    requires: { first: auto(Capability), second: auto(Capability), chosen: Choice, all: Capability.all },
    setup: ({ first, second, chosen, all }) => ({ first, second, chosen, all }),
  })
  const Root = define.entry('root', { requires: { consumer: Consumer }, parameters: { choice: Choice } })
  return { define, Capability, V1, V2, Other, Choice, Consumer, Root }
}

test('policy context: dependencySite is the one name on every policy path; site is gone; error details keep their site key', async () => {
  const { V1, V2, Other, Choice, Consumer, Root } = policyWorld()
  const seen = []
  const contexts = []
  const policy = {
    orderAutoCandidates(_contract, candidates, context) {
      contexts.push(context)
      seen.push(['auto', context.dependencySite, [...context.parentActiveRevisionIds].sort()])
      const byKey = key => candidates.find(candidate => candidate.id === key)
      return context.dependencySite.endsWith('dependency:first')
        ? candidates.filter(Boolean).sort((a, b) => (a.family.id === b.family.id ? b.version.localeCompare(a.version) : a.family.id.localeCompare(b.family.id)))
        : [...candidates].reverse().map(candidate => byKey(candidate.id))
    },
    orderVersionCandidates(_family, candidates, context) {
      contexts.push(context)
      seen.push(['version', context.dependencySite, [...context.parentActiveRevisionIds].sort()])
      return defaultRuntimePolicy.orderVersionCandidates(_family, candidates, context)
    },
  }
  const runtime = createRuntime({ services: [Consumer, V1, V2, Other], policy })
  const explanation = await runtime.explain(Root, { choice: Choice.to(V1) })
  assert.equal(explanation.ok, true)
  const root = await runtime.enter(Root, { choice: Choice.to(V1) })
  const consumer = await root.deps.consumer.load()
  const all = await consumer.all.load()
  const resolved = await all.load(Choice.to(V2))
  assert.deepEqual([(await consumer.first.load()).v, (await consumer.second.load()).v, (await consumer.chosen.load()).v, resolved.v], [2, 'other', 1, 2])
  assert.ok(seen.length >= 3, 'auto, Binding and set.load() paths all consulted the policy')
  assert.ok(seen.some(([kind, site]) => kind === 'auto' && site.endsWith('dependency:first')))
  assert.ok(seen.some(([kind, site]) => kind === 'version' && site.includes('/persistent:')), 'the persistent-reference path names the family in its site')
  for (const context of contexts) {
    assert.deepEqual(Object.keys(context), ['dependencySite', 'parentActiveRevisionIds'])
    assert.equal('site' in context, false, 'no alias, own or inherited')
    assert.equal(typeof context.dependencySite, 'string')
    assert.ok(context.parentActiveRevisionIds instanceof Set)
  }
  await runtime.dispose()

  const strict = createRuntime({ services: [Consumer, V1, Other] })
  await assert.rejects(strict.enter(Root, { choice: Choice.to(V1) }), error => {
    assert.equal(error.code, 'MISSING_AUTO_POLICY')
    assert.deepEqual(Object.keys(error.details).sort(), ['contract', 'families', 'site'])
    assert.match(error.details.site, /dependency:(first|second)$/)
    return true
  })
  await strict.dispose()
})

const DEFAULTS = { loadTimeoutMs: '30_000', disposalGraceMs: '2_000', planningBudget: '10_000', planCacheEntries: '512' }

test('limits: the defaults are locked verbatim: 30_000 / 2_000 / 10_000 / 512', async () => {
  const source = readFileSync(path.join(root, 'packages/core/src/runtime.ts'), 'utf8')
  for (const line of [
    `const DEFAULT_LOAD_TIMEOUT_MS = ${DEFAULTS.loadTimeoutMs}`,
    `const DEFAULT_DISPOSAL_GRACE_MS = ${DEFAULTS.disposalGraceMs}`,
    `const DEFAULT_PLANNING_BUDGET = ${DEFAULTS.planningBudget}`,
    `const DEFAULT_PLAN_CACHE_ENTRIES = ${DEFAULTS.planCacheEntries}`,
  ]) assert.ok(source.includes(`\n${line}\n`), `runtime.ts must declare ${line}`)
  const declaration = readFileSync(path.join(dist, 'descriptors.d.ts'), 'utf8')
  assert.ok(declaration.includes(`Defaults: \`loadTimeoutMs\` ${DEFAULTS.loadTimeoutMs}, \`disposalGraceMs\` ${DEFAULTS.disposalGraceMs},\n * \`planningBudget\` ${DEFAULTS.planningBudget}, \`planCacheEntries\` ${DEFAULTS.planCacheEntries}.`), 'RuntimeLimits documents the defaults')
  const reference = readFileSync(path.join(root, 'docs/API_REFERENCE.md'), 'utf8')
  assert.ok(reference.includes(`limits: { loadTimeoutMs: ${DEFAULTS.loadTimeoutMs}, disposalGraceMs: ${DEFAULTS.disposalGraceMs}, planningBudget: ${DEFAULTS.planningBudget}, planCacheEntries: ${DEFAULTS.planCacheEntries} },`), 'API_REFERENCE shows the defaults')
  const runtime = createRuntime({ services: [] })
  assert.equal(runtime.inspect().planCache.limit, 512, 'the observable default')
  await runtime.dispose()
})

const stuckWorld = () => {
  const define = makeDefine('expired-stuck')
  const Stuck = define.service('stuck', { setup: () => new Promise(() => {}) })
  return { Stuck, Entry: define.entry('entry', { requires: { stuck: Stuck } }) }
}

test('limits: each key sets exactly one limit', async () => {
  const cache = createRuntime({ services: [], limits: { planCacheEntries: 3 } })
  assert.equal(cache.inspect().planCache.limit, 3)
  await cache.dispose()

  {
    const { Stuck, Entry } = stuckWorld()
    const runtime = createRuntime({ services: [Stuck], limits: { loadTimeoutMs: 30, disposalGraceMs: 10 } })
    const env = await runtime.enter(Entry)
    await assert.rejects(env.deps.stuck.load(), error => error.code === 'LOAD_TIMEOUT' && error.details.deadlineMs === 30)
    await env.dispose()
    await runtime.dispose()
  }

  {
    const { Stuck, Entry } = stuckWorld()
    const runtime = createRuntime({ services: [Stuck], limits: { disposalGraceMs: 20 } })
    const env = await runtime.enter(Entry)
    void env.deps.stuck.load().catch(() => undefined)
    const started = Date.now()
    // dispose() fulfils (S2) and abandons the attempt onto the ledger.
    await env.dispose()
    assert.ok(Date.now() - started < 1_000, 'the close is bounded by the grace, not by the setup deadline')
    assert.equal(env.state, 'disposed')
    assert.equal(runtime.inspect().unsettledAttempts.length, 1)
    await runtime.dispose()
  }

  // Budget: a world that needs more than two candidate expansions.
  const define = makeDefine('expired-budget')
  const Needed = define.input('needed')
  const Cap = define.contract('cap')
  const providers = Array.from({ length: 6 }, (_, index) => makeDefine(`expired-budget-p${index}`).service({ provides: [Cap], requires: { needed: Needed }, setup: () => ({}) }))
  const Fixed1 = makeDefine('expired-budget-fixed', '1.0.0').service({ uniqueWithin: 'lineage', setup: () => ({}) })
  const Fixed2 = makeDefine('expired-budget-fixed', '2.0.0').service({ uniqueWithin: 'lineage', setup: () => ({}) })
  const Pick1 = makeDefine('expired-budget-pick1').service({ provides: [Cap], requires: { fixed: Fixed1 }, setup: () => ({}) })
  const Pick2 = makeDefine('expired-budget-pick2').service({ provides: [Cap], requires: { fixed: Fixed2 }, setup: () => ({}) })
  const Consumer = define.service('consumer', { requires: { a: { kind: 'auto-implementation', contract: Cap }, b: { kind: 'auto-implementation', contract: Cap } }, setup: () => ({}) })
  const BudgetEntry = define.entry('budget', { requires: { consumer: Consumer, fixed: Fixed2 } })
  const policy = { orderAutoCandidates: (_c, candidates) => [...candidates].sort((l, r) => l.id.localeCompare(r.id)) }
  const tight = createRuntime({ services: [Consumer, Pick1, Pick2, Fixed1, Fixed2, ...providers], policy, limits: { planningBudget: 2 } })
  await assert.rejects(tight.check(BudgetEntry), error => error.code === 'PLANNING_BUDGET_EXCEEDED' && error.details.budget === 2)
  await tight.dispose()
})

test('limits: the removed nested option records are refused, not ignored; invalid values are refused', () => {
  const removed = [
    [{ planCache: { maxEntries: 3 } }, 'planCache', 'planCacheEntries'],
    [{ initialization: { deadlineMs: 5 } }, 'initialization', 'loadTimeoutMs'],
    [{ disposal: { graceMs: 5 } }, 'disposal', 'disposalGraceMs'],
    [{ planning: { searchBudget: 5 } }, 'planning', 'planningBudget'],
  ]
  for (const [options, record, limit] of removed) {
    const message = `createRuntime() option ${record} was removed in 0.7.0; use limits.${limit}.`
    assert.throws(() => createRuntime({ services: [], ...options }), { name: 'TypeError', message })
    assert.throws(() => createRuntime({ services: [], limits: { [limit]: 5 }, ...options }), { name: 'TypeError', message }, 'refused even next to the current form')
  }
  const invalid = [
    ['loadTimeoutMs', 0, 'limits.loadTimeoutMs must be a positive number.'],
    ['disposalGraceMs', -1, 'limits.disposalGraceMs must be a positive number.'],
    ['planningBudget', 0, 'limits.planningBudget must be a positive safe integer.'],
    ['planCacheEntries', 1.5, 'limits.planCacheEntries must be a positive safe integer.'],
  ]
  for (const [key, value, message] of invalid) {
    assert.throws(() => createRuntime({ services: [], limits: { [key]: value } }), { name: 'TypeError', message })
  }
  assert.throws(() => createRuntime({ services: [], limits: 5 }), { name: 'TypeError', message: 'limits must be an object.' })
  assert.doesNotThrow(() => createRuntime({ services: [], limits: { loadTimeoutMs: Infinity } }), 'Infinity disables the deadline')
})

// v0.7 (Phase B, §2.2): the selector's last remnants are gone. Every candidate of C.all is a real node of the current
// topology, so `availability` (always `{ status: 'available' }` since the selector left in 0.6) said nothing.
test('C.all candidates carry the descriptor fields and ref only: no availability field; loading a candidate is the availability', async () => {
  const define = makeDefine('remnants')
  const Capability = define.contract('capability')
  const A = makeDefine('remnants-a').service({ provides: [Capability], setup: () => ({ id: 'a' }) })
  const B = makeDefine('remnants-b', '2.1.0').service({ provides: [Capability], setup: () => ({ id: 'b' }) })
  const Host = define.service('host', { requires: { all: Capability.all }, setup: ({ all }) => ({ all }) })
  const Entry = define.entry('entry', { requires: { host: Host } })
  const runtime = createRuntime({ services: [A, B, Host] })
  const env = await runtime.enter(Entry)
  const set = await (await env.deps.host.load()).all.load()
  assert.equal(set.candidates.length, 2)
  const ids = { 'remnants-a': 'a', 'remnants-b': 'b' }
  for (const candidate of set.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['candidateRef', 'contractId', 'eager', 'familyId', 'familyMetadata', 'implementationRef', 'revisionMetadata', 'version'])
    assert.equal('availability' in candidate, false)
    assert.ok(Object.isFrozen(candidate))
    assert.equal(candidate.candidateRef.kind, 'candidate-ref')
    assert.equal((await set.load(candidate)).id, ids[candidate.familyId])
    assert.equal((await set.load(candidate.candidateRef)).id, ids[candidate.familyId])
    assert.equal(set.resolve(candidate.implementationRef), candidate)
  }
  assert.deepEqual([...set].map(candidate => candidate.familyId), set.candidates.map(candidate => candidate.familyId))
  await env.dispose()
  await runtime.dispose()
})
