# rc.4 source excerpts
Source: b691067b4b9156f4897b2386f088dcda36a288d2 CI artifact. Original line numbers.

## packages/core/src/runtime.ts:319-353
```text
319:   /**
320:    * One close per Env, whoever asks and from wherever.
321:    *
322:    * `disposeEnv()` aborts the owner signal synchronously — `AbortController.abort()`
323:    * runs its listeners there and then — so user code runs *inside* this call, before
324:    * this line could assign what it returns. A listener that re-entered `dispose()`
325:    * found the field still empty and started a second close: the two raced for the
326:    * same slots, the one that arrived second skipped every slot the first had taken
327:    * and announced `disposed` empty-handed, and a cleanup that threw could end up in
328:    * whichever of them nobody awaited. `disposeEnv()` now sets `closing` before it
329:    * runs any of that and hands such a re-entry `joinClose()` instead of a second
330:    * close — the check belongs there, where the window is, and this stays the one
331:    * line it was: `??=` assigns the close after `disposeEnv()` returns, so it wins
332:    * over anything the re-entry left in the field.
333:    */
334:   dispose(): Promise<void> {
335:     this.disposePromise ??= this.runtime.disposeEnv(this)
336:     return this.disposePromise
337:   }
338: 
339:   /**
340:    * What a `dispose()` that re-entered this close's own synchronous prologue gets.
341:    * The close exists and its Promise is a few statements away, on the stack below:
342:    * `disposeEnv()` runs synchronously up to its first `await` and `dispose()` assigns
343:    * what it returns, both before any microtask of this one. One hop is enough to see
344:    * it, and this caller then settles exactly as the close itself does.
345:    */
346:   async joinClose(): Promise<void> {
347:     await null
348:     await this.disposePromise
349:   }
350: 
351:   [Symbol.asyncDispose](): Promise<void> {
352:     return this.dispose()
353:   }
```

## packages/core/src/runtime.ts:477-513
```text
477:   /** One close per Runtime, for the reason `EnvImpl.dispose()` gives: the root broadcast runs user abort listeners synchronously. */
478:   dispose(): Promise<void> {
479:     this.disposePromise ??= this.disposeRuntime()
480:     return this.disposePromise
481:   }
482: 
483:   /** As `EnvImpl.joinClose()`: one microtask behind this close's own prologue. */
484:   private async joinClose(): Promise<void> {
485:     await null
486:     await this.disposePromise
487:   }
488: 
489:   private async disposeRuntime(): Promise<void> {
490:     {
491:       if (this.closing) return this.joinClose()
492:       this.closing = true
493:       this.disposed = true
494:       const roots = [...this.roots]
495:       // One broadcast over every root: marking each root's subtree separately let an
496:       // abort listener of the first root start work in a second one that was still
497:       // `ready` (N3 at the Runtime level).
498:       this.broadcastClosingAll(roots)
499:       const errors = (await Promise.allSettled(roots.map(root => root.dispose())))
500:         .flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
501:       this.planner.clearCache()
502:       // Envs that completed their bounded close earlier are no longer roots, but an
503:       // attempt they abandoned may still be pending, or its late close (cleanups)
504:       // may be running: give the latter the grace, then report whatever is still
505:       // outstanding — once, as a diagnostic — instead of fulfilling silently.
506:       // Attempts that ignored the stop signal are not an error of this close.
507:       await this.materializer.awaitSettling(this.disposalGraceMs)
508:       const outstanding = this.materializer.unsettledAttempts()
509:       if (outstanding.length > 0) this.onEvent({ type: 'runtime-attempts-outstanding', attempts: outstanding })
510:       if (errors.length > 0) {
511:         throw new AggregateError(errors, 'One or more Syna root Envs failed to dispose.')
512:       }
513:     }
```

## packages/core/src/runtime.ts:639-686
```text
639:   async enterFrom<E extends Entry<any, any>>(
640:     parent: EnvImpl<any> | undefined,
641:     descriptor: E,
642:     call: EntryCall,
643:     realm: ResolutionRealm = PUBLIC_REALM,
644:   ): Promise<EnvImpl<E['requires']>> {
645:     const { envId, plan, rootSiteByEntryKey } = this.planEntry(parent, descriptor, call, false, false, realm)
646:     const env = new EnvImpl<E['requires']>(this, envId, parent, plan, rootSiteByEntryKey)
647:     this.envById.set(env.id, env)
648: 
649:     for (const slot of new Set(plan.slotsByNode.values())) {
650:       if (slot.kind === 'service' && slot.ownerEnvId === envId) slot.ownerEnv = env
651:     }
652: 
653:     if (parent) parent.children.add(env)
654:     else this.roots.add(env)
655: 
656:     try {
657:       await this.prepareSyntheticValues(env)
658:       await this.activateEnv(env)
659:       if (env.state !== 'activating') {
660:         throw new SynaError(
661:           'ENV_CLOSED',
662:           `Env ${env.id} was closed before activation completed.`,
663:           { env: env.id, state: env.state },
664:         )
665:       }
666:       env.state = 'ready'
667:       return env
668:     }
669:     catch (error) {
670:       // Activation failures are always reported as ENTRY_ACTIVATION_FAILED with
671:       // the underlying error as `cause`, whatever its type. Planning errors are
672:       // thrown before this point and keep their own codes.
673:       const failure = new SynaError(
674:         'ENTRY_ACTIVATION_FAILED',
675:         `Entry ${descriptor.id} failed while activating Env ${envId}: ${error instanceof Error ? error.message : String(error)}`,
676:         {
677:           entry: descriptor.id,
678:           env: envId,
679:           ...(error instanceof SynaError ? { causeCode: error.code, causeDetails: error.details } : {}),
680:         },
681:         { cause: error },
682:       )
683:       try { await env.dispose() }
684:       catch (cleanup) { throw addSuppressed(failure, cleanup) }
685:       throw failure
686:     }
```

