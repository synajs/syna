// Regressions for the independent re-audit of the third review round (core line,
// work/v05/audit-3/core-lifecycle-planning/REPORT.md, F-CL3-01 … F-CL3-09; ledger
// work/v05/ISSUES.md I-85 …). Each case is the auditor's probe reduced to an assertion:
//   F-CL3-01 C.all candidates are keyed by the physical revision, so two
//            Runtimes sharing a Contract object do not contaminate each other;
//   F-CL3-02 setup drift is DUPLICATE_DEFINITION on a template hit too (enter/check/range family);
//   F-CL3-03 the unreachable path runs the cleanups of an attempt whose Env handle was dropped;
//   F-CL3-04 plans do not depend on the insertion order of `requires` keys or on admission order;
//   F-CL3-05 slow rollbacks and late cleanups are in the ledger ('rolling-back' / 'settling');
//   F-CL3-08 run() keeps a successful business result on the close error;
//   F-CL3-09 check()/explain() consume no slot ids.
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
const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(2)
  }
}
const settle = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }))
const child = (flags, script) =>
  run(process.execPath, [...flags, '--input-type=module', '-e', script])
    .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))

test('F-CL3-01 C.all candidates are keyed by the physical revision: two Runtimes sharing a Contract object do not contaminate each other', async () => {
  const shared = makeDefine('v05.audit3.collection-contract')
  const Capability = shared.contract('cap')
  const Panel = shared.service('panel', { requires: { implementations: Capability.all }, setup: ({ implementations }) => ({ implementations }) })
  const Entry = shared.entry('main', { requires: { panel: Panel } })
  // Three honest physical copies of impl@1.0.0: two differ in the setup body, one only in metadata.
  const copy = (flavour, revisionMetadata) => makeDefine('v05.audit3.impl')
    .service({ provides: [Capability], ...(revisionMetadata ? { revisionMetadata } : {}), setup: () => ({ flavour }) })
  const implA = copy('A')
  const implB = copy('B')
  const implBmeta = copy('B', { displayName: 'B (renamed)' })

  const expand = async (services) => {
    const runtime = createRuntime({ services })
    const env = await runtime.enter(Entry)
    const implementations = await (await env.deps.panel.load()).implementations.load()
    const { flavour } = await implementations.load(implementations.candidates[0])
    await env.dispose()
    const warnings = runtime.inspect().definitionWarnings
    await runtime.dispose()
    return { flavour, warnings }
  }
  assert.deepEqual(await expand([Panel, implB]), { flavour: 'B', warnings: [] })
  // The second Runtime admits the other copy: it must expand its own copy, not the first Runtime's.
  assert.deepEqual(await expand([Panel, implA]), { flavour: 'A', warnings: [] })
  // A metadata-only copy carries no drift of its own: no warning may leak from another Runtime.
  assert.deepEqual(await expand([Panel, implBmeta]), { flavour: 'B', warnings: [] })
})

