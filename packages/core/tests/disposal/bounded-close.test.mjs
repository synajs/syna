// Regressions for the independent Promise/lifecycle audit (work/v05/audit/promise-lifecycle):
// F-PL-01 bounded disposal, F-PL-02 late onDispose, F-PL-03 subtree broadcast,
// F-PL-04 honest Env state, F-PL-05 dormant intermediates, F-PL-06 per-caller
// Promises, F-PL-07 pre-aborted signals. Each case pairs the counterexample with
// a legal control so the fix cannot be satisfied by refusing everything.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { createRuntime, definePackage } from '../../dist/index.js'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url))

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
const never = () => new Promise(() => undefined)
const timed = async fn => {
  const started = performance.now()
  const outcome = await fn().then(value => ({ ok: true, value }), error => ({ ok: false, error }))
  return { ...outcome, elapsedMs: performance.now() - started }
}

test('F-PL-01 dispose() of a non-cooperative setup is bounded by limits.disposalGraceMs, not by the initialization deadline', async () => {
  const define = makeDefine('v05.audit.bounded')
  const Stuck = define.service({ setup: never })
  const Entry = define.entry({ requires: { stuck: Stuck } })
  const runtime = createRuntime({
    services: [Stuck],
    limits: { loadTimeoutMs: 5_000, disposalGraceMs: 40 },
  })
  const env = await runtime.enter(Entry)
  void env.deps.stuck.load().catch(() => undefined)
  await sleep(5)
  const disposal = await timed(() => env.dispose())
  // 0.7 (S2): "dispose() rejects with the unsettled-attempt code" is withdrawn; the close fulfils and abandons the attempt.
  assert.equal(disposal.ok, true)
  assert.equal(env.state, 'disposed')
  assert.deepEqual(runtime.inspect().unsettledAttempts.map(item => item.state), ['abandoned'])
  assert.ok(disposal.elapsedMs < 1_000, `dispose() took ${disposal.elapsedMs} ms; the 5 s deadline must not apply`)
  await runtime.dispose()
})

test('F-PL-01 loadTimeoutMs: Infinity cannot turn a stuck setup into a hanging dispose(), enter() or run()', async () => {
  const define = makeDefine('v05.audit.infinite')
  const Stuck = define.service('stuck', { loadTimeoutMs: Infinity, setup: never })
  const Eager = define.service('eager', {
    eager: true,
    requires: { stuck: Stuck },
    setup({ stuck }) {
      void stuck.load().catch(() => undefined)
      throw new Error('eager boom')
    },
  })
  const Plain = define.entry('plain', { requires: { stuck: Stuck } })
  const WithEager = define.entry('with-eager', { requires: { eager: Eager } })
  const runtime = createRuntime({ services: [Stuck, Eager], limits: { disposalGraceMs: 40 } })

  const env = await runtime.enter(Plain)
  void env.deps.stuck.load().catch(() => undefined)
  const disposal = await timed(() => env.dispose())
  assert.equal(disposal.ok, true) // 0.7 (S2): the abandoned attempt is a ledger entry, not a close error
  assert.equal(env.state, 'disposed')
  assert.ok(disposal.elapsedMs < 1_000, `dispose() took ${disposal.elapsedMs} ms`)

  const entering = await timed(() => runtime.enter(WithEager))
  assert.equal(entering.ok, false)
  assert.equal(entering.error.code, 'ENTRY_ACTIVATION_FAILED')
  assert.match(entering.error.cause.message, /eager boom/)
  assert.ok(entering.elapsedMs < 1_000, `enter() took ${entering.elapsedMs} ms`)

  const running = await timed(() => runtime.run(Plain, ({ stuck }) => { void stuck.load().catch(() => undefined); return 'done' }))
  assert.deepEqual([running.ok, running.value], [true, 'done'], '0.7 (S2): run() returns the result; the abandoned attempt is on the ledger')
  assert.ok(running.elapsedMs < 1_000, `run() took ${running.elapsedMs} ms`)
  assert.equal(runtime.inspect().unsettledAttempts.length, 3, 'the plain Env, the rolled-back eager Env and the run() Env each left one attempt')
  await runtime.dispose()
})