## packages/core/src/runtime.ts:776-831
```text
776:   private async activateEnv(env: EnvImpl<any>): Promise<void> {
777:     const eager = [...new Set(env.plan.slotsByNode.values())]
778:       .filter((slot): slot is ServiceSlot =>
779:         slot.kind === 'service' && slot.ownerEnvId === env.id && slot.service.eager)
780:     await this.materializer.startEagerSlots(eager)
781:   }
782: 
783:   /**
784:    * Synchronously moves an Env and all of its descendants to `disposing` and
785:    * aborts their signals. From this point no Env in the subtree accepts new
786:    * work (enter/derive/load/recover) and every cooperative setup, worker or
787:    * cleanup in the subtree has seen the stop signal, before anything is waited
788:    * for. Idempotent.
789:    */
790:   private broadcastClosing(env: AnyEnv): void {
791:     this.markClosing(env)
792:     this.abortClosing(env)
793:   }
794: 
795:   /**
796:    * The same for several subtrees at once. Both take two passes: every Env of the
797:    * close set is marked first, and only then are the signals aborted. `abort()` runs
798:    * user listeners synchronously, so a single depth-first pass that aborted as it
799:    * descended offered those listeners a subtree that was still `ready` — they could
800:    * start a dormant Service inside the very set being closed (its `setup()` really
801:    * ran, and its late result was discarded afterwards) and add a whole grace period
802:    * to a close whose bound is computed from the tree as it stood when the close
803:    * began. Marking first closes the set before any of it runs.
804:    */
805:   private broadcastClosingAll(envs: readonly AnyEnv[]): void {
806:     for (const env of envs) this.markClosing(env)
807:     for (const env of envs) this.abortClosing(env)
808:   }
809: 
810:   /** First pass: the subtree refuses new work. Runs no user code, so nothing can observe it half done. */
811:   private markClosing(env: AnyEnv): void {
812:     if (env.state === 'disposed' || env.attemptOwner.closing) return
813:     env.state = 'disposing'
814:     env.attemptOwner.closing = true
815:     if (env.children.size !== 0) this.markDescendants(env)
816:   }
817: 
818:   /** Second pass: every signal of the marked set, in the same order. `abort()` is idempotent. */
819:   private abortClosing(env: AnyEnv): void {
820:     if (env.state === 'disposed') return
821:     env.abortController.abort()
822:     if (env.children.size !== 0) this.abortDescendants(env)
823:   }
824: 
825:   // Descending is its own step in both passes: closing a leaf Env is the common
826:   // case and it should not walk an empty child set to find that out.
827:   private markDescendants(env: AnyEnv): void {
828:     for (const child of env.children) this.markClosing(child)
829:   }
830: 
831:   private abortDescendants(env: AnyEnv): void {
```

## packages/core/src/runtime.ts:851-894
```text
851:   async disposeEnv(env: EnvImpl<any>): Promise<void> {
852:     if (env.state === 'disposed') return
853:     // The broadcast below runs user abort listeners, and one of them can call
854:     // `dispose()` again: this close is already under way, so that caller joins it
855:     // (see `EnvImpl.dispose()`) instead of starting a second one over the same slots.
856:     if (env.closing) return env.joinClose()
857:     env.closing = true
858:     this.broadcastClosing(env)
859: 
860:     const children = [...env.children]
861:     const errors: unknown[] = (await Promise.allSettled(children.map(child => child.dispose())))
862:       .flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
863: 
864:     const ownedServiceSlots = [...new Set(env.plan.slotsByNode.values())]
865:       .filter((slot): slot is ServiceSlot => slot.kind === 'service' && slot.ownerEnvId === env.id)
866: 
867:     await this.materializer.settleSlots(ownedServiceSlots)
868:     errors.push(...await this.materializer.disposeServiceSlots(ownedServiceSlots))
869:     // Every cleanup failure this close waited for, once: the rollbacks of
870:     // attempts that settled inside the grace (whose waiters may have left long
871:     // ago) next to the cleanups of the Ready slots it disposed.
872:     errors.push(...env.attemptOwner.closeErrors.splice(0))
873: 
874:     // One indexed pass, not two `for…of` walks: this is the hot close path, where
875:     // an array iterator costs an allocation per owned slot. A slot that never
876:     // started ends `disposed`, and the Env stops being anyone's owner — an owned
877:     // slot that outlives the close (an abandoned attempt, a cleanup phase that is
878:     // still running, a waiter whose deadline has not passed yet) must not reach
879:     // the Env through `slot.ownerEnv`: §13's "nothing in the Runtime retains its
880:     // graph". Nothing starts on such a slot again: every one of them is `disposed`
881:     // or `abandoned`.
882:     for (let index = 0; index < ownedServiceSlots.length; index += 1) {
883:       const slot = ownedServiceSlots[index]!
884:       if (slot.state === 'dormant' || slot.state === 'failed') slot.state = 'disposed'
885:       slot.ownerEnv = undefined
886:     }
887: 
888:     this.detachEnv(env)
889:     env.state = 'disposed'
890: 
891:     if (errors.length > 0) {
892:       throw new AggregateError(errors, `Env ${env.id} failed to dispose cleanly.`)
893:     }
894:   }
```

