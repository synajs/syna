// The close matrix required by SYNA_RC3_EXECUTION_PROMPT.md §3: what is stuck or
// throwing (a Ready slot's cleanup hanging or throwing, the rollback of an attempt
// that settled inside the grace, the late cleanup of an abandoned attempt) against
// what became of the waiter (none, still waiting, cancelled, past its deadline) — plus the
// two properties of concurrent destruction: every dependency chain keeps its order,
// and one level of the close costs one grace per slot of the longest chain.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage } from '../dist/index.js'

const makeDefine = id => definePackage({ name: `@rc3/${id.replaceAll('.', '-')}`, version: '1.0.0', syna: { id } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stateOf = (env, name) => env.inspect().nodes.find(node => node.label.includes(`/${name}@`))?.state

/** A chain `<prefix>1 → <prefix>2 → <prefix>3`, each cleanup recording itself. */
const chain = (define, prefix, cleanup) => {
  const tail = define.service(`${prefix}3`, {
    setup(_deps, lifecycle) { lifecycle.onDispose(() => cleanup(`${prefix}3`)); return { name: `${prefix}3` } },
  })
  const middle = define.service(`${prefix}2`, {
    requires: { next: tail },
    async setup({ next }, lifecycle) { await next.load(); lifecycle.onDispose(() => cleanup(`${prefix}2`)); return { name: `${prefix}2` } },
  })
  const head = define.service(`${prefix}1`, {
    requires: { next: middle },
    async setup({ next }, lifecycle) { await next.load(); lifecycle.onDispose(() => cleanup(`${prefix}1`)); return { name: `${prefix}1` } },
  })
  return { head, middle, tail, all: [head, middle, tail] }
}

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(2)
  }
}

const GRACE_MS = 80
const SHORT_TIMEOUT_MS = 25

/**
 * One cell: the failure of `row` while the waiter of the slot that carries it is
 * in the state of `column`. A Ready slot has no waiter of its own (a `load()` on
 * it resolves at once), so for the two Ready rows the waiter of the column sits
 * on a second, never-settling slot of the same Env: the close must report the
 * same thing whatever any waiter is doing.
 */
