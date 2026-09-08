import packageJson from '../package.json' with { type: 'json' }
import type {
  AnchoredEntry,
  Contract,
  CreateRuntimeOptions,
  DependencyMap,
  DependencyRefs,
  EntryCallArguments,
  EntryCallback,
  EntryCheck,
  Entry,
  EntryExplanation,
  EntryOptions,
  EntryArguments,
  EntryRunCallArguments,
  ReuseConstraints,
  Env,
  EnvInspection,
  UnsettledAttemptInspection,
  EnvInspectionNode,
  InputRef,
  LoadOptions,
  ImplementationRef,
  RuntimeCatalog,
  RuntimeEvent,
  RuntimeInspection,
  RuntimePolicy,
  RuntimeLimits,
  RuntimePolicyContext,
  Runtime,
  ServiceFamily,
  ServiceRef,
  ServiceRevision,
} from './descriptors.js'
import { diagnosticFromError, SynaError } from './errors.js'
import type {
  AttemptOwnerRecord,
  EnvState,
  ResolvedPlan,
  ResolutionRealm,
  RuntimeSlot,
  ServiceSlot,
} from './internal/runtime-model.js'
import { defaultVersionOrder } from './internal/identity.js'
import { PUBLIC_REALM } from './internal/resolution-realm.js'
import { Materializer } from './internal/materializer.js'
import { DefinitionCompiler } from './internal/definition-compiler.js'
import { ImplementationDirectory } from './internal/implementation-directory.js'
import { EntryPlanner, entryDefinitionSignature } from './internal/entry-planner.js'
import {
  createImplementationSet,
  type ImplementationViewHost,
} from './internal/implementation-views.js'
import { isBacktrackableTopologyError } from './internal/solve-errors.js'

const DEFAULT_LOAD_TIMEOUT_MS = 30_000
const DEFAULT_DISPOSAL_GRACE_MS = 2_000
const DEFAULT_PLANNING_BUDGET = 10_000
const DEFAULT_PLAN_CACHE_ENTRIES = 512

const internalPackage = Object.freeze({
  name: '@syna/core',
  id: '@syna/core',
  version: packageJson.version,
  metadata: Object.freeze({}),
})

const internalDeriveEntry: Entry<{}, {}> = Object.freeze({
  kind: 'entry' as const,
  package: internalPackage,
  id: '@syna/core/entry/derive/v1',
  apiVersion: 1,
  requires: Object.freeze({}),
  parameters: Object.freeze({}),
  reuse: Object.freeze({ fresh: Object.freeze([]), share: Object.freeze([]) }),
  metadata: Object.freeze({}),
})

/** One Entry call after the public argument shapes are normalized. */
interface EntryCall {
  readonly parameters: Readonly<Record<string, unknown>> | undefined
  readonly reuse: ReuseConstraints | undefined
}

/**
 * Splits `(parameters?, options?)` into the parameter record and the reuse
 * constraints. `reuse` is never a parameter key, and neither is `scope`: the
 * 0.5 call form carried the constraints under that key inside the parameter
 * record and is refused (removed in 0.7.0), never read as a parameter. A
 * non-object parameter value is passed on unchanged and rejected by the
 * planner (`INVALID_DESCRIPTOR`) as before.
 */
function entryCall(parameters: unknown, options: unknown): EntryCall {
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw new TypeError('Entry call options must be an object.')
  }
  if (options !== undefined && ('fresh' in options || 'share' in options)) {
    // The 0.7 `derive(constraints)` form (removed in 0.8.0, `docs/MIGRATION_V07_TO_V08.md` S1): refused, never read as no constraint.
    throw new TypeError('fresh and share are reuse constraints, not call options: pass them as { reuse: { fresh, share } }.')
  }
  const reuse = (options as EntryOptions | undefined)?.reuse
  if (typeof parameters !== 'object' || parameters === null) {
    return { parameters: parameters as undefined, reuse }
  }
  const record = parameters as Readonly<Record<string, unknown>>
  if ('reuse' in record) {
    throw new TypeError('reuse is a call option, not a parameter: enter(entry, parameters, { reuse }).')
  }
  if ('scope' in record) {
    throw new TypeError('scope is no longer a call parameter (removed in 0.7.0): pass the reuse constraints as the options argument, enter(entry, parameters, { reuse }).')
  }
  return { parameters: record, reuse }
}

/**
 * A malformed call shape is reported as a rejection, never as a synchronous
 * throw: `enter`/`check`/`explain` returned Promises for every failure in 0.5
 * and still do. A well-formed call keeps its synchronous planning prefix.
 */
function withCall<T>(parameters: unknown, options: unknown, run: (call: EntryCall) => Promise<T>): Promise<T> {
  let call: EntryCall
  try {
    call = entryCall(parameters, options)
  }
  catch (error) {
    return Promise.reject(error)
  }
  return run(call)
}

