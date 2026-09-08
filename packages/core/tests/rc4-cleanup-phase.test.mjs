// 1.0.0-rc.4 / N1 — a cleanup phase reports what it has already determined.
//
// The baseline (work/rc4/BASELINE.md §1) is that `runCleanups()` accumulated its
// failures in a local array and returned only when the whole phase had ended, so a
// failure that was already determined disappeared behind a later cleanup of the
// same phase that hung — possibly for ever. The same shape sat at four call sites.
// Every case below asserts the correct behaviour: what the close waited for is in
// the `AggregateError` of `dispose()`, what fails afterwards is in the late event,
// and neither list repeats itself.
//
// Deliberately NOT asserted anywhere in this file: that an error appears exactly
// once counting `dispose()` and the diagnostic events together. Those are two
// observers with contracts of their own (`rc3-close-paths.test.mjs:141-173` asserts
// a total of two on purpose); the invariants here are the four of the task book —
// no repetition inside the close's error set, no event emitted twice, the waiter's
// own outcome never decides whether the close reports, and a determined failure
// never disappears because later work of the same phase hangs.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { createRuntime, definePackage } from '../dist/index.js'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const child = (flags, script) =>
  run(process.execPath, [...flags, '--input-type=module', '-e', script])
    .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))

const makeDefine = id => definePackage({ name: `@rc4/${id.replaceAll('.', '-')}`, version: '1.0.0', syna: { id } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => { let resolve; const promise = new Promise(settle => { resolve = settle }); return { promise, resolve } }

/** A cleanup failure is identified by the execution that produced it, never by the Error object. */
const marked = name => Object.assign(new Error(`cleanup ${name} failed`), { marker: name })
const flat = error => (error instanceof AggregateError ? error.errors.flatMap(flat) : [error])
const markersOf = error => flat(error).map(item => item?.marker).filter(marker => marker !== undefined).sort()
const settledOutcome = promise => promise.then(() => undefined, error => error)
/** Releases every hung cleanup, including the ones that only start once an earlier one is released. */
const releaseAll = async gates => {
  for (let round = 0; round < 6; round += 1) {
    const pending = gates.splice(0)
    if (pending.length === 0) break
    for (const gate of pending) gate.resolve()
    await sleep(20)
  }
  await sleep(20)
}

const GRACE = 40

/**
 * One cleanup phase described in the order its cleanups RUN (they are registered
 * in reverse: `onDispose` is LIFO). Each step is `'ok'`, `'throw'` or `'hang'`.
 */
const phase = (steps, onDispose, ran, gates) => {
  for (const [name, kind] of [...steps].reverse()) {
    onDispose(() => {
      ran.push(name)
      if (kind === 'throw') throw marked(name)
      if (kind === 'hang') {
        const gate = deferred()
        gates.push(gate)
        return gate.promise
      }
      return undefined
    })
  }
}

/**
 * The six phase shapes of the acceptance matrix. `determined` is what the close
 * must report when it stops waiting at the budget, `late` what the late report
 * must carry afterwards, `blocked` what has not run at all while the hang lasts.
 */
const SHAPES = [
  { id: 'error-then-hang', steps: [['a', 'throw'], ['h', 'hang']], determined: ['a'], late: [], blocked: [] },
  { id: 'hang-then-error', steps: [['h', 'hang'], ['b', 'throw']], determined: [], late: ['b'], blocked: ['b'] },
  { id: 'two-errors-then-hang', steps: [['a', 'throw'], ['b', 'throw'], ['h', 'hang']], determined: ['a', 'b'], late: [], blocked: [] },
  { id: 'error-hang-error', steps: [['a', 'throw'], ['h', 'hang'], ['b', 'throw']], determined: ['a'], late: ['b'], blocked: ['b'] },
  { id: 'all-inside-the-budget', steps: [['a', 'throw'], ['b', 'throw']], determined: ['a', 'b'], late: ['a', 'b'], blocked: [], settles: true },
  { id: 'all-hang', steps: [['h1', 'hang'], ['h2', 'hang']], determined: [], late: [], blocked: ['h2'] },
]

// ---------------------------------------------------------------------------
// Call site 1: the cleanup phase of a Ready slot (`disposeServiceSlot`).
// ---------------------------------------------------------------------------

for (const shape of SHAPES) {
  test(`N1 Ready-slot cleanup / ${shape.id}: the close reports what it determined, the late report only what came after`, async () => {
    const define = makeDefine(`rc4.n1.ready.${shape.id}`)
    const events = []
    const ran = []
    const gates = []
    const Service = define.service('s', {
      setup(_deps, { onDispose }) { phase(shape.steps, onDispose, ran, gates); return { ok: true } },
    })
    const Entry = define.entry({ requires: { s: Service } })
    const runtime = createRuntime({
      services: [Service],
      limits: { disposalGraceMs: GRACE },
      diagnostics: { onEvent: event => events.push(event) },
    })
    const env = await runtime.enter(Entry)
    await env.deps.s.load()

    const closeError = await settledOutcome(env.dispose())
    assert.equal(env.state, 'disposed')
    if (shape.determined.length === 0) {
      assert.equal(closeError, undefined, 'nothing was determined while the close waited, so it fulfils')
    }
    else {
      assert.ok(closeError instanceof AggregateError, `the close reports what it determined: ${closeError}`)
      assert.deepEqual(markersOf(closeError), shape.determined, 'exactly the failures determined inside the budget, each once')
    }
    for (const name of shape.blocked) {
      assert.ok(!ran.includes(name), `${name} has not run at all while the earlier cleanup hangs`)
    }
    const abandonments = events.filter(event => event.type === 'attempt-abandoned')
    assert.equal(abandonments.length, shape.settles ? 0 : 1, 'the abandonment is reported once, and only when there was one')
    if (!shape.settles) assert.equal(abandonments[0].phase, 'cleanup')
    assert.equal(runtime.inspect().unsettledAttempts.length, shape.settles ? 0 : 1)

    await releaseAll(gates)
    const late = events.filter(event => event.type === 'attempt-failed-late')
    // A phase the close waited to the end of reports through `dispose()` alone: the
    // Ready-slot channel emits `attempt-failed-late` only for an abandoned phase.
    const expectedLate = shape.settles ? [] : shape.late
    assert.equal(late.length, expectedLate.length === 0 ? 0 : 1, 'the late report is emitted once, and only when something failed late')
    if (expectedLate.length > 0) {
      assert.deepEqual(late[0].cleanupErrors.map(item => item.marker).sort(), expectedLate,
        'the late report lists only failures the close had not already been handed')
    }
    assert.equal(runtime.inspect().unsettledAttempts.length, 0, 'the ledger entry goes when the phase ends')
    await runtime.dispose()
  })
}

// ---------------------------------------------------------------------------
// Call site 2: the rollback of a failed attempt (`runAttemptRaw`, rejected).
// ---------------------------------------------------------------------------

for (const shape of SHAPES) {
  test(`N1 attempt rollback / ${shape.id}: the close reports what the rollback determined`, async () => {
    const define = makeDefine(`rc4.n1.rollback.${shape.id}`)
    const events = []
    const ran = []
    const gates = []
    const setupGate = deferred()
    const Service = define.service('s', {
      failure: { attempts: 1 },
      setup(_deps, { onDispose }) { phase(shape.steps, onDispose, ran, gates); return setupGate.promise },
    })
    const Entry = define.entry({ requires: { s: Service } })
    const runtime = createRuntime({
      services: [Service],
      limits: { disposalGraceMs: GRACE },
      diagnostics: { onEvent: event => events.push(event) },
    })
    const env = await runtime.enter(Entry)
    const waiter = settledOutcome(env.deps.s.load())
    await sleep(5)
    // The close begins first, so the rollback runs inside the wait it bounds.
    const closing = settledOutcome(env.dispose())
    await sleep(5)
    setupGate.resolve(Promise.reject(Object.assign(new Error('setup failed'), { marker: 'setup' })))
    const closeError = await closing
    assert.equal(env.state, 'disposed')
    if (shape.determined.length === 0) assert.equal(closeError, undefined)
    else {
      assert.deepEqual(markersOf(closeError), shape.determined,
        'a rollback failure the close waited for is in its AggregateError, each once')
    }
    for (const name of shape.blocked) assert.ok(!ran.includes(name), `${name} has not run while the earlier cleanup hangs`)
    const abandonments = events.filter(event => event.type === 'attempt-abandoned')
    assert.equal(abandonments.length, shape.settles ? 0 : 1)
    if (!shape.settles) assert.equal(abandonments[0].phase, 'rollback', 'the phase is named')
    assert.deepEqual(runtime.inspect().unsettledAttempts.map(entry => entry.state), shape.settles ? [] : ['rolling-back'])

    await releaseAll(gates)
    const late = events.filter(event => event.type === 'attempt-failed-late')
    assert.equal(late.length, 1, 'the late end of the attempt is reported once')
    assert.deepEqual(late[0].cleanupErrors.map(item => item.marker).sort(), shape.late,
      'and lists only the failures the close had not been handed')
    assert.equal(runtime.inspect().unsettledAttempts.length, 0)
    await waiter
    await runtime.dispose()
  })
}

// ---------------------------------------------------------------------------
// Call site 3: the rollback of a late success the close discards.
// ---------------------------------------------------------------------------

for (const shape of [SHAPES[0], SHAPES[3], SHAPES[4]]) {
  test(`N1 discarded late success / ${shape.id}: the close reports what that rollback determined`, async () => {
    const define = makeDefine(`rc4.n1.discarded.${shape.id}`)
    const events = []
    const ran = []
    const gates = []
    const setupGate = deferred()
    const Service = define.service('s', {
      setup(_deps, { onDispose }) { phase(shape.steps, onDispose, ran, gates); return setupGate.promise },
    })
    const Entry = define.entry({ requires: { s: Service } })
    const runtime = createRuntime({
      services: [Service],
      limits: { disposalGraceMs: GRACE },
      diagnostics: { onEvent: event => events.push(event) },
    })
    const env = await runtime.enter(Entry)
    const waiter = settledOutcome(env.deps.s.load())
    await sleep(5)
    const closing = settledOutcome(env.dispose())
    await sleep(5)
    setupGate.resolve({ late: true }) // succeeds after the close began: the instance is discarded
    const closeError = await closing
    if (shape.determined.length === 0) assert.equal(closeError, undefined)
    else assert.deepEqual(markersOf(closeError), shape.determined)
    for (const name of shape.blocked) assert.ok(!ran.includes(name))
    await releaseAll(gates)
    const late = events.filter(event => event.type === 'attempt-succeeded-late')
    assert.equal(late.length, 1, 'the discarded late success is reported once')
    assert.deepEqual(late[0].cleanupErrors.map(item => item.marker).sort(), shape.late)
    assert.equal(late[0].adopted, false)
    await waiter
    await runtime.dispose()
  })
}

// ---------------------------------------------------------------------------
// Call site 4: the late close of an abandoned attempt (`closeUnsettled`).
//
// This phase belongs to an attempt the close has already stopped waiting for, so
// by §13 there is no `dispose()` left to carry any of it: the whole phase reports
// through the late event. What N1 changes here is that the phase records each
// failure when it happens and holds its slot weakly, so a failure determined long
// before the phase ends is still reported in full when it does, and the ledger
// says `settling` honestly meanwhile.
// ---------------------------------------------------------------------------

for (const shape of [SHAPES[0], SHAPES[3], SHAPES[4]]) {
  test(`N1 late settlement / ${shape.id}: the late report carries every failure of the phase, however long before it was determined`, async () => {
    const define = makeDefine(`rc4.n1.late.${shape.id}`)
    const events = []
    const ran = []
    const gates = []
    const setupGate = deferred()
    const Late = define.service('late', {
      setup(_deps, { onDispose }) { phase(shape.steps, onDispose, ran, gates); return setupGate.promise },
    })
    const Entry = define.entry({ requires: { late: Late } })
    const runtime = createRuntime({
      services: [Late],
      limits: { disposalGraceMs: GRACE },
      diagnostics: { onEvent: event => events.push(event) },
    })
    const env = await runtime.enter(Entry)
    const waiter = settledOutcome(env.deps.late.load())
    await sleep(5)

    // The close stops waiting for the pending setup at the grace and returns.
    const closeError = await settledOutcome(env.dispose())
    assert.equal(closeError, undefined, 'an abandoned attempt is not an error of the close')
    assert.deepEqual(runtime.inspect().unsettledAttempts.map(entry => entry.state), ['abandoned'])

    setupGate.resolve({ late: true }) // settles late: `closeUnsettled` runs its cleanups
    await sleep(20)
    const settling = runtime.inspect().unsettledAttempts
    assert.deepEqual(settling.map(entry => entry.state), shape.settles ? [] : ['settling'],
      'the ledger says settling while the late phase is still running')
    for (const name of shape.blocked) assert.ok(!ran.includes(name), `${name} has not run while the earlier cleanup hangs`)

    await releaseAll(gates)
    const late = events.filter(event => event.type === 'attempt-succeeded-late')
    assert.equal(late.length, 1, 'the late close is reported once')
    const everyFailure = shape.steps.filter(([, kind]) => kind === 'throw').map(([name]) => name).sort()
    assert.deepEqual(late[0].cleanupErrors.map(item => item.marker).sort(), everyFailure,
      'every failure of the phase is in the one report that can carry it, in full')
    assert.equal(late[0].adopted, false)
    assert.equal(runtime.inspect().unsettledAttempts.length, 0, 'the ledger entry goes when the phase ends')
    await waiter
    await runtime.dispose()
  })
}

// ---------------------------------------------------------------------------
// Call site 5 (the fourth of the task book's list): the unreachable channel.
// ---------------------------------------------------------------------------

test('N1 unreachable channel: the cleanup phase of an attempt closed as unreachable reports what it determined, and the rest late', async () => {
  const script = `
    import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
    const define = definePackage({ name: '@rc4/n1-unreachable', version: '1.0.0', syna: { id: 'rc4.n1.unreachable' } })
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const events = []
    const ran = []
    let releaseHang
    const Stuck = define.service('stuck', {
      failure: { attempts: 1 },
      loadTimeoutMs: 20,
      setup(_deps, { onDispose }) {
        onDispose(() => new Promise(resolve => { ran.push('h'); releaseHang = resolve }))
        onDispose(() => { ran.push('a'); throw Object.assign(new Error('determined'), { marker: 'a' }) })
        return new Promise(() => {})
      },
    })
    const Entry = define.entry('entry', { requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], limits: { disposalGraceMs: 40 }, diagnostics: { onEvent: event => events.push(event) } })
    const env = await runtime.enter(Entry)
    const timeout = await env.deps.stuck.load().then(() => 'resolved', error => error.code)
    for (let round = 0; round < 12 && !ran.includes('h'); round += 1) { global.gc(); await sleep(20) }
    const ranBeforeClose = [...ran]
    // The Env closes while the unreachable attempt's cleanup phase is still hanging.
    const closeError = await env.dispose().then(() => undefined, error => error)
    const markers = closeError ? [...closeError.errors].flatMap(function flat(e) { return e instanceof AggregateError ? e.errors.flatMap(flat) : [e] }).map(e => e.marker).filter(Boolean) : []
    releaseHang()
    await sleep(40)
    console.log(JSON.stringify({
      timeout,
      ranBeforeClose,
      determined: markers,
      unreachableEvents: events.filter(event => event.type === 'attempt-unreachable').length,
      abandonedPhases: events.filter(event => event.type === 'attempt-abandoned').map(event => event.phase),
      ledgerAfter: runtime.inspect().unsettledAttempts.length,
    }))
    await runtime.dispose().catch(() => undefined)
  `
  const result = await child(['--expose-gc', '--unhandled-rejections=strict'], script)
  assert.equal(result.code, 0, result.stderr)
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.equal(out.timeout, 'LOAD_TIMEOUT')
  assert.deepEqual(out.ranBeforeClose, ['a', 'h'], 'the unreachable diagnosis ran the cleanups; the second one hangs')
  assert.deepEqual(out.determined, ['a'], 'the failure the phase had already determined is reported by the close that stopped waiting for it')
  assert.deepEqual(out.abandonedPhases, ['rollback'], 'the abandonment names the phase')
  assert.equal(out.unreachableEvents, 1, 'attempt-unreachable is reported once, when the phase ends')
  assert.equal(out.ledgerAfter, 0)
})

// ---------------------------------------------------------------------------
// The four invariants of the acceptance criteria (task book §2.1), one by one.
// ---------------------------------------------------------------------------

test('N1 invariant 1: the close\'s own error set never repeats itself, and two cleanups that throw the same Error object are two failures', async () => {
  const define = makeDefine('rc4.n1.identity')
  const shared = marked('shared') // one Error object, thrown by two different cleanups
  const Service = define.service('s', {
    setup(_deps, { onDispose }) {
      onDispose(() => { throw shared })
      onDispose(() => { throw shared })
      onDispose(() => { throw marked('own') })
      return { ok: true }
    },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({ services: [Service], limits: { disposalGraceMs: GRACE } })
  const env = await runtime.enter(Entry)
  await env.deps.s.load()
  const closeError = await settledOutcome(env.dispose())
  const errors = flat(closeError)
  assert.equal(errors.length, 3, 'three cleanup executions failed, so the close reports three failures')
  assert.equal(errors.filter(error => error === shared).length, 2,
    'identity is the execution that failed, not the Error object: the same object thrown twice is two failures')
  assert.equal(new Set(errors).size, 2, 'and nothing was deduplicated behind our back')
  await runtime.dispose()
})

test('N1 invariant 2: an abandonment and its late end are each reported exactly once, whatever the phase does afterwards', async () => {
  const define = makeDefine('rc4.n1.once')
  const events = []
  const gates = []
  const ran = []
  const Service = define.service('s', {
    setup(_deps, { onDispose }) { phase([['a', 'throw'], ['h', 'hang'], ['b', 'throw']], onDispose, ran, gates); return { ok: true } },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({
    services: [Service],
    limits: { disposalGraceMs: GRACE },
    diagnostics: { onEvent: event => events.push(event.type) },
  })
  const env = await runtime.enter(Entry)
  await env.deps.s.load()
  await settledOutcome(env.dispose())
  await releaseAll(gates)
  assert.equal(events.filter(type => type === 'attempt-abandoned').length, 1)
  assert.equal(events.filter(type => type === 'attempt-failed-late').length, 1)
  await runtime.dispose()
  assert.equal(events.filter(type => type === 'attempt-abandoned').length, 1, 'runtime.dispose() adds no second report')
  await runtime.dispose()
})

test('N1 invariant 3: what the waiter got never decides whether the close reports — cancelled, timed out or gone', async () => {
  for (const how of ['cancelled', 'past-its-deadline', 'no-waiter']) {
    const define = makeDefine(`rc4.n1.waiter.${how}`)
    const events = []
    const ran = []
    const gates = []
    const setupGate = deferred()
    const Service = define.service('s', {
      failure: { attempts: 1 },
      loadTimeoutMs: how === 'past-its-deadline' ? 15 : 5_000,
      setup(_deps, { onDispose }) { phase([['a', 'throw'], ['h', 'hang']], onDispose, ran, gates); return setupGate.promise },
    })
    const Entry = define.entry({ requires: { s: Service } })
    const runtime = createRuntime({
      services: [Service],
      limits: { disposalGraceMs: GRACE },
      diagnostics: { onEvent: event => events.push(event.type) },
    })
    const env = await runtime.enter(Entry)
    const controller = new AbortController()
    let waiterOutcome = 'none'
    if (how !== 'no-waiter') {
      const waiting = env.deps.s.load(how === 'cancelled' ? { signal: controller.signal } : undefined)
        .then(() => 'resolved', error => error?.code ?? 'error')
      if (how === 'cancelled') { await sleep(5); controller.abort() }
      if (how === 'cancelled') waiterOutcome = await waiting
      else { await sleep(25); waiterOutcome = await waiting }
    }
    else {
      void env.deps.s.load().catch(() => undefined)
      await sleep(5)
    }
    const closing = settledOutcome(env.dispose())
    await sleep(5)
    setupGate.resolve(Promise.reject(new Error('setup failed')))
    const closeError = await closing
    assert.deepEqual(markersOf(closeError ?? new Error('none')), ['a'],
      `${how}: the close reports the failure it waited for, whatever the waiter received`)
    if (how === 'cancelled') assert.equal(waiterOutcome, 'LOAD_CANCELLED')
    if (how === 'past-its-deadline') assert.equal(waiterOutcome, 'LOAD_TIMEOUT')
    await releaseAll(gates)
    await runtime.dispose()
  }
})

test('N1 invariant 4 and the three moments: a failure before the close is the sequence\'s, one inside the close\'s wait is the close\'s, one after that budget is the late report\'s', async () => {
  const define = makeDefine('rc4.n1.moments')
  const events = []
  const ran = []
  const gates = []
  const setupGate = deferred()
  const Service = define.service('s', {
    failure: { attempts: 1 },
    setup(_deps, { onDispose }) { phase([['a', 'throw'], ['h', 'hang'], ['b', 'throw']], onDispose, ran, gates); return setupGate.promise },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({
    services: [Service],
    limits: { disposalGraceMs: GRACE },
    diagnostics: { onEvent: event => events.push(event) },
  })
  const env = await runtime.enter(Entry)
  const waiter = env.deps.s.load().then(() => 'resolved', error => error)
  await sleep(5)
  const closing = settledOutcome(env.dispose())
  await sleep(5)
  setupGate.resolve(Promise.reject(new Error('setup failed')))
  const closeError = await closing
  // Determined inside the close's wait → the close's.
  assert.deepEqual(markersOf(closeError), ['a'])
  await releaseAll(gates)
  const late = events.filter(event => event.type === 'attempt-failed-late')
  // Determined after that phase's budget → the late report's, and only that one.
  assert.deepEqual(late[0].cleanupErrors.map(item => item.marker), ['b'])
  assert.equal(markersOf(closeError).includes('b'), false, 'and never in the close that had already returned')
  await waiter
  await runtime.dispose()
})

test('N1 the three moments, before the close: a rollback that fails under a live owner is the sequence\'s failure, and the later close does not report it again', async () => {
  const define = makeDefine('rc4.n1.before')
  const events = []
  const Service = define.service('s', {
    failure: { attempts: 1 },
    setup(_deps, { onDispose }) {
      onDispose(() => { throw marked('a') })
      return Promise.reject(new Error('setup failed'))
    },
  })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({
    services: [Service],
    limits: { disposalGraceMs: GRACE },
    diagnostics: { onEvent: event => events.push(event.type) },
  })
  const env = await runtime.enter(Entry)
  const failure = await env.deps.s.load().then(() => undefined, error => error)
  assert.deepEqual(markersOf(failure), ['a'], 'the sequence reports the setup failure and its rollback together')
  assert.equal(events.filter(type => type === 'attempt-failed-late').length, 0, 'nothing is late about it')
  const closeError = await settledOutcome(env.dispose())
  assert.equal(closeError, undefined, 'the close reports nothing: the failure happened before it and was already reported')
  await runtime.dispose()
})
