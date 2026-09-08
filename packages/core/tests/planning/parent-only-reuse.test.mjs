// K03 / K04 / K05 / K06 / R12 / R13 / R14 / R15 / R16 — parent-only reuse, anchors, collections, choices.
import assert from 'node:assert/strict'
import test from 'node:test'
import { auto, createRuntime, definePackage } from '../../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@v05/${id.replaceAll('.', '-')}-${version}`,
  version,
  syna: { id },
})
const slotOf = (env, nodeId) => env.inspect().nodes.find(node => node.nodeId === nodeId)?.slotId
const serviceSlot = (env, revision) => slotOf(env, `service:${revision.id}`)

test('R12 parent-only reuse: a Binding flip-back creates a new provider instance while ancestor-owned shared slots are still reused', async () => {
  const define = makeDefine('v05.flip-back')
  const Capability = define.contract()
  const Choice = define.binding('choice', Capability)
  let aStarts = 0
  const Database = define.service('database', { setup: () => ({ pool: {} }) })
  const A = makeDefine('v05.flip-back.a').service({ provides: [Capability], setup: () => ({ id: 'a', instance: ++aStarts }) })
  const B = makeDefine('v05.flip-back.b').service({ provides: [Capability], setup: () => ({ id: 'b' }) })
  const Consumer = define.service('consumer', {
    requires: { choice: Choice, database: Database },
    setup: ({ choice, database }) => ({ choice, database }),
  })
  const Scope = define.entry({ requires: { consumer: Consumer, database: Database }, parameters: { choice: Choice } })
  const runtime = createRuntime({ services: [Consumer, Database, A, B] })

  const grand = await runtime.enter(Scope, { choice: A })
  const grandA = await (await grand.deps.consumer.load()).choice.load()
  const parent = await grand.enter(Scope, { choice: B })
  assert.equal((await (await parent.deps.consumer.load()).choice.load()).id, 'b')
  const child = await parent.enter(Scope, { choice: A })
  const childA = await (await child.deps.consumer.load()).choice.load()

  assert.notStrictEqual(childA, grandA, 'the grandparent A slot is not visible in the parent, so it is not reused')
  assert.equal(aStarts, 2)
  assert.equal(serviceSlot(child, Database), serviceSlot(grand, Database), 'the ancestor-owned Database stays shared')
  assert.strictEqual(await child.deps.database.load(), await grand.deps.database.load())
  const explanation = await parent.explain(Scope, { choice: A })
  assert.equal(explanation.ok, true)
  const providerNode = explanation.nodes.find(node => node.nodeId === `service:${A.id}`)
  assert.equal(providerNode.placement, 'new')
  assert.equal(providerNode.cause.kind, 'not-in-parent')
  await runtime.dispose()
})

test('R13 a lineage-unique anchor survives a descendant that drops the family (Binding flip) and re-attaches when dependencies still match', async () => {
  const define = makeDefine('v05.anchor-gap')
  const Capability = define.contract()
  const Choice = define.binding('choice', Capability)
  const Database = define.service('database', { setup: () => ({}) })
  let uniqueStarts = 0
  const Unique = define.service('unique', {
    uniqueWithin: 'lineage',
    requires: { database: Database },
    setup: () => ({ instance: ++uniqueStarts }),
  })
  const WithUnique = makeDefine('v05.anchor-gap.with').service({
    provides: [Capability], requires: { unique: Unique }, setup: ({ unique }) => ({ unique }),
  })
  const Without = makeDefine('v05.anchor-gap.without').service({ provides: [Capability], setup: () => ({}) })
  const Scope = define.entry({ requires: { chosen: Choice, database: Database }, parameters: { choice: Choice } })
  const runtime = createRuntime({ services: [WithUnique, Without, Database] })
  const root = await runtime.enter(Scope, { choice: WithUnique })
  const first = await (await root.deps.chosen.load()).unique.load()
  const gap = await root.enter(Scope, { choice: Without })
  assert.equal(slotOf(gap, `service:${Unique.id}`), undefined, 'the gap Env no longer resolves the unique family')
  const again = await gap.enter(Scope, { choice: WithUnique })
  assert.strictEqual(await (await again.deps.chosen.load()).unique.load(), first, 'the persisted anchor was re-attached')
  assert.equal(uniqueStarts, 1)
  assert.equal(serviceSlot(again, Unique), serviceSlot(root, Unique))
  assert.notEqual(serviceSlot(again, WithUnique), serviceSlot(root, WithUnique), 'the non-unique provider itself is new (parent-only reuse)')
  const explanation = await gap.explain(Scope, { choice: WithUnique })
  assert.equal(explanation.nodes.find(node => node.nodeId === `service:${Unique.id}`).placement, 'reused')
  await runtime.dispose()
})

