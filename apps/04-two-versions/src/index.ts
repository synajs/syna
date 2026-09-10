// 04-two-versions: two versions of one provider coexist; stored choices keep working.
//
// The domain: the Acme SDK shipped a generation 2. Tenants who chose Acme before
// keep their stored choice, new tenants get the new generation, and both generations
// are installed side by side until the last legacy tenant has moved.
import assert from 'node:assert/strict'
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage, isSynaError } from 'syna'
import { AcmeNotify as AcmeNotify1 } from '@syna-demo/acme-notify-v1'
import { AcmeNotify as AcmeNotify2 } from '@syna-demo/acme-notify-v2'
import { GlobexNotify } from '@syna-demo/globex-notify'
import { Logger } from '@syna-demo/logger'
import { Notifier, type Delivery, type Notification } from '@syna-demo/notify-contract'
import { CurrentTenant, type Tenant } from '@syna-demo/tenant-store'

const define = definePackage(packageJson)

export const PreferredNotifier = define.binding('preferred-notifier', Notifier)

export interface Outbox {
  deliver(notification: Notification): Promise<Delivery & { readonly batches: boolean }>
}

export const Outbox = define.service('outbox', {
  requires: { notifier: PreferredNotifier, logger: Logger },
  async setup({ notifier, logger }): Promise<Outbox> {
    const log = await logger.load()
    return {
      async deliver(notification) {
        const client = await notifier.load()
        const delivery = await client.send(notification)
        log.info(`outbox: ${notification.id} delivered by ${delivery.provider} ${delivery.providerVersion}`)
        // Through the Binding the client is the Contract; whether this revision can batch is a runtime fact.
        return { ...delivery, batches: 'sendBatch' in client }
      },
    }
  },
})

export interface Audit {
  versions(): Promise<{ readonly newest: string; readonly legacy: string }>
}

// A range reference, taken from the 1.x revision: "any Acme client from 1.8.0 on".
// It resolves to the newest admitted revision that satisfies the range and provides
// the same Contracts — and it types as that Contract view, not as the 1.x instance.
export const Audit = define.service('audit', {
  requires: { newest: AcmeNotify1.range('>=1.8.0'), legacy: AcmeNotify1.range('^1.8.0') },
  setup({ newest, legacy }): Audit {
    return {
      async versions() {
        return { newest: (await newest.load()).providerVersion, legacy: (await legacy.load()).providerVersion }
      },
    }
  },
})

export const TenantEntry = define.entry('tenant', {
  requires: { outbox: Outbox, audit: Audit },
  parameters: { tenant: CurrentTenant, notifier: PreferredNotifier },
})

const legacyTenant: Tenant = { id: 'early-bird', name: 'Early Bird Ltd', apiKey: 'key-early-bird' }
const newTenant: Tenant = { id: 'newcomer', name: 'Newcomer Inc', apiKey: 'key-newcomer' }

// Both generations are admitted; nothing else changes for the tenants.
const runtime = createRuntime({ services: [Outbox, Audit, AcmeNotify1, AcmeNotify2, GlobexNotify, Logger] })

const catalog = runtime.catalog.implementations(Notifier).map(record => `${record.familyId}@${record.version}`)
const acmeRevisions = runtime.catalog.revisions(AcmeNotify1.family)
console.log(`04-two-versions: catalog: ${catalog.join(', ')}; Acme revisions: ${acmeRevisions.join(', ')}`)

// The legacy tenant's choice was stored when only 1.x existed: a range intent, not a pin to a build.
const storedBeforeV2 = { kind: 'implementation-ref', contractId: Notifier.id, familyId: 'demo.notify.acme', range: '^1.8.0' }
const legacyChoice = PreferredNotifier.parse(storedBeforeV2)
const newChoice = PreferredNotifier.to(AcmeNotify2)

const deliver = (tenant: Tenant, notifier: typeof legacyChoice, id: string) => runtime.run(TenantEntry, { tenant, notifier }, async ({ outbox, audit }) => ({
  delivery: await (await outbox.load()).deliver({ id, to: `owner@${tenant.id}.test`, subject: 'Hello', body: 'Hello' }),
  audit: await (await audit.load()).versions(),
}))
const legacy = await deliver(legacyTenant, legacyChoice, 'welcome-1')
const fresh = await deliver(newTenant, newChoice, 'welcome-2')
console.log(`04-two-versions: legacy tenant (stored ${legacyChoice.range}) → Acme ${legacy.delivery.providerVersion}, batches: ${legacy.delivery.batches ? 'yes' : 'no'}; new tenant (${newChoice.range}) → Acme ${fresh.delivery.providerVersion}, batches: ${fresh.delivery.batches ? 'yes' : 'no'}`)
console.log(`04-two-versions: a range taken from the 1.x code: >=1.8.0 → ${legacy.audit.newest}, ^1.8.0 → ${legacy.audit.legacy}`)

// A choice stored for a generation nobody ships any more is refused with what is available.
const storedForV0 = PreferredNotifier.parse({ ...storedBeforeV2, range: '^0.9.0' })
let refusal = 'accepted'
try {
  runtime.catalog.resolve(storedForV0)
}
catch (error) {
  if (isSynaError(error, 'MISSING_IMPLEMENTATION') && 'available' in error.details) refusal = `${error.code} (available: ${error.details.available.join(', ')})`
  else throw error
}
const planned = await runtime.check(TenantEntry, { tenant: newTenant, notifier: storedForV0 })
console.log(`04-two-versions: a stored choice for ^0.9.0 is refused: ${refusal}; a world entered with it: ${planned.ok ? 'ok' : planned.error.code}`)

const liveWorlds = runtime.inspect().liveEnvCount
await runtime.dispose()

// The demo checks what it printed.
assert.deepEqual(catalog, ['demo.notify.acme@2.4.1', 'demo.notify.acme@1.8.4', 'demo.notify.globex@3.1.0'])
assert.deepEqual(acmeRevisions, ['2.4.1', '1.8.4'])
assert.equal(runtime.catalog.resolve(legacyChoice).version, '1.8.4')
assert.deepEqual(legacy.delivery, { notificationId: 'welcome-1', provider: 'Acme', providerVersion: '1.8.4', receipt: 'acme/1/1-1', batches: false })
assert.deepEqual(fresh.delivery, { notificationId: 'welcome-2', provider: 'Acme', providerVersion: '2.4.1', receipt: 'acme/2/2-1', batches: true })
assert.deepEqual(legacy.audit, { newest: '2.4.1', legacy: '1.8.4' })
assert.deepEqual(fresh.audit, { newest: '2.4.1', legacy: '1.8.4' })
assert.equal(refusal, 'MISSING_IMPLEMENTATION (available: 2.4.1, 1.8.4)')
assert.equal(planned.ok, false)
if (!planned.ok) assert.equal(planned.error.code, 'MISSING_IMPLEMENTATION')
assert.equal(liveWorlds, 0)
console.log('04-two-versions: OK')