test('F-CL3-02 setup drift is DUPLICATE_DEFINITION on a template hit, after check(), and for a range family whose uniqueWithin drifts', async () => {
  const define = makeDefine('v05.audit3.drift')
  const Canonical = makeDefine('v05.audit3.drift.storage').service('storage', { setup: () => ({ flavour: 'canonical' }) })
  const Drifted = makeDefine('v05.audit3.drift.storage').service('storage', { setup: () => ({ flavour: 'drifted' }) })
  const EntryCanonical = define.entry('main', { requires: { storage: Canonical } })
  const EntryDrifted = define.entry('main', { requires: { storage: Drifted } })
  assert.equal(Canonical.id, Drifted.id)

  const isDrift = outcome => outcome.status === 'rejected' && outcome.error.code === 'DUPLICATE_DEFINITION'

  // Cold (control): refused.
  const cold = createRuntime({ services: [Canonical] })
  assert.ok(isDrift(await settle(cold.enter(EntryDrifted))))
  await cold.dispose()

  // Warm: the canonical copy's template is in the cache; the drifted copy must not ride on it.
  const warm = createRuntime({ services: [Canonical] })
  const canonicalEnv = await warm.enter(EntryCanonical)
  await canonicalEnv.dispose()
  const before = warm.inspect().planCache
  const warmOutcome = await settle(warm.enter(EntryDrifted))
  assert.ok(isDrift(warmOutcome), `warm enter() of the drifted copy: ${warmOutcome.status} ${warmOutcome.error?.code ?? ''}`)
  assert.equal(warm.inspect().planCache.hits, before.hits + 1, 'the template was hit, and the hit path diagnosed the drift')
  // The canonical copy still works after the refused hit.
  const again = await warm.enter(EntryCanonical)
  assert.equal((await again.deps.storage.load()).flavour, 'canonical')
  await again.dispose()
  await warm.dispose()

  // check() warms the cache too. A drifted definition is not a planning outcome but a
  // definition error: check()/explain() throw it, cold and warm alike.
  const viaCheck = createRuntime({ services: [Canonical] })
  assert.equal((await viaCheck.check(EntryCanonical)).ok, true)
  assert.ok(isDrift(await settle(viaCheck.enter(EntryDrifted))), 'after check() of the canonical copy the drifted copy is still refused')
  assert.ok(isDrift(await settle(viaCheck.check(EntryDrifted))), 'check() of the drifted copy throws on a template hit as it does cold')
  assert.ok(isDrift(await settle(viaCheck.explain(EntryDrifted))))
  await viaCheck.dispose()

  // A range whose origin family drifts in uniqueWithin (M3).
  const Origin = makeDefine('v05.audit3.drift.h').service('h', { setup: () => ({}) })
  const DriftedFamily = makeDefine('v05.audit3.drift.h').service('h', { uniqueWithin: 'lineage', setup: () => ({}) })
  const RangeA = define.entry('range', { requires: { h: Origin.range('*') } })
  const RangeB = define.entry('range', { requires: { h: DriftedFamily.range('*') } })
  const ranged = createRuntime({ services: [Origin] })
  const rangedEnv = await ranged.enter(RangeA)
  await rangedEnv.dispose()
  assert.ok(isDrift(await settle(ranged.enter(RangeB))), 'family drift of a range origin is diagnosed on a template hit')
  await ranged.dispose()
})

test('F-CL3-03 an attempt whose Env handle was dropped is still closed as unreachable: cleanups run, the event names the Env, the ledger empties', async () => {
  const script = variant => `
    import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
    const define = definePackage({ name: '@v05/audit3-unreachable', version: '1.0.0', syna: { id: 'v05.audit3.unreachable' } })
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const events = []
    const cleanups = []
    let setups = 0
    const Stuck = define.service('stuck', {
      async setup(_deps, { onDispose }) {
        const label = setups === 0 ? 'dropped' : 'kept'
        setups += 1
        onDispose(() => { cleanups.push(label) })
        await new Promise(() => undefined) // nobody can ever settle this
        return {}
      },
    })
    const Root = define.entry('root', {})
    const Child = define.entry('child', { requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], limits: { disposalGraceMs: 10 }, diagnostics: { onEvent: event => events.push(event.type + ':' + event.env) } })
    const root = await runtime.enter(Root)
    let dropped = await root.enter(Child)
    const droppedId = dropped.id
    void dropped.deps.stuck.load().catch(() => undefined)
    await sleep(5)
    await dropped.dispose()
    const droppedRef = new WeakRef(dropped)
    dropped = undefined
    let kept
    // A job boundary between the drop and the first GC: the Env, its slot and the attempt die in one GC.
    if (${JSON.stringify(variant)} === 'single-yield') await sleep(0)
    if (${JSON.stringify(variant)} === 'pair') {
      kept = await root.enter(Child)
      void kept.deps.stuck.load().catch(() => undefined)
      await sleep(5)
      await kept.dispose()
    }
    for (let round = 0; round < 15; round += 1) { globalThis.gc(); await sleep(20) }
    await sleep(50)
    console.log(JSON.stringify({
      droppedCollected: droppedRef.deref() === undefined,
      droppedCleanup: cleanups.includes('dropped'),
      droppedEvent: events.includes('attempt-unreachable:' + droppedId),
      keptCleanup: kept ? cleanups.includes('kept') : null,
      ledger: runtime.inspect().unsettledAttempts.length,
    }))
    await runtime.dispose()
  `
  for (const variant of ['single-yield', 'pair']) {
    const result = await child(['--expose-gc', '--unhandled-rejections=strict'], script(variant))
    assert.equal(result.code, 0, `${variant}: ${result.stderr}`)
    const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1))
    assert.equal(outcome.droppedCollected, true, `${variant}: the dropped Env was collected`)
    assert.equal(outcome.droppedCleanup, true, `${variant}: the dropped Env's cleanup ran`)
    assert.equal(outcome.droppedEvent, true, `${variant}: attempt-unreachable named the dropped Env`)
    // 0.7 (S2): the 0.6 assertion "the kept Env is 'disposed' after the collection" is withdrawn: no state depends on GC.
    if (variant === 'pair') assert.equal(outcome.keptCleanup, true)
    assert.equal(outcome.ledger, 0, `${variant}: ledger empty afterwards`)
  }
})

