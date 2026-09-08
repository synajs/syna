import type {
  InputRef,
  LoadOptions,
  RuntimeEvent,
  ServiceRef,
  UnsettledAttemptInspection,
} from '../descriptors.js'
import { SynaError } from '../errors.js'
import { type ClosedEnvDetails, closedError, sleepAbortable, waitWithSignal } from './abort.js'
import {
  Attempt,
  createLifecycle,
  endSequence,
  isForeignThenable,
  raceAttempt,
  type RawOutcome,
  type RollbackOutcome,
  releaseRaw,
} from './attempt.js'
import { AttemptLedger } from './attempt-ledger.js'
import { attributeToClose, startRollback } from './cleanup-phase.js'
import { Waiters } from './deadline-queue.js'
import type {
  InputSlot,
  RuntimeSlot,
  ServiceSlot,
  SetupAttempt,
  SlotOwnerEnv,
} from './runtime-model.js'
import { disposeServiceSlots, settleSlots } from './slot-disposal.js'

export interface MaterializerOptions {
  readonly deadlineMs: number
  readonly disposalGraceMs: number
  readonly onEvent: (event: RuntimeEvent) => void
}

/**
 * Owns every operational concern of Service slots: attempts, waiters, retry,
 * recovery, deadlines and cleanup ordering. Topology is decided elsewhere; the
 * materializer can only realize already-created slots.
 *
 * What each concern is made of lives in `./materialization/`: one attempt
 * (`attempt.ts`), one cleanup phase (`cleanup-phase.ts`), one wait and its
 * deadline (`deadlines.ts`), the ledger of everything the Runtime stopped waiting
 * for (`ledger.ts`), and what a bounded close does to a set of slots
 * (`disposal.ts`). What is left here is the sequence that ties them together: a
 * `load()` becomes a wait, a wait joins an attempt, an attempt that fails becomes a
 * rollback, and a rollback decides whether the sequence retries or ends.
 *
 * `load()` returns a plain Promise of its own for every caller: a waiter on the
 * slot's current setup sequence. The setup deadline is the waiter's — it ends
 * that one wait, never the attempt. No completion barrier is attached to the
 * caller; whether the caller awaits the Promise is ordinary JavaScript.
 */
export class Materializer {
  private completionCounter = 1
  private readonly ledger: AttemptLedger
  private readonly waiters: Waiters

  constructor(private readonly options: MaterializerOptions) {
    this.ledger = new AttemptLedger(options.onEvent)
    this.waiters = new Waiters(options.deadlineMs, options.onEvent, this.ledger)
  }

  // Inspection ----------------------------------------------------------------

  /** Every attempt the Runtime is still waiting on, oldest first. */
  unsettledAttempts(): readonly UnsettledAttemptInspection[] {
    return this.ledger.view(() => true)
  }

  /** The attempts an Env's close left behind: its own slots' attempts that are abandoned, rolling back or settling. */
  abandonedAttemptsOf(envId: string): readonly UnsettledAttemptInspection[] {
    return this.ledger.view(record => record.env === envId && record.state !== 'overdue')
  }

  /** Waits, within the grace, for every late close this Runtime has started. */
  awaitSettling(graceMs: number): Promise<void> {
    return this.ledger.awaitSettling(graceMs)
  }

  // What a caller gets ---------------------------------------------------------

  createRef<T>(slot: RuntimeSlot, requester?: SetupAttempt): ServiceRef<T> {
    return Object.freeze({
      load: (options?: LoadOptions) => this.load(slot, options, requester) as Promise<T>,
    })
  }

  createInputRef<T>(slot: InputSlot): InputRef<T> {
    return Object.freeze({
      read: () => slot.payload as T,
    })
  }

  load(slot: RuntimeSlot, options?: LoadOptions, requester?: SetupAttempt): Promise<unknown> {
    if (options !== undefined && (typeof options !== 'object' || options === null)) {
      return Promise.reject(new TypeError('load() options must be an object.'))
    }
    switch (slot.kind) {
      case 'input': return Promise.resolve(slot.payload)
      case 'binding': return this.load(slot.requires.get('target')!, options, requester)
      case 'all-implementations':
      case 'entry': return Promise.resolve(slot.value)
      case 'service': return this.loadService(slot, options, requester)
    }
  }

