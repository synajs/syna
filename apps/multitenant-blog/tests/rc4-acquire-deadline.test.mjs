// 1.0.0-rc.4 / A4 — one deadline for the whole acquire, and a shutdown that ends
// every in-flight wait wherever it stands.
//
// `docs/MULTITENANT_BLOG.md` promises that the whole acquire shares one deadline.
// Until now that deadline covered the configuration read and the capacity wait but
// stopped at the door of `create()`: the three awaits inside it — `boundSites.enter()`,
// `context.load()`, `auth.load()` — and the wait on somebody else's `record.creation`
// had no deadline and no signal, so an `acquireTimeoutMs` of 20 ms could return a
// working lease 85 ms later, and a caller stuck in a creation only learned of a
// shutdown when the creation returned (work/rc4/BASELINE.md §6).
//
// The fix bounds the *wait*, never the creation: the shared creation keeps running,
// keeps its Env and stays available to everyone else. That division of labour is
// what most of the cases below assert.
//
// The gates sit in the bound authenticator, which `create()` reaches twice: as an
// eager revision it blocks `boundSites.enter()`, as a lazy one it blocks
// `auth.load()`. `context.load()` runs between the two and the deadline wraps the
// whole `record.creation`, so it is covered by construction; the application
// exposes no seam that would let a test stop the site context from outside.
import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthOptions, AuthenticatorContract, SiteAuth, define } from '../dist/index.js'
import { AUTH, createFilesystemApp } from './helpers/app-harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitUntil = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
    await sleep(2)
  }
}
const outcomeOf = promise => promise.then(lease => { lease.release(); return 'lease' }, error => error?.code ?? String(error))

/** A gate every test opens itself; `setups` counts how often the site authenticator started. */
const makeGate = () => {
  let open
  const promise = new Promise(resolve => { open = resolve })
  return { promise, open, setups: 0 }
}

const slowAuth = (gate, id, eager) => define.service(id, {
  eager,
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  async setup({ options }) {
    gate.setups += 1
    void options.read()
    await gate.promise
    return { scheme: 'slow', async authenticate() { return { kind: 'anonymous', roles: [] } } }
  },
})

/** An app whose `alpha` tenant authenticates with the gated revision. */
const gatedApp = async (gate, { eager = false, ...siteManager } = {}) => {
  const Slow = slowAuth(gate, `rc4-slow-auth-${eager ? 'eager' : 'lazy'}-${Math.random().toString(36).slice(2, 8)}`, eager)
  return createFilesystemApp({
    auth: { ...AUTH, alpha: { implementation: SiteAuth.to(Slow), options: {} } },
    app: { siteManager, extraServices: [Slow] },
  })
}

for (const eager of [true, false]) {
  const where = eager ? 'boundSites.enter()' : 'auth.load()'
  test(`A4 a creation stuck in ${where} is refused at the acquirer's own deadline, and the creation goes on`, async () => {
    const gate = makeGate()
    const harness = await gatedApp(gate, { eager, capacity: 2, acquireTimeoutMs: 40, idleTtlMs: 60_000, sweepIntervalMs: 60_000 })
    try {
      const manager = await harness.app.app.deps.sites.load()
      const started = Date.now()
      const acquiring = outcomeOf(manager.acquire('alpha', 'request'))
      await waitUntil(() => gate.setups === 1)
      assert.equal(await acquiring, 'SITE_CAPACITY', 'the acquirer is refused, not handed a lease long after its deadline')
      const elapsed = Date.now() - started
      assert.ok(elapsed < 400, `at its own deadline (${elapsed} ms, timeout 40 ms)`)
      assert.equal(manager.stats().inFlightAcquires, 0)
      assert.equal(manager.stats().creating, 1, 'the creation itself was not cancelled')
      assert.equal(manager.stats().creationFailures, 0, 'and an impatient caller is not a failure of the tenant')

      // The record's fate: the creation finishes, the world becomes active and the
      // next acquirer reuses it — one creation in total, no backoff anywhere.
      gate.open()
      await waitUntil(() => manager.stats().creating === 0)
      assert.equal(manager.records().find(record => record.tenantId === 'alpha')?.state, 'active',
        'the creation nobody waited for still produced a usable world')
      assert.equal(await outcomeOf(manager.acquire('alpha', 'request')), 'lease', 'which the next acquirer reuses')
      assert.equal(manager.stats().creations, 1)
      assert.equal(gate.setups, 1, 'the site was created once')
      assert.equal(manager.stats().creationFailures, 0)
    }
    finally {
      gate.open()
      await harness.close().catch(() => undefined)
    }
  })
}

test('A4 record.creation: the first caller\'s deadline is its own — the second keeps waiting and gets the lease', async () => {
  const gate = makeGate()
  const harness = await gatedApp(gate, { capacity: 2, acquireTimeoutMs: 60, idleTtlMs: 60_000, sweepIntervalMs: 60_000 })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const first = outcomeOf(manager.acquire('alpha', 'request'))
    await waitUntil(() => gate.setups === 1)
    // The second acquirer joins the creation the first one started, with a deadline
    // of its own that starts now.
    await sleep(40)
    const second = outcomeOf(manager.acquire('alpha', 'request'))
    assert.equal(await first, 'SITE_CAPACITY', 'the first caller gave up at its own deadline')
    assert.equal(manager.stats().creating, 1, 'and the shared creation is untouched by that')
    gate.open()
    assert.equal(await second, 'lease', 'the second caller was still waiting and is served by the same creation')
    assert.equal(manager.stats().creations, 1)
    assert.equal(manager.stats().creationFailures, 0, 'one caller\'s impatience never becomes the tenant\'s backoff')
  }
  finally {
    gate.open()
    await harness.close().catch(() => undefined)
  }
})