const runCell = async (row, column) => {
  const define = makeDefine(`rc3.matrix.${row}.${column}`)
  const events = []
  const cleanupError = new Error(`${row} cleanup failed`)
  const readyRow = row === 'ready-hangs' || row === 'ready-throws'
  const loadTimeoutMs = column === 'none' || column === 'timeout' ? SHORT_TIMEOUT_MS : 5_000
  let releaseHung
  let releaseSubject
  let releaseWitness

  const Subject = readyRow
    ? define.service('subject', {
      setup(_deps, { onDispose }) {
        onDispose(row === 'ready-hangs'
          ? () => new Promise(resolve => { releaseHung = resolve })
          : () => { throw cleanupError })
        return { subject: true }
      },
    })
    : define.service('subject', {
      loadTimeoutMs,
      setup(_deps, { onDispose }) {
        onDispose(() => { throw cleanupError })
        return new Promise(resolve => { releaseSubject = () => resolve({ late: true }) })
      },
    })
  // Only the Ready rows need it, and only when the column has a waiter to place.
  const Witness = define.service('witness', {
    loadTimeoutMs,
    setup() { return new Promise(resolve => { releaseWitness = () => resolve({ witness: true }) }) },
  })
  const Entry = define.entry({ requires: { subject: Subject, witness: Witness } })
  const runtime = createRuntime({
    services: [Subject, Witness],
    limits: { disposalGraceMs: GRACE_MS },
    diagnostics: { onEvent: event => events.push(event) },
  })
  const env = await runtime.enter(Entry)

  const carrier = readyRow ? env.deps.witness : env.deps.subject
  if (readyRow) await env.deps.subject.load() // Ready before the close
  let waiter
  let waiterOutcome
  const controller = new AbortController()
  if (column === 'none' && !readyRow) {
    // The attempt's only waiter timed out before the close began: nothing waits
    // for it any more and it is overdue.
    waiterOutcome = await carrier.load().then(() => 'resolved', error => error?.code ?? error)
  }
  else if (column === 'waiting') {
    waiter = carrier.load().then(() => 'resolved', error => error)
  }
  else if (column === 'cancelled') {
    waiter = carrier.load({ signal: controller.signal }).then(() => 'resolved', error => error)
    await sleep(5)
    controller.abort()
    waiterOutcome = await waiter.then(error => error?.code ?? error)
    waiter = undefined
  }
  else if (column === 'timeout') {
    // Issued now, so its deadline expires while the close is running.
    waiter = carrier.load().then(() => 'resolved', error => error)
  }
  if (column === 'none' && readyRow) await sleep(2)
  else if (column === 'waiting' || column === 'timeout') await sleep(2)

  const started = Date.now()
  const disposal = env.dispose().then(() => undefined, error => error)
  if (row === 'rollback-throws') {
    // Settles inside the grace, after the column's deadline could fire.
    await sleep(SHORT_TIMEOUT_MS + 20)
    releaseSubject()
  }
  const closeError = await disposal
  const elapsed = Date.now() - started
  if (waiter) waiterOutcome = await waiter.then(value => (value instanceof Error ? value.code ?? value.name : value), error => error?.code ?? error)

  const ledgerAfterClose = runtime.inspect().unsettledAttempts.map(entry => entry.state).sort()
  const lateEvents = []
  if (row === 'late-cleanup-throws') {
    releaseSubject()
    await waitFor(() => events.some(event => event.type === 'attempt-succeeded-late'))
    lateEvents.push(...events.filter(event => event.type === 'attempt-succeeded-late'))
  }
  if (row === 'ready-hangs') releaseHung?.()
  releaseWitness?.()
  await sleep(20)
  await runtime.dispose().catch(() => undefined)

  const flat = error => (error instanceof AggregateError ? error.errors.flatMap(flat) : [error])
  return {
    elapsed,
    envState: env.state,
    rejected: closeError !== undefined,
    occurrences: closeError === undefined ? 0 : flat(closeError).filter(error => error === cleanupError).length,
    waiterOutcome,
    events: events.map(event => event.type),
    abandonedPhases: events.filter(event => event.type === 'attempt-abandoned').map(event => event.phase).sort(),
    ledgerAfterClose,
    lateCleanupErrors: lateEvents.flatMap(event => event.cleanupErrors),
  }
}

const ROWS = ['ready-hangs', 'ready-throws', 'rollback-throws', 'late-cleanup-throws']
const COLUMNS = ['none', 'waiting', 'cancelled', 'timeout']

