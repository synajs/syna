import { createRuntime, type CreateRuntimeOptions, type Env, type Runtime, type ServiceRevision, type UnsettledAttemptInspection } from 'synajs'
import { AUTHENTICATORS } from './auth/implementations.js'
import { DatabasePool } from './data/postgres/pool.js'
import { PostgresContentStore } from './data/postgres/store.js'
import { FilesystemContentStore } from './data/filesystem/store.js'
import { BlogLayout, ContentLayoutChoice, DefaultLayout } from './data/filesystem/layout.js'
import { ContentBackend } from './domain/content.js'
import type { DatabaseSettings } from './data/postgres/config.js'
import { PipelineBuilder } from './render/pipeline.js'
import { Renderer } from './render/renderer.js'
import { STAGE_FACTORIES } from './render/factories.js'
import { MarkdownStageFactoryContract } from './render/stages.js'
import { RenderInfrastructureEntry } from './render/infrastructure.js'
import { SiteContext } from './site/context.js'
import { FilesystemInfrastructureEntry, PostgresInfrastructureEntry, RequestEntry, SiteEntry } from './site/entries.js'
import { AppEntry } from './site/app-entry.js'
import { SiteEnvironmentManager } from './site/manager.js'
import { RequestHandler } from './site/request.js'
import { StaticBuilder } from './site/static-builder.js'
import { MaintenanceWorker } from './site/worker.js'
import type { RequestFacts, SiteManagerSettings } from './site/inputs.js'
import { evaluateBudget, type BudgetReport, type ForkBudget } from './site/preflight.js'
import { loadDomainTable, type DomainTable } from './site/domains.js'
import { defaultRecipes } from './render/recipe.js'
import { SessionAuth } from './auth/implementations.js'
import { SiteAuth } from './auth/contract.js'

export type BackendChoice =
  | { readonly kind: 'postgres'; readonly database: DatabaseSettings }
  | { readonly kind: 'filesystem'; readonly rootDir: string; readonly layout?: 'default' | 'blog' }

export interface HylaAppOptions {
  readonly backend: BackendChoice
  readonly siteManager?: Partial<SiteManagerSettings>
  /** Additional admitted Services (third-party factories, alternative authenticators, fixtures). */
  readonly extraServices?: readonly ServiceRevision[]
  readonly runtime?: Omit<CreateRuntimeOptions, 'services'>
}

export interface HylaShutdownReport {
  /** `key#count` of site leases still held when the shutdown timeout expired. Empty on a clean close. */
  readonly unreleasedLeases: readonly string[]
  /**
   * Setup attempts that ignored the stop signal past the disposal grace and are
   * still pending when `close()` returns (from `runtime.inspect().unsettledAttempts`;
   * the Runtime also reports them once as `runtime-attempts-outstanding`). Their
   * resources are outside Syna control; the Runtime retains only this ledger.
   */
  readonly unsettledAttempts: readonly UnsettledAttemptInspection[]
  /** Errors raised while disposing the Runtime (Service cleanups that threw). Empty on a clean close. */
  readonly errors: readonly unknown[]
}

export interface HylaApp {
  readonly runtime: Runtime
  readonly infrastructure: Env<any>
  readonly app: Env<typeof AppEntry['requires']>
  readonly preflight: readonly BudgetReport[]
  domains(): Promise<DomainTable>
  /** Shuts the site manager down first (reporting unreleased leases), then disposes the Runtime. */
  close(): Promise<HylaShutdownReport>
}

/** Default budget for one request: only the request handler may be local; shared infrastructure must be inherited. */
export const REQUEST_BUDGET: ForkBudget = Object.freeze({
  maxLocalServices: 10,
  mustInherit: Object.freeze([
    `service:${PipelineBuilder.id}`,
    `service:${Renderer.id}`,
    `service:${SiteContext.id}`,
    ...STAGE_FACTORIES.map(factory => `service:${factory.id}`),
  ]),
  costs: Object.freeze({ [DatabasePool.id]: 10, [PostgresContentStore.id]: 10, [FilesystemContentStore.id]: 5 }),
  maxCost: 10,
})

