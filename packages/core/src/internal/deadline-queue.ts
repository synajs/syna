// One wait, and when it ends. The queue holds every armed waiter in the process
// behind a single timer; `Waiters` is what a `load()` gets — its own Promise, its
// own deadline on the slot's current attempt, and the report when that deadline
// passes (§11).
import type { RuntimeEvent } from '../descriptors.js'
import { SynaError } from '../errors.js'
import type { AttemptLedger } from './attempt-ledger.js'
import type {
  ServiceSlot,
  SetupAttempt,
  SetupWaiter,
} from './runtime-model.js'

/**
 * The deadlines of every armed waiter in the process: a list sorted by expiry
 * (a new wait usually expires last, so insertion starts at the tail) behind
 * one timer set for the earliest expiry. A wait that settles before its
 * deadline — nearly all of them — costs a few pointer writes and never a timer
 * of its own; the timer is re-set earlier only when an earlier expiry arrives.
 * When it fires it times out the earliest due waiter and lets that timeout's
 * consequences run (the rejection chain that settles every other waiter of the
 * same sequence, as when each waiter had a timer of its own and Node drained
 * the microtasks between two of them) before the next due waiter is looked at
 * from a `setImmediate`. While no waiter is queued the timer is `unref`ed, so
 * the queue holds the process alive exactly as long as pending waits do.
 */
class DeadlineQueue {
  private head: SetupWaiter | undefined = undefined
  private tail: SetupWaiter | undefined = undefined
  private queued = 0
  private timer: ReturnType<typeof setTimeout> | undefined = undefined
  /** The expiry the timer is set for; `Infinity` while there is no timer. */
  private target = Infinity

  add(waiter: SetupWaiter, expiresAt: number): void {
    // Re-arming a waiter that is already queued moves it; `unlink` takes it out of
    // the count, so the increment below puts back the same one and never a second.
    if (waiter.queued) this.unlink(waiter)
    waiter.expiresAt = expiresAt
    waiter.queued = true
    let after = this.tail
    while (after !== undefined && after.expiresAt > expiresAt) after = after.prev
    waiter.prev = after
    waiter.next = after === undefined ? this.head : after.next
    if (waiter.next !== undefined) waiter.next.prev = waiter
    else this.tail = waiter
    if (after !== undefined) after.next = waiter
    else this.head = waiter
    if (this.queued++ === 0) this.timer?.ref()
    if (expiresAt < this.target) this.arm(expiresAt)
  }

  remove(waiter: SetupWaiter): void {
    if (!waiter.queued) return
    this.unlink(waiter)
    if (this.queued === 0) this.timer?.unref()
  }

  /** Takes the waiter out of the list and out of the count; the only place either changes downwards. */
  private unlink(waiter: SetupWaiter): void {
    if (waiter.prev !== undefined) waiter.prev.next = waiter.next
    else this.head = waiter.next
    if (waiter.next !== undefined) waiter.next.prev = waiter.prev
    else this.tail = waiter.prev
    waiter.prev = undefined
    waiter.next = undefined
    waiter.queued = false
    this.queued -= 1
  }

  private arm(expiresAt: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.target = expiresAt
    this.timer = setTimeout(this.fire, Math.max(0, expiresAt - performance.now()))
  }

  private readonly fire = (): void => {
    // A deferred continuation may find a timer that an `add` armed meanwhile;
    // the head decides afresh what the next timer is.
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.target = Infinity
    const head = this.head
    if (head === undefined) return
    const now = performance.now()
    if (head.expiresAt > now) {
      this.arm(head.expiresAt)
      return
    }
    this.remove(head)
    try {
      head.onDeadline(head)
    }
    finally {
      const next = this.head
      if (next !== undefined) {
        if (next.expiresAt <= now) setImmediate(this.fire)
        else this.arm(next.expiresAt)
      }
    }
  }
}

const deadlines = new DeadlineQueue()

