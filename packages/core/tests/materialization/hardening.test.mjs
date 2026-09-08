import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auto,
  createRuntime,
  definePackage,
  forward,
  override,
} from '../../dist/index.js'

const makeDefine = (id, version = '1.0.0', metadata) => definePackage({
  name: `@test/${id.replaceAll('.', '-')}-${version}`,
  version,
  syna: { id, ...(metadata ? { metadata } : {}) },
})

const withTimeout = async (promise, milliseconds = 500) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds} ms.`)), milliseconds)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

test('0.x implementation refs use the exact installed version as the caret baseline', async () => {
  const define = makeDefine('test.zero-ref', '0.2.0')
  const Capability = define.contract()
  const Choice = define.binding('choice', Capability)
  const Provider = define.service('provider', {
    provides: [Capability],
    setup: () => ({ id: 'zero' }),
  })
  const Consumer = define.service('consumer', {
    requires: { choice: Choice },
    setup: ({ choice }) => ({ load: async () => (await choice.load()).id }),
  })
  const Entry = define.entry({
    requires: { consumer: Consumer },
    parameters: { choice: Choice },
  })

  const ref = Choice.to(Provider)
  assert.equal(ref.range, '^0.2.0')

  const runtime = createRuntime({ services: [Consumer, Provider] })
  assert.equal(runtime.catalog.resolve(ref).version, '0.2.0')
  assert.equal(runtime.catalog.implementations(Capability)[0].implementationRef.range, '^0.2.0')

  const env = await runtime.enter(Entry, { choice: ref })
  assert.equal(await (await env.deps.consumer.load()).load(), 'zero')
  await runtime.dispose()
})

// v0.5 (MIGRATION M-07): a load() wait is a plain Promise. A pending cycle is not
// failed immediately; the configurable initialization deadline reports it.
test('a setup wait cycle routed through a Ready service ends with LOAD_TIMEOUT instead of hanging', async () => {
  const define = makeDefine('test.ready-indirect-cycle')
  let A
  let B
  let C

  A = define.service('a', {
    requires: { c: forward(() => C) },
    setup({ c }) {
      return {
        viaC: async () => (await c.load()).name,
      }
    },
  })
  B = define.service('b', {
    requires: { a: forward(() => A) },
    async setup({ a }) {
      const readyA = await a.load()
      await readyA.viaC()
      return { name: 'b' }
    },
  })
  C = define.service('c', {
    requires: { b: forward(() => B) },
    async setup({ b }) {
      await b.load()
      return { name: 'c' }
    },
  })

  const Entry = define.entry({ requires: { a: A, b: B } })
  const runtime = createRuntime({ services: [A, B, C], limits: { loadTimeoutMs: 40 } })
  const env = await runtime.enter(Entry)
  await env.deps.a.load()
  await assert.rejects(
    withTimeout(env.deps.b.load(), 2000),
    error => {
      assert.equal(error.code, 'LOAD_TIMEOUT')
      assert.equal(error.details.revision, B.id)
      // The wait went through a Ready instance's method, so no load() edge from B
      // is observable; the deadline is the honest fallback, not a deadlock proof.
      assert.equal(typeof error.details.elapsedMs, 'number')
      return true
    },
  )
  await runtime.dispose()
})

test('an Entry dependency is bound to the owner Env of the Service slot', async () => {
  const define = makeDefine('test.bound-entry')
  const Context = define.input('context')
  let workerStarts = 0

  const Worker = define.service('worker', {
    requires: { context: Context },
    setup({ context }) {
      const instance = ++workerStarts
      return {
        instance,
        context: async () => context.read(),
      }
    },
  })
  const WorkerEntry = define.entry('worker-entry', {
    requires: { worker: Worker },
    parameters: { context: Context },
  })
  const Orchestrator = define.service('orchestrator', {
    requires: { workers: WorkerEntry },
    setup({ workers }) {
      return {
        async run(context) {
          const bound = await workers.load()
          return bound.run({ context }, async ({ worker }, child) => {
            const value = await worker.load()
            return {
              parentId: child.inspect().parentId,
              instance: value.instance,
              context: await value.context(),
            }
          })
        },
      }
    },
  })
  const Root = define.entry('root', { requires: { orchestrator: Orchestrator } })
  const EmptyChild = define.entry('empty-child', { requires: { orchestrator: Orchestrator } })
  const runtime = createRuntime({ services: [Orchestrator, Worker] })
  const root = await runtime.enter(Root)
  const child = await root.enter(EmptyChild)

  const fromRoot = await root.deps.orchestrator.load()
  const fromChild = await child.deps.orchestrator.load()
  assert.strictEqual(fromRoot, fromChild)

  const first = await fromRoot.run('one')
  const second = await fromChild.run('two')
  assert.equal(first.parentId, root.id)
  assert.equal(second.parentId, root.id)
  assert.notEqual(first.instance, second.instance)
  assert.equal(first.context, 'one')
  assert.equal(second.context, 'two')
  await runtime.dispose()
})

test('runtime.check validates topology without materializing eager services or publishing an Env', async () => {
  const define = makeDefine('test.preflight')
  const Required = define.input('required')
  let starts = 0
  const Eager = define.service({
    eager: true,
    requires: { required: Required },
    setup() {
      starts += 1
      return {}
    },
  })
  const Entry = define.entry({
    requires: { eager: Eager },
    parameters: { required: Required },
  })
  const runtime = createRuntime({ services: [Eager] })

  const valid = await runtime.check(Entry, { required: 'ok' })
  assert.equal(valid.ok, true)
  assert.equal(starts, 0)
  assert.equal(runtime.inspect().rootEnvCount, 0)

  const invalid = await runtime.check(Entry, {})
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'MISSING_INPUT')
  assert.equal(starts, 0)

  const env = await runtime.enter(Entry, { required: 'ok' })
  assert.equal(starts, 1)
  await runtime.dispose()
})

test('construction-time substitution rewrites exact dependency edges without mutating a live Runtime', async () => {
  const define = makeDefine('test.substitution')
  const Real = define.service('real', { setup: () => ({ source: 'real' }) })
  const Fake = define.service('fake', { setup: () => ({ source: 'fake' }) })
  const Consumer = define.service('consumer', {
    requires: { dependency: Real },
    setup: ({ dependency }) => ({ source: async () => (await dependency.load()).source }),
  })
  const Entry = define.entry({ requires: { consumer: Consumer } })
  const runtime = createRuntime({
    services: [Consumer, Fake],
    overrides: [override(Real, Fake)],
  })
  const env = await runtime.enter(Entry)
  assert.equal(await (await env.deps.consumer.load()).source(), 'fake')
  await runtime.dispose()
})

test('retry is opt-in and all concurrent waiters share one sequence of setup attempts', async () => {
  const define = makeDefine('test.retry')
  let attempts = 0
  const Recovering = define.service({
    failure: { attempts: 3 },
    setup() {
      attempts += 1
      if (attempts < 3) throw new Error(`attempt ${attempts}`)
      return { attempts }
    },
  })
  const Entry = define.entry({ requires: { service: Recovering } })
  const runtime = createRuntime({ services: [Recovering] })
  const env = await runtime.enter(Entry)
  const [first, second] = await Promise.all([
    env.deps.service.load(),
    env.deps.service.load(),
  ])
  assert.strictEqual(first, second)
  assert.equal(first.attempts, 3)
  assert.equal(attempts, 3)
  await runtime.dispose()
})

test('plan templates are reused for repeated request-shaped Entries with different Input payloads', async () => {
  const define = makeDefine('test.plan-cache')
  const Request = define.input('request')
  const Handler = define.service('handler', {
    requires: { request: Request },
    setup: ({ request }) => ({ request: async () => request.read() }),
  })
  const Root = define.entry('root', {})
  const RequestEntry = define.entry('request', {
    requires: { handler: Handler },
    parameters: { request: Request },
  })
  const runtime = createRuntime({ services: [Handler] })
  const root = await runtime.enter(Root)
  const before = runtime.inspect().planCache

  for (let index = 0; index < 5; index += 1) {
    const child = await root.enter(RequestEntry, { request: { index } })
    assert.equal(await (await child.deps.handler.load()).request().then(value => value.index), index)
    await child.dispose()
  }

  const after = runtime.inspect().planCache
  assert.ok(after.misses >= before.misses + 1)
  assert.ok(after.hits >= before.hits + 4)
  await runtime.dispose()
})

test('policy bugs propagate directly instead of being disguised as topology backtracking failures', async () => {
  const define = makeDefine('test.policy-error')
  const Capability = define.contract()
  const Provider = define.service('provider', {
    provides: [Capability],
    setup: () => ({}),
  })
  const Consumer = define.service('consumer', {
    requires: { capability: auto(Capability) },
    setup: () => ({}),
  })
  const Entry = define.entry({ requires: { consumer: Consumer } })
  const runtime = createRuntime({
    services: [Consumer, Provider],
    policy: {
      orderAutoCandidates() {
        throw new TypeError('policy exploded')
      },
    },
  })
  await assert.rejects(runtime.enter(Entry), error => {
    assert.equal(error instanceof TypeError, true)
    assert.equal(error.message, 'policy exploded')
    return true
  })
})

test('structured run preserves the callback error and exposes disposal failure as suppressed', async () => {
  const define = makeDefine('test.suppressed-dispose')
  const BrokenCleanup = define.service({
    setup(_dependencies, { onDispose }) {
      onDispose(() => { throw new Error('cleanup failed') })
      return {}
    },
  })
  const Entry = define.entry({ requires: { service: BrokenCleanup } })
  const runtime = createRuntime({ services: [BrokenCleanup] })

  await assert.rejects(
    runtime.run(Entry, async ({ service }) => {
      await service.load()
      throw new Error('callback failed')
    }),
    error => {
      assert.equal(error.message, 'callback failed')
      assert.equal(error.suppressed instanceof AggregateError, true)
      const render = value => value instanceof AggregateError
        ? [value.message, ...value.errors.flatMap(render)]
        : [String(value)]
      assert.match(render(error.suppressed).join(' | '), /cleanup failed/)
      return true
    },
  )
})

test('fresh and share may target a Service Family rather than one exact revision', async () => {
  const define = makeDefine('test.family-scope-target')
  const State = define.service('state', { setup: () => ({ token: {} }) })
  const Consumer = define.service('consumer', {
    requires: { state: State },
    setup: ({ state }) => ({ state }),
  })
  const Root = define.entry('root', { requires: { consumer: Consumer } })
  const Fresh = define.entry('fresh', {
    requires: { consumer: Consumer },
    reuse: { fresh: [State.family] },
  })
  const Impossible = define.entry('impossible', {
    requires: { consumer: Consumer },
    reuse: { fresh: [State.family], share: [State.family] },
  })
  const runtime = createRuntime({ services: [Consumer, State] })
  const root = await runtime.enter(Root)
  const child = await root.enter(Fresh)
  assert.notStrictEqual(await root.deps.consumer.load(), await child.deps.consumer.load())
  await assert.rejects(root.enter(Impossible), error => error.code === 'SHARE_CONSTRAINT_FAILED')
  await runtime.dispose()
})

// v0.5 (MIGRATION M-05): no activation transaction. An AnchoredEntry anchored at an
// owner that is still activating rejects with OWNER_NOT_READY; the rejection is
// an ordinary Promise the setup may catch.
test('an owner-bound Entry entered during owner activation rejects with OWNER_NOT_READY', async () => {
  const define = makeDefine('test.bound-entry-activation')
  const ChildEntry = define.entry('child', {})
  let observed
  const Eager = define.service({
    eager: true,
    requires: { child: ChildEntry },
    async setup({ child }) {
      const bound = await child.load()
      try {
        await bound.enter()
        observed = 'entered'
      }
      catch (error) {
        observed = error.code
      }
      return { start: () => bound.enter() }
    },
  })
  const Root = define.entry({ requires: { eager: Eager } })
  const runtime = createRuntime({ services: [Eager] })
  const root = await runtime.enter(Root)
  assert.equal(observed, 'OWNER_NOT_READY')
  // Once the owner is Ready the same handle works.
  const child = await (await root.deps.eager.load()).start()
  assert.equal(child.state, 'ready')
  assert.equal(child.inspect().parentId, root.id)
  await runtime.dispose()
})

test('non-semantic metadata drift produces a warning without changing nominal graph identity', async () => {
  // Only the metadata differs; the setup bodies are textually identical (a
  // differing body would be a structural conflict since the third review round).
  let setups = 0
  const canonical = makeDefine('test.metadata-drift', '1.0.0', {
    displayName: 'Canonical name',
  }).service({ setup: () => ({ id: (setups += 1) }) })
  const copy = makeDefine('test.metadata-drift', '1.0.0', {
    displayName: 'Different display name',
  }).service({ setup: () => ({ id: (setups += 1) }) })
  const entryDefine = makeDefine('test.metadata-drift-entry')
  const Entry = entryDefine.entry({ requires: { service: copy } })
  const runtime = createRuntime({ services: [canonical, copy] })
  assert.equal(runtime.inspect().definitionWarnings.length, 1)
  assert.deepEqual(runtime.inspect().admittedServices, [canonical.id])
  const env = await runtime.enter(Entry)
  assert.equal((await env.deps.service.load()).id, 1)
  assert.equal(setups, 1, 'one canonical revision, set up once')
  await runtime.dispose()
})

test('re-providing an Input creates a new slot while reassigning the same exact Binding choice is a no-op', async () => {
  const define = makeDefine('test.input-binding-asymmetry')
  const Capability = define.contract()
  const Current = define.input('current')
  const Choice = define.binding('choice', Capability)
  const Provider = define.service('provider', {
    provides: [Capability],
    setup: () => ({ id: 'provider' }),
  })
  const Consumer = define.service('consumer', {
    requires: { current: Current, choice: Choice },
    setup: ({ current, choice }) => ({ current, choice }),
  })
  const Scope = define.entry({
    requires: { consumer: Consumer },
    parameters: { current: Current, choice: Choice },
  })
  const runtime = createRuntime({ services: [Consumer, Provider] })
  const root = await runtime.enter(Scope, { current: 1, choice: Provider })
  const child = await root.enter(Scope, { current: 1, choice: Provider })

  const rootInspection = root.inspect()
  const childInspection = child.inspect()
  const inputId = `input:${Current.id}`
  const bindingId = `binding:${Choice.id}`
  assert.notEqual(
    rootInspection.nodes.find(node => node.nodeId === inputId)?.slotId,
    childInspection.nodes.find(node => node.nodeId === inputId)?.slotId,
  )
  assert.equal(
    rootInspection.nodes.find(node => node.nodeId === bindingId)?.slotId,
    childInspection.nodes.find(node => node.nodeId === bindingId)?.slotId,
  )
  await runtime.dispose()
})

test('auto candidate backtracking includes lineage and slot-assignment constraints', async () => {
  const define = makeDefine('test.slot-backtracking')
  const Capability = define.contract()
  const FixedV1 = makeDefine('test.slot-backtracking-fixed', '1.0.0').service({
    uniqueWithin: 'lineage',
    setup: () => ({ version: 1 }),
  })
  const FixedV2 = makeDefine('test.slot-backtracking-fixed', '2.0.0').service({
    uniqueWithin: 'lineage',
    setup: () => ({ version: 2 }),
  })
  const Incompatible = makeDefine('test.slot-backtracking-incompatible').service({
    provides: [Capability],
    requires: { fixed: FixedV2 },
    setup: () => ({ id: 'incompatible' }),
  })
  const Compatible = makeDefine('test.slot-backtracking-compatible').service({
    provides: [Capability],
    requires: { fixed: FixedV1 },
    setup: () => ({ id: 'compatible' }),
  })
  const Consumer = define.service('consumer', {
    requires: { capability: auto(Capability) },
    setup: ({ capability }) => ({ capability }),
  })
  const Root = define.entry('root', { requires: { fixed: FixedV1 } })
  const Child = define.entry('child', { requires: { consumer: Consumer } })
  const runtime = createRuntime({
    services: [FixedV1, FixedV2, Incompatible, Compatible, Consumer],
    policy: {
      orderAutoCandidates(_contract, candidates) {
        return [Incompatible, Compatible].filter(candidate => candidates.includes(candidate))
      },
    },
  })

  const root = await runtime.enter(Root)
  const child = await root.enter(Child)
  const provider = await (await child.deps.consumer.load()).capability.load()
  assert.equal(provider.id, 'compatible')
  await runtime.dispose()
})

test('a policy failure while planning a C.all candidate propagates as the policy error, never disguised', async () => {
  const define = makeDefine('test.collection-policy-error')
  const Capability = define.contract()
  const DependencyV1 = makeDefine('test.collection-policy-dependency', '1.0.0').service({ setup: () => ({}) })
  const DependencyV2 = makeDefine('test.collection-policy-dependency', '2.0.0').service({ setup: () => ({}) })
  const Provider = define.service('provider', {
    provides: [Capability],
    requires: { dependency: DependencyV1.range('*') },
    setup: () => ({}),
  })
  const Panel = define.service('panel', {
    requires: { implementations: Capability.all },
    setup: ({ implementations }) => ({ implementations }),
  })
  const Entry = define.entry({ requires: { panel: Panel } })
  const runtime = createRuntime({
    services: [Panel, Provider, DependencyV1, DependencyV2],
    policy: {
      orderVersionCandidates() {
        throw new TypeError('candidate policy exploded')
      },
    },
  })
  await assert.rejects(runtime.enter(Entry), error => {
    assert.equal(error instanceof TypeError, true)
    assert.equal(error.message, 'candidate policy exploded')
    return true
  })
  await assert.rejects(runtime.check(Entry), error => error instanceof TypeError)
})

// With C.all every admitted revision of the family is active in this Env, so the version policy's
// active-ancestor preference cannot single one out: the highest satisfying version wins. (The selector
// form of this test, where only Provider12 was active, preferred 1.2.0; see docs/MIGRATION_V05_TO_V06.md.)
test('C.all resolves a persistent ref with the Runtime version policy among the coexisting revisions', async () => {
  const capabilityDefine = makeDefine('test.collection-version-policy')
  const Capability = capabilityDefine.contract()
  const Choice = capabilityDefine.binding('choice', Capability)
  const Provider12 = makeDefine('test.collection-version-provider', '1.2.0').service({
    provides: [Capability],
    setup: () => ({ version: '1.2.0' }),
  })
  const Provider19 = makeDefine('test.collection-version-provider', '1.9.0').service({
    provides: [Capability],
    setup: () => ({ version: '1.9.0' }),
  })
  const Panel = capabilityDefine.service('panel', {
    requires: { providers: Capability.all },
    setup: ({ providers }) => ({ providers }),
  })
  const Entry = capabilityDefine.entry({
    requires: { active: Provider12, panel: Panel },
  })
  const runtime = createRuntime({ services: [Panel, Provider12, Provider19] })
  const env = await runtime.enter(Entry)
  const providers = await (await env.deps.panel.load()).providers.load()
  const selected = providers.resolve(Choice.to(Provider12, '^1.0.0'))
  assert.equal(selected.version, '1.9.0')
  assert.equal(providers.resolve(Choice.to(Provider12, '~1.2.0')).version, '1.2.0')
  assert.deepEqual(providers.candidates.map(candidate => candidate.version), ['1.9.0', '1.2.0'])
  await runtime.dispose()
})

test('Runtime definition overrides preserve the source Contract identity', async () => {
  const define = makeDefine('test.substitution-contract')
  const Capability = define.contract()
  const Source = define.service('source', {
    provides: [Capability],
    setup: () => ({ value: 1 }),
  })
  const Target = define.service('target', {
    setup: () => ({ value: 2 }),
  })
  const Consumer = define.service('consumer', {
    requires: { capability: Capability },
    setup: ({ capability }) => ({ capability }),
  })
  const Entry = define.entry({ requires: { consumer: Consumer } })
  const runtime = createRuntime({
    services: [Consumer, Source],
    overrides: [override(Source, Target)],
  })
  const env = await runtime.enter(Entry)
  const consumer = await env.deps.consumer.load()
  assert.equal((await consumer.capability.load()).value, 2)
  assert.deepEqual(runtime.catalog.implementations(Capability).map(item => item.familyId), [Source.family.id])
  await runtime.dispose()
})
