// The ledger of everything the Runtime stopped waiting for, and what happens to it
// afterwards: the late settlement of an abandoned attempt, the unreachable diagnosis,
// and the reports a bounded close owes when it gives up (§13).
import type { RuntimeEvent, UnsettledAttemptInspection } from '../descriptors.js'
import { settlesWithin } from './abort.js'
import { releaseRaw, releaseSlot, slotOf } from './attempt.js'
import { attributeToClose, startCleanupPhase } from './cleanup-phase.js'
import type {
  AttemptCleanupPhase,
  ServiceSlot,
  SetupAttempt,
} from './runtime-model.js'

/**
 * Ledger entry for something the Runtime stopped waiting for: an attempt whose
 * raw Promise is pending after a waiter's deadline (`overdue`: the attempt is
 * overdue and still running under a live owner) or after its owner's close
 * (`abandoned`), an attempt whose setup ended but whose rollback outlived the
 * close (`rolling-back`), one whose late result is being cleaned up
 * (`settling`), or the cleanup phase of a Ready slot that outlived its own
 * budget (`abandoned`, with no attempt of its own: `attempt-abandoned` reports
 * it with `phase: 'cleanup'`). The record holds the attempt strongly, and that
 * retains nothing beyond the documented bound: a listed attempt holds the
 * user's raw Promise only weakly, so that Promise's reachability alone decides
 * how long the record lives — when the Promise is collected the attempt is
 * closed as unreachable and the record dropped. (A weak reference here let the
 * attempt die in the same collection as the Promise, so nothing was left to run
 * its cleanups when the unreachable path fired.)
 */
export interface UnsettledRecord {
  readonly id: number
  /** Absent for an abandoned cleanup: nothing is executing a `setup()` there. */
  readonly attempt: SetupAttempt | undefined
  readonly slot: string
  readonly revision: string
  readonly env: string
  readonly startedAt: number
  state: UnsettledAttemptInspection['state']
  /** The close in progress once the attempt settled late or was found unreachable. */
  closing?: Promise<void>
}

/** What the finalization registry hands back: the attempt itself, so the unreachable close can run its cleanups. */
interface UnreachableToken {
  readonly id: number
  readonly attempt: SetupAttempt
}

/**
 * Every attempt the Runtime is still waiting on, and the machinery that ends one:
 * the record, the finalization watch on the user's raw Promise, the late close and
 * the reports. Nothing here holds an Env: a listed attempt keeps its slot weakly
 * (`releaseSlot`) and the user's Promise weakly (`releaseRaw`), so a record lives
 * exactly as long as the work it names.
 */
export class AttemptLedger {
  private nextAttemptId = 1
  private readonly unsettled = new Map<number, UnsettledRecord>()
  /**
   * Fires when the raw setup Promise of an overdue or abandoned attempt is
   * garbage-collected: nothing can settle it any more, so the attempt is closed
   * as failed (its registered cleanups run) instead of staying pending forever.
   */
  private readonly unreachable = new FinalizationRegistry<UnreachableToken>(token => this.attemptUnreachable(token))

  constructor(private readonly onEvent: (event: RuntimeEvent) => void) {}

  /** The id of the next attempt, or of a cleanup phase listed without one. */
  nextId(): number {
    return this.nextAttemptId++
  }

  /** The record of an attempt, while it is listed. */
  recordOf(id: number): UnsettledRecord | undefined {
    return this.unsettled.get(id)
  }

  /** The unreachable diagnosis no longer applies: the raw Promise has settled. */
  unwatch(attempt: SetupAttempt): void {
    this.unreachable.unregister(attempt)
  }

  view(include: (record: UnsettledRecord) => boolean): readonly UnsettledAttemptInspection[] {
    const now = Date.now()
    const views: UnsettledAttemptInspection[] = []
    for (const record of this.unsettled.values()) {
      if (!include(record)) continue
      views.push(Object.freeze({
        attemptNumber: record.id,
        slot: record.slot,
        revision: record.revision,
        env: record.env,
        state: record.state,
        elapsedMs: now - record.startedAt,
      }))
    }
    return Object.freeze(views)
  }

