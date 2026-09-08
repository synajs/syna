// K10 / K11 / R06 / R07 / R08 — private realms, owner anchors, compiled overrides.
import assert from 'node:assert/strict'
import test from 'node:test'
import { auto, createRuntime, definePackage, override } from '../../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@v05/${id.replaceAll('.', '-')}-${version}`,
  version,
  syna: { id },
})

test('R06 override: Real needs config, Fake does not; Fake adds its own private helper; every resolution path agrees; source appears once', async () => {
  const define = makeDefine('v05.override')
  const Db = define.contract('db')
  const Config = define.input('config')
  const Real = define.service('postgres', {
    provides: [Db],
    requires: { config: Config },
    setup: ({ config }) => ({ source: 'real', config: config.read() }),
  })
  const Helper = define.service('fake-helper', { setup: () => ({ helper: true }) })
  const Fake = define.service('fake-postgres', {
    requires: { helper: Helper },
    setup: async ({ helper }) => ({ source: 'fake', helper: (await helper.load()).helper }),
  })
  const Consumer = define.service('consumer', {
    requires: { exact: Real, strict: Db, automatic: auto(Db), all: Db.all, range: Real.range('^1') },
    setup: deps => deps,
  })
  const Entry = define.entry({ requires: { consumer: Consumer } })
  const runtime = createRuntime({ services: [Consumer, Real], overrides: [override(Real, Fake)] })

  // No Config is required: the executable manifest is the Fake's.
  const check = await runtime.check(Entry)
  assert.equal(check.ok, true)
  const env = await runtime.enter(Entry)
  const consumer = await env.deps.consumer.load()
  const values = await Promise.all([
    consumer.exact.load(), consumer.strict.load(), consumer.automatic.load(), consumer.range.load(),
  ])
  assert.ok(values.every(value => value === values[0]))
  assert.deepEqual(values[0], { source: 'fake', helper: true })
  const all = await consumer.all.load()
  assert.equal(all.candidates.length, 1)
  assert.equal(all.candidates[0].familyId, Real.family.id)
  assert.strictEqual(await all.load(all.candidates[0]), values[0])
  assert.deepEqual(runtime.inspect().admittedServices, [Consumer.id, Real.id].sort())
  assert.deepEqual(runtime.inspect().overriddenServices, [Real.id])
  assert.ok(runtime.inspect().privateServices.includes(Helper.id))
  assert.deepEqual(runtime.catalog.implementations(Db).map(item => item.familyId), [Real.family.id])
  // `fresh: [Real]` forks the compiled override (the Fake under Real's identity) and
  // its reverse closure into the derived Env; the Fake's private helper has no
  // dependency on Real and stays shared with the parent.
  const fresh = await env.derive({ reuse: { fresh: [Real] } })
  const ownersOf = (handle, needle) => [...new Set(handle.inspect().nodes.filter(node => node.label.includes(needle)).map(node => node.ownerEnvId))]
  assert.deepEqual(ownersOf(fresh, '/postgres@'), [fresh.id])
  assert.deepEqual(ownersOf(fresh, '/consumer@'), [fresh.id])
  assert.deepEqual(ownersOf(fresh, '/fake-helper@'), [env.id])
  const freshEntry = await fresh.enter(Entry)
  const freshConsumer = await freshEntry.deps.consumer.load()
  const freshValues = await Promise.all([
    freshConsumer.exact.load(), freshConsumer.strict.load(), freshConsumer.automatic.load(), freshConsumer.range.load(),
  ])
  assert.ok(freshValues.every(value => value === freshValues[0]), 'every resolution path agrees inside the fork too')
  assert.notStrictEqual(freshValues[0], values[0], 'the fork owns a new instance')
  assert.deepEqual(freshValues[0], { source: 'fake', helper: true }, 'and it is still the Fake')
  await runtime.dispose()

  // Explicitly admitting the Fake as well makes it a second, independent candidate.
  const both = createRuntime({ services: [Consumer, Real, Fake], overrides: [override(Real, Fake)] })
  assert.deepEqual(both.catalog.implementations(Db).map(item => item.familyId), [Real.family.id])
  assert.deepEqual(both.inspect().admittedServices, [Consumer.id, Fake.id, Real.id].sort())
  assert.throws(() => createRuntime({ services: [Real], overrides: [override(Real, Fake), override(Real, Helper)] }), error => error.code === 'DUPLICATE_DEFINITION')
  assert.throws(() => createRuntime({ services: [Real], overrides: [override(Real, Real)] }), error => error.code === 'INVALID_DESCRIPTOR')
  assert.throws(() => createRuntime({ services: [Real], overrides: [override(Real, Fake), override(Fake, Real)] }), error => error.code === 'INVALID_DESCRIPTOR')
})

