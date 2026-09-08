# 1.0.0-rc.5 — the baseline: what the rc.4 tests let through

The third independent review (`work/rc5/README_ZH.md`) reports no production defect in
1.0.0-rc.4. What it found is that two wrong implementations pass the rc.4 suite. Before
anything was changed this round, both were reproduced here, on this machine, from this
workspace's own build — the review ran Node 22.16.0 on Linux against the CI artifact, so
the numbers below are an independent second measurement, not a quotation.

```
node scripts/mutation-audit.mjs --expect-survival     # (with the rc.4 test lists)
```

| mutant | what it changes | tests run | result on rc.4 |
|---|---|---|---|
| **M1** `join-premature` | both `joinClose()` methods in `packages/core/dist/runtime.js` become `await null; return` | the five rc.4 files (`rc4-cleanup-phase`, `rc4-close-invariants`, `rc4-graph-property`, `rc4-retention`, `rc4-waiter-termination`) | **55 / 55 pass — SURVIVED** |
| **M2** `deadline-4x` | `deadlines.add(waiter, performance.now() + Math.max(0, deadlineMs))` becomes `deadlineMs * 4` | `rc4-waiter-termination` | **8 / 8 pass — SURVIVED** |

Recorded run: `work/rc5/mutations/rc4-baseline.json` (Node v26.0.0, commit `aba7c94`,
2026-09-08). Both mutants were applied to an isolated copy of the compiled core under
`work/mutations/`; neither the sources nor the workspace's own build was touched. The
counts match the review's `work/rc5/evidence/mutation-results.json` exactly.

## Why they passed

**M1.** The real close still runs, still executes its cleanups once and still reports its
failure — to the caller that started it. Only the *re-entering* caller is answered early,
with success. `rc4-close-invariants.test.mjs:78-85` checked the outer caller's outcome
(`notEqual(closed, 'resolved')`) and, for the inner one, wrote `await codeOf(holder.inner)`
without asserting the value. `cleanupRuns === 1` cannot see the difference either: one
close ran, exactly as it should have. Nothing in the file observed the inner caller *while*
the cleanup was still running, so an observer that had already been let go looked the same
as one that was still waiting.

**M2.** A 40 ms deadline that fires at 160 ms is inside `35 ≤ elapsed < 400`; the eager
case only asked for `elapsed < 1000` against an expectation of 80 ms. The reported
`details.deadlineMs` still said 40, because the mutation changes the arming, not the
report. Every other assertion in the file is about codes, notes, ledger states and setup
counts, all of which the mutant preserves.

Neither gap is fixed by a narrower window. A wall-clock bound wide enough not to flake on a
loaded machine is wide enough to hold a deadline that is wrong by a factor — and rc.4's own
G1 finding was that tightening such a bound to zero tolerance is what made the release gate
flaky. The criterion has to change, not the threshold.

## What now kills them

| mutant | killed by | how |
|---|---|---|
| M1 | `rc4-close-invariants.test.mjs` — the eight-path re-entry matrix, both endings | while the cleanup is still held open, *both* observers must still be pending and the Env must not be `disposed`; after the release both must be answered by that one close, each carrying the same underlying cleanup failure exactly once |
| M2 | `rc4-deadline-clock.test.mjs` — five cases on a clock the test owns | the clock is advanced to the millisecond before the deadline (nothing has happened) and to the deadline (the wait has ended); the eager case separates the internal deadline, the bounded close that follows it, and the result the public Promise finally carries |

`rc4-waiter-termination.test.mjs` keeps the end-to-end wall-clock evidence — a real
process really does give up after a real timeout — with the tolerance now stated as what
it is: `SLACK = 5` ms for a timer that may fire early, `TOLERANCE = 250` ms for process
scheduling. It is not what proves when a deadline fires, and it does not pretend to be.

The record the release gate reads is `work/rc5/mutations/RESULTS.json`; it carries the
SHA-256 of every source and test file the run was produced from, so a stale record cannot
pass for evidence.
