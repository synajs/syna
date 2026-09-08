import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auto,
  createRuntime,
  definePackage,
} from '../../dist/index.js'

const makeDefine = (id, version = '1.0.0', metadata) => definePackage({
  name: `@test/${id.replaceAll('.', '-')}-${version}`,
  version,
  syna: { id, ...(metadata ? { metadata } : {}) },
})

function nodeByLabel(env, prefix) {
  const node = env.inspect().nodes.find(item => item.label.startsWith(prefix))
  assert.ok(node, `Expected a node starting with ${prefix}`)
  return node
}

test('a naked Contract rejects ambiguous implementation families', async () => {
  const contractDefine = makeDefine('test.strict-contract')
  const Capability = contractDefine.contract()
  const Impl1 = makeDefine('test.strict-impl-a', '1.0.0').service({
    provides: [Capability], setup: () => ({ name: 'a' }),
  })
  const Impl2 = makeDefine('test.strict-impl-b', '2.0.0').service({
    provides: [Capability], setup: () => ({ name: 'b' }),
  })
  const Consumer = makeDefine('test.strict-consumer').service({
    requires: { capability: Capability },
    setup({ capability }) {
      return { name: async () => (await capability.load()).name }
    },
  })
  const Entry = contractDefine.entry('strict', { requires: { consumer: Consumer } })
  const runtime = createRuntime({ services: [Consumer, Impl1, Impl2] })
  await assert.rejects(
    runtime.enter(Entry),
    error => error.code === 'AMBIGUOUS_IMPLEMENTATION',
  )
})

test('auto Contract choices are independent per dependency edge', async () => {
  const define = makeDefine('test.auto-independent')
  const Capability = define.contract()
  const A = makeDefine('test.auto-independent-a').service({
    provides: [Capability], setup: () => ({ id: 'a' }),
  })
  const B = makeDefine('test.auto-independent-b').service({
    provides: [Capability], setup: () => ({ id: 'b' }),
  })
  const Consumer = define.service('consumer', {
    requires: { first: auto(Capability), second: auto(Capability) },
    setup({ first, second }) {
      return { values: async () => [(await first.load()).id, (await second.load()).id] }
    },
  })
  const Entry = define.entry({ requires: { consumer: Consumer } })
  const runtime = createRuntime({
    services: [Consumer, A, B],
    policy: {
      orderAutoCandidates(_contract, candidates, context) {
        return context.dependencySite.endsWith('dependency:first')
          ? [A, B]
          : [B, A]
      },
    },
  })
  const env = await runtime.enter(Entry)
  assert.deepEqual(await (await env.deps.consumer.load()).values(), ['a', 'b'])
  await env.dispose()
})

test('Contract.all exposes every admitted revision and shares canonical slots', async () => {
  const define = makeDefine('test.collection-contract')
  const Capability = define.contract()
  const Provider18 = makeDefine('test.collection-provider', '1.8.0', { displayName: 'Provider' }).service({
    provides: [Capability], setup: () => ({ version: '1.8' }),
  })
  const Provider24 = makeDefine('test.collection-provider', '2.4.0', { displayName: 'Provider' }).service({
    provides: [Capability], setup: () => ({ version: '2.4' }),
  })
  const Other = makeDefine('test.collection-other', '3.0.0', { displayName: 'Other' }).service({
    provides: [Capability], setup: () => ({ version: '3.0' }),
  })
  const Consumer = define.service('consumer', {
    requires: {
      automatic: auto(Capability),
      implementations: Capability.all,
    },
    setup({ automatic, implementations }) {
      return { automatic, implementations }
    },
  })
  const Entry = define.entry({ requires: { consumer: Consumer } })
  const runtime = createRuntime({
    services: [Consumer, Provider18, Provider24, Other],
    policy: { orderAutoCandidates: (_contract, candidates) => [Other, Provider24, Provider18].filter(item => candidates.includes(item)) },
  })
  const env = await runtime.enter(Entry)
  const consumer = await env.deps.consumer.load()
  const implementations = await consumer.implementations.load()
  assert.deepEqual(
    implementations.candidates.map(candidate => `${candidate.familyId}@${candidate.version}`),
    [Other.id, Provider24.id, Provider18.id],
  )
  assert.deepEqual([...implementations], implementations.candidates)

  const selectedAutomatic = await consumer.automatic.load()
  const automaticCandidate = implementations.candidates.find(candidate =>
    candidate.familyId === Other.family.id && candidate.version === Other.version,
  )
  assert.ok(automaticCandidate)
  assert.strictEqual(selectedAutomatic, await implementations.load(automaticCandidate))
  await env.dispose()
})