test('R13 a unique family cannot silently get a second instance: re-provided dependency conflicts with the chain; anchor mismatch on re-appearance is explicit; siblings anchor independently', async () => {
  const define = makeDefine('v05.anchor-conflict')
  const Tenant = define.input('tenant')
  const Capability = define.contract()
  const Choice = define.binding('choice', Capability)
  const Unique = define.service('unique', {
    uniqueWithin: 'lineage',
    requires: { tenant: Tenant },
    setup: () => ({}),
  })
  const WithUnique = makeDefine('v05.anchor-conflict.with').service({
    provides: [Capability], requires: { unique: Unique }, setup: () => ({}),
  })
  const Without = makeDefine('v05.anchor-conflict.without').service({ provides: [Capability], setup: () => ({}) })
  const Root = define.entry('root', { requires: { unique: Unique }, parameters: { tenant: Tenant } })
  const Reprovide = define.entry('reprovide', { parameters: { tenant: Tenant } })
  const runtime = createRuntime({ services: [Unique, WithUnique, Without] })
  const root = await runtime.enter(Root, { tenant: 'a' })
  await assert.rejects(root.enter(Reprovide, { tenant: 'b' }), error => {
    assert.equal(error.code, 'LINEAGE_UNIQUENESS_CONFLICT')
    const attempted = error.details.attempted[0]
    assert.equal(attempted.revision, Unique.id)
    assert.deepEqual(attempted.cause, { kind: 'dependency-forked', via: 'tenant', dependency: `input:${Tenant.id}` })
    assert.deepEqual(attempted.path, [`service:${Unique.id}`, `input:${Tenant.id}`])
    return true
  })

  const Scope = define.entry('scope', { requires: { chosen: Choice }, parameters: { choice: Choice, tenant: Tenant } })
  const Flip = define.entry('flip', { requires: { chosen: Choice }, parameters: { choice: Choice } })
  const anchored = await runtime.enter(Scope, { choice: WithUnique, tenant: 'a' })
  const gap = await anchored.enter(Scope, { choice: Without, tenant: 'b' })
  await assert.rejects(gap.enter(Flip, { choice: WithUnique }), error => {
    assert.equal(error.code, 'LINEAGE_UNIQUENESS_CONFLICT')
    assert.equal(error.details.attempted[0].cause.kind, 'pinned-dependency-mismatch')
    assert.equal(error.details.attempted[0].cause.via, 'tenant')
    return true
  })

  const left = await runtime.enter(Scope, { choice: WithUnique, tenant: 'left' })
  const right = await runtime.enter(Scope, { choice: WithUnique, tenant: 'right' })
  assert.notEqual(serviceSlot(left, Unique), serviceSlot(right, Unique))
  await runtime.dispose()
})

