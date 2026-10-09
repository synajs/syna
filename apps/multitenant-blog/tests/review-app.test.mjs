// Regressions for the second review round, application side (work/v05/ISSUES.md
// I-54 … I-57): a site whose creation fails after its Env was entered is
// closed, not leaked; a closing Env keeps its unit of capacity until the close
// settles and the queue stays fair; the page cache reads the content version
// before the content; a SiteEnv whose close rejects is reported, never an
// unhandled rejection; close() returns what is outstanding instead of
// rejecting.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { override } from 'synajs'
import { AuthOptions, AuthenticatorContract, SessionAuth, SiteAuth, defaultRecipes, define } from '../dist/index.js'
import { createFilesystemApp } from './helpers/app-harness.mjs'

const run = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (predicate, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await sleep(2)
  }
  return true
}
const siteConfig = (tenantId, auth) => ({
  tenantId,
  title: `Tenant ${tenantId}`,
  domains: [`${tenantId}.test`],
  defaultLocale: 'en',
  theme: { name: 'paper', accent: '#000000' },
  navigation: [],
  recipes: defaultRecipes(),
  auth,
})
const anonymous = Object.freeze({ kind: 'anonymous' })

/** An authenticator whose cleanup takes a while: widens the window in which a SiteEnv is closing. */
const SlowCloseAuth = define.service('review-slow-close-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  setup({ options }, { onDispose }) {
    onDispose(() => sleep(Number(options.read().closeMs ?? 100)))
    return { scheme: 'slow-close', async authenticate() { return anonymous } }
  },
})

/** An authenticator whose cleanup throws: a SiteEnv whose close rejects. */
const ThrowingCloseAuth = define.service('review-throwing-close-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  setup(_deps, { onDispose }) {
    onDispose(() => { throw new Error('cleanup exploded') })
    return { scheme: 'throwing-close', async authenticate() { return anonymous } }
  },
})

/** An authenticator whose setup ignores the stop signal: abandoned when the SiteEnv closes. */
const StubbornAuth = define.service('review-stubborn-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  async setup({ options }) {
    await sleep(Number(options.read().delayMs ?? 150))
    return { scheme: 'stubborn', async authenticate() { return anonymous } }
  },
})