test('R07 a Service-owned Entry resolves exact and range private roots identically; public callers with the same descriptor are refused; private Contract implementations do not leak', async () => {
  const define = makeDefine('v05.private-realm')
  const Capability = define.contract()
  const Transaction = define.service('transaction', { provides: [Capability], setup: () => ({ id: 'tx' }) })
  // Third review round (C1): a Family the owner references only by range, never exactly.
  // The range carries its origin revision, so the origin is a candidate of the private realm.
  const Ledger = makeDefine('v05.private-realm.ledger').service('ledger', { setup: () => ({ version: '1.0.0' }) })
  const ExactEntry = define.entry('tx-exact', { requires: { tx: Transaction } })
  const RangeEntry = define.entry('tx-range', { requires: { tx: Transaction.range('^1.0.0') } })
  const LedgerEntry = define.entry('ledger', { requires: { ledger: Ledger.range('^1') } })
  const ContractEntry = define.entry('tx-contract', { requires: { tx: Capability } })
  const UnitOfWork = define.service('uow', {
    requires: { exact: ExactEntry, range: RangeEntry, ledger: LedgerEntry, contract: ContractEntry },
    setup: ({ exact, range, ledger, contract }) => ({
      exact: async () => (await exact.load()).run(async ({ tx }) => (await tx.load()).id),
      range: async () => (await range.load()).run(async ({ tx }) => (await tx.load()).id),
      ledger: async () => (await ledger.load()).run(async ({ ledger }) => (await ledger.load()).version),
      contractCheck: async () => (await contract.load()).check(),
    }),
  })
  const App = define.entry({ requires: { uow: UnitOfWork } })
  const runtime = createRuntime({ services: [UnitOfWork] })
  const app = await runtime.enter(App)
  const uow = await app.deps.uow.load()
  assert.equal(await uow.exact(), 'tx')
  assert.equal(await uow.range(), 'tx')
  assert.equal(await uow.ledger(), '1.0.0', 'a range-only private Family resolves to the range origin')
  assert.ok(runtime.inspect().privateServices.includes(Ledger.id))
  assert.ok(!runtime.inspect().admittedServices.includes(Ledger.id))
  const contractCheck = await uow.contractCheck()
  assert.equal(contractCheck.ok, false)
  assert.equal(contractCheck.error.code, 'MISSING_IMPLEMENTATION', 'Contract discovery stays public')
  await assert.rejects(app.enter(ExactEntry), error => error.code === 'MISSING_SERVICE')
  await assert.rejects(app.enter(RangeEntry), error => error.code === 'MISSING_SERVICE')
  await assert.rejects(app.enter(LedgerEntry), error => error.code === 'MISSING_SERVICE', 'the range origin is private to its owner')
  await assert.rejects(app.anchor(ExactEntry).enter(), error => error.code === 'MISSING_SERVICE')
  await assert.rejects(app.anchor(LedgerEntry).enter(), error => error.code === 'MISSING_SERVICE')
  assert.deepEqual(runtime.catalog.implementations(Capability), [])
  await runtime.dispose()
})

test('R07 a range prefers an admitted newer revision over its private origin, and only revisions providing the origin\'s Contracts are candidates', async () => {
  // Third review round (C1/C2): candidates = {origin} ∪ owner closure ∪ admitted,
  // filtered by the origin's Contracts (a range loads the Contract view).
  const define = makeDefine('v05.private-realm.versions')
  const Cap = define.contract('cap')
  const Ledger10 = makeDefine('v05.ledger', '1.0.0').service('ledger', { provides: [Cap], setup: () => ({ version: '1.0.0', check: () => 'ok' }) })
  const Ledger11 = makeDefine('v05.ledger', '1.1.0').service('ledger', { provides: [Cap], setup: () => ({ version: '1.1.0', check: () => 'ok' }) })
  const Ledger12 = makeDefine('v05.ledger', '1.2.0').service('ledger', { setup: () => ({ version: '1.2.0' }) })
  const PrivateEntry = define.entry('private', { requires: { ledger: Ledger10.range('^1') } })
  const Owner = define.service('owner', {
    requires: { entry: PrivateEntry },
    setup: ({ entry }) => ({ version: async () => (await entry.load()).run(async ({ ledger }) => (await ledger.load()).version) }),
  })
  const Public = define.entry('public', { requires: { ledger: Ledger10.range('^1') } })
  const App = define.entry('app', { requires: { owner: Owner } })
  const runtime = createRuntime({ services: [Owner, Ledger11, Ledger12] })
  const app = await runtime.enter(App)
  assert.equal(await (await app.deps.owner.load()).version(), '1.1.0', 'private consumer: the admitted 1.1.0 beats the private origin 1.0.0; 1.2.0 dropped the Contract')
  const pub = await app.enter(Public)
  assert.equal((await pub.deps.ledger.load()).version, '1.1.0', 'the public consumer agrees')
  const incompatible = await app.check(define.entry('only-incompatible', { requires: { ledger: Ledger10.range('^1.2') } }))
  assert.equal(incompatible.ok, false)
  assert.equal(incompatible.error.code, 'INCOMPATIBLE_IMPLEMENTATION')
  assert.deepEqual(incompatible.error.details.required, [Cap.id])
  assert.deepEqual(incompatible.error.details.candidates, [{ revision: Ledger12.id, provides: [] }])
  const bare = await app.check(define.entry('bare', { requires: { ledger: Ledger12.range('^1') } }))
  assert.equal(bare.ok, true, 'a range from a revision without provides accepts any compatible revision')
  await runtime.dispose()
})

