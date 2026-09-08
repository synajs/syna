// 1.0.0-rc.4 / N5 — when a deadline fires, told by a clock the test owns.
//
// The third independent review of rc.4 armed every waiter for four times its
// configured `loadTimeoutMs` and left the reported details alone. All eight cases of
// `rc4-waiter-termination.test.mjs` passed (`work/rc5/BASELINE.md`): a 40 ms deadline
// that fires at 160 ms still lands inside `35 ≤ elapsed < 400`, and the eager case
// only asked for `< 1000`. An upper bound wide enough not to flake is wide enough to
// hold a deadline that is wrong by a factor.
//
// The answer is not a narrower window — that would only trade a blind spot for a
// flaky one, and would reject the legitimate structured rollback the public `enter()`
// waits for. It is to stop measuring durations here at all: each case below runs in a
// child process whose `setTimeout`, `clearTimeout`, `Date.now` and `performance.now`
// the test owns, advances that clock to the instant *before* the deadline and to the
// deadline itself, and asserts what has and has not happened at each. The end-to-end
// wall-clock evidence — that a real process really does give up after a real timeout —
// stays where it was, in `rc4-waiter-termination.test.mjs`, with a stated tolerance.
//
// Three things the model separates and this file therefore verifies separately (§11):
//   1. the instant the *internal* wait ends (the waiter's own deadline);
//   2. the boundary of the close that an eager activation failure starts (the grace,
//      not a second copy of the deadline);
//   3. the result and `cause` the *public* Promise finally carries.
//
// Deliberately NOT asserted: how many timers exist. The queue may arm one timer for
// the whole runtime or one per waiter; what the model promises is when a wait ends.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url))

/**
 * The clock driver, installed before the core is imported. `advance(to)` runs every
 * timer due at or before `to` in expiry order, draining the microtask queue (and one
 * real `setImmediate`, which the deadline queue uses to chain simultaneous expiries)
 * after each one, and leaves the clock exactly at `to`.
 *
 * Only this process is affected: the parent test runner keeps its own timers.
 */
const CLOCK = `
  const real = { setImmediate: globalThis.setImmediate }
  let clock = 0
  const timers = new Set()
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const timer = { at: clock + Math.max(0, Number(delay) || 0), callback, args,
      ref() { return this }, unref() { return this }, hasRef() { return false } }
    timers.add(timer)
    return timer
  }
  globalThis.clearTimeout = timer => { timers.delete(timer) }
  Date.now = () => 1_000_000 + clock
  Object.defineProperty(performance, 'now', { configurable: true, value: () => clock })
  const flush = async () => {
    for (let round = 0; round < 16; round += 1) await Promise.resolve()
    await new Promise(resolve => real.setImmediate(resolve))
    for (let round = 0; round < 16; round += 1) await Promise.resolve()
  }
  const advance = async to => {
    for (let safety = 0; safety < 1000; safety += 1) {
      const due = [...timers].filter(timer => timer.at <= to).sort((a, b) => a.at - b.at)[0]
      if (due === undefined) { clock = to; await flush(); return }
      clock = due.at
      timers.delete(due)
      due.callback(...due.args)
      await flush()
    }
    throw new Error('fake clock: the timers never drained')
  }
  const now = () => clock
  const deferred = () => { let resolve; const promise = new Promise(settle => { resolve = settle }); return { promise, resolve } }
  const outcome = promise => { const seen = { settled: false, value: undefined, at: undefined }
    promise.then(value => { seen.settled = true; seen.value = { ok: true, value }; seen.at = clock },
      error => { seen.settled = true; seen.value = { ok: false, code: error?.code, cause: error?.cause?.code,
        note: error?.details?.note, attemptStillRunning: error?.details?.attemptStillRunning,
        deadlineMs: error?.details?.deadlineMs }; seen.at = clock })
    return seen }
`

const scenario = body => `
  ${CLOCK}
  const { createRuntime, definePackage } = await import(${JSON.stringify(DIST)})
  const define = definePackage({ name: '@rc4/deadline-clock', version: '1.0.0', syna: { id: 'rc4.deadline.clock' } })
  const events = []
  const record = value => console.log(JSON.stringify(value))
  ${body}
`