## packages/core/src/internal/materializer.ts:637-748
```text
637:   private waitFor(
638:     slot: ServiceSlot,
639:     value: Promise<unknown>,
640:     signal: AbortSignal | undefined,
641:     requester: SetupAttempt | undefined,
642:   ): Promise<unknown> {
643:     return new Promise<unknown>((resolve, reject) => {
644:       // A requester's pending load is observed for the wait-cycle diagnosis
645:       // exactly as long as this wait lasts (a timeout ends it too).
646:       const pendingLoad = requester && requester.state === 'running' ? this.nextLoadId++ : undefined
647:       if (pendingLoad !== undefined) requester!.pendingLoads.set(pendingLoad, { target: slot, since: Date.now() })
648:       let done = false
649:       const waiter: SetupWaiter = {
650:         id: this.nextWaiterId++,
651:         slot,
652:         attempt: undefined,
653:         deadlineMs: 0,
654:         expiresAt: 0,
655:         queued: false,
656:         prev: undefined,
657:         next: undefined,
658:         onDeadline: this.onDeadline,
659:         settle: outcome => {
660:           if (done) return
661:           done = true
662:           slot.waiters.delete(waiter)
663:           this.disarm(waiter)
664:           signal?.removeEventListener('abort', onAbort)
665:           if (pendingLoad !== undefined) requester!.pendingLoads.delete(pendingLoad)
666:           // Nothing else observes the caller's Promise: ignoring a rejected one
667:           // is an ordinary unhandled rejection.
668:           if (outcome.ok) resolve(outcome.value)
669:           else reject(outcome.error)
670:         },
671:       }
672:       const onAbort = (): void => {
673:         waiter.settle({
674:           ok: false,
675:           error: new SynaError('LOAD_CANCELLED', 'The caller cancelled its wait.', { slot: slot.id, revision: slot.service.key }),
676:         })
677:       }
678:       slot.waiters.add(waiter)
679:       value.then(
680:         instance => waiter.settle({ ok: true, value: instance }),
681:         error => waiter.settle({ ok: false, error }),
682:       )
683:       // A setup may abort its caller's signal while running synchronously inside
684:       // this very load(): the wait then ends before it is armed.
685:       if (signal?.aborted) {
686:         onAbort()
687:         return
688:       }
689:       signal?.addEventListener('abort', onAbort, { once: true })
690:       const attempt = slot.attempt
691:       // Armed for the current attempt until that attempt ends, not until its raw
692:       // Promise settles: a wait joined while the rollback of a failed setup is
693:       // still running is a wait on the current attempt (§11) and gets a deadline
694:       // like any other.
695:       if (attempt && attempt.state === 'running') this.arm(waiter, slot, attempt)
696:     })
697:   }
698: 
699:   /** Starts (or restarts) the waiter's deadline for the given running attempt. `Infinity` arms nothing. */
700:   private arm(waiter: SetupWaiter, slot: ServiceSlot, attempt: SetupAttempt): void {
701:     const deadlineMs = slot.service.loadTimeoutMs ?? this.options.deadlineMs
702:     if (!Number.isFinite(deadlineMs)) {
703:       deadlines.remove(waiter)
704:       return
705:     }
706:     waiter.attempt = attempt
707:     waiter.deadlineMs = deadlineMs
708:     deadlines.add(waiter, performance.now() + Math.max(0, deadlineMs))
709:   }
710: 
711:   private disarm(waiter: SetupWaiter): void {
712:     deadlines.remove(waiter)
713:   }
714: 
715:   /**
716:    * The waiter's deadline passed while its attempt is still running: only this
717:    * wait ends (`LOAD_TIMEOUT`). The attempt is overdue from the first
718:    * such timeout on — listed in the ledger as `overdue`, `attempt-overdue`
719:    * reported once, its slot showing `overdueMs` — and keeps running; its
720:    * result is adopted if the owner is still ready and discarded only by a
721:    * close.
722:    */
723:   private waiterTimedOut(waiter: SetupWaiter): void {
724:     const slot = waiter.slot
725:     const attempt = waiter.attempt
726:     const deadlineMs = waiter.deadlineMs
727:     if (!slot.waiters.has(waiter)) return
728:     if (attempt === undefined || slot.attempt !== attempt || attempt.state !== 'running') return
729:     const envId = slot.ownerEnvId
730:     if (attempt.rawSettled) {
731:       // The setup itself has settled and the attempt is in its cleanup phase. The
732:       // wait is still a wait on the current attempt, so the deadline still ends it —
733:       // but the setup is not overdue, nothing is listed for it, and the cleanup goes
734:       // on: only this one wait ends.
735:       waiter.settle({ ok: false, error: this.timeoutError(attempt, slot, envId, deadlineMs, true) })
736:       return
737:     }
738:     if (attempt.overdueAt === undefined) {
739:       attempt.overdueAt = Date.now()
740:       this.registerOverdue(attempt, envId)
741:       this.options.onEvent({
742:         type: 'attempt-overdue',
743:         slot: slot.id,
744:         revision: slot.service.key,
745:         env: envId,
746:         attemptNumber: attempt.id,
747:         deadlineMs,
748:         elapsedMs: attempt.overdueAt - attempt.startedAt,
```

