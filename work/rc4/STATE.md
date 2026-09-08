# Syna 1.0.0-rc.4 — working state

Task book `work/tasks/SYNA_RC4_EXECUTION_PROMPT.md` (goal `work/tasks/SYNA_RC4_GOAL.txt`): the closing
paths again, from a three-way independent cross-review of 1.0.0-rc.3. Baseline 1.0.0-rc.3 = commit
`9c57269` (gate on `5ae7baf`; `work/rc3/STATE.md`). Eight items: N1, N2, N3, N4, N5, A4, G1, D2 —
the review's own analysis is `work/rc4/ROOT_CAUSE.md`, the pre-fix reading of every new test is
`work/rc4/BASELINE.md`, and the merged acceptance matrix is `work/rc4/MATRIX.md`.

The task book states guarantees, not implementations. Two of them shaped everything else: a cleanup
phase needs a life of its own — observable while it runs, detached from the frame that started it —
and the caller's deadline and the resource's cleanup are different clocks.

## The commits

- `b3fd24d` `chore(tasks)`: the task book and goal under `work/tasks/`, the reviewers' analysis, the
  pre-fix baseline and the eleven probes.
- `896a702` `fix(core)` **N1, N2, N3, N4, N5**: the cleanup phase as a value, one close per Env, the
  close set closed before any of it runs, the Env graph released, the waiter's deadline running to the
  end of the attempt. Five new test files; v07-s7's internal-invariant count 5 → 4.
- `2324bfa` `fix(app)` **A4**: one acquire deadline over the whole acquire, the shared creation never
  ended by one acquirer's deadline.
- `9a08b18` `test(gate)` **G1**: the wall-clock lower bound split into a structural half and a
  wall-clock half with a stated tolerance; the gate re-keyed to 1.0.0-rc.3 with no registered
  increment and no registered faster row; the recorded rc.3 baseline.
- `<docs>` `docs`: §11 and §13 clarified, `docs/SEMANTIC_CHANGES_RC4.md`, the reference and stability
  documents, the history, the changelog, and this file.
- `<release>` `release(rc.4)`: the version of every package and the lockfile.
- `<evidence>` `release(rc.4)`: the gate run, `docs/VALIDATION.md` and the release manifest.

## What each item became

- **N1 — a determined cleanup failure hidden by a later hang of the same phase.** `runCleanups()`
  records each failure as it happens instead of returning a list at the end, and the phase that owns
  those failures is a value: `CleanupPhase` (`packages/core/src/internal/materializer.ts`), with
  `errors`, `failed`, `done`, `take()` and `release()`. All four call sites go through it — the three
  rollback branches of `runAttemptRaw()`, the late close of `closeUnsettled()`, and the Ready-slot
  cleanup of `disposeServiceSlot()`. A close that abandons a phase takes what it has already
  determined and reports it; what fails afterwards is a late event, not a loss.
- **N2 — an abort listener re-entering `dispose()`.** `disposeEnv()` sets `env.closing` before the
  broadcast — before any user code of the close runs — and a `dispose()` that arrives from inside it
  gets `EnvImpl.joinClose()` rather than a second close. `dispose()` itself is the one line it was in
  rc.3 (`this.disposePromise ??= this.runtime.disposeEnv(this)`): `??=` assigns after the right-hand
  side is evaluated, so the real close overwrites whatever the re-entry left in the field, and
  `joinClose()` — one microtask, then `await this.disposePromise` — reads it after that assignment.
  Both callers settle on the same result, and a cleanup that throws is reported to both.
- **N3 — a child Env not marked when its parent aborts.** The broadcast has two passes: `markClosing()`
  moves the whole close set to `disposing` (it runs no user code, so nothing can observe it half done),
  then `abortClosing()` aborts the signals. `runtime.dispose()` does it in one pass over every root,
  so a listener of the first root cannot start work in a second that is still `ready`. Both passes
  descend only when `env.children.size !== 0`.
- **N4 — suspended frames holding `slot`/`owner`.** `CleanupPhase.release()` swaps the strong `slot`
  and `owner` references for `WeakRef`s, the sequence driver is reaction-driven (no `await` frame is
  suspended across a rollback), and the close releases `slot.ownerEnv` for every owned slot at the end.
  The `await` sweep is below.
- **N5 — a waiter that never settles.** A waiter's deadline is armed while the attempt is `running`,
  which now means "until the attempt ends" — the setup settled *and* the cleanup phase that settlement
  started ended (§11). A rollback that hangs therefore ends every wait at `loadTimeoutMs` with a
  `note` of its own instead of leaving `load()` and `enter()` pending for ever, without marking the
  attempt overdue (its setup did not outrun its deadline; its rollback did).
