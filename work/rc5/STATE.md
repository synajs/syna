# Syna 1.0.0-rc.5 — working state

Task book `work/tasks/SYNA_RC5_EXECUTION_PROMPT.md` (goal `work/tasks/SYNA_RC5_GOAL.txt`); the third
independent review of 1.0.0-rc.4 and its material are in `work/rc5/README_ZH.md`,
`work/rc5/evidence/` and `work/rc5/probes/`. Baseline
1.0.0-rc.4 = commit `b691067` (gate on `e96871b`; `work/rc4/STATE.md`).

The review found no defect in the production code. What it found is that the tests did not hold the
invariants they claimed: two counter-examples — a re-entering observer answered early, and every
waiter deadline armed at four times its configured value — survived the whole rc.4 suite (55/55 and
8/8). So this round changes **no production behaviour**. Part A makes the tests prove the promises;
Part B then uses the repaired tests as a net for internal quality.

## The commits

- `aba7c94` `chore(audit)`: the third review, its probes and the two mutation patches.
- `bf6cdf9` `chore(rc.5)`: the task book, the independently reproduced mutation baseline
  (`work/rc5/BASELINE.md`) and `scripts/mutation-audit.mjs`.
- `907b708` `test(core)`: the re-entry matrix (M1) and the controlled clock (M2).
- `4563861` `test(core)`: the `onEvent` re-entry case, the four retention paths, the cleanup-phase
  gates and the active waiter in the no-overlap case.
- `c7ec8b9` `test(app)`: the acquire deadline proved by varying it.
- `f424017` `docs`: the four corrections the review asked for.
- `be0ba79` `refactor(core)`: `materializer.ts` splits into the concerns it orchestrates.
- `35b20c8` `refactor(tests)`: the core suites grouped by behaviour domain.
- `f4abe75` `build(gate)`: one gate script, one profile per release, `docs/VALIDATION.md` back in the
  archive.
- `d06bcf9` `docs`: `docs/SEMANTIC_CHANGES_RC5.md`, the changelog, the history, and the one item
  withdrawn rather than delivered.
- `e80440d` `fix(gate)`: the deadline mutant names the source its statement now lives in.
- `b619983` `test`: the endings four core cases and one example asserted are no longer the collector's
  to choose (what the first release run found; below).
- the evidence commit: the gate run, `docs/VALIDATION.md` and the release manifest.

## Part A — the tests prove the promises

The two counter-examples are the criterion of this round. `node scripts/mutation-audit.mjs` builds an
isolated copy of the compiled core under `work/mutations/`, applies one mutant, runs the tests that
must object, and writes `work/rc5/mutations/RESULTS.json` with the source and test hashes it was
produced from. It is a manual audit, not a gate step; the gate reads the record and checks it belongs
to this tree.

- **M1 — `joinClose()` fulfils one microtask early** (both methods, `packages/core/src/runtime.ts`).
  rc.4: 55/55 passed. rc.5: `disposal/close-reentry.test.mjs` is a matrix of eight re-entry paths ×
  two endings. Each cell holds the close on a gate and asserts that *before* the gate is released
  neither the outer caller nor the re-entering observer has settled and the Env is still `disposing`,
  and that after it both are answered by that one close — both rejecting with the same underlying
  cleanup failure, present exactly once in each, or both fulfilling. 12 of 51 cases fail on the mutant.
- **M2 — every waiter deadline armed at four times its timeout**
  (`packages/core/src/internal/deadline-queue.ts`). rc.4: 8/8 passed, because the assertions were
  upper bounds (`< 400`, `< 1000`) wide enough to hold both readings. rc.5:
  `materialization/deadline-clock.test.mjs` runs five cases in child processes on a clock the test
  owns — `setTimeout`/`clearTimeout`/`Date.now`/`performance.now` replaced, time advanced explicitly —
  and observes the moments separately: nothing has happened at the millisecond before the deadline,
  the wait has ended at the deadline itself, and for eager activation the internal deadline, the
  bounded close it starts and the public `enter()`'s result and cause are three separate assertions.
  The end-to-end wall-clock evidence stays in `materialization/waiter-termination.test.mjs` with its
  tolerance written down (5 ms timer earliness, 250 ms scheduling), not narrowed. 5 of 13 cases fail
  on the mutant.