test('R-2 a site whose creation fails after its Env was entered is closed, not leaked', async () => {
  const Broken = define.service('review-broken-auth', { setup: () => ({ scheme: 'broken' }) })
  const harness = await createFilesystemApp({ app: { runtime: { overrides: [override(SessionAuth, Broken)] } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const before = harness.app.runtime.inspect().liveEnvCount
    await assert.rejects(manager.acquire('alpha', 'request'), error => error instanceof TypeError && /Authenticator interface/.test(error.message))
    assert.equal(manager.records().length, 0)
    assert.equal(harness.app.runtime.inspect().liveEnvCount, before, 'the entered SiteEnv was disposed before the failure was reported')
    assert.equal(harness.app.runtime.inspect().unsettledAttempts.length, 0)
    // Control: beta's own authenticator is unaffected and its creation is normal.
    ;(await manager.acquire('beta', 'request')).release()
    assert.equal(harness.app.runtime.inspect().liveEnvCount, before + 1)
  }
  finally {
    await harness.close()
  }
})

test('R-2 a closing Env keeps its unit of capacity until the close settles; the acquirer that started the eviction is served before later arrivals', async () => {
  const harness = await createFilesystemApp({ app: { extraServices: [SlowCloseAuth], siteManager: { capacity: 1, idleTtlMs: 60_000, acquireTimeoutMs: 2_000 } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const store = await harness.app.app.deps.store.load()
    for (const tenant of ['a', 'b', 'c']) {
      await store.forTenant(tenant).saveSiteConfig(siteConfig(tenant, { implementation: SiteAuth.to(SlowCloseAuth), options: { closeMs: 120 } }))
    }
    const base = harness.app.runtime.inspect().liveEnvCount
    ;(await manager.acquire('a', 'request')).release()

    const samples = []
    const sampler = setInterval(() => samples.push({ live: harness.app.runtime.inspect().liveEnvCount - base, records: manager.stats().records, disposing: manager.stats().disposing }), 5)
    const order = []
    const b = manager.acquire('b', 'request').then(lease => { order.push('b'); return lease })
    await sleep(10)
    assert.equal(manager.stats().disposing, 1, 'the idle env is closing and still counted')
    const c = manager.acquire('c', 'request').then(lease => { order.push('c'); return lease })
    const leaseB = await b
    leaseB.release()
    const leaseC = await c
    clearInterval(sampler)
    leaseC.release()

    assert.deepEqual(order, ['b', 'c'], 'FIFO: the evictor is served first, the later arrival after it')
    assert.ok(samples.every(sample => sample.live <= 1 && sample.records <= 1), `the working set never exceeded capacity: ${JSON.stringify(samples)}`)
    assert.ok(samples.some(sample => sample.disposing === 1), 'the closing env occupied capacity while it closed')
    assert.equal(manager.stats().evictions, 2)
    assert.equal(manager.stats().disposalFailures, 0)
  }
  finally {
    await harness.close()
  }
})

test('R-2b the page cache is single-flight, bounded (least recently used dropped) and never keeps a failed render', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { pageCacheMaxEntries: 2 } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const lease = await manager.acquire('alpha', 'request')
    try {
      const { context } = lease
      assert.equal(context.cacheStats.maxEntries, 2)
      // Ten concurrent renders of one page: one production, the other nine join it.
      const realList = context.repository.listPosts.bind(context.repository)
      let listCalls = 0
      context.repository.listPosts = async filter => { listCalls += 1; await sleep(5); return realList(filter) }
      const pages = await Promise.all(Array.from({ length: 10 }, () => context.renderIndex(anonymous)))
      assert.ok(pages.every(page => page.html === pages[0].html))
      assert.equal(listCalls, 1, 'one production')
      assert.deepEqual({ misses: context.cacheStats.misses, coalesced: context.cacheStats.coalesced, entries: context.cacheStats.entries }, { misses: 1, coalesced: 9, entries: 1 })
      context.repository.listPosts = realList
      // Bounded: three distinct pages, two kept; the least recently used goes first.
      const slugs = (await context.listPosts(anonymous)).map(post => post.slug)
      assert.ok(slugs.length >= 2)
      await context.renderPost(slugs[0], anonymous) // index, post0
      await context.renderIndex(anonymous) // a hit: index is now the most recently used
      await context.renderPost(slugs[1], anonymous) // post0 is dropped
      assert.equal(context.cacheStats.entries, 2)
      assert.equal(context.cacheStats.evictions, 1)
      const missesBefore = context.cacheStats.misses
      await context.renderIndex(anonymous)
      assert.equal(context.cacheStats.misses, missesBefore, 'the index survived')
      await context.renderPost(slugs[0], anonymous)
      assert.equal(context.cacheStats.misses, missesBefore + 1, 'post0 was rendered again')
      // A failed render is not cached and does not poison the key: the next lookup renders again.
      let failOnce = true
      context.repository.listPosts = async filter => { if (failOnce) { failOnce = false; throw new Error('store hiccup') } return realList(filter) }
      const entriesBefore = context.cacheStats.entries
      await assert.rejects(context.renderIndex(anonymous, 'engineering'), /store hiccup/)
      assert.equal(context.cacheStats.entries, entriesBefore)
      const category = await context.renderIndex(anonymous, 'engineering')
      assert.equal(category.meta.kind, 'category')
      assert.equal(context.cacheStats.entries, Math.min(2, entriesBefore + 1))
      context.repository.listPosts = realList
    }
    finally {
      lease.release()
    }
  }
  finally {
    await harness.close()
  }
})

test('R-2 the page cache reads the content version before the content it renders, so an edit landing in between is never cached under the new version', async () => {
  const harness = await createFilesystemApp()
  try {
    const manager = await harness.app.app.deps.sites.load()
    const store = await harness.app.app.deps.store.load()
    const repository = store.forTenant('alpha')
    const post = (await repository.listPosts({ visibility: 'public' })).find(item => item.status === 'published')
    const lease = await manager.acquire('alpha', 'request')
    try {
      const { context } = lease
      const warm = await context.renderPost(post.slug, anonymous)
      assert.ok(warm.html.includes(post.body.slice(0, 20)))
      // Hold the version read so that the edit lands between the two reads renderPost makes.
      const realVersion = context.repository.contentVersion.bind(context.repository)
      let release
      const gate = new Promise(resolve => { release = resolve })
      context.repository.contentVersion = async () => { await gate; return realVersion() }
      const rendering = context.renderPost(post.slug, anonymous)
      await sleep(10)
      await repository.savePost({ ...post, body: 'UPDATED-BODY-MARKER' })
      release()
      await rendering
      context.repository.contentVersion = realVersion
      const after = await context.renderPost(post.slug, anonymous)
      assert.ok(after.html.includes('UPDATED-BODY-MARKER'), 'the page rendered from pre-edit content was keyed by the pre-edit version')
      // Control: the index page, whose content is read inside the producer, lists the post too.
      const index = await context.renderIndex(anonymous)
      assert.ok(index.html.includes(`/posts/${post.slug}`))
    }
    finally {
      lease.release()
    }
  }
  finally {
    await harness.close()
  }
})

test('R-2/R-4 a SiteEnv whose close rejects is reported and counted, never an unhandled rejection; sweep, shutdown and close() keep going', async () => {
  const reported = []
  const harness = await createFilesystemApp({ app: {
    extraServices: [ThrowingCloseAuth],
    siteManager: { capacity: 2, idleTtlMs: 60_000, onDisposalError: (error, record) => reported.push({ message: error.message, key: record.key, tenantId: record.tenantId }) },
  } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const store = await harness.app.app.deps.store.load()
    await store.forTenant('x').saveSiteConfig(siteConfig('x', { implementation: SiteAuth.to(ThrowingCloseAuth), options: {} }))
    const first = await manager.acquire('x', 'request')
    first.release()
    manager.invalidate('x') // draining and idle: closed in the background
    assert.ok(await until(() => reported.length === 1))
    assert.match(reported[0].message, /failed to dispose cleanly/)
    assert.equal(reported[0].tenantId, 'x')
    assert.equal(manager.stats().disposalFailures, 1)
    assert.equal(manager.records().length, 0, 'the record is released although its close failed')
    // The tenant is still served: a new world is created for it.
    const second = await manager.acquire('x', 'request')
    second.release()
    assert.equal(await manager.sweep(), 0)
    const report = await harness.app.close()
    assert.equal(manager.stats().disposalFailures, 2, 'the shutdown close of the second world failed the same way and was counted')
    assert.equal(reported.length, 2)
    assert.deepEqual(report.unreleasedLeases, [])
    assert.deepEqual(report.unsettledAttempts, [])
    assert.deepEqual(report.errors, [], 'the SiteEnvs were already closed by the manager; the Runtime itself closed cleanly')
  }
  finally {
    await harness.close()
  }
})

test('R-2/R-4 under the default unhandled-rejection policy, background closes that fail do not crash the process', async () => {
  const dist = fileURLToPath(new URL('../dist/index.js', import.meta.url))
  const harness = fileURLToPath(new URL('./helpers/app-harness.mjs', import.meta.url))
  const script = `
    import { AuthOptions, AuthenticatorContract, SiteAuth, defaultRecipes, define } from ${JSON.stringify(dist)}
    import { createFilesystemApp } from ${JSON.stringify(harness)}
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const Throwing = define.service('review-child-throwing-auth', {
      provides: [AuthenticatorContract], requires: { options: AuthOptions },
      setup(_deps, { onDispose }) { onDispose(() => { throw new Error('cleanup exploded') }); return { scheme: 't', async authenticate() { return { kind: 'anonymous' } } } },
    })
    const app = await createFilesystemApp({ app: { extraServices: [Throwing], siteManager: { capacity: 2, idleTtlMs: 5, sweepIntervalMs: 5, onDisposalError: () => undefined } } })
    const manager = await app.app.app.deps.sites.load()
    const store = await app.app.app.deps.store.load()
    await store.forTenant('x').saveSiteConfig({ tenantId: 'x', title: 'x', domains: ['x.test'], defaultLocale: 'en', theme: { name: 'paper', accent: '#000000' }, navigation: [], recipes: defaultRecipes(), auth: { implementation: SiteAuth.to(Throwing), options: {} } })
    ;(await manager.acquire('x', 'request')).release()
    await sleep(60) // the sweeper evicts it and the close fails in the background
    ;(await manager.acquire('x', 'request')).release()
    manager.invalidate('x')
    await sleep(30)
    const stats = manager.stats()
    await app.close()
    console.log(JSON.stringify({ disposalFailures: stats.disposalFailures, evictions: stats.evictions }))
  `
  const result = await run(process.execPath, ['--input-type=module', '-e', script])
    .then(value => ({ code: 0, ...value }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
  assert.equal(result.code, 0, `the process died:\n${result.stderr}`)
  const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.ok(outcome.disposalFailures >= 2, JSON.stringify(outcome))
})

test('S7 close() reports a failing site-manager shutdown instead of swallowing it, and is idempotent', async () => {
  const harness = await createFilesystemApp()
  const manager = await harness.app.app.deps.sites.load()
  const lease = await manager.acquire('alpha', 'request')
  lease.release()
  const realShutdown = manager.shutdown
  manager.shutdown = async () => { throw new Error('shutdown exploded') }
  const first = harness.app.close()
  const second = harness.app.close()
  assert.equal(await second, await first, 'a second close() returns the same report, it does not close twice')
  const report = await first
  assert.ok(report.errors.some(error => /shutdown exploded/.test(String(error.message ?? error))), `the manager error is in the report: ${JSON.stringify(report.errors.map(String))}`)
  assert.equal(harness.app.runtime.inspect().liveEnvCount, 0, 'the Runtime was disposed anyway (the manager\'s own cleanup closed the site env)')
  manager.shutdown = realShutdown
  await harness.close() // the harness closes the app again: same report, then removes the directory
})

test('R-2/R-3 close() returns attempts that never settled and disposal errors instead of rejecting; the Runtime retains only the ledger', async () => {
  const reported = []
  const events = []
  const harness = await createFilesystemApp({ app: {
    extraServices: [StubbornAuth],
    runtime: { limits: { disposalGraceMs: 20 }, diagnostics: { onEvent: event => events.push(event.type) } },
    // The shutdown gives up waiting for the creating record long before the stubborn setup ends.
    siteManager: { capacity: 2, idleTtlMs: 60_000, shutdownTimeoutMs: 30, onDisposalError: error => reported.push(error) },
  } })
  const manager = await harness.app.app.deps.sites.load()
  const store = await harness.app.app.deps.store.load()
  await store.forTenant('s').saveSiteConfig(siteConfig('s', { implementation: SiteAuth.to(StubbornAuth), options: { delayMs: 400 } }))
  const acquiring = manager.acquire('s', 'request').catch(error => error)
  await until(() => manager.records().some(record => record.tenantId === 's' && record.state === 'creating'))
  await sleep(20) // the SiteEnv is entered; the authenticator setup is now in flight

  const started = Date.now()
  const report = await harness.app.close()
  assert.ok(Date.now() - started < 300, 'close() is bounded by the shutdown timeout plus the disposal grace, not by the stubborn setup')
  // 0.7 (S2): the 0.6 assertions "the manager reported the SiteEnv close (unsettled-attempt error, details.slots)"
  // and "the Runtime re-reported it as an error of close()" are withdrawn: the close fulfils, the attempt is on the ledger.
  assert.deepEqual(reported, [], 'a SiteEnv close that abandons an attempt is not a disposal error')
  assert.equal(report.unreleasedLeases.length, 1, 'the creator\'s hold on the creating record is reported as unreleased')
  assert.equal(report.unsettledAttempts.length, 1)
  assert.match(report.unsettledAttempts[0].revision, /stubborn/)
  assert.equal(report.unsettledAttempts[0].state, 'abandoned')
  assert.deepEqual(report.errors, [], 'the outstanding attempt is reported in unsettledAttempts, not as an error')
  assert.deepEqual(events.filter(type => type === 'attempt-abandoned' || type === 'runtime-attempts-outstanding'), ['attempt-abandoned', 'runtime-attempts-outstanding'], 'the Runtime reported the outstanding attempt once when it closed')
  assert.equal(harness.app.runtime.inspect().liveEnvCount, 0, 'no Env is retained: the closed SiteEnv left the registries')
  assert.ok((await acquiring) instanceof Error)

  // Once the stubborn setup finishes, its result is discarded and the ledger empties.
  await until(() => harness.app.runtime.inspect().unsettledAttempts.length === 0, 2_000)
  assert.equal(harness.app.runtime.inspect().unsettledAttempts.length, 0)
  assert.equal(harness.app.runtime.inspect().liveEnvCount, 0)
  await harness.close()
})
