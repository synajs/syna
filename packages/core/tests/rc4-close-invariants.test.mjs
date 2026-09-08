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
const deferred = () => { let resolve; const promise = new Promise(settle => { resolve = settle }); return { promise, resolve } }
const codeOf = promise => promise.then(() => 'resolved', error => error?.code ?? String(error?.message ?? error))
const GRACE = 60

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

const REENTRY = [
  { id: 'same Env, dispose()', target: 'self' },
  { id: 'same Env, Symbol.asyncDispose', target: 'self-async-dispose' },
  { id: 'same Env, runtime.dispose()', target: 'runtime' },
  { id: 'child Env re-enters its own close', target: 'child-self' },
  { id: 'child Env re-enters its parent', target: 'child-parent' },
]

for (const shape of REENTRY) {
  test(`N2 ${shape.id}: one close, the caller's Promise carries its cleanup failure, and nothing is reported twice`, async () => {
    const define = makeDefine(`rc4.n2.${shape.id.replaceAll(/[^a-z]+/gi, '-')}`)
    const events = []
    const holder = {}
    let cleanupRuns = 0
    const cleanup = () => { cleanupRuns += 1; throw new Error('cleanup failed') }
    const reenter = () => {
      const target = shape.target === 'runtime' ? holder.runtime
        : shape.target === 'child-parent' ? holder.root
        : shape.target === 'child-self' ? holder.child
        : holder.env
      holder.inner = shape.target === 'self-async-dispose' ? target[Symbol.asyncDispose]() : target.dispose()
      holder.inner.then(() => undefined, () => undefined)
    }
    const Service = listener(define, 's', reenter, { cleanup })
    const Root = define.entry('root', {})
    const Child = define.entry('child', { requires: { s: Service } })
    const runtime = createRuntime({
      services: [Service],
      limits: { disposalGraceMs: GRACE },
      diagnostics: { onEvent: event => events.push(event.type) },
    })
    holder.runtime = runtime
    const root = await runtime.enter(Root)
    holder.root = root
    const child = await root.enter(Child)
    holder.child = child
    holder.env = shape.target.startsWith('child') ? child : child
    await child.deps.s.load()

    const closed = shape.target === 'child-parent' || shape.target === 'runtime'
      ? await codeOf(root.dispose())
      : await codeOf(child.dispose())
    assert.notEqual(closed, 'resolved',
      'the Promise the caller awaited carries the cleanup failure: it is not the empty-handed half of a race')
    assert.equal(cleanupRuns, 1, 'the cleanup ran once, in one close')
    assert.equal(child.state, 'disposed')
    assert.equal(events.filter(type => type === 'attempt-abandoned').length, 0, 'nothing was abandoned: the cleanup was fast')
    await codeOf(holder.inner)
    assert.equal(cleanupRuns, 1, 'and the re-entering call joined that same close')
    assert.equal(runtime.inspect().unsettledAttempts.length, 0)
    await codeOf(runtime.dispose())
    assert.equal(events.filter(type => type === 'runtime-attempts-outstanding').length, 0)
  })
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
