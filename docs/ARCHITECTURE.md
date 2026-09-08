# Architecture (v0.8, as implemented)

```text
packages/core/src/
├── definition.ts                       definePackage(), auto(), forward(), override(), descriptor constructors
├── descriptors.ts                      public TypeScript contracts (no runtime code)
├── errors.ts                           SynaError, code union, diagnostics
├── semver.ts                           thin wrapper over npm `semver` (includePrerelease)
├── loading.ts                          loadAll()
├── graph.ts                            SCC discovery, dependant-first order
├── runtime.ts                          RuntimeImpl / EnvImpl: entry points, AnchoredEntry, activation & closing order
└── internal/
    ├── identity.ts                     nominal identity, structural signatures, ordering helpers
    ├── definition-compiler.ts          DefinitionCompiler: admission, private closure, CompiledService, overrides, realms
    ├── resolution-realm.ts             public / private-entry realms
    ├── graph-builder.ts                GraphBuilder: lowering of roots and manifests to exact nominal nodes
    ├── entry-planner.ts                EntryPlanner: inputs/bindings, choice backtracking with budget, parent-only reuse fixed point,
    │                                   lineage pins, slot allocation, explain()
    ├── plan-cache.ts                   bounded deterministic LRU for plan templates
    ├── implementation-directory.ts     read-only candidate directory, implementation refs, policy-order validation, CandidateIndex
    ├── implementation-views.ts         C.all set built on the directory
    ├── materializer.ts                 attempts, cleanup phases, waiters, the DeadlineQueue (load timeouts), retry/recovery, late results, bounded dependant-first disposal
    ├── abort.ts                        abortable sleep, per-caller wait cancellation, bounded settle
    ├── solve-errors.ts                 backtrackable topology errors
    └── runtime-model.ts                internal records: CompiledService, slots, attempts, plans, realms
```

## Responsibility boundaries

- **DefinitionCompiler** turns `createRuntime({ services, overrides })` into `CompiledService` records. Public descriptors never carry internal state; overrides never create a second public identity. It also owns the exact-closure computation that defines a Service's private realm.
- **GraphBuilder** lowers Entry roots and Service manifests into nodes with stable ids (`service:<key>`, `input:<id>`, `binding:<id>`, `all:<contract>`, `entry:<site>:<id>`). It raises `NeedChoice` for auto/range/contract sites; it never allocates slots.
- **EntryPlanner** owns everything about a plan: parameters, choices (with the search budget), the parent-only reuse fixed point with fork causes, persistent lineage pins, slot allocation, plan-template caching and `explain()`. It cannot start a setup: it has no reference to the Materializer.
- **ImplementationDirectory / views** are the single implementation of candidate identity, implementation-ref resolution and policy-order validation shared by `C.all` and the catalog.
- **Materializer** realizes already-created slots: one attempt per slot at a time, waiters joining the sequence promise, per-attempt refs that record pending loads for diagnostics only, load timeouts (through the `DeadlineQueue`), retry/backoff with owner-signal cancellation, recovery after exhaustion, discard-and-report of late results, and the bounded disposal step: independent SCCs concurrently, dependant-first, each slot's cleanup phase with a disposal grace of its own and abandoned (listed, reported) if it outlives it. It never changes topology or versions.
- **DeadlineQueue** (`materializer.ts`) is the one timer behind every load timeout in the process: a module-level singleton shared by every Runtime, keeping the armed waiters in a list sorted by expiry (insertion starts at the tail, since a new wait usually expires last) behind a single `setTimeout` set for the earliest expiry. A wait that settles before its timeout — nearly all of them — costs a few pointer writes and never a timer of its own; the timer is re-set only when an earlier expiry arrives. When it fires it times out the earliest due waiter, lets that timeout's consequences run (the rejection chain that settles the other waiters of the same sequence), and looks at the next due waiter from a `setImmediate`. The timer is `ref`ed when the first waiter is queued and `unref`ed when the last one leaves, so the queue holds the process open exactly as long as pending waits do: an idle Runtime holds nothing, a Runtime that is never disposed holds nothing once its waiters settled, and the process exits naturally. Runtimes are isolated in it: a waiter belongs to one Runtime's sequence, a Runtime's disposal removes only its own waiters (they reject with `ENV_CLOSED`), and one Runtime's timeouts fire on their own expiries whatever another Runtime queued (`packages/core/tests/materialization/deadline-queue.test.mjs`: cross-Runtime isolation, natural process exit).
- **RuntimeImpl / EnvImpl** wire the pieces: planning entry points (`enter`, `check`, `explain`), Ready-anchor enforcement for AnchoredEntry, synthetic values (collections, anchored entries), activation (start owned eager slots) and the closing order.

## What the boundaries prevent

- **The cleanup phase** (`materializer.ts`, 1.0.0-rc.4) is a task, not an `await` in the caller's frame: the cleanups of a failed or discarded attempt, of an attempt that settled after its owner closed, and of a Ready slot being disposed all run through one `CleanupPhase`. It records each failure the moment that cleanup ends (so a close that stops waiting takes what is already determined and leaves the rest to the late report), and it holds its slot and its owner Env strongly only while a close is still waiting for it — weakly from the moment one stops. That is why the setup sequence is driven by reactions rather than by an `await` loop: an `async` frame suspended on a cleanup keeps its whole register file, `slot` and `owner` included, and `slot.ownerEnv` is the Env behind them (`docs/SEMANTIC_MODEL.md` §13). A completed bounded close clears `slot.ownerEnv` for the slots it owned, so nothing that outlives it reaches the Env at all.
- The planner cannot execute setup (no materializer reference); the materializer cannot alter versions or slots (it only reads slot records); the plan cache stores templates (graphs + choices) and never Env or slot instances; diagnostics (`onEvent`) are fire-and-forget and cannot change outcomes.
- No AsyncLocalStorage: caller attribution for pending-load diagnostics comes from the refs handed to each attempt.
- No hidden `__type`/string-prefix state carries internal records; `InternalCandidateRef` and `CompiledService` are internal types.

## Deliberately absent

Prepared/activation groups, cross-ancestor historical reuse, Env merge or multiple parents, ambient caller Env, hot installation, reactive Inputs, cross-process uniqueness, forced revocation of escaped instances, a custom Promise/effect DSL for deadlock detection.