test('F-PL-01 control: a cooperative setup that unwinds within the grace period disposes cleanly', async () => {
  const define = makeDefine('v05.audit.cooperative')
  const Cooperative = define.service({
    setup: (_deps, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => setTimeout(() => reject(new Error('unwound')), 10), { once: true })
    }),
  })
  const Entry = define.entry({ requires: { cooperative: Cooperative } })
  const runtime = createRuntime({ services: [Cooperative], limits: { disposalGraceMs: 500 } })
  const env = await runtime.enter(Entry)
  const loading = env.deps.cooperative.load().catch(error => error)
  await sleep(5)
  await env.dispose()
  assert.equal(env.state, 'disposed')
  assert.match((await loading).message, /unwound/)
  await runtime.dispose()
})

test('F-PL-02 onDispose() registered after the deadline passed belongs to the adopted instance and runs at disposal', async () => {
  // 0.7 (S1): the 0.6 assertion "the late-acquired resource is released right after the late result" is
  // withdrawn (docs/SEMANTIC_CHANGES_V07.md §撤回): under a ready owner the late result is adopted, so the
  // resource is the live instance's and the ordinary disposal releases it.
  const define = makeDefine('v05.audit.late-ondispose')
  const gate = deferred()
  const resource = { closed: false }
  const events = []
  const Slow = define.service({
    loadTimeoutMs: 20,
    async setup(_deps, { onDispose }) {
      await gate.promise
      onDispose(() => { resource.closed = true })
      return resource
    },
  })
  const Entry = define.entry({ requires: { slow: Slow } })
  const runtime = createRuntime({
    services: [Slow],
    diagnostics: { onEvent: event => events.push(event) },
  })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.slow.load(), error => error.code === 'LOAD_TIMEOUT')
  gate.resolve()
  await sleep(10)
  assert.equal(resource.closed, false, 'the late-acquired resource is the live instance, not an orphan')
  assert.strictEqual(await env.deps.slow.load(), resource)
  const late = events.find(event => event.type === 'attempt-succeeded-late')
  assert.ok(late, 'late result reported as a result, not as a runtime-injected failure')
  assert.equal(late.adopted, true)
  assert.deepEqual(late.cleanupErrors, [])
  assert.equal(events.some(event => event.type === 'attempt-failed-late'), false)
  await runtime.dispose()
  assert.equal(resource.closed, true, 'released by disposal')
})

test('F-PL-02 onDispose() registered after the owner closed mid-setup is still run once the setup settles', async () => {
  const define = makeDefine('v05.audit.late-ondispose-close')
  const gate = deferred()
  const closed = []
  const Slow = define.service({
    async setup(_deps, { onDispose }) {
      await gate.promise
      onDispose(() => closed.push('late-resource'))
      return {}
    },
  })
  const Entry = define.entry({ requires: { slow: Slow } })
  const runtime = createRuntime({ services: [Slow], limits: { disposalGraceMs: 20 } })
  const env = await runtime.enter(Entry)
  void env.deps.slow.load().catch(() => undefined)
  await sleep(5)
  await env.dispose() // 0.7 (S2): fulfils; the attempt is abandoned onto the ledger
  gate.resolve()
  await sleep(10)
  assert.deepEqual(closed, ['late-resource'])
  await runtime.dispose().catch(() => undefined)
})

test('F-PL-02 control: onDispose() from a stale lifecycle after the setup settled is still refused', async () => {
  const define = makeDefine('v05.audit.stale-lifecycle')
  let stale
  const Svc = define.service({
    setup(_deps, lifecycle) {
      stale = lifecycle
      return {}
    },
  })
  const Entry = define.entry({ requires: { svc: Svc } })
  const runtime = createRuntime({ services: [Svc] })
  const env = await runtime.enter(Entry)
  await env.deps.svc.load()
  assert.throws(() => stale.onDispose(() => undefined), error => error.code === 'LIFECYCLE_MISUSE')
  await runtime.dispose()
})