- **A4 — `acquireTimeoutMs` did not cover the creation.** `apps/multitenant-blog/src/site/manager.ts`
  gained `awaitCreationWithin()` on the same generic wait as `readConfigWithin()`: one acquirer's
  deadline ends that acquirer's wait, never the shared `record.creation`, which keeps running for
  whoever else is waiting on it. `create()` holds a lease of its own for its whole duration, and
  `shutdown()` cancels creation waiters as it cancels configuration waiters.
- **G1 — two zero-tolerance wall-clock lower bounds.** `close-matrix.test.mjs:249/:263` became two
  tests: a structural one that intercepts `globalThis.setTimeout` and asserts which budget each timer
  belongs to and the order of arming versus expiry (never a duration), and a wall-clock one that
  measures with `performance.now()` against the budget minus a stated 5 ms of timer slack.
- **D2 — the four clarifications** in `docs/SEMANTIC_MODEL.md` §11 and §13, collected with everything
  else this round changed in `docs/SEMANTIC_CHANGES_RC4.md`.

## The `await` sweep (N4)

Every `await` in `packages/core/src/internal/materializer.ts`, and what its frame holds if it is
suspended when the close ends:

| line | function | frame outlives the close? | what it holds |
|---|---|---|---|
| 386 | `awaitSettling` | no — `settlesWithin(..., graceMs)` | the `closing` promises, no slot |
| 423 | `startEagerSlots` | no — activation only | the eager slots |
| 438 | `settleSlots` | no — one grace | the slot list |
| 445, 479 | `settleSlot` | no — one grace, then the remaining budget | `slot`, `attempt` |
| 576, 590 | `disposeServiceSlots` | no — a budget per slot cleanup | the slot list |
| 859 | `startAttempt` | **yes** — the raw setup is user code | `slot`, `owner`; bounded by the user's own setup Promise (§13), which is what makes an abandoned attempt reachable at all |
| 1032 | `runAttemptRaw` | **yes** — same frame, the race | `slot`, `owner`; ends with the raw settlement, the deadline or the abort |
| 1375, 1378 | `handleLateSettlement` | no — the late reaction, `closeUnsettled()` is not `async` | `attempt`, `record`, `envId` (a string) |
| 1532 | `recoverFailedSlot` | no — `sleepAbortable` ends with the abort | the slot |
| 1626 | `disposeServiceSlot` | no — `settlesWithin(phase.done, disposalGraceMs)` | `slot`, `phase` |
| 1716 | `runCleanups` | **yes** — the cleanup itself may hang | the phase, `slotId` (a string), `record`; the phase holds `WeakRef`s after `release()` |

The three that can outlive a close are exactly the three the retention probe covers, and in all three
the Env graph is unreachable while the work is still outstanding (`work/rc4/probes/n4.mjs`,
`packages/core/tests/rc4-retention.test.mjs`). The rc.3 rollback path is gone: no frame is suspended
across a rollback any more, so nothing of the sequence driver is in the picture.

## The benchmark round: one case, and what it was really measuring

`site-enter-tenant-input-reverse-closure-200` (300 × `app.enter(Site, { tenant })` + `site.dispose()`,
plan cache 64) read **+17 % to +29 % on `timing.p95Ms`** against the rc.3 baseline while `p50Ms`,
`minMs` and the scavenge count of the whole workload were flat. Bisection over the compiled
`packages/core/dist/runtime.js` — an interleaved A/B harness that swaps that one file between
alternating runs of the workload and reports the median p95 over N runs — established what moved it:

| variant (each against the rc.3 compiled runtime) | p95 delta |
|---|---|
| byte-identical copy (control) | −1.0 % |
| one comment line at the top of the file (control) | +3.4 % |
| a comment line inside `disposeEnv()` (control) | −7.5 % |
| the two new class fields alone | −1.6 % |
| `closing = true` written on the common path | +3.9 % |
| `??=` expanded into an `if` and an assignment | −4.1 % |
| a method added to `EnvImpl` and never called | −9.3 % |
| **an inert, never-taken `if (…) this.roots.delete(env)` inside `disposeEnv()`** | **+25.8 %** |
| **a never-taken `this.reentrantClose?.adopt(…)` inside `dispose()`** | **+16.7 %** |
| **a second `for…of` over the owned slots** | **+30.4 %** |
| the same clearing merged into the existing `for…of` | +25.2 % |
| the same clearing in an indexed loop, plus the inert statement | +6.6 % |

A never-executed statement costs as much as the whole feature, so the row is not measuring the work
the close does; it is measuring whether V8 keeps this close path in the shape it had. The case's
per-iteration distribution is bimodal (a ~0.18 ms mode and a ~0.27 ms mode) and p95 sits in the sparse
region between them, so what the number reports is the fraction of iterations in each mode.