## docs/SEMANTIC_MODEL.md:98-132
```text
98: These seven values are `SlotState` (`env.inspect().nodes[].state`, `attempt-abandoned.dependencies[].state`, `SLOT_NOT_LOADABLE.details.state`). An Env has a state of its own, `EnvState`: `activating → ready → disposing → disposed` (§13).
99: 
100: `ServiceRef.load()` materializes an already-planned slot and returns a plain Promise. Whether the caller awaits it is ordinary JavaScript; the Runtime adds no barrier and no obligation. One actual `setup()` execution is an attempt; each caller is a waiter; concurrent waiters join one attempt; a waiter may end its own wait with an AbortSignal without affecting the attempt.
101: 
102: Failure is sticky by default. A failure policy may retry within one sequence and may allow one shared recovery sequence on a later `load()` after cooldown. A failed rollback ends both: a slot whose cleanup threw (inside a sequence, or while a discarded late result was being cleaned up) is final and refuses recovery with `ROLLBACK_FAILED`, because the resources that attempt acquired are no longer under Syna control and a new attempt would stack on top of them.
103: 
104: An attempt **ends** when its `setup()` has settled *and* the cleanup phase that settlement started has ended: the rollback of a setup that failed, or of a result the owner's close discards. Until then the slot stays `starting`, no second attempt of that slot may start, and every waiter is still waiting on the current attempt. Only a successful setup adopted by a live owner ends an attempt at the moment its Promise settles, because nothing is rolled back.
105: 
106: The load timeout (`loadTimeoutMs`, default 30_000) is the waiter's timeout, not the attempt's: a report by the waiter, never a verdict on the Service. It bounds one `load()` wait on the current attempt — from the start of the attempt to the end of the attempt as defined above, re-armed when a retry starts a new attempt, not counted during the backoff — and ends that wait with `LOAD_TIMEOUT`; the attempt keeps running and the slot stays `starting`. A wait joined while a rollback is still running is a wait on the current attempt like any other and is bounded like any other. A wait ended while the setup itself was still pending makes the attempt *overdue*; one ended during the rollback does not — the setup did not outrun its deadline, its rollback did, so nothing is listed and nothing is reported: only that one wait ends, and the cleanup goes on. Such an attempt is *overdue*: `inspect()` reports `overdueMs` for its slot, the ledger lists it as `overdue`, and `attempt-overdue` is reported once. Later waiters join the running attempt, each with its own window; a shorter wait is the caller's own `AbortSignal`. A late success is adopted while the owner Env is `ready`: the instance is the slot's, every waiter still waiting is fulfilled, nothing is cleaned up, and `attempt-succeeded-late` reports `adopted: true`. Only a close discards a late success (§13). A late failure follows the failure policy like any other failure; a timeout consumes no attempt and triggers no backoff. An abandoned attempt (§13) is discarded, cleaned up and reported when its raw Promise settles late; if that Promise is garbage-collected first, nothing can settle it any more and the attempt is closed as unreachable (its cleanups run, `attempt-unreachable` is reported; an overdue attempt's sequence then follows its failure policy). While its setup Promise is still pending, retention of an attempt is bounded by the reachability of that Promise, never by the Runtime; once the setup has settled, what remains is the cleanup work itself and the minimal record it needs (§13).
107: 
108: An eager Service slot must be `ready` before its Env becomes `ready`. Unrelated eager slots have no startup order guarantee. `enter()` is the waiter of each eager attempt: an eager setup that outlasts the load timeout fails the activation (`ENTRY_ACTIVATION_FAILED`, cause `LOAD_TIMEOUT`) and the rollback closes the new Env, so its late success is discarded by that close — a corollary of the rule above, not an exception.
109: 
110: ## 12. Cycles
111: 
112: Structural dependency cycles are legal. Their strongly connected components fork as indivisible reuse units.
113: 
114: A cycle of setup waits cannot be proven from Promises. The Runtime records which `load()` calls each attempt issued and, when the load timeout expires, reports the observed load-call cycle as diagnostic information — an observation, not a deadlock proof. Legal pre-fetching and racing patterns are never misreported.
115: 
116: ## 13. Disposal
117: 
118: A parent cannot dispose before its descendants. Closing first refuses new work throughout the whole subtree and only then aborts the owner signals of it — in that order, because `AbortController.abort()` runs its listeners synchronously and the stop signal is the cancellation path handed to every `setup()`: when the first listener runs, every Env of the close set already refuses `enter()`, `derive()`, `load()` and recovery, so no user code can start a dormant Service inside the set being closed, and no user code can add a grace period to a bound computed from the tree as it stood when the close began. A close is *entered* before any of it runs — before the first of those listeners — so a listener that calls `dispose()` again, on the same Env, on an ancestor or on the Runtime, joins the close in progress instead of starting a second one; whoever awaits which call, they all settle on the same result. The close then waits for descendants, then gives each owned in-flight attempt the disposal grace, then disposes owned slots — each slot's cleanup phase with a disposal grace of its own. Each Env disposes only Service slots it owns. What does not end inside its own budget is abandoned and reported (`attempt-abandoned`, naming the phase — a setup still pending, a rollback still running, or the cleanup of a Ready slot — and the dependency slots it may still use) rather than waited for. The bound is per Env and per level: descendants close first, so a tree closes in at most one grace per level of attempts plus the cleanup step of that level.
119: 
120: **What is bounded is the waiting, not the release of resources.** An abandoned cleanup keeps running and keeps holding whatever it holds; the model has no way to terminate it (§14). The Runtime stops waiting, says so, and lists it — that is the whole of the guarantee.
121: 
122: The close is bounded, and its end is the end of the Env. `env.state` is advanced only by Runtime actions — `activating → ready → disposing → disposed` — and is `disposed` when the bounded close completes (descendants closed, cleanups run or grace elapsed), whether or not attempts or cleanups were abandoned: the Env leaves the tree and the Runtime's registries, its parent no longer waits for it, nothing in the Runtime retains its graph, and no later event — a late settlement, a garbage collection — changes its state again. An abandoned attempt or cleanup is not an error of the close: `dispose()` fulfils, and rejects only for errors of the close itself.
123: 
124: Errors of the close itself are exactly the cleanup failures it waited for: the cleanups of the Ready slots it disposed, and the rollback of an attempt that settled inside the grace — its result discarded by this close — whose cleanup threw. What a close stops waiting for is a **phase**, not a single cleanup: a cleanup phase runs its cleanups one after another, and each failure is determined the moment that cleanup ends. When the close gives up on a phase, the failures it has already determined are still failures the close waited for and are reported by it; only the part that had not been decided — cleanups still running, and cleanups that never started because an earlier one has not ended — passes to the ledger and to the late report, which lists what failed after that point and nothing else. Each failure appears exactly once in the `AggregateError` of `dispose()` (`error.suppressed` for `run()`), whether or not a waiter was still there to receive the rejection of its own `load()`: what the waiter got — the same `AggregateError`, `LOAD_CANCELLED` after its own abort, `LOAD_TIMEOUT` after its own deadline — never decides whether the close reports. What the close stopped waiting for reports through an event instead, since the `dispose()` that would have carried it has returned by definition.
125: 
126: What outlives the close is accounted for in a ledger, decoupled from the state: `runtime.inspect().unsettledAttempts` (overdue, abandoned, rolling back, settling) and, per Env, `env.inspect().abandonedAttempts` (the entries of the slots that Env owns). An entry leaves the ledger when its attempt settles — success or failure, both discarded because the owner is closed, cleaned up and reported by `attempt-succeeded-late` / `attempt-failed-late` — when an abandoned cleanup ends (a failure then reported by `attempt-failed-late`), or when its setup Promise is found unreachable (§11). Garbage collection only shrinks the ledger (`attempt-unreachable`); it never advances a state, and no assertion about a state may depend on it. An entry may therefore stay listed for as long as the work it names runs, without limit and without breaking the bounded close: what is bounded is the Runtime's *waiting*, never the work, and a `settling` entry that never leaves is the ledger reporting honestly that something the model cannot terminate has not been released. `runtime.dispose()` waits up to the grace for what is settling and then reports whatever is still outstanding once, as `runtime-attempts-outstanding`.
127: 
128: Retention is the user's, never the Runtime's. An attempt on the ledger holds nothing of the Env it belonged to: not the Env, not its plan, not its Input payloads, not its sibling slots. While its setup Promise is still pending, that Promise — the user's own — is what keeps the attempt alive; once the setup has settled, what remains is the cleanup work itself and the minimal record it needs (the cleanup functions, the identity strings, weak handles), so the remaining retention is decided by that work and not by a Promise that has already settled. The same holds for a cleanup phase that outlived its close and for a late close that started after it. A closed Env whose handle the user dropped is collectable while any of them is still pending, and they can still run to the end afterwards. What a user's own `setup` frame or cleanup closure captures is the user's business, and `deps` reaching its slots is what a dependency reference is.
129: 
130: Dependencies of an abandoned attempt, and of an abandoned cleanup, are disposed in the normal order afterwards. The model has no revocation and no forced termination (§14), so a setup or a cleanup that keeps running past the grace may observe closed dependencies; this is the acknowledged consequence of a bounded close, reported with the entry, not a state the model can prevent.
131: 
132: For materialized owned slots, the structural graph is condensed to an SCC DAG. SCCs are disposed dependant-first; independent SCCs are disposed concurrently, so the cleanup step of one Env costs one grace per slot of its longest dependency chain, not one per slot. Within an SCC, cleanup uses reverse materialization-completion order, one slot at a time, and offers no stronger business ordering guarantee.
```

