// 06-testing: the real provider replaced by a recording fake in an integration test.
//
// The domain: the application delivers through Acme. An integration test must run the
// same application — same worlds, same tenant choices, same code path — without
// calling Acme, and check what would have been sent.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage, override, type Runtime } from 'synajs'
import { AcmeNotify } from '@syna-demo/acme-notify-v2'
import { Logger } from '@syna-demo/logger'
import { Notifier, type Delivery, type Notification } from '@syna-demo/notify-contract'
import { CurrentTenant, TenantStore, TenantStoreConfig, type Tenant } from '@syna-demo/tenant-store'

const define = definePackage(packageJson)

// --- the application (the shape of 03) --------------------------------------------------

export const PreferredNotifier = define.binding('preferred-notifier', Notifier)

export interface Outbox {
  deliver(notification: Notification): Promise<Delivery>
}

export const Outbox = define.service('outbox', {
  requires: { notifier: PreferredNotifier, logger: Logger },
  async setup({ notifier, logger }): Promise<Outbox> {
    const log = await logger.load()
    return {
      async deliver(notification) {
        const delivery = await (await notifier.load()).send(notification)
        log.info(`outbox: ${notification.id} delivered by ${delivery.provider} ${delivery.providerVersion}`)
        return delivery
      },
    }
  },
})

export const AppEntry = define.entry('app', {
  requires: { store: TenantStore },
  parameters: { config: TenantStoreConfig },
})

export const TenantEntry = define.entry('tenant', {
  requires: { outbox: Outbox },
  parameters: { tenant: CurrentTenant, notifier: PreferredNotifier },
})

interface Outcome {
  readonly tenantId: string
  readonly notificationId: string
  readonly provider: string
}

/** The application's job, written once and run under both Runtimes. */
export async function deliverAll(runtime: Runtime, directory: string): Promise<{ outcomes: readonly Outcome[]; versions: readonly string[] }> {
  const tenants: readonly Tenant[] = [
    { id: 'acme-corp', name: 'Acme Corp', apiKey: 'key-acme-corp' },
    { id: 'globex-fans', name: 'Globex Fans', apiKey: 'key-globex-fans' },
  ]
  const notifications: readonly Notification[] = [
    { id: 'welcome-1', to: 'owner@acme-corp.test', subject: 'Welcome', body: 'Hello' },
    { id: 'invoice-2', to: 'billing@globex-fans.test', subject: 'Invoice', body: 'Attached' },
  ]
  return runtime.run(AppEntry, { config: { directory } }, async ({ store }, app) => {
    const outcomes: Outcome[] = []
    const versions: string[] = []
    for (const [index, tenant] of tenants.entries()) {
      await (await store.load()).saveTenant(tenant)
      // The tenants chose Acme; the same stored choice is used under both Runtimes.
      const delivery = await app.run(TenantEntry, { tenant, notifier: PreferredNotifier.to(AcmeNotify) }, async ({ outbox }) =>
        (await outbox.load()).deliver(notifications[index]!))
      outcomes.push({ tenantId: tenant.id, notificationId: delivery.notificationId, provider: delivery.provider })
      versions.push(delivery.providerVersion)
    }
    return { outcomes, versions }
  })
}

// --- the test double ------------------------------------------------------------------

const recorded: string[] = []

// A recording fake with the real client's instance shape. It is never admitted on its
// own: `override(AcmeNotify, RecordingNotifier)` makes every path that resolves the
// real revision — the Binding written for it included — run this setup instead.
export const RecordingNotifier = define.service('recording-notifier', {
  requires: { tenant: CurrentTenant },
  setup({ tenant }) {
    const { id } = tenant.read()
    const record = (notification: Notification): Delivery => {
      recorded.push(`${id}:${notification.id}`)
      return { notificationId: notification.id, provider: 'Acme', providerVersion: 'fake', receipt: `fake-${recorded.length}` }
    }
    return {
      provider: 'Acme',
      providerVersion: 'fake',
      tenantId: id,
      sdk: 'acme-sdk-2' as const,
      async send(notification: Notification) {
        return record(notification)
      },
      async sendBatch(notifications: readonly Notification[]) {
        return { batchId: `fake-batch-${recorded.length + 1}`, deliveries: notifications.map(record) }
      },
    }
  },
})

// --- the same job under both Runtimes ---------------------------------------------------

const services = [Outbox, AcmeNotify, TenantStore, Logger]
const real = createRuntime({ services })
const fake = createRuntime({ services, overrides: [override(AcmeNotify, RecordingNotifier)] })

const directory = mkdtempSync(path.join(tmpdir(), '06-testing-'))
const underReal = await deliverAll(real, path.join(directory, 'real'))
const underFake = await deliverAll(fake, path.join(directory, 'fake'))
const describe = (result: typeof underReal) => result.outcomes.map((outcome, index) => `${outcome.tenantId}/${outcome.notificationId} via ${outcome.provider} ${result.versions[index]}`).join(', ')
console.log(`06-testing: real runtime: ${describe(underReal)}`)
console.log(`06-testing: fake runtime: ${describe(underFake)}`)
const agree = JSON.stringify(underReal.outcomes) === JSON.stringify(underFake.outcomes)
console.log(`06-testing: same tenants, notifications and outcomes under both: ${agree}`)
console.log(`06-testing: the fake recorded: ${recorded.join(', ')}; overridden in the fake runtime: ${fake.inspect().overriddenServices.join(', ')}`)

const liveWorlds = real.inspect().liveEnvCount + fake.inspect().liveEnvCount
await real.dispose()
await fake.dispose()
rmSync(directory, { recursive: true, force: true })

// The demo checks what it printed.
assert.deepEqual(underReal.outcomes, [
  { tenantId: 'acme-corp', notificationId: 'welcome-1', provider: 'Acme' },
  { tenantId: 'globex-fans', notificationId: 'invoice-2', provider: 'Acme' },
])
assert.deepEqual(underFake.outcomes, underReal.outcomes)
assert.deepEqual(underReal.versions, ['2.4.1', '2.4.1'])
assert.deepEqual(underFake.versions, ['fake', 'fake'])
assert.deepEqual(recorded, ['acme-corp:welcome-1', 'globex-fans:invoice-2'])
assert.deepEqual(real.inspect().overriddenServices, [])
assert.deepEqual(fake.inspect().overriddenServices, [AcmeNotify.id])
assert.equal(liveWorlds, 0)
console.log('06-testing: OK')
