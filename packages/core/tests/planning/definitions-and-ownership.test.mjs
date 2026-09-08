import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRuntime,
  definePackage,
  forward,
} from '../../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@test/${id.replaceAll('.', '-')}`,
  version,
  syna: { id },
})

function nodeByLabel(env, prefix) {
  const node = env.inspect().nodes.find(item => item.label.startsWith(prefix))
  assert.ok(node, `Expected a node starting with ${prefix}`)
  return node
}

test('definePackage derives stable service identities and exact versions from the manifest', () => {
  const v1 = makeDefine('test.package-version', '1.8.4').service({ setup: () => ({}) })
  const v2 = makeDefine('test.package-version', '2.4.2').service({ setup: () => ({}) })
  assert.equal(v1.family.id, 'test.package-version')
  assert.equal(v1.version, '1.8.4')
  assert.equal(v2.version, '2.4.2')
  assert.equal(v1.id, 'test.package-version@1.8.4')
})

test('Runtime construction creates no Env or instance; access order does not affect ownership', async () => {
  let starts = 0
  const define = makeDefine('test.lazy-order')
  const Counter = define.service({
    setup() {
      return { id: ++starts }
    },
  })
  const Root = define.entry('root', { requires: { counter: Counter } })
  const Child = define.entry('child', { requires: { counter: Counter } })
  const runtime = createRuntime({ services: [Counter] })

  assert.equal(runtime.inspect().rootEnvCount, 0)
  assert.equal(starts, 0)
  const root = await runtime.enter(Root)
  const child = await root.enter(Child)
  assert.equal(starts, 0)

  const fromChild = await child.deps.counter.load()
  const fromRoot = await root.deps.counter.load()
  assert.strictEqual(fromChild, fromRoot)
  assert.equal(starts, 1)
  assert.equal(
    nodeByLabel(root, 'test.lazy-order@').slotId,
    nodeByLabel(child, 'test.lazy-order@').slotId,
  )
  await root.dispose()
})

test('ServiceRef is safely destructurable and materializes only when load() is called', async () => {
  let starts = 0
  const define = makeDefine('test.dependency-ref')
  const Service = define.service({ setup: () => ({ id: ++starts }) })
  const Root = define.entry({ requires: { service: Service } })
  const runtime = createRuntime({ services: [Service] })
  const env = await runtime.enter(Root)

  const { service } = env.deps
  assert.equal(starts, 0)
  assert.equal((await service.load()).id, 1)
  assert.equal((await service.load()).id, 1)
  assert.equal(starts, 1)
  await env.dispose()
})

test('re-providing an Input forks exactly its reverse dependency closure', async () => {
  const define = makeDefine('test.input-fork')
  const Context = define.input('context')
  let dependentStarts = 0
  let unrelatedStarts = 0

  const Dependent = define.service('dependent', {
    requires: { context: Context },
    setup({ context }) {
      const id = ++dependentStarts
      return { id, read: async () => context.read() }
    },
  })
  const Unrelated = define.service('unrelated', {
    setup: () => ({ id: ++unrelatedStarts }),
  })
  const Scope = define.entry({
    requires: { dependent: Dependent, unrelated: Unrelated },
    parameters: { context: Context },
  })

  const runtime = createRuntime({ services: [Dependent, Unrelated] })
  const parent = await runtime.enter(Scope, { context: 'parent' })
  const parentDependent = await parent.deps.dependent.load()
  const parentUnrelated = await parent.deps.unrelated.load()
  const child = await parent.enter(Scope, { context: 'child' })
  const childDependent = await child.deps.dependent.load()
  const childUnrelated = await child.deps.unrelated.load()

  assert.notStrictEqual(childDependent, parentDependent)
  assert.strictEqual(childUnrelated, parentUnrelated)
  assert.equal(await childDependent.read(), 'child')
  assert.equal(await parentDependent.read(), 'parent')
  assert.equal(dependentStarts, 2)
  assert.equal(unrelatedStarts, 1)
  await parent.dispose()
})

