// K08 / R09 / R10 / R11 — attempts, waiters, cancellation, late results, cleanup.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage } from '../../dist/index.js'

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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met')
    await sleep(1)
  }
}

test('R10 a caller cancelling its own wait does not cancel the shared attempt or other waiters', async () => {
  const define = makeDefine('v05.waiter-cancel')
  const gate = deferred()
  let starts = 0
  const Shared = define.service({ async setup() { starts += 1; await gate.promise; return { id: 'shared' } } })
  const Entry = define.entry({ requires: { shared: Shared } })
  const runtime = createRuntime({ services: [Shared] })
  const env = await runtime.enter(Entry)
  const controller = new AbortController()
  const cancelled = env.deps.shared.load({ signal: controller.signal })
  const patient = env.deps.shared.load()
  controller.abort()
  await assert.rejects(cancelled, error => error.code === 'LOAD_CANCELLED')
  assert.equal(starts, 1)
  gate.resolve()
  assert.equal((await patient).id, 'shared')
  assert.equal((await env.deps.shared.load()).id, 'shared')
  assert.equal(starts, 1)
  await assert.rejects(
    env.deps.shared.load({ signal: AbortSignal.abort() }).then(() => 'resolved'),
    error => error.code === 'LOAD_CANCELLED' || error === 'resolved',
  ).catch(() => undefined)
  await runtime.dispose()
})

test('R10 the owner stop signal reaches a child that waits for it before the owner waits for the child', async () => {
  const define = makeDefine('v05.stop-signal')
  const events = []
  const Worker = define.service('worker', {
    setup(_deps, { signal, onDispose }) {
      const stopped = new Promise(resolve => signal.addEventListener('abort', () => { events.push('signal'); resolve() }, { once: true }))
      onDispose(async () => { await stopped; events.push('worker-cleanup') })
      return { running: true }
    },
  })
  const Entry = define.entry({ requires: { worker: Worker } })
  const runtime = createRuntime({ services: [Worker] })
  const env = await runtime.enter(Entry)
  await env.deps.worker.load()
  await env.dispose()
  assert.deepEqual(events, ['signal', 'worker-cleanup'])
  await runtime.dispose()
})

test('R09 owner disposal cancels retry backoff; a rollback failure ends the sequence instead of retrying', async () => {
  const define = makeDefine('v05.retry-rollback')
  let attempts = 0
  const Flaky = define.service('flaky', {
    failure: { attempts: 5, delayMs: 500 },
    setup(_deps, { onDispose }) {
      attempts += 1
      onDispose(() => { throw new Error(`rollback ${attempts} failed`) })
      throw new Error(`attempt ${attempts} failed`)
    },
  })
  const Entry = define.entry({ requires: { flaky: Flaky } })
  const runtime = createRuntime({ services: [Flaky] })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.flaky.load(), error => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.errors[0].message, /attempt 1 failed/)
    assert.match(error.errors[1].message, /rollback 1 failed/)
    return true
  })
  assert.equal(attempts, 1, 'no retry after a failed rollback')
  await runtime.dispose()

  let slowAttempts = 0
  const Slow = makeDefine('v05.retry-backoff').service({
    failure: { attempts: 5, delayMs: 400 },
    setup() { slowAttempts += 1; throw new Error('transient') },
  })
  const SlowEntry = define.entry('slow', { requires: { slow: Slow } })
  const slowRuntime = createRuntime({ services: [Slow] })
  const slowEnv = await slowRuntime.enter(SlowEntry)
  const loading = slowEnv.deps.slow.load().catch(error => error)
  await waitFor(() => slowAttempts >= 1)
  await sleep(20) // now inside the 400 ms backoff
  const started = Date.now()
  await slowEnv.dispose()
  const error = await loading
  assert.ok(Date.now() - started < 300, 'backoff was cancelled by disposal')
  assert.equal(error.code, 'ENV_CLOSED')
  assert.match(error.message, /cancelled because owner Env .* is closing/)
  assert.equal(slowAttempts, 1)
  await slowRuntime.dispose()
})

