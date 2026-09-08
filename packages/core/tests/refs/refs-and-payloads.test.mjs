// K07 / R02 / R03 / R04 / R05 — plain Promises, no hidden barrier.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage, forward, loadAll } from '../../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@v05/${id.replaceAll('.', '-')}`,
  version,
  syna: { id },
})

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('R05 Input.read() preserves payload identity for Promise, thenable, function and undefined payloads', async () => {
  const define = makeDefine('v05.input-identity')
  const Payload = define.input('payload')
  const Reader = define.service('reader', {
    requires: { payload: Payload },
    setup: ({ payload }) => ({ read: () => payload.read() }),
  })
  const Entry = define.entry({ requires: { reader: Reader }, parameters: { payload: Payload } })
  const runtime = createRuntime({ services: [Reader] })

  const promisePayload = Promise.resolve('inner')
  const thenable = { then: onFulfilled => onFulfilled('assimilated') }
  const fn = () => 'called'
  for (const payload of [promisePayload, thenable, fn, undefined, null, 0, '']) {
    const env = await runtime.enter(Entry, { payload })
    const reader = await env.deps.reader.load()
    assert.strictEqual(reader.read(), payload)
    assert.strictEqual(env.deps.reader.load === undefined, false)
    await env.dispose()
  }
  // The deprecated load() form awaits the payload: identity is NOT preserved there.
  const env = await runtime.enter(Entry, { payload: thenable })
  // Presence is distinct from undefined: omitting the parameter is MISSING_INPUT.
  await assert.rejects(runtime.enter(Entry, {}), error => error.code === 'MISSING_INPUT')
  await runtime.dispose()
})

test('R05 ServiceRef is not thenable: Promise.resolve(ref) yields the ref and starts nothing', async () => {
  const define = makeDefine('v05.ref-not-thenable')
  let starts = 0
  const Service = define.service({ setup() { starts += 1; return { ok: true } } })
  const Entry = define.entry({ requires: { service: Service } })
  const runtime = createRuntime({ services: [Service] })
  const env = await runtime.enter(Entry)
  const ref = env.deps.service
  assert.equal('then' in ref, false)
  const resolved = await Promise.resolve(ref)
  assert.strictEqual(resolved, ref)
  await tick()
  assert.equal(starts, 0)
  await Promise.all([ref, ref])
  assert.equal(starts, 0)
  assert.equal((await ref.load()).ok, true)
  assert.equal(starts, 1)
  await runtime.dispose()
})

test('K07 an un-awaited load() inside setup is a background operation, not a barrier', async () => {
  const define = makeDefine('v05.no-barrier')
  const gate = deferred()
  let slowStarted = 0
  const Slow = define.service('slow', { async setup() { slowStarted += 1; await gate.promise; return { slow: true } } })
  const Caller = define.service('caller', {
    requires: { slow: Slow },
    setup({ slow }) {
      void slow.load().catch(() => undefined)
      return { ready: true, slow }
    },
  })
  const Entry = define.entry({ requires: { caller: Caller } })
  const runtime = createRuntime({ services: [Caller] })
  const env = await runtime.enter(Entry)
  const caller = await env.deps.caller.load()
  assert.equal(caller.ready, true)
  assert.equal(slowStarted, 1, 'the background load started the real slot')
  gate.resolve()
  assert.equal((await caller.slow.load()).slow, true)
  await runtime.dispose()
})