test('R14 C.all shares the slot with a direct dependency, keeps every revision, and propagates slot changes to collection and consumers', async () => {
  const define = makeDefine('v05.all')
  const Plugin = define.contract('plugin')
  const Config = define.input('config')
  const Impl10 = makeDefine('v05.all.impl', '1.0.0').service({ provides: [Plugin], setup: () => ({ v: '1.0.0' }) })
  const Impl20 = makeDefine('v05.all.impl', '2.0.0').service({
    provides: [Plugin],
    requires: { config: Config },
    setup: ({ config }) => ({ v: '2.0.0', config: config.read() }),
  })
  let eagerStarts = 0
  const Other = makeDefine('v05.all.other', '3.1.0').service({
    provides: [Plugin], eager: true, setup: () => { eagerStarts += 1; return { v: 'other' } },
  })
  const Manager = define.service('manager', {
    requires: { plugins: Plugin.all, direct: Impl10 },
    setup: ({ plugins, direct }) => ({ plugins, direct }),
  })
  const Entry = define.entry({ requires: { manager: Manager, direct: Impl10 }, parameters: { config: Config } })
  const runtime = createRuntime({ services: [Manager, Impl10, Impl20, Other] })
  const root = await runtime.enter(Entry, { config: 'root' })
  assert.equal(eagerStarts, 1, 'eager members of the collection follow their own policy')
  const manager = await root.deps.manager.load()
  const set = await manager.plugins.load()
  assert.deepEqual(set.candidates.map(c => `${c.familyId}@${c.version}`).sort(), [Impl10.id, Impl20.id, Other.id].sort())
  const direct = await manager.direct.load()
  const viaSet = await set.load(set.candidates.find(c => c.version === '1.0.0'))
  assert.strictEqual(direct, viaSet, 'same node, same slot')
  assert.strictEqual(direct, await root.deps.direct.load())

  const child = await root.enter(Entry, { config: 'child' })
  assert.notEqual(slotOf(child, `service:${Impl20.id}`), slotOf(root, `service:${Impl20.id}`), 'Input change forks the member')
  assert.notEqual(slotOf(child, `all:${Plugin.id}`), slotOf(root, `all:${Plugin.id}`), 'the collection forks with it')
  assert.notEqual(slotOf(child, `service:${Manager.id}`), slotOf(root, `service:${Manager.id}`), 'and its consumer')
  assert.equal(slotOf(child, `service:${Impl10.id}`), slotOf(root, `service:${Impl10.id}`), 'unaffected members stay shared')
  assert.equal(eagerStarts, 1, 'the inherited eager member was not restarted')
  const childSet = await (await child.deps.manager.load()).plugins.load()
  assert.equal((await childSet.load(childSet.candidates.find(c => c.version === '2.0.0'))).config, 'child')
  await runtime.dispose()
})

test('R14 C.all is unsatisfiable as a whole when members cannot coexist, and a collection CandidateRef is scoped to its collection', async () => {
  const define = makeDefine('v05.all-conflict')
  const Plugin = define.contract('plugin')
  const Fixed1 = makeDefine('v05.all-conflict.fixed', '1.0.0').service({ uniqueWithin: 'lineage', setup: () => ({}) })
  const Fixed2 = makeDefine('v05.all-conflict.fixed', '2.0.0').service({ uniqueWithin: 'lineage', setup: () => ({}) })
  const P1 = makeDefine('v05.all-conflict.p1').service({ provides: [Plugin], requires: { fixed: Fixed1 }, setup: () => ({}) })
  const P2 = makeDefine('v05.all-conflict.p2').service({ provides: [Plugin], requires: { fixed: Fixed2 }, setup: () => ({}) })
  const Manager = define.service('manager', { requires: { plugins: Plugin.all }, setup: ({ plugins }) => ({ plugins }) })
  const Entry = define.entry({ requires: { manager: Manager } })
  const conflicting = createRuntime({ services: [Manager, P1, P2, Fixed1, Fixed2] })
  await assert.rejects(conflicting.enter(Entry), error => error.code === 'LINEAGE_UNIQUENESS_CONFLICT')
  const check = await conflicting.check(Entry)
  assert.equal(check.ok, false)
  assert.equal(check.error.code, 'LINEAGE_UNIQUENESS_CONFLICT')

  const fine = createRuntime({ services: [Manager, P1, Fixed1] })
  const first = await fine.enter(Entry)
  const second = await fine.enter(Entry)
  const firstSet = await (await first.deps.manager.load()).plugins.load()
  const secondSet = await (await second.deps.manager.load()).plugins.load()
  await assert.rejects(secondSet.load(firstSet.candidates[0].candidateRef), error => error.code === 'FOREIGN_CANDIDATE_REF')
  await fine.dispose()
})