## packages/core/tests/rc4-waiter-termination.test.mjs:24-117
```text
24: test('N5 lazy load(): a waiter on an attempt whose rollback hangs ends at its own deadline, and the cleanup keeps running', async () => {
25:   const define = makeDefine('rc4.n5.lazy')
26:   const events = []
27:   const hang = deferred()
28:   let cleanupStarted = 0
29:   const Service = define.service('s', {
30:     failure: { attempts: 1 },
31:     loadTimeoutMs: 40,
32:     setup(_deps, { onDispose }) {
33:       onDispose(() => { cleanupStarted += 1; return hang.promise })
34:       return sleep(5).then(() => { throw new Error('setup failed') })
35:     },
36:   })
37:   const Entry = define.entry({ requires: { s: Service } })
38:   const runtime = createRuntime({ services: [Service], diagnostics: { onEvent: event => events.push(event.type) } })
39:   const env = await runtime.enter(Entry)
40: 
41:   const started = Date.now()
42:   const first = await codeOf(env.deps.s.load())
43:   const elapsed = Date.now() - started
44:   assert.equal(first, 'LOAD_TIMEOUT', 'the wait ends at the load timeout although the setup itself settled long ago')
45:   assert.ok(elapsed >= 35 && elapsed < 400, `and at that deadline, not at some other time (${elapsed} ms)`)
46:   assert.equal(cleanupStarted, 1, 'the cleanup was started')
47:   assert.deepEqual(stateOf(env), ['starting'], 'the slot is still on the unfinished attempt')
48:   assert.equal(env.state, 'ready', 'nothing about the Env changed: this is not a close')
49:   assert.deepEqual(events, [], 'a rollback that outruns a waiter is not an overdue setup: nothing is reported and nothing is listed')
50:   assert.equal(runtime.inspect().unsettledAttempts.length, 0)
51: 
52:   hang.resolve()
53:   await sleep(20)
54:   assert.equal(cleanupStarted, 1, 'and no second attempt was started behind the unfinished rollback')
55:   await runtime.dispose().catch(() => undefined)
56: })
57: 
58: test('N5 a waiter that joins after the raw setup has already failed gets a deadline of its own', async () => {
59:   const define = makeDefine('rc4.n5.joined')
60:   const hang = deferred()
61:   let setups = 0
62:   const Service = define.service('s', {
63:     failure: { attempts: 1 },
64:     loadTimeoutMs: 40,
65:     setup(_deps, { onDispose }) {
66:       setups += 1
67:       onDispose(() => hang.promise)
68:       return sleep(5).then(() => { throw new Error('setup failed') })
69:     },
70:   })
71:   const Entry = define.entry({ requires: { s: Service } })
72:   const runtime = createRuntime({ services: [Service] })
73:   const env = await runtime.enter(Entry)
74:   void env.deps.s.load().catch(() => undefined)
75:   await sleep(60) // the first waiter has already timed out; the rollback is still running
76: 
77:   const started = Date.now()
78:   const joined = await codeOf(env.deps.s.load())
79:   const elapsed = Date.now() - started
80:   assert.equal(joined, 'LOAD_TIMEOUT', 'the wait that joined afterwards is bounded too')
81:   assert.ok(elapsed >= 35 && elapsed < 400, `by its own deadline, measured from its own start (${elapsed} ms)`)
82:   assert.equal(setups, 1, 'joining an unfinished rollback never starts an overlapping attempt')
83:   hang.resolve()
84:   await sleep(20)
85:   await runtime.dispose().catch(() => undefined)
86: })
87: 
88: test('N5 eager activation: enter() fails with ENTRY_ACTIVATION_FAILED within the load timeout plus the close, not never', async () => {
89:   const define = makeDefine('rc4.n5.eager')
90:   const events = []
91:   const hang = deferred()
92:   const Service = define.service('s', {
93:     eager: true,
94:     failure: { attempts: 1 },
95:     loadTimeoutMs: 40,
96:     setup(_deps, { onDispose }) {
97:       onDispose(() => hang.promise)
98:       return sleep(5).then(() => { throw new Error('eager setup failed') })
99:     },
100:   })
101:   const Entry = define.entry({ requires: { s: Service } })
102:   const runtime = createRuntime({
103:     services: [Service],
104:     limits: { disposalGraceMs: 40 },
105:     diagnostics: { onEvent: event => events.push(event.type) },
106:   })
107:   const started = Date.now()
108:   const outcome = await runtime.enter(Entry).then(() => 'entered', error => error)
109:   const elapsed = Date.now() - started
110:   assert.equal(outcome.code, 'ENTRY_ACTIVATION_FAILED')
111:   assert.equal(outcome.cause?.code, 'LOAD_TIMEOUT', 'the activation is the waiter of the eager attempt (§11)')
112:   assert.ok(elapsed < 1_000, `and it settles (${elapsed} ms)`)
113:   assert.equal(runtime.inspect().liveEnvCount, 0, 'the half-started Env is closed')
114:   assert.ok(events.includes('attempt-abandoned'), 'the close abandons the unfinished rollback and says so')
115:   hang.resolve()
116:   await sleep(30)
117:   await runtime.dispose().catch(() => undefined)
```