  /**
   * Starts every given eager slot and resolves when all are Ready; rejects with
   * the first failure. The activation is the waiter of each eager attempt, so
   * an eager setup that outlasts the deadline fails the activation with
   * `LOAD_TIMEOUT` while the attempt keeps running; the rollback
   * that follows closes the new Env, and that close is what discards the late
   * result.
   */
  async startEagerSlots(slots: readonly ServiceSlot[]): Promise<void> {
    await Promise.all(slots.map(slot => this.loadService(slot, undefined, undefined)))
  }

  // Disposal -------------------------------------------------------------------

  /**
   * Gives every in-flight attempt of the given slots at most `limits.disposalGraceMs`
   * to settle after the owner's stop signal (see `./materialization/disposal.ts`).
   */
  settleSlots(slots: readonly ServiceSlot[]): Promise<void> {
    return settleSlots(slots, this.options.disposalGraceMs, this.ledger)
  }

  /** Dependant-first disposal of the Ready owned slots (see `./materialization/disposal.ts`). */
  disposeServiceSlots(slotsInput: readonly ServiceSlot[]): Promise<readonly unknown[]> {
    return disposeServiceSlots(slotsInput, this.options.disposalGraceMs, this.ledger)
  }

  // Loading -----------------------------------------------------------------

  private loadService(
    slot: ServiceSlot,
    options: LoadOptions | undefined,
    requester: SetupAttempt | undefined,
  ): Promise<unknown> {
    if (options?.signal?.aborted) {
      // Nothing is started for a caller that already gave up.
      return Promise.reject(new SynaError('LOAD_CANCELLED', 'The caller cancelled its wait.', {
        slot: slot.id,
        revision: slot.service.key,
      }))
    }
    let value: Promise<unknown>
    try {
      value = this.serviceValue(slot)
    }
    catch (error) {
      value = Promise.reject(error)
    }
    if (slot.state === 'ready') {
      // Nothing to wait for: the caller's own Promise of the instance.
      return waitWithSignal(value.then(instance => instance), options?.signal, () => ({
        slot: slot.id,
        revision: slot.service.key,
      }))
    }
    // Every caller gets its own Promise: a waiter with its own deadline.
    // The shared sequence carries an internal rejection handler so the runtime
    // never produces unhandled rejections on its own; a caller that ignores its
    // Promise sees ordinary JavaScript behaviour (an unhandled rejection)
    // whichever slot state it hit.
    return this.waiters.waitFor(slot, value, options?.signal, requester)
  }

  private serviceValue(slot: ServiceSlot): Promise<unknown> {
    switch (slot.state) {
      case 'ready':
        return Promise.resolve(slot.instance)
      case 'disposing':
      case 'disposed':
      case 'abandoned':
        throw new SynaError(
          'SLOT_NOT_LOADABLE',
          `Service slot ${slot.id} (${slot.service.key}) is ${slot.state}.`,
          { slot: slot.id, revision: slot.service.key, state: slot.state },
        )
      case 'failed':
        if (slot.service.failure.afterExhaustion === 'sticky') {
          return Promise.reject(slot.error)
        }
        if (slot.rollbackFailed) return Promise.reject(this.rollbackFailedError(slot))
        return this.recoverFailedSlot(slot)
      case 'dormant':
        this.startSequence(slot)
        return slot.sequence!
      case 'starting':
        return slot.sequence!
    }
  }

  private owner(slot: ServiceSlot): SlotOwnerEnv {
    if (!slot.ownerEnv) {
      throw new Error(`Syna internal invariant: service slot ${slot.id} has no owner Env.`)
    }
    return slot.ownerEnv
  }

  // One sequence of attempts ---------------------------------------------------