- **The `onEvent` re-entry case** produced no diagnostic at all (measured: the callback ran 0 times).
  It now forces a real `attempt-abandoned`, asserts the callback happened *first*, and only then
  asserts that the close it re-entered answers it with the same failure.
- **`disposal/retention.test.mjs`** said "the same four paths" and exercised two. It now uses four
  Services — a pending setup, a Ready slot's cleanup, a failed setup's rollback, an attempt that
  settles after the close — and asserts the ledger reads `abandoned` / `abandoned` / `rolling-back` /
  `settling`. Why a fixed number of collection rounds is enough, and why nothing in the loop may call
  `deref()` (it keeps its target alive for the rest of the job), are written down in the file.
- **`disposal/cleanup-phase.test.mjs`** replaced `sleep(5)` / `sleep(20)` with phase gates: the attempt
  has started, the close has entered, the phase has reached the step that hangs, the ledger is empty.
  Each case carries an independent watchdog that is never treated as a semantic deadline.
- **The no-overlap case** had five `load()` calls with an already-aborted signal, all refused before
  they could reach the shared attempt. It now adds a waiter that genuinely waits: it joins the same
  attempt, the setup count stays 1, and it leaves at its own deadline while the rollback is still held.
- **The application's three upper bounds** (`< 400`, `< 600`, `< 1000`) became bounded pairs on a
  monotonic clock, plus a case that changes the criterion instead of the window: the same scenario runs
  at 60 ms and at 360 ms and the difference between the two waits must be the difference between the
  two configurations. A4's original assertions still pass.
- **Four documents corrected**: `SEMANTIC_CHANGES_RC4` §3.2 described an early candidate design rather
  than what was built (entered guard + deferred join); `SEMANTIC_MODEL` §11 now says that a rollback
  waiter's expiry emits no `attempt-overdue` and states the two eager guarantees (the internal waiter
  ends at `loadTimeoutMs` and starts the close; the public `enter()` rejects after that bounded close);
  the coverage claim follows the real matrix (Ready 6 + rollback 6 + discarded-late-success 3 +
  late-settlement 3 + unreachable 1 = 19 cells) instead of "5×6=30". `enter()` was deliberately *not*
  changed to throw at the load timeout.

## Part B — internal quality, with the repaired tests as the net

- **`materializer.ts` 1720 → 601 lines**, split into `attempt.ts`, `cleanup-phase.ts`,
  `deadline-queue.ts`, `attempt-ledger.ts` and `slot-disposal.ts`. The criterion was that the suites
  pass without one character changed, and they do. Two structural constraints shaped it: the
  compiled-output scan tests list `dist` and `dist/internal` non-recursively (so the layout stays
  flat), and the `Syna internal invariant` count belongs to `materializer.ts` (so both sites stay there).
- **The core tests are grouped by behaviour**: `planning/`, `materialization/`, `disposal/`, `errors/`,
  `refs/`, `inventory/`, `property/`, audit numbers kept for traceability, content moved and not
  rewritten, with `packages/core/tests/README.md` carrying the complete old → new mapping table.
- **One gate**: `verify-v05/v06/v07/v08` merged into `scripts/verify-release.mjs`, with one JSON profile
  per release under `scripts/release-profiles/` — the historical ones extracted from each release's own
  manifest so an old release can still be reproduced, and `1.0.0-rc.5.json` carrying this release's
  constants and its ordered step list. The last step of every run compares the steps it actually ran
  with that list.
- **`docs/VALIDATION.md` is in the source archive again**, and still excluded from the fingerprint.
- **Withdrawn**: the `descriptors.ts` split (§3.5 of `docs/SEMANTIC_CHANGES_RC5.md`). Four tests read
  `dist/descriptors.d.ts` by name, and TypeScript's declaration emit follows module structure, so the
  split moves public declarations out of that file. The task book's rule — stop and report rather than
  change tests to fit a refactor — applies, and it was reverted.

## What the release gate found

Three release runs. Each one is recorded; the release is the third.

**On `e80440d` — PARTIAL.** One step failed: `rebuild-examples`, inside the copy unpacked from the
source archive, on `apps/07-failure-modes` — `close took 2 ms`, while the same program had passed in
the workspace minutes earlier in the same run. Scene 4's hung setup parked on a Promise nothing
referred to any more, so a collection in that window let the Runtime prove the attempt dead and close
it as `attempt-unreachable`; the scene asserted the other ending. A probe forcing a full collection
every 10 ms found four core cases with the same shape. All five are repaired in `b619983`
(`work/rc5/evidence/gc-pressure.md`); nothing in the production source changed, and the example's
printed line — with it the gate's expectation of that line — is unchanged.

