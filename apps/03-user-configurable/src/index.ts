// 03-user-configurable: a tenant chooses its provider; the choice is stored as JSON.
//
// The domain: two providers can deliver a notification. A tenant picks one on a
// settings page; the choice goes into the tenant store (a JSON file) and must still
// mean the same provider when it is read back later.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage, isSynaError, type ImplementationRef } from 'syna'
import { AcmeNotify } from '@syna-demo/acme-notify-v2'
import { GlobexNotify } from '@syna-demo/globex-notify'
import { Logger } from '@syna-demo/logger'
import { Notifier, type Delivery, type Notification } from '@syna-demo/notify-contract'
import { CurrentTenant, TenantStore, TenantStoreConfig, type Tenant } from '@syna-demo/tenant-store'

const define = definePackage(packageJson)

// The Contract `Notifier` ("can send a notification") is defined once, in
// @syna-demo/notify-contract, with `define.contract<Notifier>('notifier')`; the Acme and
// Globex clients declare `provides: [Notifier]`. This program depends on the Contract,
// never on a particular client.

// The tenant's choice is a Binding: a named slot that one implementation of the
// Contract is assigned to when a tenant world is entered.
export const PreferredNotifier = define.binding('preferred-notifier', Notifier, {
  metadata: { displayName: 'Preferred notifier', description: 'The provider a tenant chose on its settings page.' },
})

export interface ProviderOption {
  readonly label: string
  /** JSON-safe; what the settings page stores when the tenant picks this option. */
  readonly choice: ImplementationRef<typeof Notifier>
}

export interface SettingsPage {
  options(): Promise<readonly ProviderOption[]>
}

// The settings page lists every admitted implementation of the Contract: `Notifier.all`.
export const SettingsPage = define.service('settings-page', {
  requires: { providers: Notifier.all },
  setup({ providers }): SettingsPage {
    return {
      async options() {
        const set = await providers.load()
        return set.candidates.map(candidate => ({
          label: `${candidate.familyMetadata.displayName} ${candidate.version}`,
          choice: candidate.implementationRef,
        }))
      },
    }
  },
})

export interface Outbox {
  deliver(notification: Notification): Promise<Delivery>
}

// The outbox depends on the Binding, so it gets whichever provider the world was
// entered with — the Contract's `send()`, nothing provider-specific.
export const Outbox = define.service('outbox', {
  requires: { notifier: PreferredNotifier, logger: Logger },
  async setup({ notifier, logger }): Promise<Outbox> {
    const log = await logger.load()
    return {
      async deliver(notification) {
        const client = await notifier.load()
        const delivery = await client.send(notification)
        log.info(`outbox: ${notification.id} delivered by ${delivery.provider} ${delivery.providerVersion} (receipt ${delivery.receipt})`)
        return delivery
      },
    }
  },
})

export const AppEntry = define.entry('app', {
  requires: { store: TenantStore },
  parameters: { config: TenantStoreConfig },
})

// The settings page needs the tenant (the provider clients hold a tenant credential),
// but no choice yet — it is where the choice is made.
export const SettingsEntry = define.entry('settings', {
  requires: { page: SettingsPage },
  parameters: { tenant: CurrentTenant },
})

// A delivery world needs both: the tenant and the tenant's choice.
export const TenantEntry = define.entry('tenant', {
  requires: { outbox: Outbox },
  parameters: { tenant: CurrentTenant, notifier: PreferredNotifier },
})

const tenants: readonly Tenant[] = [
  { id: 'acme-corp', name: 'Acme Corp', apiKey: 'key-acme-corp' },
  { id: 'globex-fans', name: 'Globex Fans', apiKey: 'key-globex-fans' },
]
const directory = mkdtempSync(path.join(tmpdir(), '03-user-configurable-'))
const runtime = createRuntime({ services: [Outbox, SettingsPage, AcmeNotify, GlobexNotify, TenantStore, Logger] })

