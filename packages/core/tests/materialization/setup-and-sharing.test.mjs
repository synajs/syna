import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRuntime,
  definePackage,
  forward,
} from '../../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@test/${id.replaceAll('.', '-')}-${version}`,
  version,
  syna: { id },
})

// v0.5 (MIGRATION M-07): a genuine pending setup cycle is reported by the
// initialization deadline with the observed load() cycle.
test('structural cycles are legal after setup; pending setup wait cycles hit the initialization deadline', async () => {
  const define = makeDefine('test.lifecycle-cycle')
  let A
  let B
  A = define.service('a', {
    requires: { b: forward(() => B) },
    setup({ b }) { return { name: 'a', callB: async () => (await b.load()).name } },
  })
  B = define.service('b', {
    requires: { a: forward(() => A) },
    setup({ a }) { return { name: 'b', callA: async () => (await a.load()).name } },
  })
  const Entry = define.entry('good', { requires: { a: A, b: B } })
  const runtime = createRuntime({ services: [A, B] })
  const env = await runtime.enter(Entry)
  assert.equal(await (await env.deps.a.load()).callB(), 'b')
  assert.equal(await (await env.deps.b.load()).callA(), 'a')
  await env.dispose()

  let C
  let D
  C = define.service('c', {
    requires: { d: forward(() => D) },
    async setup({ d }) { await d.load(); return {} },
  })
  D = define.service('d', {
    requires: { c: forward(() => C) },
    async setup({ c }) { await c.load(); return {} },
  })
  const BadEntry = define.entry('bad', { requires: { c: C } })
  const badRuntime = createRuntime({ services: [C, D], limits: { loadTimeoutMs: 40 } })
  const badEnv = await badRuntime.enter(BadEntry)
  await assert.rejects(badEnv.deps.c.load(), error => {
    assert.equal(error.code, 'LOAD_TIMEOUT')
    // Whichever attempt's deadline fires first reports the cycle from its own slot.
    const cycle = error.details.suspectedWaitCycle
    assert.equal(cycle.length, 3)
    assert.equal(cycle[0], cycle[2])
    assert.deepEqual(new Set(cycle), new Set([C.id, D.id]))
    assert.match(error.message, /observation, not a proof/)
    return true
  })
  await badEnv.dispose()
})

test('concurrent requests for one dormant slot share exactly one setup', async () => {
  const define = makeDefine('test.concurrent-start')
  let starts = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const Service = define.service({
    async setup() {
      starts += 1
      await gate
      return { id: {} }
    },
  })
  const Entry = define.entry({ requires: { service: Service } })
  const runtime = createRuntime({ services: [Service] })
  const env = await runtime.enter(Entry)
  const first = env.deps.service.load()
  const second = env.deps.service.load()
  await Promise.resolve()
  assert.equal(starts, 1)
  release()
  assert.strictEqual(await first, await second)
  await env.dispose()
})

test('parallel eager setup has no ordering guarantee and can start concurrently', async () => {
  const define = makeDefine('test.eager-parallel')
  const events = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const A = define.service('a', {
    eager: true,
    async setup() { events.push('a-start'); await gate; events.push('a-end'); return {} },
  })
  const B = define.service('b', {
    eager: true,
    async setup() { events.push('b-start'); await gate; events.push('b-end'); return {} },
  })
  const Entry = define.entry({ requires: { a: A, b: B } })
  const runtime = createRuntime({ services: [A, B] })
  const entering = runtime.enter(Entry)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(new Set(events), new Set(['a-start', 'b-start']))
  release()
  const env = await entering
  assert.equal(events.includes('a-end'), true)
  assert.equal(events.includes('b-end'), true)
  await env.dispose()
})