**On `b619983`, first attempt — one failed step: `benchmark-compare`**, `materializationMs.p95Ms`
+14.0 %, everything else within ±10 %. Repeating the identical comparison put that row at −0.2 % and
failed `warmPlanMs.p95Ms` at +12.1 % instead. A null experiment — the same commit compared against
*itself*, same script, same 21 alternating rounds — missed the band on two rows by +19.3 % and
+15.8 %. The machine was carrying about seven runnable threads of unrelated work (`load 6.85`, a
100 % CPU Steam process, a Rust build), and the failing rows are all sub-phases of
`phase-breakdown-300` measured in tens of microseconds. The statistic was not touched: not the
tolerance, not the percentile, not the number of rounds, not the flags. The measurements are in
`work/rc5/evidence/benchmark-noise.md`.

**On `b619983`, second attempt — COMPLETE**, with the machine quieter: 23/23 rows within ±10 %
(`materializationMs` p50 −3.0 %, p95 −4.3 %; `disposeMs` p50 −1.1 %, p95 +1.2 %), and the
informational drift against the recorded rc.4 baseline also 23/23.

## The release gate on `b619983` — COMPLETE

```
== COMPLETE == 1132 test executions (566 distinct cases, 566 re-run in the rebuilt copy),
               1132 passed, 0 failed steps, 0 skipped tests
55 steps, provenance b619983 dirty=false, 396 source files,
fingerprint aef69d271c317bf8ae94a7e3021a5229c7fd53717b4d00b0dcc7928c49e6a8db
Node v26.0.0 darwin arm64; PostgreSQL 17.10 on a temporary cluster (127.0.0.1:54329)
```

| archive | bytes | sha256 |
|---|---|---|
| `work/release/syna-v1.0.0-rc.5-source.tar.gz` | 929722 | `553c31bddc38e467dd0b2bc0f3c35f7e061c00679c9dc28d7f55097dfbe85d69` |
| `work/release/syna-v1.0.0-rc.5-source.zip` | 1174681 | `1f8bcd94d4dcbc8fee24da632bb13880b8222652b58eb05f2d1cad4bee625459` |
| `work/release/pack/syna-core-1.0.0-rc.5.tgz` | 132791 | `d40c72c86c38630c48da2eb579d472ad6a03b14058ce3584c75be60eb972c4d0` |
| `work/release/pack/syna-tsconfig-1.0.0-rc.5.tgz` | 1573 | `0a2830dd36533a65066c2ab0f847432de5416e3bb8cd67b7e1ff2aad8fe38c48` |

The COMPLETE reading is from the archive: `rebuild-unpack` … `rebuild-examples` unpack
`syna-v1.0.0-rc.5-source.tar.gz` (470 files, `docs/VALIDATION.md` among them) into a scratch
directory, install from the lockfile, build and re-run every suite there (338 core, 145 app, 45
PostgreSQL, 38 gate self-tests), then `pack-core` / `pack-tsconfig` / `consumer-install` /
`consumer-build` / `consumer-run` install the packed tarballs into a fresh consumer project and run
it. The last step, `release-profile`, compares the 55 steps the run recorded with the list in
`scripts/release-profiles/1.0.0-rc.5.json`.

## Acceptance (§6 of the task book)

- **A01 — no production behaviour changed.** `git diff b691067..b619983 -- packages/core/src` is the
  §4.1 split and nothing else: six files, `materializer.ts` −1255, five new modules +1256, the delta
  being imports, class boundaries and constructor wiring. The planning layer is byte-identical
  (`git diff b691067..HEAD -- .../entry-planner.ts .../graph-builder.ts .../definition-compiler.ts
  .../plan-cache.ts .../lineage.ts` is empty), the explain/inspect snapshots are unchanged, and the
  public inventory is identical to the rc.4 record: exports 92 → 92, members 232 → 232, union members
  50 → 50, **0 added / 0 removed / 0 changed / 0 doc-only** (`validation/v1.0.0-rc.5-release/api-inventory-diff.md`).
