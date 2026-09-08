// v0.7 (Phase D, S1): the setup deadline is the waiter's timeout, not the attempt's. `loadTimeoutMs` bounds one
// `load()` wait on the current attempt (default 30_000, locked by v07-expired-forms); at expiry that wait rejects
// with LOAD_TIMEOUT (`attemptStillRunning: true`), the slot stays `starting`, `inspect()` shows
// `overdueMs`, the ledger lists the attempt as `overdue` and `attempt-overdue` is reported once per attempt.
// The attempt keeps running: a later success is adopted while the owner Env is `ready` (no cleanup runs,
// `attempt-succeeded-late` with `adopted: true`) and only a close discards it; a later failure follows the existing
// failure policy. A timeout consumes no attempt and triggers no backoff. `load({ signal })` with
// `AbortSignal.timeout()` is the documented shorter wait. The four counter-examples of the task book (§2.4) are
// cases 1–4; no case depends on `--expose-gc` except the ledger/event case at the end.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { createRuntime, definePackage } from '../../dist/index.js'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v07/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const waitFor = async (condition, timeoutMs = 2_000) => {
  const started = Date.now()
  while (!condition()) {
    assert.ok(Date.now() - started < timeoutMs, 'condition not met in time')
    await sleep(2)
  }
}
const rejection = async promise => {
  try { await promise }
  catch (error) { return error }
  assert.fail('expected a rejection')
}
const nodeOf = (env, revision) => env.inspect().nodes.find(node => node.nodeId === `service:${revision.id}`)
const child = (flags, script) =>
  run(process.execPath, [...flags, '--input-type=module', '-e', script])
    .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))

/** A Service whose setup succeeds after `resolveAfterMs` under a `deadlineMs` waiter deadline. */
const slowWorld = (id, { deadlineMs = 100, resolveAfterMs = 250, eager = false, failure, limits } = {}) => {
  const define = makeDefine(id)
  const log = []
  const events = []
  let setups = 0
  const Slow = define.service('slow', {
    loadTimeoutMs: deadlineMs,
    ...(eager ? { eager: true } : {}),
    ...(failure ? { failure } : {}),
    async setup(_deps, { onDispose }) {
      setups += 1
      onDispose(() => log.push('cleanup'))
      await sleep(resolveAfterMs)
      return { id: 'slow', setups }
    },
  })
  const Entry = define.entry('entry', { requires: { slow: Slow } })
  const runtime = createRuntime({
    services: [Slow],
    ...(limits ? { limits } : {}),
    diagnostics: { onEvent: event => events.push(event) },
  })
  return { define, Slow, Entry, runtime, log, events, setups: () => setups }
}