## packages/core/tests/rc4-waiter-termination.test.mjs:209-235
```text
209: test('N5 unchanged semantics: a waiter may leave while the rollback is unfinished, and no overlapping attempt starts behind it', async () => {
210:   const define = makeDefine('rc4.n5.no-overlap')
211:   const hang = deferred()
212:   let setups = 0
213:   const Service = define.service('s', {
214:     failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 1 },
215:     loadTimeoutMs: 5_000,
216:     setup(_deps, { onDispose }) { setups += 1; onDispose(() => hang.promise); return Promise.reject(new Error('setup failed')) },
217:   })
218:   const Entry = define.entry({ requires: { s: Service } })
219:   const runtime = createRuntime({ services: [Service] })
220:   const env = await runtime.enter(Entry)
221:   const controller = new AbortController()
222:   const leaving = codeOf(env.deps.s.load({ signal: controller.signal }))
223:   await sleep(10)
224:   controller.abort()
225:   assert.equal(await leaving, 'LOAD_CANCELLED', 'the caller left its wait')
226:   for (let round = 0; round < 5; round += 1) {
227:     void env.deps.s.load({ signal: AbortSignal.abort() }).catch(() => undefined)
228:     await sleep(2)
229:   }
230:   assert.equal(setups, 1, 'the unfinished rollback blocks every new attempt')
231:   assert.deepEqual(stateOf(env), ['starting'])
232:   hang.resolve()
233:   await sleep(20)
234:   await runtime.dispose().catch(() => undefined)
235: })
```

