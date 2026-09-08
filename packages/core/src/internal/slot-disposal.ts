// What a bounded close does to the slots of one Env: give every in-flight attempt
// the grace to settle, then run the cleanup phases of the Ready ones dependant-first
// (§13). Nothing here decides the Env's own state; that is the Runtime's.
import { stronglyConnectedComponents } from '../graph.js'
import { settlesWithin } from './abort.js'
import type { AttemptLedger } from './attempt-ledger.js'
import { abandonCleanupPhase, startCleanupPhase } from './cleanup-phase.js'
import type { RuntimeSlot, ServiceSlot } from './runtime-model.js'

/**
 * Gives every in-flight attempt of the given slots at most `limits.disposalGraceMs`
 * to settle after the owner's stop signal: running sequences, overdue or
 * not. Slots are waited for concurrently, so the whole step is bounded by
 * one grace period regardless of the per-service `loadTimeoutMs` (even
 * `Infinity`). Attempts that do not settle in time are abandoned: their slot
 * is marked `abandoned`, the attempt stays registered as `unsettledAttempt`
 * and in the ledger, `attempt-abandoned` is reported, and its late result is
 * still discarded, cleaned up and reported when it eventually arrives. The
 * owner's close does not wait for that: its state is the Runtime's to set.
 */
export async function settleSlots(slots: readonly ServiceSlot[], graceMs: number, ledger: AttemptLedger): Promise<void> {
  await Promise.all(slots.map(slot => settleSlot(slot, graceMs, ledger)))
}

export async function settleSlot(slot: ServiceSlot, graceMs: number, ledger: AttemptLedger): Promise<void> {
  const startedAt = Date.now()
  if (slot.state === 'starting' && slot.sequence) {
    if (!(await settlesWithin(slot.sequence, graceMs))) {
      const running = slot.attempt
      slot.state = 'abandoned'
      // What the attempt's cleanup phase has already determined belongs to this
      // close even though it stops waiting for the rest of the phase (§13): it is
      // taken before `reportsToClose` is cleared, so it enters the AggregateError
      // of dispose() exactly once and the late report lists only later failures.
      if (running) abandonCleanupPhase(running)
      // From here the close no longer waits for this attempt: whatever its
      // cleanups do afterwards is reported by an event, not by dispose().
      if (running) running.reportsToClose = false
      if (running && running.state === 'running' && !running.rawSettled) {
        running.state = 'abandoned'
        slot.unsettledAttempt = running
        running.endRace?.('abandoned')
      }
      else if (running && running.rawSettled && !slot.unsettledAttempt) {
        // The setup itself has settled; what outlives the grace is its rollback
        // (the cleanups of a failed attempt, or of a result the closing owner
        // discards). It is on the ledger as `rolling-back` until it ends, and
        // the slot is released then.
        ledger.registerRollingBack(running, slot)
      }
      const attempt = slot.unsettledAttempt ?? running
      if (attempt) ledger.reportAbandoned(slot, attempt)
      return
    }
    // The sequence settled inside the grace: the attempt settled (its result
    // discarded by this close, or failed) and its cleanups ran. A deadline
    // never settles a sequence, so nothing of it is still running here.
  }
  const attempt = slot.unsettledAttempt
  if (!attempt) return
  const remainingMs = Number.isFinite(graceMs) ? Math.max(0, graceMs - (Date.now() - startedAt)) : graceMs
  if (await settlesWithin(attempt.settled, remainingMs)) return
  slot.state = 'abandoned'
  // The late close of this attempt is a cleanup phase like any other: what it has
  // already determined is this close's to report (N1).
  abandonCleanupPhase(attempt)
  attempt.reportsToClose = false
  ledger.reportAbandoned(slot, attempt)
}

/**
 * Dependant-first disposal over the SCC condensation of Ready owned slots.
 * Independent components run concurrently and each dependency chain keeps its
 * order, so the step costs one cleanup budget per slot of the longest chain
 * rather than one per slot. A component whose slot was abandoned counts as
 * finished: its dependencies are disposed regardless (§13).
 */
