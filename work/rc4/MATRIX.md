# 1.0.0-rc.4 — the merged acceptance matrix

§3 of the task book plus the matrices of `work/rc4/ROOT_CAUSE.md`, merged into one table per item and
extended where the task book asks for a dimension neither report had. "Source" says where the cell
comes from: **T** the task book §3, **R** the root-cause report, **N** new here.

Every cell names the test that asserts it. Nothing in this round asserts that an error appears
"exactly once counting `dispose()` and the events together" (§2.1 禁止一), and nothing asserts
concurrency or seriality from an exact number of timers (§2.1 禁止二).

## N1 — the cleanup phase reports what it has determined

`packages/core/tests/rc4-cleanup-phase.test.mjs`

| call site | ① error→hang | ② hang→error | ③ error,error→hang | ④ error→hang→error | ⑤ all inside the budget | ⑥ all hang | source |
|---|---|---|---|---|---|---|---|
| Ready slot (`disposeServiceSlot`) | ✓ | ✓ (asserts ② never ran before release) | ✓ | ✓ | ✓ | ✓ | T, R |
| attempt rollback (`runAttemptRaw`, rejected) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | T, R |
| discarded late success (owner closed) | ✓ | — | — | ✓ | ✓ | — | T, R |
| late settlement (`closeUnsettled`) | ✓ | — | — | ✓ | ✓ | — | T, R |
| unreachable channel (`--expose-gc`) | ✓ | — | — | — | — | — | T, R |

Per cell: the outcome of `dispose()`, the identity and count of the errors in its `AggregateError`,
the event sequence with its `phase`, the ledger state, and — after the hang is released — the
`cleanupErrors` of the late event.

The four invariants of §2.1, one test each:

| invariant | test | source |
|---|---|---|
| 1. the close's error set never repeats itself; identity is the cleanup execution, not the `Error` object | "N1 invariant 1 …" (one `Error` object thrown by two cleanups is two failures) | T |
| 2. no event is emitted twice | "N1 invariant 2 …" (`attempt-abandoned` once, `attempt-failed-late` once, `runtime.dispose()` adds none) | T |
| 3. the waiter's own outcome does not decide whether the close reports | "N1 invariant 3 …" (cancelled / past its deadline / no waiter) | T |
| 4. a determined failure does not disappear because later work of the same phase hangs | ① and ④ of every call site | T |

The three moments a failure can happen:

| moment | belongs to | test | source |
|---|---|---|---|
| before the close | the sequence (`AggregateError`, `ROLLBACK_FAILED`); the later close reports nothing | "N1 the three moments, before the close …" | T |
| inside the close's wait | `dispose()` | "N1 invariant 4 and the three moments …" | T |
| after that phase's budget | the late event, and never the `dispose()` that returned | same test | T |

## N2 / N3 — the close publishes itself before any user code runs

`packages/core/tests/rc4-close-invariants.test.mjs`

| listener sits on | re-enters `dispose()` | starts a dormant slot | source |
|---|---|---|---|
| the same Env | ✓ (`dispose()`, `Symbol.asyncDispose`, `runtime.dispose()`) | ✓ (its own Env, through its own refs) | T, R |
| the parent Env | ✓ (`child-parent`) | ✓ (child Env, grandchild Env, `enter()` a new Env) | T, R |
| a child Env | ✓ (`child-self`) | ✓ | T, R |
| a sibling root | ✓ (each tree keeps one close) | ✓ (`runtime.dispose()`, second root) | T, R |
| `onEvent` | ✓ (joins the same close) | — | T, R |
| the Runtime level | ✓ (`runtime-attempts-outstanding` exactly once) | ✓ | T, R |

Every re-entry cell also asserts that **the Promise the caller awaited rejects** when a cleanup
throws — the swallowed failure of the baseline. Additional cells:

| cell | test | source |
|---|---|---|
| multi-root `runtime.dispose()` | "N2 a listener that re-enters `runtime.dispose()` …", "N3 … a second root" | T |
| `Symbol.asyncDispose` | the `self-async-dispose` shape | T |
| the `enterFrom` activation-failure close | "N2/N3 the activation-failure path …" | T |
| reverse assertion: closing one tree leaves another root usable | "N3 reverse assertion …" | T, R |
| a child Env created by a listener does not escape the close set | "N3 a listener that enters a new Env inside the close set …" (`liveEnvCount` and `rootEnvCount` back to zero) | T, R |
| the close-time bound is not enlarged by a listener | "N3 the close-time bound is the Runtime's …" | R |
| a cleanup that awaits its own `dispose()` stays bounded | `work/rc4/probes/extra.mjs` N2e (probe; the behaviour is unchanged and already covered by `rc3-close-paths`) | R |

## N4 — nothing suspended on a cleanup keeps a closed Env alive

`packages/core/tests/rc4-retention.test.mjs`, every case in a child process with `--expose-gc`,
`WeakRef`, a control Env with nothing outstanding, and eight collections across macrotasks.