  private startSequence(slot: ServiceSlot): void {
    const owner = this.owner(slot)
    this.assertOwnerUsable(owner, slot, 'materialize')
    this.assertNoUnsettledAttempt(slot)
    slot.state = 'starting'
    delete slot.error
    delete slot.failedAt
    // The sequence promise must be observable before setup() runs synchronously:
    // a dependency's setup may call load() back on this slot within the same tick.
    let resolveSequence: (value: unknown) => void = () => undefined
    let rejectSequence: (error: unknown) => void = () => undefined
    const sequence = new Promise<unknown>((resolve, reject) => {
      resolveSequence = resolve
      rejectSequence = reject
    })
    slot.sequence = sequence
    void sequence.catch(() => undefined)
    void this.startAttempt(slot, owner, 1, resolveSequence, rejectSequence)
  }

  /**
   * A failed rollback is final for the slot: whatever the attempt acquired is
   * outside Syna control, so no policy may start an attempt that would stack a
   * second set of resources on top of it. The original failure stays reachable
   * as `cause`.
   */
  private rollbackFailedError(slot: ServiceSlot): SynaError {
    return new SynaError(
      'ROLLBACK_FAILED',
      `Recovery of ${slot.service.key} is refused: the rollback of a previous setup attempt failed, so resources it acquired are not under Syna control and a new attempt would stack on top of them.`,
      { slot: slot.id, revision: slot.service.key, state: slot.state },
      slot.error instanceof Error ? { cause: slot.error } : undefined,
    )
  }

  /**
   * Attempts of one slot never overlap. An unsettled attempt always belongs
   * to an abandoned slot, which refuses `load()` with `SLOT_NOT_LOADABLE`
   * before a sequence could start, so this cannot be reached by a caller.
   */
  private assertNoUnsettledAttempt(slot: ServiceSlot): void {
    const unsettled = slot.unsettledAttempt
    if (!unsettled) return
    throw new Error(`Syna internal invariant: setup attempt ${unsettled.id} of ${slot.service.key} has not settled; a new attempt would overlap it.`)
  }

  /**
   * One iteration of the setup sequence — attempts 1 to `failure.attempts`, with
   * the failure policy between them — settling the slot's sequence Promise
   * directly through its resolvers.
   *
   * The sequence is driven by reactions rather than by one `await` loop on
   * purpose. An `async` frame suspended on a rollback keeps `slot` and `owner` in
   * its register file for as long as that rollback runs, and `slot.ownerEnv` is
   * the Env behind them — the whole plan, its Input payloads and its sibling
   * slots (§13). Nothing here is suspended while a cleanup phase runs: what the
   * phase needs, it holds itself, and it lets go of the Env the moment the close
   * stops waiting for it.
   */
  private async startAttempt(
    slot: ServiceSlot,
    owner: SlotOwnerEnv,
    index: number,
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void,
  ): Promise<void> {
    let raw: RawOutcome
    try {
      this.assertOwnerUsable(owner, slot, 'continue setup of')
      // Suspended here for the raw phase only, exactly as the sequence always was:
      // the close ends that wait by ending the attempt's race. What follows a
      // settled setup — the cleanup phase — is never awaited in this frame.
      raw = await this.runAttemptRaw(slot, owner)
    }
    catch (error) {
      endSequence(slot, error, reject)
      return
    }
    if (raw.kind === 'ok') {
      resolve(raw.instance)
      return
    }
    if (raw.kind === 'unsettled') {
      endSequence(slot, raw.error, reject)
      return
    }
    this.continueAfterRollback(raw, index, resolve, reject)
  }

