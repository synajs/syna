// 02-per-tenant: one set of instances per tenant, without a named scope.
//
// The domain: a notification service with several tenants. Each tenant has its own
// credential at the provider, so each tenant needs its own provider client and its
// own outbox — while the tenant store (a connection pool) and the logger are shared.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage, type EntryExplanation, type ForkCause } from 'synajs'
import { AcmeNotify } from '@syna-demo/acme-notify-v2'
import { Logger } from '@syna-demo/logger'
import { CurrentTenant, TenantStore, TenantStoreConfig, type Tenant } from '@syna-demo/tenant-store'

const define = definePackage(packageJson)

interface Notification {
  readonly id: string
  readonly to: string
  readonly subject: string
  readonly body: string
}

export interface Branding {
  readonly signature: string
}

// The tenant is an Input: a fact of the world, read synchronously. A Service that
// reads it belongs to that tenant's world — so every tenant world gets its own.
export const Branding = define.service('branding', {
  requires: { tenant: CurrentTenant },
  setup({ tenant }): Branding {
    const { name } = tenant.read()
    return { signature: `— ${name}` }
  },
})

export interface Outbox {
  deliver(notification: Notification): Promise<string>
}

// The outbox never reads the tenant itself. It follows its dependencies: the branding
// and the Acme client are per tenant, so the outbox is per tenant too; the store and
// the logger are not, so they are the same instances in every tenant world.
export const Outbox = define.service('outbox', {
  requires: { branding: Branding, notifier: AcmeNotify, store: TenantStore, logger: Logger },
  async setup({ branding, notifier, store, logger }): Promise<Outbox> {
    const log = await logger.load()
    const { signature } = await branding.load()
    return {
      async deliver(notification) {
        const acme = await notifier.load()
        const delivery = await acme.send({ ...notification, body: `${notification.body}\n${signature}` })
        await (await store.load()).writeSettings(acme.tenantId, { lastReceipt: delivery.receipt })
        log.info(`outbox of ${acme.tenantId}: ${notification.id} delivered (receipt ${delivery.receipt})`)
        return delivery.receipt
      },
    }
  },
})

// The root world: shared infrastructure, configured by the host.
export const AppEntry = define.entry('app', {
  requires: { store: TenantStore, logger: Logger },
  parameters: { config: TenantStoreConfig },
})

// A tenant world: a child of the root that provides the tenant. `share` says the store
// and the logger must be the parent's — a world that cannot reuse them is refused
// rather than silently opening a second pool.
export const TenantEntry = define.entry('tenant', {
  requires: { outbox: Outbox, notifier: AcmeNotify, store: TenantStore, logger: Logger },
  parameters: { tenant: CurrentTenant },
  reuse: { share: [TenantStore, Logger] },
})

const why = (cause: ForkCause | undefined): string => {
  switch (cause?.kind) {
    case 'input-provided': return 'this world provides it'
    case 'dependency-forked': return `its dependency "${cause.via}" is new in this world`
    case 'not-in-parent': return 'the parent world has no such node'
    default: return cause?.kind ?? 'root'
  }
}

const report = (title: string, plan: EntryExplanation): void => {
  if (!plan.ok) throw new Error(`${title}: ${plan.error.message}`)
  console.log(`02-per-tenant: ${title}: ${plan.services.new} new, ${plan.services.forked} forked, ${plan.services.reused} reused services`)
  for (const fork of plan.forks) console.log(`02-per-tenant:   ${fork.placement} ${fork.label} — ${why(fork.cause)}`)
}

const tenants: readonly Tenant[] = [
  { id: 'acme-corp', name: 'Acme Corp', apiKey: 'key-acme-corp' },
  { id: 'globex-fans', name: 'Globex Fans', apiKey: 'key-globex-fans' },
]
const directory = mkdtempSync(path.join(tmpdir(), '02-per-tenant-'))
const runtime = createRuntime({ services: [Outbox, Branding, AcmeNotify, TenantStore, Logger] })

const app = await runtime.enter(AppEntry, { config: { directory } })
const store = await app.deps.store.load()
const logger = await app.deps.logger.load()
for (const tenant of tenants) await store.saveTenant(tenant)

// Ask before entering: what would a tenant world create, and why?
const tenantPlan = await app.explain(TenantEntry, { tenant: tenants[0]! })
report('a tenant world', tenantPlan)