test('1. a 250 ms success under a 100 ms deadline: the first load() times out, a load() at 300 ms gets the instance, onDispose did not run, the slot is ready', async () => {
  const { runtime, Entry, Slow, events, log, setups } = slowWorld('s1-adopted')
  const env = await runtime.enter(Entry)
  const started = Date.now()
  const error = await rejection(env.deps.slow.load())
  const elapsed = Date.now() - started
  assert.equal(error.code, 'LOAD_TIMEOUT')
  assert.ok(elapsed >= 95 && elapsed < 240, `the wait ended at the deadline, not at the attempt's end (${elapsed} ms)`)
  const node = nodeOf(env, Slow)
  assert.deepEqual(error.details, {
    slot: node.slotId,
    revision: Slow.id,
    env: env.id,
    attemptNumber: error.details.attemptNumber,
    deadlineMs: 100,
    elapsedMs: error.details.elapsedMs,
    pendingLoads: [],
    attemptStillRunning: true,
    note: error.details.note,
  })
  assert.equal(typeof error.details.attemptNumber, 'number')
  assert.ok(error.details.elapsedMs >= 95, 'elapsedMs is the attempt\'s running time')
  assert.match(error.details.note, /The attempt keeps running; its result is adopted if the owner Env is still ready, and discarded only if the owner closes/)
  assert.equal(error.message, `Setup of ${Slow.id} did not complete within 100 ms.`)
  // The slot stays starting and is overdue; the attempt is listed as timed-out; one event so far.
  assert.equal(node.state, 'starting')
  assert.equal(typeof node.overdueMs, 'number')
  assert.ok(node.overdueMs >= 0 && node.overdueMs < 100)
  assert.deepEqual(events, [{
    type: 'attempt-overdue',
    slot: node.slotId,
    revision: Slow.id,
    env: env.id,
    attemptNumber: error.details.attemptNumber,
    deadlineMs: 100,
    elapsedMs: events[0].elapsedMs,
  }])
  assert.ok(events[0].elapsedMs >= 95)
  assert.deepEqual(
    runtime.inspect().unsettledAttempts.map(item => [item.attemptNumber, item.slot, item.revision, item.env, item.state]),
    [[error.details.attemptNumber, node.slotId, Slow.id, env.id, 'overdue']],
  )
  assert.equal(env.state, 'ready')

  await sleep(200) // t ≈ 300 ms: the attempt succeeded at 250 ms under a ready owner
  const instance = await env.deps.slow.load()
  assert.deepEqual(instance, { id: 'slow', setups: 1 })
  assert.deepEqual(log, [], 'onDispose was not executed: the late success was adopted, not discarded')
  const ready = nodeOf(env, Slow)
  assert.equal(ready.state, 'ready')
  assert.equal('overdueMs' in ready, false, 'overdueMs is gone once the slot is ready')
  assert.deepEqual(events.map(event => event.type), ['attempt-overdue', 'attempt-succeeded-late'])
  assert.deepEqual(events[1], { type: 'attempt-succeeded-late', slot: node.slotId, revision: Slow.id, env: env.id, adopted: true, cleanupErrors: [] })
  assert.deepEqual(runtime.inspect().unsettledAttempts, [], 'adoption removes the attempt from the ledger')
  assert.equal(setups(), 1, 'one setup() call: the timeout started nothing')
  assert.strictEqual(await env.deps.slow.load(), instance)
  await runtime.dispose()
  assert.deepEqual(log, ['cleanup'], 'the adopted instance is released by disposal like any other')
})

test('2. the same setup with the owner disposed at 150 ms: the result is discarded and the cleanup runs (adopted: false) — after the grace and inside it', async () => {
  // (a) A 20 ms grace: the attempt is abandoned at ~170 ms and its late result discarded at 250 ms.
  {
    const { runtime, Entry, Slow, events, log } = slowWorld('s1-discarded-late', { limits: { disposalGraceMs: 20 } })
    const env = await runtime.enter(Entry)
    const error = await rejection(env.deps.slow.load())
    assert.equal(error.code, 'LOAD_TIMEOUT')
    const node = nodeOf(env, Slow)
    await sleep(50) // t ≈ 150 ms
    await env.dispose() // S2: the close fulfils; the overdue attempt is abandoned onto the ledger
    assert.equal(nodeOf(env, Slow).state, 'abandoned')
    assert.deepEqual(runtime.inspect().unsettledAttempts.map(item => item.state), ['abandoned'])
    await waitFor(() => events.some(event => event.type === 'attempt-succeeded-late'))
    assert.deepEqual(events.map(event => event.type), ['attempt-overdue', 'attempt-abandoned', 'attempt-succeeded-late'])
    assert.deepEqual(events.at(-1), { type: 'attempt-succeeded-late', slot: node.slotId, revision: Slow.id, env: env.id, adopted: false, cleanupErrors: [] })
    assert.deepEqual(log, ['cleanup'], 'only a close discards a late success, and then its cleanup runs')
    assert.equal(nodeOf(env, Slow).state, 'disposed')
    assert.deepEqual(runtime.inspect().unsettledAttempts, [])
    await runtime.dispose()
  }
  // (b) The default grace: the close waits for the attempt, which settles inside the grace and is discarded there.
  {
    const { runtime, Entry, Slow, events, log } = slowWorld('s1-discarded-in-grace')
    const env = await runtime.enter(Entry)
    await assert.rejects(env.deps.slow.load(), error => error.code === 'LOAD_TIMEOUT')
    const node = nodeOf(env, Slow)
    await sleep(50)
    const closedAt = Date.now()
    await env.dispose()
    assert.ok(Date.now() - closedAt >= 80 && Date.now() - closedAt < 1_000, 'the close waited for the attempt inside the grace')
    assert.deepEqual(events.map(event => event.type), ['attempt-overdue', 'attempt-succeeded-late'])
    assert.deepEqual(events.at(-1), { type: 'attempt-succeeded-late', slot: node.slotId, revision: Slow.id, env: env.id, adopted: false, cleanupErrors: [] })
    assert.deepEqual(log, ['cleanup'])
    assert.equal(nodeOf(env, Slow).state, 'disposed')
    assert.equal(env.state, 'disposed')
    assert.deepEqual(runtime.inspect().unsettledAttempts, [])
    await runtime.dispose()
  }
})