export const SITE_BUDGET: ForkBudget = Object.freeze({
  maxLocalServices: 4,
  mustInherit: Object.freeze([
    `service:${PipelineBuilder.id}`,
    `service:${Renderer.id}`,
    ...STAGE_FACTORIES.map(factory => `service:${factory.id}`),
  ]),
})

export const CORE_SERVICES: readonly ServiceRevision[] = Object.freeze([
  DatabasePool,
  PostgresContentStore,
  FilesystemContentStore,
  DefaultLayout,
  BlogLayout,
  ...STAGE_FACTORIES,
  PipelineBuilder,
  Renderer,
  SiteContext,
  RequestHandler,
  StaticBuilder,
  SiteEnvironmentManager,
  MaintenanceWorker,
  ...AUTHENTICATORS,
])

export class PreflightError extends Error {
  readonly reports: readonly BudgetReport[]
  constructor(reports: readonly BudgetReport[]) {
    super(`Deployment refused by preflight:\n${reports.flatMap(report => report.violations.map(violation => `  [${report.entry}] ${violation}`)).join('\n')}`)
    this.name = 'PreflightError'
    this.reports = reports
  }
}

/**
 * Host wiring: Runtime → infrastructure root → app Env, with startup preflight.
 * The render infrastructure (including the whole factory collection) and the
 * site/request shapes are explained and budget-checked before anything listens.
 */
export async function createHylaApp(options: HylaAppOptions): Promise<HylaApp> {
  const runtime = createRuntime({
    ...options.runtime,
    services: [...CORE_SERVICES, ...(options.extraServices ?? [])],
  })
  const reports: BudgetReport[] = []
  const refuse = async (): Promise<never> => {
    await runtime.dispose()
    throw new PreflightError(reports)
  }

  // 1. Render infrastructure must plan with only public infrastructure; any factory needing request/site facts fails here.
  const infrastructureExplanation = await runtime.explain(RenderInfrastructureEntry)
  reports.push(evaluateBudget(infrastructureExplanation, { maxLocalServices: Number.POSITIVE_INFINITY, mustInherit: [] }))
  if (!reports.at(-1)!.ok) return refuse()

  let infrastructure: Env<any>
  let backend
  if (options.backend.kind === 'postgres') {
    infrastructure = await runtime.enter(PostgresInfrastructureEntry, { database: options.backend.database })
    backend = ContentBackend.to(PostgresContentStore)
  }
  else {
    infrastructure = await runtime.enter(FilesystemInfrastructureEntry, {
      contentRoot: { rootDir: options.backend.rootDir },
      layout: ContentLayoutChoice.to(options.backend.layout === 'blog' ? BlogLayout : DefaultLayout),
    })
    backend = ContentBackend.to(FilesystemContentStore)
  }
  const appParameters = { backend, siteManager: options.siteManager ?? {} }

  // 2. The app world plans; then the site and request shapes are budget-checked from a planned app world.
  const appCheck = await infrastructure.check(AppEntry, appParameters)
  if (!appCheck.ok) {
    await runtime.dispose()
    throw new Error(`App entry does not plan: ${appCheck.error.code} ${appCheck.error.message}`)
  }
  let app: Env<typeof AppEntry['requires']>
  try {
    app = await infrastructure.enter(AppEntry, appParameters)
    // Touch the backend now: an unreachable database or a bad schema fails startup,
    // not the first request.
    await app.deps.store.load()
  }
  catch (error) {
    await runtime.dispose().catch(() => undefined)
    throw error
  }
  const probeSite = {
    tenantId: 'preflight',
    title: 'preflight',
    domains: [],
    defaultLocale: 'en' as const,
    theme: { name: 'paper', accent: '#000000' },
    navigation: [],
    recipes: defaultRecipes(),
    auth: { implementation: SiteAuth.to(SessionAuth), options: {} },
    configRevision: 1,
  }
  const siteExplanation = await app.explain(SiteEntry, {
    tenant: 'preflight',
    snapshot: probeSite,
    auth: SiteAuth.to(SessionAuth),
    authOptions: {},
  })
  reports.push(evaluateBudget(siteExplanation, SITE_BUDGET))
  if (!reports.at(-1)!.ok) return refuse()

  // 3. The request shape is budget-checked from a real site world: a synthetic
  //    tenant entered once here, outside the manager, touching no content. An
  //    embedder that never runs preflightRequests() still gets the request check;
  //    preflightRequests() repeats it per configured tenant (their own recipes
  //    and authenticators). The manager itself comes up now, so invalid site
  //    manager settings fail startup rather than the first request.
  try {
    await app.deps.sites.load()
    const probeEnv = await app.enter(SiteEntry, {
      tenant: 'preflight',
      snapshot: probeSite,
      auth: SiteAuth.to(SessionAuth),
      authOptions: {},
    })
    try { reports.push(await explainRequest(probeEnv)) }
    finally { await probeEnv.dispose() }
  }
  catch (error) {
    await runtime.dispose().catch(() => undefined)
    throw error
  }
  if (!reports.at(-1)!.ok) return refuse()

  let closing: Promise<HylaShutdownReport> | undefined
  return {
    runtime,
    infrastructure,
    app,
    preflight: reports,
    domains: async () => loadDomainTable(await app.deps.store.load()),
    /**
     * Never rejects for conditions it can report: unreleased leases, attempts
     * that never settled and cleanup failures (the site manager's shutdown
     * included) are returned, so the host decides what to log and what to
     * escalate. Idempotent: every caller gets the same report.
     */
    close() {
      closing ??= (async () => {
        let unreleasedLeases: readonly string[] = []
        const errors: unknown[] = []
        try {
          const manager = await app.deps.sites.load()
          unreleasedLeases = (await manager.shutdown()).unreleasedLeases
        }
        catch (error) {
          errors.push(error)
        }
        // The Runtime nests its report (Runtime → Env → Service); the host gets the leaves.
        const leaves = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(leaves) : [error]
        try { await runtime.dispose() }
        catch (error) { errors.push(...leaves(error)) }
        return { unreleasedLeases, unsettledAttempts: runtime.inspect().unsettledAttempts, errors }
      })()
      return closing
    },
  }
}