const observe = async body => {
  const result = await run(process.execPath, ['--input-type=module', '-e', scenario(body)])
    .then(ok => ({ code: 0, ...ok }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout.trim().split('\n').at(-1))
}

test('N5 clock: the first waiter on an attempt whose rollback hangs ends at its own deadline, at that instant and not before', async () => {
  const out = await observe(`
    const hang = deferred()
    const Service = define.service('s', {
      failure: { attempts: 1 },
      loadTimeoutMs: 40,
      setup(_deps, { onDispose }) {
        onDispose(() => hang.promise)
        return new Promise((_resolve, reject) => setTimeout(() => reject('setup failed'), 5))
      },
    })
    const Entry = define.entry({ requires: { s: Service } })
    const runtime = createRuntime({ services: [Service], diagnostics: { onEvent: event => events.push({ at: now(), type: event.type }) } })
    const env = await runtime.enter(Entry)
    const waiter = outcome(env.deps.s.load())
    await flush()

    await advance(4)
    const beforeSetupFailed = { settled: waiter.settled, slot: env.inspect().nodes.find(node => node.kind === 'service').state }
    await advance(5)
    const afterSetupFailed = { settled: waiter.settled, slot: env.inspect().nodes.find(node => node.kind === 'service').state }
    await advance(39)
    const before = { settled: waiter.settled }
    await advance(40)
    record({
      beforeSetupFailed, afterSetupFailed, before,
      settledAt: waiter.at, result: waiter.value, events,
      slot: env.inspect().nodes.find(node => node.kind === 'service').state,
      env: env.state,
      ledger: runtime.inspect().unsettledAttempts.length,
    })
    hang.resolve()
  `)
  assert.deepEqual(out.beforeSetupFailed, { settled: false, slot: 'starting' })
  assert.deepEqual(out.afterSetupFailed, { settled: false, slot: 'starting' },
    'the raw setup has failed and its rollback is running: the attempt has not ended, so the wait goes on')
  assert.deepEqual(out.before, { settled: false }, 'one millisecond before its deadline the wait is still open')
  assert.equal(out.settledAt, 40, 'and it ends at the configured deadline, at that instant')
  assert.equal(out.result.ok, false)
  assert.equal(out.result.code, 'LOAD_TIMEOUT')
  assert.equal(out.result.deadlineMs, 40, 'reported as the deadline it actually was')
  assert.match(out.result.note, /rollback of the failed setup was still running/)
  assert.deepEqual(out.events, [], 'a rollback that outruns a waiter is not an overdue setup')
  assert.equal(out.slot, 'starting', 'the attempt is still the current one')
  assert.equal(out.env, 'ready', 'and nothing about the Env changed: this is not a close')
  assert.equal(out.ledger, 0)
})

test('N5 clock: a waiter that joins during the rollback is armed from its own start, not from the attempt\'s', async () => {
  const out = await observe(`
    const hang = deferred()
    let setups = 0
    const Service = define.service('s', {
      failure: { attempts: 1 },
      loadTimeoutMs: 40,
      setup(_deps, { onDispose }) {
        setups += 1
        onDispose(() => hang.promise)
        return new Promise((_resolve, reject) => setTimeout(() => reject('setup failed'), 5))
      },
    })
    const Entry = define.entry({ requires: { s: Service } })
    const runtime = createRuntime({ services: [Service] })
    const env = await runtime.enter(Entry)
    const first = outcome(env.deps.s.load())
    await flush()
    await advance(40)

    await advance(70)
    const second = outcome(env.deps.s.load())
    await flush()
    await advance(109)
    const before = { settled: second.settled }
    await advance(110)
    record({
      firstAt: first.at, secondAt: second.at, before,
      first: first.value, second: second.value, setups,
      slot: env.inspect().nodes.find(node => node.kind === 'service').state,
    })
    hang.resolve()
  `)
  assert.equal(out.firstAt, 40, 'the waiter that started with the attempt ended at 40')
  assert.deepEqual(out.before, { settled: false }, 'the one that joined at 70 is still waiting at 109')
  assert.equal(out.secondAt, 110, 'and ends at 70 + 40: its window is its own')
  assert.equal(out.first.code, 'LOAD_TIMEOUT')
  assert.equal(out.second.code, 'LOAD_TIMEOUT')
  assert.equal(out.setups, 1, 'joining an unfinished rollback never starts an overlapping attempt')
  assert.equal(out.slot, 'starting')
})

test('N5 clock: eager activation has two moments — the internal wait ends at the deadline, the public enter() after the close it starts', async () => {
  const out = await observe(`
    const hang = deferred()
    const Service = define.service('s', {
      eager: true,
      failure: { attempts: 1 },
      loadTimeoutMs: 60,
      setup(_deps, { signal, onDispose }) {
        signal.addEventListener('abort', () => { events.push({ at: now(), type: 'owner-abort' }) }, { once: true })
        onDispose(() => hang.promise)
        return new Promise((_resolve, reject) => setTimeout(() => reject('eager setup failed'), 5))
      },
    })
    const Entry = define.entry({ requires: { s: Service } })
    const runtime = createRuntime({
      services: [Service],
      limits: { disposalGraceMs: 2_000 },
      diagnostics: { onEvent: event => events.push({ at: now(), type: event.type }) },
    })
    const entering = outcome(runtime.enter(Entry))
    await flush()

    await advance(59)
    const beforeDeadline = { abort: events.filter(event => event.type === 'owner-abort').length, entered: entering.settled }
    await advance(60)
    const atDeadline = { abort: events.filter(event => event.type === 'owner-abort').at(0)?.at, entered: entering.settled, live: runtime.inspect().liveEnvCount }
    await advance(2_059)
    const beforeGrace = { entered: entering.settled, live: runtime.inspect().liveEnvCount }
    await advance(2_060)
    record({
      beforeDeadline, atDeadline, beforeGrace,
      settledAt: entering.at, result: entering.value, events,
      live: runtime.inspect().liveEnvCount,
    })
    hang.resolve()
  `)
  assert.deepEqual(out.beforeDeadline, { abort: 0, entered: false },
    'before the load timeout nothing has been given up on')
  assert.equal(out.atDeadline.abort, 60,
    'the internal eager wait ends at `loadTimeoutMs` and starts the activation-failure close there')
  assert.equal(out.atDeadline.entered, false,
    'the public enter() does not escape that close: it waits for it, as `enterFrom` always has')
  assert.equal(out.beforeGrace.entered, false, 'and it is still waiting one millisecond before the close is bounded')
  assert.equal(out.settledAt, 2_060, 'it settles when the bounded close does: the deadline plus the grace, not twice the deadline')
  assert.equal(out.result.ok, false)
  assert.equal(out.result.code, 'ENTRY_ACTIVATION_FAILED')
  assert.equal(out.result.cause, 'LOAD_TIMEOUT', 'and it names the internal wait that failed the activation (§11)')
  assert.equal(out.live, 0, 'the half-started Env is gone')
  assert.ok(out.events.some(event => event.type === 'attempt-abandoned'),
    'the close abandons the unfinished rollback and says so')
})

test('N5 clock: the public enter() is bounded by the close, so a shorter grace ends it earlier — the deadline itself does not move', async () => {
  const out = await observe(`
    const hang = deferred()
    const Service = define.service('s', {
      eager: true,
      failure: { attempts: 1 },
      loadTimeoutMs: 60,
      setup(_deps, { signal, onDispose }) {
        signal.addEventListener('abort', () => { events.push({ at: now(), type: 'owner-abort' }) }, { once: true })
        onDispose(() => hang.promise)
        return new Promise((_resolve, reject) => setTimeout(() => reject('eager setup failed'), 5))
      },
    })
    const Entry = define.entry({ requires: { s: Service } })
    const runtime = createRuntime({ services: [Service], limits: { disposalGraceMs: 40 } })
    const entering = outcome(runtime.enter(Entry))
    await flush()
    await advance(60)
    const atDeadline = { abort: events.filter(event => event.type === 'owner-abort').at(0)?.at, entered: entering.settled }
    await advance(99)
    const beforeGrace = { entered: entering.settled }
    await advance(100)
    record({ atDeadline, beforeGrace, settledAt: entering.at, result: entering.value })
    hang.resolve()
  `)
  assert.equal(out.atDeadline.abort, 60, 'the same internal deadline as with the long grace')
  assert.equal(out.atDeadline.entered, false)
  assert.deepEqual(out.beforeGrace, { entered: false })
  assert.equal(out.settledAt, 100, 'and the public Promise follows the close: 60 + 40')
  assert.equal(out.result.code, 'ENTRY_ACTIVATION_FAILED')
  assert.equal(out.result.cause, 'LOAD_TIMEOUT')
})

test('N5 clock control: while the setup itself is pending the deadline fires at the same instant, and that attempt is overdue', async () => {
  const out = await observe(`
    const Service = define.service('s', {
      loadTimeoutMs: 30,
      setup(_deps, { onDispose }) { onDispose(() => undefined); return new Promise(() => undefined) },
    })
    const Entry = define.entry({ requires: { s: Service } })
    const runtime = createRuntime({ services: [Service], diagnostics: { onEvent: event => events.push({ at: now(), type: event.type }) } })
    const env = await runtime.enter(Entry)
    const waiter = outcome(env.deps.s.load())
    await flush()
    await advance(29)
    const before = { settled: waiter.settled, events: [...events] }
    await advance(30)
    record({
      before, settledAt: waiter.at, result: waiter.value, events,
      ledger: runtime.inspect().unsettledAttempts.map(entry => entry.state),
    })
  `)
  assert.deepEqual(out.before, { settled: false, events: [] })
  assert.equal(out.settledAt, 30)
  assert.equal(out.result.code, 'LOAD_TIMEOUT')
  assert.equal(out.result.attemptStillRunning, true)
  assert.match(out.result.note, /while setup was still pending/)
  assert.deepEqual(out.events, [{ at: 30, type: 'attempt-overdue' }],
    'reported once, at the deadline: a setup that outran its own window is overdue')
  assert.deepEqual(out.ledger, ['overdue'])
})
