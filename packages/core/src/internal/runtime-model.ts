import type {
  Awaitable,
  Binding,
  CandidateRef,
  Contract,
  Dependency,
  DescriptorMetadata,
  Entry,
  ForkCause,
  Input,
  NormalizedServiceFailurePolicy,
  RuntimePolicyContext,
  ServiceFamily,
  ServiceRevision,
  SlotState,
} from '../descriptors.js'
import type { LabeledGraphNode } from '../graph.js'

/** The context handed to Runtime policies: the dependency site being resolved and the parent lineage's active revisions. */
export class PolicyContext implements RuntimePolicyContext {
  constructor(
    readonly dependencySite: string,
    readonly parentActiveRevisionIds: ReadonlySet<string>,
  ) {}
}

export type EnvState = 'activating' | 'ready' | 'disposing' | 'disposed'

export type NodeKind = 'service' | 'input' | 'binding' | 'all-implementations' | 'entry'

/**
 * Internal executable record for one nominal Service revision. Public code
 * only ever sees the `source` descriptor; an override replaces the executable
 * half without creating a second public identity.
 */
export interface CompiledService {
  readonly key: string
  readonly family: ServiceFamily
  readonly version: string
  readonly source: ServiceRevision
  readonly provides: readonly Contract[]
  readonly eager: boolean
  readonly requires: DependencyMap
  readonly setup: ServiceRevision['setup']
  readonly failure: NormalizedServiceFailurePolicy
  readonly loadTimeoutMs: number | undefined
  readonly metadata: Readonly<DescriptorMetadata>
  readonly overriddenBy: ServiceRevision | undefined
  readonly admitted: boolean
}

type DependencyMap = Readonly<Record<string, Dependency>>

/** Authority under which an Entry's roots are resolved. */
export type ResolutionRealm =
  | { readonly kind: 'public'; readonly id: 'public' }
  | {
      readonly kind: 'private-entry'
      readonly id: string
      readonly ownerKey: string
      /** Exact revision keys visible to this realm in addition to public admission. */
      readonly closureKeys: ReadonlySet<string>
    }

export interface RootSite {
  readonly id: string
  readonly entryId: string
  readonly key: string
  readonly dependency: Dependency
  readonly realm: ResolutionRealm
}

/**
 * What an attempt keeps of its owner: identity, whether the owner's close has
 * begun, and the cleanup failures that close is waiting for. One record per Env,
 * never the Env itself — an attempt that outlives its owner must not keep the
 * Env's graph (plan, Input slots, sibling slots) alive.
 *
 * Deliberately not the owner's `AbortSignal`: a signal keeps its abort reason,
 * an Error whose structured stack keeps the receiver of every frame it was
 * created in — the Env among them — until someone reads `.stack`. The flag below
 * is what a listed attempt needs; live code takes the signal from the owner
 * itself, and `setup()` still receives it in its lifecycle.
 */
export interface AttemptOwnerRecord {
  readonly envId: string
  /** Set the moment the owner's close begins (before anything is waited for). */
  closing: boolean
  /**
   * Cleanup failures of this Env's attempts that its close waited for, drained
   * once by `disposeEnv()` into the `AggregateError` of `dispose()`. What the
   * close stopped waiting for is not in here: it is reported by an event.
   */
  readonly closeErrors: unknown[]
}

export interface SlotOwnerEnv {
  readonly id: string
  readonly state: EnvState
  readonly abortController: AbortController
  readonly attemptOwner: AttemptOwnerRecord
}

export interface InputSlot {
  readonly kind: 'input'
  readonly id: string
  readonly ownerEnvId: string
  readonly descriptor: Input
  readonly payload: unknown
  readonly state: 'ready'
  readonly requires: ReadonlyMap<string, RuntimeSlot>
}

export interface BindingChoiceSlot {
  readonly id: string
  readonly ownerEnvId: string
  readonly binding: Binding
  readonly revision: CompiledService
}

export interface SyntheticSlot {
  readonly kind: 'binding' | 'all-implementations' | 'entry'
  readonly id: string
  readonly ownerEnvId: string
  readonly state: 'ready'
  readonly requires: Map<string, RuntimeSlot>
  value?: unknown
}

export interface PendingLoad {
  readonly target: ServiceSlot
  readonly since: number
}

/**
 * One `load()` wait on a slot that is not Ready. The setup deadline is the
 * waiter's: it is armed while an attempt is running (re-armed when a new
 * attempt of the same sequence starts, cleared between attempts) and ends
 * only this wait with `LOAD_TIMEOUT`; the attempt keeps running.
 * Armed waiters sit in one deadline queue (a list sorted by expiry behind a
 * single timer), so a wait costs no timer of its own.
 */
