// The independent audit of 1.0.0-rc.2 (probes reconstructed in
// work/rc3/probes/site-manager.mjs, baseline in work/rc3/BASELINE.md), flipped:
// each case asserts the correct behaviour where the probe asserted the defect.
// RC2-A1 the manager winds down exactly once, whatever closed its admission;
// RC2-A2 one deadline bounds the whole acquire, the configuration read included;
// RC2-A3 a shutdown ends the wait of every caller in flight.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { override } from 'syna'
import { PreflightError, RequestHandler, createHylaApp, violations } from '../dist/index.js'
import { createFilesystemApp } from './helpers/app-harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitUntil = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
    await sleep(2)
  }
}
const settledWithin = async (promise, ms) => {
  const pending = Symbol('pending')
  const result = await Promise.race([promise.then(value => ({ value }), error => ({ error })), sleep(ms).then(() => pending)])
  return result === pending ? undefined : result
}

/** Records every interval created while `body` runs, and whether it was cleared. */
const watchIntervals = async body => {
  const intervals = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (callback, ms, ...rest) => {
    const entry = { cleared: false, fired: 0 }
    entry.handle = realSetInterval((...args) => { entry.fired += 1; return callback(...args) }, ms, ...rest)
    intervals.push(entry)
    return entry.handle
  }
  globalThis.clearInterval = handle => {
    for (const entry of intervals) if (entry.handle === handle) entry.cleared = true
    return realClearInterval(handle)
  }
  try { return await body(intervals) }
  finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

/** Gates every getSiteConfig() of one store (the site-manager tests' helper). */
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
    open(tenantId) { const gate = entry(tenantId); gate.isOpen = true; gate.open() },
    restore() { store.forTenant = realForTenant },
  }
}