test('dispose is dependant-before-dependency and reverse completion inside an SCC', async () => {
  const define = makeDefine('test.dispose-order')
  const events = []
  const B = define.service('b', {
    setup(_deps, { onDispose }) {
      onDispose(() => events.push('dispose-b'))
      return { id: 'b' }
    },
  })
  const A = define.service('a', {
    requires: { b: B },
    setup({ b }, { onDispose }) {
      onDispose(() => events.push('dispose-a'))
      return { useB: async () => await b.load() }
    },
  })
  const Entry = define.entry('linear', { requires: { a: A, b: B } })
  const runtime = createRuntime({ services: [A, B] })
  const env = await runtime.enter(Entry)
  const a = await env.deps.a.load()
  await a.useB()
  await env.dispose()
  assert.deepEqual(events, ['dispose-a', 'dispose-b'])

  const sccEvents = []
  let X
  let Y
  X = define.service('x', {
    requires: { y: forward(() => Y) },
    setup(_deps, { onDispose }) { onDispose(() => sccEvents.push('dispose-x')); return {} },
  })
  Y = define.service('y', {
    requires: { x: forward(() => X) },
    setup(_deps, { onDispose }) { onDispose(() => sccEvents.push('dispose-y')); return {} },
  })
  const SccEntry = define.entry('scc', { requires: { x: X, y: Y } })
  const sccRuntime = createRuntime({ services: [X, Y] })
  const sccEnv = await sccRuntime.enter(SccEntry)
  await sccEnv.deps.x.load()
  await sccEnv.deps.y.load()
  await sccEnv.dispose()
  assert.deepEqual(sccEvents, ['dispose-y', 'dispose-x'])
})

test('disposing a parent recursively disposes descendants before parent-owned slots', async () => {
  const define = makeDefine('test.parent-dispose')
  const events = []
  const Parent = define.service('parent', {
    setup(_deps, { onDispose }) { onDispose(() => events.push('parent')); return {} },
  })
  const Epoch = define.input('epoch')
  const Child = define.service('child', {
    requires: { epoch: Epoch },
    setup(_deps, { onDispose }) { onDispose(() => events.push('child')); return {} },
  })
  const Root = define.entry('root', { requires: { parent: Parent } })
  const ChildEntry = define.entry('child', {
    requires: { child: Child }, parameters: { epoch: Epoch },
  })
  const runtime = createRuntime({ services: [Parent, Child] })
  const root = await runtime.enter(Root)
  const child = await root.enter(ChildEntry, { epoch: 1 })
  await root.deps.parent.load()
  await child.deps.child.load()
  await root.dispose()
  assert.deepEqual(events, ['child', 'parent'])
  assert.equal(child.state, 'disposed')
})

test('failed setup is sticky for a canonical slot', async () => {
  const define = makeDefine('test.sticky-failure')
  let attempts = 0
  const Broken = define.service({
    setup() {
      attempts += 1
      throw new Error('broken once, broken for this slot')
    },
  })
  const Entry = define.entry({ requires: { broken: Broken } })
  const runtime = createRuntime({ services: [Broken] })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.broken.load(), /broken once/)
  await assert.rejects(env.deps.broken.load(), /broken once/)
  assert.equal(attempts, 1)
  await env.dispose()
})

test('failed eager activation rolls back newly started local services', async () => {
  const define = makeDefine('test.activation-rollback')
  const events = []
  const Good = define.service('good', {
    eager: true,
    setup(_deps, { onDispose }) {
      events.push('good-start')
      onDispose(() => events.push('good-dispose'))
      return {}
    },
  })
  const Bad = define.service('bad', {
    eager: true,
    setup() {
      events.push('bad-start')
      throw new Error('activation failed')
    },
  })
  const Entry = define.entry({ requires: { good: Good, bad: Bad } })
  const runtime = createRuntime({ services: [Good, Bad] })
  await assert.rejects(
    runtime.enter(Entry),
    error => error.code === 'ENTRY_ACTIVATION_FAILED'
      && error.cause instanceof Error
      && error.cause.message === 'activation failed',
  )
  assert.equal(events.includes('good-dispose'), true)
  assert.equal(runtime.inspect().rootEnvCount, 0)
})

test('a setup that waits for a collection member which waits back on it hits the initialization deadline', async () => {
  const define = makeDefine('test.collection-cycle')
  const Plugin = define.contract()
  let Manager
  let Candidate
  Manager = define.service('manager', {
    requires: { plugins: Plugin.all },
    async setup({ plugins }) {
      const implementations = await plugins.load()
      await implementations.load(implementations.candidates[0])
      return {}
    },
  })
  Candidate = define.service('candidate', {
    provides: [Plugin],
    requires: { manager: forward(() => Manager) },
    async setup({ manager }) { await manager.load(); return {} },
  })
  const Entry = define.entry({ requires: { manager: Manager } })
  const runtime = createRuntime({ services: [Manager, Candidate], limits: { loadTimeoutMs: 40 } })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.manager.load(), error => error.code === 'LOAD_TIMEOUT')
  await env.dispose()
})