/**
 * The waiters of one Runtime: `waitFor` hands each caller a Promise of its own,
 * armed against the slot's current attempt and disarmed the moment that wait ends
 * however it ends. The deadline ends one wait, never the attempt.
 */
export class Waiters {
  private nextLoadId = 1
  private nextWaiterId = 1

  constructor(
    private readonly deadlineMs: number,
    private readonly onEvent: (event: RuntimeEvent) => void,
    private readonly ledger: AttemptLedger,
  ) {}

  /**
   * One caller's wait on the slot's sequence (or its recovery, or an immediate
   * refusal). The waiter's deadline is armed now if an attempt is running, and
   * by every attempt that starts while the wait lasts; it ends only this wait.
   * An aborted signal ends the wait too (`LOAD_CANCELLED`) and takes the
   * waiter, deadline included, off the slot.
   */
  waitFor(
    slot: ServiceSlot,
    value: Promise<unknown>,
    signal: AbortSignal | undefined,
    requester: SetupAttempt | undefined,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      // A requester's pending load is observed for the wait-cycle diagnosis
      // exactly as long as this wait lasts (a timeout ends it too).
      const pendingLoad = requester && requester.state === 'running' ? this.nextLoadId++ : undefined
      if (pendingLoad !== undefined) requester!.pendingLoads.set(pendingLoad, { target: slot, since: Date.now() })
      let done = false
      const waiter: SetupWaiter = {
        id: this.nextWaiterId++,
        slot,
        attempt: undefined,
        deadlineMs: 0,
        expiresAt: 0,
        queued: false,
        prev: undefined,
        next: undefined,
        onDeadline: this.onDeadline,
        settle: outcome => {
          if (done) return
          done = true
          slot.waiters.delete(waiter)
          this.disarm(waiter)
          signal?.removeEventListener('abort', onAbort)
          if (pendingLoad !== undefined) requester!.pendingLoads.delete(pendingLoad)
          // Nothing else observes the caller's Promise: ignoring a rejected one
          // is an ordinary unhandled rejection.
          if (outcome.ok) resolve(outcome.value)
          else reject(outcome.error)
        },
      }
      const onAbort = (): void => {
        waiter.settle({
          ok: false,
          error: new SynaError('LOAD_CANCELLED', 'The caller cancelled its wait.', { slot: slot.id, revision: slot.service.key }),
        })
      }
      slot.waiters.add(waiter)
      value.then(
        instance => waiter.settle({ ok: true, value: instance }),
        error => waiter.settle({ ok: false, error }),
      )
      // A setup may abort its caller's signal while running synchronously inside
      // this very load(): the wait then ends before it is armed.
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const attempt = slot.attempt
      // Armed for the current attempt until that attempt ends, not until its raw
      // Promise settles: a wait joined while the rollback of a failed setup is
      // still running is a wait on the current attempt (§11) and gets a deadline
      // like any other.
      if (attempt && attempt.state === 'running') this.arm(waiter, slot, attempt)
    })
  }

  /** Starts (or restarts) the waiter's deadline for the given running attempt. `Infinity` arms nothing. */
  arm(waiter: SetupWaiter, slot: ServiceSlot, attempt: SetupAttempt): void {
    const deadlineMs = slot.service.loadTimeoutMs ?? this.deadlineMs
    if (!Number.isFinite(deadlineMs)) {
      deadlines.remove(waiter)
      return
    }
    waiter.attempt = attempt
    waiter.deadlineMs = deadlineMs
    deadlines.add(waiter, performance.now() + Math.max(0, deadlineMs))
  }

  disarm(waiter: SetupWaiter): void {
    deadlines.remove(waiter)
  }

  /**
   * The waiter's deadline passed while its attempt is still running: only this
   * wait ends (`LOAD_TIMEOUT`). The attempt is overdue from the first
   * such timeout on — listed in the ledger as `overdue`, `attempt-overdue`
   * reported once, its slot showing `overdueMs` — and keeps running; its
   * result is adopted if the owner is still ready and discarded only by a
   * close.
   */
  private waiterTimedOut(waiter: SetupWaiter): void {
    const slot = waiter.slot
    const attempt = waiter.attempt
    const deadlineMs = waiter.deadlineMs
    if (!slot.waiters.has(waiter)) return
    if (attempt === undefined || slot.attempt !== attempt || attempt.state !== 'running') return
    const envId = slot.ownerEnvId
    if (attempt.rawSettled) {
      // The setup itself has settled and the attempt is in its cleanup phase. The
      // wait is still a wait on the current attempt, so the deadline still ends it —
      // but the setup is not overdue, nothing is listed for it, and the cleanup goes
      // on: only this one wait ends.
      waiter.settle({ ok: false, error: this.timeoutError(attempt, slot, envId, deadlineMs, true) })
      return
    }
    if (attempt.overdueAt === undefined) {
      attempt.overdueAt = Date.now()
      this.ledger.registerOverdue(attempt, envId)
      this.onEvent({
        type: 'attempt-overdue',
        slot: slot.id,
        revision: slot.service.key,
        env: envId,
        attemptNumber: attempt.id,
        deadlineMs,
        elapsedMs: attempt.overdueAt - attempt.startedAt,
      })
    }
    waiter.settle({ ok: false, error: this.timeoutError(attempt, slot, envId, deadlineMs, false) })
  }

  private timeoutError(
    attempt: SetupAttempt,
    slot: ServiceSlot,
    envId: string,
    deadlineMs: number,
    rollingBack: boolean,
  ): SynaError {
    const now = Date.now()
    const pendingLoads = [...attempt.pendingLoads.values()].map(pending => ({
      revision: pending.target.service.key,
      slot: pending.target.id,
      state: pending.target.state,
      waitingMs: now - pending.since,
    }))
    const suspectedWaitCycle = this.findSuspectedWaitCycle(slot)
    return new SynaError(
      'LOAD_TIMEOUT',
      `Setup of ${slot.service.key} did not complete within ${deadlineMs} ms.${
        suspectedWaitCycle
          ? ` Observed load() calls form a cycle (${suspectedWaitCycle.join(' -> ')}); this is an observation, not a proof of deadlock.`
          : ''
      }`,
      {
        slot: slot.id,
        revision: slot.service.key,
        env: envId,
        attemptNumber: attempt.id,
        deadlineMs,
        elapsedMs: now - attempt.startedAt,
        pendingLoads,
        ...(suspectedWaitCycle ? { suspectedWaitCycle } : {}),
        attemptStillRunning: true,
        note: rollingBack
          ? 'The deadline ended this wait while the rollback of the failed setup was still running. The attempt is not overdue; its cleanups keep running and the slot accepts no overlapping attempt until they end.'
          : 'The deadline ended this wait while setup was still pending. The attempt keeps running; its result is adopted if the owner Env is still ready, and discarded only if the owner closes.',
      },
    )
  }

  /** Follows pending load() calls between starting slots. Returns revision keys when they lead back to `origin`. */
  private findSuspectedWaitCycle(origin: ServiceSlot): readonly string[] | undefined {
    const path: string[] = []
    const visited = new Set<string>()
    const visit = (slot: ServiceSlot): boolean => {
      if (visited.has(slot.id)) return false
      visited.add(slot.id)
      path.push(slot.service.key)
      const attempt = slot.attempt
      if (attempt) {
        for (const pending of attempt.pendingLoads.values()) {
          if (pending.target === origin) {
            path.push(origin.service.key)
            return true
          }
          if (pending.target.state === 'starting' && visit(pending.target)) return true
        }
      }
      path.pop()
      return false
    }
    return visit(origin) ? path : undefined
  }

  private readonly onDeadline = (waiter: SetupWaiter): void => this.waiterTimedOut(waiter)
}