for (const row of ROWS) {
  for (const column of COLUMNS) {
    test(`close matrix: ${row} × waiter ${column}`, async () => {
      const cell = await runCell(row, column)
      const readyRow = row === 'ready-hangs' || row === 'ready-throws'
      const hasPendingSlot = !readyRow || column !== 'none'

      // Every cell: the close ends inside its bound and the Env is disposed.
      const budgets = (hasPendingSlot ? 1 : 0) + (row === 'ready-hangs' ? 1 : 0)
      assert.ok(cell.elapsed <= GRACE_MS * budgets + 400, `bounded close (took ${cell.elapsed} ms, ${budgets} budget(s) of ${GRACE_MS} ms)`)
      assert.equal(cell.envState, 'disposed')

      // Whether dispose() reports depends on the row alone, never on the waiter.
      if (row === 'ready-throws' || row === 'rollback-throws') {
        assert.equal(cell.rejected, true, 'a cleanup failure the close waited for rejects dispose()')
        assert.equal(cell.occurrences, 1, 'exactly once in the AggregateError')
      }
      else {
        assert.equal(cell.rejected, false, 'the close does not reject for what it stopped waiting for')
      }

      // The waiter gets its own outcome, and it changes nothing above.
      const expectedWaiter = {
        none: readyRow ? undefined : 'LOAD_TIMEOUT',
        waiting: row === 'ready-hangs' || row === 'ready-throws' ? 'ENV_CLOSED' : (row === 'rollback-throws' ? 'AggregateError' : 'ENV_CLOSED'),
        cancelled: 'LOAD_CANCELLED',
        'timeout': 'LOAD_TIMEOUT',
      }[column]
      assert.equal(cell.waiterOutcome, expectedWaiter, `the waiter of a ${column} column`)

      // Events: the late settlement is reported from the start of the close, and
      // an abandoned cleanup says which phase it was.
      if (row === 'ready-hangs') assert.ok(cell.abandonedPhases.includes('cleanup'))
      else assert.ok(!cell.abandonedPhases.includes('cleanup'))
      if (row === 'rollback-throws') {
        assert.ok(cell.events.includes('attempt-succeeded-late'), 'reported even when no waiter is left')
      }
      if (row === 'late-cleanup-throws') {
        assert.deepEqual(cell.ledgerAfterClose, ['abandoned'], 'the abandoned attempt is on the ledger while dispose() has returned')
        assert.equal(cell.lateCleanupErrors.length, 1, 'its late cleanup failure is reported by the event')
      }
      if (hasPendingSlot && row !== 'rollback-throws') {
        assert.ok(cell.abandonedPhases.includes('setup'), 'the never-settling attempt is abandoned by the same close')
      }
    })
  }
}

test('concurrent destruction: three independent chains are disposed at once while each chain keeps its own order', async () => {
  const define = makeDefine('rc3.matrix.chains')
  const order = []
  const slow = async name => { order.push(`${name}:start`); await sleep(40); order.push(`${name}:end`) }
  const a = chain(define, 'a', slow)
  const b = chain(define, 'b', slow)
  const c = chain(define, 'c', slow)
  const services = [...a.all, ...b.all, ...c.all]
  const Entry = define.entry({ requires: { a: a.head, b: b.head, c: c.head } })
  const runtime = createRuntime({ services, limits: { disposalGraceMs: 1_000 } })
  const env = await runtime.enter(Entry)
  await Promise.all([env.deps.a.load(), env.deps.b.load(), env.deps.c.load()])

  const started = Date.now()
  await env.dispose()
  const elapsed = Date.now() - started
  // Nine cleanups of 40 ms: 360 ms in a row, three chains of three concurrently ≈ 120 ms.
  assert.ok(elapsed < 260, `independent chains are disposed concurrently (took ${elapsed} ms)`)

  const ends = order.filter(entry => entry.endsWith(':end')).map(entry => entry.slice(0, -4))
  for (const prefix of ['a', 'b', 'c']) {
    assert.deepEqual(ends.filter(name => name.startsWith(prefix)), [`${prefix}1`, `${prefix}2`, `${prefix}3`],
      `chain ${prefix} is disposed dependant-first, one slot at a time`)
  }
  assert.deepEqual(new Set(order.slice(0, 3)), new Set(['a1:start', 'b1:start', 'c1:start']),
    'the three heads start together: the chains interleave')
  assert.equal(order.length, 18)
  await runtime.dispose()
})

// "One grace per slot of the longest chain" is two claims, and 1.0.0-rc.4 / G1
// separates them because putting both on one wall-clock reading made the release
// gate flaky: `wideElapsed >= graceMs` was a zero-tolerance lower bound on a
// measured duration, and libuv may fire a timer about a millisecond early while
// `Date.now()` truncates both readings — 39 ms against a 40 ms budget, in the cloud
// and in 8 of 3000 local rounds (work/rc4/BASELINE.md §7).
//
// The structural claim — each slot's cleanup phase consumes a budget of its own,
// the phases of independent slots overlap, the phases along a chain do not — is now
// asserted from the order of observable events and from when budgets are armed and
// expire, with no reading of elapsed time at all. The wall-clock claim keeps its
// upper bound (the close really is bounded) and a lower bound with a stated
// tolerance on a monotonic clock (it really does wait for the budget).
//
// Deliberately NOT asserted: an exact number of timers. Five independent slots arm
// five concurrent budgets today and could legitimately share one tomorrow; what the
// model promises is the attribution and the ordering, not the mechanism.