test('F-PL-03 an ancestor closing broadcasts the stop signal to every descendant before waiting on any of them', async () => {
  const define = makeDefine('v05.audit.broadcast')
  const slowCleanup = deferred()
  const log = []
  const SlowService = define.service('slow', {
    setup(_deps, { onDispose }) {
      onDispose(async () => { log.push('c1-cleanup-start'); await slowCleanup.promise; log.push('c1-cleanup-end') })
      return {}
    },
  })
  const Lazy = define.service('lazy', { setup: () => { log.push('lazy-start'); return {} } })
  const Watcher = define.service('watcher', {
    setup(_deps, { signal }) {
      signal.addEventListener('abort', () => log.push('c2-signal'), { once: true })
      return {}
    },
  })
  const Root = define.entry('root', {})
  const Child1 = define.entry('child1', { requires: { slow: SlowService } })
  const Child2 = define.entry('child2', { requires: { lazy: Lazy, watcher: Watcher } })
  const runtime = createRuntime({ services: [SlowService, Lazy, Watcher] })
  const root = await runtime.enter(Root)
  const child1 = await root.enter(Child1)
  await child1.deps.slow.load()
  const child2 = await root.enter(Child2)
  await child2.deps.watcher.load()

  const disposing = root.dispose()
  assert.equal(child2.state, 'disposing', 'the sibling is closing immediately, not after child1 finished')
  assert.ok(log.includes('c2-signal'), 'the sibling saw the stop signal before anything was awaited')
  await assert.rejects(child2.deps.lazy.load(), error => error.code === 'ENV_CLOSED')
  await assert.rejects(child2.derive(), error => error.code === 'ENV_CLOSED')
  await assert.rejects(root.enter(Child2), error => error.code === 'ENV_CLOSED')
  assert.equal(log.includes('lazy-start'), false, 'no new attempt started inside a closing subtree')
  slowCleanup.resolve()
  await disposing
  assert.deepEqual([root.state, child1.state, child2.state], ['disposed', 'disposed', 'disposed'])
  assert.equal(runtime.inspect().liveEnvCount, 0)
  await runtime.dispose()
})

test('F-PL-03 runtime.dispose() closes independent roots concurrently, bounded by the slowest', async () => {
  const define = makeDefine('v05.audit.concurrent-roots')
  const SlowClose = define.service({
    setup(_deps, { onDispose }) {
      onDispose(() => sleep(150))
      return {}
    },
  })
  const Entry = define.entry({ requires: { slow: SlowClose } })
  const runtime = createRuntime({ services: [SlowClose] })
  const roots = await Promise.all([1, 2, 3, 4].map(() => runtime.enter(Entry)))
  await Promise.all(roots.map(root => root.deps.slow.load()))
  const closing = await timed(() => runtime.dispose())
  assert.equal(closing.ok, true)
  // sequential closing would take ≥ 600 ms; concurrent closing takes ≈ 150 ms — the bound sits between them with margin on both sides
  assert.ok(closing.elapsedMs >= 140 && closing.elapsedMs < 450, `four 150 ms cleanups took ${closing.elapsedMs} ms; they must overlap`)
  assert.equal(runtime.inspect().liveEnvCount, 0)
})

