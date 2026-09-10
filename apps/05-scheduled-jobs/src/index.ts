// 05-scheduled-jobs: a scheduler service creates one typed child world per tenant.
//
// The domain: once a day every tenant gets a digest. The scheduler is a service of
// the application world; each digest is its own small world — the tenant, the date,
// the tenant's provider client — that shares the application's connection pool and
// is gone as soon as the digest was sent.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage, isSynaError, type EntryCheck } from 'syna'
import { AcmeNotify } from '@syna-demo/acme-notify-v2'
import { Logger } from '@syna-demo/logger'
import { CurrentTenant, TenantStore, TenantStoreConfig, type Tenant } from '@syna-demo/tenant-store'

const define = definePackage(packageJson)

export interface DigestJob {
  readonly date: string
}

/** The job a digest world is about: its own Input, next to the tenant. */
export const DigestJob = define.input<DigestJob>('digest-job')

export interface DigestReport {
  readonly tenantId: string
  readonly date: string
  readonly poolId: number
  readonly batchId: string
  readonly world: string
}

export interface DigestSender {
  send(): Promise<Omit<DigestReport, 'world'>>
}

// Lives in a digest world: reads the world's tenant and job, uses the tenant's Acme
// client (per tenant, see 02) and the shared store (from the application world).
export const DigestSender = define.service('digest-sender', {
  requires: { job: DigestJob, tenant: CurrentTenant, notifier: AcmeNotify, store: TenantStore, logger: Logger },
  async setup({ job, tenant, notifier, store, logger }): Promise<DigestSender> {
    const { date } = job.read()
    const { id, name } = tenant.read()
    const log = await logger.load()
    return {
      async send() {
        const acme = await notifier.load()
        const pool = await store.load()
        const items = [{ id: `digest-${date}-1`, to: `owner@${id}.test`, subject: `${name}: your digest for ${date}`, body: '3 new deliveries' }]
        const batch = await acme.sendBatch(items)
        log.info(`digest for ${id} on ${date}: batch ${batch.batchId} through pool #${pool.poolId}`)
        return { tenantId: id, date, poolId: pool.poolId, batchId: batch.batchId }
      },
    }
  },
})

// The digest world: what it offers and what it must be given.
export const DigestEntry = define.entry('digest', {
  requires: { sender: DigestSender },
  parameters: { tenant: CurrentTenant, job: DigestJob },
})

export interface DigestScheduler {
  /** The plan of a digest world, checked while the scheduler itself was starting. */
  readonly preflight: EntryCheck
  runOnce(date: string): Promise<readonly DigestReport[]>
}

// The scheduler depends on the digest Entry. What it receives is that Entry anchored
// at the world that owns the scheduler: every world it opens is a child of the
// application world, typed by the Entry — and it needs no "current world" to do so.
export const DigestScheduler = define.service('digest-scheduler', {
  eager: true,
  requires: { digest: DigestEntry, store: TenantStore, logger: Logger },
  async setup({ digest, store, logger }): Promise<DigestScheduler> {
    const anchored = await digest.load()
    const log = await logger.load()
    // Planning is allowed while this world is still activating; entering is not (see below).
    const preflight = await anchored.check({ tenant: { id: 'probe', name: 'Probe', apiKey: 'probe' }, job: { date: '0000-00-00' } })
    log.info(`digest scheduler: digest world planned: ${preflight.ok ? 'ok' : preflight.error.code}`)
    return {
      preflight,
      async runOnce(date) {
        const tenants = await (await store.load()).listTenants()
        // One world per tenant, all at once; `run()` closes each world when its callback returns.
        return Promise.all(tenants.map(tenant => anchored.run({ tenant, job: { date } }, async ({ sender }, world) => ({
          ...(await (await sender.load()).send()),
          world: world.id,
        }))))
      },
    }
  },
})

export const AppEntry = define.entry('app', {
  requires: { scheduler: DigestScheduler, store: TenantStore },
  parameters: { config: TenantStoreConfig },
})

const tenants: readonly Tenant[] = [
  { id: 'acme-corp', name: 'Acme Corp', apiKey: 'key-acme-corp' },
  { id: 'globex-fans', name: 'Globex Fans', apiKey: 'key-globex-fans' },
]
const directory = mkdtempSync(path.join(tmpdir(), '05-scheduled-jobs-'))
const runtime = createRuntime({ services: [DigestScheduler, DigestSender, AcmeNotify, TenantStore, Logger] })

const app = await runtime.enter(AppEntry, { config: { directory } })
const store = await app.deps.store.load()
for (const tenant of tenants) await store.saveTenant(tenant)

// The host starts the schedule once the application world is ready.
const scheduler = await app.deps.scheduler.load()
console.log(`05-scheduled-jobs: the scheduler planned a digest world while it was starting: ${scheduler.preflight.ok ? 'ok' : scheduler.preflight.error.code}`)
const reports = [...await scheduler.runOnce('2026-09-07')].sort((a, b) => a.tenantId.localeCompare(b.tenantId))
const liveAfterRun = runtime.inspect().liveEnvCount
console.log(`05-scheduled-jobs: digests for 2026-09-07: ${reports.map(report => `${report.tenantId} (pool #${report.poolId})`).join(', ')}; batches: ${reports.map(report => report.batchId).sort().join(', ')}`)
console.log(`05-scheduled-jobs: worlds alive after the run: ${liveAfterRun} (each digest world closed when its run() returned)`)

// Control: a service that opens a child world during its own setup is refused — its
// owner is not ready yet — and that refusal fails the activation of the owner world.
const Ping = define.entry('ping', {})
const Impatient = define.service('impatient', {
  eager: true,
  requires: { ping: Ping },
  async setup({ ping }) {
    await (await ping.load()).enter()
    return {}
  },
})
const ImpatientRoot = define.entry('impatient-root', { requires: { impatient: Impatient } })
const control = createRuntime({ services: [Impatient] })
let refusal = 'entered'
try {
  await control.enter(ImpatientRoot)
}
catch (error) {
  if (isSynaError(error, 'ENTRY_ACTIVATION_FAILED')) refusal = `${error.code} (cause ${error.details.causeCode})`
  else throw error
}
await control.dispose()
console.log(`05-scheduled-jobs: entering a child world from inside setup is refused: ${refusal}`)

await app.dispose()
const liveWorlds = runtime.inspect().liveEnvCount
await runtime.dispose()
rmSync(directory, { recursive: true, force: true })

// The demo checks what it printed.
assert.equal(scheduler.preflight.ok, true)
assert.deepEqual(reports.map(report => report.tenantId), ['acme-corp', 'globex-fans'])
assert.deepEqual(reports.map(report => report.poolId), [store.poolId, store.poolId])
assert.deepEqual(reports.map(report => report.date), ['2026-09-07', '2026-09-07'])
assert.deepEqual(reports.map(report => report.batchId).sort(), ['acme/2/batch-1-1', 'acme/2/batch-2-1'])
assert.notEqual(reports[0]!.world, reports[1]!.world)
assert.notEqual(reports[0]!.world, app.id)
assert.equal(liveAfterRun, 1)
assert.equal(refusal, 'ENTRY_ACTIVATION_FAILED (cause OWNER_NOT_READY)')
assert.equal(store.stats().closed, true)
assert.equal(liveWorlds, 0)
console.log('05-scheduled-jobs: OK')