/**
 * Runs `body` with `globalThis.setTimeout` intercepted (the house style of
 * work/rc3/probes/site-manager.mjs) and returns every timer armed while it ran,
 * each with the logical moment it was armed and the moment it fired. Logical, not
 * measured: this test must say nothing about how long anything took.
 */
const recordingTimers = async body => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const armed = []
  const live = new Map()
  let sequence = 0
  globalThis.setTimeout = (callback, delay, ...args) => {
    const record = { delay, armedAt: sequence += 1, firedAt: undefined }
    armed.push(record)
    const timer = realSetTimeout.call(globalThis, (...called) => {
      record.firedAt = sequence += 1
      callback(...called)
    }, delay, ...args)
    live.set(timer, record)
    return timer
  }
  globalThis.clearTimeout = timer => {
    live.delete(timer)
    return realClearTimeout.call(globalThis, timer)
  }
  try { await body() }
  finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
  return armed
}

test('structure: five independent hung cleanups spend their budgets at the same time, and a chain of three spends them one after another', async () => {
  const define = makeDefine('rc4.matrix.structure')
  const graceMs = 40

  // Wide: five independent slots. Every cleanup announces itself and hangs.
  const started = []
  const wide = Array.from({ length: 5 }, (_unused, index) => define.service(`wide${index}`, {
    setup(_deps, { onDispose }) {
      onDispose(() => new Promise(() => { started.push(`wide${index}`) }))
      return { index }
    },
  }))
  const WideEntry = define.entry('wide', { requires: Object.fromEntries(wide.map((service, index) => [`w${index}`, service])) })
  const runtimeWide = createRuntime({ services: wide, limits: { disposalGraceMs: graceMs } })
  const wideEnv = await runtimeWide.enter(WideEntry)
  await Promise.all(wide.map((_service, index) => wideEnv.deps[`w${index}`].load()))

  const wideTimers = await recordingTimers(() => wideEnv.dispose())
  const wideBudgets = wideTimers.filter(record => record.delay === graceMs)
  assert.ok(wideBudgets.length >= 1, 'the level spends a budget')
  const firstWideExpiry = Math.min(...wideBudgets.filter(record => record.firedAt !== undefined).map(record => record.firedAt))
  assert.ok(Number.isFinite(firstWideExpiry), 'a budget expired: the close really stopped waiting')
  assert.ok(wideBudgets.every(record => record.armedAt < firstWideExpiry),
    'every budget of this level was armed before the first of them expired — the phases overlap, so the level costs one budget of wall-clock time')
  assert.equal(started.length, 5, 'all five cleanup phases had started')
  assert.equal(wideEnv.state, 'disposed')
  assert.equal(runtimeWide.inspect().unsettledAttempts.length, 5, 'each slot was abandoned on a budget of its own')
  await runtimeWide.dispose()

  // Deep: a chain of three. Each cleanup announces itself and hangs.
  const chainStarted = []
  const deep = chain(define, 'deep', name => new Promise(() => { chainStarted.push(name) }))
  const DeepEntry = define.entry('deep', { requires: { head: deep.head } })
  const runtimeDeep = createRuntime({ services: deep.all, limits: { disposalGraceMs: graceMs } })
  const deepEnv = await runtimeDeep.enter(DeepEntry)
  await deepEnv.deps.head.load()

  const deepTimers = await recordingTimers(() => deepEnv.dispose())
  const deepBudgets = deepTimers.filter(record => record.delay === graceMs && record.firedAt !== undefined)
  assert.ok(deepBudgets.length >= 3, `the chain spends one budget per slot (${deepBudgets.length})`)
  const byArming = [...deepBudgets].sort((left, right) => left.armedAt - right.armedAt)
  for (let index = 1; index < byArming.length; index += 1) {
    assert.ok(byArming[index].armedAt > byArming[index - 1].firedAt,
      'along a chain the next budget is armed only after the previous one expired: the phases are serial, never overlapping')
  }
  assert.deepEqual(chainStarted, ['deep1', 'deep2', 'deep3'],
    'and the cleanups themselves ran dependant-first, one at a time')
  assert.equal(deepEnv.state, 'disposed')
  assert.deepEqual(
    ['deep1', 'deep2', 'deep3'].map(name => stateOf(deepEnv, name)),
    ['abandoned', 'abandoned', 'abandoned'],
    'every slot of the chain was reached, dependant-first, and each one abandoned on its own budget',
  )
  assert.equal(runtimeDeep.inspect().unsettledAttempts.length, 3)
  await runtimeDeep.dispose()
})