test('R15 an auto choice site is stable along a lineage, independent per edge; bare ambiguity and missing policy are distinct errors; policy bugs propagate', async () => {
  const define = makeDefine('v05.choices')
  const Capability = define.contract()
  const V1 = makeDefine('v05.choices.impl', '1.0.0').service({ provides: [Capability], setup: () => ({ v: 1 }) })
  const V2 = makeDefine('v05.choices.impl', '2.0.0').service({ provides: [Capability], setup: () => ({ v: 2 }) })
  const Other = makeDefine('v05.choices.other', '1.0.0').service({ provides: [Capability], setup: () => ({ v: 'other' }) })
  const Consumer = define.service('consumer', {
    requires: { first: auto(Capability), second: auto(Capability) },
    setup: ({ first, second }) => ({ first, second }),
  })
  const Root = define.entry('root', { requires: { consumer: Consumer } })
  const Child = define.entry('child', { requires: { consumer: Consumer, extra: V1 } })
  const runtime = createRuntime({
    services: [Consumer, V1, V2, Other],
    policy: {
      orderAutoCandidates(_contract, candidates, context) {
        const byKey = key => candidates.find(candidate => candidate.id === key)
        return context.dependencySite.endsWith('dependency:first')
          ? [byKey(V2.id), byKey(V1.id), byKey(Other.id)]
          : [byKey(Other.id), byKey(V2.id), byKey(V1.id)]
      },
    },
  })
  const root = await runtime.enter(Root)
  const consumer = await root.deps.consumer.load()
  assert.equal((await consumer.first.load()).v, 2)
  assert.equal((await consumer.second.load()).v, 'other')
  const child = await root.enter(Child)
  assert.strictEqual(await child.deps.consumer.load(), consumer, 'inherited choice sites did not move')
  assert.equal((await child.deps.extra.load()).v, 1, 'a new root requirement selects its own revision without rewriting old edges')
  await runtime.dispose()

  const Bare = define.service('bare', { requires: { capability: Capability }, setup: () => ({}) })
  const BareEntry = define.entry('bare', { requires: { bare: Bare } })
  const bareRuntime = createRuntime({ services: [Bare, V1, Other] })
  await assert.rejects(bareRuntime.enter(BareEntry), error => error.code === 'AMBIGUOUS_IMPLEMENTATION')
  const NoPolicy = define.entry('no-policy', { requires: { consumer: Consumer } })
  const noPolicy = createRuntime({ services: [Consumer, V1, Other] })
  await assert.rejects(noPolicy.enter(NoPolicy), error => error.code === 'MISSING_AUTO_POLICY')
  const broken = createRuntime({ services: [Consumer, V1, Other], policy: { orderAutoCandidates() { throw new TypeError('policy bug') } } })
  await assert.rejects(broken.enter(NoPolicy), error => error instanceof TypeError && error.message === 'policy bug')
  await assert.rejects(broken.check(NoPolicy), error => error instanceof TypeError)
  const partial = createRuntime({ services: [Consumer, V1, Other], policy: { orderAutoCandidates: (_c, candidates) => [candidates[0]] } })
  await assert.rejects(partial.enter(NoPolicy), error => error.code === 'INVALID_DESCRIPTOR')
})