test('F-CL3-04 plans do not depend on the insertion order of requires keys, on the cache, or on admission order', async () => {
  const fixtures = () => {
    const F1 = makeDefine('v05.audit3.order.fixed', '1.0.0').service('fixed', { uniqueWithin: 'lineage', setup: () => ({ v: 1 }) })
    const F2 = makeDefine('v05.audit3.order.fixed', '2.0.0').service('fixed', { uniqueWithin: 'lineage', setup: () => ({ v: 2 }) })
    const P1 = makeDefine('v05.audit3.order.p', '1.0.0').service('p', { requires: { fixed: F1 }, setup: () => ({}) })
    const P2 = makeDefine('v05.audit3.order.p', '2.0.0').service('p', { requires: { fixed: F2 }, setup: () => ({}) })
    const Q1 = makeDefine('v05.audit3.order.q', '1.0.0').service('q', { requires: { fixed: F2 }, setup: () => ({}) })
    const Q2 = makeDefine('v05.audit3.order.q', '2.0.0').service('q', { requires: { fixed: F1 }, setup: () => ({}) })
    return { F1, F2, P1, P2, Q1, Q2 }
  }
  const choicesOf = async (runtime, entry) => {
    const explanation = await runtime.explain(entry)
    assert.equal(explanation.ok, true, explanation.ok ? '' : explanation.error.code)
    return Object.fromEntries(Object.entries(explanation.choices).map(([site, revision]) => [site.replace(/^.*(?:require|dependency):/, ''), revision]))
  }

  // Entries differing only in key order: same id, same plan cold, same plan cached.
  {
    const { F1, F2, P1, P2, Q1, Q2 } = fixtures()
    const define = makeDefine('v05.audit3.order')
    const EntryPQ = define.entry('main', { requires: { p: P1.range('*'), q: Q1.range('*') } })
    const EntryQP = define.entry('main', { requires: { q: Q1.range('*'), p: P1.range('*') } })
    const services = [F1, F2, P1, P2, Q1, Q2]
    const coldPQ = createRuntime({ services })
    const coldQP = createRuntime({ services })
    const planPQ = await choicesOf(coldPQ, EntryPQ)
    const planQP = await choicesOf(coldQP, EntryQP)
    assert.deepEqual(planQP, planPQ, 'cold plans agree regardless of key order')
    assert.equal(Object.keys(planPQ).length >= 2, true)
    await coldPQ.dispose()
    await coldQP.dispose()
    const cached = createRuntime({ services })
    const first = await choicesOf(cached, EntryPQ)
    const second = await choicesOf(cached, EntryQP)
    assert.equal(cached.inspect().planCache.hits >= 1, true, 'the second copy hit the first copy\'s template')
    assert.deepEqual(first, planPQ)
    assert.deepEqual(second, planQP, 'the cached plan equals the copy\'s own cold plan (R17)')
    await cached.dispose()
  }

  // Services differing only in key order, admitted in either order: same plan (M2).
  {
    const build = order => {
      const { F1, F2, P1, P2, Q1, Q2 } = fixtures()
      const setup = () => ({})
      const ConsumerPQ = makeDefine('v05.audit3.order.consumer').service('consumer', { requires: { p: P1.range('*'), q: Q1.range('*') }, setup })
      const ConsumerQP = makeDefine('v05.audit3.order.consumer').service('consumer', { requires: { q: Q1.range('*'), p: P1.range('*') }, setup })
      const Entry = makeDefine('v05.audit3.order.m2').entry({ requires: { consumer: ConsumerPQ } })
      const copies = order === 'pq' ? [ConsumerPQ, ConsumerQP] : [ConsumerQP, ConsumerPQ]
      return { runtime: createRuntime({ services: [F1, F2, P1, P2, Q1, Q2, ...copies] }), Entry }
    }
    const pq = build('pq')
    const qp = build('qp')
    const planPQ = await choicesOf(pq.runtime, pq.Entry)
    const planQP = await choicesOf(qp.runtime, qp.Entry)
    assert.deepEqual(planQP, planPQ, 'admission order of key-order copies does not change the plan')
    await pq.runtime.dispose()
    await qp.runtime.dispose()
  }
})