test('3. two waiters time out one after the other (the second joins at 50 ms), then the attempt succeeds: both got LOAD_TIMEOUT, a third load() gets the instance, nothing stale remains', async () => {
  const { runtime, Entry, Slow, events, log, setups } = slowWorld('s1-two-waiters')
  const env = await runtime.enter(Entry)
  const first = rejection(env.deps.slow.load())
  await sleep(50)
  const second = rejection(env.deps.slow.load())
  const firstError = await first
  const firstAt = Date.now()
  const secondError = await second
  const secondAt = Date.now()
  assert.equal(firstError.code, 'LOAD_TIMEOUT')
  assert.equal(secondError.code, 'LOAD_TIMEOUT')
  assert.ok(secondAt - firstAt >= 40, `each waiter has its own window (${secondAt - firstAt} ms apart)`)
  assert.equal(firstError.details.attemptNumber, secondError.details.attemptNumber, 'both waited on the same attempt')
  assert.ok(secondError.details.elapsedMs > firstError.details.elapsedMs)
  assert.equal(firstError.details.attemptStillRunning, true)
  assert.equal(secondError.details.attemptStillRunning, true)
  assert.deepEqual(events.map(event => event.type), ['attempt-overdue'], 'once per attempt, not once per waiter')
  assert.equal(nodeOf(env, Slow).state, 'starting')
  assert.equal(setups(), 1)

  const third = await env.deps.slow.load() // joins at ~150 ms; the attempt succeeds at 250 ms
  assert.deepEqual(third, { id: 'slow', setups: 1 })
  assert.deepEqual(events.map(event => event.type), ['attempt-overdue', 'attempt-succeeded-late'])
  assert.equal(events[1].adopted, true)
  // No waiter holds stale state: the ready slot answers at once, the ledger and the overdue mark are gone.
  const started = Date.now()
  assert.strictEqual(await env.deps.slow.load(), third)
  assert.ok(Date.now() - started < 50)
  assert.deepEqual(runtime.inspect().unsettledAttempts, [])
  assert.equal('overdueMs' in nodeOf(env, Slow), false)
  assert.equal(nodeOf(env, Slow).state, 'ready')
  assert.deepEqual(log, [])
  assert.equal(setups(), 1)
  await runtime.dispose()
  assert.deepEqual(log, ['cleanup'])
})

test('4. eager: an eager slot that succeeds after the deadline fails the activation (ENTRY_ACTIVATION_FAILED, cause LOAD_TIMEOUT) and the rollback close discards the late success', async () => {
  const { runtime, Entry, Slow, events, log, setups } = slowWorld('s1-eager', { eager: true, limits: { disposalGraceMs: 20 } })
  const started = Date.now()
  const error = await rejection(runtime.enter(Entry))
  assert.ok(Date.now() - started < 240, 'enter() rejected at the deadline plus the rollback grace, before the attempt ended')
  assert.equal(error.code, 'ENTRY_ACTIVATION_FAILED')
  assert.equal(error.details.entry, Entry.id)
  assert.equal(error.details.causeCode, 'LOAD_TIMEOUT')
  assert.equal(error.details.causeDetails.revision, Slow.id, 'causeDetails.slot / revision name the overdue slot')
  assert.equal(error.details.causeDetails.attemptStillRunning, true)
  assert.equal(error.cause.code, 'LOAD_TIMEOUT')
  assert.equal(runtime.inspect().liveEnvCount, 0, 'the rollback closed the new Env')
  assert.equal(runtime.inspect().rootEnvCount, 0)
  await waitFor(() => events.some(event => event.type === 'attempt-succeeded-late'))
  assert.deepEqual(events.map(event => event.type), ['attempt-overdue', 'attempt-abandoned', 'attempt-succeeded-late'])
  assert.equal(events.at(-1).adopted, false, 'discarded by the rollback close — a corollary of "only a close discards", not an exception')
  assert.deepEqual(log, ['cleanup'])
  assert.deepEqual(runtime.inspect().unsettledAttempts, [])
  assert.equal(setups(), 1)
  await runtime.dispose()
})

