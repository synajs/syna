# Syna Core Semantic Model v0 (v0.8 wording: the names of 0.8.0 — `docs/MIGRATION_V07_TO_V08.md`, `docs/GLOSSARY.md` — with no semantic change; §11 and §13 revised in 0.7.0 — `docs/SEMANTIC_CHANGES_V07.md`; everything else unchanged since v0.5)

## 1. Static Runtime

A Runtime is finite, closed, and immutable. It contains:

- a public admission set of exact Service revisions;
- the exact transitive private definition closure;
- nominal Contract, Input, Binding, and Entry descriptors;
- deterministic version and implementation policies.

Runtime construction creates no Env, logical slot, or Service instance.

## 2. Entry and Env

Every Env is created by exactly one Entry invocation. A parentless invocation creates a root; an invocation anchored at an existing Env creates a child. Envs form a single-parent forest and cannot merge.

Entry planning is atomic. Failure before commit creates no Env. A committed Env has immutable topology.

`check()` and `explain()` plan without committing: no setup runs, no Env is created and no lineage pin is published, no Env id and no slot id is consumed (planning ids are numbered apart). Planning is not side-effect free in the strict sense: it registers every descriptor it meets — and diagnoses a drifted copy of a definition exactly as `enter()` would, whether the plan is solved or taken from the cache — and may fill the plan cache. Both are bounded by the static definition set of §1 (`inspect().definitions` exposes the counts), so repeated planning cannot grow the Runtime beyond that set.

## 3. Nodes and slots

The resolved graph contains:

- Service nodes;
- Input nodes;
- Binding projection nodes;
- all-implementations nodes;
- owner-anchored Entry nodes.

Only Service nodes materialize user instances. Other nodes use immediately-ready synthetic or value slots.

For each Env and each canonical resolved node, there is at most one visible canonical slot. A slot has exactly one owner Env. A descendant may reuse an ancestor-owned slot.

## 4. Parent-only canonical reuse

A child reuses the greatest valid subset of its **parent's currently visible** slots (a parent slot may be owned by an earlier ancestor). A parent slot is reusable only when the child has the same nominal node and every bound dependency slot remains identical. A changed dependency slot removes the dependant from the reuse set; this propagates to a fixed point over the reverse dependency graph. Historical slots that the parent no longer exposes are never searched. Payload equality and whether setup already ran are never reuse criteria.

`fresh` is a hard non-reuse constraint. `share` is a hard reuse constraint. Failure to satisfy a hard constraint aborts the Entry.

Node correspondence in the current model is nominal-ID-preserving. General bisimulation partition refinement is not part of the runtime hot path.

## 5. Inputs

An Input is a typed external contextual fact with no Syna-owned lifecycle. Explicit local provision creates a new Input slot even when its payload is reference-equal to an ancestor payload. Inheritance is decided by the Entry's declaration, not by the call: an Entry that does not declare an Input among its `parameters` resolves it to the nearest ancestor slot (`MISSING_INPUT` when no ancestor provides it); an Entry that declares it must be given it on every enter, and omitting the key is `MISSING_INPUT`, never inheritance.

Changing an Input slot forks exactly the reverse dependency closure that observes it.

## 6. Service versions

Service Family and exact Service Revision are distinct identities. Multiple revisions of one Family may coexist. The same revision may own different slots in different Env worlds.

A normal static dependency choice site has one deterministic result in a lineage. A new Entry root site may select another compatible revision without rewriting an existing Service dependency edge.

A range reference is taken from one revision, its origin. It resolves among the revisions of that Family the Runtime knows at the site — the admitted ones and, in a private realm, the consumer's private closure and the origin itself; in the public realm an origin that was never admitted is not a candidate — that satisfy the range and provide every Contract the origin provides. A range therefore loads the origin's Contract view, never a revision-private shape.

## 7. Lineage uniqueness

A Family with `uniqueWithin: 'lineage'` is pinned when it first appears in an Env lineage. Descendants may not select a different revision, resolved structure, or slot for that Family. Siblings whose common ancestor never pinned the Family may pin independently.

