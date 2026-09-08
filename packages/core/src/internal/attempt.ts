// One execution of a Service's `setup()`, and the small operations on it that need
// nothing else: how its raw phase can end, the race that observes that end, and the
// handles a listed attempt lets go of so that nothing it keeps outlives its Env (§13).
import type { Awaitable, ServiceLifecycle } from '../descriptors.js'
import { SynaError } from '../errors.js'
import type {
  AttemptCleanupPhase,
  AttemptOwnerRecord,
  PendingLoad,
  ServiceSlot,
  SetupAttempt,
} from './runtime-model.js'

/** How an attempt's raw setup ended, when what follows is a cleanup phase. */
export type RollbackReason = 'unreachable' | 'failed' | 'discarded'

/** The rollback of one attempt, handed to the sequence so it can go on without waiting in a frame of its own. */
export interface RollbackOutcome {
  readonly kind: 'rollback'
  readonly attempt: SetupAttempt
  readonly phase: AttemptCleanupPhase
  readonly reason: RollbackReason
  /** The raw rejection, for `reason: 'failed'`. */
  readonly error: unknown
  /** Whether the owner had already begun closing when the raw setup settled (`reason: 'discarded'`). */
  readonly ownerClosed: boolean
}

/**
 * The end of one attempt's raw phase — everything up to and including the
 * settlement of the user's setup Promise. A rollback is never awaited here: it is
 * returned as a task the sequence attaches to (see `runSequence`).
 */
export type RawOutcome =
  | { readonly kind: 'ok'; readonly instance: unknown }
  /** The owner's close stopped waiting for the raw Promise; no cleanup of this attempt runs here. */
  | { readonly kind: 'unsettled'; readonly error: unknown }
  | RollbackOutcome

export type RaceResult =
  | { readonly kind: 'resolved'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'abandoned' }
  | { readonly kind: 'unreachable' }

export function isForeignThenable(value: unknown): boolean {
  if (value instanceof Promise) return false
  if (typeof value !== 'object' && typeof value !== 'function') return false
  if (value === null) return false
  return typeof (value as { then?: unknown }).then === 'function'
}

/**
 * Settles with the raw result, with `abandoned` when disposal stops waiting
 * first, or with `unreachable` when the raw Promise was garbage-collected
 * unsettled first. Whichever comes first wins; the raw Promise itself is never
 * cancelled. No deadline runs here: the deadline belongs to each waiter. The
 * early ends come in through `attempt.endRace`, so the race allocates nothing
 * but its own Promise and the two reactions on the raw one (which also observe
 * a rejection: the Runtime leaves none unhandled). Nothing returned here
 * references the raw Promise.
 */
export function raceAttempt(promise: Promise<unknown>, attempt: SetupAttempt): Promise<RaceResult> {
  // The reactions close over the resolver alone: a closure that mentioned
  // `promise` would keep it reachable through `attempt.endRace` for as long as
  // the attempt lives, and the unreachable diagnosis could never fire.
  let resolve!: (result: RaceResult) => void
  const race = new Promise<RaceResult>(settle => { resolve = settle })
  attempt.endRace = kind => resolve({ kind })
  promise.then(
    value => resolve({ kind: 'resolved', value }),
    error => resolve({ kind: 'rejected', error }),
  )
  return race
}

/**
 * One execution of `setup()` (see `SetupAttempt`). Every instance has the same
 * shape; `settled` is created only when something waits for it, and the race's
 * early end is a function on the attempt rather than a Promise per outcome.
 */
