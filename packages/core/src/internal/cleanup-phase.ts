// One cleanup phase — the cleanups of a failed or discarded attempt, of an attempt
// that settled after its owner closed, or of a Ready slot being disposed. A phase is a
// task rather than an `await` in its caller's frame, so that a failure it has already
// determined belongs to the close that waited for it however long the rest hangs (§13).
import type { Awaitable } from '../descriptors.js'
import type { RollbackOutcome, RollbackReason } from './attempt.js'
import type {
  AttemptCleanupPhase,
  DisposableError,
  ServiceSlot,
  SetupAttempt,
  SlotOwnerEnv,
} from './runtime-model.js'

/**
 * One cleanup phase: the cleanups of a failed or discarded attempt, of an attempt
 * that settled after its owner closed, or of a Ready slot being disposed.
 *
 * Two things make it a task rather than an `await` in its caller's frame. Its
 * failures are recorded the moment each cleanup ends, so a failure that is
 * already determined never disappears behind a later cleanup of the same phase
 * that hangs — `take()` hands a close what is determined so far, and whatever
 * comes afterwards is the late report's. And it holds its slot and its owner Env
 * strongly only while the close is still waiting for it: `release()` swaps both
 * for weak handles, so a phase that outlives its close keeps no Env graph alive.
 * An `async` frame suspended on a hung cleanup would keep `slot` and `owner` in
 * its register file whether or not it still uses them, and `slot.ownerEnv` is the
 * whole graph behind them (§13).
 */
export class CleanupPhase implements AttemptCleanupPhase {
  readonly errors: DisposableError[] = []
  failed = false
  readonly done: Promise<void>
  private strongSlot: ServiceSlot | undefined
  private weakSlot: WeakRef<ServiceSlot> | undefined
  private strongOwner: SlotOwnerEnv | undefined
  private weakOwner: WeakRef<SlotOwnerEnv> | undefined

  constructor(
    slot: ServiceSlot | undefined,
    owner: SlotOwnerEnv | undefined,
    run: (record: (failure: DisposableError) => void) => Promise<void>,
  ) {
    this.strongSlot = slot
    this.strongOwner = owner
    this.done = run(this.record)
  }

  get slot(): ServiceSlot | undefined { return this.strongSlot ?? this.weakSlot?.deref() }

  get owner(): SlotOwnerEnv | undefined { return this.strongOwner ?? this.weakOwner?.deref() }

  private readonly record = (failure: DisposableError): void => {
    this.failed = true
    this.errors.push(failure)
  }

  take(): readonly DisposableError[] {
    return this.errors.splice(0)
  }

  release(): void {
    if (this.strongSlot !== undefined) {
      this.weakSlot = new WeakRef(this.strongSlot)
      this.strongSlot = undefined
    }
    if (this.strongOwner !== undefined) {
      this.weakOwner = new WeakRef(this.strongOwner)
      this.strongOwner = undefined
    }
  }
}

/**
 * Runs cleanups in reverse registration order; every cleanup runs even if an
 * earlier one throws, and every failure is recorded the moment it happens rather
 * than when the phase ends — a failure that is already determined must not
 * disappear behind a later cleanup of the same phase that hangs. A method of its
 * own, so the frame suspended on a hung cleanup holds the cleanup list, a slot id
 * and the recorder, never the slot or the Env behind it.
 */
export async function runCleanups(
  cleanups: Array<() => Awaitable<void>>,
  slotId: string,
  record: (failure: DisposableError) => void,
): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() }
    catch (error) { record({ slot: slotId, error }) }
  }
}

/** Starts one cleanup phase as a task of its own (see `CleanupPhase`). */
export function startCleanupPhase(
  cleanups: Array<() => Awaitable<void>>,
  slotId: string,
  slot: ServiceSlot | undefined,
  owner: SlotOwnerEnv | undefined,
): CleanupPhase {
  return new CleanupPhase(slot, owner, record => runCleanups(cleanups, slotId, record))
}

/**
 * Starts the cleanup phase of an attempt whose setup has settled and hands it to
 * the sequence. The phase is a task: `runAttemptRaw` returns here, so nothing is
 * suspended on cleanups that may never end.
 */
export function startRollback(
  attempt: SetupAttempt,
  slot: ServiceSlot,
  owner: SlotOwnerEnv,
  reason: RollbackReason,
  error: unknown,
  ownerClosed: boolean,
): RollbackOutcome {
  const phase = startCleanupPhase(attempt.cleanups, slot.id, slot, owner)
  attempt.cleanupPhase = phase
  return { kind: 'rollback', attempt, phase, reason, error, ownerClosed }
}

/**
 * A cleanup failure of an attempt whose owner is closing belongs to that
 * close: it enters `dispose()`'s AggregateError exactly once, whether or not a
 * waiter is still there to see the rejection of its own `load()`. Failures of
 * an attempt the close stopped waiting for are reported by an event instead.
 */
export function attributeToClose(attempt: SetupAttempt, cleanupErrors: readonly unknown[]): void {
  if (cleanupErrors.length === 0 || !attempt.reportsToClose || !attempt.owner.closing) return
  attempt.owner.closeErrors.push(new AggregateError(
    [...cleanupErrors],
    `Rollback of ${attempt.revisionKey} failed while owner Env ${attempt.owner.envId} was closing.`,
  ))
}

/**
 * The close stops waiting for an attempt's cleanup phase. The failures the phase
 * has already determined stay with the close — they happened while it was still
 * waiting — and the phase lets go of the Env from here on.
 */
export function abandonCleanupPhase(attempt: SetupAttempt): void {
  const phase = attempt.cleanupPhase
  // Only the close that is still waiting for the phase may take from it: once it
  // has stopped, later failures are the late report's and must stay in the phase.
  if (!phase || !attempt.reportsToClose || !attempt.owner.closing) return
  const determined = phase.take()
  if (determined.length > 0) attributeToClose(attempt, determined.map(item => item.error))
  phase.release()
}
