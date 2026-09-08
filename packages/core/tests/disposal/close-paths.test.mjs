// The independent audit of 1.0.0-rc.2 (probes reconstructed in
// work/rc3/probes/core-lifecycle.mjs, baseline in work/rc3/BASELINE.md), flipped:
// each case asserts the correct behaviour where the probe asserted the defect.
// RC2-L1 the cleanup of a Ready slot is part of the bounded close;
// RC2-L2 / RC2-L2b every cleanup failure the close waited for is reported exactly
// once, whatever became of the waiter; RC2-L3 nothing the Runtime keeps reaches a
// closed Env's graph.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { createRuntime, definePackage } from '../../dist/index.js'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
const child = (flags, script, ...args) =>
  run(process.execPath, [...flags, '--input-type=module', '-e', script, ...args])
    .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))

const makeDefine = id => definePackage({ name: `@rc3/${id.replaceAll('.', '-')}`, version: '1.0.0', syna: { id } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(2)
  }
}
const stateOf = (env, name) => env.inspect().nodes.find(node => node.label.includes(`/${name}@`))?.state

test('RC2-L1 a hung Ready-slot cleanup is abandoned by the bounded close: the Env is disposed, its dependencies are disposed in order, and the late end leaves the ledger', async () => {
  const define = makeDefine('rc3.l1.hung-cleanup')
  const events = []
  const order = []
  let releaseHung
  const Deep = define.service('deep', {
    setup(_deps, { onDispose }) { onDispose(() => { order.push('deep') }); return { deep: true } },
  })
  const Middle = define.service('middle', {
    requires: { deep: Deep },
    async setup({ deep }, { onDispose }) { await deep.load(); onDispose(() => { order.push('middle') }); return { middle: true } },
  })
  const Hung = define.service('hung', {
    requires: { middle: Middle },
    async setup({ middle }, { onDispose }) {
      await middle.load()
      onDispose(() => new Promise(resolve => {
        order.push('hung-started')
        releaseHung = () => { order.push('hung-ended'); resolve() }
      }))
      return { hung: true }
    },
  })
  const Entry = define.entry({ requires: { hung: Hung } })
  const runtime = createRuntime({
    services: [Hung, Middle, Deep],
    limits: { disposalGraceMs: 60 },
    diagnostics: { onEvent: event => events.push(event) },
  })
  const env = await runtime.enter(Entry)
  await env.deps.hung.load()

  const started = Date.now()
  await env.dispose() // fulfils: an abandoned cleanup is not an error of the close
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 55 && elapsed < 400, `one cleanup budget, not an unbounded wait (took ${elapsed} ms)`)
  assert.equal(env.state, 'disposed')
  assert.deepEqual(order, ['hung-started', 'middle', 'deep'], 'the dependencies of the abandoned cleanup are disposed in the normal order')

  const abandoned = events.filter(event => event.type === 'attempt-abandoned')
  assert.equal(abandoned.length, 1)
  assert.equal(abandoned[0].phase, 'cleanup')
  assert.match(abandoned[0].revision, /hung/)
  assert.equal(abandoned[0].env, env.id)
  assert.ok(abandoned[0].elapsedMs >= 55)
  assert.deepEqual(abandoned[0].dependencies.map(dependency => [dependency.dependency, dependency.state]), [['middle', 'ready']],
    'the report names the dependency it may still use, in the state it was in')

  const ledger = runtime.inspect().unsettledAttempts
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].state, 'abandoned')
  assert.match(ledger[0].revision, /hung/)
  assert.equal(ledger[0].env, env.id)
  assert.deepEqual(env.inspect().abandonedAttempts.map(entry => entry.slot), [ledger[0].slot])
  assert.equal(stateOf(env, 'hung'), 'abandoned', 'the slot says the close stopped waiting for it')
  assert.equal(stateOf(env, 'middle'), 'disposed')

  releaseHung()
  await waitFor(() => runtime.inspect().unsettledAttempts.length === 0)
  assert.deepEqual(order, ['hung-started', 'middle', 'deep', 'hung-ended'])
  assert.equal(stateOf(env, 'hung'), 'disposed')
  assert.equal(events.filter(event => event.type === 'attempt-failed-late').length, 0, 'a clean late end is not a failure')
  assert.equal(env.state, 'disposed', 'no later event changes the state')
  await runtime.dispose()
})