export class Attempt implements SetupAttempt {
  readonly startedAt = Date.now()
  state: SetupAttempt['state'] = 'running'
  overdueAt?: number
  readonly cleanups: Array<() => Awaitable<void>> = []
  readonly pendingLoads = new Map<number, PendingLoad>()
  rawSettled = false
  raw: Promise<unknown> | undefined = undefined
  rawRef?: WeakRef<Promise<unknown>>
  slot: ServiceSlot | undefined
  slotRef?: WeakRef<ServiceSlot>
  readonly slotId: string
  readonly revisionKey: string
  endRace: ((kind: 'abandoned' | 'unreachable') => void) | undefined = undefined
  watched = false
  reportsToClose = true
  private isSettled = false
  private settledPromise: Promise<void> | undefined = undefined
  private resolveSettledPromise: (() => void) | undefined = undefined

  constructor(readonly id: number, slot: ServiceSlot, readonly owner: AttemptOwnerRecord) {
    this.slot = slot
    this.slotId = slot.id
    this.revisionKey = slot.service.key
  }

  get settled(): Promise<void> {
    if (this.isSettled) return Promise.resolve()
    return (this.settledPromise ??= new Promise<void>(resolve => { this.resolveSettledPromise = resolve }))
  }

  resolveSettled(): void {
    this.isSettled = true
    this.resolveSettledPromise?.()
  }
}

/**
 * The lifecycle handed to one `setup()`. Built here rather than inside
 * `runAttempt` so that the object the user's own frame keeps — for as long as
 * that setup is pending — reaches the attempt and two strings, never the slot
 * and never the Env behind it.
 */
export function createLifecycle(attempt: SetupAttempt, signal: AbortSignal): ServiceLifecycle {
  return {
    signal,
    onDispose: cleanup => {
      if (typeof cleanup !== 'function') {
        throw new TypeError('onDispose() expects a cleanup function.')
      }
      // Accepted for as long as this attempt's setup is still executing, which
      // includes the time after its deadline passed or its owner closed: the
      // resource acquired late is exactly the one the late-settlement cleanup
      // must release. Refused once the raw Promise settled (stale lifecycle).
      if (attempt.rawSettled || attempt.state === 'succeeded' || attempt.state === 'failed') {
        throw new SynaError(
          'LIFECYCLE_MISUSE',
          `onDispose() for ${attempt.revisionKey} may only be called while its setup attempt is still executing.`,
          { slot: attempt.slotId, revision: attempt.revisionKey, attemptNumber: attempt.id, state: attempt.state },
        )
      }
      attempt.cleanups.push(cleanup)
    },
  }
}

/** The slot of an attempt: strong while it runs off the ledger, weak once it is listed, gone once its Env was collected. */
export function slotOf(attempt: SetupAttempt): ServiceSlot | undefined {
  return attempt.slot ?? attempt.slotRef?.deref()
}

/**
 * Leaves a listed attempt with a weak handle on its slot (created here, on
 * this rare path, never per attempt), so that from now on nothing the Runtime
 * holds keeps the owner Env's graph alive.
 */
export function releaseSlot(attempt: SetupAttempt): void {
  const slot = attempt.slot
  if (!slot) return
  attempt.slotRef = new WeakRef(slot)
  attempt.slot = undefined
}

/**
 * Hands out the raw Promise of an attempt that is being listed and leaves the
 * attempt with a weak handle only (created here, on this rare path, never per
 * attempt). Undefined when the attempt was listed before and the Promise has
 * been collected since.
 */
export function releaseRaw(attempt: SetupAttempt): Promise<unknown> | undefined {
  const rawPromise = attempt.raw
  if (rawPromise) {
    attempt.rawRef = new WeakRef(rawPromise)
    attempt.raw = undefined
    return rawPromise
  }
  return attempt.rawRef?.deref()
}

/** The sequence ends with a failure: the slot records it, if the slot is still there, and the sequence rejects. */
export function endSequence(slot: ServiceSlot | undefined, error: unknown, reject: (error: unknown) => void): void {
  if (slot) {
    if (slot.state === 'starting') {
      slot.error = error
      slot.failedAt = Date.now()
      slot.state = 'failed'
    }
    delete slot.attempt
  }
  reject(error)
}