test('F-CL3-05a a failed setup whose rollback outlives the grace is abandoned as rolling back (event phase, ledger state), and its slot ends disposed', async () => {
  const define = makeDefine('v05.audit3.slow-rollback')
  const rollbackGate = deferred()
  const events = []
  const Failing = define.service('failing', {
    async setup(_deps, { onDispose }) {
      onDispose(async () => { events.push('rollback-start'); await rollbackGate.promise; events.push('rollback-end') })
      throw new Error('setup failed')
    },
  })
  const Entry = define.entry({ requires: { failing: Failing } })
  const runtime = createRuntime({ services: [Failing], limits: { disposalGraceMs: 40 }, diagnostics: { onEvent: event => events.push(event.type === 'attempt-abandoned' ? `attempt-abandoned:${event.phase}` : event.type) } })
  const env = await runtime.enter(Entry)
  const load = env.deps.failing.load()
  void load.catch(() => undefined)
  await waitFor(() => events.includes('rollback-start'))
  // 0.7 (S2): the 0.6 assertions "dispose() rejects ('were still rolling back', details.slots[].phase)" and
  // "state stays 'disposing'" are withdrawn: the phase is on the attempt-abandoned event, the attempt on the ledger.
  await env.dispose()
  assert.ok(events.includes('attempt-abandoned:rollback'), 'the bounded close reports the outstanding rollback')
  assert.equal(env.state, 'disposed')
  const ledger = runtime.inspect().unsettledAttempts
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].state, 'rolling-back')
  assert.equal(ledger[0].env, env.id)
  assert.deepEqual(env.inspect().abandonedAttempts.map(item => item.state), ['rolling-back'])
  await runtime.dispose()
  assert.ok(events.includes('runtime-attempts-outstanding'), 'runtime.dispose() reports the rollback still outstanding, once')
  rollbackGate.resolve()
  await waitFor(() => runtime.inspect().unsettledAttempts.length === 0)
  assert.equal(env.inspect().nodes[0].state, 'disposed', 'the slot leaves abandoned once its rollback finished')
  assert.deepEqual(env.inspect().abandonedAttempts, [])
  assert.ok(events.includes('rollback-end'))
  const outcome = await settle(load)
  assert.equal(outcome.status, 'rejected')
  assert.equal(outcome.error.message, 'setup failed')
})

test('F-CL3-05b during a late cleanup the ledger still lists the attempt as settling and runtime.dispose() reports it once', async () => {
  const define = makeDefine('v05.audit3.late-cleanup')
  const setupGate = deferred()
  const cleanupGate = deferred()
  const events = []
  const Stuck = define.service('stuck', {
    async setup(_deps, { onDispose }) {
      onDispose(async () => { events.push('late-cleanup-start'); await cleanupGate.promise; events.push('late-cleanup-end') })
      await setupGate.promise
      return {}
    },
  })
  const Entry = define.entry({ requires: { stuck: Stuck } })
  const runtime = createRuntime({ services: [Stuck], limits: { disposalGraceMs: 10 }, diagnostics: { onEvent: event => events.push(event.type) } })
  const env = await runtime.enter(Entry)
  void env.deps.stuck.load().catch(() => undefined)
  await sleep(5)
  await env.dispose()
  assert.equal(env.state, 'disposed') // 0.7 (S2): the 0.6 'disposing' assertions of this case are withdrawn
  assert.deepEqual(runtime.inspect().unsettledAttempts.map(item => item.state), ['abandoned'])
  setupGate.resolve() // late settlement; the late cleanup now blocks on cleanupGate
  await waitFor(() => events.includes('late-cleanup-start'))
  assert.equal(env.state, 'disposed')
  assert.deepEqual(runtime.inspect().unsettledAttempts.map(item => item.state), ['settling'], 'the ledger keeps the attempt while its late cleanup runs')
  assert.deepEqual(env.inspect().abandonedAttempts.map(item => item.state), ['settling'])
  await runtime.dispose()
  assert.deepEqual(events.filter(event => event === 'runtime-attempts-outstanding'), ['runtime-attempts-outstanding'], 'runtime.dispose() does not fulfil silently while a late cleanup runs: it reports the settling attempt once')
  cleanupGate.resolve()
  await waitFor(() => runtime.inspect().unsettledAttempts.length === 0)
  assert.equal(env.inspect().nodes[0].state, 'disposed')
  assert.ok(events.includes('late-cleanup-end'))
  assert.ok(events.includes('attempt-succeeded-late'))
  // A Runtime closes once: a later call returns the same close and reports nothing again.
  await runtime.dispose()
  assert.equal(events.filter(event => event === 'runtime-attempts-outstanding').length, 1)
})

