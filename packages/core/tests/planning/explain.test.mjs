// K12 — check()/explain() plan only and report inherited/new/forked with causes.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage } from '../../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@v05/${id.replaceAll('.', '-')}`,
  version,
  syna: { id },
})

test('K12 explain distinguishes inherited, new and forked nodes and gives the cause path for a per-request rebuild', async () => {
  const define = makeDefine('v05.explain')
  const CurrentRequest = define.input('current-request')
  const Logger = define.service('logger', { setup: () => ({}) })
  const RequestAwareLogger = define.service('request-aware-logger', {
    requires: { request: CurrentRequest, logger: Logger },
    setup: () => ({}),
  })
  const DatabasePool = define.service('database-pool', {
    requires: { logger: RequestAwareLogger },
    eager: true,
    setup: () => ({}),
  })
  const Handler = define.service('handler', { requires: { pool: DatabasePool }, setup: () => ({}) })
  const Root = define.entry('root', { requires: { pool: DatabasePool, logger: Logger }, parameters: { request: CurrentRequest } })
  const Request = define.entry('request', { requires: { handler: Handler }, parameters: { request: CurrentRequest } })
  const runtime = createRuntime({ services: [DatabasePool, Handler, Logger] })
  const root = await runtime.enter(Root, { request: 'boot' })
  const explanation = await root.explain(Request, { request: 'r1' })
  assert.equal(explanation.ok, true)
  assert.equal(explanation.parent, root.id)
  assert.deepEqual(explanation.services, { reused: 1, new: 1, forked: 2, eagerToStart: 1, eagerReused: 0 })
  assert.deepEqual(explanation.inputs, { inherited: 0, provided: 1 })
  const pool = explanation.nodes.find(node => node.nodeId === `service:${DatabasePool.id}`)
  assert.equal(pool.placement, 'forked')
  assert.deepEqual(pool.cause, { kind: 'dependency-forked', via: 'logger', dependency: `service:${RequestAwareLogger.id}` })
  assert.deepEqual(pool.path, [`service:${DatabasePool.id}`, `service:${RequestAwareLogger.id}`, `input:${CurrentRequest.id}`])
  const requestNode = explanation.nodes.find(node => node.nodeId === `input:${CurrentRequest.id}`)
  assert.deepEqual(requestNode.cause, { kind: 'input-provided', input: CurrentRequest.id })
  const handler = explanation.nodes.find(node => node.nodeId === `service:${Handler.id}`)
  assert.equal(handler.placement, 'new')
  assert.equal(handler.cause.kind, 'not-in-parent')
  assert.equal(explanation.nodes.find(node => node.nodeId === `service:${Logger.id}`).placement, 'reused')
  assert.equal(explanation.forks.length, 4)
  // explain() executed no setup, published no Env and left no anchor behind.
  assert.equal(runtime.inspect().liveEnvCount, 1)
  assert.equal(root.inspect().nodes.every(node => node.state !== 'starting'), true)
  await runtime.dispose()
})