const app = await runtime.enter(AppEntry, { config: { directory } })
const store = await app.deps.store.load()
for (const tenant of tenants) await store.saveTenant(tenant)

// 1. The settings page of globex-fans lists the providers; the tenant picks Globex.
const options = await app.run(SettingsEntry, { tenant: tenants[1]! }, async ({ page }) => (await page.load()).options())
console.log(`03-user-configurable: settings page of globex-fans: ${options.map(option => option.label).join(', ')}`)
const globexChoice = PreferredNotifier.to(GlobexNotify)
const acmeChoice = PreferredNotifier.to(AcmeNotify)
await store.writeSettings('globex-fans', { notifier: globexChoice })
await store.writeSettings('acme-corp', { notifier: acmeChoice })

// 2. What was written is plain JSON with one shape; reading it back gives the same reference.
const storedText = readFileSync(path.join(directory, 'settings', 'globex-fans.json'), 'utf8')
const storedDocument = JSON.parse(storedText) as { notifier: unknown }
const readBack = PreferredNotifier.parse(storedDocument.notifier)
console.log(`03-user-configurable: stored choice of globex-fans: ${JSON.stringify(storedDocument.notifier)}`)

// 3. Each tenant's world is entered with the choice read from its file.
const deliveries: Record<string, Delivery> = {}
for (const [index, tenant] of tenants.entries()) {
  const settings = await store.readSettings(tenant.id)
  const notifier = PreferredNotifier.parse(settings.notifier)
  deliveries[tenant.id] = await app.run(TenantEntry, { tenant, notifier }, async ({ outbox }) =>
    (await outbox.load()).deliver({ id: `welcome-${index + 1}`, to: `owner@${tenant.id}.test`, subject: 'Welcome', body: 'Hello' }))
}
const summary = tenants.map(tenant => `${tenant.id} → ${deliveries[tenant.id]!.provider} ${deliveries[tenant.id]!.providerVersion} (receipt ${deliveries[tenant.id]!.receipt})`)
console.log(`03-user-configurable: ${summary.join('; ')}`)

// 4. A document that is not a complete reference is refused when it is read, not when it is used.
let refusal = 'accepted'
try {
  PreferredNotifier.parse({ kind: 'implementation-ref', contractId: Notifier.id, familyId: 'demo.notify.globex' })
}
catch (error) {
  if (isSynaError(error, 'INVALID_DESCRIPTOR')) refusal = `${error.code} (${error.details.problem})`
  else throw error
}
console.log(`03-user-configurable: a hand-written document without a range is refused: ${refusal}`)

await app.dispose()
const liveWorlds = runtime.inspect().liveEnvCount
await runtime.dispose()
rmSync(directory, { recursive: true, force: true })

// The demo checks what it printed.
assert.deepEqual(options.map(option => option.label), ['Acme Notify 2.4.1', 'Globex Notify 3.1.0'])
assert.deepEqual(options[1]!.choice, globexChoice)
assert.deepEqual(Object.keys(storedDocument.notifier as object), ['kind', 'contractId', 'familyId', 'range'])
assert.deepEqual(storedDocument.notifier, { kind: 'implementation-ref', contractId: Notifier.id, familyId: GlobexNotify.family.id, range: '^3.1.0' })
assert.deepEqual(readBack, globexChoice)
assert.equal(runtime.catalog.resolve(readBack).version, '3.1.0')
assert.deepEqual(deliveries['acme-corp'], { notificationId: 'welcome-1', provider: 'Acme', providerVersion: '2.4.1', receipt: 'acme/2/1-1' })
assert.deepEqual(deliveries['globex-fans'], { notificationId: 'welcome-2', provider: 'Globex', providerVersion: '3.1.0', receipt: 'globex/1-1' })
assert.equal(refusal, 'INVALID_DESCRIPTOR (malformed-implementation-ref)')
assert.equal(liveWorlds, 0)
console.log('03-user-configurable: OK')
