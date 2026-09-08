// R17 / R18 / R19 / K09 — plan cache neutrality and bounds, churn, cleanup ordering.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage, forward } from '../../dist/index.js'
import { PlanTemplateCache } from '../../dist/internal/plan-cache.js'

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@v05/${id.replaceAll('.', '-')}`,
  version,
  syna: { id },
})

function buildWorld(define) {
  const Request = define.input('request')
  const Tenant = define.input('tenant')
  const Capability = define.contract()
  const Choice = define.binding('choice', Capability)
  const Pool = define.service('pool', { setup: () => ({ pool: {} }) })
  const A = makeDefine(`${define.package.id}.a`).service({ provides: [Capability], setup: () => ({ id: 'a' }) })
  const B = makeDefine(`${define.package.id}.b`).service({ provides: [Capability], setup: () => ({ id: 'b' }) })
  const TenantCache = define.service('tenant-cache', { requires: { tenant: Tenant, pool: Pool }, setup: () => ({}) })
  const Handler = define.service('handler', {
    requires: { request: Request, cache: TenantCache, provider: Choice, pool: Pool },
    setup: () => ({}),
  })
  const App = define.entry('app', { requires: { pool: Pool } })
  const Site = define.entry('site', { requires: { cache: TenantCache }, parameters: { tenant: Tenant, choice: Choice } })
  const RequestEntry = define.entry('request', { requires: { handler: Handler }, parameters: { request: Request } })
  return { Request, Tenant, Choice, Pool, A, B, TenantCache, Handler, App, Site, RequestEntry }
}

async function topology(limits) {
  const define = makeDefine('v05.cache-neutral')
  const w = buildWorld(define)
  const runtime = createRuntime({ services: [w.Pool, w.TenantCache, w.Handler, w.A, w.B], limits })
  const app = await runtime.enter(w.App)
  const observed = []
  for (const round of [0, 1, 2]) {
    const siteA = await app.enter(w.Site, { tenant: 'a', choice: round % 2 === 0 ? w.A : w.B })
    const siteB = await app.enter(w.Site, { tenant: 'b', choice: w.B })
    for (const site of [siteA, siteB]) {
      for (let index = 0; index < 3; index += 1) {
        const request = await site.enter(w.RequestEntry, { request: index })
        const explanation = await site.explain(w.RequestEntry, { request: index })
        observed.push(request.inspect().nodes.map(node => [node.nodeId, node.ownerEnvId === request.id ? 'owned' : node.ownerEnvId === site.id ? 'site' : 'app'].join('=')).join('|'))
        observed.push(explanation.nodes.map(node => `${node.nodeId}:${node.placement}`).join('|'))
        await request.dispose()
      }
    }
    await siteA.dispose()
    await siteB.dispose()
  }
  const stats = runtime.inspect().planCache
  await runtime.dispose()
  return { observed, stats }
}

test('R17 plan-cache disabled, enabled and constantly evicting yield identical topologies and explanations', async () => {
  const large = await topology({ planCacheEntries: 512 })
  const tiny = await topology({ planCacheEntries: 1 })
  const small = await topology({ planCacheEntries: 3 })
  assert.deepEqual(tiny.observed, large.observed)
  assert.deepEqual(small.observed, large.observed)
  assert.ok(large.stats.hits > 0)
  assert.ok(tiny.stats.evictions > 0)
})

test('R17 cache keys separate public and private realms, and templates never cross slots between parents of equal shape', async () => {
  const define = makeDefine('v05.cache-realm')
  const Private = define.service('private', { setup: () => ({ secret: true }) })
  const PrivateEntry = define.entry('private-entry', { requires: { private: Private } })
  const Owner = define.service('owner', {
    requires: { entry: PrivateEntry },
    setup: ({ entry }) => ({ open: async () => (await entry.load()).run(async ({ private: ref }) => (await ref.load()).secret) }),
  })
  const App = define.entry({ requires: { owner: Owner } })
  const runtime = createRuntime({ services: [Owner] })
  const app = await runtime.enter(App)
  assert.equal(await (await app.deps.owner.load()).open(), true)
  // The same descriptor through the public realm must not hit the private template.
  await assert.rejects(app.enter(PrivateEntry), error => error.code === 'MISSING_SERVICE')
  await assert.rejects(app.anchor(PrivateEntry).enter(), error => error.code === 'MISSING_SERVICE')
  assert.equal(await (await app.deps.owner.load()).open(), true)
  await runtime.dispose()

  const shape = makeDefine('v05.cache-shape')
  const Tenant = shape.input('tenant')
  const Cache = shape.service('cache', { requires: { tenant: Tenant }, setup: ({ tenant }) => ({ tenant: tenant.read() }) })
  const Handler = shape.service('handler', { requires: { cache: Cache }, setup: ({ cache }) => ({ cache }) })
  const Site = shape.entry('site', { requires: { cache: Cache }, parameters: { tenant: Tenant } })
  const Request = shape.entry('request', { requires: { handler: Handler } })
  const shapeRuntime = createRuntime({ services: [Cache, Handler] })
  const siteA = await shapeRuntime.enter(Site, { tenant: 'a' })
  const siteB = await shapeRuntime.enter(Site, { tenant: 'b' })
  const requestA = await siteA.enter(Request)
  const requestB = await siteB.enter(Request)
  assert.ok(shapeRuntime.inspect().planCache.hits >= 1, 'the second request used the cached template')
  const cacheA = await (await requestA.deps.handler.load()).cache.load()
  const cacheB = await (await requestB.deps.handler.load()).cache.load()
  assert.equal(cacheA.tenant, 'a')
  assert.equal(cacheB.tenant, 'b')
  assert.strictEqual(cacheA, await siteA.deps.cache.load())
  assert.strictEqual(cacheB, await siteB.deps.cache.load())
  await shapeRuntime.dispose()
})

test('R18 10,000 request/AnchoredEntry churns do not grow live Envs, plan templates or registries', async () => {
  const define = makeDefine('v05.churn')
  const Request = define.input('request')
  const Capability = define.contract()
  const Worker = define.service('worker', { requires: { request: Request }, setup: ({ request }) => ({ id: request.read() }) })
  const WorkerEntry = define.entry('worker', { requires: { worker: Worker }, parameters: { request: Request } })
  const Coordinator = define.service('coordinator', {
    requires: { workers: WorkerEntry },
    setup: ({ workers }) => ({ run: id => workers.load().then(bound => bound.run({ request: id }, async ({ worker }) => (await worker.load()).id)) }),
  })
  const P = makeDefine('v05.churn.p').service({ provides: [Capability], setup: () => ({}) })
  const Panel = define.service('panel', { requires: { all: Capability.all, request: Request }, setup: ({ all }) => ({ all }) })
  const App = define.entry('app', { requires: { coordinator: Coordinator } })
  const RequestEntry = define.entry('request', { requires: { panel: Panel }, parameters: { request: Request } })
  const runtime = createRuntime({ services: [Coordinator, Panel, P], limits: { planCacheEntries: 64 } })
  const app = await runtime.enter(App)
  const coordinator = await app.deps.coordinator.load()
  const baseline = runtime.inspect()
  let refSeen = 0
  for (let index = 0; index < 10_000; index += 1) {
    if (index % 2 === 0) {
      assert.equal(await coordinator.run(index), index)
    }
    else {
      const env = await app.enter(RequestEntry, { request: index })
      const set = await (await env.deps.panel.load()).all.load()
      refSeen += set.candidates.length
      await env.dispose()
    }
  }
  const after = runtime.inspect()
  assert.equal(refSeen, 5000)
  assert.equal(after.liveEnvCount, baseline.liveEnvCount)
  assert.equal(after.rootEnvCount, 1)
  assert.ok(after.planCache.entries <= 4, JSON.stringify(after.planCache))
  assert.ok(after.planCache.misses <= 4, JSON.stringify(after.planCache))
  assert.ok(after.planCache.hits >= 9_990)
  assert.deepEqual(after.privateServices, baseline.privateServices)
  await runtime.dispose()
})

test('R19 SCC members fork together and dispose in reverse completion order; a late-loaded dependency still closes after its dependants', async () => {
  const define = makeDefine('v05.dispose-order')
  const events = []
  let X
  let Y
  X = define.service('x', {
    requires: { y: forward(() => Y) },
    setup: (_deps, { onDispose }) => { onDispose(() => events.push('x')); return { name: 'x' } },
  })
  Y = define.service('y', {
    requires: { x: forward(() => X) },
    setup: (_deps, { onDispose }) => { onDispose(() => events.push('y')); return { name: 'y' } },
  })
  const Late = define.service('late', { setup: (_deps, { onDispose }) => { onDispose(() => events.push('late')); return {} } })
  const User = define.service('user', {
    requires: { late: Late, x: X },
    setup: ({ late }, { onDispose }) => { onDispose(() => events.push('user')); return { useLate: () => late.load() } },
  })
  const Root = define.entry('root', { requires: { user: User, x: X, y: Y } })
  const Child = define.entry('child', { requires: { user: User }, reuse: { fresh: [Y] } })
  const runtime = createRuntime({ services: [User, Late, X, Y] })
  const root = await runtime.enter(Root)
  const user = await root.deps.user.load()      // materializes user, x, y (y via x's structural edge is lazy: only x)
  await root.deps.y.load()
  await root.deps.x.load()
  await user.useLate()                          // late-loaded dependency after User is Ready
  const child = await root.enter(Child)
  const nodes = id => child.inspect().nodes.find(node => node.nodeId === id).slotId
  const rootNodes = id => root.inspect().nodes.find(node => node.nodeId === id).slotId
  assert.notEqual(nodes(`service:${Y.id}`), rootNodes(`service:${Y.id}`))
  assert.notEqual(nodes(`service:${X.id}`), rootNodes(`service:${X.id}`), 'the whole SCC forks')
  assert.notEqual(nodes(`service:${User.id}`), rootNodes(`service:${User.id}`))
  assert.equal(nodes(`service:${Late.id}`), rootNodes(`service:${Late.id}`))
  await child.dispose()
  assert.deepEqual(events, [], 'the child owned only dormant slots')
  await root.dispose()
  assert.equal(events.indexOf('user') < events.indexOf('late'), true, 'dependant before late-loaded dependency')
  assert.equal(events.indexOf('user') < events.indexOf('x'), true)
  const sccOrder = events.filter(event => event === 'x' || event === 'y')
  assert.deepEqual(sccOrder, ['x', 'y'], 'reverse completion order inside the SCC (y completed first)')
  await runtime.dispose()
})

test('K09 Ready means every locally owned eager slot is Ready; inherited eager slots are not restarted; closing refuses new work first', async () => {
  const define = makeDefine('v05.ready')
  const events = []
  const Eager = define.service('eager', {
    eager: true,
    async setup(_deps, { signal, onDispose }) {
      events.push('eager-start')
      await new Promise(resolve => setTimeout(resolve, 5))
      onDispose(() => events.push('eager-dispose'))
      signal.addEventListener('abort', () => events.push('aborted'), { once: true })
      return {}
    },
  })
  const Lazy = define.service('lazy', { setup: () => { events.push('lazy-start'); return {} } })
  const Root = define.entry('root', { requires: { eager: Eager, lazy: Lazy } })
  const Child = define.entry('child', { requires: { eager: Eager } })
  const runtime = createRuntime({ services: [Eager, Lazy] })
  const root = await runtime.enter(Root)
  assert.equal(root.state, 'ready')
  assert.deepEqual(events, ['eager-start'])
  const child = await root.enter(Child)
  assert.deepEqual(events, ['eager-start'], 'inherited eager slot is already Ready')
  const disposing = root.dispose()
  await assert.rejects(root.enter(Child), error => error.code === 'ENV_CLOSED')
  await assert.rejects(root.deps.lazy.load(), error => error.code === 'ENV_CLOSED')
  await disposing
  assert.equal(child.state, 'disposed')
  assert.deepEqual(events, ['eager-start', 'aborted', 'eager-dispose'])
  await runtime.dispose()
})

test('R17 plan templates are keyed by the lineage anchors: equal-shape gap Envs, one anchored and one not, never share a template in either order; a stale hit is re-solved', async () => {
  // Third review round (C3), the shape of R13 plus a second revision and a range
  // choice site. Lineage A: the root Binding picks F@1 (lineage-unique) so F is
  // anchored; lineage B: the root picks G, nothing anchors F. Both then flip the
  // Binding to G at the gap Site, so the two Sites have identical plans and keys
  // and differ only in the anchors they inherit. A Request below takes F by range.
  const build = () => {
    const define = makeDefine('v05.cache-anchors')
    const Cap = define.contract()
    const F1 = makeDefine('v05.cache-anchors.f', '1.0.0').service('f', { uniqueWithin: 'lineage', provides: [Cap], setup: () => ({ version: '1.0.0' }) })
    const F2 = makeDefine('v05.cache-anchors.f', '2.0.0').service('f', { uniqueWithin: 'lineage', provides: [Cap], setup: () => ({ version: '2.0.0' }) })
    const G = define.service('g', { provides: [Cap], setup: () => ({ version: 'g' }) })
    const Choice = define.binding('choice', Cap)
    const Pool = define.service('pool', { setup: () => ({}) })
    const Tenant = define.input('tenant')
    const Leaf = define.service('leaf', { requires: { f: F1.range('*') }, setup: async ({ f }) => ({ f: await f.load() }) })
    const App = define.entry('app', { requires: { impl: Choice }, parameters: { choice: Choice } })
    const Site = define.entry('site', { requires: { pool: Pool }, parameters: { tenant: Tenant, choice: Choice } })
    const Request = define.entry('request', { requires: { leaf: Leaf } })
    const runtime = createRuntime({ services: [F1, F2, G, Pool, Leaf] })
    const lineage = async anchored => {
      const app = await runtime.enter(App, { choice: anchored ? F1 : G })
      const site = await app.enter(Site, { tenant: anchored ? 'a' : 'b', choice: G })
      return { app, site, pinnedSlot: app.inspect().nodes.find(node => node.kind === 'service' && node.label.includes('/f@'))?.slotId }
    }
    const observe = async ({ site, app }) => {
      const request = await site.enter(Request)
      const node = request.inspect().nodes.find(node => node.kind === 'service' && node.label.includes('/f@'))
      const result = { version: (await request.deps.leaf.load()).f.version, owner: node.ownerEnvId === app.id ? 'app' : node.ownerEnvId === request.id ? 'request' : node.ownerEnvId, slot: node.slotId }
      await request.dispose()
      return result
    }
    return { runtime, lineage, observe }
  }
  const expected = (lineage, anchored) => (anchored
    ? { version: '1.0.0', owner: 'app', slot: lineage.pinnedSlot }
    : { version: '2.0.0', owner: 'request' })
  const shape = ({ version, owner, slot }, anchored) => (anchored ? { version, owner, slot } : { version, owner })

  for (const anchored of [true, false]) {
    const world = build()
    const single = await world.lineage(anchored)
    assert.deepEqual(shape(await world.observe(single), anchored), expected(single, anchored), 'cold plan')
    await world.runtime.dispose()
  }
  for (const order of [[true, false], [false, true]]) {
    const world = build()
    const lineages = new Map()
    for (const anchored of order) lineages.set(anchored, await world.lineage(anchored))
    assert.equal(lineages.get(true).site.inspect().nodes.map(node => node.label).join(), lineages.get(false).site.inspect().nodes.map(node => node.label).join(), 'the gap Sites have the same shape')
    const before = world.runtime.inspect().planCache
    for (const pass of [1, 2]) {
      for (const anchored of order) {
        assert.deepEqual(shape(await world.observe(lineages.get(anchored)), anchored), expected(lineages.get(anchored), anchored), `${order.map(a => (a ? 'anchored' : 'unanchored')).join(' then ')}, pass ${pass}: the ${anchored ? 'anchored' : 'unanchored'} lineage plans as if cold`)
      }
    }
    const after = world.runtime.inspect().planCache
    assert.equal(after.misses - before.misses, 2, 'one template per anchor set')
    assert.equal(after.hits - before.hits, 2, 'the second pass hits both')
    await world.runtime.dispose()
  }

  // Defence in depth behind the key: a template that reaches slot assignment
  // under anchors it was not solved for is evicted and solved afresh instead of
  // surfacing a LINEAGE_UNIQUENESS_CONFLICT a cold plan would not have had.
  // (The wrong-revision direction is only caught by the key, hence the key.)
  const world = build()
  const anchoredLineage = await world.lineage(true)
  const unanchoredLineage = await world.lineage(false)
  const originalGet = PlanTemplateCache.prototype.get
  const originalSet = PlanTemplateCache.prototype.set
  const requestTemplates = new Map()
  PlanTemplateCache.prototype.set = function recordingSet(key, value) {
    if (key.includes('/entry/request/')) requestTemplates.set(key, value)
    return originalSet.call(this, key, value)
  }
  let resolved = 0
  try {
    await world.observe(unanchoredLineage)
    await world.observe(anchoredLineage)
    const keys = [...requestTemplates.keys()]
    assert.equal(keys.length, 2)
    const [unanchoredKey, anchoredKey] = keys
    PlanTemplateCache.prototype.get = function staleGet(key) {
      return key === anchoredKey ? requestTemplates.get(unanchoredKey) : originalGet.call(this, key)
    }
    PlanTemplateCache.prototype.set = function countingSet(key, value) {
      if (key === anchoredKey) resolved += 1
      return originalSet.call(this, key, value)
    }
    assert.deepEqual(shape(await world.observe(anchoredLineage), true), expected(anchoredLineage, true), 'a stale template under the anchored lineage is not trusted')
    assert.equal(resolved, 1, 'the stale hit was evicted and solved afresh')
  }
  finally {
    PlanTemplateCache.prototype.get = originalGet
    PlanTemplateCache.prototype.set = originalSet
  }
  await world.runtime.dispose()
})