test('5. a timeout consumes no attempt and triggers no backoff (attempts 2, delayMs 200): adopted on attempt 1; control: a failing first attempt still retries with the backoff and the waiter\'s window restarts with the new attempt', async () => {
  const { runtime, Entry, events, setups } = slowWorld('s1-no-attempt-consumed', { failure: { attempts: 2, delayMs: 200 } })
  const env = await runtime.enter(Entry)
  const started = Date.now()
  const error = await rejection(env.deps.slow.load())
  assert.equal(error.code, 'LOAD_TIMEOUT')
  assert.equal(error.details.attemptNumber, events[0].attemptNumber)
  await sleep(200) // t ≈ 300 ms
  assert.deepEqual(await env.deps.slow.load(), { id: 'slow', setups: 1 })
  assert.ok(Date.now() - started < 400, 'no 200 ms backoff ran')
  assert.equal(setups(), 1, 'the timeout consumed no attempt: setup() ran once')
  assert.deepEqual(events.map(event => event.type), ['attempt-overdue', 'attempt-succeeded-late'])
  await runtime.dispose()

  // Control: a failure consumes an attempt, the backoff runs, and the waiter is re-armed for the new attempt,
  // so a 100 ms deadline does not end a wait whose first attempt failed and second attempt took 200 ms to start.
  const define = makeDefine('s1-attempt-consumed')
  const controlEvents = []
  const stamps = []
  let calls = 0
  const controlStart = Date.now()
  const Flaky = define.service('flaky', {
    failure: { attempts: 2, delayMs: 150 },
    loadTimeoutMs: 100,
    async setup() {
      calls += 1
      stamps.push(Date.now() - controlStart)
      if (calls === 1) throw new Error('first attempt failed')
      await sleep(50)
      return { calls }
    },
  })
  const FlakyEntry = define.entry('entry', { requires: { flaky: Flaky } })
  const controlRuntime = createRuntime({ services: [Flaky], diagnostics: { onEvent: event => controlEvents.push(event.type) } })
  const controlEnv = await controlRuntime.enter(FlakyEntry)
  assert.deepEqual(await controlEnv.deps.flaky.load(), { calls: 2 })
  assert.equal(calls, 2, 'the failure consumed an attempt')
  assert.ok(stamps[1] - stamps[0] >= 140, `the backoff ran (${stamps[1] - stamps[0]} ms)`)
  assert.deepEqual(controlEvents, [], 'no timeout: the window is per attempt, cleared during the backoff')
  await controlRuntime.dispose()
})