  /**
   * Waits, up to `graceMs`, for the attempts whose late close (the cleanups
   * after a late result or an unreachable Promise) is in progress; whatever is
   * still outstanding afterwards stays in the ledger for the caller to report.
   */
  async awaitSettling(graceMs: number): Promise<void> {
    const closing = [...this.unsettled.values()].flatMap(record => (record.closing ? [record.closing] : []))
    if (closing.length > 0) await settlesWithin(Promise.all(closing), graceMs)
  }

  registerUnsettled(
    attempt: SetupAttempt,
    envId: string,
    state: 'overdue' | 'abandoned',
  ): UnsettledRecord {
    const existing = this.unsettled.get(attempt.id)
    if (existing && existing.attempt === attempt) {
      existing.state = state
      return existing
    }
    const record: UnsettledRecord = {
      id: attempt.id,
      attempt,
      slot: attempt.slotId,
      revision: attempt.revisionKey,
      env: envId,
      startedAt: attempt.startedAt,
      state,
    }
    this.unsettled.set(attempt.id, record)
    releaseSlot(attempt)
    return record
  }

  /**
   * The attempt's first waiter timed out: it is overdue, listed as `overdue`
   * while it keeps running under its live owner. From now on it holds the raw
   * Promise only weakly, so that Promise's reachability bounds the record.
   */
  registerOverdue(attempt: SetupAttempt, envId: string): void {
    this.registerUnsettled(attempt, envId, 'overdue')
    const rawPromise = releaseRaw(attempt)
    if (rawPromise) this.watch(attempt, rawPromise)
    else attempt.endRace?.('unreachable')
  }

  /**
   * Registers the raw Promise for the unreachable diagnosis, once per attempt.
   * The held value keeps the attempt reachable until the raw Promise is
   * collected; the attempt holds that Promise only weakly, so this never delays
   * its collection.
   */
  private watch(attempt: SetupAttempt, rawPromise: Promise<unknown>): void {
    if (attempt.watched) return
    attempt.watched = true
    this.unreachable.register(rawPromise, { id: attempt.id, attempt }, attempt)
  }

  /**
   * Watches the raw Promise of an abandoned attempt for its late settlement.
   * A method of its own, so the reactions the pending Promise keeps close over
   * the attempt and an id string — never over `runAttempt`'s scope, which holds
   * the slot, the owner Env and the dependency refs.
   */
  watchLateSettlement(attempt: SetupAttempt, rawPromise: Promise<unknown>): void {
    const envId = attempt.owner.envId
    this.watch(attempt, rawPromise)
    rawPromise.then(
      () => this.handleLateSettlement(attempt, envId, undefined),
      lateError => this.handleLateSettlement(attempt, envId, { error: lateError }),
    )
  }

  /** A failed or discarded attempt whose rollback outlived the disposal grace: listed until the rollback ends. */
  registerRollingBack(attempt: SetupAttempt, slot: ServiceSlot): void {
    const record: UnsettledRecord = {
      id: attempt.id,
      attempt,
      slot: slot.id,
      revision: slot.service.key,
      env: slot.ownerEnvId,
      startedAt: attempt.startedAt,
      state: 'rolling-back',
    }
    this.unsettled.set(attempt.id, record)
    releaseSlot(attempt)
    // The reaction is kept by the attempt's own `settled` Promise: it closes over
    // the record and the attempt, and reaches the slot only weakly.
    void attempt.settled.then(() => {
      if (this.unsettled.get(record.id) === record) this.unsettled.delete(record.id)
      const settled = slotOf(attempt)
      if (settled && settled.state === 'abandoned') settled.state = 'disposed'
    })
  }