- **A02 — M1 killed.** `work/rc5/mutations/RESULTS.json`: on the isolated copy, 51 cases run, 39 pass,
  **12 fail**, one for each of the eight re-entry paths × the two endings that assert the pair.
- **A03 — M2 killed.** 13 cases run, 8 pass, **5 fail**: the four controlled-clock cases and the
  pending-setup control. The internal deadline, the bounded close that follows it and the public
  `enter()`'s result are asserted separately; the end-to-end wall-clock check is still there, with its
  tolerance stated rather than narrowed.
- **A04** — `close-reentry.test.mjs:238` asserts `seen.length > 0` before reading any outcome;
  `retention.test.mjs` exercises the four paths its title claims; `cleanup-phase.test.mjs` has no
  `sleep`-based phase assumption left; the no-overlap case has a waiter that actually waits.
- **A05** — the application's three upper bounds are bounded pairs on a monotonic clock plus the
  differential case; A4's original assertions still pass (`rc4-acquire-deadline.test.mjs`).
- **A06** — the four corrections are in `SEMANTIC_CHANGES_RC4` §3.2, `SEMANTIC_MODEL` §11,
  `API_REFERENCE` and the coverage table (19 cells, by the real matrix).
- **A07** — the split passes with the suites unchanged (not one character); `packages/core/tests/README.md`
  carries the old → new mapping with the audit numbers; the gate is one script with one profile per
  release and every historical step list preserved under `scripts/release-profiles/`.
- **A08** — benchmark 23/23 within ±10 % with the dispose rows not regressing (p50 −1.1 %, p95 +1.2 %);
  `any` 178 keywords, exactly the recorded baseline; the gate rebuilt from the archive and printed
  COMPLETE with `provenance dirty=false`; `docs/VALIDATION.md` is inside the archive and still outside
  the fingerprint.

Not done, deliberately: no tag, no push, no publish; `enter()` still rejects after the bounded close
rather than throwing at the load timeout; the `descriptors.ts` split is withdrawn, not deferred
silently (`docs/SEMANTIC_CHANGES_RC5.md` §3.5).

## Reproduce

- Mutation audit (manual, never in CI): `node scripts/mutation-audit.mjs` — builds
  `work/mutations/<name>/` from the compiled tree, applies each mutant, runs the tests that must
  object, rewrites `work/rc5/mutations/RESULTS.json`. The gate's `mutation-audit-record` step only
  reads that file and checks the six source and test hashes against this tree.
- The GC probe: `node --expose-gc --import file://<dir>/gc-pressure.mjs --test --test-reporter=tap
  'packages/core/tests/**/*.test.mjs'` with the module in `work/rc5/evidence/gc-pressure.md`;
  `NODE_OPTIONS='--expose-gc --import file://<dir>/gc-pressure.mjs' npm run demo` for the examples.
- Suites: `npm run typecheck && npm test && npm run test:scripts && npm run test:app &&
  npm run test:postgres && npm run demo && npm run demo:multitenant-blog`
  (then `git checkout -- work/v05/working-set.json; rm -rf work/demo-content`).
- This round's core cases: `node --test packages/core/tests/disposal/close-reentry.test.mjs
  packages/core/tests/materialization/deadline-clock.test.mjs
  packages/core/tests/disposal/cleanup-phase.test.mjs`, and
  `node --test --expose-gc packages/core/tests/disposal/retention.test.mjs`.
- The benchmark comparison by hand: `node scripts/benchmark-same-session.mjs --commit b691067
  --baseline-label 1.0.0-rc.4 --record benchmarks/results-v1.0.0-rc.4-baseline-same-machine.json
  --runs 21 --faster-ok '' --faster-floor 0.30 --out-dir <dir>`. Pass `--commit b619983` for the null
  experiment. Run it on an idle machine: the `phase-breakdown-300` sub-phase rows are tens of
  microseconds and do not survive a loaded one.
- Gate: `node scripts/verify-release.mjs --release` alone (about five minutes; PostgreSQL 17 binaries
  or `SYNA_TEST_PG_URL`; the git history with `b691067` for the same-session comparison). Then
  `node scripts/validation-doc.mjs` and commit `RELEASE_MANIFEST.json`,
  `validation/v1.0.0-rc.5-release/` and `docs/VALIDATION.md` together; the step logs stay untracked.