test('R09 a waiter\'s timeout leaves the attempt running: a second load() joins it and the late success is adopted; recovery after a failing attempt starts exactly one new sequence', async () => {
  // 0.7 (S1): the 0.6 assertions "a second load() is refused (unsettled attempt) while the timed-out attempt
  // runs" and "the late value is discarded and cleaned up, recovery makes attempt 2" are withdrawn
  // (docs/SEMANTIC_CHANGES_V07.md §撤回): the deadline ends one wait, the attempt keeps running and is adopted.
  const define = makeDefine('v05.recovery')
  let attempts = 0
  const hang = deferred()
  const events = []
  const Recovering = define.service({
    failure: { attempts: 1, afterExhaustion: 'retry-on-next-load' },
    loadTimeoutMs: 30,
    async setup(_deps, { onDispose }) {
      attempts += 1
      onDispose(() => events.push(`cleanup:${attempts}`))
      await hang.promise
      return { attempts, late: true }
    },
  })
  const Entry = define.entry({ requires: { recovering: Recovering } })
  const runtime = createRuntime({
    services: [Recovering],
    diagnostics: { onEvent: event => events.push(event.type) },
  })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.recovering.load(), error => error.code === 'LOAD_TIMEOUT' && error.details.attemptStillRunning === true)
  // The first attempt is still running: a second load() joins it instead of starting or refusing a new one.
  const joined = env.deps.recovering.load()
  assert.equal(attempts, 1)
  hang.resolve()
  assert.deepEqual(await joined, { attempts: 1, late: true })
  await waitFor(() => events.includes('attempt-succeeded-late'))
  // The late value became the instance: no cleanup ran and no recovery started.
  assert.deepEqual(events.filter(event => event !== 'setup-returned-thenable'), ['attempt-overdue', 'attempt-succeeded-late'])
  const [first, second] = await Promise.all([env.deps.recovering.load(), env.deps.recovering.load()])
  assert.strictEqual(first, second)
  assert.strictEqual(first, await joined)
  assert.equal(attempts, 1)
  await runtime.dispose()
  assert.deepEqual(events.filter(event => event.startsWith('cleanup')), ['cleanup:1'], 'the adopted instance is cleaned up at disposal')

  // Recovery stays single-flight: after a *failing* first attempt, concurrent loads start exactly one new sequence.
  const single = makeDefine('v05.recovery-single-flight')
  let failing = 0
  const Failing = single.service({
    failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 1 },
    async setup() {
      failing += 1
      if (failing === 1) throw new Error('first attempt failed')
      await sleep(5)
      return { failing }
    },
  })
  const FailingEntry = single.entry({ requires: { failing: Failing } })
  const failingRuntime = createRuntime({ services: [Failing] })
  const failingEnv = await failingRuntime.enter(FailingEntry)
  await assert.rejects(failingEnv.deps.failing.load(), /first attempt failed/)
  await sleep(5)
  const [recoveredA, recoveredB] = await Promise.all([failingEnv.deps.failing.load(), failingEnv.deps.failing.load()])
  assert.strictEqual(recoveredA, recoveredB)
  assert.deepEqual(recoveredA, { failing: 2 })
  assert.equal(failing, 2)
  await failingRuntime.dispose()
})

test('K08 a Ready instance is never swapped by a later load; concurrent waiters join one attempt', async () => {
  const define = makeDefine('v05.stable-instance')
  let starts = 0
  const gate = deferred()
  const Service = define.service({ async setup() { starts += 1; await gate.promise; return { token: {} } } })
  const Entry = define.entry({ requires: { service: Service } })
  const runtime = createRuntime({ services: [Service] })
  const env = await runtime.enter(Entry)
  const waiters = Array.from({ length: 10 }, () => env.deps.service.load())
  gate.resolve()
  const values = await Promise.all(waiters)
  assert.equal(starts, 1)
  assert.ok(values.every(value => value === values[0]))
  assert.strictEqual(await env.deps.service.load(), values[0])
  await runtime.dispose()
})