  /** Drops the ledger entry of an overdue attempt once it settled; tells whether the attempt was overdue. */
  forgetOverdue(attempt: SetupAttempt): boolean {
    if (attempt.overdueAt === undefined) return false
    const record = this.unsettled.get(attempt.id)
    if (record && record.attempt === attempt) this.unsettled.delete(attempt.id)
    return true
  }

  /** Runs the late close of a ledgered attempt; the record stays listed (as `settling`) until the cleanups are done. */
  settleRecord(
    record: UnsettledRecord,
    attempt: SetupAttempt,
    failure: { readonly error: unknown } | undefined,
    how: 'settled' | 'unreachable',
  ): Promise<void> {
    record.state = 'settling'
    record.closing = this.closeUnsettled(attempt, record.env, failure, how).finally(() => {
      if (this.unsettled.get(record.id) === record) this.unsettled.delete(record.id)
    })
    return record.closing
  }

  private attemptUnreachable({ id, attempt }: UnreachableToken): void {
    const record = this.unsettled.get(id)
    if (!record || record.attempt !== attempt) return
    if (attempt.rawSettled) {
      this.unsettled.delete(id)
      return
    }
    if (attempt.state === 'running') {
      // Overdue under a live owner: the attempt is still racing; the race ends
      // as `unreachable` and the sequence takes the failure path.
      attempt.endRace?.('unreachable')
      return
    }
    void this.settleRecord(record, attempt, undefined, 'unreachable')
  }

  private async handleLateSettlement(
    attempt: SetupAttempt,
    envId: string,
    failure: { readonly error: unknown } | undefined,
  ): Promise<void> {
    this.unreachable.unregister(attempt)
    const record = this.unsettled.get(attempt.id)
    if (record && record.attempt === attempt && record.closing === undefined) {
      await this.settleRecord(record, attempt, failure, 'settled')
      return
    }
    await this.closeUnsettled(attempt, envId, failure, 'settled')
  }

  /**
   * Ends an unsettled attempt: its late result (if any) is discarded, the
   * cleanups it registered run, its slot is released, and the outcome is
   * reported. `unreachable` means the raw Promise was collected unsettled.
   */
  private closeUnsettled(
    attempt: SetupAttempt,
    envId: string,
    failure: { readonly error: unknown } | undefined,
    how: 'settled' | 'unreachable',
  ): Promise<void> {
    attempt.rawSettled = true
    // The slot may be gone with its Env: the cleanups of the attempt run either
    // way, and what is reported comes from the attempt's own record of itself. The
    // phase takes the slot weakly from the start — the attempt is listed by now, so
    // a late cleanup that hangs must keep no Env graph alive (§13). A plain `const
    // slot = …` here would be held by the suspended frame however little the code
    // after the await still used it.
    releaseSlot(attempt)
    const phase = startCleanupPhase(attempt.cleanups, attempt.slotId, slotOf(attempt), undefined)
    phase.release()
    attempt.cleanupPhase = phase
    return phase.done.then(() => this.finishLateClose(attempt, envId, failure, how, phase))
  }

  /** The late close of a listed attempt has run its cleanups: the slot is released and the outcome reported. */
  private finishLateClose(
    attempt: SetupAttempt,
    envId: string,
    failure: { readonly error: unknown } | undefined,
    how: 'settled' | 'unreachable',
    phase: AttemptCleanupPhase,
  ): void {
    // Only what this phase has not already handed to a close that was still waiting.
    const cleanupErrors = phase.take().map(item => item.error)
    delete attempt.cleanupPhase
    attributeToClose(attempt, cleanupErrors)
    const slot = phase.slot
    if (slot) {
      if (slot.unsettledAttempt === attempt) delete slot.unsettledAttempt
      // Resources a late cleanup could not release are outside Syna control from now on.
      if (phase.failed) slot.rollbackFailed = true
      // An abandoned slot has now released everything its attempt acquired.
      if (slot.state === 'abandoned' && slot.unsettledAttempt === undefined) slot.state = 'disposed'
    }
    attempt.resolveSettled()
    if (how === 'unreachable') {
      this.onEvent({
        type: 'attempt-unreachable',
        slot: attempt.slotId,
        revision: attempt.revisionKey,
        env: envId,
        elapsedMs: Date.now() - attempt.startedAt,
        cleanupErrors,
      })
      return
    }
    if (failure) {
      this.onEvent({
        type: 'attempt-failed-late',
        slot: attempt.slotId,
        revision: attempt.revisionKey,
        env: envId,
        error: failure.error,
        cleanupErrors,
      })
    }
    else {
      this.onEvent({
        type: 'attempt-succeeded-late',
        slot: attempt.slotId,
        revision: attempt.revisionKey,
        env: envId,
        adopted: false,
        cleanupErrors,
      })
    }
  }