  /**
   * The rest of the sequence, attached to the attempt's cleanup phase instead of
   * awaited: what a hung rollback keeps alive is this one reaction, and it reaches
   * the slot and the owner only through the phase, which holds both weakly from
   * the moment the close stops waiting.
   */
  private continueAfterRollback(
    rollback: RollbackOutcome,
    index: number,
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void,
  ): void {
    void rollback.phase.done.then(() => {
      const outcome = this.finishRollback(rollback)
      const slot = rollback.phase.slot
      if (rollback.phase.failed) {
        // A failed rollback ends the sequence and is final for the slot: retrying
        // (now or on a later load) on top of leaked resources is not safe.
        if (slot) slot.rollbackFailed = true
        endSequence(slot, new AggregateError(
          [outcome.error, ...outcome.cleanupErrors],
          `Setup attempt ${index} of ${rollback.attempt.revisionKey} and its rollback both failed.`,
          outcome.error instanceof Error ? { cause: outcome.error } : undefined,
        ), reject)
        return
      }
      const owner = rollback.phase.owner
      const policy = slot?.service.failure
      // A slot or an owner that is already gone means the Env was collected while
      // this rollback ran: there is nothing left to retry into.
      const mayRetry = slot !== undefined && owner !== undefined && policy !== undefined
        && index < policy.attempts
        && !owner.abortController.signal.aborted
        && (owner.state === 'activating' || owner.state === 'ready')
      if (!mayRetry || !slot || !owner || !policy) {
        endSequence(slot, outcome.error, reject)
        return
      }
      void sleepAbortable(
        policy.delayMs,
        owner.abortController.signal,
        `Retry of ${slot.service.key} was cancelled because owner Env ${owner.id} is closing.`,
        this.closedDetails(owner, slot),
      ).then(
        () => void this.startAttempt(slot, owner, index + 1, resolve, reject),
        error => endSequence(slot, error, reject),
      )
    })
  }

  /**
   * An attempt's cleanup phase has ended, so the attempt is over: it is reported
   * and the sequence is told what happened. Everything used here comes from the
   * attempt's own record of itself, so the phase never had to keep the slot or the
   * Env to make this report.
   */
  private finishRollback(rollback: RollbackOutcome): { readonly error: unknown; readonly cleanupErrors: readonly unknown[] } {
    const { attempt, phase, reason } = rollback
    const slot = phase.slot
    // The attempt ends here, so its waiters' deadlines end with it: the backoff
    // before a retry is not counted against them (§11), and the next attempt arms
    // every waiter again.
    if (slot) for (const waiter of slot.waiters) this.waiters.disarm(waiter)
    const cleanupErrors = phase.take().map(item => item.error)
    attempt.state = 'failed'
    delete attempt.cleanupPhase
    attributeToClose(attempt, cleanupErrors)
    const wasOverdue = this.ledger.forgetOverdue(attempt)
    const envId = attempt.owner.envId
    if (reason === 'unreachable') {
      attempt.resolveSettled()
      this.options.onEvent({
        type: 'attempt-unreachable',
        slot: attempt.slotId,
        revision: attempt.revisionKey,
        env: envId,
        elapsedMs: Date.now() - attempt.startedAt,
        cleanupErrors,
      })
      return {
        error: new Error(`Setup of ${attempt.revisionKey} can no longer settle: its Promise was garbage-collected while still pending.`),
        cleanupErrors,
      }
    }
    if (reason === 'failed') {
      // Late is measured from the start of the close, not from its end: a
      // settlement inside the grace is reported like one after it, whether or
      // not a waiter is still there.
      if (wasOverdue || (phase.owner ? this.ownerClosing(phase.owner) : attempt.owner.closing)) {
        this.options.onEvent({
          type: 'attempt-failed-late',
          slot: attempt.slotId,
          revision: attempt.revisionKey,
          env: envId,
          error: rollback.error,
          cleanupErrors,
        })
      }
      attempt.resolveSettled()
      return { error: rollback.error, cleanupErrors }
    }
    if (wasOverdue || rollback.ownerClosed) {
      this.options.onEvent({
        type: 'attempt-succeeded-late',
        slot: attempt.slotId,
        revision: attempt.revisionKey,
        env: envId,
        adopted: false,
        cleanupErrors,
      })
    }
    attempt.resolveSettled()
    return {
      error: closedError(
        `Setup of ${attempt.revisionKey} completed after owner Env ${envId} began closing; the instance was discarded.`,
        { env: envId, state: phase.owner?.state ?? 'disposed', slot: attempt.slotId, revision: attempt.revisionKey },
      ),
      cleanupErrors,
    }
  }