test('R02 catching a lazy backend failure yields a degraded Ready consumer; an eager backend fails the Env instead', async () => {
  const define = makeDefine('v05.degraded')
  const Backend = define.service('backend', { setup() { throw new Error('backend down') } })
  const Consumer = define.service('consumer', {
    requires: { backend: Backend },
    async setup({ backend }) {
      try {
        await backend.load()
        return { mode: 'full' }
      }
      catch (error) {
        return { mode: 'degraded', reason: error.message }
      }
    },
  })
  const Entry = define.entry({ requires: { consumer: Consumer, backend: Backend } })
  const runtime = createRuntime({ services: [Consumer, Backend] })
  const env = await runtime.enter(Entry)
  const consumer = await env.deps.consumer.load()
  assert.deepEqual(consumer, { mode: 'degraded', reason: 'backend down' })
  // The backend slot keeps its own sticky failure; the consumer is not poisoned.
  await assert.rejects(env.deps.backend.load(), /backend down/)
  assert.strictEqual(await env.deps.consumer.load(), consumer)
  await runtime.dispose()

  const EagerBackend = makeDefine('v05.degraded-eager-backend').service({
    eager: true,
    setup() { throw new Error('eager backend down') },
  })
  const EagerConsumer = makeDefine('v05.degraded-eager-consumer').service({
    requires: { backend: EagerBackend },
    async setup({ backend }) {
      try { await backend.load(); return { mode: 'full' } }
      catch { return { mode: 'degraded' } }
    },
  })
  const EagerEntry = define.entry('eager', { requires: { consumer: EagerConsumer } })
  const eagerRuntime = createRuntime({ services: [EagerConsumer, EagerBackend] })
  await assert.rejects(
    eagerRuntime.enter(EagerEntry),
    error => error.code === 'ENTRY_ACTIVATION_FAILED' && /eager backend down/.test(error.cause?.message ?? ''),
  )
  assert.equal(eagerRuntime.inspect().rootEnvCount, 0)
  await eagerRuntime.dispose()
})

test('R03 a Ready Helper running its own background load with its own catch does not add obligations to the Caller', async () => {
  const define = makeDefine('v05.helper-background')
  const gate = deferred()
  const Flaky = define.service('flaky', { async setup() { await gate.promise; throw new Error('flaky failed later') } })
  const Helper = define.service('helper', {
    requires: { flaky: Flaky },
    setup({ flaky }) {
      const observed = []
      return {
        warm() { void flaky.load().catch(error => observed.push(error.message)) },
        observed,
      }
    },
  })
  const Caller = define.service('caller', {
    requires: { helper: Helper },
    async setup({ helper }) {
      const h = await helper.load()
      h.warm()
      return { id: 'caller', helper: h }
    },
  })
  const Entry = define.entry({ requires: { caller: Caller } })
  const runtime = createRuntime({ services: [Caller] })
  const env = await runtime.enter(Entry)
  const caller = await env.deps.caller.load()
  assert.equal(caller.id, 'caller')
  gate.resolve()
  await sleep(5)
  assert.deepEqual(caller.helper.observed, ['flaky failed later'])
  assert.strictEqual(await env.deps.caller.load(), caller)
  await runtime.dispose()
})

test('R04 structural A<->B is legal; runtime mutual calls work; Promise.race fallback and legal prefetch are not misreported', async () => {
  const define = makeDefine('v05.race')
  let A
  let B
  A = define.service('a', {
    requires: { b: forward(() => B) },
    setup: ({ b }) => ({ name: 'a', callB: async () => (await b.load()).name }),
  })
  B = define.service('b', {
    requires: { a: forward(() => A) },
    setup: ({ a }) => ({ name: 'b', callA: async () => (await a.load()).name }),
  })
  const gate = deferred()
  const Slow = define.service('slow', { async setup() { await gate.promise; throw new Error('slow eventually failed') } })
  const Racer = define.service('racer', {
    requires: { slow: Slow, a: A },
    async setup({ slow, a }) {
      // Legal prefetch of a structural-cycle member plus a race with a timeout fallback.
      void a.load()
      const winner = await Promise.race([
        slow.load().then(() => 'slow'),
        sleep(5).then(() => 'fallback'),
      ])
      return { winner }
    },
  })
  const Entry = define.entry({ requires: { a: A, b: B, racer: Racer } })
  const runtime = createRuntime({ services: [A, B, Racer, Slow], limits: { loadTimeoutMs: 2000 } })
  const env = await runtime.enter(Entry)
  assert.equal(await (await env.deps.a.load()).callB(), 'b')
  assert.equal(await (await env.deps.b.load()).callA(), 'a')
  const racer = await env.deps.racer.load()
  assert.equal(racer.winner, 'fallback')
  gate.resolve()
  await sleep(5)
  // The late rejection of the raced load does not poison the Ready racer.
  assert.strictEqual(await env.deps.racer.load(), racer)
  await runtime.dispose()
})