  reportAbandoned(slot: ServiceSlot, attempt: SetupAttempt): void {
    const record = this.unsettled.get(attempt.id)
    if (record && record.state === 'overdue') record.state = 'abandoned'
    this.reportAbandonment(slot, attempt.rawSettled ? 'rollback' : 'setup', Date.now() - attempt.startedAt)
  }

  /**
   * The one report of a bounded close giving up. The dependency list is
   * materialized here, while the slot is at hand: nothing looks it up later.
   */
  reportAbandonment(slot: ServiceSlot, phase: 'setup' | 'rollback' | 'cleanup', elapsedMs: number): void {
    this.onEvent({
      type: 'attempt-abandoned',
      phase,
      slot: slot.id,
      revision: slot.service.key,
      env: slot.ownerEnvId,
      elapsedMs,
      // The slots it depends on are closed in the normal order regardless (the
      // Runtime cannot revoke an instance it already handed out).
      dependencies: [...slot.requires.entries()]
        .filter((entry): entry is [string, ServiceSlot] => entry[1].kind === 'service')
        .map(([dependency, target]) => ({
          dependency,
          slot: target.id,
          revision: target.service.key,
          state: target.state,
        })),
    })
  }

  /**
   * The close stops waiting for a cleanup phase: the slot is listed as
   * `abandoned` under the attempt that produced the instance, reported with
   * `phase: 'cleanup'`, and its dependencies are disposed regardless. When the
   * cleanup ends late the entry is dropped, and a failure is reported by
   * `attempt-failed-late` — never by the `dispose()` that stopped waiting for it.
   */
  abandonCleanup(
    slot: ServiceSlot,
    phase: AttemptCleanupPhase,
    startedAt: number,
  ): void {
    slot.state = 'abandoned'
    delete slot.instance
    const id = slot.instanceAttemptId ?? this.nextAttemptId++
    const slotId = slot.id
    const revisionKey = slot.service.key
    const envId = slot.ownerEnvId
    const record: UnsettledRecord = {
      id,
      attempt: undefined,
      slot: slotId,
      revision: revisionKey,
      env: envId,
      startedAt,
      state: 'abandoned',
    }
    this.unsettled.set(id, record)
    this.reportAbandonment(slot, 'cleanup', Date.now() - startedAt)
    // The reaction is kept by the cleanup that outlived the close: like a listed
    // attempt, it reaches its slot only weakly from here on.
    phase.release()
    record.closing = phase.done.then(() => {
      if (this.unsettled.get(id) === record) this.unsettled.delete(id)
      const abandoned = phase.slot
      if (abandoned && abandoned.state === 'abandoned') abandoned.state = 'disposed'
      // Only the failures that came after the close stopped waiting: the ones it
      // had already been handed are in its own AggregateError.
      const errors = phase.take()
      if (errors.length === 0) return
      this.onEvent({
        type: 'attempt-failed-late',
        slot: slotId,
        revision: revisionKey,
        env: envId,
        error: errors.length === 1
          ? errors[0]!.error
          : new AggregateError(errors.map(item => item.error), `Service ${revisionKey} failed to dispose cleanly.`),
        cleanupErrors: errors.map(item => item.error),
      })
    })
  }
}