| path | closed Env unreachable | its unrelated Input payload unreachable | control Env unreachable | ledger | source |
|---|---|---|---|---|---|
| P1 raw setup pending | ✓ | ✓ | ✓ | `abandoned` | T, R |
| P2 rollback pending | ✓ | ✓ | ✓ | `rolling-back` | T, R |
| P3 Ready-slot cleanup pending | ✓ | ✓ | ✓ | `abandoned` | T, R |
| P4 late close pending | ✓ | ✓ | ✓ | `settling` | T, R |
| after `runtime.dispose()` (rollback + Ready cleanup together) | ✓ | ✓ | — | `abandoned` + `rolling-back` | T, R |
| **positive control**: the user still holds the Env | **retained**, payload included | **retained** | ✓ still collected | `rolling-back` | T |

The whole-`await` sweep §2.3 asks for is in `docs/SEMANTIC_CHANGES_RC4.md` §4 and repeated in
`work/rc4/STATE.md`.

## N5 — a wait is on the current attempt, and an attempt ends when its cleanup phase does

`packages/core/tests/rc4-waiter-termination.test.mjs`

| entry | assertion | source |
|---|---|---|
| lazy `load()` | ends at its own deadline; the cleanup keeps running; the Env is untouched; nothing listed, nothing reported | T, R |
| a waiter that joins after the raw setup failed | armed on joining, ends at its own deadline measured from its own start | T, R |
| eager activation (`enter()`) | `ENTRY_ACTIVATION_FAILED` with cause `LOAD_TIMEOUT`, inside the load timeout plus the close; `liveEnvCount` back to zero | T |
| control: the raw setup itself is pending | unchanged — `attempt-overdue` once, ledger `overdue`, the old `note` | T |
| the `LOAD_TIMEOUT` of a rollback-phase wait | says which phase it ended; the attempt is not overdue (`overdueMs` absent) | N |
| a rollback that succeeds | the retry rules of the sequence are unchanged (three attempts, each rolled back before the next) | T |
| a rollback that fails fast | `AggregateError` (setup + cleanup), then `ROLLBACK_FAILED`, no second attempt | T |
| a waiter leaves during a pending cleanup | allowed; no overlapping attempt starts behind it | T |

## A4 — one deadline for the whole acquire

`apps/multitenant-blog/tests/rc4-acquire-deadline.test.mjs`

| cell | assertion | source |
|---|---|---|
| stuck in `boundSites.enter()` | refused with `SITE_CAPACITY` at the acquirer's own deadline; the creation goes on | T, R |
| stuck in `auth.load()` | same | T, R |
| stuck in `context.load()` | not gated from outside — see `docs/DEFERRED.md` S15; covered by construction (the deadline wraps the whole `record.creation`) and bracketed by the two cells above | T |
| `record.creation`, first caller times out | the second caller keeps waiting and gets the lease from the same creation | T, R |
| every caller leaves | the creation completes, the world becomes `active`, is reusable, `creations` is 1, no failure and no backoff | T, R |
| the record's fate after a timeout | asserted in both directions: `active` and reusable, `leases` 0 | T, R |
| `shutdown()` during a creation | `SITE_MANAGER_CLOSED` at once, long before the creation returns | T, R |
| the deadline racing `invalidate()` | refused within its own timeout, never left waiting on a rotated world | T, R |
| `record.disposal` | an acquirer meeting a world being closed is served or refused inside its own deadline | T, R |
| control: a fast acquire | byte for byte what it was (single-flight, lease counts, reuse) | T, R |
| `shutdown()` truncating a creation | `apps/multitenant-blog/tests/site-manager.test.mjs` F-AP3-04, rewritten to the rc.4 contract | T |

## G1 — the gate's timing assertions

`packages/core/tests/close-matrix.test.mjs`

| test | proves | does not prove | source |
|---|---|---|---|
| "structure: five independent hung cleanups spend their budgets at the same time, and a chain of three spends them one after another" | every budget of a level is armed before the first of them expires (the phases overlap); along a chain the next budget is armed only after the previous one expired; the cleanups themselves ran dependant-first, one at a time | any duration; that no *other* timer was armed (it only counts timers whose delay is the grace) | T |
| "wall clock: the close of a wide level costs about one budget and the close of a chain about three, with slack" | the close really waits for its budget and really stops afterwards, on a monotonic clock with a 5 ms slack | an exact duration | T |

## Property test

`packages/core/tests/rc4-graph-property.test.mjs` — 200 graphs on a fixed seed, ~90 ms. Randomised:
structure, cycles, never-materialized intermediate nodes, the materialized subset, the number of
cleanups per slot, their registration order, which of them throw. Oracle: breadth-first reachability
computed in the test, never the Runtime's condensation. Asserted: every cleanup of a materialized
slot ran exactly once; dependant-first over the declared graph with cycles excepted and paths through
never-materialized nodes included; every failure exactly once in the close's error set; nothing left
over. The test also asserts that the generator generated something to check (ordered pairs, mutually
reachable pairs, dormant slots, failures).

Hangs stay out of it deliberately (§4): they are the gate-driven scenarios above.