  /**
   * The raw phase of one attempt: `setup()` and everything up to the settlement of
   * the Promise it returned. A rollback is not run here — it is started as a task
   * of its own and handed back, so no frame stays suspended on it.
   */
  private async runAttemptRaw(slot: ServiceSlot, owner: SlotOwnerEnv): Promise<RawOutcome> {
    const attempt = this.createAttempt(slot, owner)
    slot.attempt = attempt
    slot.attemptCount += 1

    const dependencyRefs: Record<string, ServiceRef<unknown> | InputRef<unknown>> = {}
    for (const [key, dependencySlot] of slot.requires) {
      dependencyRefs[key] = dependencySlot.kind === 'input'
        ? this.createInputRef(dependencySlot)
        : this.createRef(dependencySlot, attempt)
    }
    const lifecycle = createLifecycle(attempt, owner.abortController.signal)

    // The raw Promise lives on the attempt while the attempt runs off the
    // ledger (`releaseRaw` swaps it for a weak handle the moment the attempt is
    // listed) and never in this frame across the await: what only the user's
    // code can settle is not kept alive by a listed attempt.
    const raced = await (() => {
      let rawPromise: Promise<unknown>
      try {
        const raw = slot.service.setup(Object.freeze(dependencyRefs) as never, lifecycle)
        if (isForeignThenable(raw)) {
          this.options.onEvent({
            type: 'setup-returned-thenable',
            slot: slot.id,
            revision: slot.service.key,
            env: owner.id,
          })
        }
        rawPromise = Promise.resolve(raw)
      }
      catch (error) {
        rawPromise = Promise.reject(error)
      }
      attempt.raw = rawPromise
      // Every waiter present now measures its deadline against this attempt.
      for (const waiter of slot.waiters) this.waiters.arm(waiter, slot, attempt)
      return raceAttempt(rawPromise, attempt)
    })()
    // The waiters' deadlines are *not* cleared here. A wait is on the current
    // attempt, and the attempt is not over until its cleanup phase is: clearing
    // them at the settlement of the raw Promise left every waiter of a failed setup
    // whose rollback hung with no timeout at all. They are cleared when the attempt
    // ends (`finishRollback`), so the backoff before a retry is still not counted
    // against them (§11), or by their own settlement when the sequence ends here.

    if (raced.kind === 'abandoned') {
      slot.unsettledAttempt = attempt
      const record = this.ledger.registerUnsettled(attempt, owner.id, 'abandoned')
      const error = closedError(
        `Setup of ${slot.service.key} was still pending when owner Env ${owner.id} closed; its eventual result will be discarded.`,
        this.closedDetails(owner, slot)(),
      )
      // The wait-cycle diagnosis only ever reads attempts running under a live
      // owner: an abandoned attempt keeps no dependency slots for it.
      attempt.pendingLoads.clear()
      attempt.endRace = undefined
      const rawPromise = releaseRaw(attempt)
      if (rawPromise) this.ledger.watchLateSettlement(attempt, rawPromise)
      else {
        // Overdue earlier and collected since: nothing can settle it any more.
        void this.ledger.settleRecord(record, attempt, undefined, 'unreachable')
      }
      return { kind: 'unsettled', error }
    }

    attempt.rawSettled = true
    attempt.raw = undefined
    attempt.endRace = undefined
    // A setup that has settled waits for nothing: the wait-cycle diagnosis only
    // reads attempts that are still executing, and keeping the entries would hold
    // this attempt's dependency slots through the cleanup phase that follows.
    attempt.pendingLoads.clear()
    if (attempt.watched) this.ledger.unwatch(attempt)
    const ownerClosed = owner.abortController.signal.aborted
      || (owner.state !== 'activating' && owner.state !== 'ready')

    if (raced.kind === 'unreachable') {
      // The raw Promise of an overdue attempt was collected while its owner
      // lived: the attempt is closed as failed and the sequence goes on with the
      // failure policy (a new attempt cannot overlap one that can never finish).
      return startRollback(attempt, slot, owner, 'unreachable', undefined, ownerClosed)
    }
    if (raced.kind === 'rejected') {
      return startRollback(attempt, slot, owner, 'failed', raced.error, ownerClosed)
    }
    if (ownerClosed || slot.attempt !== attempt) {
      return startRollback(attempt, slot, owner, 'discarded', undefined, ownerClosed)
    }

    attempt.state = 'succeeded'
    attempt.resolveSettled()
    slot.instance = raced.value
    slot.instanceAttemptId = attempt.id
    slot.cleanups = attempt.cleanups
    slot.completionOrder = this.completionCounter++
    slot.state = 'ready'
    delete slot.attempt
    delete slot.error
    delete slot.failedAt
    if (this.ledger.forgetOverdue(attempt)) {
      // Adopted: the owner is still ready, so the late instance is the slot's
      // and its cleanups run at disposal like any other. Only a close discards
      // a late success.
      this.options.onEvent({
        type: 'attempt-succeeded-late',
        slot: slot.id,
        revision: slot.service.key,
        env: owner.id,
        adopted: true,
        cleanupErrors: [],
      })
    }
    return { kind: 'ok', instance: raced.value }
  }