This is not Runtime-global or process-global uniqueness. The pin persists through descendants that do not use the Family; when the Family reappears it re-attaches to the pinned slot only if every dependency slot matches, otherwise the Entry fails with the full conflict chain (`LINEAGE_UNIQUENESS_CONFLICT`, naming the pinned slot and revision).

## 8. Contracts

A Contract has nominal runtime identity and compile-time API shape, but no instance lifecycle.

- A naked Contract requires an unambiguous implementation family.
- `auto(C)` creates an independent implementation choice site governed by explicit Runtime policy.
- `C.all` requires all admitted implementation revisions to coexist in the current Env; it is the only collection form. Enumerating implementations as separately planned worlds is written as an explicit Entry per candidate.

Private transitive Service definitions are not discoverable Contract candidates unless explicitly admitted.

## 9. Bindings

A Binding is a named inherited implementation choice. An Entry assignment resolves a durable family/range intent to an exact admitted Service revision. Reassigning the same exact choice is a no-op; choosing a different revision creates a new Binding choice/projection slot and forks its dependants.

Selection identity and Service instance identity remain distinct: descendants can retain one Binding choice while provider dependencies cause request-local provider slots.

## 10. Owner-anchored Entries

An Entry may be a Service dependency. The injected Anchored Entry is anchored at the unique owner Env of the consuming Service slot, not at an ambient caller Env. This permits a Service to construct typed child worlds without making “current Env” dynamic or ambiguous. Its roots resolve in the owner's private realm: the admitted revisions plus the owner's transitive closure over exact references and range origins; Contract discovery stays public.

A Service-owned Anchored Entry can only be entered from a `ready` owner. Invoking it while the owner is still `activating` rejects with `OWNER_NOT_READY` (an ordinary rejected Promise); invoking it after the owner begins disposal rejects with `ENV_CLOSED`. There is no activation transaction and no provisional `ready`.

## 11. Materialization

Topology precedes materialization. A Service slot moves through:

```text
dormant → starting → ready → disposing → disposed
              │                  └────→ abandoned ──(cleanup ends late)──→ disposed
              └────→ failed ──(recovery)──→ starting
                       │  (final once a rollback failed)
                       └→ abandoned ──(late settlement / unreachable)──→ disposed
```

These seven values are `SlotState` (`env.inspect().nodes[].state`, `attempt-abandoned.dependencies[].state`, `SLOT_NOT_LOADABLE.details.state`). An Env has a state of its own, `EnvState`: `activating → ready → disposing → disposed` (§13).

`ServiceRef.load()` materializes an already-planned slot and returns a plain Promise. Whether the caller awaits it is ordinary JavaScript; the Runtime adds no barrier and no obligation. One actual `setup()` execution is an attempt; each caller is a waiter; concurrent waiters join one attempt; a waiter may end its own wait with an AbortSignal without affecting the attempt.

Failure is sticky by default. A failure policy may retry within one sequence and may allow one shared recovery sequence on a later `load()` after cooldown. A failed rollback ends both: a slot whose cleanup threw (inside a sequence, or while a discarded late result was being cleaned up) is final and refuses recovery with `ROLLBACK_FAILED`, because the resources that attempt acquired are no longer under Syna control and a new attempt would stack on top of them.

An attempt **ends** when its `setup()` has settled *and* the cleanup phase that settlement started has ended: the rollback of a setup that failed, or of a result the owner's close discards. Until then the slot stays `starting`, no second attempt of that slot may start, and every waiter is still waiting on the current attempt. Only a successful setup adopted by a live owner ends an attempt at the moment its Promise settles, because nothing is rolled back.