test('R16 same Binding choice is a no-op, same Input payload re-provision forks, omitted parameter and undefined differ, duplicate parameters rejected', async () => {
  const define = makeDefine('v05.parameters')
  const Capability = define.contract()
  const Current = define.input('current')
  const Choice = define.binding('choice', Capability)
  const Provider = define.service('provider', { provides: [Capability], setup: () => ({}) })
  const Consumer = define.service('consumer', {
    requires: { current: Current, choice: Choice },
    setup: ({ current, choice }) => ({ current: current.read(), choice }),
  })
  const Scope = define.entry({ requires: { consumer: Consumer }, parameters: { current: Current, choice: Choice } })
  const runtime = createRuntime({ services: [Consumer, Provider] })
  const payload = { same: true }
  const root = await runtime.enter(Scope, { current: payload, choice: Provider })
  const child = await root.enter(Scope, { current: payload, choice: Choice.to(Provider) })
  assert.equal(slotOf(child, `binding:${Choice.id}`), slotOf(root, `binding:${Choice.id}`))
  assert.notEqual(slotOf(child, `input:${Current.id}`), slotOf(root, `input:${Current.id}`))
  assert.notEqual(slotOf(child, `service:${Consumer.id}`), slotOf(root, `service:${Consumer.id}`))
  assert.strictEqual((await child.deps.consumer.load()).current, payload)

  const undefinedChild = await root.enter(Scope, { current: undefined, choice: Provider })
  assert.strictEqual((await undefinedChild.deps.consumer.load()).current, undefined)
  await assert.rejects(root.enter(Scope, { choice: Provider }), error =>
    error.code === 'MISSING_INPUT' && error.details.missingInputs.includes(Current.id))
  const explanation = await root.explain(Scope, {})
  assert.equal(explanation.ok, false)
  assert.deepEqual(explanation.missingInputs, [Current.id])
  assert.deepEqual(explanation.missingBindings, [Choice.id])

  assert.throws(
    () => define.entry('dup', { parameters: { a: Current, b: Current } }),
    /declared twice/,
  )
  const OtherContract = define.contract('other')
  await assert.rejects(
    root.enter(Scope, { current: 1, choice: { kind: 'implementation-ref', contractId: OtherContract.id, familyId: Provider.family.id, range: '*' } }),
    error => error.code === 'INCOMPATIBLE_IMPLEMENTATION',
  )
  await runtime.dispose()
})

test('K03 fresh/share accept exact and family targets; conflicts fail explicitly; payload equality never drives reuse', async () => {
  const define = makeDefine('v05.reuse')
  const State = define.service('state', { setup: () => ({ token: {} }) })
  const Consumer = define.service('consumer', { requires: { state: State }, setup: ({ state }) => ({ state }) })
  const Root = define.entry('root', { requires: { consumer: Consumer, state: State } })
  const runtime = createRuntime({ services: [Consumer, State] })
  const root = await runtime.enter(Root)
  const freshFamily = await root.derive({ reuse: { fresh: [State.family] } })
  assert.equal(freshFamily.inspect().nodes.length, root.inspect().nodes.length)
  assert.notEqual(slotOf(freshFamily, `service:${State.id}`), slotOf(root, `service:${State.id}`))
  assert.notEqual(slotOf(freshFamily, `service:${Consumer.id}`), slotOf(root, `service:${Consumer.id}`))
  const shared = await root.derive({ reuse: { share: [State] } })
  assert.equal(slotOf(shared, `service:${State.id}`), slotOf(root, `service:${State.id}`))
  await assert.rejects(root.derive({ reuse: { fresh: [State], share: [State.family] } }), error => error.code === 'SHARE_CONSTRAINT_FAILED')
  const Unknown = makeDefine('v05.reuse.unknown').service({ setup: () => ({}) })
  await assert.rejects(root.derive({ reuse: { fresh: [Unknown] } }), error => error.code === 'INACTIVE_REUSE_TARGET')
  await runtime.dispose()
})