test('K12 check/explain never execute setup and report unsatisfiable constraints, missing parameters and budget exhaustion honestly', async () => {
  const define = makeDefine('v05.explain-errors')
  let starts = 0
  const Eager = define.service('eager', { eager: true, setup: () => { starts += 1; return {} } })
  const Needed = define.input('needed')
  const Needy = define.service('needy', { requires: { needed: Needed }, setup: () => ({}) })
  const Entry = define.entry({ requires: { eager: Eager, needy: Needy }, parameters: { needed: Needed } })
  const runtime = createRuntime({ services: [Eager, Needy] })
  const ok = await runtime.explain(Entry, { needed: 1 })
  assert.equal(ok.ok, true)
  assert.equal(ok.services.eagerToStart, 1)
  assert.deepEqual(ok.parameters.inputsProvided, [Needed.id])
  const missing = await runtime.explain(Entry, {})
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'MISSING_INPUT')
  assert.deepEqual(missing.missingInputs, [Needed.id])
  assert.equal(starts, 0)
  assert.equal(runtime.inspect().liveEnvCount, 0)

  // Budget exhaustion is a budget error, not a proof of unsatisfiability.
  const Cap = define.contract('cap')
  const providers = Array.from({ length: 6 }, (_, index) =>
    makeDefine(`v05.explain-budget.p${index}`).service({ provides: [Cap], requires: { needed: Needed }, setup: () => ({}) }))
  const Fixed1 = makeDefine('v05.explain-budget.fixed', '1.0.0').service({ uniqueWithin: 'lineage', setup: () => ({}) })
  const Fixed2 = makeDefine('v05.explain-budget.fixed', '2.0.0').service({ uniqueWithin: 'lineage', setup: () => ({}) })
  const Pick1 = makeDefine('v05.explain-budget.pick1').service({ provides: [Cap], requires: { fixed: Fixed1 }, setup: () => ({}) })
  const Pick2 = makeDefine('v05.explain-budget.pick2').service({ provides: [Cap], requires: { fixed: Fixed2 }, setup: () => ({}) })
  const Consumer = define.service('consumer', {
    requires: { a: { kind: 'auto-implementation', contract: Cap }, b: { kind: 'auto-implementation', contract: Cap } },
    setup: () => ({}),
  })
  const BudgetEntry = define.entry('budget', { requires: { consumer: Consumer, fixed: Fixed2 } })
  const tight = createRuntime({
    services: [Consumer, Pick1, Pick2, Fixed1, Fixed2, ...providers],
    limits: { planningBudget: 2 },
    policy: { orderAutoCandidates: (_c, candidates) => [...candidates].sort((l, r) => l.id.localeCompare(r.id)) },
  })
  await assert.rejects(tight.enter(BudgetEntry), error => error.code === 'PLANNING_BUDGET_EXCEEDED')
  await assert.rejects(tight.check(BudgetEntry), error => error.code === 'PLANNING_BUDGET_EXCEEDED')
  const roomy = createRuntime({
    services: [Consumer, Pick1, Pick2, Fixed1, Fixed2],
    policy: { orderAutoCandidates: (_c, candidates) => [...candidates].sort((l, r) => l.id.localeCompare(r.id)) },
  })
  const solved = await roomy.explain(BudgetEntry)
  assert.equal(solved.ok, true)
  assert.ok(Object.values(solved.choices).every(key => key === Pick2.id || key === Fixed2.id))
  await runtime.dispose()
})

test('K12 planning consumes no Env id and grows the registries only by the distinct descriptors it meets', async () => {
  // Third review round (C5): check()/explain() register descriptors and may fill
  // the plan cache, but publish nothing and never advance the Env numbering.
  const define = makeDefine('v05.explain-bounded')
  const Tenant = define.input('tenant')
  const Capability = define.contract()
  const Choice = define.binding('choice', Capability)
  const Impl = define.service('impl', { provides: [Capability], setup: () => ({}) })
  const Cache = define.service('cache', { requires: { tenant: Tenant, impl: Choice }, setup: () => ({}) })
  const App = define.entry('app', { requires: {} })
  const Site = define.entry('site', { requires: { cache: Cache }, parameters: { tenant: Tenant, choice: Choice } })
  const runtime = createRuntime({ services: [Cache, Impl] })
  const app = await runtime.enter(App)
  const before = runtime.inspect()
  assert.deepEqual(before.definitions, { entries: 1, inputs: 1, bindings: 1, contracts: 1, families: 2 })
  for (let index = 0; index < 50; index += 1) {
    const check = await app.check(Site, { tenant: `t${index}`, choice: Impl })
    assert.equal(check.ok, true)
    const explanation = await app.explain(Site, { tenant: `t${index}`, choice: Impl })
    assert.equal(explanation.ok, true)
  }
  const after = runtime.inspect()
  assert.deepEqual([after.liveEnvCount, after.rootEnvCount], [before.liveEnvCount, before.rootEnvCount])
  assert.deepEqual(after.definitions, { ...before.definitions, entries: 2 }, 'only the Entry planned for the first time was new')
  assert.equal(after.planCache.entries - before.planCache.entries, 1, 'one template for 100 plans of the same shape')
  const site = await app.enter(Site, { tenant: 'real', choice: Impl })
  assert.equal(site.id, `env-${Number(app.id.slice('env-'.length)) + 1}`, 'planning consumed no Env id')
  assert.deepEqual(runtime.inspect().definitions, after.definitions)
  await runtime.dispose()
})