test('7. a late failure of an overdue attempt follows the failure policy: sticky rejects later loads with the setup\'s own error, retry-on-next-load recovers after the cooldown; attempt-failed-late is reported', async () => {
  const define = makeDefine('s1-late-failure')
  const gates = { sticky: deferred(), recovering: deferred() }
  const counts = { sticky: 0, recovering: 0 }
  const events = []
  const service = (name, failure) => define.service(name, {
    failure,
    loadTimeoutMs: 30,
    async setup(_deps, { onDispose }) {
      counts[name] += 1
      const call = counts[name]
      onDispose(() => events.push(`cleanup:${name}:${call}`))
      if (call === 1) {
        await gates[name].promise
        throw new Error(`${name} failed late`)
      }
      return { name, attempt: call }
    },
  })
  const Sticky = service('sticky', { attempts: 1, afterExhaustion: 'sticky' })
  const Recovering = service('recovering', { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 1 })
  const Entry = define.entry('entry', { requires: { sticky: Sticky, recovering: Recovering } })
  const runtime = createRuntime({ services: [Sticky, Recovering], diagnostics: { onEvent: event => events.push(event) } })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.sticky.load(), error => error.code === 'LOAD_TIMEOUT')
  await assert.rejects(env.deps.recovering.load(), error => error.code === 'LOAD_TIMEOUT')
  assert.deepEqual(runtime.inspect().unsettledAttempts.map(item => item.state), ['overdue', 'overdue'])
  const joined = { sticky: rejection(env.deps.sticky.load()), recovering: rejection(env.deps.recovering.load()) }
  gates.sticky.resolve()
  gates.recovering.resolve()
  assert.equal((await joined.sticky).message, 'sticky failed late', 'a waiter that joined the overdue attempt sees its failure')
  assert.equal((await joined.recovering).message, 'recovering failed late')
  const failures = events.filter(event => event.type === 'attempt-failed-late')
  assert.deepEqual(
    failures.map(event => [event.revision, event.env, event.error.message, event.cleanupErrors]).sort(),
    [[Recovering.id, env.id, 'recovering failed late', []], [Sticky.id, env.id, 'sticky failed late', []]],
  )
  assert.deepEqual(events.filter(event => typeof event === 'string').sort(), ['cleanup:recovering:1', 'cleanup:sticky:1'], 'the failed attempts rolled back')
  assert.equal(events.some(event => event.type === 'attempt-succeeded-late'), false)
  assert.equal(nodeOf(env, Sticky).state, 'failed')
  assert.equal(nodeOf(env, Recovering).state, 'failed')
  assert.deepEqual(runtime.inspect().unsettledAttempts, [])
  // sticky: the setup's own error, no new attempt
  assert.equal((await rejection(env.deps.sticky.load())).message, 'sticky failed late')
  assert.equal(counts.sticky, 1)
  // retry-on-next-load: one recovery after the cooldown
  await sleep(5)
  assert.deepEqual(await env.deps.recovering.load(), { name: 'recovering', attempt: 2 })
  assert.equal(counts.recovering, 2)
  await runtime.dispose()
})

test('8. load({ signal: AbortSignal.timeout(20) }) is the shorter wait: LOAD_CANCELLED at 20 ms, the attempt is neither overdue nor affected, and its result is the instance', async () => {
  const { runtime, Entry, Slow, events, setups } = slowWorld('s1-signal-timeout', { deadlineMs: 1_000, resolveAfterMs: 80 })
  const env = await runtime.enter(Entry)
  const started = Date.now()
  const error = await rejection(env.deps.slow.load({ signal: AbortSignal.timeout(20) }))
  assert.equal(error.code, 'LOAD_CANCELLED')
  assert.ok(Date.now() - started < 70, 'ended by the signal, not by the deadline or the attempt')
  const node = nodeOf(env, Slow)
  assert.deepEqual(error.details, { slot: node.slotId, revision: Slow.id })
  assert.equal(node.state, 'starting')
  assert.equal('overdueMs' in node, false)
  assert.deepEqual(events, [], 'the cancelled waiter takes its deadline with it: nothing is overdue')
  assert.deepEqual(await env.deps.slow.load(), { id: 'slow', setups: 1 })
  assert.deepEqual(events, [], 'not a late result: the attempt was never overdue')
  assert.deepEqual(runtime.inspect().unsettledAttempts, [])
  assert.equal(setups(), 1)
  await runtime.dispose()
})