test('RC2-L1 an abandoned cleanup that fails late is reported by attempt-failed-late, never by the dispose() that stopped waiting for it', async () => {
  const define = makeDefine('rc3.l1.late-failure')
  const events = []
  let release
  const Slow = define.service('slow', {
    setup(_deps, { onDispose }) {
      onDispose(() => new Promise((_resolve, reject) => { release = () => reject(new Error('cleanup failed long after the close')) }))
      return { slow: true }
    },
  })
  const Entry = define.entry({ requires: { slow: Slow } })
  const runtime = createRuntime({
    services: [Slow],
    limits: { disposalGraceMs: 40 },
    diagnostics: { onEvent: event => events.push(event) },
  })
  const env = await runtime.enter(Entry)
  await env.deps.slow.load()
  await env.dispose()
  assert.equal(env.state, 'disposed')
  assert.equal(runtime.inspect().unsettledAttempts.length, 1)

  // runtime.dispose() reports what is still outstanding, the abandoned cleanup included.
  await runtime.dispose()
  const outstanding = events.filter(event => event.type === 'runtime-attempts-outstanding')
  assert.equal(outstanding.length, 1)
  assert.deepEqual(outstanding[0].attempts.map(attempt => attempt.state), ['abandoned'])

  release()
  await waitFor(() => runtime.inspect().unsettledAttempts.length === 0)
  const late = events.filter(event => event.type === 'attempt-failed-late')
  assert.equal(late.length, 1)
  assert.match(late[0].error.message, /cleanup failed long after the close/)
  assert.deepEqual(late[0].cleanupErrors.map(error => error.message), ['cleanup failed long after the close'])
  assert.equal(late[0].env, env.id)
})

test('RC2-L2 a rollback that throws while the close discards its late result is reported by dispose() exactly once, and by an event', async () => {
  const define = makeDefine('rc3.l2.reported')
  const events = []
  const cleanupError = new Error('cleanup during close failed')
  let release
  const Late = define.service('late', {
    setup(_deps, { onDispose }) {
      onDispose(() => { throw cleanupError })
      return new Promise(resolve => { release = () => resolve({ late: true }) })
    },
  })
  const Entry = define.entry({ requires: { late: Late } })
  const runtime = createRuntime({
    services: [Late],
    limits: { disposalGraceMs: 300 },
    diagnostics: { onEvent: event => events.push(event) },
  })
  const env = await runtime.enter(Entry)
  const waiter = env.deps.late.load().then(() => 'resolved', error => error)
  await sleep(5)
  const disposal = env.dispose().then(() => undefined, error => error)
  await sleep(5)
  release() // settles inside the grace: the result is discarded and the cleanup throws

  const closeError = await disposal
  assert.ok(closeError instanceof AggregateError, 'the close reports the cleanup failure it waited for')
  const flat = error => (error instanceof AggregateError ? error.errors.flatMap(flat) : [error])
  assert.equal(flat(closeError).filter(error => error === cleanupError).length, 1, 'exactly once')
  assert.equal(env.state, 'disposed')

  const late = events.filter(event => event.type === 'attempt-succeeded-late')
  assert.equal(late.length, 1, 'a settlement from the start of the close is reported, not only one after it')
  assert.equal(late[0].adopted, false)
  assert.deepEqual(late[0].cleanupErrors, [cleanupError])

  // The waiter's own rejection is unchanged and independent of the report above.
  const waiterOutcome = await waiter
  assert.ok(waiterOutcome instanceof AggregateError)
  assert.equal(flat(waiterOutcome).filter(error => error === cleanupError).length, 1)
  assert.equal(runtime.inspect().unsettledAttempts.length, 0)
  await runtime.dispose()
})

test('RC2-L2b the same failure is reported when the waiter has cancelled or run out its deadline: what the waiter got changes nothing', async () => {
  const define = makeDefine('rc3.l2b.no-waiter')
  const flat = error => (error instanceof AggregateError ? error.errors.flatMap(flat) : [error])

  for (const how of ['cancelled', 'timeout']) {
    const events = []
    const cleanupError = new Error(`cleanup during close failed (${how})`)
    let release
    const Late = define.service(`late-${how}`, {
      loadTimeoutMs: how === 'timeout' ? 20 : 5_000,
      setup(_deps, { onDispose }) {
        onDispose(() => { throw cleanupError })
        return new Promise(resolve => { release = () => resolve({ late: true }) })
      },
    })
    const Entry = define.entry(`entry-${how}`, { requires: { late: Late } })
    const runtime = createRuntime({
      services: [Late],
      limits: { disposalGraceMs: 300 },
      diagnostics: { onEvent: event => events.push(event) },
    })
    const env = await runtime.enter(Entry)
    const controller = new AbortController()
    const waiter = env.deps.late.load(how === 'cancelled' ? { signal: controller.signal } : undefined)
      .then(() => 'resolved', error => error?.code ?? error)
    if (how === 'cancelled') { await sleep(5); controller.abort() }
    const waiterOutcome = await waiter
    assert.equal(waiterOutcome, how === 'cancelled' ? 'LOAD_CANCELLED' : 'LOAD_TIMEOUT')

    const disposal = env.dispose().then(() => undefined, error => error)
    await sleep(5)
    release() // nobody is waiting any more; the close is
    const closeError = await disposal
    assert.ok(closeError instanceof AggregateError, `${how}: the close reports the failure although no waiter was left`)
    assert.equal(flat(closeError).filter(error => error === cleanupError).length, 1, `${how}: exactly once`)
    assert.equal(events.filter(event => event.type === 'attempt-succeeded-late').length, 1, `${how}: and reports it as an event`)
    assert.equal(env.state, 'disposed')
    await runtime.dispose()
  }
})

