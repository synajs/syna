// H10 / H11 / P05 — SiteEnvs are a bounded, leased working set with version rotation.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AuthOptions, AuthenticatorContract, SessionAuth, SiteAuth, defaultRecipes, define, siteConfigInputFromFixture } from '../dist/index.js'
import { createFilesystemApp, fixture } from './helpers/app-harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function addTenants(store, count) {
  const ids = []
  for (let index = 0; index < count; index += 1) {
    const tenantId = `t${String(index).padStart(3, '0')}`
    ids.push(tenantId)
    const repository = store.forTenant(tenantId)
    await repository.saveSiteConfig({
      tenantId,
      title: `Tenant ${index}`,
      domains: [`${tenantId}.test`],
      defaultLocale: 'en',
      theme: { name: 'paper', accent: '#000000' },
      navigation: [],
      recipes: defaultRecipes(),
      auth: { implementation: SiteAuth.to(SessionAuth), options: { sessions: {} } },
    })
    await repository.savePost({
      id: `${tenantId}-p1`, slug: 'first', locale: 'en', title: `First of ${tenantId}`, body: `Hello from ${tenantId}`,
      status: 'published', categories: [], tags: [], createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    })
  }
  return ids
}

const waitUntil = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
    await sleep(2)
  }
}

test('H10 leases are single-flight per key, idempotent on release, evicted only when idle, and bounded by capacity with backpressure', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 3, idleTtlMs: 60_000, maxPendingAcquires: 2, acquireTimeoutMs: 300 } } })
  try {
    const store = await harness.app.app.deps.store.load()
    const tenants = await addTenants(store, 6)
    const manager = await harness.app.app.deps.sites.load()

    const leases = await Promise.all(Array.from({ length: 5 }, () => manager.acquire(tenants[0], 'request')))
    assert.equal(manager.stats().creations, 1, 'concurrent first acquires share one creation')
    assert.ok(leases.every(lease => lease.env === leases[0].env))
    assert.equal(manager.stats().leases, 5)
    leases[0].release()
    leases[0].release()
    leases[0].release()
    assert.equal(manager.stats().leases, 4, 'release is idempotent and never negative')
    for (const lease of leases.slice(1)) lease.release()
    assert.equal(manager.stats().leases, 0)

    const held = [await manager.acquire(tenants[1], 'request'), await manager.acquire(tenants[2], 'request')]
    assert.equal(manager.stats().records, 3)
    // Capacity reached: the idle tenant 0 env is evicted to make room for tenant 3.
    const fourth = await manager.acquire(tenants[3], 'request')
    assert.equal(manager.stats().evictions, 1)
    assert.deepEqual(manager.records().map(record => record.tenantId).sort(), [tenants[1], tenants[2], tenants[3]])

    // All three are leased: further tenants queue (bounded) and time out instead of evicting a live tenant.
    const started = Date.now()
    // The wait queue is FIFO by arrival; an acquirer arrives after its configuration read, so B is
    // issued only once A is queued (two concurrent reads could otherwise complete in either order).
    const waitingA = manager.acquire(tenants[4], 'request').catch(error => error)
    await waitUntil(() => manager.stats().pendingAcquires === 1)
    const waitingB = manager.acquire(tenants[5], 'request').catch(error => error)
    await waitUntil(() => manager.stats().pendingAcquires === 2)
    await assert.rejects(manager.acquire(tenants[0], 'request'), error => error.code === 'SITE_CAPACITY')
    fourth.release()
    const resultA = await waitingA
    assert.equal(resultA.tenantId, tenants[4], `a released env made room; the waiter proceeded${resultA instanceof Error ? ` — got ${resultA.code ?? resultA.name}: ${resultA.message}` : ''}`)
    const resultB = await waitingB
    assert.equal(resultB.code, 'SITE_CAPACITY', 'the second waiter timed out')
    assert.ok(Date.now() - started >= 250)
    assert.equal(manager.stats().records, 3)
    assert.deepEqual(manager.records().filter(record => record.leases > 0).map(record => record.tenantId).sort(), [tenants[1], tenants[2], tenants[4]])
    for (const lease of [...held, resultA]) lease.release()
    assert.ok(manager.stats().rejectedForCapacity >= 2)
  }
  finally {
    await harness.close()
  }
})