test('R08 an owner-bound Entry stays bound to its owner after inheritance; app-owned UoW never sees request Inputs; explicit parameters work; the handle causes no fresh', async () => {
  const define = makeDefine('v05.owner-anchor')
  const CurrentRequest = define.input('current-request')
  const Payload = define.input('payload')
  const Worker = define.service('worker', {
    requires: { payload: Payload },
    setup: ({ payload }) => ({ payload: payload.read() }),
  })
  const RequestWorker = define.service('request-worker', {
    requires: { request: CurrentRequest },
    setup: ({ request }) => ({ request: request.read() }),
  })
  const WorkerEntry = define.entry('worker', { requires: { worker: Worker }, parameters: { payload: Payload } })
  const RequestWorkerEntry = define.entry('request-worker', { requires: { worker: RequestWorker } })
  const UnitOfWork = define.service('uow', {
    requires: { workers: WorkerEntry, requestWorkers: RequestWorkerEntry },
    setup: ({ workers, requestWorkers }) => ({
      run: async payload => (await workers.load()).run({ payload }, async ({ worker }, env) => ({
        payload: (await worker.load()).payload, parent: env.inspect().parentId,
      })),
      requestCheck: async () => (await requestWorkers.load()).check(),
    }),
  })
  const App = define.entry('app', { requires: { uow: UnitOfWork } })
  const Request = define.entry('request', { requires: { uow: UnitOfWork }, parameters: { request: CurrentRequest } })
  const runtime = createRuntime({ services: [UnitOfWork] })
  const app = await runtime.enter(App)
  const request = await app.enter(Request, { request: { id: 'r1' } })
  const uowFromApp = await app.deps.uow.load()
  const uowFromRequest = await request.deps.uow.load()
  assert.strictEqual(uowFromApp, uowFromRequest, 'the handle did not force a fresh UoW per request')
  const result = await uowFromRequest.run('explicit')
  assert.equal(result.payload, 'explicit')
  assert.equal(result.parent, app.id, 'the child world is anchored at the owner, not the request')
  const check = await uowFromRequest.requestCheck()
  assert.equal(check.ok, false)
  assert.equal(check.error.code, 'MISSING_INPUT')
  const explanation = await app.explain(Request, { request: { id: 'r2' } })
  assert.equal(explanation.ok, true)
  assert.equal(explanation.services.forked, 0)
  assert.equal(explanation.services.new, 0)
  assert.equal(explanation.synthetic.reused, 2)
  await runtime.dispose()
})

test('K10 a Service-owned Entry declared in requires does not pull its future roots or Inputs into the current graph', async () => {
  const define = makeDefine('v05.deferred-roots')
  const TxInput = define.input('tx-input')
  const Heavy = define.service('heavy', { requires: { input: TxInput }, eager: true, setup: () => { throw new Error('must not start') } })
  const TxEntry = define.entry('tx', { requires: { heavy: Heavy }, parameters: { input: TxInput } })
  const Owner = define.service('owner', { requires: { tx: TxEntry }, setup: ({ tx }) => ({ tx }) })
  const App = define.entry({ requires: { owner: Owner } })
  const runtime = createRuntime({ services: [Owner] })
  const app = await runtime.enter(App)
  const nodeIds = app.inspect().nodes.map(node => node.nodeId)
  assert.ok(!nodeIds.includes(`service:${Heavy.id}`))
  assert.ok(!nodeIds.includes(`input:${TxInput.id}`))
  assert.ok(runtime.inspect().privateServices.includes(Heavy.id), 'the Runtime knows the definition')
  await runtime.dispose()
})