test('fresh forks a slot and all dependants; share is a hard constraint', async () => {
  const define = makeDefine('test.fresh-share')
  const B = define.service('b', { setup: () => ({ token: {} }) })
  const A = define.service('a', {
    requires: { b: B },
    setup({ b }) { return { b: async () => b.load() } },
  })
  const Root = define.entry('root', { requires: { a: A, b: B } })
  const Fresh = define.entry('fresh', {
    requires: { a: A, b: B },
    reuse: { fresh: [B] },
  })
  const Impossible = define.entry('impossible', {
    requires: { b: B },
    reuse: { fresh: [B], share: [B] },
  })

  const runtime = createRuntime({ services: [A, B] })
  const root = await runtime.enter(Root)
  const child = await root.enter(Fresh)
  assert.notEqual(nodeByLabel(root, `${B.family.id}@`).slotId, nodeByLabel(child, `${B.family.id}@`).slotId)
  assert.notEqual(nodeByLabel(root, `${A.family.id}@`).slotId, nodeByLabel(child, `${A.family.id}@`).slotId)
  assert.notStrictEqual(await root.deps.a.load(), await child.deps.a.load())
  await assert.rejects(root.enter(Impossible), error => error.code === 'SHARE_CONSTRAINT_FAILED')
  await root.dispose()
})

test('service ranges are deterministic and prefer compatible ancestor revisions', async () => {
  const Worker18 = makeDefine('test.range-worker', '1.8.0').service({
    setup: () => ({ version: '1.8' }),
  })
  const Worker19 = makeDefine('test.range-worker', '1.9.0').service({
    setup: () => ({ version: '1.9' }),
  })
  const Worker20 = makeDefine('test.range-worker', '2.0.0').service({
    setup: () => ({ version: '2.0' }),
  })
  const entries = makeDefine('test.range-entry')
  const Root = entries.entry('root', { requires: { worker: Worker18.range('^1') } })
  const Child = entries.entry('child', { requires: { worker: Worker18.range('^1') } })
  const runtime = createRuntime({ services: [Worker18, Worker19, Worker20] })
  const root = await runtime.enter(Root)
  const child = await root.enter(Child)
  assert.equal((await root.deps.worker.load()).version, '1.9')
  assert.strictEqual(await root.deps.worker.load(), await child.deps.worker.load())
  await root.dispose()
})

test('freshening one member of a structural SCC forks the whole SCC', async () => {
  const define = makeDefine('test.scc')
  let A
  let B
  A = define.service('a', {
    requires: { b: forward(() => B) },
    setup: () => ({ name: 'a' }),
  })
  B = define.service('b', {
    requires: { a: forward(() => A) },
    setup: () => ({ name: 'b' }),
  })
  const Root = define.entry('root', { requires: { a: A, b: B } })
  const Child = define.entry('child', {
    requires: { a: A, b: B },
    reuse: { fresh: [A] },
  })
  const runtime = createRuntime({ services: [A, B] })
  const root = await runtime.enter(Root)
  const child = await root.enter(Child)
  assert.notEqual(nodeByLabel(root, `${A.family.id}@`).slotId, nodeByLabel(child, `${A.family.id}@`).slotId)
  assert.notEqual(nodeByLabel(root, `${B.family.id}@`).slotId, nodeByLabel(child, `${B.family.id}@`).slotId)
  await root.dispose()
})

test('different root Envs may independently anchor different revisions of a fixed family', async () => {
  const Fixed1 = makeDefine('test.fixed-roots', '1.0.0').service({
    uniqueWithin: 'lineage', setup: () => ({ version: 1 }),
  })
  const Fixed2 = makeDefine('test.fixed-roots', '2.0.0').service({
    uniqueWithin: 'lineage', setup: () => ({ version: 2 }),
  })
  const entries = makeDefine('test.fixed-root-entry')
  const Root1 = entries.entry('one', { requires: { fixed: Fixed1 } })
  const Root2 = entries.entry('two', { requires: { fixed: Fixed2 } })
  const runtime = createRuntime({ services: [Fixed1, Fixed2] })
  const first = await runtime.enter(Root1)
  const second = await runtime.enter(Root2)
  assert.equal((await first.deps.fixed.load()).version, 1)
  assert.equal((await second.deps.fixed.load()).version, 2)
  await runtime.dispose()
})