test('RC2-A1 the site manager winds down exactly once on all three closing paths: explicit shutdown, owner abort, startup rollback', async () => {
  // 1. The host shuts the manager down and then disposes the Runtime.
  await watchIntervals(async intervals => {
    const harness = await createFilesystemApp({ app: { siteManager: { capacity: 2, sweepIntervalMs: 30, shutdownTimeoutMs: 200 } } })
    const manager = await harness.app.app.deps.sites.load()
    const sweeper = intervals.at(-1)
    const lease = await manager.acquire('alpha', 'request')
    lease.release()
    const first = await manager.shutdown()
    assert.deepEqual(first.unreleasedLeases, [])
    assert.equal(sweeper.cleared, true, 'the sweep interval is cleared by the shutdown')
    const firedAfterShutdown = sweeper.fired
    const second = await manager.shutdown()
    assert.deepEqual(second, first, 'shutdown() is idempotent: every caller gets the same report')
    await harness.app.close()
    await sleep(90)
    assert.equal(sweeper.fired, firedAfterShutdown, 'and the sweeper never fires again')
    assert.equal(manager.stats().closed, true)
    await harness.close()
  })

  // 2. Only the Runtime is disposed: the owner's abort listener runs first, and
  //    closing the admission is not a reason to skip the wind-down.
  await watchIntervals(async intervals => {
    const harness = await createFilesystemApp({ app: { siteManager: { capacity: 1, sweepIntervalMs: 30, acquireTimeoutMs: 30_000, shutdownTimeoutMs: 200 } } })
    const manager = await harness.app.app.deps.sites.load()
    const sweeper = intervals.at(-1)
    const held = await manager.acquire('alpha', 'request')
    const queued = manager.acquire('beta', 'request').then(() => 'acquired', error => error.code ?? error.name)
    await waitUntil(() => manager.stats().pendingAcquires === 1)
    held.release()
    await harness.app.runtime.dispose().catch(() => undefined)
    assert.equal(sweeper.cleared, true, 'the abort listener no longer swallows the wind-down')
    const firedAfterClose = sweeper.fired
    assert.deepEqual(await settledWithin(queued, 200), { value: 'SITE_MANAGER_CLOSED' }, 'the queued acquirer is rejected by the shutdown itself')
    assert.equal(manager.stats().pendingAcquires, 0, 'no waiter is left hanging')
    await sleep(90)
    assert.equal(sweeper.fired, firedAfterClose)
    assert.deepEqual(await manager.shutdown(), await manager.shutdown(), 'shutdown() after the close is the same idempotent report')
    await harness.close()
  })

  // 3. Startup fails after the manager was created: the rollback winds it down.
  await watchIntervals(async intervals => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'rc3-a1-rollback-'))
    try {
      await assert.rejects(
        createHylaApp({
          backend: { kind: 'filesystem', rootDir },
          siteManager: { sweepIntervalMs: 30 },
          runtime: { overrides: [override(RequestHandler, violations.HeavyRequestHandler)] },
        }),
        error => error instanceof PreflightError,
      )
      const sweeper = intervals.at(-1)
      assert.ok(sweeper, 'the manager was created before the deployment was refused')
      assert.equal(sweeper.cleared, true, 'the refused startup cleared the sweep interval')
      const firedAfterRollback = sweeper.fired
      await sleep(90)
      assert.equal(sweeper.fired, firedAfterRollback, 'nothing of the refused deployment keeps running')
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

test('RC2-A2 one deadline bounds the whole acquire: a blocked configuration read is refused within acquireTimeoutMs', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 2, acquireTimeoutMs: 200 } } })
  try {
    const store = await harness.app.app.deps.store.load()
    const manager = await harness.app.app.deps.sites.load()
    const gates = gateConfigReads(store)
    const started = Date.now()
    const acquiring = manager.acquire('alpha', 'request').then(() => 'acquired', error => error.code ?? error.name)
    await waitUntil(() => gates.waiting('alpha') === 1)
    assert.equal(manager.stats().inFlightAcquires, 1)
    assert.equal(manager.stats().inFlightConfigReads, 1)
    assert.equal(manager.stats().pendingAcquires, 0, 'a configuration read is not the capacity queue')

    assert.equal(await acquiring, 'SITE_CAPACITY', 'the acquire is refused, not left waiting on the store')
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 190 && elapsed < 900, `refused on the acquire deadline (after ${elapsed} ms, timeout 200 ms)`)
    assert.equal(manager.stats().inFlightAcquires, 0)

    // The shared round-trip was not cancelled: a second acquirer of the same
    // tenant still gets its configuration when the store answers.
    const joined = manager.acquire('alpha', 'request')
    await waitUntil(() => manager.stats().inFlightAcquires === 1)
    gates.open('alpha')
    const lease = await joined
    assert.equal(lease.tenantId, 'alpha')
    lease.release()
    gates.restore()
  }
  finally {
    await harness.close()
  }
})

test('RC2-A3 shutdown() ends the wait of every caller in flight, without waiting for the store', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 2, acquireTimeoutMs: 30_000, shutdownTimeoutMs: 200 } } })
  try {
    const store = await harness.app.app.deps.store.load()
    const manager = await harness.app.app.deps.sites.load()
    const gates = gateConfigReads(store)
    const acquiring = manager.acquire('alpha', 'request').then(() => 'acquired', error => error.code ?? error.name)
    await waitUntil(() => gates.waiting('alpha') === 1)
    assert.equal(manager.stats().inFlightAcquires, 1)

    const started = Date.now()
    await manager.shutdown()
    assert.equal(await acquiring, 'SITE_MANAGER_CLOSED', 'the in-flight caller is refused as closed')
    const elapsed = Date.now() - started
    assert.ok(elapsed < 500, `the shutdown did not wait for the store (${elapsed} ms)`)
    assert.equal(manager.stats().inFlightAcquires, 0, 'nobody is left in flight')
    assert.equal(manager.stats().closed, true)

    // The round-trip itself was never cancelled; it just has no callers left.
    assert.equal(manager.stats().inFlightConfigReads, 1)
    gates.open('alpha')
    await waitUntil(() => manager.stats().inFlightConfigReads === 0)
    gates.restore()
  }
  finally {
    await harness.close()
  }
})