test('H10 configuration update under traffic: new requests enter the new revision, in-flight requests finish on the old one, old envs are released and never accumulate', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 8, idleTtlMs: 60_000 } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const store = await harness.app.app.deps.store.load()
    const repository = store.forTenant('alpha')
    const inFlight = await manager.acquire('alpha', 'request')
    assert.equal(inFlight.context.site.title, 'Alpha Notes')

    for (let round = 1; round <= 5; round += 1) {
      const current = await repository.getSiteConfig()
      await repository.saveSiteConfig({ ...current, title: `Alpha Notes v${round}` })
      const fresh = await manager.acquire('alpha', 'request')
      assert.equal(fresh.context.site.title, `Alpha Notes v${round}`, 'new requests see the new revision')
      assert.equal(fresh.configRevision, current.configRevision + 1)
      fresh.release()
    }
    assert.equal(inFlight.context.site.title, 'Alpha Notes', 'the in-flight request keeps its snapshot')
    const records = manager.records().filter(record => record.tenantId === 'alpha')
    assert.ok(records.length <= 2, `old revisions must not accumulate: ${JSON.stringify(records)}`)
    assert.ok(records.some(record => record.state === 'draining' && record.leases === 1))
    inFlight.release()
    await sleep(5)
    const after = manager.records().filter(record => record.tenantId === 'alpha')
    assert.equal(after.length, 1)
    assert.equal(after[0].state, 'active')
    assert.equal(after[0].configRevision, inFlight.configRevision + 5)
    assert.ok(manager.stats().evictions === 0, 'version rotation is not eviction')
  }
  finally {
    await harness.close()
  }
})

test('H10 a cold creation failure leaves no poisoned single-flight promise and backs off; shutdown refuses new acquires and reports unreleased leases', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 4, creationBackoffMs: 50, creationBackoffMaxMs: 200, shutdownTimeoutMs: 100 } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const store = await harness.app.app.deps.store.load()
    const repository = store.forTenant('broken')
    await repository.saveSiteConfig({
      tenantId: 'broken', title: 'Broken', domains: ['broken.test'], defaultLocale: 'en', theme: { name: 'paper', accent: '#000' }, navigation: [],
      recipes: defaultRecipes(),
      auth: { implementation: { kind: 'implementation-ref', contractId: SiteAuth.contract.id, familyId: 'hyla.mini/signed-token-auth', range: '*' }, options: {} },
    })
    await assert.rejects(manager.acquire('broken', 'request'), /secret/)
    assert.equal(manager.stats().creationFailures, 1)
    assert.equal(manager.records().filter(record => record.tenantId === 'broken').length, 0, 'no poisoned record remains')
    await assert.rejects(manager.acquire('broken', 'request'), /backing off/)
    assert.equal(manager.stats().creationFailures, 1, 'the retry storm is throttled')
    await sleep(60)
    const current = await repository.getSiteConfig()
    await repository.saveSiteConfig({ ...current, auth: { ...current.auth, options: { secret: 'now-fine' } } })
    const recovered = await manager.acquire('broken', 'request')
    assert.equal(recovered.context.site.title, 'Broken')
    assert.equal(manager.stats().creationFailures, 1)

    await assert.rejects(manager.acquire('unknown-tenant', 'request'), error => error.code === 'UNKNOWN_TENANT')

    const shutdown = manager.shutdown()
    await assert.rejects(manager.acquire('alpha', 'request'), error => error.code === 'SITE_MANAGER_CLOSED')
    const report = await shutdown
    assert.equal(report.unreleasedLeases.length, 1, 'the still-held lease is reported, not silently killed')
    assert.equal(manager.stats().records, 0)
    recovered.release()
  }
  finally {
    await harness.close()
  }
})