test('a descendant cannot diverge a lineage-fixed family', async () => {
  const Fixed1 = makeDefine('test.fixed-lineage', '1.0.0').service({
    uniqueWithin: 'lineage', setup: () => ({ version: 1 }),
  })
  const Fixed2 = makeDefine('test.fixed-lineage', '2.0.0').service({
    uniqueWithin: 'lineage', setup: () => ({ version: 2 }),
  })
  const entries = makeDefine('test.fixed-lineage-entry')
  const Root = entries.entry('root', { requires: { fixed: Fixed1 } })
  const Child = entries.entry('child', { requires: { fixed: Fixed2 } })
  const runtime = createRuntime({ services: [Fixed1, Fixed2] })
  const root = await runtime.enter(Root)
  await assert.rejects(root.enter(Child), error => error.code === 'LINEAGE_UNIQUENESS_CONFLICT')
  await root.dispose()
})

test('a disposed Env cannot materialize a dormant owned slot', async () => {
  const define = makeDefine('test.disposed-lazy')
  let starts = 0
  const Lazy = define.service({ setup() { starts += 1; return {} } })
  const Root = define.entry({ requires: { lazy: Lazy } })
  const runtime = createRuntime({ services: [Lazy] })
  const env = await runtime.enter(Root)
  const ref = env.deps.lazy
  await env.dispose()
  await assert.rejects(ref.load(), error => error.code === 'SLOT_NOT_LOADABLE')
  assert.equal(starts, 0)
})

test('slot topology is invariant under different materialization orders', async () => {
  const define = makeDefine('test.random-order')
  const revisions = []
  for (let index = 0; index < 8; index += 1) {
    const requires = {}
    if (index >= 1) requires.previous = revisions[index - 1]
    if (index >= 3) requires.skip = revisions[index - 3]
    revisions.push(define.service(`s${index}`, {
      requires,
      setup(dependencies) {
        return {
          index,
          touch: async () => Promise.all(Object.values(dependencies).map(ref => ref.load())),
        }
      },
    }))
  }
  const requirements = Object.fromEntries(revisions.map((revision, index) => [`s${index}`, revision]))
  const Root = define.entry('root', { requires: requirements })
  const Child = define.entry('child', { requires: requirements })
  const runtime = createRuntime({ services: revisions })
  const root = await runtime.enter(Root)
  const child = await root.enter(Child)
  for (const index of [7, 1, 5, 0, 4, 2, 6, 3]) await root.deps[`s${index}`].load()
  for (const index of [3, 6, 2, 4, 0, 5, 1, 7]) await child.deps[`s${index}`].load()
  for (const revision of revisions) {
    assert.equal(
      nodeByLabel(root, `${revision.family.id}@`).slotId,
      nodeByLabel(child, `${revision.family.id}@`).slotId,
    )
  }
  await root.dispose()
})

test('nominally identical physical package copies canonicalize; a differing setup body or manifest fails', async () => {
  const RevisionA = makeDefine('test.duplicate', '1.0.0').service({
    setup: () => ({ copy: 'same' }),
  })
  const RevisionB = makeDefine('test.duplicate', '1.0.0').service({
    setup: () => ({ copy: 'same' }),
  })
  const entryDefine = makeDefine('test.duplicate-entry')
  const Root = entryDefine.entry({ requires: { service: RevisionB } })
  const runtime = createRuntime({ services: [RevisionA, RevisionB] })
  const env = await runtime.enter(Root)
  assert.equal((await env.deps.service.load()).copy, 'same')
  await env.dispose()

  const DifferentSetup = makeDefine('test.duplicate', '1.0.0').service({
    setup: () => ({ copy: 'different' }),
  })
  assert.throws(
    () => createRuntime({ services: [RevisionA, DifferentSetup] }),
    error => error.code === 'DUPLICATE_DEFINITION',
  )
  const Conflicting = makeDefine('test.duplicate', '1.0.0').service({
    eager: true,
    setup: () => ({ copy: 'conflicting' }),
  })
  assert.throws(
    () => createRuntime({ services: [RevisionA, Conflicting] }),
    error => error.code === 'DUPLICATE_DEFINITION',
  )
})