test('F-CL3-05c runtime.dispose() waits within the grace for a settling attempt instead of reporting a cleanup that is about to finish', async () => {
  const define = makeDefine('v05.audit3.settling-grace')
  const setupGate = deferred()
  const Stuck = define.service('stuck', {
    async setup(_deps, { onDispose }) {
      onDispose(async () => { await sleep(30) })
      await setupGate.promise
      return {}
    },
  })
  const Entry = define.entry({ requires: { stuck: Stuck } })
  const events = []
  const runtime = createRuntime({ services: [Stuck], limits: { disposalGraceMs: 200, loadTimeoutMs: 20 }, diagnostics: { onEvent: event => events.push(event.type) } })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.stuck.load(), error => error.code === 'LOAD_TIMEOUT')
  // The Env's own close abandons the overdue attempt (its raw Promise is still pending).
  await env.dispose()
  assert.equal(env.state, 'disposed')
  assert.deepEqual(runtime.inspect().unsettledAttempts.map(item => item.state), ['abandoned'])
  setupGate.resolve() // late settlement: the cleanup takes 30 ms, well inside the 200 ms grace
  await waitFor(() => runtime.inspect().unsettledAttempts[0]?.state === 'settling')
  await runtime.dispose()
  assert.equal(runtime.inspect().unsettledAttempts.length, 0)
  assert.deepEqual(events, ['attempt-overdue', 'attempt-abandoned', 'attempt-succeeded-late'], 'the close waited for the settling attempt: nothing outstanding to report')
})

test('F-CL3-08 run() keeps a successful business result on the close error', async () => {
  const define = makeDefine('v05.audit3.run-result')
  // 0.7 (S2): an abandoned attempt is no longer an error of the close (run() then returns the result: see
  // v07-s2-state-and-ledger), so the close error of this case is a cleanup that throws.
  const Throwing = define.service('throwing', { setup: (_deps, { onDispose }) => { onDispose(() => { throw new Error('cleanup failed') }); return {} } })
  const Entry = define.entry({ requires: { throwing: Throwing } })
  const runtime = createRuntime({ services: [Throwing] })
  const outcome = await settle(runtime.run(Entry, async deps => {
    await deps.throwing.load()
    return 'business result'
  }))
  assert.equal(outcome.status, 'rejected')
  assert.ok(outcome.error instanceof AggregateError)
  assert.ok(outcome.error.errors.some(item => item instanceof AggregateError && item.errors.some(inner => inner.message === 'cleanup failed')))
  assert.equal(outcome.error.result, 'business result')
  assert.equal(Object.keys(outcome.error).includes('result'), false, 'the result rides along without changing the error\'s enumerable shape')
  await runtime.dispose()
})

test('F-CL3-09 check() and explain() consume no slot ids: the first real Env is numbered from slot-1', async () => {
  const define = makeDefine('v05.audit3.slot-ids')
  const Cap = define.contract('cap')
  const Impl = define.service('impl', { provides: [Cap], setup: () => ({}) })
  const Sub = define.entry('sub', {})
  const Entry = define.entry({ requires: { all: Cap.all, sub: Sub, impl: Impl } })
  const runtime = createRuntime({ services: [Impl] })
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await runtime.check(Entry)).ok, true)
    assert.equal((await runtime.explain(Entry)).ok, true)
  }
  const env = await runtime.enter(Entry)
  const slotIds = env.inspect().nodes.map(node => node.slotId).sort()
  assert.equal(env.id, 'env-1')
  assert.deepEqual(slotIds, ['slot-1', 'slot-2', 'slot-3'])
  await env.dispose()
  await runtime.dispose()
})