  private createAttempt(slot: ServiceSlot, owner: SlotOwnerEnv): SetupAttempt {
    return new Attempt(this.ledger.nextId(), slot, owner.attemptOwner)
  }

  /** Whether the owner's close has begun: from then on its attempts' cleanup failures are the close's to report. */
  private ownerClosing(owner: SlotOwnerEnv): boolean {
    return owner.abortController.signal.aborted || (owner.state !== 'activating' && owner.state !== 'ready')
  }

  private recoverFailedSlot(slot: ServiceSlot): Promise<unknown> {
    if (slot.recovery) return slot.recovery
    const owner = this.owner(slot)
    this.assertNoUnsettledAttempt(slot)

    const recovery = (async () => {
      this.assertOwnerUsable(owner, slot, 'recover')
      const elapsed = Date.now() - (slot.failedAt ?? 0)
      const remaining = Math.max(0, slot.service.failure.cooldownMs - elapsed)
      await sleepAbortable(
        remaining,
        owner.abortController.signal,
        `Recovery of ${slot.service.key} was cancelled because owner Env ${owner.id} is closing.`,
        this.closedDetails(owner, slot),
      )
      this.assertOwnerUsable(owner, slot, 'recover')
      // A late cleanup may have failed during the cooldown: the slot is then final.
      if (slot.rollbackFailed) throw this.rollbackFailedError(slot)
      if (slot.state === 'ready') return slot.instance
      if (slot.state === 'starting' && slot.sequence) return slot.sequence
      if (slot.state !== 'failed') {
        // The owner was just found usable and recovery is single-flight: the slot is `failed` here.
        throw new Error(`Syna internal invariant: cannot recover ${slot.service.key} from state ${slot.state}.`)
      }
      slot.state = 'dormant'
      this.startSequence(slot)
      return slot.sequence!
    })()
    slot.recovery = recovery
    void recovery.then(
      () => { if (slot.recovery === recovery) delete slot.recovery },
      () => { if (slot.recovery === recovery) delete slot.recovery },
    )
    return recovery
  }

  private assertOwnerUsable(owner: SlotOwnerEnv, slot: ServiceSlot, action: string): void {
    const closing = owner.abortController.signal.aborted
    if (!closing && (owner.state === 'activating' || owner.state === 'ready')) return
    throw closedError(
      closing
        ? `Cannot ${action} ${slot.service.key}: owner Env ${owner.id} is closing.`
        : `Cannot ${action} ${slot.service.key} while owner Env ${owner.id} is ${owner.state}.`,
      this.closedDetails(owner, slot)(),
    )
  }

  /** The `ENV_CLOSED` details of a slot-level refusal, read when the refusal is built. */
  private closedDetails(owner: SlotOwnerEnv, slot: ServiceSlot): () => ClosedEnvDetails {
    return () => ({ env: owner.id, state: owner.state, slot: slot.id, revision: slot.service.key })
  }

  // Disposal ------------------------------------------------------------------
}