test('F-PL-04 an Env whose close abandoned an attempt is disposed and uncounted; the ledger accounts for the attempt until its late result is cleaned up', async () => {
  const define = makeDefine('v05.audit.honest-state')
  const gate = deferred()
  const events = []
  const Slow = define.service({
    loadTimeoutMs: 20,
    async setup(_deps, { onDispose }) {
      onDispose(() => events.push('cleanup'))
      await gate.promise
      return {}
    },
  })
  const Entry = define.entry({ requires: { slow: Slow } })
  const runtime = createRuntime({
    services: [Slow],
    limits: { disposalGraceMs: 20 },
    diagnostics: { onEvent: event => events.push(event.type) },
  })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.slow.load(), error => error.code === 'LOAD_TIMEOUT')
  // 0.7 (S2): the 0.6 assertions "dispose() rejects with the unsettled-attempt code" and "state stays
  // 'disposing' until the late result is cleaned up" are withdrawn (docs/SEMANTIC_CHANGES_V07.md §撤回).
  await env.dispose()

  assert.equal(env.state, 'disposed', 'the bounded close is complete; the outstanding resource is on the ledger')
  assert.equal(env.inspect().nodes[0].state, 'abandoned')
  assert.deepEqual(env.inspect().abandonedAttempts.map(item => item.state), ['abandoned'])
  // Second review round: the bounded close is also the end of the Runtime's hold on
  // the Env. It leaves the registries; the outstanding attempt is accounted for in
  // the ledger instead (env id, slot, revision, state, running time).
  assert.deepEqual(
    [runtime.inspect().rootEnvCount, runtime.inspect().liveEnvCount],
    [0, 0],
    'the Runtime retains no closed Env',
  )
  const [outstanding] = runtime.inspect().unsettledAttempts
  assert.equal(runtime.inspect().unsettledAttempts.length, 1)
  assert.equal(outstanding.env, env.id)
  assert.equal(outstanding.state, 'abandoned')
  assert.match(outstanding.revision, /honest-state/)
  await runtime.dispose()
  // runtime.dispose() fulfils and reports the outstanding attempt from the ledger once, as a diagnostic.
  assert.deepEqual(events.filter(event => event !== 'cleanup'), ['attempt-overdue', 'attempt-abandoned', 'runtime-attempts-outstanding'])

  gate.resolve()
  await sleep(10)
  assert.equal(env.state, 'disposed')
  assert.equal(env.inspect().nodes[0].state, 'disposed')
  assert.deepEqual(env.inspect().abandonedAttempts, [])
  // 0.7 (S1): the waiter's timeout marked the attempt overdue before the close abandoned it.
  assert.deepEqual(events.filter(event => event !== 'cleanup'), ['attempt-overdue', 'attempt-abandoned', 'runtime-attempts-outstanding', 'attempt-succeeded-late'])
  assert.ok(events.includes('cleanup'))
  assert.equal(runtime.inspect().liveEnvCount, 0)
  assert.equal(runtime.inspect().unsettledAttempts.length, 0)
})

test('F-PL-04 a parent whose child abandoned an attempt: both are disposed at the end of their bounded close; only the child lists the attempt', async () => {
  const define = makeDefine('v05.audit.parent-honest')
  const gate = deferred()
  const Slow = define.service({
    async setup() { await gate.promise; return {} },
  })
  const Root = define.entry('root', {})
  const Child = define.entry('child', { requires: { slow: Slow } })
  const runtime = createRuntime({ services: [Slow], limits: { disposalGraceMs: 20 } })
  const root = await runtime.enter(Root)
  const child = await root.enter(Child)
  void child.deps.slow.load().catch(() => undefined)
  await sleep(5)
  await root.dispose() // 0.7 (S2): fulfils; the 0.6 assertion "both stay 'disposing'" is withdrawn
  assert.deepEqual([root.state, child.state], ['disposed', 'disposed'])
  assert.deepEqual([root.inspect().abandonedAttempts.length, child.inspect().abandonedAttempts.length], [0, 1])
  assert.equal(runtime.inspect().liveEnvCount, 0, 'both completed their bounded close and left the registries')
  assert.equal(runtime.inspect().unsettledAttempts.length, 1)
  gate.resolve()
  await sleep(10)
  assert.deepEqual([root.state, child.state], ['disposed', 'disposed'])
  assert.equal(runtime.inspect().unsettledAttempts.length, 0)
  assert.deepEqual(child.inspect().abandonedAttempts, [])
  await runtime.dispose()
})