test('private transitive services are usable internally but not publicly admitted', async () => {
  const define = makeDefine('test.private-service')
  const Private = define.service('private', { setup: () => ({ secret: 42 }) })
  const Public = define.service({
    requires: { private: Private },
    setup({ private: privateRef }) {
      return { read: async () => (await privateRef.load()).secret }
    },
  })
  const Root = define.entry({ requires: { service: Public } })
  const runtime = createRuntime({ services: [Public] })
  const env = await runtime.enter(Root)
  assert.equal(await (await env.deps.service.load()).read(), 42)
  assert.deepEqual(runtime.inspect().admittedServices, [Public.id])
  assert.deepEqual([...runtime.inspect().privateServices].sort(), [Private.id, Public.id].sort())

  const Invalid = define.entry('invalid', { requires: { private: Private } })
  await assert.rejects(runtime.enter(Invalid), error => error.code === 'MISSING_SERVICE')
  await env.dispose()
})

test('run() gives typed dependency refs directly and guarantees disposal', async () => {
  const define = makeDefine('test.run')
  let disposed = 0
  const Service = define.service({
    setup(_deps, { onDispose }) {
      onDispose(() => { disposed += 1 })
      return { answer: 42 }
    },
  })
  const Root = define.entry({ requires: { service: Service } })
  const runtime = createRuntime({ services: [Service] })
  const answer = await runtime.run(Root, async ({ service }, env) => {
    assert.equal(env.state, 'ready')
    return (await service.load()).answer
  })
  assert.equal(answer, 42)
  assert.equal(disposed, 1)
})

test('descriptor API identities are independent from package semver and change only with apiVersion', () => {
  const v1 = makeDefine('test.api-identity', '1.7.0')
  const v2 = makeDefine('test.api-identity', '2.1.0')

  const ContractV1 = v1.contract('capability')
  const ContractV2 = v2.contract('capability')
  const ContractV2Api2 = v2.contract('capability', { apiVersion: 2 })
  const InputV1 = v1.input('context')
  const InputV2 = v2.input('context')
  const InputV2Api2 = v2.input('context', { apiVersion: 2 })
  const BindingV1 = v1.binding('provider', ContractV1)
  const BindingV2 = v2.binding('provider', ContractV2)
  const BindingV2Api2 = v2.binding('provider', ContractV2, { apiVersion: 2 })
  const ServiceV1 = v1.service('worker', { setup: () => ({}) })
  const ServiceV2 = v2.service('worker', { setup: () => ({}) })
  const EntryV1 = v1.entry('main', {})
  const EntryV2 = v2.entry('main', {})
  const EntryV2Api2 = v2.entry('main', { apiVersion: 2 })

  assert.equal(ContractV1.id, ContractV2.id)
  assert.equal(InputV1.id, InputV2.id)
  assert.equal(BindingV1.id, BindingV2.id)
  assert.equal(EntryV1.id, EntryV2.id)
  assert.notEqual(ContractV2.id, ContractV2Api2.id)
  assert.notEqual(InputV2.id, InputV2Api2.id)
  assert.notEqual(BindingV2.id, BindingV2Api2.id)
  assert.notEqual(EntryV2.id, EntryV2Api2.id)
  assert.equal(ServiceV1.family.id, ServiceV2.family.id)
  assert.notEqual(ServiceV1.id, ServiceV2.id)
})
