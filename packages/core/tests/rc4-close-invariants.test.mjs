// 1.0.0-rc.4 / N2 + N3 — the close publishes itself before any user code runs.
//
// `abortController.abort()` executes its listeners synchronously, and the abort
// signal is the documented cancellation path handed to every `setup()`. Two halves
// of the close were not established yet when those listeners ran (work/rc4/BASELINE.md
// §2 and §3): the Promise of this close (`??=` assigned it only after `disposeEnv()`
// had returned, so a re-entering listener started a second close that raced the
// first for the same slots — and a cleanup failure could end up in whichever of the
// two nobody awaited), and the close set itself (marking and aborting were one
// depth-first pass, so a listener saw descendants that were still `ready` and could
// start a dormant Service inside the set being closed).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage } from '../dist/index.js'

const makeDefine = id => definePackage({ name: `@rc4/${id.replaceAll('.', '-')}`, version: '1.0.0', syna: { id } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(settle => { resolve = settle }); return { promise, resolve } }
const codeOf = promise => promise.then(() => 'resolved', error => error?.code ?? String(error?.message ?? error))
const flat = error => (error instanceof AggregateError ? error.errors.flatMap(flat) : [error])
/** What a Promise has done so far, read without awaiting it. */
const track = promise => {
  const state = { settled: 'pending', reason: undefined }
  promise.then(() => { state.settled = 'fulfilled' }, error => { state.settled = 'rejected'; state.reason = error })
  return state
}
const GRACE = 60
/**
 * The budget of the re-entry matrix below, which holds its cleanup open on purpose:
 * long enough that the close cannot reach the end of its grace while the assertions
 * that it has *not* ended yet are being made. Each of those tests carries a watchdog
 * of its own (`{ timeout }`), which is a test harness limit and never a deadline the
 * model promises.
 */
const HELD = 5_000

/** A Service whose setup registers `onAbort` on the owner's stop signal. */
const listener = (define, name, onAbort, options = {}) => define.service(name, {
  ...options,
  setup(_deps, { signal, onDispose }) {
    if (options.cleanup) onDispose(options.cleanup)
    signal.addEventListener('abort', onAbort, { once: true })
    return { name }
  },
})

// ---------------------------------------------------------------------------
// N2 — one close, whoever calls it and from where.
// ---------------------------------------------------------------------------

/**
 * The eight paths a user callback can re-enter a close from (the independent review
 * of rc.4 enumerated them): `outer` is the close the test starts, `inner` the close
 * the abort listener of a Service inside the child Env starts from within it.
 *
 * Every cell asserts the same four things, because the third review showed that the
 * rc.4 assertions did not: an implementation where both `joinClose()` methods yield
 * one microtask and then fulfil — the re-entering caller succeeds early while the
 * real close runs on and reports its cleanup failure only to the caller that started
 * it — passed all 55 of the rc.4 cases (`work/rc5/BASELINE.md`). What rejects it is
 * asserting the *inner* observer: that it is still waiting while the cleanup is, and
 * that it is answered with the same failure afterwards.
 *
 * Deliberately NOT asserted: that the two observers receive the same Error object. A
 * parent's close and the Runtime's own aggregate what their children report, so the
 * cleanup failure may sit one layer deeper for one of them; what the model promises
 * is that the failure reaches both, and once each.
 */
const REENTRY = [
  { id: 'same Env', outer: 'child', inner: 'child' },
  { id: 'same Env through Symbol.asyncDispose', outer: 'child', inner: 'child', asyncDispose: true },
  { id: 'a child Env, re-entering its parent', outer: 'child', inner: 'root' },
  { id: 'a parent Env, re-entering its child', outer: 'root', inner: 'child' },
  { id: 'a root Env, re-entering that same root', outer: 'root', inner: 'root' },
  { id: 'a root Env, re-entering the Runtime', outer: 'root', inner: 'runtime' },
  { id: 'the Runtime, re-entering the Runtime', outer: 'runtime', inner: 'runtime' },
  { id: 'the Runtime, re-entering a child Env', outer: 'runtime', inner: 'child' },
]

for (const shape of REENTRY) {
  for (const ending of ['a cleanup that fails', 'a cleanup that succeeds']) {
    const fails = ending === 'a cleanup that fails'
    test(`N2 ${shape.id} / ${ending}: neither observer settles before the cleanup does, and both are answered by that one close`,
      { timeout: 20_000 }, async () => {
        const define = makeDefine(`rc4.n2.${shape.id.replaceAll(/[^a-z]+/gi, '-')}.${fails ? 'fails' : 'ok'}`)
        const holder = {}
        const gate = deferred()
        const entered = deferred()
        const failure = Object.assign(new Error(`cleanup of ${shape.id} failed`), { marker: shape.id })
        let cleanups = 0
        let dormantSetups = 0
        const Dormant = define.service('dormant', { setup() { dormantSetups += 1; return { ok: true } } })
        const Listening = define.service('listening', {
          requires: { dormant: Dormant },
          setup({ dormant }, { signal, onDispose }) {
            onDispose(async () => {
              cleanups += 1
              entered.resolve()
              await gate.promise
              if (fails) throw failure
            })
            signal.addEventListener('abort', () => {
              holder.stateAtAbort = holder.child.state
              // N3 in the same breath: the close set refuses new work before any listener runs.
              holder.refused = codeOf(dormant.load())
              const target = holder[shape.inner]
              holder.innerPromise = shape.asyncDispose ? target[Symbol.asyncDispose]() : target.dispose()
              holder.inner = track(holder.innerPromise)
            }, { once: true })
            return { ok: true }
          },
        })
        const Root = define.entry('root', {})
        const Child = define.entry('child', { requires: { listening: Listening, dormant: Dormant } })
        const runtime = createRuntime({ services: [Listening, Dormant], limits: { disposalGraceMs: HELD } })
        holder.runtime = runtime
        holder.root = await runtime.enter(Root)
        holder.child = await holder.root.enter(Child)
        await holder.child.deps.listening.load()

        const outerPromise = holder[shape.outer].dispose()
        const outer = track(outerPromise)
        await entered.promise
        await turn()
        await turn()

        // 1. While the cleanup is still running, neither observer has been answered.
        assert.equal(cleanups, 1, 'one close, so the cleanup ran once')
        assert.equal(outer.settled, 'pending', 'the caller that started the close is still waiting for it')
        assert.equal(holder.inner.settled, 'pending',
          'and so is the caller that re-entered it: joining a close means waiting for it, not being let go early')
        assert.equal(holder.stateAtAbort, 'disposing', 'the close set was marked before any listener ran')
        assert.equal(holder.child.state, 'disposing', 'nothing is declared disposed while its own cleanup runs')
        assert.equal(await holder.refused, 'ENV_CLOSED')
        assert.equal(dormantSetups, 0, 'and nothing inside the close set was started')

        gate.resolve()
        const [outerEnd, innerEnd] = await Promise.allSettled([outerPromise, holder.innerPromise])

        // 2. Both are answered by that one close, with what it determined.
        if (fails) {
          assert.equal(outerEnd.status, 'rejected', 'the close reports its cleanup failure')
          assert.equal(innerEnd.status, 'rejected', 'to the re-entering caller as well')
          assert.equal(flat(outerEnd.reason).filter(error => error === failure).length, 1,
            'the failure the cleanup produced, once')
          assert.equal(flat(innerEnd.reason).filter(error => error === failure).length, 1,
            'the same failure, once, however many layers of aggregation are between')
        }
        else {
          assert.equal(outerEnd.status, 'fulfilled')
          assert.equal(innerEnd.status, 'fulfilled', 'a close that had nothing to report fulfils for both observers')
        }
        assert.equal(cleanups, 1, 'and there was never a second close over the same slots')
        assert.equal(holder.child.state, 'disposed')
        assert.equal(runtime.inspect().unsettledAttempts.length, 0)
        await codeOf(runtime.dispose())
      })
  }
}

test('N2 a listener that re-enters runtime.dispose() gets one Runtime close: runtime-attempts-outstanding is reported once', async () => {
  const define = makeDefine('rc4.n2.runtime-once')
  const events = []
  const holder = {}
  const hang = deferred()
  const Service = listener(define, 's', () => { holder.inner = codeOf(holder.runtime.dispose()) }, { cleanup: () => hang.promise })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({
    services: [Service],
    limits: { disposalGraceMs: GRACE },
    diagnostics: { onEvent: event => events.push(event.type) },
  })
  holder.runtime = runtime
  const env = await runtime.enter(Entry)
  await env.deps.s.load()
  await codeOf(runtime.dispose())
  await codeOf(holder.inner)
  assert.equal(events.filter(type => type === 'runtime-attempts-outstanding').length, 1,
    'one Runtime close, so one diagnostic — two flows reported it twice before')
  assert.equal(events.filter(type => type === 'attempt-abandoned').length, 1)
  hang.resolve()
  await sleep(20)
})

test('N2 a listener re-entering the close of a sibling root closes that root on its own, and each tree keeps one close', async () => {
  const define = makeDefine('rc4.n2.siblings')
  const events = []
  const holder = {}
  const Quiet = define.service('quiet', { setup(_deps, { onDispose }) { onDispose(() => { holder.otherCleanups = (holder.otherCleanups ?? 0) + 1 }); return { ok: true } } })
  const Service = listener(define, 's', () => { holder.inner = codeOf(holder.other.dispose()) }, { cleanup: () => { holder.ownCleanups = (holder.ownCleanups ?? 0) + 1 } })
  const First = define.entry('first', { requires: { s: Service } })
  const Second = define.entry('second', { requires: { quiet: Quiet } })
  const runtime = createRuntime({ services: [Service, Quiet], limits: { disposalGraceMs: GRACE }, diagnostics: { onEvent: event => events.push(event.type) } })
  const first = await runtime.enter(First)
  const second = await runtime.enter(Second)
  holder.other = second
  await first.deps.s.load()
  await second.deps.quiet.load()
  await codeOf(first.dispose())
  await codeOf(holder.inner)
  assert.equal(holder.ownCleanups, 1)
  assert.equal(holder.otherCleanups, 1, 'the sibling root closed once')
  assert.equal(second.state, 'disposed')
  assert.equal(runtime.inspect().rootEnvCount, 0)
  await codeOf(runtime.dispose())
})

test('N2 onEvent that re-enters dispose() joins the same close, exactly as it did before', async () => {
  const define = makeDefine('rc4.n2.onevent')
  const holder = {}
  let cleanups = 0
  const Service = define.service('s', { setup(_deps, { onDispose }) { onDispose(() => { cleanups += 1 }); return { ok: true } } })
  const Entry = define.entry({ requires: { s: Service } })
  const runtime = createRuntime({
    services: [Service],
    limits: { disposalGraceMs: GRACE },
    diagnostics: { onEvent: () => { holder.inner ??= codeOf(holder.env.dispose()) } },
  })
  const env = await runtime.enter(Entry)
  holder.env = env
  await env.deps.s.load()
  await codeOf(env.dispose())
  assert.equal(cleanups, 1)
  await codeOf(runtime.dispose())
})

test('N2/N3 the activation-failure path: the Env `enterFrom` closes is already marked when the listener runs, and its eager slot is cleaned up once', async () => {
  const define = makeDefine('rc4.n2.activation')
  const holder = { setups: 0 }
  let cleanups = 0
  const Dormant = define.service('dormant', { setup() { holder.setups += 1; return { ok: true } } })
  const Listening = define.service('listening', {
    eager: true,
    requires: { dormant: Dormant },
    setup({ dormant }, { signal, onDispose }) {
      onDispose(() => { cleanups += 1 })
      // The Env handle does not exist yet — `enter()` has not returned — so the only
      // thing a listener can do here is start work through the refs it already has.
      signal.addEventListener('abort', () => { holder.load = codeOf(dormant.load()) }, { once: true })
      return { ok: true }
    },
  })
  const Failing = define.service('failing', { eager: true, setup() { return Promise.reject(new Error('eager failure')) } })
  const Entry = define.entry({ requires: { listening: Listening, failing: Failing, dormant: Dormant } })
  const runtime = createRuntime({ services: [Dormant, Listening, Failing], limits: { disposalGraceMs: GRACE } })
  const outcome = await runtime.enter(Entry).then(() => 'entered', error => error)
  assert.equal(outcome.code, 'ENTRY_ACTIVATION_FAILED')
  assert.equal(await holder.load, 'ENV_CLOSED', 'the Env `enterFrom` disposes is marked before the listener runs')
  assert.equal(holder.setups, 0, 'so the dormant sibling never ran its setup()')
  assert.equal(cleanups, 1, 'the eager slot that did start is cleaned up exactly once')
  assert.equal(runtime.inspect().liveEnvCount, 0)
  await codeOf(runtime.dispose())
})

// ---------------------------------------------------------------------------
// N3 — the close set refuses new work before any listener runs.
// ---------------------------------------------------------------------------

const DORMANT = [
  { id: 'parent listener, child Env', close: 'root', where: 'child' },
  { id: 'parent listener, grandchild Env', close: 'root', where: 'grandchild' },
  { id: 'child listener, its own Env', close: 'root', where: 'self' },
  { id: 'runtime.dispose(), a second root', close: 'runtime', where: 'other-root' },
]

for (const shape of DORMANT) {
  test(`N3 ${shape.id}: the dormant Service is refused with ENV_CLOSED and its setup() never runs`, async () => {
    const define = makeDefine(`rc4.n3.${shape.id.replaceAll(/[^a-z]+/gi, '-')}`)
    const holder = { setups: 0, states: [] }
    const Dormant = define.service('dormant', { setup() { holder.setups += 1; return { ok: true } } })
    const Listening = listener(define, 'listening', () => {
      const target = holder[shape.where]
      holder.stateAtAbort = target.state
      holder.load = codeOf(target.deps.dormant.load())
    })
    const Root = define.entry('root', { requires: { listening: Listening, dormant: Dormant } })
    const Child = define.entry('child', { requires: { dormant: Dormant } })
    const runtime = createRuntime({ services: [Dormant, Listening], limits: { disposalGraceMs: GRACE } })
    const root = await runtime.enter(Root)
    await root.deps.listening.load()
    const child = await root.enter(Child)
    const grandchild = await child.enter(Child)
    holder.self = root
    holder.child = child
    holder.grandchild = grandchild
    if (shape.where === 'other-root') holder['other-root'] = await runtime.enter(Child)

    await codeOf(shape.close === 'runtime' ? runtime.dispose() : root.dispose())
    assert.equal(holder.stateAtAbort, 'disposing',
      'the whole close set was marked before any listener ran')
    assert.equal(await holder.load, 'ENV_CLOSED')
    assert.equal(holder.setups, 0, 'and setup() never executed: nothing was acquired to be discarded later')
    await codeOf(runtime.dispose())
    assert.equal(runtime.inspect().liveEnvCount, 0, 'no Env escaped the close')
  })
}

test('N3 reverse assertion: closing one tree leaves another root usable — a listener may still load() there', async () => {
  const define = makeDefine('rc4.n3.reverse')
  const holder = { setups: 0 }
  const Dormant = define.service('dormant', { setup() { holder.setups += 1; return { ok: true } } })
  const Listening = listener(define, 'listening', () => { holder.load = codeOf(holder.other.deps.dormant.load()) })
  const First = define.entry('first', { requires: { listening: Listening } })
  const Second = define.entry('second', { requires: { dormant: Dormant } })
  const runtime = createRuntime({ services: [Dormant, Listening], limits: { disposalGraceMs: GRACE } })
  const first = await runtime.enter(First)
  await first.deps.listening.load()
  holder.other = await runtime.enter(Second)
  await codeOf(first.dispose())
  assert.equal(await holder.load, 'resolved', 'the other root is not being closed, so it still accepts work')
  assert.equal(holder.setups, 1)
  assert.equal(holder.other.state, 'ready')
  await codeOf(runtime.dispose())
})

test('N3 a listener that enters a new Env inside the close set is refused, and no Env escapes', async () => {
  const define = makeDefine('rc4.n3.enter')
  const holder = { setups: 0 }
  const Dormant = define.service('dormant', { eager: true, setup() { holder.setups += 1; return { ok: true } } })
  const Listening = listener(define, 'listening', () => { holder.entered = codeOf(holder.child.enter(holder.Sub)) })
  const Root = define.entry('root', { requires: { listening: Listening } })
  const Child = define.entry('child', {})
  const Sub = define.entry('sub', { requires: { dormant: Dormant } })
  const runtime = createRuntime({ services: [Dormant, Listening], limits: { disposalGraceMs: GRACE } })
  const root = await runtime.enter(Root)
  await root.deps.listening.load()
  holder.child = await root.enter(Child)
  holder.Sub = Sub
  await codeOf(root.dispose())
  assert.equal(await holder.entered, 'ENV_CLOSED', 'the refusal comes from planning, before anything is built')
  assert.equal(holder.setups, 0)
  assert.equal(runtime.inspect().liveEnvCount, 0, 'no Env created by a listener escaped the close set')
  assert.equal(runtime.inspect().rootEnvCount, 0)
  await codeOf(runtime.dispose())
})

test('N3 the close-time bound is the Runtime\'s: a listener cannot add a grace period to it', async () => {
  const define = makeDefine('rc4.n3.bound')
  const holder = {}
  const hang = deferred()
  const Dormant = define.service('dormant', {
    setup(_deps, { onDispose }) { holder.started = true; onDispose(() => hang.promise); return { ok: true } },
  })
  const Listening = listener(define, 'listening', () => { holder.load = codeOf(holder.child.deps.dormant.load()) })
  const Root = define.entry('root', { requires: { listening: Listening } })
  const Child = define.entry('child', { requires: { dormant: Dormant } })
  const runtime = createRuntime({ services: [Dormant, Listening], limits: { disposalGraceMs: 80 } })
  const root = await runtime.enter(Root)
  await root.deps.listening.load()
  holder.child = await root.enter(Child)
  const started = Date.now()
  await codeOf(root.dispose())
  const elapsed = Date.now() - started
  assert.equal(holder.started, undefined, 'the listener could not start the hanging setup at all')
  assert.ok(elapsed < 60, `so the close cost no grace period of its own (${elapsed} ms, budget 80 ms)`)
  assert.equal(runtime.inspect().unsettledAttempts.length, 0)
  await codeOf(runtime.dispose())
})