test('F-PL-05 disposal order follows a dependency that passes through a never-started slot', async () => {
  const define = makeDefine('v05.audit.dormant-middle')
  const order = []
  const C = define.service('c', { setup: (_deps, { onDispose }) => { onDispose(() => order.push('C')); return { name: 'C' } } })
  const B = define.service('b', { requires: { c: C }, setup: () => ({ name: 'B' }) })
  const A = define.service('a', {
    requires: { b: B },
    setup: (_deps, { onDispose }) => { onDispose(() => order.push('A')); return { name: 'A' } },
  })
  const Entry = define.entry({ requires: { a: A, c: C, b: B } })
  const runtime = createRuntime({ services: [A, B, C] })
  const env = await runtime.enter(Entry)
  await env.deps.c.load()
  await env.deps.a.load()
  await env.dispose()
  assert.deepEqual(order, ['A', 'C'], 'dependant A closes before its transitive dependency C')
  await runtime.dispose()
})

test('F-PL-06 a load() Promise that nobody handles is an unhandled rejection whether it joined a running attempt or hit a failed slot', async () => {
  const script = `
    import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
    const define = definePackage({ name: '@v05/audit-unhandled', version: '1.0.0', syna: { id: 'v05.audit.unhandled' } })
    const gate = new Promise(resolve => setTimeout(resolve, 10))
    const Failing = define.service({ async setup() { await gate; throw new Error('setup failed') } })
    const Entry = define.entry({ requires: { failing: Failing } })
    const runtime = createRuntime({ services: [Failing] })
    const env = await runtime.enter(Entry)
    const mode = process.argv[1]
    if (mode === 'joined') {
      void env.deps.failing.load().catch(() => undefined) // the attempt owner handles its own copy
      env.deps.failing.load()                              // this caller forgets to
    }
    else if (mode === 'handled') {
      void env.deps.failing.load().catch(() => undefined)
      env.deps.failing.load().catch(() => undefined)
    }
    await new Promise(resolve => setTimeout(resolve, 60))
    if (mode === 'failed-slot') env.deps.failing.load()
    await new Promise(resolve => setTimeout(resolve, 20))
    await runtime.dispose()
    console.log('exit-normally')
  `
  const invoke = mode => run(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script, mode])
    .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
  const [joined, failedSlot, handled] = await Promise.all([invoke('joined'), invoke('failed-slot'), invoke('handled')])
  assert.equal(joined.code, 1, 'forgotten Promise on a running attempt surfaces')
  assert.match(joined.stderr, /setup failed/)
  assert.equal(failedSlot.code, 1, 'forgotten Promise on a failed slot surfaces')
  assert.match(failedSlot.stderr, /setup failed/)
  assert.equal(handled.code, 0, 'handled Promises produce no unhandled rejection')
  assert.match(handled.stdout, /exit-normally/)
})

test('F-PL-06 every caller receives its own Promise; the shared attempt is still one', async () => {
  const define = makeDefine('v05.audit.own-promise')
  let setups = 0
  const Svc = define.service({ async setup() { setups += 1; await sleep(5); return { id: setups } } })
  const Entry = define.entry({ requires: { svc: Svc } })
  const runtime = createRuntime({ services: [Svc] })
  const env = await runtime.enter(Entry)
  const first = env.deps.svc.load()
  const second = env.deps.svc.load()
  assert.notStrictEqual(first, second)
  assert.strictEqual(await first, await second)
  assert.equal(setups, 1)
  await runtime.dispose()
})

test('F-PL-07 load() with an already-aborted signal starts nothing', async () => {
  const define = makeDefine('v05.audit.pre-aborted')
  let setups = 0
  const Svc = define.service({ setup: () => { setups += 1; return {} } })
  const Entry = define.entry({ requires: { svc: Svc } })
  const runtime = createRuntime({ services: [Svc] })
  const env = await runtime.enter(Entry)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(env.deps.svc.load({ signal: controller.signal }), error => error.code === 'LOAD_CANCELLED')
  assert.equal(setups, 0)
  assert.equal(env.inspect().nodes[0].state, 'dormant')
  // Control: a live signal loads normally and the slot becomes Ready once.
  await env.deps.svc.load({ signal: new AbortController().signal })
  assert.equal(setups, 1)
  await runtime.dispose()
})