test('A4 every caller leaves: the creation still completes, is counted once and stays reusable', async () => {
  const gate = makeGate()
  const harness = await gatedApp(gate, { capacity: 2, acquireTimeoutMs: 40, idleTtlMs: 60_000, sweepIntervalMs: 60_000 })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const callers = [outcomeOf(manager.acquire('alpha', 'request')), outcomeOf(manager.acquire('alpha', 'request'))]
    await waitUntil(() => gate.setups === 1)
    assert.deepEqual(await Promise.all(callers), ['SITE_CAPACITY', 'SITE_CAPACITY'])
    assert.equal(manager.stats().inFlightAcquires, 0, 'nobody is waiting any more')
    gate.open()
    await waitUntil(() => manager.stats().creating === 0)
    const records = manager.records().filter(record => record.tenantId === 'alpha')
    assert.deepEqual(records.map(record => record.state), ['active'], 'the world nobody waited for is a normal, leaseless, reusable world')
    assert.equal(records[0].leases, 0)
    assert.equal(manager.stats().creations, 1)
    assert.equal(manager.stats().creationFailures, 0)
    assert.equal(await outcomeOf(manager.acquire('alpha', 'request')), 'lease')
    assert.equal(gate.setups, 1, 'and no second creation was started behind the first')
  }
  finally {
    gate.open()
    await harness.close().catch(() => undefined)
  }
})

test('A4 shutdown() ends the wait of a caller inside the creation at once, without waiting for it', async () => {
  const gate = makeGate()
  const harness = await gatedApp(gate, { capacity: 2, acquireTimeoutMs: 5_000, shutdownTimeoutMs: 50, idleTtlMs: 60_000, sweepIntervalMs: 60_000 })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const acquiring = outcomeOf(manager.acquire('alpha', 'request'))
    await waitUntil(() => gate.setups === 1)
    const started = Date.now()
    const shutting = manager.shutdown()
    assert.equal(await acquiring, 'SITE_MANAGER_CLOSED', 'the caller is refused as closed')
    const elapsed = Date.now() - started
    // The gate is still shut: the creation has not returned, and the caller did not wait for it.
    assert.equal(gate.setups, 1)
    assert.ok(elapsed < 400, `and it did not wait for the creation to return (${elapsed} ms)`)
    gate.open()
    const report = await shutting
    assert.ok(Array.isArray(report.unreleasedLeases))
  }
  finally {
    gate.open()
    await harness.close().catch(() => undefined)
  }
})

test('A4 the deadline racing invalidate(): the acquirer is refused within its own timeout, never left waiting on a rotated world', async () => {
  const gate = makeGate()
  const harness = await gatedApp(gate, { capacity: 2, acquireTimeoutMs: 80, idleTtlMs: 60_000, sweepIntervalMs: 60_000 })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const started = Date.now()
    const acquiring = outcomeOf(manager.acquire('alpha', 'request'))
    await waitUntil(() => gate.setups === 1)
    manager.invalidate('alpha') // the world being created is rotated away under it
    const outcome = await acquiring
    const elapsed = Date.now() - started
    assert.equal(outcome, 'SITE_CAPACITY', 'the acquirer is refused with the capacity error, not left waiting')
    assert.ok(elapsed < 600, `within its own deadline (${elapsed} ms, timeout 80 ms)`)
  }
  finally {
    gate.open()
    await harness.close().catch(() => undefined)
  }
})

test('A4 control: a normal, fast acquire is exactly what it was — the deadline never shortens the healthy path', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 2, acquireTimeoutMs: 60, idleTtlMs: 60_000, sweepIntervalMs: 60_000 } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const leases = await Promise.all([manager.acquire('alpha', 'request'), manager.acquire('alpha', 'request')])
    assert.equal(manager.stats().creations, 1, 'concurrent first acquires still share one creation')
    assert.equal(leases[0].env, leases[1].env)
    assert.equal(manager.stats().leases, 2)
    for (const lease of leases) lease.release()
    assert.equal(manager.stats().leases, 0)
    assert.equal(manager.stats().creationFailures, 0)
    const again = await manager.acquire('alpha', 'request')
    assert.equal(again.env, leases[0].env, 'and the warm world is reused')
    again.release()
  }
  finally {
    await harness.close().catch(() => undefined)
  }
})

test('A4 record.disposal: an acquirer that meets a world being closed is served or refused inside its own deadline, never behind the close', async () => {
  const gate = makeGate()
  const harness = await gatedApp(gate, { capacity: 1, acquireTimeoutMs: 300, idleTtlMs: 60_000, sweepIntervalMs: 60_000 })
  try {
    const manager = await harness.app.app.deps.sites.load()
    gate.open() // the first world is created normally
    const lease = await manager.acquire('alpha', 'request')
    // Closing that world takes as long as the SiteEnv close takes; the acquirer
    // behind it must not inherit that wait.
    manager.invalidate('alpha')
    lease.release() // leaseless and draining → the close starts now
    const started = Date.now()
    const outcome = await outcomeOf(manager.acquire('alpha', 'request'))
    const elapsed = Date.now() - started
    assert.ok(outcome === 'lease' || outcome === 'SITE_CAPACITY', `served or refused, never stuck: ${outcome}`)
    assert.ok(elapsed < 1_000, `inside its own deadline (${elapsed} ms, timeout 300 ms)`)
    assert.equal(manager.stats().creationFailures, 0)
  }
  finally {
    gate.open()
    await harness.close().catch(() => undefined)
  }
})
