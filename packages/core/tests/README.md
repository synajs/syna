# `@syna/core` tests

The suites are grouped by the behaviour they hold, not by the review round that produced
them. A test's audit number stays in its title (`F-PL-01 …`, `N2 …`, `R17 …`, `A03 …`),
so every case is still traceable to the round that asked for it; the mapping below says
where each file went when 1.0.0-rc.5 regrouped them. Nothing but the file names and the
depth of the relative path to `../../dist` changed in that move.

Run them all with `npm test`, one domain with
`node --test 'packages/core/tests/disposal/*.test.mjs'`, one file by name.

## `planning/`

What a plan is: definitions and identity, versions and ranges, Contracts and Bindings, realms and overrides, parent-only reuse, the plan cache, `check()` and `explain()`. Nothing here runs a `setup()`.

Audit numbers in these titles: F-CD-*, F-CL3-*, R01, R06, R07, R12, R13, R17, K12.

| was | is |
|---|---|
| `v04-regressions.test.mjs` | `planning/all-implementations-and-budgets.test.mjs` |
| `v05-definitions.test.mjs` | `planning/binding-and-version-ranges.test.mjs` |
| `v05-audit3-lifecycle-planning.test.mjs` | `planning/candidate-identity-and-drift.test.mjs` |
| `contracts.test.mjs` | `planning/contracts.test.mjs` |
| `core.test.mjs` | `planning/definitions-and-ownership.test.mjs` |
| `v05-audit-planning.test.mjs` | `planning/explain-missing-inputs.test.mjs` |
| `v05-explain.test.mjs` | `planning/explain.test.mjs` |
| `v05-realms-override.test.mjs` | `planning/override-and-private-realms.test.mjs` |
| `v05-planner.test.mjs` | `planning/parent-only-reuse.test.mjs` |
| `v05-cache-cleanup.test.mjs` | `planning/plan-cache-equivalence.test.mjs` |
| `v04-adversarial.test.mjs` | `planning/plan-cache-lineages.test.mjs` |
| `v04-finalization.test.mjs` | `planning/realms-and-owner-anchoring.test.mjs` |
| `v04-corrections.test.mjs` | `planning/request-envs-and-templates.test.mjs` |
| `semver.test.mjs` | `planning/semver.test.mjs` |

## `materialization/`

What a `load()` does: one attempt, the waiters that join it, deadlines, retry and recovery, late results.

Audit numbers in these titles: R05, R10, R-1, N5, S1.

| was | is |
|---|---|
| `rc4-deadline-clock.test.mjs` | `materialization/deadline-clock.test.mjs` |
| `v08-deadline-queue.test.mjs` | `materialization/deadline-queue.test.mjs` |
| `hardening.test.mjs` | `materialization/hardening.test.mjs` |
| `v05-review-lifecycle.test.mjs` | `materialization/retry-and-late-results.test.mjs` |
| `lifecycle.test.mjs` | `materialization/setup-and-sharing.test.mjs` |
| `v07-s1-waiter-deadline.test.mjs` | `materialization/waiter-deadline.test.mjs` |
| `rc4-waiter-termination.test.mjs` | `materialization/waiter-termination.test.mjs` |
| `v05-attempts.test.mjs` | `materialization/waiters-and-cancellation.test.mjs` |

## `disposal/`

What a close does: the bounded close, cleanup phases, what a `dispose()` reports and what an event reports, the ledger of what outlived the close, and what is retained afterwards.

Audit numbers in these titles: F-PL-*, RC2-L1, N1, N2, N3, N4, S2.

| was | is |
|---|---|
| `v05-audit-lifecycle.test.mjs` | `disposal/bounded-close.test.mjs` |
| `rc4-cleanup-phase.test.mjs` | `disposal/cleanup-phase.test.mjs` |
| `close-matrix.test.mjs` | `disposal/close-matrix.test.mjs` |
| `rc3-close-paths.test.mjs` | `disposal/close-paths.test.mjs` |
| `rc4-close-invariants.test.mjs` | `disposal/close-reentry.test.mjs` |
| `rc4-retention.test.mjs` | `disposal/retention.test.mjs` |
| `v07-s2-state-and-ledger.test.mjs` | `disposal/state-and-ledger.test.mjs` |

## `errors/`

The error surface: which code a refusal carries, what its `details` say, and where each is thrown.

Audit numbers in these titles: T1, S6, S7, S8, S10.

| was | is |
|---|---|
| `v07-s7-env-state.test.mjs` | `errors/env-state.test.mjs` |
| `v07-s10-as-syna-error.test.mjs` | `errors/foreign-errors.test.mjs` |
| `v07-s7-invalid-descriptor.test.mjs` | `errors/invalid-descriptor.test.mjs` |
| `v07-s8-missing-implementation.test.mjs` | `errors/missing-implementation.test.mjs` |
| `v07-s6-reuse-errors.test.mjs` | `errors/reuse-errors.test.mjs` |
| `v06-t1-errors.test.mjs` | `errors/syna-error.test.mjs` |

## `refs/`

The handles a caller holds: `ServiceRef`/`InputRef` and their payloads, implementation references, slot state.

Audit numbers in these titles: A05, A06, R05.

| was | is |
|---|---|
| `v08-implementation-ref.test.mjs` | `refs/implementation-ref.test.mjs` |
| `v05-promises.test.mjs` | `refs/refs-and-payloads.test.mjs` |
| `v08-slot-state.test.mjs` | `refs/slot-state.test.mjs` |

## `inventory/`

The shape of the published surface: the recorded snapshots of `check`/`explain`/`inspect`/`catalog`, and the forms of earlier releases that must stay refused.

Audit numbers in these titles: A03, F16, F4, S1, S2.

| was | is |
|---|---|
| `v07-expired-forms.test.mjs` | `inventory/expired-forms-0.7.test.mjs` |
| `v08-expired-forms.test.mjs` | `inventory/expired-forms-0.8.test.mjs` |
| `v06-snapshots.test.mjs` | `inventory/snapshots.test.mjs` |

## `property/`

Randomised and differential tests: a brute-force reference planner, and graph invariants checked against an independent oracle.

Audit numbers in these titles: the reference planner differential; the rc.4 graph property test.

| was | is |
|---|---|
| `rc4-graph-property.test.mjs` | `property/graph-invariants.test.mjs` |
| `reference-planner.test.mjs` | `property/reference-planner.test.mjs` |

## Fixtures

`snapshots/` holds the 0.5.0 recording of `check`/`explain`/`inspect`/`catalog`
(`v05-explain-inspect.json`) and the rename mapping applied to it since
(`v05-renames.json`). Two suites read it: `inventory/snapshots.test.mjs`, which asserts
the recording still matches, and `refs/implementation-ref.test.mjs`, which takes the
pre-0.8 reference forms from it rather than spelling them again.

## Where the rest is

| suite | what it covers |
|---|---|
| `packages/core/type-tests/` | the types, compiled with `tsc` and never run |
| `apps/multitenant-blog/tests/` | the reference application: site manager, rendering, storage backends, the PostgreSQL matrix |
| `scripts/tests/` | the release gate's own tooling |
| `scripts/mutation-audit.mjs` | the standing counter-examples the suites above must reject (`work/rc5/mutations/RESULTS.json`) |