That is a reason to shape the code, not to change the statistic: `--no-maglev` and the element-wise
median of 21 rounds are exactly what they were. Two shapes were enough — `EnvImpl.dispose()` stays
rc.3's one line with the re-entrancy guard moved into `disposeEnv()`, where the window actually is,
and the close walks nothing it does not have to (one indexed pass over the owned slots; both broadcast
passes descend only when there are children). With those, all 23 rows are within ±10 %.

## Acceptance (§5 of the task book)

- **A01** — the planning layer is untouched: `git diff 9c57269..HEAD -- packages/core/src/internal/entry-planner.ts packages/core/src/internal/graph-builder.ts packages/core/src/internal/definition-compiler.ts packages/core/src/internal/plan-cache.ts` is empty; the reference-planner differential and the explain/inspect snapshots are verbatim.
- **A02** — the public API inventory is identical to the rc.3 record: 0 added, 0 removed, 0 changed, 0 doc-only (exports 92 → 92, members 232 → 232, union members 50 → 50). `docs/API_STABILITY.md` records "No exception — 1.0.0-rc.4"; `scripts/tests/api-inventory.test.mjs` asserts the zero increment.
- **A03…A08** — the eight items, cell by cell, in `work/rc4/MATRIX.md`; every new test was seen red (or hanging) against the pre-fix source before the fix, recorded per test in `work/rc4/BASELINE.md`.
- **A09** — the prohibitions held: no assertion requires an error to be reported "exactly once in total" across `dispose()` and the diagnostic channel (`rc3-close-paths.test.mjs:141-173` still asserts the two legitimate observers), and no test counts timers to prove concurrency — the structural G1 test asserts budget ownership and the arming/expiry order instead.
- **A10** — the three semantics that must not change are unchanged: an unfinished rollback starts no overlapping attempt, a success inside the rollback budget keeps the same-sequence retry rule, and a determined rollback failure keeps its `AggregateError` and `ROLLBACK_FAILED`.
- **A11** — benchmark 23/23 within ±10 % against a same-machine alternating rc.3, dispose rows included (`phase-breakdown-300.disposeMs` p50 +2.2 % / p95 +6.2 %; `warm-enter-dispose-*` +0.2 % … +3.4 %; the closure case p50 −0.1 % / p95 +0.6 %). `any` not increased (178 keywords = the 178 of the record).

Not done, deliberately: no tag, no push, no publish; no `materializer.ts` refactor (rc.5), no new public
name and no new public option, and nothing changed in the planning layer. What was found and left is in
`docs/DEFERRED.md` (S14 the dead `stopWaitingForCleanups`, S15, S16).

## Reproduce

- Probes: `node work/rc4/probes/n1.mjs`, `n2n3.mjs`, `n2-error.mjs`, `n5.mjs`, `waiter.mjs`,
  `waiter2.mjs`, `abort-throw.mjs`, `onevent.mjs`, `g1.mjs`, `extra.mjs`, `a4.mjs`, and
  `node --expose-gc work/rc4/probes/n4.mjs`. Each prints the flipped reading on this tree; against
  `9c57269` they print the defect (`work/rc4/BASELINE.md`).
- Suites: `npm run typecheck && npm test && npm run test:scripts && npm run test:app && npm run test:postgres && npm run demo && npm run demo:multitenant-blog`
  (then `git checkout -- work/v05/working-set.json; rm -rf work/demo-content`).
- The close matrix alone: `node --test packages/core/tests/close-matrix.test.mjs`; this round's tests:
  `node --test --expose-gc packages/core/tests/rc4-*.test.mjs` and
  `node --test apps/multitenant-blog/tests/rc4-acquire-deadline.test.mjs`.
- The benchmark by hand, fewer rounds:
  `node scripts/benchmark-same-session.mjs --commit 9c57269 --baseline-label 1.0.0-rc.3 --runs 7 --out-dir <dir>`.
  The A/B harness used for the bisection swaps `packages/core/dist/runtime.js` between alternating runs
  of `benchmarks/v0.5-planning.mjs` and compares the median p95 of one case; it is a diagnostic, not a
  gate step.
- Gate: `node scripts/verify-release.mjs --release` alone (about seven minutes; PostgreSQL 17 binaries
  or `SYNA_TEST_PG_URL`; the git history with `9c57269` for the same-session comparison, else
  `benchmarks/results-v1.0.0-rc.3-baseline-same-machine.json`). Then `node scripts/validation-doc.mjs`
  and commit `RELEASE_MANIFEST.json`, `validation/v1.0.0-rc.4-release/` and `docs/VALIDATION.md`
  together; the step logs stay untracked (`*.log`).