export async function disposeServiceSlots(slotsInput: readonly ServiceSlot[], graceMs: number, ledger: AttemptLedger): Promise<readonly unknown[]> {
  const errors: unknown[] = []
  const disposable = slotsInput.filter(slot => slot.state === 'ready')
  if (disposable.length === 0) return errors
  const adjacency = serviceDependencyAdjacency(disposable)
  const scc = stronglyConnectedComponents(adjacency)
  const byId = new Map(disposable.map(slot => [slot.id, slot]))

  // The condensation, as edges rather than as one linear order: `dependencies`
  // are the components a component must outlive, `pendingDependants` how many
  // components must finish before it may close.
  const dependencies = scc.components.map(() => new Set<number>())
  const pendingDependants = scc.components.map(() => 0)
  for (const [source, targets] of adjacency) {
    const from = scc.componentByNode.get(source)!
    for (const target of targets) {
      const to = scc.componentByNode.get(target)!
      if (from === to || dependencies[from]!.has(to)) continue
      dependencies[from]!.add(to)
      pendingDependants[to]! += 1
    }
  }

  const running: Promise<void>[] = []
  const start = (index: number): void => {
    const slots = scc.components[index]!
      .map(id => byId.get(id))
      .filter((slot): slot is ServiceSlot => slot !== undefined)
      .sort((left, right) => (right.completionOrder ?? 0) - (left.completionOrder ?? 0))
    running.push((async () => {
      // Inside a component the order is the reverse of materialization
      // completion, one slot at a time: concurrency is between chains, never
      // along one.
      for (const slot of slots) {
        try { await disposeServiceSlot(slot, graceMs, ledger) }
        catch (error) { errors.push(error) }
      }
      for (const dependency of dependencies[index]!) {
        pendingDependants[dependency]! -= 1
        if (pendingDependants[dependency] === 0) start(dependency)
      }
    })())
  }
  for (let index = 0; index < scc.components.length; index += 1) {
    if (pendingDependants[index] === 0) start(index)
  }
  // `running` grows while it is walked: a component started by a finishing one
  // is appended, and every component is started exactly once.
  for (let index = 0; index < running.length; index += 1) await running[index]
  return errors
}

// Loading -----------------------------------------------------------------

/**
 * One Ready slot's cleanup phase, bounded by `limits.disposalGraceMs`. What
 * does not end inside that budget is abandoned: the close stops waiting, the
 * cleanup keeps running (nothing can terminate it), and the slot is listed and
 * reported. `dispose()` does not reject for an abandoned cleanup — only for
 * one that threw while the close was still waiting for it.
 */
export async function disposeServiceSlot(slot: ServiceSlot, graceMs: number, ledger: AttemptLedger): Promise<void> {
  if (slot.state !== 'ready') return
  slot.state = 'disposing'
  if (slot.cleanups.length === 0) {
    // A slot that registered no cleanup has nothing that could outlive the
    // budget, so there is nothing to bound: the timer the grace needs is not
    // armed at all. Most slots are this one.
    slot.state = 'disposed'
    delete slot.instance
    return
  }
  const startedAt = Date.now()
  const phase = startCleanupPhase(slot.cleanups, slot.id, slot, slot.ownerEnv)
  if (!(await settlesWithin(phase.done, graceMs))) {
    // What this phase already determined belongs to the close that waited for it,
    // even though the close stops waiting for the rest (§13): it is reported by
    // `dispose()` like any other cleanup failure the close waited for, and the
    // late report of the abandoned phase lists only what fails after this point.
    const determined = phase.take().map(item => item.error)
    ledger.abandonCleanup(slot, phase, startedAt)
    if (determined.length > 0) {
      throw new AggregateError(determined, `Service ${slot.service.key} failed to dispose cleanly.`)
    }
    return
  }
  const errors = phase.take()
  slot.state = 'disposed'
  delete slot.instance
  if (errors.length > 0) {
    throw new AggregateError(
      errors.map(item => item.error),
      `Service ${slot.service.key} failed to dispose cleanly.`,
    )
  }
}

export function serviceDependencyAdjacency(
  slots: readonly ServiceSlot[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const included = new Set(slots.map(slot => slot.id))
  const adjacency = new Map<string, Set<string>>()
  // A dependency that passes through a Service slot outside the disposable set
  // (dormant, failed, owned elsewhere) still orders the slots on either side:
  // A -> B -> C with B never started must dispose A before C.
  const collect = (
    slot: RuntimeSlot,
    visited: Set<string>,
    output: Set<string>,
  ): void => {
    if (visited.has(slot.id)) return
    visited.add(slot.id)
    if (slot.kind === 'service' && included.has(slot.id)) {
      output.add(slot.id)
      return
    }
    for (const dependency of slot.requires.values()) collect(dependency, visited, output)
  }
  for (const slot of slots) {
    const targets = new Set<string>()
    for (const dependency of slot.requires.values()) collect(dependency, new Set(), targets)
    adjacency.set(slot.id, targets)
  }
  return adjacency
}
