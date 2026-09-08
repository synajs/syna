import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auto,
  createRuntime,
  definePackage,
  override,
} from '../../dist/index.js'

const defineFor = (id, version = '1.0.0') => definePackage({
  name: `@test/${id.replaceAll('.', '-')}`,
  version,
  syna: { id },
})

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const withTimeout = async (promise, milliseconds = 1000) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds} ms.`)), milliseconds)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

async function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition.')
    await sleep(1)
  }
}

test('C.all planning is reusable and bounded across short-lived request Envs', async () => {
  const define = defineFor('v04.collection-cache')
  const Capability = define.contract()
  const Request = define.input('request')
  const ProviderA = defineFor('v04.collection-cache.a').service({
    provides: [Capability],
    setup: () => ({ id: 'a' }),
  })
  const ProviderB = defineFor('v04.collection-cache.b').service({
    provides: [Capability],
    setup: () => ({ id: 'b' }),
  })
  const ProviderC = defineFor('v04.collection-cache.c').service({
    provides: [Capability],
    setup: () => ({ id: 'c' }),
  })
  const Panel = define.service('panel', {
    requires: { request: Request, implementations: Capability.all },
    setup: ({ request, implementations }) => ({ request, implementations }),
  })
  const Root = define.entry('root', {})
  const RequestEntry = define.entry('request', {
    requires: { panel: Panel },
    parameters: { request: Request },
  })
  const runtime = createRuntime({
    services: [Panel, ProviderA, ProviderB, ProviderC],
    limits: { planCacheEntries: 32 },
  })
  const root = await runtime.enter(Root)

  for (let index = 0; index < 200; index += 1) {
    const requestEnv = await root.enter(RequestEntry, { request: index })
    await requestEnv.dispose()
  }

  const cache = runtime.inspect().planCache
  assert.ok(cache.hits >= 199, `expected request-plan cache hits, received ${JSON.stringify(cache)}`)
  assert.ok(cache.misses <= 8, `request plans should not miss per Env: ${JSON.stringify(cache)}`)
  assert.ok(cache.entries <= 8, `plan cache should remain bounded by semantic shapes: ${JSON.stringify(cache)}`)
  await runtime.dispose()
})

// v0.5 (MIGRATION M-06): both forms are background operations; neither blocks B.
// v0.6 D1: the former preload() form is the same un-awaited load with a swallowing catch.
test('an un-awaited load, with or without a swallowing catch, is a non-blocking background operation', async () => {
  const define = defineFor('v04.materialization-protocol')
  let A
  let B
  let C

  A = define.service('a', {
    requires: { c: defineFor('v04.materialization-protocol-placeholder').input('unused') },
    setup: () => ({}),
  })
  // Re-declare the real cycle with forward-free late variables through closures in setup APIs.
  const Access = define.input('access')
  C = define.service('c', {
    requires: { b: { kind: 'forward-dependency', get: () => B } },
    async setup({ b }) {
      await b.load()
      return { id: 'c' }
    },
  })
  A = define.service('a-real', {
    requires: { c: C },
    setup({ c }) {
      return {
        prewarm: () => { void c.load().catch(() => undefined) },
        strong: () => { void c.load() },
      }
    },
  })
  B = define.service('b', {
    requires: { a: A, mode: Access },
    async setup({ a, mode }) {
      const readyA = await a.load()
      if (mode.read() === 'preload') readyA.prewarm()
      else readyA.strong()
      return { id: 'b' }
    },
  })

  const Entry = define.entry({
    requires: { a: A, b: B, c: C },
    parameters: { mode: Access },
  })

  const safeRuntime = createRuntime({ services: [A, B, C] })
  const safeEnv = await safeRuntime.enter(Entry, { mode: 'preload' })
  await safeEnv.deps.a.load()
  assert.equal((await safeEnv.deps.b.load()).id, 'b')
  assert.equal((await safeEnv.deps.c.load()).id, 'c')
  await safeRuntime.dispose()

  const strongRuntime = createRuntime({ services: [A, B, C] })
  const strongEnv = await strongRuntime.enter(Entry, { mode: 'strong' })
  await strongEnv.deps.a.load()
  assert.equal((await withTimeout(strongEnv.deps.b.load())).id, 'b')
  assert.equal((await withTimeout(strongEnv.deps.c.load())).id, 'c')
  await strongRuntime.dispose()
})

test('disposing an owner aborts an in-progress retry sequence and backoff', async () => {
  const define = defineFor('v04.retry-dispose')
  let attempts = 0
  const abortedStates = []
  const Flaky = define.service({
    failure: { attempts: 5, delayMs: 250 },
    setup(_deps, { signal }) {
      attempts += 1
      abortedStates.push(signal.aborted)
      throw new Error('still unavailable')
    },
  })
  const Entry = define.entry({ requires: { flaky: Flaky } })
  const runtime = createRuntime({ services: [Flaky] })
  const env = await runtime.enter(Entry)
  const load = env.deps.flaky.load().catch(() => undefined)
  await waitFor(() => attempts >= 1)
  const started = Date.now()
  await env.dispose()
  const elapsed = Date.now() - started
  await load

  assert.ok(elapsed < 150, `dispose waited ${elapsed} ms for a cancelled retry schedule`)
  assert.deepEqual(abortedStates, [false])
  await runtime.dispose()
})

test('definition override preserves source admission identity across exact, Contract, all and reuse constraints', async () => {
  const define = defineFor('v04.override')
  const Db = define.contract()
  const Real = define.service('postgres', {
    provides: [Db],
    setup: () => ({ source: 'real' }),
  })
  const Fake = define.service('fake-postgres', {
    setup: () => ({ source: 'fake' }),
  })
  const ExactConsumer = define.service('exact-consumer', {
    requires: { db: Real },
    setup: ({ db }) => ({ source: async () => (await db.load()).source }),
  })
  const ContractConsumer = define.service('contract-consumer', {
    requires: { db: Db, all: Db.all },
    setup: dependencies => dependencies,
  })
  const Root = define.entry('root', {
    requires: { exact: ExactConsumer, contract: ContractConsumer },
  })
  const Fresh = define.entry('fresh', {
    requires: { exact: ExactConsumer },
    reuse: { fresh: [Real] },
  })
  const runtime = createRuntime({
    services: [ExactConsumer, ContractConsumer, Real],
    overrides: [override(Real, Fake)],
  })

  assert.deepEqual(runtime.inspect().admittedServices, [
    ExactConsumer.id,
    ContractConsumer.id,
    Real.id,
  ].sort())
  assert.equal(runtime.catalog.implementations(Db).length, 1)
  assert.equal(runtime.catalog.implementations(Db)[0].familyId, Real.family.id)

  const root = await runtime.enter(Root)
  assert.equal(await (await root.deps.exact.load()).source(), 'fake')
  const contract = await root.deps.contract.load()
  assert.equal((await contract.db.load()).source, 'fake')
  const all = await contract.all.load()
  assert.equal(all.candidates.length, 1)
  assert.equal(all.candidates[0].familyId, Real.family.id)
  assert.equal((await all.load(all.candidates[0])).source, 'fake')

  const fresh = await root.enter(Fresh)
  assert.notEqual(
    root.inspect().nodes.find(node => node.nodeId === `service:${Real.id}`)?.slotId,
    fresh.inspect().nodes.find(node => node.nodeId === `service:${Real.id}`)?.slotId,
  )
  await runtime.dispose()
})

test('a Service-owned Entry may resolve exact private roots without exposing them publicly', async () => {
  const define = defineFor('v04.private-entry')
  const Transaction = define.service('transaction', {
    setup: () => ({ id: 'private-transaction' }),
  })
  const TransactionEntry = define.entry('transaction-entry', {
    requires: { transaction: Transaction },
  })
  const UnitOfWork = define.service('unit-of-work', {
    requires: { transactionEntry: TransactionEntry },
    setup({ transactionEntry }) {
      return {
        async run() {
          const bound = await transactionEntry.load()
          return bound.run(async ({ transaction }) => (await transaction.load()).id)
        },
      }
    },
  })
  const Root = define.entry({ requires: { uow: UnitOfWork } })
  const runtime = createRuntime({ services: [UnitOfWork] })

  assert.deepEqual(runtime.inspect().admittedServices, [UnitOfWork.id])
  assert.ok(runtime.inspect().privateServices.includes(Transaction.id))
  const env = await runtime.enter(Root)
  assert.equal(await (await env.deps.uow.load()).run(), 'private-transaction')
  await runtime.dispose()
})

test('retry-on-next-load starts a new exactly-once setup sequence after exhaustion', async () => {
  const define = defineFor('v04.retry-next-load')
  let attempts = 0
  const Recoverable = define.service({
    failure: {
      attempts: 1,
      afterExhaustion: 'retry-on-next-load',
    },
    setup() {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return { attempts }
    },
  })
  const Entry = define.entry({ requires: { service: Recoverable } })
  const runtime = createRuntime({ services: [Recoverable] })
  const env = await runtime.enter(Entry)

  await assert.rejects(env.deps.service.load(), /transient/)
  const [first, second] = await Promise.all([
    env.deps.service.load(),
    env.deps.service.load(),
  ])
  assert.strictEqual(first, second)
  assert.equal(first.attempts, 2)
  assert.equal(attempts, 2)
  await runtime.dispose()
})

// v0.5 (MIGRATION M-05 / K10): the coordinator's setup returns an initialized
// control object; the host starts the worker world after the root is Ready.
test('a worker world is started by the host after the owner is Ready, not during eager setup', async () => {
  const define = defineFor('v04.activation-entry')
  let childStarts = 0
  let childDisposes = 0
  const Worker = define.service('worker', {
    eager: true,
    setup(_deps, { onDispose }) {
      childStarts += 1
      onDispose(() => { childDisposes += 1 })
      return { id: 'worker' }
    },
  })
  const WorkerEntry = define.entry('worker-entry', { requires: { worker: Worker } })
  const Coordinator = define.service('coordinator', {
    eager: true,
    requires: { workerEntry: WorkerEntry },
    async setup({ workerEntry }, { onDispose }) {
      const bound = await workerEntry.load()
      let child
      onDispose(async () => { await child?.dispose() })
      return {
        async start() {
          child = await bound.enter()
          return child.deps.worker.load()
        },
      }
    },
  })
  const Root = define.entry({ requires: { coordinator: Coordinator } })
  const runtime = createRuntime({ services: [Coordinator] })
  const env = await runtime.enter(Root)
  assert.equal(childStarts, 0)
  const coordinator = await env.deps.coordinator.load()
  assert.equal((await coordinator.start()).id, 'worker')
  assert.equal(childStarts, 1)
  await runtime.dispose()
  assert.equal(childDisposes, 1)
})

test('plan cache is capped and reports eviction rather than retaining unlimited Entry shapes', async () => {
  const define = defineFor('v04.cache-bound')
  const Service = define.service({ setup: () => ({}) })
  const runtime = createRuntime({ services: [Service], limits: { planCacheEntries: 4 } })
  for (let index = 0; index < 20; index += 1) {
    const Entry = define.entry(`entry-${index}`, { requires: { service: Service } })
    const env = await runtime.enter(Entry)
    await env.dispose()
  }
  const cache = runtime.inspect().planCache
  assert.equal(cache.entries, 4)
  assert.ok(cache.evictions >= 16)
  await runtime.dispose()
})