test('H11 / P05 working set stays bounded under hot-spot, rotating and long-tail access with many tenants; heap trend is sampled after GC', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 6, idleTtlMs: 40, sweepIntervalMs: 20 } } })
  try {
    const store = await harness.app.app.deps.store.load()
    const tenants = await addTenants(store, 120)
    const manager = await harness.app.app.deps.sites.load()
    assert.equal(manager.stats().records, 0, 'unvisited tenants have no Env')

    const heapSamples = []
    const rootEnvs = harness.app.runtime.inspect().liveEnvCount // infrastructure + app
    assert.equal(rootEnvs, 2)
    let maxSiteEnvsAlive = 0
    const sampleHeap = label => {
      if (typeof globalThis.gc === 'function') globalThis.gc()
      const stats = manager.stats()
      const liveEnvs = harness.app.runtime.inspect().liveEnvCount
      heapSamples.push({ label, heapUsed: process.memoryUsage().heapUsed, records: stats.records, disposing: stats.disposing, liveEnvs })
      assert.ok(liveEnvs - rootEnvs <= 6, `${label}: ${liveEnvs - rootEnvs} site Envs alive (closing ones included) exceed the capacity of 6`)
    }
    sampleHeap('start')
    const maxRecords = { hot: 0, rotate: 0, tail: 0, mixed: 0 }
    const touch = async (tenantId, phase) => {
      const lease = await manager.acquire(tenantId, 'request')
      // Capacity is a bound on real Envs: a SiteEnv still closing counts, so the
      // Runtime never holds more site worlds than the capacity, at any lease.
      maxSiteEnvsAlive = Math.max(maxSiteEnvsAlive, harness.app.runtime.inspect().liveEnvCount - rootEnvs)
      await lease.context.renderIndex({ kind: 'anonymous' })
      maxRecords[phase] = Math.max(maxRecords[phase], manager.stats().records)
      lease.release()
    }
    // Hot spot: 3 tenants, 300 requests.
    for (let index = 0; index < 300; index += 1) await touch(tenants[index % 3], 'hot')
    sampleHeap('after-hot')
    // Rotation across 120 tenants twice.
    for (let round = 0; round < 2; round += 1) for (const tenantId of tenants) await touch(tenantId, 'rotate')
    sampleHeap('after-rotation')
    // Long tail with concurrency and a config change under traffic.
    await Promise.all(tenants.slice(0, 40).map(async (tenantId, index) => {
      await touch(tenantId, 'tail')
      if (index === 5) {
        const repository = store.forTenant(tenants[0])
        const current = await repository.getSiteConfig()
        await repository.saveSiteConfig({ ...current, title: 'rotated under traffic' })
      }
      await touch(tenants[0], 'tail')
    }))
    sampleHeap('after-tail')
    for (let index = 0; index < 200; index += 1) await touch(tenants[(index * 7) % 120], 'mixed')
    sampleHeap('after-mixed')
    await sleep(80)
    await manager.sweep()
    sampleHeap('after-idle-sweep')

    const stats = manager.stats()
    for (const phase of Object.keys(maxRecords)) assert.ok(maxRecords[phase] <= 6, `${phase} exceeded capacity: ${maxRecords[phase]}`)
    assert.ok(maxSiteEnvsAlive <= 6, `site Envs alive exceeded the capacity at some lease: ${maxSiteEnvsAlive}`)
    assert.ok(maxSiteEnvsAlive >= 6, `the working set was exercised up to its capacity: ${maxSiteEnvsAlive}`)
    assert.equal(stats.records, 0, 'idle envs are evicted by TTL')
    assert.equal(harness.app.runtime.inspect().liveEnvCount, 2, 'only infrastructure and app envs remain')
    assert.ok(stats.evictions > 100)
    assert.equal(stats.leases, 0)
    assert.equal(stats.pendingAcquires, 0)
    const first = heapSamples[1].heapUsed
    const last = heapSamples.at(-1).heapUsed
    assert.ok(last < first * 1.5 + 20_000_000, `heap did not stay bounded: ${JSON.stringify(heapSamples)}`)
    const report = {
      generatedAt: new Date().toISOString(),
      tenants: tenants.length,
      capacity: 6,
      maxRecordsPerPhase: maxRecords,
      maxSiteEnvsAlive,
      finalStats: stats,
      planCache: harness.app.runtime.inspect().planCache,
      heapSamples,
      gcExposed: typeof globalThis.gc === 'function',
    }
    // The orchestrator points this at validation/v0.5-<mode>/working-set.json; a
    // plain test run writes under work/ so it never dirties tracked files.
    const outFile = path.resolve(process.env.SYNA_WORKING_SET_OUT ?? path.join('work', 'v05', 'working-set.json'))
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`)
  }
  finally {
    await harness.close()
  }
})

test('H11 shutdown with concurrent acquire/release: no acquire after close, every lease accounted for', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 4, shutdownTimeoutMs: 200 } } })
  const manager = await harness.app.app.deps.sites.load()
  const outcomes = []
  const workers = Array.from({ length: 12 }, async (_, index) => {
    for (let round = 0; round < 20; round += 1) {
      try {
        const lease = await manager.acquire(index % 2 === 0 ? 'alpha' : 'beta', 'request')
        await sleep(1)
        lease.release()
        outcomes.push('ok')
      }
      catch (error) {
        outcomes.push(error.code ?? error.message)
        return
      }
    }
  })
  await sleep(15)
  const report = await manager.shutdown()
  await Promise.all(workers)
  assert.equal(report.unreleasedLeases.length, 0)
  assert.ok(outcomes.includes('ok'))
  assert.ok(outcomes.every(outcome => outcome === 'ok' || outcome === 'SITE_MANAGER_CLOSED'), JSON.stringify(outcomes))
  assert.equal(manager.stats().records, 0)
  await harness.close()
  void fixture
})

// Third review round (docs/AUDIT.md, S2 / S5 / S6): reservation hand-off,
// monotonic rotation under stale reads and invalidation, lease purposes.

/**
 * Gates the manager's configuration reads per tenant AFTER the real read has
 * completed: once a gate opens, the acquirer continues on microtasks alone (no
 * I/O), so the interleaving of several acquirers is exact.
 */
function gateConfigReads(store) {
  const gates = new Map()
  const entry = tenantId => {
    let gate = gates.get(tenantId)
    if (!gate) {
      let open
      const opened = new Promise(resolve => { open = resolve })
      gate = { opened, open, waiting: 0, isOpen: false }
      gates.set(tenantId, gate)
    }
    return gate
  }
  const realForTenant = store.forTenant.bind(store)
  store.forTenant = tenantId => {
    const repository = realForTenant(tenantId)
    return {
      ...repository,
      async getSiteConfig() {
        const config = await repository.getSiteConfig()
        const gate = entry(tenantId)
        if (!gate.isOpen) {
          gate.waiting += 1
          await gate.opened
        }
        return config
      },
    }
  }
  return {
    waiting: tenantId => entry(tenantId).waiting,
    open(tenantId) {
      const gate = entry(tenantId)
      gate.isOpen = true
      gate.open()
    },
    restore() { store.forTenant = realForTenant },
  }
}

test('S2 a reservation whose record was created meanwhile is handed to the next waiter: a third acquirer never starves behind it', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 2, idleTtlMs: 60_000, acquireTimeoutMs: 3_000 } } })
  try {
    const store = await harness.app.app.deps.store.load()
    const [x, y] = await addTenants(store, 2)
    const manager = await harness.app.app.deps.sites.load()
    const gates = gateConfigReads(store)
    // A and B both acquire X (one shared configuration read, no record yet); C reads Y's.
    const a = manager.acquire(x, 'request')
    const b = manager.acquire(x, 'request')
    const c = manager.acquire(y, 'request')
    await waitUntil(() => gates.waiting(x) === 1 && gates.waiting(y) === 1)
    // Same tick: A and B reserve the two units (B's becomes redundant once A
    // inserts the record); C finds the working set full and queues.
    gates.open(x)
    gates.open(y)
    const started = Date.now()
    const leases = await Promise.all([a, b, c])
    assert.ok(Date.now() - started < 1_000, 'C was served by the redundant reservation, not by the acquire timeout')
    assert.equal(leases[0].key, leases[1].key, 'A and B share one SiteEnv')
    assert.equal(leases[2].tenantId, y)
    assert.equal(manager.stats().creations, 2)
    assert.equal(manager.stats().rejectedForCapacity, 0)
    assert.equal(manager.stats().pendingAcquires, 0)
    for (const lease of leases) lease.release()
    gates.restore()
  }
  finally {
    await harness.close()
  }
})

test('S5 a stale configuration read joins the newer world instead of draining it', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 4, idleTtlMs: 60_000 } } })
  try {
    const store = await harness.app.app.deps.store.load()
    const manager = await harness.app.app.deps.sites.load()
    const repository = store.forTenant('alpha')
    const first = await manager.acquire('alpha', 'request')
    first.release()
    const saved = await repository.saveSiteConfig({ ...(await repository.getSiteConfig()), title: 'rev+1' })
    const current = await manager.acquire('alpha', 'request')
    assert.equal(current.configRevision, saved.configRevision)
    assert.equal(manager.stats().creations, 2)
    await waitUntil(() => manager.records().length === 1, 2_000)

    // The next read returns the previous revision once (a replica behind a save, a
    // cached read that raced the write): rotation is monotonic, so the acquirer
    // joins the newer SiteEnv; the newer world is never drained for an older read.
    const realForTenant = store.forTenant.bind(store)
    let stale = 1
    store.forTenant = tenantId => {
      const real = realForTenant(tenantId)
      return {
        ...real,
        async getSiteConfig() {
          const config = await real.getSiteConfig()
          if (tenantId === 'alpha' && stale > 0) { stale -= 1; return { ...config, configRevision: config.configRevision - 1, title: 'stale' } }
          return config
        },
      }
    }
    try {
      const joined = await manager.acquire('alpha', 'request')
      assert.equal(joined.key, current.key, 'the stale reader joined the current world')
      assert.equal(joined.configRevision, saved.configRevision)
      assert.equal(stale, 0, 'the stale read was consumed')
      assert.equal(manager.stats().creations, 2, 'no SiteEnv was created for the stale revision')
      assert.deepEqual(manager.records().map(record => record.state), ['active'], 'the current world was not drained')
      joined.release()
    }
    finally {
      store.forTenant = realForTenant
    }
    current.release()
  }
  finally {
    await harness.close()
  }
})

test('S5 an invalidate() during the capacity wait is honoured: the SiteEnv created afterwards belongs to the new generation', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 1, idleTtlMs: 60_000, acquireTimeoutMs: 2_000 } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const alpha = await manager.acquire('alpha', 'request')
    const waiting = manager.acquire('beta', 'request') // read the configuration, then queued: alpha holds the only unit
    await waitUntil(() => manager.stats().pendingAcquires === 1)
    manager.invalidate('beta') // generation 0 → 1 while the acquirer waits
    alpha.release() // the idle alpha env is closed for the waiter
    const beta = await waiting
    assert.ok(beta.key.endsWith('|g1'), `the record created after the wait carries the new generation: ${beta.key}`)
    assert.equal(manager.stats().creations, 2)
    // A follow-up acquire joins that record instead of rotating it away as stale.
    const again = await manager.acquire('beta', 'request')
    assert.equal(again.key, beta.key)
    assert.equal(manager.stats().creations, 2)
    assert.deepEqual(manager.records().map(record => record.state), ['active'])
    again.release()
    beta.release()
  }
  finally {
    await harness.close()
  }
})

test('S6 lease purposes: builds never take the last unit, requests are served while builds wait, and a queued request goes before an earlier build', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 2, idleTtlMs: 5, sweepIntervalMs: 60_000, acquireTimeoutMs: 3_000 } } })
  try {
    const store = await harness.app.app.deps.store.load()
    const [gamma] = await addTenants(store, 1)
    const manager = await harness.app.app.deps.sites.load()
    assert.equal(manager.settings.reservedForRequests, 1, 'default: one unit of a capacity ≥ 2 is kept for requests')
    assert.equal(manager.stats().reservedForRequests, 1)

    const build1 = await manager.acquire('alpha', 'build') // the first unit is free for anybody
    const build2 = manager.acquire('beta', 'build') // the last unit is not for a build
    await waitUntil(() => manager.stats().waitingByPurpose.build === 1)
    const request = await manager.acquire('beta', 'request') // a request takes it immediately
    assert.equal(manager.stats().records, 2)
    assert.equal(manager.stats().waitingByPurpose.build, 1, 'the build is still waiting')
    // A build joining an existing SiteEnv needs no unit at all.
    const buildOnBeta = await manager.acquire('beta', 'build')
    assert.equal(buildOnBeta.key, request.key)
    buildOnBeta.release()

    const request2 = manager.acquire(gamma, 'request') // queued behind a full working set
    await waitUntil(() => manager.stats().waitingByPurpose.request === 1)
    request.release() // beta is idle: it is closed for the waiting request, not for the earlier build
    const served = await request2
    assert.equal(served.tenantId, gamma)
    assert.equal(manager.stats().waitingByPurpose.build, 1, 'the earlier build still waits: requests go first')
    assert.deepEqual(manager.stats().waitingByPurpose, { request: 0, build: 1, background: 0 })

    served.release()
    build1.release()
    await sleep(10)
    await manager.sweep() // both idle envs are past their TTL: the build finally gets a unit
    const build2Lease = await build2
    assert.equal(build2Lease.tenantId, 'beta')
    assert.deepEqual(manager.stats().waitingByPurpose, { request: 0, build: 0, background: 0 })
    assert.equal(manager.stats().rejectedForCapacity, 0)
    build2Lease.release()
  }
  finally {
    await harness.close()
  }
})

test('S6 reservedForRequests is validated at startup and 0 for a capacity of 1', async () => {
  await assert.rejects(
    createFilesystemApp({ app: { siteManager: { capacity: 2, reservedForRequests: 2 } } }),
    error => error instanceof TypeError && /reservedForRequests/.test(error.message),
  )
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 1 } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    assert.equal(manager.settings.reservedForRequests, 0)
    const build = await manager.acquire('alpha', 'build') // with nothing reserved a build may take the only unit
    build.release()
  }
  finally {
    await harness.close()
  }
})

// Fixtures for the third re-audit's site-manager findings (F-AP3-03/04/05/07).
/** An authenticator whose cleanup takes a while (a connection drain): its SiteEnv closes slowly. */
const SlowCloseAuth = define.service('test-slow-close-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  setup({ options }, { onDispose }) {
    onDispose(() => sleep(Number(options.read().closeMs ?? 600)))
    return { scheme: 'slow-close', async authenticate() { return { kind: 'anonymous' } } }
  },
})
/** An authenticator whose setup takes a while, widening the creation window deterministically. */
const SlowSetupAuth = define.service('test-slow-setup-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  async setup({ options }) {
    await sleep(Number(options.read().delayMs ?? 300))
    return { scheme: 'slow-setup', async authenticate() { return { kind: 'anonymous' } } }
  },
})
const sessionAuth = { implementation: SiteAuth.to(SessionAuth), options: { sessions: {} } }
const addTenant = (store, tenantId, auth = sessionAuth) => store.forTenant(tenantId).saveSiteConfig({
  ...siteConfigInputFromFixture(tenantId, fixture.tenants.alpha, { recipes: defaultRecipes(), auth }),
  domains: [`${tenantId}.test`],
})

test('F-AP3-07 a closing SiteEnv frees its key at once: an acquirer of the same tenant gets a new SiteEnv without spinning on configuration reads or waiting for the close', async () => {
  const harness = await createFilesystemApp({ app: { extraServices: [SlowCloseAuth], siteManager: { capacity: 4, idleTtlMs: 0, sweepIntervalMs: 60_000, acquireTimeoutMs: 300 } } })
  try {
    const store = await harness.app.app.deps.store.load()
    await addTenant(store, 'slow', { implementation: SiteAuth.to(SlowCloseAuth), options: { closeMs: 600 } })
    const manager = await harness.app.app.deps.sites.load()
    let reads = 0
    const realForTenant = store.forTenant.bind(store)
    store.forTenant = tenantId => {
      const real = realForTenant(tenantId)
      return { ...real, async getSiteConfig() { if (tenantId === 'slow') reads += 1; return real.getSiteConfig() } }
    }
    try {
      const first = await manager.acquire('slow', 'request')
      const firstEnv = first.env
      first.release()
      const sweeping = manager.sweep() // idleTtlMs 0: the idle SiteEnv starts its 600 ms close now
      await sleep(5)
      assert.equal(manager.records().find(record => record.tenantId === 'slow')?.state, 'disposing', 'the closing SiteEnv stays visible (it still holds a unit)')
      reads = 0
      const started = Date.now()
      const second = await manager.acquire('slow', 'request')
      const elapsed = Date.now() - started
      assert.notEqual(second.env, firstEnv, 'a new SiteEnv; the closing one is neither joined nor waited for')
      assert.ok(elapsed < 250, `served at once with three units free, not after the close (${elapsed} ms)`)
      assert.ok(reads <= 5, `no read storm while the close was in flight: ${reads} configuration reads`)
      assert.equal(manager.records().filter(record => record.tenantId === 'slow').length, 2, 'closing and new records coexist; the closing one counts toward capacity until its close ends')
      second.release()
      await sweeping
      await waitUntil(() => manager.records().filter(record => record.tenantId === 'slow').length === 1)
      assert.equal(manager.stats().evictions, 1)
    }
    finally {
      store.forTenant = realForTenant
    }
  }
  finally {
    await harness.close()
  }
})

test('F-AP3-03 a build acquirer closes idle SiteEnvs only when that makes it servable: none for a unit it can never take, as many as it needs otherwise', async () => {
  // capacity 2, reserve 1: while a request holds one unit a build can never be served; beta's idle SiteEnv must survive the refused attempts.
  const narrow = await createFilesystemApp({ app: { siteManager: { capacity: 2, idleTtlMs: 60_000, sweepIntervalMs: 60_000, acquireTimeoutMs: 150 } } })
  try {
    const store = await narrow.app.app.deps.store.load()
    await addTenant(store, 'gamma')
    const manager = await narrow.app.app.deps.sites.load()
    const held = await manager.acquire('alpha', 'request')
    const beta = await manager.acquire('beta', 'request')
    beta.release()
    const before = manager.stats()
    assert.deepEqual([before.records, before.idle], [2, 1])
    for (let round = 1; round <= 3; round += 1) {
      await assert.rejects(manager.acquire('gamma', 'build'), error => error.code === 'SITE_CAPACITY')
      const again = await manager.acquire('beta', 'request') // live traffic between the attempts
      again.release()
    }
    const after = manager.stats()
    assert.equal(after.evictions, before.evictions, 'no idle SiteEnv was closed for a build that could not be served')
    assert.equal(after.creations, before.creations, 'beta was never re-created')
    held.release()
  }
  finally {
    await narrow.close()
  }
  // capacity 3, reserve 1, three idle SiteEnvs: a build needs two free units and gets them by closing two.
  const wide = await createFilesystemApp({ app: { siteManager: { capacity: 3, idleTtlMs: 60_000, sweepIntervalMs: 60_000, acquireTimeoutMs: 500 } } })
  try {
    const store = await wide.app.app.deps.store.load()
    await addTenant(store, 'gamma')
    await addTenant(store, 'delta')
    const manager = await wide.app.app.deps.sites.load()
    for (const tenantId of ['alpha', 'beta', 'gamma']) (await manager.acquire(tenantId, 'request')).release()
    assert.equal(manager.stats().records, 3)
    const build = await manager.acquire('delta', 'build')
    assert.equal(manager.stats().evictions, 2, 'one unit for the build, one to keep the request reserve')
    await waitUntil(() => manager.stats().records === 2)
    build.release()
  }
  finally {
    await wide.close()
  }
})

test('F-AP3-04 a creation cut short by shutdown() fails with SITE_MANAGER_CLOSED, counts as no creation failure and leaks no SiteEnv', async () => {
  const harness = await createFilesystemApp({ app: { extraServices: [SlowSetupAuth], siteManager: { capacity: 4, shutdownTimeoutMs: 20, sweepIntervalMs: 60_000 } } })
  try {
    const store = await harness.app.app.deps.store.load()
    await addTenant(store, 'slow', { implementation: SiteAuth.to(SlowSetupAuth), options: { delayMs: 300 } })
    const manager = await harness.app.app.deps.sites.load()
    const runtime = harness.app.runtime
    const liveBefore = runtime.inspect().liveEnvCount
    let acquireEndedAt = 0
    const acquiring = manager.acquire('slow', 'request').then(
      lease => { lease.release(); acquireEndedAt = Date.now(); return 'lease' },
      error => { acquireEndedAt = Date.now(); return error },
    )
    await sleep(60) // inside enter(): the authenticator's setup is running
    assert.equal(manager.records().find(record => record.tenantId === 'slow')?.state, 'creating')
    const started = Date.now()
    const report = await manager.shutdown()
    assert.ok(Date.now() - started < 1_000, 'shutdown() is bounded by its timeout plus the SiteEnv close, not by the creation')
    const outcome = await acquiring
    assert.equal(outcome.code, 'SITE_MANAGER_CLOSED', `the acquirer is refused as closed, not with the Runtime's state error: ${outcome.message ?? outcome}`)
    // 1.0.0-rc.4 / A4: the shutdown ends the caller's wait where it stands instead of
    // letting it run to the end of the creation, so the refusal carries no cause —
    // at that moment the creation has not failed, and it may yet succeed. The wait
    // ends well before the authenticator's 300 ms setup would have returned.
    assert.ok(acquireEndedAt - started < 200, `the acquirer stops waiting at the shutdown, not at the end of the creation (${acquireEndedAt - started} ms)`)
    assert.equal(manager.stats().creationFailures, 0, 'a shutdown is not a creation failure and starts no backoff')
    assert.equal(report.unreleasedLeases.length, 1, 'the creator\'s hold on the creating record is reported, as documented (R-2/R-3)')
    await waitUntil(() => runtime.inspect().liveEnvCount === liveBefore)
    assert.equal(runtime.inspect().liveEnvCount, liveBefore, 'the SiteEnv entered meanwhile is closed by the manager')
    const closeReport = await harness.app.close()
    assert.deepEqual(closeReport.errors, [])
  }
  finally {
    await harness.close()
  }
})

