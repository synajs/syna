import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRuntime,
  definePackage,
  loadAll,
  override,
} from '../../dist/index.js'

const defineFor = (id, version = '1.0.0') => definePackage({
  name: `@adversarial/${id.replaceAll('.', '-')}`,
  version,
  syna: { id },
})

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

test('plan cache never reuses root-site mappings across different Entry lineages', async () => {
  const define = defineFor('v04.cache-lineage')
  const Service = define.service({ setup: () => ({ id: 'service' }) })
  const RootA = define.entry('root-a', { requires: { alpha: Service } })
  const RootB = define.entry('root-b', { requires: { beta: Service } })
  const Child = define.entry('child', { requires: { child: Service } })
  const runtime = createRuntime({ services: [Service] })

  const rootA = await runtime.enter(RootA)
  const rootB = await runtime.enter(RootB)
  const childA = await rootA.enter(Child)
  const childB = await rootB.enter(Child)

  assert.equal((await childA.deps.child.load()).id, 'service')
  assert.equal((await childB.deps.child.load()).id, 'service')
  assert.equal((await rootA.deps.alpha.load()).id, 'service')
  assert.equal((await rootB.deps.beta.load()).id, 'service')

  await runtime.dispose()
})

test('equivalent sibling Entry invocations share templates without sharing Env-local slots', async () => {
  const define = defineFor('v04.cache-siblings')
  const Request = define.input('request')
  const Handler = define.service({
    requires: { request: Request },
    setup: ({ request }) => ({ request }),
  })
  const Root = define.entry('root', {})
  const RequestEntry = define.entry('request', {
    requires: { handler: Handler },
    parameters: { request: Request },
  })
  const runtime = createRuntime({ services: [Handler] })
  const root = await runtime.enter(Root)

  const first = await root.enter(RequestEntry, { request: 'first' })
  const second = await root.enter(RequestEntry, { request: 'second' })
  const firstHandler = await first.deps.handler.load()
  const secondHandler = await second.deps.handler.load()

  assert.notStrictEqual(firstHandler, secondHandler)
  assert.equal(firstHandler.request.read(), 'first')
  assert.equal(secondHandler.request.read(), 'second')
  assert.ok(runtime.inspect().planCache.hits >= 1)
  await runtime.dispose()
})

test('runtime disposal releases compiled plan templates', async () => {
  const define = defineFor('v04.cache-dispose')
  const Service = define.service({ setup: () => ({}) })
  const Entry = define.entry({ requires: { service: Service } })
  const runtime = createRuntime({ services: [Service] })
  const env = await runtime.enter(Entry)
  await env.dispose()
  assert.ok(runtime.inspect().planCache.entries > 0)
  await runtime.dispose()
  assert.equal(runtime.inspect().planCache.entries, 0)
})

test('check() reports ownership from explicit plan identity rather than Env id prefixes', async () => {
  const define = defineFor('v04.check-ownership')
  const Service = define.service({ setup: () => ({}) })
  const Entry = define.entry({ requires: { service: Service } })
  const runtime = createRuntime({ services: [Service] })
  const result = await runtime.check(Entry)
  assert.equal(result.ok, true)
  assert.equal(result.inspection.ownedSlotCount, 1)
  assert.equal(result.inspection.reusedSlotCount, 0)
  await runtime.dispose()
})

test('loadAll materializes a typed group concurrently and preserves keys', async () => {
  const define = defineFor('v04.load-all')
  let started = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const A = define.service('a', {
    async setup() {
      started += 1
      await gate
      return { id: 'a' }
    },
  })
  const B = define.service('b', {
    async setup() {
      started += 1
      await gate
      return { id: 'b' }
    },
  })
  const Entry = define.entry({ requires: { a: A, b: B } })
  const runtime = createRuntime({ services: [A, B] })
  const env = await runtime.enter(Entry)
  const loading = loadAll(env.deps)
  while (started < 2) await new Promise(resolve => setImmediate(resolve))
  assert.equal(started, 2)
  release()
  const loaded = await loading
  assert.deepEqual(Object.keys(loaded), ['a', 'b'])
  assert.equal(loaded.a.id, 'a')
  assert.equal(loaded.b.id, 'b')
  await runtime.dispose()
})

test('override chains preserve the original public identity and reject cycles', async () => {
  const define = defineFor('v04.override-chain')
  const Capability = define.contract()
  const A = define.service('a', { provides: [Capability], setup: () => ({ id: 'a' }) })
  const B = define.service('b', { setup: () => ({ id: 'b' }) })
  const C = define.service('c', { setup: () => ({ id: 'c' }) })
  const Entry = define.entry({ requires: { value: A, contract: Capability } })
  const runtime = createRuntime({
    services: [A],
    // Deliberately reverse the chain declaration order. Override resolution
    // must depend on the graph, not array order.
    overrides: [override(B, C), override(A, B)],
  })
  const env = await runtime.enter(Entry)
  assert.equal((await env.deps.value.load()).id, 'c')
  assert.equal((await env.deps.contract.load()).id, 'c')
  assert.deepEqual(runtime.inspect().admittedServices, [A.id])
  await runtime.dispose()

  assert.throws(
    () => createRuntime({ services: [A], overrides: [override(A, B), override(B, A)] }),
    /cycle/i,
  )
})

test('retry-on-next-load cooldown is exactly-once across concurrent callers', async () => {
  const define = defineFor('v04.recovery-cooldown')
  let attempts = 0
  const Recovering = define.service({
    failure: {
      attempts: 1,
      afterExhaustion: 'retry-on-next-load',
      cooldownMs: 20,
    },
    setup() {
      attempts += 1
      if (attempts === 1) throw new Error('first')
      return { attempts }
    },
  })
  const Entry = define.entry({ requires: { recovering: Recovering } })
  const runtime = createRuntime({ services: [Recovering] })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.recovering.load(), /first/)
  const started = performance.now()
  const values = await Promise.all(Array.from({ length: 20 }, () => env.deps.recovering.load()))
  assert.ok(performance.now() - started >= 15)
  assert.equal(attempts, 2)
  assert.ok(values.every(value => value === values[0]))
  await runtime.dispose()
})