export const PROBE_REQUEST: RequestFacts = Object.freeze({
  method: 'GET',
  path: '/',
  query: Object.freeze({}),
  host: 'preflight.test',
  headers: Object.freeze({}),
  principal: Object.freeze({ kind: 'anonymous' as const }),
  target: 'http' as const,
})

/** Explains one request from a live site Env and evaluates the request budget. Planning only. */
export async function explainRequest(
  siteEnv: Env<typeof SiteEntry['requires']>,
  facts: RequestFacts = PROBE_REQUEST,
  budget: ForkBudget = REQUEST_BUDGET,
): Promise<BudgetReport> {
  const explanation = await siteEnv.explain(RequestEntry, { request: facts })
  return evaluateBudget(explanation, budget)
}

/**
 * Request-budget preflight for every known tenant: acquires each SiteEnv once,
 * explains a probe request against the request budget, releases the lease.
 * Run before the server listens; a violation refuses the deployment.
 */
export async function preflightRequests(app: HylaApp, tenantIds?: readonly string[]): Promise<readonly BudgetReport[]> {
  const store = await app.app.deps.store.load()
  const manager = await app.app.deps.sites.load()
  const tenants = tenantIds ?? await store.listTenants()
  const reports: BudgetReport[] = []
  for (const tenantId of tenants) {
    const lease = await manager.acquire(tenantId, 'background')
    try {
      reports.push(await explainRequest(lease.env))
    }
    finally {
      lease.release()
    }
  }
  if (reports.some(report => !report.ok)) throw new PreflightError(reports)
  return reports
}

export { MarkdownStageFactoryContract }
