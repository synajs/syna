// 1.0.0-rc.4 / N5 — a wait is on the current attempt, and an attempt ends when its
// cleanup phase does, not when its raw setup Promise settles.
//
// The baseline (work/rc4/BASELINE.md §5) needed no close at all: on a perfectly
// healthy Env, a setup that failed at 10 ms with a cleanup that hung left every
// `load()` pending for ever — the deadlines were cleared the moment the raw
// Promise settled, `LOAD_TIMEOUT` never fired, no event was reported, and a second
// `load()` joined the same silence. `enter()` did the same for an eager slot.
//
// The three semantics of §2.3 that must not change are asserted here as well: no
// overlapping attempt while a rollback is unfinished, the retry rules of one
// sequence when a rollback succeeds, and the `AggregateError` + `ROLLBACK_FAILED`
// pair when a rollback fails.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage } from '../dist/index.js'

const makeDefine = id => definePackage({ name: `@rc4/${id.replaceAll('.', '-')}`, version: '1.0.0', syna: { id } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => { let resolve, reject; const promise = new Promise((settle, fail) => { resolve = settle; reject = fail }); return { promise, resolve, reject } }
const codeOf = promise => promise.then(() => 'resolved', error => error?.code ?? String(error))
const stateOf = env => env.inspect().nodes.filter(node => node.kind === 'service').map(node => node.state)

test('N5 lazy load(): a waiter on an attempt whose rollback hangs ends at its own deadline, and the cleanup keeps running', async () => {
  const define = makeDefine('rc4.n5.lazy')
  const events = []
  const hang = deferred()
  let cleanupStarted = 0
  const Service = define.service('s', {
    failure: { attempts: 1 },
    loadTimeoutMs: 40,
    setup(_deps, { onDispose }) {
      onDispose(() => { cleanupStarted += 1; return hang.promise })
      return sleep(5).then(() => { throw new Error('setup failed') })
    },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({ services: [Service], diagnostics: { onEvent: event => events.push(event.type) } })
  const env = await runtime.enter(Entry)

  const started = Date.now()
  const first = await codeOf(env.deps.s.load())
  const elapsed = Date.now() - started
  assert.equal(first, 'LOAD_TIMEOUT', 'the wait ends at the load timeout although the setup itself settled long ago')
  assert.ok(elapsed >= 35 && elapsed < 400, `and at that deadline, not at some other time (${elapsed} ms)`)
  assert.equal(cleanupStarted, 1, 'the cleanup was started')
  assert.deepEqual(stateOf(env), ['starting'], 'the slot is still on the unfinished attempt')
  assert.equal(env.state, 'ready', 'nothing about the Env changed: this is not a close')
  assert.deepEqual(events, [], 'a rollback that outruns a waiter is not an overdue setup: nothing is reported and nothing is listed')
  assert.equal(runtime.inspect().unsettledAttempts.length, 0)

  hang.resolve()
  await sleep(20)
  assert.equal(cleanupStarted, 1, 'and no second attempt was started behind the unfinished rollback')
  await runtime.dispose().catch(() => undefined)
})

test('N5 a waiter that joins after the raw setup has already failed gets a deadline of its own', async () => {
  const define = makeDefine('rc4.n5.joined')
  const hang = deferred()
  let setups = 0
  const Service = define.service('s', {
    failure: { attempts: 1 },
    loadTimeoutMs: 40,
    setup(_deps, { onDispose }) {
      setups += 1
      onDispose(() => hang.promise)
      return sleep(5).then(() => { throw new Error('setup failed') })
    },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({ services: [Service] })
  const env = await runtime.enter(Entry)
  void env.deps.s.load().catch(() => undefined)
  await sleep(60) // the first waiter has already timed out; the rollback is still running

  const started = Date.now()
  const joined = await codeOf(env.deps.s.load())
  const elapsed = Date.now() - started
  assert.equal(joined, 'LOAD_TIMEOUT', 'the wait that joined afterwards is bounded too')
  assert.ok(elapsed >= 35 && elapsed < 400, `by its own deadline, measured from its own start (${elapsed} ms)`)
  assert.equal(setups, 1, 'joining an unfinished rollback never starts an overlapping attempt')
  hang.resolve()
  await sleep(20)
  await runtime.dispose().catch(() => undefined)
})

test('N5 eager activation: enter() fails with ENTRY_ACTIVATION_FAILED within the load timeout plus the close, not never', async () => {
  const define = makeDefine('rc4.n5.eager')
  const events = []
  const hang = deferred()
  const Service = define.service('s', {
    eager: true,
    failure: { attempts: 1 },
    loadTimeoutMs: 40,
    setup(_deps, { onDispose }) {
      onDispose(() => hang.promise)
      return sleep(5).then(() => { throw new Error('eager setup failed') })
    },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({
    services: [Service],
    limits: { disposalGraceMs: 40 },
    diagnostics: { onEvent: event => events.push(event.type) },
  })
  const started = Date.now()
  const outcome = await runtime.enter(Entry).then(() => 'entered', error => error)
  const elapsed = Date.now() - started
  assert.equal(outcome.code, 'ENTRY_ACTIVATION_FAILED')
  assert.equal(outcome.cause?.code, 'LOAD_TIMEOUT', 'the activation is the waiter of the eager attempt (§11)')
  assert.ok(elapsed < 1_000, `and it settles (${elapsed} ms)`)
  assert.equal(runtime.inspect().liveEnvCount, 0, 'the half-started Env is closed')
  assert.ok(events.includes('attempt-abandoned'), 'the close abandons the unfinished rollback and says so')
  hang.resolve()
  await sleep(30)
  await runtime.dispose().catch(() => undefined)
})

test('N5 control: while the raw setup itself is pending, the deadline behaves exactly as it always did', async () => {
  const define = makeDefine('rc4.n5.control')
  const events = []
  const Service = define.service('s', {
    loadTimeoutMs: 30,
    setup(_deps, { onDispose }) { onDispose(() => undefined); return new Promise(() => undefined) },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({ services: [Service], diagnostics: { onEvent: event => events.push(event.type) } })
  const env = await runtime.enter(Entry)
  const outcome = await env.deps.s.load().then(() => 'resolved', error => error)
  assert.equal(outcome.code, 'LOAD_TIMEOUT')
  assert.equal(outcome.details.attemptStillRunning, true)
  assert.match(outcome.details.note, /while setup was still pending/)
  assert.deepEqual(events, ['attempt-overdue'], 'a pending setup is overdue and is reported once')
  assert.deepEqual(runtime.inspect().unsettledAttempts.map(entry => entry.state), ['overdue'])
  await runtime.dispose().catch(() => undefined)
})

test('N5 a wait ended during the rollback says so: the attempt is not overdue and nothing is listed for it', async () => {
  const define = makeDefine('rc4.n5.note')
  const hang = deferred()
  const Service = define.service('s', {
    failure: { attempts: 1 },
    loadTimeoutMs: 30,
    setup(_deps, { onDispose }) { onDispose(() => hang.promise); return Promise.reject(new Error('setup failed')) },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({ services: [Service] })
  const env = await runtime.enter(Entry)
  const outcome = await env.deps.s.load().then(() => 'resolved', error => error)
  assert.equal(outcome.code, 'LOAD_TIMEOUT')
  assert.match(outcome.details.note, /rollback of the failed setup was still running/)
  assert.equal(env.inspect().nodes.find(node => node.kind === 'service').overdueMs, undefined,
    'the setup did not outrun its deadline; its rollback did')
  hang.resolve()
  await sleep(20)
  await runtime.dispose().catch(() => undefined)
})

test('N5 unchanged semantics: a rollback that succeeds leaves the retry rules of the sequence exactly as they were', async () => {
  const define = makeDefine('rc4.n5.retry')
  const cleanups = []
  let setups = 0
  const Service = define.service('s', {
    failure: { attempts: 3, delayMs: 5 },
    loadTimeoutMs: 5_000,
    setup(_deps, { onDispose }) {
      const attempt = (setups += 1)
      onDispose(async () => { await sleep(5); cleanups.push(attempt) })
      if (attempt < 3) return Promise.reject(new Error(`attempt ${attempt} failed`))
      return { attempt }
    },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({ services: [Service] })
  const env = await runtime.enter(Entry)
  assert.deepEqual(await env.deps.s.load(), { attempt: 3 }, 'the third attempt of the same sequence succeeds')
  assert.deepEqual(cleanups, [1, 2], 'each failed attempt rolled back before the next one started')
  assert.equal(setups, 3)
  await runtime.dispose()
})

test('N5 unchanged semantics: a rollback that fails is still an AggregateError of setup and cleanup, and the slot is final with ROLLBACK_FAILED', async () => {
  const define = makeDefine('rc4.n5.rollback-failed')
  let setups = 0
  const Service = define.service('s', {
    failure: { attempts: 2, delayMs: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 1 },
    setup(_deps, { onDispose }) {
      setups += 1
      onDispose(() => { throw new Error('rollback failed') })
      return Promise.reject(new Error('setup failed'))
    },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({ services: [Service] })
  const env = await runtime.enter(Entry)
  const failure = await env.deps.s.load().then(() => undefined, error => error)
  assert.ok(failure instanceof AggregateError, 'setup and rollback are reported together')
  assert.deepEqual(failure.errors.map(error => error.message), ['setup failed', 'rollback failed'])
  assert.equal(failure.cause?.message, 'setup failed')
  assert.equal(setups, 1, 'a failed rollback ends the sequence: no second attempt on top of leaked resources')
  const again = await env.deps.s.load().then(() => 'resolved', error => error)
  assert.equal(again.code, 'ROLLBACK_FAILED')
  assert.equal(again.cause?.errors?.length, 2)
  assert.equal(setups, 1)
  await runtime.dispose()
})

test('N5 unchanged semantics: a waiter may leave while the rollback is unfinished, and no overlapping attempt starts behind it', async () => {
  const define = makeDefine('rc4.n5.no-overlap')
  const hang = deferred()
  let setups = 0
  const Service = define.service('s', {
    failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 1 },
    loadTimeoutMs: 5_000,
    setup(_deps, { onDispose }) { setups += 1; onDispose(() => hang.promise); return Promise.reject(new Error('setup failed')) },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({ services: [Service] })
  const env = await runtime.enter(Entry)
  const controller = new AbortController()
  const leaving = codeOf(env.deps.s.load({ signal: controller.signal }))
  await sleep(10)
  controller.abort()
  assert.equal(await leaving, 'LOAD_CANCELLED', 'the caller left its wait')
  for (let round = 0; round < 5; round += 1) {
    void env.deps.s.load({ signal: AbortSignal.abort() }).catch(() => undefined)
    await sleep(2)
  }
  assert.equal(setups, 1, 'the unfinished rollback blocks every new attempt')
  assert.deepEqual(stateOf(env), ['starting'])
  hang.resolve()
  await sleep(20)
  await runtime.dispose().catch(() => undefined)
})