test('C.all CandidateRefs are exact and scoped to their own collection slot', async () => {
  const define = makeDefine('test.collection-ref')
  const Capability = define.contract()
  const Provider = makeDefine('test.collection-ref-provider').service({
    provides: [Capability], setup: () => ({ id: {} }),
  })
  const Panel = define.service('panel', {
    requires: { implementations: Capability.all },
    setup({ implementations }) { return { implementations } },
  })
  const Entry = define.entry({ requires: { panel: Panel } })
  const runtime = createRuntime({ services: [Panel, Provider] })
  const first = await runtime.enter(Entry)
  const second = await runtime.enter(Entry)
  const firstSet = await (await first.deps.panel.load()).implementations.load()
  const secondSet = await (await second.deps.panel.load()).implementations.load()
  const candidate = firstSet.candidates[0]
  assert.ok(candidate)
  await assert.rejects(
    secondSet.load(candidate.candidateRef),
    error => error.code === 'FOREIGN_CANDIDATE_REF',
  )
  await runtime.dispose()
})

test('Binding choices persist by family/range and are inherited by descendants', async () => {
  const define = makeDefine('test.binding')
  const Capability = define.contract()
  const Choice = define.binding('choice', Capability)
  const Context = define.input('context')
  const Provider = makeDefine('test.binding-provider', '2.4.1').service({
    provides: [Capability],
    requires: { context: Context },
    setup({ context }) { return { context: async () => context.read() } },
  })
  const Consumer = define.service('consumer', {
    requires: { choice: Choice },
    setup({ choice }) { return { choice } },
  })
  const Anchor = define.entry('anchor', { parameters: { choice: Choice } })
  const Use = define.entry('use', {
    requires: { consumer: Consumer },
    parameters: { context: Context },
  })
  const runtime = createRuntime({ services: [Consumer, Provider] })
  const anchor = await runtime.enter(Anchor, { choice: Choice.to(Provider) })
  const first = await anchor.enter(Use, { context: 'one' })
  const second = await anchor.enter(Use, { context: 'two' })
  const providerOne = await (await first.deps.consumer.load()).choice.load()
  const providerTwo = await (await second.deps.consumer.load()).choice.load()
  assert.notStrictEqual(providerOne, providerTwo)
  assert.equal(await providerOne.context(), 'one')
  assert.equal(await providerTwo.context(), 'two')
  await anchor.dispose()
})

test('reassigning a Binding forks its synthetic slot and reverse dependency closure', async () => {
  const define = makeDefine('test.binding-reassign')
  const Capability = define.contract()
  const Choice = define.binding('choice', Capability)
  const A = makeDefine('test.binding-reassign-a').service({
    provides: [Capability], setup: () => ({ id: 'a' }),
  })
  const B = makeDefine('test.binding-reassign-b').service({
    provides: [Capability], setup: () => ({ id: 'b' }),
  })
  const Consumer = define.service('consumer', {
    requires: { choice: Choice },
    setup({ choice }) { return { id: async () => (await choice.load()).id } },
  })
  const Scope = define.entry({
    requires: { consumer: Consumer },
    parameters: { choice: Choice },
  })
  const runtime = createRuntime({ services: [Consumer, A, B] })
  const parent = await runtime.enter(Scope, { choice: A })
  const child = await parent.enter(Scope, { choice: B })
  assert.equal(await (await parent.deps.consumer.load()).id(), 'a')
  assert.equal(await (await child.deps.consumer.load()).id(), 'b')
  assert.notEqual(
    nodeByLabel(parent, Choice.id).slotId,
    nodeByLabel(child, Choice.id).slotId,
  )
  await parent.dispose()
})