export interface SetupWaiter {
  readonly id: number
  readonly slot: ServiceSlot
  /** Ends the wait; no-op after the first call. */
  readonly settle: (outcome: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }) => void
  /** Called by the deadline queue once `expiresAt` has passed while the waiter was still queued. */
  readonly onDeadline: (waiter: SetupWaiter) => void
  /** The attempt the deadline is measured against and its length; set when armed. */
  attempt: SetupAttempt | undefined
  deadlineMs: number
  /** Position in the deadline queue while armed (`queued`): the expiry, and the neighbours in expiry order. */
  expiresAt: number
  queued: boolean
  prev: SetupWaiter | undefined
  next: SetupWaiter | undefined
}

/**
 * The cleanup phase of an attempt or of a Ready slot, run as a task of its own
 * (`materializer.ts`). Its failures are recorded the moment each cleanup ends, so
 * a failure that is already determined is never hidden by a later cleanup of the
 * same phase that hangs; and it holds its slot and owner Env strongly only while
 * the close is still waiting for it, so a phase that outlives that close keeps no
 * Env graph alive.
 */
export interface AttemptCleanupPhase {
  /** Failures determined so far and not yet handed to a close, in the order they happened. */
  readonly errors: readonly DisposableError[]
  /** Whether any cleanup of this phase failed, whoever ended up reporting it. */
  readonly failed: boolean
  /** Resolves when every cleanup of the phase has ended. Never rejects. */
  readonly done: Promise<void>
  /** Strong while the close still waits for the phase, weak (and possibly gone) afterwards. */
  readonly slot: ServiceSlot | undefined
  readonly owner: SlotOwnerEnv | undefined
  /** Hands out the failures determined so far and takes them out of the phase, so a later report lists only later ones. */
  take(): readonly DisposableError[]
  /** The close stops waiting: from here the phase keeps its slot and owner only weakly. */
  release(): void
}

/** One actual execution of `setup()` for a slot. Waiters join it; it never runs concurrently with another attempt of the same slot. */
export interface SetupAttempt {
  readonly id: number
  /**
   * The slot this attempt belongs to, held strongly only while the attempt runs
   * off the ledger. The moment it is listed the reference is swapped for
   * `slotRef`: an attempt that outlives its owner must not keep the Env's graph
   * (plan, Input slots, sibling slots) alive through its slot.
   */
  slot: ServiceSlot | undefined
  /** Weak handle on the slot of a listed attempt (see `slot`). */
  slotRef?: WeakRef<ServiceSlot>
  /** Identity of the slot, for reports and diagnostics after the slot itself may be gone. */
  readonly slotId: string
  readonly revisionKey: string
  readonly startedAt: number
  /**
   * `running` covers an overdue attempt as well (`overdueAt` set): a waiter's
   * deadline never changes the attempt. `abandoned`: the owner Env closed while
   * the raw setup Promise was pending; the attempt then lives on as
   * `slot.unsettledAttempt` until that Promise settles.
   */
  state: 'running' | 'succeeded' | 'failed' | 'abandoned'
  /** When the first waiter on this attempt timed out; the attempt is overdue from then on. */
  overdueAt?: number
  readonly cleanups: Array<() => Awaitable<void>>
  readonly pendingLoads: Map<number, PendingLoad>
  /** True once the user's setup Promise settled (resolved or rejected), however late. */
  rawSettled: boolean
  /** Resolves once the raw setup Promise settled and any orphaned resources were cleaned. */
  readonly settled: Promise<void>
  resolveSettled: () => void
  /**
   * Ends the attempt's race early while it is pending: disposal gave up waiting
   * for the raw Promise (`abandoned`), or that Promise was garbage-collected
   * unsettled (`unreachable`). Set by the race; a no-op once the race ended.
   */
  endRace: ((kind: 'abandoned' | 'unreachable') => void) | undefined
  /**
   * The user's raw setup Promise, held only while the attempt runs off the
   * ledger. The moment the attempt is listed (overdue or abandoned) it is
   * swapped for `rawRef`, so from then on that Promise's reachability alone
   * bounds how long the attempt can stay open.
   */
  raw: Promise<unknown> | undefined
  /** Weak handle on the raw Promise of a listed attempt (see `raw`). */
  rawRef?: WeakRef<Promise<unknown>>
  /** The raw Promise is registered for the unreachable diagnosis (once per attempt). */
  watched: boolean
  /** The minimal record of the Env that owns this attempt's slot. */
  readonly owner: AttemptOwnerRecord
  /**
   * The cleanup phase running for this attempt, while one is: the rollback of a
   * failed or discarded setup, or the late close of an attempt that settled after
   * its owner. A close that stops waiting for the attempt takes the failures the
   * phase has already determined and tells it to let go of the Env.
   */
  cleanupPhase?: AttemptCleanupPhase
  /**
   * Whether a cleanup failure of this attempt still belongs to its owner's
   * close. False from the moment that close stopped waiting for the attempt: its
   * late failures are reported by an event, never by a `dispose()` that returned.
   */
  reportsToClose: boolean
}