/** `run(entry, [parameters, [options,]] callback)`: the callback is always last. */
function runCall<E extends Entry, Result>(
  args: EntryRunCallArguments<E, Result>,
): { readonly call: EntryCall; readonly callback: EntryCallback<E, Result> } {
  const list = args as readonly unknown[]
  if (list.length === 1) return { call: entryCall({}, undefined), callback: list[0] as EntryCallback<E, Result> }
  if (list.length === 2) return { call: entryCall(list[0], undefined), callback: list[1] as EntryCallback<E, Result> }
  return { call: entryCall(list[0], list[1]), callback: list[2] as EntryCallback<E, Result> }
}

function addSuppressed(primary: unknown, cleanup: unknown): unknown {
  if (primary instanceof Error && Object.isExtensible(primary)) {
    Object.defineProperty(primary, 'suppressed', {
      configurable: true,
      enumerable: false,
      value: cleanup,
    })
    return primary
  }
  return new AggregateError(
    [primary, cleanup],
    'Entry execution and Env disposal both failed.',
    primary instanceof Error ? { cause: primary } : undefined,
  )
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number.`)
  }
  return value
}

/** The 0.5 nested option records, each of which named one limit; refused since 0.7.0 so an old call is never silently unlimited. */
const REMOVED_LIMIT_RECORDS: ReadonlyMap<string, keyof RuntimeLimits> = new Map([
  ['planCache', 'planCacheEntries'],
  ['initialization', 'loadTimeoutMs'],
  ['disposal', 'disposalGraceMs'],
  ['planning', 'planningBudget'],
])

/** `limits` is the one form; an expired nested record is a TypeError naming the limit it used to set. */
function resolveLimits(options: CreateRuntimeOptions): Required<RuntimeLimits> {
  for (const [record, limit] of REMOVED_LIMIT_RECORDS) {
    if ((options as unknown as Readonly<Record<string, unknown>>)[record] !== undefined) {
      throw new TypeError(`createRuntime() option ${record} was removed in 0.7.0; use limits.${limit}.`)
    }
  }
  const limits = options.limits ?? {}
  if (typeof limits !== 'object' || limits === null) throw new TypeError('limits must be an object.')
  // The limit renamed in 0.8.0 (`docs/MIGRATION_V07_TO_V08.md` F16): refused, so an old call is never silently on the default.
  if ((limits as Readonly<Record<string, unknown>>)['setupDeadlineMs'] !== undefined) { // syna-v08-rename
    throw new TypeError('limits.setupDeadlineMs was renamed in 0.8.0; use limits.loadTimeoutMs.') // syna-v08-rename
  }
  return {
    loadTimeoutMs: positiveNumber(limits.loadTimeoutMs, DEFAULT_LOAD_TIMEOUT_MS, 'limits.loadTimeoutMs'),
    disposalGraceMs: positiveNumber(limits.disposalGraceMs, DEFAULT_DISPOSAL_GRACE_MS, 'limits.disposalGraceMs'),
    planningBudget: limits.planningBudget ?? DEFAULT_PLANNING_BUDGET,
    planCacheEntries: limits.planCacheEntries ?? DEFAULT_PLAN_CACHE_ENTRIES,
  }
}

export const defaultRuntimePolicy: RuntimePolicy = Object.freeze({
  orderAutoCandidates(
    contract: Contract,
    candidates: readonly ServiceRevision[],
    context: RuntimePolicyContext,
  ) {
    const families = new Set(candidates.map(candidate => candidate.family.id))
    if (families.size > 1) {
      throw new SynaError(
        'MISSING_AUTO_POLICY',
        `auto(${contract.id}) has multiple implementation families, but this Runtime has no explicit auto-selection policy.`,
        { contract: contract.id, site: context.dependencySite, families: [...families].sort() },
      )
    }
    return defaultVersionOrder(candidates, context.parentActiveRevisionIds)
  },

  orderVersionCandidates(
    _family: ServiceFamily,
    candidates: readonly ServiceRevision[],
    context: RuntimePolicyContext,
  ) {
    return defaultVersionOrder(candidates, context.parentActiveRevisionIds)
  },
})

/** Any Env, whatever it requires: the Runtime's own registries and the close paths are shape-agnostic. */
type AnyEnv = EnvImpl<any>

class EnvImpl<Requires extends DependencyMap> implements Env<Requires> {
  readonly children = new Set<EnvImpl<any>>()
  readonly deps: DependencyRefs<Requires>
  readonly abortController = new AbortController()
  /** What this Env's attempts keep of it: identity, the close flag, the close's cleanup errors — never the Env. */
  readonly attemptOwner: AttemptOwnerRecord
  /** Advanced only by Runtime actions: `activating → ready → disposing → disposed`; `disposed` at the end of the bounded close. */
  state: EnvState = 'activating'
  private disposePromise?: Promise<void>
  /** Set by `disposeEnv()` the moment this Env's own close is entered, before any of it runs. */
  closing = false

  constructor(
    readonly runtime: RuntimeImpl,
    readonly id: string,
    readonly parent: EnvImpl<any> | undefined,
    readonly plan: ResolvedPlan,
    rootSiteByEntryKey: ReadonlyMap<string, string>,
  ) {
    this.attemptOwner = { envId: id, closing: false, closeErrors: [] }
    const refs: Record<string, ServiceRef<unknown> | InputRef<unknown>> = {}
    for (const [key, rootSiteId] of rootSiteByEntryKey) {
      const nodeId = plan.rootNodeBySite.get(rootSiteId)!
      const slot = plan.slotsByNode.get(nodeId)!
      refs[key] = runtime.createRefFor(slot)
    }
    this.deps = Object.freeze(refs) as unknown as DependencyRefs<Requires>
  }

  enter<E extends Entry<any, any>>(
    descriptor: E,
    ...args: EntryCallArguments<E>
  ): Promise<Env<E['requires']>> {
    return withCall(args[0], args[1], call => this.runtime.enterFrom(this, descriptor, call, PUBLIC_REALM))
  }

  async run<E extends Entry<any, any>, Result>(
    descriptor: E,
    ...args: EntryRunCallArguments<E, Result>
  ): Promise<Result> {
    const { call, callback } = runCall(args)
    const child = await this.runtime.enterFrom(this, descriptor, call, PUBLIC_REALM)
    return this.runtime.executeStructured(child, () => Promise.resolve(callback(child.deps, child)))
  }

  check<E extends Entry<any, any>>(
    descriptor: E,
    ...args: EntryCallArguments<E>
  ): Promise<EntryCheck> {
    return withCall(args[0], args[1], call => this.runtime.checkFrom(this, descriptor, call, PUBLIC_REALM))
  }

  explain<E extends Entry<any, any>>(
    descriptor: E,
    ...args: EntryCallArguments<E>
  ): Promise<EntryExplanation> {
    return withCall(args[0], args[1], call => this.runtime.explainFrom(this, descriptor, call, PUBLIC_REALM))
  }

  derive(options?: EntryOptions): Promise<Env<{}>> {
    return withCall(undefined, options, call => this.runtime.enterFrom(this, internalDeriveEntry, call, PUBLIC_REALM))
  }

  anchor<E extends Entry>(descriptor: E): AnchoredEntry<E> {
    return this.runtime.createAnchoredEntry(descriptor, this.id, PUBLIC_REALM)
  }

  inspect(): EnvInspection {
    const nodes: EnvInspectionNode[] = [...this.plan.nodes.values()]
      .map(node => {
        const slot = this.plan.slotsByNode.get(node.id)!
        const overdueAt = slot.kind === 'service' && slot.state === 'starting' ? slot.attempt?.overdueAt : undefined
        return {
          nodeId: node.id,
          kind: node.kind,
          label: node.label,
          slotId: slot.id,
          ownerEnvId: slot.ownerEnvId,
          state: slot.state,
          ...(overdueAt === undefined ? {} : { overdueMs: Date.now() - overdueAt }),
          dependencies: Object.fromEntries(
            [...slot.requires.entries()].map(([key, dependency]) => [key, dependency.id]),
          ),
        }
      })
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))

    return {
      id: this.id,
      ...(this.parent ? { parentId: this.parent.id } : {}),
      state: this.state,
      abandonedAttempts: this.runtime.abandonedAttemptsOf(this.id),
      nodes,
    }
  }

  /**
   * One close per Env, whoever asks and from wherever.
   *
   * `disposeEnv()` aborts the owner signal synchronously — `AbortController.abort()`
   * runs its listeners there and then — so user code runs *inside* this call, before
   * this line could assign what it returns. A listener that re-entered `dispose()`
   * found the field still empty and started a second close: the two raced for the
   * same slots, the one that arrived second skipped every slot the first had taken
   * and announced `disposed` empty-handed, and a cleanup that threw could end up in
   * whichever of them nobody awaited. `disposeEnv()` now sets `closing` before it
   * runs any of that and hands such a re-entry `joinClose()` instead of a second
   * close — the check belongs there, where the window is, and this stays the one
   * line it was: `??=` assigns the close after `disposeEnv()` returns, so it wins
   * over anything the re-entry left in the field.
   */
  dispose(): Promise<void> {
    this.disposePromise ??= this.runtime.disposeEnv(this)
    return this.disposePromise
  }

  /**
   * What a `dispose()` that re-entered this close's own synchronous prologue gets.
   * The close exists and its Promise is a few statements away, on the stack below:
   * `disposeEnv()` runs synchronously up to its first `await` and `dispose()` assigns
   * what it returns, both before any microtask of this one. One hop is enough to see
   * it, and this caller then settles exactly as the close itself does.
   */
  async joinClose(): Promise<void> {
    await null
    await this.disposePromise
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }
}

class RuntimeImpl implements Runtime, ImplementationViewHost {
  readonly policy: RuntimePolicy
  readonly catalog: RuntimeCatalog
  readonly roots = new Set<EnvImpl<any>>()
  readonly directory: ImplementationDirectory
  readonly internalPackage = internalPackage

  private readonly compiler: DefinitionCompiler
  private readonly materializer: Materializer
  private readonly disposalGraceMs: number
  private readonly envById = new Map<string, EnvImpl<any>>()
  private readonly planner: EntryPlanner
  private readonly onEvent: (event: RuntimeEvent) => void

  private disposed = false
  private disposePromise?: Promise<void>
  private closing = false

  constructor(options: CreateRuntimeOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('createRuntime() expects an options object.')
    }
    const policy = options.policy ?? {}
    this.policy = Object.freeze({
      orderAutoCandidates:
        policy.orderAutoCandidates ?? defaultRuntimePolicy.orderAutoCandidates,
      orderVersionCandidates:
        policy.orderVersionCandidates ?? defaultRuntimePolicy.orderVersionCandidates,
    })
    const onEvent = options.diagnostics?.onEvent
    this.onEvent = event => {
      if (!onEvent) return
      try { onEvent(event) }
      catch { /* diagnostics must never change business outcomes */ }
    }

    const limits = resolveLimits(options)
    this.compiler = new DefinitionCompiler(
      options.services,
      options.overrides ?? [],
      entryDefinitionSignature,
    )
    this.directory = new ImplementationDirectory(this.compiler.admitted, this.policy)
    this.planner = new EntryPlanner(
      this.compiler,
      this.directory,
      this.policy,
      limits.planCacheEntries,
      limits.planningBudget,
    )
    this.disposalGraceMs = limits.disposalGraceMs
    this.materializer = new Materializer({
      deadlineMs: limits.loadTimeoutMs,
      disposalGraceMs: this.disposalGraceMs,
      onEvent: this.onEvent,
    })

    this.catalog = Object.freeze({
      implementations: <C extends Contract>(contract: C) =>
        this.directory.implementations(contract),
      resolve: <C extends Contract>(ref: ImplementationRef<C>) =>
        this.directory.resolveCatalog(ref),
      revisions: (family: ServiceFamily) => {
        // The 0.7 `revisions(familyId)` form (removed in 0.8.0, `docs/MIGRATION_V07_TO_V08.md` S2): refused, never an empty list.
        if (typeof family !== 'object' || family === null) {
          throw new SynaError('INVALID_DESCRIPTOR', 'catalog.revisions() expects a ServiceFamily descriptor (revision.family), not a family id.', { descriptor: 'ServiceFamily', problem: 'not-an-object' })
        }
        if (family.kind !== 'service-family') {
          throw new SynaError('INVALID_DESCRIPTOR', 'catalog.revisions() expects a ServiceFamily descriptor.', { descriptor: 'ServiceFamily', problem: 'wrong-kind' })
        }
        return this.directory.revisions(family.id)
      },
    })
  }

  inspect(): RuntimeInspection {
    const planCache = this.planner.cacheStats()
    const definitions = this.compiler.inspect()
    return {
      admittedServices: definitions.admittedServices,
      privateServices: definitions.privateServices,
      overriddenServices: definitions.overriddenServices,
      definitions: definitions.definitions,
      rootEnvCount: [...this.roots].filter(root => root.state !== 'disposed').length,
      liveEnvCount: this.envById.size,
      unsettledAttempts: this.materializer.unsettledAttempts(),
      planCache,
      definitionWarnings: definitions.warnings,
    }
  }

  enter<E extends Entry<any, any>>(
    descriptor: E,
    ...args: EntryCallArguments<E>
  ): Promise<Env<E['requires']>> {
    return withCall(args[0], args[1], call => this.enterFrom(undefined, descriptor, call, PUBLIC_REALM))
  }

  async run<E extends Entry<any, any>, Result>(
    descriptor: E,
    ...args: EntryRunCallArguments<E, Result>
  ): Promise<Result> {
    const { call, callback } = runCall(args)
    const env = await this.enterFrom(undefined, descriptor, call, PUBLIC_REALM)
    return this.executeStructured(env, () => Promise.resolve(callback(env.deps, env)))
  }

  check<E extends Entry<any, any>>(
    descriptor: E,
    ...args: EntryCallArguments<E>
  ): Promise<EntryCheck> {
    return withCall(args[0], args[1], call => this.checkFrom(undefined, descriptor, call, PUBLIC_REALM))
  }

  explain<E extends Entry<any, any>>(
    descriptor: E,
    ...args: EntryCallArguments<E>
  ): Promise<EntryExplanation> {
    return withCall(args[0], args[1], call => this.explainFrom(undefined, descriptor, call, PUBLIC_REALM))
  }

  /** One close per Runtime, for the reason `EnvImpl.dispose()` gives: the root broadcast runs user abort listeners synchronously. */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeRuntime()
    return this.disposePromise
  }

  /** As `EnvImpl.joinClose()`: one microtask behind this close's own prologue. */
  private async joinClose(): Promise<void> {
    await null
    await this.disposePromise
  }

  private async disposeRuntime(): Promise<void> {
    {
      if (this.closing) return this.joinClose()
      this.closing = true
      this.disposed = true
      const roots = [...this.roots]
      // One broadcast over every root: marking each root's subtree separately let an
      // abort listener of the first root start work in a second one that was still
      // `ready` (N3 at the Runtime level).
      this.broadcastClosingAll(roots)
      const errors = (await Promise.allSettled(roots.map(root => root.dispose())))
        .flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
      this.planner.clearCache()
      // Envs that completed their bounded close earlier are no longer roots, but an
      // attempt they abandoned may still be pending, or its late close (cleanups)
      // may be running: give the latter the grace, then report whatever is still
      // outstanding — once, as a diagnostic — instead of fulfilling silently.
      // Attempts that ignored the stop signal are not an error of this close.
      await this.materializer.awaitSettling(this.disposalGraceMs)
      const outstanding = this.materializer.unsettledAttempts()
      if (outstanding.length > 0) this.onEvent({ type: 'runtime-attempts-outstanding', attempts: outstanding })
      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more Syna root Envs failed to dispose.')
      }
    }
  }

  /** The ledger entries an Env's close left behind (`env.inspect().abandonedAttempts`). */
  abandonedAttemptsOf(envId: string): readonly UnsettledAttemptInspection[] {
    return this.materializer.abandonedAttemptsOf(envId)
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }

  // ImplementationViewHost ------------------------------------------------------

  activeRevisionKeys(envId: string): ReadonlySet<string> {
    return this.planner.activeRevisionKeys(this.envById.get(envId)?.plan)
  }


  loadSlot(slot: RuntimeSlot, options?: LoadOptions): Promise<unknown> {
    return this.materializer.load(slot, options)
  }

  async executeStructured<Result>(
    env: Env,
    callback: () => Promise<Result> | Result,
  ): Promise<Result> {
    let result: Result
    try {
      result = await callback()
    }
    catch (primary) {
      try { await env.dispose() }
      catch (cleanup) { throw addSuppressed(primary, cleanup) }
      throw primary
    }
    try {
      await env.dispose()
    }
    catch (closeError) {
      // The callback succeeded and only the close reports: its result travels with the error.
      if (typeof closeError === 'object' && closeError !== null) {
        Object.defineProperty(closeError, 'result', { value: result, enumerable: false, configurable: true, writable: true })
      }
      throw closeError
    }
    return result
  }

  /**
   * An AnchoredEntry is anchored at one Env id. Entering requires that Env to be
   * Ready: an owner that is still activating yields OWNER_NOT_READY, a plain
   * rejected Promise the caller may catch. Planning (`check`/`explain`) only
   * plans: it runs no setup, publishes no Env, leaves no anchor and consumes no
   * Env id; it registers the descriptors it meets and may fill the plan cache,
   * both bounded by the static definition set. It is allowed while the anchor
   * activates.
   */
  createAnchoredEntry<E extends Entry<any, any>>(
    descriptor: E,
    anchorEnvId: string,
    realm: ResolutionRealm,
  ): AnchoredEntry<E> {
    const anchor = (): EnvImpl<any> => this.requireEnv(anchorEnvId)
    // async: a dead anchor (`requireEnv`) rejects, as in 0.5, instead of throwing synchronously.
    const enterAnchored = async (...args: EntryCallArguments<E>): Promise<Env<E['requires']>> =>
      withCall(args[0], args[1], call => this.enterFrom(anchor(), descriptor, call, realm))

    const runAnchored = async <Result>(...args: EntryRunCallArguments<E, Result>): Promise<Result> => {
      const { call, callback } = runCall(args)
      const child = await this.enterFrom(anchor(), descriptor, call, realm)
      return this.executeStructured(child, () => Promise.resolve(callback(child.deps, child)))
    }

    return Object.freeze({
      enter: enterAnchored,
      run: runAnchored,
      check: async (...args: EntryCallArguments<E>) =>
        withCall(args[0], args[1], call => this.checkFrom(anchor(), descriptor, call, realm, true)),
      explain: async (...args: EntryCallArguments<E>) =>
        withCall(args[0], args[1], call => this.explainFrom(anchor(), descriptor, call, realm, true)),
    })
  }

  async checkFrom<E extends Entry<any, any>>(
    parent: EnvImpl<any> | undefined,
    descriptor: E,
    call: EntryCall,
    realm: ResolutionRealm = PUBLIC_REALM,
    allowActivatingParent = false,
  ): Promise<EntryCheck> {
    try {
      const { plan } = this.planEntry(parent, descriptor, call, true, allowActivatingParent, realm)
      return Object.freeze({ ok: true, inspection: this.planner.inspect(plan) })
    }
    catch (error) {
      if (!isBacktrackableTopologyError(error)) throw error
      return Object.freeze({ ok: false, error: diagnosticFromError(error) })
    }
  }

  async explainFrom<E extends Entry<any, any>>(
    parent: EnvImpl<any> | undefined,
    descriptor: E,
    call: EntryCall,
    realm: ResolutionRealm = PUBLIC_REALM,
    allowActivatingParent = false,
  ): Promise<EntryExplanation> {
    try {
      const { plan } = this.planEntry(parent, descriptor, call, true, allowActivatingParent, realm)
      return this.planner.explain(plan, descriptor, parent)
    }
    catch (error) {
      if (!isBacktrackableTopologyError(error)) throw error
      const missing = collectMissingParameters(error.code, error.details)
      return Object.freeze({
        ok: false,
        entry: descriptor.id,
        ...(parent ? { parent: parent.id } : {}),
        error: diagnosticFromError(error),
        missingInputs: Object.freeze([...missing.inputs]),
        missingBindings: Object.freeze([...missing.bindings]),
      })
    }
  }

  async enterFrom<E extends Entry<any, any>>(
    parent: EnvImpl<any> | undefined,
    descriptor: E,
    call: EntryCall,
    realm: ResolutionRealm = PUBLIC_REALM,
  ): Promise<EnvImpl<E['requires']>> {
    const { envId, plan, rootSiteByEntryKey } = this.planEntry(parent, descriptor, call, false, false, realm)
    const env = new EnvImpl<E['requires']>(this, envId, parent, plan, rootSiteByEntryKey)
    this.envById.set(env.id, env)

    for (const slot of new Set(plan.slotsByNode.values())) {
      if (slot.kind === 'service' && slot.ownerEnvId === envId) slot.ownerEnv = env
    }

    if (parent) parent.children.add(env)
    else this.roots.add(env)

    try {
      await this.prepareSyntheticValues(env)
      await this.activateEnv(env)
      if (env.state !== 'activating') {
        throw new SynaError(
          'ENV_CLOSED',
          `Env ${env.id} was closed before activation completed.`,
          { env: env.id, state: env.state },
        )
      }
      env.state = 'ready'
      return env
    }
    catch (error) {
      // Activation failures are always reported as ENTRY_ACTIVATION_FAILED with
      // the underlying error as `cause`, whatever its type. Planning errors are
      // thrown before this point and keep their own codes.
      const failure = new SynaError(
        'ENTRY_ACTIVATION_FAILED',
        `Entry ${descriptor.id} failed while activating Env ${envId}: ${error instanceof Error ? error.message : String(error)}`,
        {
          entry: descriptor.id,
          env: envId,
          ...(error instanceof SynaError ? { causeCode: error.code, causeDetails: error.details } : {}),
        },
        { cause: error },
      )
      try { await env.dispose() }
      catch (cleanup) { throw addSuppressed(failure, cleanup) }
      throw failure
    }
  }

  createRefFor(slot: RuntimeSlot): ServiceRef<unknown> | InputRef<unknown> {
    return slot.kind === 'input'
      ? this.materializer.createInputRef(slot)
      : this.materializer.createRef(slot)
  }

  private requireEnv(envId: string): EnvImpl<any> {
    const env = this.envById.get(envId)
    if (!env) {
      throw new SynaError(
        'ENV_CLOSED',
        `Env ${envId} is no longer live.`,
        { env: envId, state: 'disposed' },
      )
    }
    return env
  }

  private planEntry<E extends Entry<any, any>>(
    parent: EnvImpl<any> | undefined,
    descriptor: E,
    call: EntryCall,
    checking: boolean,
    allowActivatingParent: boolean,
    realm: ResolutionRealm,
  ): {
    readonly envId: string
    readonly plan: ResolvedPlan
    readonly rootSiteByEntryKey: ReadonlyMap<string, string>
  } {
    this.assertEntryUsable(parent, descriptor, allowActivatingParent)
    return this.planner.plan(parent, descriptor, call.parameters as EntryArguments<E> | undefined, call.reuse, checking, realm)
  }

  private assertEntryUsable(
    parent: EnvImpl<any> | undefined,
    descriptor: Entry,
    allowActivatingParent: boolean,
  ): void {
    if (this.disposed) throw new SynaError('RUNTIME_CLOSED', 'The Syna Runtime is disposed.')
    if (typeof descriptor !== 'object' || descriptor === null || descriptor.kind !== 'entry') {
      throw new SynaError('INVALID_DESCRIPTOR', 'Expected an Entry descriptor.', { descriptor: 'Entry', problem: 'wrong-kind' })
    }
    if (!parent) return
    if (parent.runtime !== this) {
      throw new SynaError('RUNTIME_MISMATCH', 'An Entry anchor belongs to another Runtime.')
    }
    if (parent.state === 'ready') return
    if (parent.state === 'activating') {
      if (allowActivatingParent) return
      throw new SynaError(
        'OWNER_NOT_READY',
        `Cannot enter ${descriptor.id} from Env ${parent.id} while it is still activating. Finish setup first and start child worlds from a Ready owner (for example from a host-driven start() method).`,
        { entry: descriptor.id, env: parent.id, state: parent.state },
      )
    }
    throw new SynaError(
      'ENV_CLOSED',
      `Cannot enter from Env ${parent.id} while it is ${parent.state}.`,
      { env: parent.id, state: parent.state },
    )
  }

  private async prepareSyntheticValues(env: EnvImpl<any>): Promise<void> {
    for (const node of env.plan.nodes.values()) {
      const slot = env.plan.slotsByNode.get(node.id)!
      if (slot.ownerEnvId !== env.id || slot.kind === 'service' || slot.kind === 'input' || slot.value !== undefined) {
        continue
      }
      if (node.kind === 'all-implementations') slot.value = createImplementationSet(this, node, slot, env.id)
      else if (node.kind === 'entry') {
        slot.value = this.createAnchoredEntry(node.entry, this.anchorEnvId(node.anchorNodeId, env), node.realm)
      }
      Object.freeze(slot.requires)
    }
  }

  private anchorEnvId(anchorNodeId: string | undefined, fallback: EnvImpl<any>): string {
    if (!anchorNodeId) return fallback.id
    const anchorNodeSlot = fallback.plan.slotsByNode.get(anchorNodeId)
    if (!anchorNodeSlot) {
      throw new Error(`Syna internal invariant: missing anchor node ${anchorNodeId}.`)
    }
    return anchorNodeSlot.ownerEnvId
  }

  /** Ready means every eager slot owned by this Env is Ready; inherited eager slots are already Ready in their owner. */
  private async activateEnv(env: EnvImpl<any>): Promise<void> {
    const eager = [...new Set(env.plan.slotsByNode.values())]
      .filter((slot): slot is ServiceSlot =>
        slot.kind === 'service' && slot.ownerEnvId === env.id && slot.service.eager)
    await this.materializer.startEagerSlots(eager)
  }

  /**
   * Synchronously moves an Env and all of its descendants to `disposing` and
   * aborts their signals. From this point no Env in the subtree accepts new
   * work (enter/derive/load/recover) and every cooperative setup, worker or
   * cleanup in the subtree has seen the stop signal, before anything is waited
   * for. Idempotent.
   */
  private broadcastClosing(env: AnyEnv): void {
    this.markClosing(env)
    this.abortClosing(env)
  }

  /**
   * The same for several subtrees at once. Both take two passes: every Env of the
   * close set is marked first, and only then are the signals aborted. `abort()` runs
   * user listeners synchronously, so a single depth-first pass that aborted as it
   * descended offered those listeners a subtree that was still `ready` — they could
   * start a dormant Service inside the very set being closed (its `setup()` really
   * ran, and its late result was discarded afterwards) and add a whole grace period
   * to a close whose bound is computed from the tree as it stood when the close
   * began. Marking first closes the set before any of it runs.
   */
  private broadcastClosingAll(envs: readonly AnyEnv[]): void {
    for (const env of envs) this.markClosing(env)
    for (const env of envs) this.abortClosing(env)
  }

  /** First pass: the subtree refuses new work. Runs no user code, so nothing can observe it half done. */
  private markClosing(env: AnyEnv): void {
    if (env.state === 'disposed' || env.attemptOwner.closing) return
    env.state = 'disposing'
    env.attemptOwner.closing = true
    if (env.children.size !== 0) this.markDescendants(env)
  }

  /** Second pass: every signal of the marked set, in the same order. `abort()` is idempotent. */
  private abortClosing(env: AnyEnv): void {
    if (env.state === 'disposed') return
    env.abortController.abort()
    if (env.children.size !== 0) this.abortDescendants(env)
  }

  // Descending is its own step in both passes: closing a leaf Env is the common
  // case and it should not walk an empty child set to find that out.
  private markDescendants(env: AnyEnv): void {
    for (const child of env.children) this.markClosing(child)
  }

  private abortDescendants(env: AnyEnv): void {
    for (const child of env.children) this.abortClosing(child)
  }

  /**
   * Closing order: refuse new work and broadcast cancellation to the whole
   * subtree, wait for descendants (concurrently: sibling subtrees are
   * independent), give owned attempts the disposal grace period, then dispose
   * owned Ready slots dependant-first over the SCC condensation.
   *
   * That much is bounded by the grace period, and at its end the close is
   * complete: the Env leaves the tree and the Runtime's registries and its
   * state is `disposed`, whatever is still pending. An attempt that ignored the
   * stop signal past the grace is abandoned — reported by `attempt-abandoned`,
   * listed in `inspect().unsettledAttempts` and in this Env's
   * `inspect().abandonedAttempts` until it settles late or is found
   * unreachable — and is kept alive only by the user's own pending setup
   * Promise. dispose() rejects only for errors of the close itself (a cleanup
   * that threw).
   */
  async disposeEnv(env: EnvImpl<any>): Promise<void> {
    if (env.state === 'disposed') return
    // The broadcast below runs user abort listeners, and one of them can call
    // `dispose()` again: this close is already under way, so that caller joins it
    // (see `EnvImpl.dispose()`) instead of starting a second one over the same slots.
    if (env.closing) return env.joinClose()
    env.closing = true
    this.broadcastClosing(env)

    const children = [...env.children]
    const errors: unknown[] = (await Promise.allSettled(children.map(child => child.dispose())))
      .flatMap(result => (result.status === 'rejected' ? [result.reason] : []))

    const ownedServiceSlots = [...new Set(env.plan.slotsByNode.values())]
      .filter((slot): slot is ServiceSlot => slot.kind === 'service' && slot.ownerEnvId === env.id)

    await this.materializer.settleSlots(ownedServiceSlots)
    errors.push(...await this.materializer.disposeServiceSlots(ownedServiceSlots))
    // Every cleanup failure this close waited for, once: the rollbacks of
    // attempts that settled inside the grace (whose waiters may have left long
    // ago) next to the cleanups of the Ready slots it disposed.
    errors.push(...env.attemptOwner.closeErrors.splice(0))

    // One indexed pass, not two `for…of` walks: this is the hot close path, where
    // an array iterator costs an allocation per owned slot. A slot that never
    // started ends `disposed`, and the Env stops being anyone's owner — an owned
    // slot that outlives the close (an abandoned attempt, a cleanup phase that is
    // still running, a waiter whose deadline has not passed yet) must not reach
    // the Env through `slot.ownerEnv`: §13's "nothing in the Runtime retains its
    // graph". Nothing starts on such a slot again: every one of them is `disposed`
    // or `abandoned`.
    for (let index = 0; index < ownedServiceSlots.length; index += 1) {
      const slot = ownedServiceSlots[index]!
      if (slot.state === 'dormant' || slot.state === 'failed') slot.state = 'disposed'
      slot.ownerEnv = undefined
    }

    this.detachEnv(env)
    env.state = 'disposed'

    if (errors.length > 0) {
      throw new AggregateError(errors, `Env ${env.id} failed to dispose cleanly.`)
    }
  }

  /** Bounded close complete: the Runtime forgets the Env. */
  private detachEnv(env: EnvImpl<any>): void {
    env.parent?.children.delete(env)
    this.roots.delete(env)
    this.envById.delete(env.id)
  }
}

/**
 * Missing parameters reported by a planning failure, wherever they occur: the
 * Entry's own declared-but-unprovided parameters (`details.missingInputs` /
 * `missingBindings`), a requirement deep inside the graph (`MISSING_INPUT` /
 * `MISSING_BINDING` with `details.missing`), or the same inside the per-candidate
 * failures of an `UNSATISFIABLE_TOPOLOGY` report.
 */
function collectMissingParameters(
  code: string,
  details: Readonly<Record<string, unknown>>,
): { readonly inputs: readonly string[]; readonly bindings: readonly string[] } {
  const inputs = new Set<string>()
  const bindings = new Set<string>()
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const visit = (nodeCode: string, nodeDetails: Readonly<Record<string, unknown>>): void => {
    const declared = Array.isArray(nodeDetails.missingInputs) || Array.isArray(nodeDetails.missingBindings)
    for (const id of strings(nodeDetails.missingInputs)) inputs.add(id)
    for (const id of strings(nodeDetails.missingBindings)) bindings.add(id)
    // Deep requirements (raised by the graph builder) carry the id under `missing` only.
    if (!declared && nodeCode === 'MISSING_INPUT') for (const id of strings(nodeDetails.missing)) inputs.add(id)
    if (!declared && nodeCode === 'MISSING_BINDING') for (const id of strings(nodeDetails.missing)) bindings.add(id)
    for (const failure of Array.isArray(nodeDetails.failures) ? nodeDetails.failures : []) {
      if (typeof failure !== 'object' || failure === null) continue
      const nested = failure as { code?: unknown; details?: unknown }
      if (typeof nested.code !== 'string') continue
      visit(nested.code, (typeof nested.details === 'object' && nested.details !== null ? nested.details : {}) as Readonly<Record<string, unknown>>)
    }
  }
  visit(code, details)
  return { inputs: [...inputs].sort(), bindings: [...bindings].sort() }
}

export function createRuntime(options: CreateRuntimeOptions): Runtime {
  return new RuntimeImpl(options)
}