// The wall-clock half. `performance.now()` is monotonic and not truncated to whole
// milliseconds, and the lower bounds carry TIMER_SLACK_MS because a libuv timer may
// fire a fraction early — the same slack every other duration assertion in this
// repository uses. What this proves is that the close really waits for its budget
// and really stops afterwards; what it cannot prove is an exact duration.
const TIMER_SLACK_MS = 5

test('wall clock: the close of a wide level costs about one budget and the close of a chain about three, with slack', async () => {
  const define = makeDefine('rc4.matrix.wallclock')
  const graceMs = 40
  const hang = () => new Promise(() => undefined)

  const wide = Array.from({ length: 5 }, (_unused, index) => define.service(`wide${index}`, {
    setup(_deps, { onDispose }) { onDispose(hang); return { index } },
  }))
  const WideEntry = define.entry('wide', { requires: Object.fromEntries(wide.map((service, index) => [`w${index}`, service])) })
  const runtimeWide = createRuntime({ services: wide, limits: { disposalGraceMs: graceMs } })
  const wideEnv = await runtimeWide.enter(WideEntry)
  await Promise.all(wide.map((_service, index) => wideEnv.deps[`w${index}`].load()))
  const wideStarted = performance.now()
  await wideEnv.dispose()
  const wideElapsed = performance.now() - wideStarted
  assert.ok(wideElapsed >= graceMs - TIMER_SLACK_MS,
    `the close did wait for its budget (took ${wideElapsed.toFixed(1)} ms, budget ${graceMs} ms, slack ${TIMER_SLACK_MS} ms)`)
  assert.ok(wideElapsed < graceMs * 3,
    `and five independent hung cleanups still cost one budget (took ${wideElapsed.toFixed(1)} ms)`)
  assert.equal(wideEnv.state, 'disposed')
  await runtimeWide.dispose()

  const deep = chain(define, 'deep', () => hang())
  const DeepEntry = define.entry('deep', { requires: { head: deep.head } })
  const runtimeDeep = createRuntime({ services: deep.all, limits: { disposalGraceMs: graceMs } })
  const deepEnv = await runtimeDeep.enter(DeepEntry)
  await deepEnv.deps.head.load()
  const deepStarted = performance.now()
  await deepEnv.dispose()
  const deepElapsed = performance.now() - deepStarted
  assert.ok(deepElapsed >= graceMs * 3 - TIMER_SLACK_MS,
    `a chain of three hung cleanups waited for three budgets (took ${deepElapsed.toFixed(1)} ms, budget ${graceMs} ms, slack ${TIMER_SLACK_MS} ms)`)
  assert.ok(deepElapsed < graceMs * 3 + 220,
    `and never more (took ${deepElapsed.toFixed(1)} ms)`)
  assert.equal(deepEnv.state, 'disposed')
  await runtimeDeep.dispose()
})