export interface ServiceSlot {
  readonly kind: 'service'
  readonly id: string
  readonly ownerEnvId: string
  readonly service: CompiledService
  readonly requires: Map<string, RuntimeSlot>
  /**
   * Set to `undefined` — never `delete`d, which would move a hot slot into
   * dictionary mode — when the owner Env's bounded close completes: from then on
   * the slot reaches no Env.
   */
  ownerEnv?: SlotOwnerEnv | undefined
  state: SlotState
  instance?: unknown
  error?: unknown
  failedAt?: number
  /** The attempt currently running, if any. */
  attempt?: SetupAttempt
  /** Result promise of the current or last setup sequence; waiters join it. */
  sequence?: Promise<unknown>
  /** Every `load()` currently waiting on this slot, each with its own deadline. */
  readonly waiters: Set<SetupWaiter>
  /** An abandoned attempt whose raw Promise has not settled yet (the owner closed). Blocks new attempts. */
  unsettledAttempt?: SetupAttempt
  /**
   * A rollback (attempt cleanup or late-settlement cleanup) of this slot failed:
   * resources it acquired are outside Syna control. Permanent — no policy may
   * start another attempt that would stack on top of them.
   */
  rollbackFailed?: boolean
  recovery?: Promise<unknown>
  cleanups: Array<() => Awaitable<void>>
  completionOrder?: number
  attemptCount: number
  /** The attempt that produced `instance`: the number an abandoned cleanup of this slot is listed under. */
  instanceAttemptId?: number
}

export type RuntimeSlot = InputSlot | SyntheticSlot | ServiceSlot

export interface BasePlanNode extends LabeledGraphNode {
  readonly kind: NodeKind
  readonly edges: Map<string, string>
}

export interface ServicePlanNode extends BasePlanNode {
  readonly kind: 'service'
  readonly revision: CompiledService
}

export interface InputPlanNode extends BasePlanNode {
  readonly kind: 'input'
  readonly descriptor: Input
}

export interface BindingPlanNode extends BasePlanNode {
  readonly kind: 'binding'
  readonly binding: Binding
  readonly revision: CompiledService
}

/** Every candidate is a real dependency in the current Env. */
export interface AllPlanNode extends BasePlanNode {
  readonly kind: 'all-implementations'
  readonly contract: Contract
  readonly candidates: readonly CompiledService[]
}

export interface AnchoredEntryPlanNode extends BasePlanNode {
  readonly kind: 'entry'
  readonly entry: Entry
  readonly dependencySite: string
  readonly anchorNodeId?: string
  readonly realm: ResolutionRealm
}

export type PlanNode =
  | ServicePlanNode
  | InputPlanNode
  | BindingPlanNode
  | AllPlanNode
  | AnchoredEntryPlanNode

export interface NodeExplanation {
  readonly placement: 'reused' | 'new' | 'forked'
  readonly cause: ForkCause | undefined
}

export interface ResolvedPlan {
  readonly nodes: Map<string, PlanNode>
  readonly rootNodeBySite: Map<string, string>
  readonly slotsByNode: Map<string, RuntimeSlot>
  readonly rootSites: readonly RootSite[]
  readonly inputSlots: ReadonlyMap<string, InputSlot>
  readonly bindingChoices: ReadonlyMap<string, BindingChoiceSlot>
  readonly choices: ReadonlyMap<string, string>
  /** Lineage-unique family → anchored slot (persists through Envs that do not use the family). */
  readonly anchors: ReadonlyMap<string, ServiceSlot>
  readonly explanations: ReadonlyMap<string, NodeExplanation>
  readonly signature: string
  readonly lineageKey: string
  readonly envId: string
  readonly checking: boolean
}

export interface EnvPlanView {
  readonly plan: ResolvedPlan
  readonly parent: EnvPlanView | undefined
}

export interface NeedChoiceData {
  readonly site: string
  readonly candidates: readonly CompiledService[]
  readonly description: string
}

export class NeedChoice extends Error {
  readonly data: NeedChoiceData
  constructor(data: NeedChoiceData) {
    super(`A resolution choice is required at ${data.site}.`)
    this.name = 'NeedChoice'
    this.data = data
  }
}

export interface GraphBuildResult {
  readonly nodes: Map<string, PlanNode>
  readonly rootNodeBySite: Map<string, string>
}

export interface ScopeTargetSet {
  readonly revisionKeys: ReadonlySet<string>
  readonly familyIds: ReadonlySet<string>
}

export interface PlanEntryParameters {
  readonly envId: string
  readonly checking: boolean
  readonly realm: ResolutionRealm
  readonly lineageKey: string
  readonly parent?: EnvPlanView
  readonly rootSites: readonly RootSite[]
  readonly inputSlots: ReadonlyMap<string, InputSlot>
  readonly providedInputIds: ReadonlySet<string>
  readonly bindingChoices: ReadonlyMap<string, BindingChoiceSlot>
  readonly changedBindingIds: ReadonlySet<string>
  readonly inheritedChoices: ReadonlyMap<string, string>
  readonly fresh: ScopeTargetSet
  readonly share: ScopeTargetSet
}

export interface InternalCandidateRef extends CandidateRef<any> {
  readonly sourceSlotId: string
  readonly revisionKey: string
}

export interface DisposableError {
  readonly slot: string
  readonly error: unknown
}