// Two tenant worlds, one delivery each.
const worlds = await Promise.all(tenants.map(tenant => app.enter(TenantEntry, { tenant })))
const receipts: string[] = []
const outboxes = []
const clients = []
for (const [index, world] of worlds.entries()) {
  const outbox = await world.deps.outbox.load()
  outboxes.push(outbox)
  clients.push(await world.deps.notifier.load())
  receipts.push(await outbox.deliver({ id: `welcome-${index + 1}`, to: `owner@${tenants[index]!.id}.test`, subject: 'Welcome', body: 'Hello' }))
}
const sameStore = (await worlds[0]!.deps.store.load()) === store && (await worlds[1]!.deps.store.load()) === store
const sameLogger = (await worlds[0]!.deps.logger.load()) === logger && (await worlds[1]!.deps.logger.load()) === logger
console.log(`02-per-tenant: ${tenants[0]!.id} → ${receipts[0]}; ${tenants[1]!.id} → ${receipts[1]}`)
console.log(`02-per-tenant: separate outboxes and Acme clients per tenant: ${outboxes[0] !== outboxes[1] && clients[0] !== clients[1]}; one store pool and one logger for all: ${sameStore && sameLogger}`)

// A world below a tenant world that provides the tenant again (a sandbox credential):
// exactly what depends on the tenant is forked, the rest is reused.
const SandboxEntry = define.entry('sandbox', {
  requires: { outbox: Outbox, notifier: AcmeNotify, store: TenantStore },
  parameters: { tenant: CurrentTenant },
})
const sandboxTenant: Tenant = { ...tenants[0]!, apiKey: 'sandbox-key' }
const sandboxPlan = await worlds[0]!.explain(SandboxEntry, { tenant: sandboxTenant })
report('a sandbox world below acme-corp', sandboxPlan)
const sandbox = await worlds[0]!.enter(SandboxEntry, { tenant: sandboxTenant })
const sandboxClient = await sandbox.deps.notifier.load()
const sandboxReceipt = await (await sandbox.deps.outbox.load()).deliver({ id: 'sandbox-1', to: 'qa@acme-corp.test', subject: 'Test', body: 'Hello' })
const sandboxPool = (await sandbox.deps.store.load()).poolId
console.log(`02-per-tenant: the sandbox has its own Acme client (${sandboxClient !== clients[0]}) on the shared pool #${sandboxPool}: ${sandboxReceipt}`)

// `share` is a hard constraint: a caller asking for a fresh store is refused, not obeyed.
const refused = await app.check(TenantEntry, { tenant: tenants[1]! }, { reuse: { fresh: [TenantStore] } })
console.log(`02-per-tenant: a caller asking for a fresh store under a shared one is refused: ${refused.ok ? 'no' : refused.error.code}`)

await sandbox.dispose()
for (const world of worlds) await world.dispose()
await app.dispose()
const liveWorlds = runtime.inspect().liveEnvCount
await runtime.dispose()
rmSync(directory, { recursive: true, force: true })

// The demo checks what it printed.
assert.equal(tenantPlan.ok, true)
if (tenantPlan.ok) {
  assert.deepEqual({ new: tenantPlan.services.new, forked: tenantPlan.services.forked, reused: tenantPlan.services.reused }, { new: 3, forked: 0, reused: 2 })
  assert.deepEqual(tenantPlan.forks.map(fork => fork.cause?.kind).sort(), ['input-provided', 'not-in-parent', 'not-in-parent', 'not-in-parent'])
}
assert.deepEqual(receipts, ['acme/2/1-1', 'acme/2/2-1'])
assert.notEqual(outboxes[0], outboxes[1])
assert.notEqual(clients[0], clients[1])
assert.equal(sameStore && sameLogger, true)
assert.equal(sandboxPlan.ok, true)
if (sandboxPlan.ok) {
  assert.deepEqual({ new: sandboxPlan.services.new, forked: sandboxPlan.services.forked, reused: sandboxPlan.services.reused }, { new: 0, forked: 3, reused: 2 })
  const outboxFork = sandboxPlan.forks.find(fork => fork.label.includes('/outbox@'))
  assert.equal(outboxFork?.cause?.kind, 'dependency-forked')
}
assert.notEqual(sandboxClient, clients[0])
assert.equal(sandboxPool, store.poolId)
assert.equal(sandboxReceipt, 'acme/2/3-1')
assert.equal(refused.ok, false)
if (!refused.ok) assert.equal(refused.error.code, 'SHARE_CONSTRAINT_FAILED')
assert.equal(store.stats().closed, true)
assert.equal(liveWorlds, 0)
console.log('02-per-tenant: OK')