## packages/core/tests/rc4-close-invariants.test.mjs:45-89
```text
45:   test(`N2 ${shape.id}: one close, the caller's Promise carries its cleanup failure, and nothing is reported twice`, async () => {
46:     const define = makeDefine(`rc4.n2.${shape.id.replaceAll(/[^a-z]+/gi, '-')}`)
47:     const events = []
48:     const holder = {}
49:     let cleanupRuns = 0
50:     const cleanup = () => { cleanupRuns += 1; throw new Error('cleanup failed') }
51:     const reenter = () => {
52:       const target = shape.target === 'runtime' ? holder.runtime
53:         : shape.target === 'child-parent' ? holder.root
54:         : shape.target === 'child-self' ? holder.child
55:         : holder.env
56:       holder.inner = shape.target === 'self-async-dispose' ? target[Symbol.asyncDispose]() : target.dispose()
57:       holder.inner.then(() => undefined, () => undefined)
58:     }
59:     const Service = listener(define, 's', reenter, { cleanup })
60:     const Root = define.entry('root', {})
61:     const Child = define.entry('child', { requires: { s: Service } })
62:     const runtime = createRuntime({
63:       services: [Service],
64:       limits: { disposalGraceMs: GRACE },
65:       diagnostics: { onEvent: event => events.push(event.type) },
66:     })
67:     holder.runtime = runtime
68:     const root = await runtime.enter(Root)
69:     holder.root = root
70:     const child = await root.enter(Child)
71:     holder.child = child
72:     holder.env = shape.target.startsWith('child') ? child : child
73:     await child.deps.s.load()
74: 
75:     const closed = shape.target === 'child-parent' || shape.target === 'runtime'
76:       ? await codeOf(root.dispose())
77:       : await codeOf(child.dispose())
78:     assert.notEqual(closed, 'resolved',
79:       'the Promise the caller awaited carries the cleanup failure: it is not the empty-handed half of a race')
80:     assert.equal(cleanupRuns, 1, 'the cleanup ran once, in one close')
81:     assert.equal(child.state, 'disposed')
82:     assert.equal(events.filter(type => type === 'attempt-abandoned').length, 0, 'nothing was abandoned: the cleanup was fast')
83:     await codeOf(holder.inner)
84:     assert.equal(cleanupRuns, 1, 'and the re-entering call joined that same close')
85:     assert.equal(runtime.inspect().unsettledAttempts.length, 0)
86:     await codeOf(runtime.dispose())
87:     assert.equal(events.filter(type => type === 'runtime-attempts-outstanding').length, 0)
88:   })
89: }
```

## packages/core/tests/rc4-close-invariants.test.mjs:138-155
```text
138: test('N2 onEvent that re-enters dispose() joins the same close, exactly as it did before', async () => {
139:   const define = makeDefine('rc4.n2.onevent')
140:   const holder = {}
141:   let cleanups = 0
142:   const Service = define.service('s', { setup(_deps, { onDispose }) { onDispose(() => { cleanups += 1 }); return { ok: true } } })
143:   const Entry = define.entry({ requires: { s: Service } })
144:   const runtime = createRuntime({
145:     services: [Service],
146:     limits: { disposalGraceMs: GRACE },
147:     diagnostics: { onEvent: () => { holder.inner ??= codeOf(holder.env.dispose()) } },
148:   })
149:   const env = await runtime.enter(Entry)
150:   holder.env = env
151:   await env.deps.s.load()
152:   await codeOf(env.dispose())
153:   assert.equal(cleanups, 1)
154:   await codeOf(runtime.dispose())
155: })
```

## packages/core/tests/rc4-retention.test.mjs:156-166
```text
156:   test(`N4 ${item.id}: the closed Env, its Input payload and the control are all collected while it runs`, async () => {
157:     const result = await child(scenario(item.body))
158:     assert.equal(result.code, 0, result.stderr)
159:     const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
160:     assert.deepEqual(out.ledger, item.ledger, 'the ledger says honestly what is still outstanding')
161:     assert.equal(out.reachability.control, false, 'the control Env is collected: the measurement can see a collection')
162:     assert.equal(out.reachability.subject, false, 'the closed Env is unreachable while its cleanup is still pending')
163:     assert.equal(out.reachability.payload, false, 'and so is the Input payload nothing else refers to')
164:     assert.equal(out.ledgerAfter, 0, 'the ledger empties when the outstanding work ends')
165:   })
166: }
```

## packages/core/tests/rc4-retention.test.mjs:192-225
```text
192: test('N4 after runtime.dispose(): the same four paths keep nothing either', async () => {
193:   const result = await child(`
194:     import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
195:     const define = definePackage({ name: '@rc4/retention-runtime', version: '1.0.0', syna: { id: 'rc4.retention.runtime' } })
196:     const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
197:     const collect = async () => { for (let round = 0; round < 8; round += 1) { globalThis.gc(); await sleep(20) } }
198:     const hangs = []
199:     const Rollback = define.service('rollback', {
200:       failure: { attempts: 1 }, loadTimeoutMs: 30,
201:       setup(_deps, { onDispose }) { onDispose(() => new Promise(resolve => hangs.push(resolve))); return Promise.reject('setup failed') },
202:     })
203:     const Ready = define.service('ready', { setup(_deps, { onDispose }) { onDispose(() => new Promise(resolve => hangs.push(resolve))); return { ok: true } } })
204:     const Payload = define.input('payload')
205:     const Entry = define.entry('entry', { requires: { rollback: Rollback, ready: Ready, payload: Payload }, parameters: { payload: Payload } })
206:     const runtime = createRuntime({ services: [Rollback, Ready], limits: { disposalGraceMs: 20 } })
207:     let env = await runtime.enter(Entry, { payload: { marker: new Uint8Array(1 << 20) } })
208:     void env.deps.rollback.load().catch(() => undefined)
209:     await env.deps.ready.load()
210:     await sleep(10)
211:     const envRef = new WeakRef(env)
212:     const payloadRef = new WeakRef(env.deps.payload.read())
213:     await runtime.dispose().catch(() => undefined)
214:     const ledger = runtime.inspect().unsettledAttempts.map(entry => entry.state).sort()
215:     env = undefined
216:     await collect()
217:     console.log(JSON.stringify({ ledger, env: envRef.deref() !== undefined, payload: payloadRef.deref() !== undefined }))
218:     for (const resolve of hangs) resolve()
219:   `)
220:   assert.equal(result.code, 0, result.stderr)
221:   const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
222:   assert.deepEqual(out.ledger, ['abandoned', 'rolling-back'], 'both kinds of outstanding work are listed')
223:   assert.equal(out.env, false, 'the Env is collected after runtime.dispose() too')
224:   assert.equal(out.payload, false)
225: })
```

## apps/multitenant-blog/tests/rc4-acquire-deadline.test.mjs:66-79
```text
66:   test(`A4 a creation stuck in ${where} is refused at the acquirer's own deadline, and the creation goes on`, async () => {
67:     const gate = makeGate()
68:     const harness = await gatedApp(gate, { eager, capacity: 2, acquireTimeoutMs: 40, idleTtlMs: 60_000, sweepIntervalMs: 60_000 })
69:     try {
70:       const manager = await harness.app.app.deps.sites.load()
71:       const started = Date.now()
72:       const acquiring = outcomeOf(manager.acquire('alpha', 'request'))
73:       await waitUntil(() => gate.setups === 1)
74:       assert.equal(await acquiring, 'SITE_CAPACITY', 'the acquirer is refused, not handed a lease long after its deadline')
75:       const elapsed = Date.now() - started
76:       assert.ok(elapsed < 400, `at its own deadline (${elapsed} ms, timeout 40 ms)`)
77:       assert.equal(manager.stats().inFlightAcquires, 0)
78:       assert.equal(manager.stats().creating, 1, 'the creation itself was not cancelled')
79:       assert.equal(manager.stats().creationFailures, 0, 'and an impatient caller is not a failure of the tenant')
```

## apps/multitenant-blog/tests/rc4-acquire-deadline.test.mjs:148-165
```text
148: test('A4 shutdown() ends the wait of a caller inside the creation at once, without waiting for it', async () => {
149:   const gate = makeGate()
150:   const harness = await gatedApp(gate, { capacity: 2, acquireTimeoutMs: 5_000, shutdownTimeoutMs: 50, idleTtlMs: 60_000, sweepIntervalMs: 60_000 })
151:   try {
152:     const manager = await harness.app.app.deps.sites.load()
153:     const acquiring = outcomeOf(manager.acquire('alpha', 'request'))
154:     await waitUntil(() => gate.setups === 1)
155:     const started = Date.now()
156:     const shutting = manager.shutdown()
157:     assert.equal(await acquiring, 'SITE_MANAGER_CLOSED', 'the caller is refused as closed')
158:     const elapsed = Date.now() - started
159:     // The gate is still shut: the creation has not returned, and the caller did not wait for it.
160:     assert.equal(gate.setups, 1)
161:     assert.ok(elapsed < 400, `and it did not wait for the creation to return (${elapsed} ms)`)
162:     gate.open()
163:     const report = await shutting
164:     assert.ok(Array.isArray(report.unreleasedLeases))
165:   }
```

## apps/multitenant-blog/tests/rc4-acquire-deadline.test.mjs:212-228
```text
212: test('A4 record.disposal: an acquirer that meets a world being closed is served or refused inside its own deadline, never behind the close', async () => {
213:   const gate = makeGate()
214:   const harness = await gatedApp(gate, { capacity: 1, acquireTimeoutMs: 300, idleTtlMs: 60_000, sweepIntervalMs: 60_000 })
215:   try {
216:     const manager = await harness.app.app.deps.sites.load()
217:     gate.open() // the first world is created normally
218:     const lease = await manager.acquire('alpha', 'request')
219:     // Closing that world takes as long as the SiteEnv close takes; the acquirer
220:     // behind it must not inherit that wait.
221:     manager.invalidate('alpha')
222:     lease.release() // leaseless and draining → the close starts now
223:     const started = Date.now()
224:     const outcome = await outcomeOf(manager.acquire('alpha', 'request'))
225:     const elapsed = Date.now() - started
226:     assert.ok(outcome === 'lease' || outcome === 'SITE_CAPACITY', `served or refused, never stuck: ${outcome}`)
227:     assert.ok(elapsed < 1_000, `inside its own deadline (${elapsed} ms, timeout 300 ms)`)
228:     assert.equal(manager.stats().creationFailures, 0)
```