test('Contract.all includes eager candidates and only eager ones materialize at activation', async () => {
  const define = makeDefine('test.collection-eager')
  const Capability = define.contract()
  let eagerStarts = 0
  let lazyStarts = 0
  const Eager = makeDefine('test.collection-eager-provider').service({
    provides: [Capability], eager: true,
    setup() { eagerStarts += 1; return { id: 'eager' } },
  })
  const Lazy = makeDefine('test.collection-lazy-provider').service({
    provides: [Capability],
    setup() { lazyStarts += 1; return { id: 'lazy' } },
  })
  const Panel = define.service('panel', {
    requires: { implementations: Capability.all },
    setup({ implementations }) { return { implementations } },
  })
  const Entry = define.entry({ requires: { panel: Panel } })
  const runtime = createRuntime({ services: [Panel, Eager, Lazy] })
  const env = await runtime.enter(Entry)
  assert.equal(eagerStarts, 1)
  assert.equal(lazyStarts, 0)
  const implementations = await (await env.deps.panel.load()).implementations.load()
  const lazy = implementations.candidates.find(candidate => candidate.familyId === Lazy.family.id)
  assert.ok(lazy)
  assert.equal((await implementations.load(lazy)).id, 'lazy')
  assert.equal(lazyStarts, 1)
  await env.dispose()
})

test('C.all fails when all advertised implementations cannot coexist', async () => {
  const define = makeDefine('test.collection-conflict')
  const Capability = define.contract()
  const Fixed1 = makeDefine('test.collection-fixed-dependency', '1.0.0').service({
    uniqueWithin: 'lineage', setup: () => ({ version: 1 }),
  })
  const Fixed2 = makeDefine('test.collection-fixed-dependency', '2.0.0').service({
    uniqueWithin: 'lineage', setup: () => ({ version: 2 }),
  })
  const Provider1 = makeDefine('test.collection-conflict-provider-a').service({
    provides: [Capability], requires: { fixed: Fixed1 }, setup: () => ({ id: 'a' }),
  })
  const Provider2 = makeDefine('test.collection-conflict-provider-b').service({
    provides: [Capability], requires: { fixed: Fixed2 }, setup: () => ({ id: 'b' }),
  })
  const Panel = define.service('panel', {
    requires: { implementations: Capability.all }, setup: () => ({}),
  })
  const Entry = define.entry({ requires: { panel: Panel } })
  const runtime = createRuntime({ services: [Panel, Provider1, Provider2, Fixed1, Fixed2] })
  await assert.rejects(runtime.enter(Entry), error =>
    error.code === 'LINEAGE_UNIQUENESS_CONFLICT'
    || error.code === 'UNSATISFIABLE_TOPOLOGY')
})

test('private transitive Contract implementations never leak into auto or C.all candidates', async () => {
  const define = makeDefine('test.private-contract')
  const Capability = define.contract()
  const Public = makeDefine('test.private-contract-public').service({
    provides: [Capability], setup: () => ({ id: 'public' }),
  })
  const Private = makeDefine('test.private-contract-private').service({
    provides: [Capability], setup: () => ({ id: 'private' }),
  })
  const Wrapper = makeDefine('test.private-contract-wrapper').service({
    requires: { private: Private }, setup: () => ({}),
  })
  const Consumer = define.service('consumer', {
    requires: { automatic: Capability, implementations: Capability.all },
    setup({ automatic, implementations }) { return { automatic, implementations } },
  })
  const Entry = define.entry({ requires: { consumer: Consumer } })
  const runtime = createRuntime({ services: [Consumer, Public, Wrapper] })
  const env = await runtime.enter(Entry)
  const consumer = await env.deps.consumer.load()
  assert.equal((await consumer.automatic.load()).id, 'public')
  assert.deepEqual((await consumer.implementations.load()).candidates.map(item => item.familyId), [Public.family.id])
  await env.dispose()
})

test('durable implementation refs serialize, parse and upgrade within their version intent', () => {
  const define = makeDefine('test.refs')
  const Capability = define.contract()
  const Choice = define.binding('choice', Capability)
  const Provider21 = makeDefine('test.refs-provider', '2.1.0', { displayName: 'Provider' }).service({
    provides: [Capability], setup: () => ({}),
  })
  const Provider27 = makeDefine('test.refs-provider', '2.7.0', { displayName: 'Provider' }).service({
    provides: [Capability], setup: () => ({}),
  })
  const runtime = createRuntime({ services: [Provider21, Provider27] })
  const serialized = JSON.parse(JSON.stringify(Choice.to(Provider21)))
  const parsed = Choice.parse(serialized)
  const resolved = runtime.catalog.resolve(parsed)
  assert.equal(resolved.version, '2.7.0')
  assert.equal(resolved.familyMetadata.displayName, 'Provider')
})