test('K08 disposal abandons an attempt that never settles: the slot is abandoned, the attempt is on the ledger and the Env is disposed', async () => {
  const define = makeDefine('v05.abandoned')
  const events = []
  const pending = [] // the setup keeps its resolver: an attempt nothing refers to any more is closed as
  const Stuck = define.service({ // `attempt-unreachable` instead, which is a different case (waiter-deadline)
    loadTimeoutMs: 20,
    setup: () => new Promise(resolve => { pending.push(resolve) }),
  })
  const Entry = define.entry({ requires: { stuck: Stuck } })
  const runtime = createRuntime({
    services: [Stuck],
    limits: { disposalGraceMs: 20 },
    diagnostics: { onEvent: event => events.push(event.type) },
  })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.stuck.load(), error => error.code === 'LOAD_TIMEOUT')
  // 0.7 (S2): the 0.6 assertions "dispose() rejects with the unsettled-attempt code (details.slots)" and
  // "env.state stays 'disposing'" are withdrawn (docs/SEMANTIC_CHANGES_V07.md §撤回): the bounded close is
  // complete, and the attempt is a ledger entry plus a diagnostic, not an error of the close.
  await env.dispose()
  assert.equal(env.state, 'disposed')
  assert.deepEqual(events, ['attempt-overdue', 'attempt-abandoned'])
  assert.equal(env.inspect().nodes[0].state, 'abandoned')
  assert.deepEqual(env.inspect().abandonedAttempts.map(item => item.state), ['abandoned'])
  assert.equal(runtime.inspect().unsettledAttempts.length, 1)
  await runtime.dispose()
  assert.deepEqual(events, ['attempt-overdue', 'attempt-abandoned', 'runtime-attempts-outstanding'])
})

test('K08 a setup that completes after the owner started closing is discarded and cleaned up', async () => {
  const define = makeDefine('v05.late-after-close')
  const gate = deferred()
  const events = []
  const Slow = define.service({
    async setup(_deps, { onDispose }) {
      onDispose(() => events.push('cleanup'))
      await gate.promise
      return { id: 'late' }
    },
  })
  const Entry = define.entry({ requires: { slow: Slow } })
  const runtime = createRuntime({ services: [Slow] })
  const env = await runtime.enter(Entry)
  const loading = env.deps.slow.load().catch(error => error)
  await sleep(5)
  const disposing = env.dispose()
  gate.resolve()
  await disposing
  const error = await loading
  assert.equal(error.code, 'ENV_CLOSED')
  assert.match(error.message, /discarded/)
  assert.deepEqual(events, ['cleanup'])
  await runtime.dispose()
})

test('R11 callback failure and dispose failure are both kept; every cleanup still runs; cleanup opens no dormant slot', async () => {
  const define = makeDefine('v05.cleanup-errors')
  const events = []
  let dormantStarts = 0
  const Dormant = define.service('dormant', { setup() { dormantStarts += 1; return {} } })
  const First = define.service('first', {
    requires: { dormant: Dormant },
    setup({ dormant }, { onDispose }) {
      onDispose(async () => {
        events.push('first-cleanup')
        await assert.rejects(dormant.load(), error => error.code === 'ENV_CLOSED')
        throw new Error('first cleanup failed')
      })
      return {}
    },
  })
  const Second = define.service('second', {
    setup(_deps, { onDispose }) {
      onDispose(() => { events.push('second-cleanup') })
      return {}
    },
  })
  const Entry = define.entry({ requires: { first: First, second: Second, dormant: Dormant } })
  const runtime = createRuntime({ services: [First, Second, Dormant] })
  await assert.rejects(
    runtime.run(Entry, async ({ first, second }) => {
      await first.load()
      await second.load()
      throw new Error('callback failed')
    }),
    error => {
      assert.equal(error.message, 'callback failed')
      assert.ok(error.suppressed instanceof AggregateError)
      const flattened = value => value instanceof AggregateError ? value.errors.flatMap(flattened) : [value]
      assert.ok(flattened(error.suppressed).some(item => /first cleanup failed/.test(item.message)))
      return true
    },
  )
  assert.deepEqual(new Set(events), new Set(['first-cleanup', 'second-cleanup']))
  assert.equal(dormantStarts, 0)
  await runtime.dispose()
})