test('RC2-L3 while an abandoned attempt is pending, nothing the Runtime keeps reaches the closed Env: it and its Input payload are collected, the ledger holds one entry, and the late cleanup still runs', async () => {
  const script = `
    import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
    const define = definePackage({ name: '@rc3/l3', version: '1.0.0', syna: { id: 'rc3.l3.retention' } })
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const events = []
    let cleanups = 0
    // The setup captures nothing of its own: what is reachable afterwards is the
    // Runtime's doing. (A cleanup or a setup frame that captures deps is the
    // user's business, docs/SEMANTIC_MODEL.md §13.)
    const hold = []
    const Payload = define.input('payload')
    const Pending = define.service('pending', {
      setup(_deps, { onDispose }) {
        onDispose(() => { cleanups += 1 })
        return new Promise(resolve => { hold.push(resolve) })
      },
    })
    const Quiet = define.service('quiet', { setup() { return { ok: true } } })
    const Root = define.entry('root', {})
    const Child = define.entry('child', { requires: { pending: Pending, payload: Payload }, parameters: { payload: Payload } })
    const Control = define.entry('control', { requires: { quiet: Quiet, payload: Payload }, parameters: { payload: Payload } })
    const runtime = createRuntime({
      services: [Pending, Quiet],
      limits: { disposalGraceMs: 20 },
      diagnostics: { onEvent: event => events.push(event.type) },
    })
    const root = await runtime.enter(Root)

    let leaking = await root.enter(Child, { payload: { marker: new Uint8Array(1 << 16) } })
    void leaking.deps.pending.load().catch(() => undefined)
    await sleep(5)
    await leaking.dispose()
    // Control: an Env closed with nothing outstanding must be collected too — it
    // is what proves the method sees a difference at all.
    let control = await root.enter(Control, { payload: { marker: new Uint8Array(1 << 16) } })
    await control.deps.quiet.load()
    await control.dispose()

    const leakingRef = new WeakRef(leaking)
    const payloadRef = new WeakRef(leaking.deps.payload.read())
    const controlRef = new WeakRef(control)
    const ledgerWhilePending = runtime.inspect().unsettledAttempts
    leaking = undefined
    control = undefined
    // WeakRef.deref() keeps its target alive until the end of the job, so the
    // loop only collects and the refs are read once, afterwards.
    for (let round = 0; round < 8; round += 1) { globalThis.gc(); await sleep(20) }
    const reachability = {
      env: leakingRef.deref() !== undefined,
      payload: payloadRef.deref() !== undefined,
      control: controlRef.deref() !== undefined,
    }
    // The attempt outlived the Env's collection and can still be closed.
    for (const resolve of hold) resolve({ late: true })
    await sleep(50)
    console.log(JSON.stringify({
      ledger: ledgerWhilePending.map(entry => ({ state: entry.state, env: entry.env })),
      reachability,
      cleanups,
      ledgerAfter: runtime.inspect().unsettledAttempts.length,
      lateEvents: events.filter(event => event === 'attempt-succeeded-late').length,
    }))
    await runtime.dispose()
  `
  const result = await child(['--expose-gc', '--unhandled-rejections=strict'], script)
  assert.equal(result.code, 0, result.stderr)
  const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.equal(outcome.ledger.length, 1, 'one abandoned attempt is on the ledger')
  assert.equal(outcome.ledger[0].state, 'abandoned')
  assert.equal(outcome.reachability.control, false, 'the control Env is collected: the method sees collection')
  assert.equal(outcome.reachability.env, false, 'the closed Env is unreachable while its attempt is still pending')
  assert.equal(outcome.reachability.payload, false, 'and so is the Input payload of that Env')
  assert.equal(outcome.cleanups, 1, 'the attempt still ran its cleanup when it settled, after its Env was collected')
  assert.equal(outcome.lateEvents, 1)
  assert.equal(outcome.ledgerAfter, 0)
})
