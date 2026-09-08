import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auto,
  createRuntime,
  definePackage,
} from '../../dist/index.js'

const defineFor = (id, version = '1.0.0') => definePackage({
  name: `@final/${id.replaceAll('.', '-')}`,
  version,
  syna: { id },
})

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs} ms.`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('private Entry realms expose declared exact roots but do not discover private Contract implementations', async () => {
  const define = defineFor('realm-contract-boundary')
  const Capability = define.contract()
  const PrivateProvider = define.service('private-provider', {
    provides: [Capability],
    setup: () => ({ source: 'private' }),
  })
  const StrictEntry = define.entry('strict', { requires: { capability: Capability } })
  const AutoEntry = define.entry('auto', { requires: { capability: auto(Capability) } })
  const Owner = define.service('owner', {
    requires: {
      // Makes the provider part of the owner's private definition universe.
      privateProvider: PrivateProvider,
      strict: StrictEntry,
      automatic: AutoEntry,
    },
    setup({ strict, automatic }) {
      return {
        async checkStrict() {
          return (await strict.load()).check()
        },
        async checkAuto() {
          return (await automatic.load()).check()
        },
      }
    },
  })
  const Root = define.entry({ requires: { owner: Owner } })
  const runtime = createRuntime({ services: [Owner] })
  const env = await runtime.enter(Root)
  const owner = await env.deps.owner.load()

  const strict = await owner.checkStrict()
  const automatic = await owner.checkAuto()
  assert.equal(strict.ok, false)
  assert.equal(strict.error.code, 'MISSING_IMPLEMENTATION')
  assert.equal(automatic.ok, false)
  assert.equal(automatic.error.code, 'MISSING_IMPLEMENTATION')
  assert.ok(runtime.inspect().privateServices.includes(PrivateProvider.id))
  assert.ok(!runtime.inspect().admittedServices.includes(PrivateProvider.id))
  await runtime.dispose()
})

test('owner-bound Entry context is explicit: app-owned capabilities do not inherit caller-local Inputs', async () => {
  const define = defineFor('owner-entry-context')
  const CurrentRequest = define.input('current-request')
  const RequestWorker = define.service('request-worker', {
    requires: { request: CurrentRequest },
    setup: async ({ request }) => ({ request: request.read() }),
  })
  const WorkerEntry = define.entry('worker', { requires: { worker: RequestWorker } })
  const AppOwnedFactory = define.service('app-factory', {
    requires: { workers: WorkerEntry },
    setup({ workers }) {
      return {
        async check() {
          return (await workers.load()).check()
        },
      }
    },
  })
  const RequestOwnedFactory = define.service('request-factory', {
    requires: { request: CurrentRequest, workers: WorkerEntry },
    setup({ workers }) {
      return {
        async run() {
          return (await workers.load()).run(async ({ worker }) => (await worker.load()).request)
        },
      }
    },
  })
  const App = define.entry('app', { requires: { factory: AppOwnedFactory } })
  const Request = define.entry('request', {
    requires: { appFactory: AppOwnedFactory, requestFactory: RequestOwnedFactory },
    parameters: { request: CurrentRequest },
  })
  const runtime = createRuntime({ services: [AppOwnedFactory, RequestOwnedFactory] })
  const app = await runtime.enter(App)
  const request = await app.enter(Request, { request: { id: 'request-1' } })

  const appFactory = await request.deps.appFactory.load()
  const appCheck = await appFactory.check()
  assert.equal(appCheck.ok, false)
  assert.equal(appCheck.error.code, 'MISSING_INPUT')

  const requestFactory = await request.deps.requestFactory.load()
  assert.deepEqual(await requestFactory.run(), { id: 'request-1' })
  await runtime.dispose()
})

test('a background load failure does not fail the caller setup, but remains observable on explicit load', async () => {
  const define = defineFor('preload-failure')
  let attempts = 0
  const Failing = define.service('failing', {
    setup() {
      attempts += 1
      throw new Error('prefetch failed')
    },
  })
  const Caller = define.service('caller', {
    requires: { failing: Failing },
    setup({ failing }) {
      void failing.load().catch(() => undefined)
      return { ready: true, failing }
    },
  })
  const Entry = define.entry({ requires: { caller: Caller } })
  const runtime = createRuntime({ services: [Caller] })
  const env = await runtime.enter(Entry)
  const caller = await env.deps.caller.load()
  assert.equal(caller.ready, true)
  await waitFor(() => attempts === 1)
  await assert.rejects(caller.failing.load(), /prefetch failed/)
  assert.equal(attempts, 1)
  await runtime.dispose()
})

test('disposing during retry-on-next-load cooldown prevents a recovery generation', async () => {
  const define = defineFor('recovery-dispose')
  let attempts = 0
  const Recoverable = define.service({
    failure: {
      attempts: 1,
      afterExhaustion: 'retry-on-next-load',
      cooldownMs: 1000,
    },
    setup() {
      attempts += 1
      throw new Error(`attempt-${attempts}`)
    },
  })
  const Entry = define.entry({ requires: { service: Recoverable } })
  const runtime = createRuntime({ services: [Recoverable] })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.service.load(), /attempt-1/)
  const recovering = env.deps.service.load()
  await new Promise(resolve => setTimeout(resolve, 10))
  const started = performance.now()
  await env.dispose()
  const elapsed = performance.now() - started
  await assert.rejects(recovering, /closing|cancelled|aborted/i)
  assert.ok(elapsed < 200, `dispose waited ${elapsed.toFixed(1)} ms`)
  assert.equal(attempts, 1)
  await runtime.dispose()
})

// v0.5 (MIGRATION M-05): there is no activation transaction to roll a child
// back into. The child world is refused while the owner activates, so nothing
// of it ever starts; the failed root still rolls back its own started slots.
test('failed parent activation cannot have started a child world; local eager slots roll back', async () => {
  const define = defineFor('activation-child-rollback')
  let childStarts = 0
  const events = []
  const Worker = define.service('worker', {
    eager: true,
    setup() {
      childStarts += 1
      return {}
    },
  })
  const WorkerEntry = define.entry('worker-entry', { requires: { worker: Worker } })
  const Sibling = define.service('sibling', {
    eager: true,
    setup(_dependencies, { onDispose }) {
      events.push('sibling-start')
      onDispose(() => events.push('sibling-dispose'))
      return {}
    },
  })
  const Coordinator = define.service('coordinator', {
    eager: true,
    requires: { workers: WorkerEntry, sibling: Sibling },
    async setup({ workers, sibling }) {
      await sibling.load()
      await (await workers.load()).enter()
      throw new Error('unreachable')
    },
  })
  const Root = define.entry({ requires: { coordinator: Coordinator } })
  const runtime = createRuntime({ services: [Coordinator] })
  await assert.rejects(
    runtime.enter(Root),
    error => error.code === 'ENTRY_ACTIVATION_FAILED' && error.cause?.code === 'OWNER_NOT_READY',
  )
  assert.equal(childStarts, 0)
  assert.deepEqual(events, ['sibling-start', 'sibling-dispose'])
  assert.equal(runtime.inspect().rootEnvCount, 0)
  await runtime.dispose()
})

test('Binding-dependent plan templates do not leak exact choices across sibling Envs', async () => {
  const define = defineFor('binding-cache-isolation')
  const Capability = define.contract()
  const Selection = define.binding('selection', Capability)
  const A = define.service('a', { provides: [Capability], setup: () => ({ id: 'a' }) })
  const B = define.service('b', { provides: [Capability], setup: () => ({ id: 'b' }) })
  const Consumer = define.service('consumer', {
    requires: { selected: Selection },
    setup: ({ selected }) => ({ selected }),
  })
  const Base = define.entry('base', {})
  const Selected = define.entry('selected', {
    requires: { consumer: Consumer },
    parameters: { selection: Selection },
  })
  const runtime = createRuntime({ services: [Consumer, A, B] })
  const base = await runtime.enter(Base)
  const left = await base.enter(Selected, { selection: A })
  const right = await base.enter(Selected, { selection: B })
  assert.equal((await (await left.deps.consumer.load()).selected.load()).id, 'a')
  assert.equal((await (await right.deps.consumer.load()).selected.load()).id, 'b')
  await runtime.dispose()
})

// v0.5 (MIGRATION M-06): an un-awaited load() is a plain background Promise; the
// caller becomes Ready on its own result and is never poisoned afterwards.
test('an un-awaited load() does not become a setup barrier for the caller', async () => {
  const define = defineFor('strong-load-barrier')
  const release = deferred()
  let dependencyReady = false
  const Dependency = define.service('dependency', {
    async setup() {
      await release.promise
      dependencyReady = true
      return {}
    },
  })
  const Consumer = define.service('consumer', {
    requires: { dependency: Dependency },
    setup({ dependency }) {
      void dependency.load()
      return { id: 'consumer' }
    },
  })
  const Entry = define.entry({ requires: { consumer: Consumer } })
  const runtime = createRuntime({ services: [Consumer] })
  const env = await runtime.enter(Entry)
  let consumerReady = false
  const loading = env.deps.consumer.load().then(value => {
    consumerReady = true
    return value
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(consumerReady, true)
  assert.equal(dependencyReady, false)
  const consumer = await loading
  assert.equal(consumer.id, 'consumer')
  release.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(dependencyReady, true)
  assert.strictEqual(await env.deps.consumer.load(), consumer)
  await runtime.dispose()
})