The load timeout (`loadTimeoutMs`, default 30_000) is the waiter's timeout, not the attempt's: a report by the waiter, never a verdict on the Service. It bounds one `load()` wait on the current attempt — from the start of the attempt to the end of the attempt as defined above, re-armed when a retry starts a new attempt, not counted during the backoff — and ends that wait with `LOAD_TIMEOUT`; the attempt keeps running and the slot stays `starting`. A wait joined while a rollback is still running is a wait on the current attempt like any other and is bounded like any other. A wait ended while the setup itself was still pending makes the attempt *overdue*; one ended during the rollback does not — the setup did not outrun its deadline, its rollback did, so nothing is listed and nothing is reported: only that one wait ends, and the cleanup goes on. Such an attempt is *overdue*: `inspect()` reports `overdueMs` for its slot, the ledger lists it as `overdue`, and `attempt-overdue` is reported once. Later waiters join the running attempt, each with its own window; a shorter wait is the caller's own `AbortSignal`. A late success is adopted while the owner Env is `ready`: the instance is the slot's, every waiter still waiting is fulfilled, nothing is cleaned up, and `attempt-succeeded-late` reports `adopted: true`. Only a close discards a late success (§13). A late failure follows the failure policy like any other failure; a timeout consumes no attempt and triggers no backoff. An abandoned attempt (§13) is discarded, cleaned up and reported when its raw Promise settles late; if that Promise is garbage-collected first, nothing can settle it any more and the attempt is closed as unreachable (its cleanups run, `attempt-unreachable` is reported; an overdue attempt's sequence then follows its failure policy). While its setup Promise is still pending, retention of an attempt is bounded by the reachability of that Promise, never by the Runtime; once the setup has settled, what remains is the cleanup work itself and the minimal record it needs (§13).

An eager Service slot must be `ready` before its Env becomes `ready`. Unrelated eager slots have no startup order guarantee. `enter()` is the waiter of each eager attempt: an eager setup that outlasts the load timeout fails the activation (`ENTRY_ACTIVATION_FAILED`, cause `LOAD_TIMEOUT`) and the rollback closes the new Env, so its late success is discarded by that close — a corollary of the rule above, not an exception.

## 12. Cycles

Structural dependency cycles are legal. Their strongly connected components fork as indivisible reuse units.

A cycle of setup waits cannot be proven from Promises. The Runtime records which `load()` calls each attempt issued and, when the load timeout expires, reports the observed load-call cycle as diagnostic information — an observation, not a deadlock proof. Legal pre-fetching and racing patterns are never misreported.

## 13. Disposal

A parent cannot dispose before its descendants. Closing first refuses new work throughout the whole subtree and only then aborts the owner signals of it — in that order, because `AbortController.abort()` runs its listeners synchronously and the stop signal is the cancellation path handed to every `setup()`: when the first listener runs, every Env of the close set already refuses `enter()`, `derive()`, `load()` and recovery, so no user code can start a dormant Service inside the set being closed, and no user code can add a grace period to a bound computed from the tree as it stood when the close began. A close is *entered* before any of it runs — before the first of those listeners — so a listener that calls `dispose()` again, on the same Env, on an ancestor or on the Runtime, joins the close in progress instead of starting a second one; whoever awaits which call, they all settle on the same result. The close then waits for descendants, then gives each owned in-flight attempt the disposal grace, then disposes owned slots — each slot's cleanup phase with a disposal grace of its own. Each Env disposes only Service slots it owns. What does not end inside its own budget is abandoned and reported (`attempt-abandoned`, naming the phase — a setup still pending, a rollback still running, or the cleanup of a Ready slot — and the dependency slots it may still use) rather than waited for. The bound is per Env and per level: descendants close first, so a tree closes in at most one grace per level of attempts plus the cleanup step of that level.

**What is bounded is the waiting, not the release of resources.** An abandoned cleanup keeps running and keeps holding whatever it holds; the model has no way to terminate it (§14). The Runtime stops waiting, says so, and lists it — that is the whole of the guarantee.

The close is bounded, and its end is the end of the Env. `env.state` is advanced only by Runtime actions — `activating → ready → disposing → disposed` — and is `disposed` when the bounded close completes (descendants closed, cleanups run or grace elapsed), whether or not attempts or cleanups were abandoned: the Env leaves the tree and the Runtime's registries, its parent no longer waits for it, nothing in the Runtime retains its graph, and no later event — a late settlement, a garbage collection — changes its state again. An abandoned attempt or cleanup is not an error of the close: `dispose()` fulfils, and rejects only for errors of the close itself.

Errors of the close itself are exactly the cleanup failures it waited for: the cleanups of the Ready slots it disposed, and the rollback of an attempt that settled inside the grace — its result discarded by this close — whose cleanup threw. What a close stops waiting for is a **phase**, not a single cleanup: a cleanup phase runs its cleanups one after another, and each failure is determined the moment that cleanup ends. When the close gives up on a phase, the failures it has already determined are still failures the close waited for and are reported by it; only the part that had not been decided — cleanups still running, and cleanups that never started because an earlier one has not ended — passes to the ledger and to the late report, which lists what failed after that point and nothing else. Each failure appears exactly once in the `AggregateError` of `dispose()` (`error.suppressed` for `run()`), whether or not a waiter was still there to receive the rejection of its own `load()`: what the waiter got — the same `AggregateError`, `LOAD_CANCELLED` after its own abort, `LOAD_TIMEOUT` after its own deadline — never decides whether the close reports. What the close stopped waiting for reports through an event instead, since the `dispose()` that would have carried it has returned by definition.

What outlives the close is accounted for in a ledger, decoupled from the state: `runtime.inspect().unsettledAttempts` (overdue, abandoned, rolling back, settling) and, per Env, `env.inspect().abandonedAttempts` (the entries of the slots that Env owns). An entry leaves the ledger when its attempt settles — success or failure, both discarded because the owner is closed, cleaned up and reported by `attempt-succeeded-late` / `attempt-failed-late` — when an abandoned cleanup ends (a failure then reported by `attempt-failed-late`), or when its setup Promise is found unreachable (§11). Garbage collection only shrinks the ledger (`attempt-unreachable`); it never advances a state, and no assertion about a state may depend on it. An entry may therefore stay listed for as long as the work it names runs, without limit and without breaking the bounded close: what is bounded is the Runtime's *waiting*, never the work, and a `settling` entry that never leaves is the ledger reporting honestly that something the model cannot terminate has not been released. `runtime.dispose()` waits up to the grace for what is settling and then reports whatever is still outstanding once, as `runtime-attempts-outstanding`.

Retention is the user's, never the Runtime's. An attempt on the ledger holds nothing of the Env it belonged to: not the Env, not its plan, not its Input payloads, not its sibling slots. While its setup Promise is still pending, that Promise — the user's own — is what keeps the attempt alive; once the setup has settled, what remains is the cleanup work itself and the minimal record it needs (the cleanup functions, the identity strings, weak handles), so the remaining retention is decided by that work and not by a Promise that has already settled. The same holds for a cleanup phase that outlived its close and for a late close that started after it. A closed Env whose handle the user dropped is collectable while any of them is still pending, and they can still run to the end afterwards. What a user's own `setup` frame or cleanup closure captures is the user's business, and `deps` reaching its slots is what a dependency reference is.

Dependencies of an abandoned attempt, and of an abandoned cleanup, are disposed in the normal order afterwards. The model has no revocation and no forced termination (§14), so a setup or a cleanup that keeps running past the grace may observe closed dependencies; this is the acknowledged consequence of a bounded close, reported with the entry, not a state the model can prevent.

For materialized owned slots, the structural graph is condensed to an SCC DAG. SCCs are disposed dependant-first; independent SCCs are disposed concurrently, so the cleanup step of one Env costs one grace per slot of its longest dependency chain, not one per slot. Within an SCC, cleanup uses reverse materialization-completion order, one slot at a time, and offers no stronger business ordering guarantee.

No new `dormant` Service slot may be materialized once its owner Env begins disposal.

## 14. Explicit limitations

Core v0 deliberately does not define:

- Runtime hot installation/uninstallation;
- Env merge or multiple parents;
- ambient dynamic caller Env;
- reactive Input mutation tracking;
- process/distributed singleton guarantees;
- automatic cross-Contract runtime adapters;
- forced revocation of escaped plain JavaScript Service instances;
- forced termination of a `setup()` that ignores its stop signal: such an attempt is abandoned and reported, never killed, and the slots it depends on are closed in the normal order regardless.