test('F-AP3-05 one deadline bounds the whole acquire: a waiter granted late whose generation moved is refused within acquireTimeoutMs', async () => {
  const TIMEOUT = 400
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 1, idleTtlMs: 60_000, sweepIntervalMs: 60_000, acquireTimeoutMs: TIMEOUT } } })
  try {
    const store = await harness.app.app.deps.store.load()
    await addTenant(store, 'gamma')
    const manager = await harness.app.app.deps.sites.load()
    const holder = await manager.acquire('alpha', 'request') // the only unit
    const started = Date.now()
    const waiting = manager.acquire('beta', 'request').then(lease => { lease.release(); return 'lease' }, error => error.code)
    await waitUntil(() => manager.stats().pendingAcquires === 1)
    const other = manager.acquire('gamma', 'request') // queued behind beta; keeps its lease until beta's acquire has ended
    await waitUntil(() => manager.stats().pendingAcquires === 2)
    await sleep(TIMEOUT * 0.8)
    manager.invalidate('beta') // beta's generation moves while its acquirer waits
    holder.release() // beta is granted, sees the moved generation, hands the unit on (gamma takes it) and queues again
    const outcome = await waiting
    const elapsed = Date.now() - started
    assert.equal(outcome, 'SITE_CAPACITY')
    assert.ok(elapsed <= TIMEOUT * 1.25, `the whole acquire took ${elapsed} ms for an acquireTimeoutMs of ${TIMEOUT}`)
    ;(await other).release()
  }
  finally {
    await harness.close()
  }
})