test('R04 a genuinely pending wait cycle is reported by the initialization deadline with the observed load() cycle', async () => {
  const define = makeDefine('v05.pending-cycle')
  let X
  let Y
  X = define.service('x', { requires: { y: forward(() => Y) }, async setup({ y }) { await y.load(); return {} } })
  Y = define.service('y', { requires: { x: forward(() => X) }, async setup({ x }) { await x.load(); return {} } })
  const Entry = define.entry({ requires: { x: X } })
  const runtime = createRuntime({ services: [X, Y], limits: { loadTimeoutMs: 30 } })
  const env = await runtime.enter(Entry)
  const started = Date.now()
  await assert.rejects(env.deps.x.load(), error => {
    assert.equal(error.code, 'LOAD_TIMEOUT')
    assert.ok(Array.isArray(error.details.suspectedWaitCycle))
    assert.ok(error.details.pendingLoads.length >= 1)
    assert.match(error.message, /not a proof of deadlock/)
    return true
  })
  assert.ok(Date.now() - started < 1500, 'bounded by the deadline, not a hang')
  await runtime.dispose()
})

test('K07 loadAll is an ordinary catchable batch; planning errors and materialization failures stay distinct', async () => {
  const define = makeDefine('v05.load-all')
  const Good = define.service('good', { setup: () => ({ id: 'good' }) })
  const Bad = define.service('bad', { setup() { throw new Error('bad setup') } })
  const Needed = define.input('needed')
  const NeedsInput = define.service('needs-input', { requires: { needed: Needed }, setup: () => ({}) })
  const Entry = define.entry({ requires: { good: Good, bad: Bad } })
  const runtime = createRuntime({ services: [Good, Bad, NeedsInput] })
  const env = await runtime.enter(Entry)
  await assert.rejects(loadAll(env.deps), /bad setup/)
  const partial = await loadAll({ good: env.deps.good })
  assert.deepEqual(partial, { good: { id: 'good' } })
  // A planning error (missing Input) surfaces from enter/check, never as a slot failure.
  const Planning = define.entry('planning', { requires: { needs: NeedsInput } })
  await assert.rejects(runtime.enter(Planning), error => error.code === 'MISSING_INPUT')
  assert.equal((await runtime.check(Planning)).ok, false)
  await runtime.dispose()
})

test('K07 a foreign thenable returned by setup is awaited (JavaScript semantics) and diagnosed; instances are never thenable', async () => {
  const define = makeDefine('v05.thenable')
  const events = []
  const Foreign = define.service('foreign', {
    setup: () => ({ then: onFulfilled => onFulfilled({ assimilated: true }) }),
  })
  const Holder = define.service('holder', {
    setup: () => ({ client: { then: () => 'a thenable kept inside a plain holder' } }),
  })
  const Entry = define.entry({ requires: { foreign: Foreign, holder: Holder } })
  const runtime = createRuntime({ services: [Foreign, Holder], diagnostics: { onEvent: event => events.push(event.type) } })
  const env = await runtime.enter(Entry)
  assert.deepEqual(await env.deps.foreign.load(), { assimilated: true })
  assert.equal((await env.deps.holder.load()).client.then(), 'a thenable kept inside a plain holder')
  assert.deepEqual(events, ['setup-returned-thenable'])
  await runtime.dispose()
})