test('9. a waiter that joins during a failed slot\'s recovery cooldown is armed when the new attempt starts; a dependency load inside a setup is a waiter too and its timeout is the setup\'s own failure', async () => {
  const define = makeDefine('s1-recovery-waiter')
  let calls = 0
  const Recovering = define.service('recovering', {
    failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 100 },
    loadTimeoutMs: 60,
    async setup() {
      calls += 1
      if (calls === 1) throw new Error('first attempt failed')
      await sleep(30)
      return { calls }
    },
  })
  const Entry = define.entry('entry', { requires: { recovering: Recovering } })
  const runtime = createRuntime({ services: [Recovering] })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.recovering.load(), /first attempt failed/)
  const started = Date.now()
  // The cooldown (100 ms) is longer than the deadline (60 ms): the waiter is armed only when the attempt starts.
  assert.deepEqual(await env.deps.recovering.load(), { calls: 2 })
  assert.ok(Date.now() - started >= 120, 'waited through the cooldown and the attempt without timing out')
  await runtime.dispose()

  // A setup waiting on a dependency is a waiter with the dependency's deadline; its LOAD_TIMEOUT is
  // the setup's own rejection, so the consumer fails while the dependency's attempt keeps running and is adopted.
  const world = makeDefine('s1-dependency-waiter')
  const events = []
  const Dep = world.service('dep', { loadTimeoutMs: 30, async setup() { await sleep(80); return { id: 'dep' } } })
  const Consumer = world.service('consumer', { requires: { dep: Dep }, async setup({ dep }) { return { dep: await dep.load() } } })
  const DepEntry = world.entry('entry', { requires: { consumer: Consumer, dep: Dep } })
  const depRuntime = createRuntime({ services: [Dep, Consumer], diagnostics: { onEvent: event => events.push(event.type) } })
  const depEnv = await depRuntime.enter(DepEntry)
  const failure = await rejection(depEnv.deps.consumer.load())
  assert.equal(failure.code, 'LOAD_TIMEOUT')
  assert.equal(failure.details.revision, Dep.id)
  assert.equal(nodeOf(depEnv, Consumer).state, 'failed', 'the consumer\'s setup rejected with its dependency wait\'s timeout')
  assert.equal(nodeOf(depEnv, Dep).state, 'starting')
  await waitFor(() => events.includes('attempt-succeeded-late'))
  assert.equal(nodeOf(depEnv, Dep).state, 'ready', 'the dependency\'s attempt was adopted')
  assert.deepEqual(await depEnv.deps.dep.load(), { id: 'dep' })
  assert.deepEqual(events, ['attempt-overdue', 'attempt-succeeded-late'])
  await depRuntime.dispose()
})

test('an overdue attempt whose setup Promise is garbage-collected is closed as unreachable: attempt-unreachable, the ledger shrinks and the sequence takes the failure path (ledger/event assertions only; no state assertion depends on GC)', async () => {
  const script = `
    import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
    const define = definePackage({ name: '@v07/s1-gc', version: '1.0.0', syna: { id: 'v07.s1.gc' } })
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const events = []
    let calls = 0
    const Stuck = define.service('stuck', {
      failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 1 },
      loadTimeoutMs: 20,
      setup(_deps, { onDispose }) {
        calls += 1
        onDispose(() => events.push('cleanup:' + calls))
        return calls === 1 ? new Promise(() => {}) : { calls }
      },
    })
    const Entry = define.entry('entry', { requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], diagnostics: { onEvent: event => events.push(event.type) } })
    const env = await runtime.enter(Entry)
    const error = await env.deps.stuck.load().catch(error => error)
    const before = runtime.inspect().unsettledAttempts.map(item => item.state)
    for (let round = 0; round < 10 && !events.includes('attempt-unreachable'); round += 1) {
      global.gc()
      await sleep(20)
    }
    const after = runtime.inspect().unsettledAttempts.length
    const recovered = await env.deps.stuck.load().catch(error => error.code)
    console.log(JSON.stringify({ code: error.code, before, events, after, recovered, calls }))
    await runtime.dispose()
  `
  const result = await child(['--expose-gc', '--unhandled-rejections=strict'], script)
  assert.equal(result.code, 0, `child failed:\n${result.stderr}`)
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.equal(out.code, 'LOAD_TIMEOUT')
  assert.deepEqual(out.before, ['overdue'], 'overdue and listed while the Promise is alive')
  assert.deepEqual(out.events, ['attempt-overdue', 'cleanup:1', 'attempt-unreachable'], 'closed as unreachable after its cleanup ran')
  assert.equal(out.after, 0, 'the ledger shrank')
  assert.deepEqual(out.recovered, { calls: 2 }, 'the failure path: retry-on-next-load recovered')
})
