# Independent audits (AUDIT)

Three fresh-context reviewers examined the v0.5 workspace without access to the implementer's conversation, with the source, the task book (`SYNA_V05_EXECUTION_PROMPT.md`) and the documents as their only input. Each reviewer wrote executable probes, reported PASS/FAIL per attack with observed values, and produced a report. The reports, probes and captured outputs are archived under `docs/audit/<line>/` (probe import paths adjusted from `work/v05/audit/<line>/` to `docs/audit/<line>/`; two strings in the cache-delivery report were reworded so the archive scan for home paths and credential-bearing connection strings stays clean, as noted at the top of that copy; the reviewers' working copies stay verbatim under `work/v05/audit/`, outside the archive).

| line | reviewer input | commit reviewed | probes | report |
|---|---|---|---|---|
| Promise semantics / lifecycle (`packages/core`) | catch/degrade, background loads, `Promise.race`, late resolution, cancellation, retry, cleanup failures, disposal order, stop signals, deadlines | `afb8396` (dist built from the working tree) | 13 probes, 148 checks | `docs/audit/promise-lifecycle/REPORT.md` |
| Application / permissions / resources (`apps/hyla-mini`) | two tenants, private realms, override coherence, `C.all` factory sharing, site lease vs. configuration race, shared pool ownership and closing, static export, process hygiene | `afb8396` | 10 probes (2 on real PostgreSQL), ~250 checks | `docs/audit/app-permissions/REPORT.md` |
| Cache / delivery / developer experience | R17 neutrality, R18/P04 churn, benchmarks and budgets, G1 archive rebuild in a clean directory, TypeScript consumer, deprecated paths, orchestrator transparency | `05a3a75` (`git archive` into `mktemp -d`) | 8 probes + own rebuild driver (`rebuild-logs/`) | `docs/audit/cache-delivery/REPORT.md` |

Commit hashes: the git history was rewritten on 2026-09-05 to correct the author identity (trees, dates and messages unchanged). The archived reports cite the pre-rewrite hashes; `0240b6f` is now `afb8396` and `e2a6c73` is now `05a3a75`.

Reviewers modified nothing under `packages/`, `apps/`, `docs/`, `scripts/`, `benchmarks/`; they ran alone against their own PostgreSQL data directories. Their timing numbers were recorded while other audits were running (stated in the reports).

Paths under `work/v05/` cited in this document (the ISSUES/DECISIONS/STATE ledgers, a round's probes before they are archived) are repository-only: the source archive built by `scripts/verify-v05.mjs --release` never contains `work/`. Every reviewer's probes and report are archived under `docs/audit/`, which the archive does contain.

## Findings and their resolution

Severity is the reviewer's. Status is after the fixes in this workspace. Regression tests: `packages/core/tests/disposal/bounded-close.test.mjs` (lifecycle, 14 tests), `packages/core/tests/planning/explain-missing-inputs.test.mjs` (planning, 4 tests), `apps/hyla-mini/tests/audit-app.test.mjs` (application, 12 tests) and two new repository-conformance cases run against both backends. Issue numbers refer to `work/v05/ISSUES.md`.

### Promise / lifecycle

| finding | severity | status | fix | regression |
|---|---|---|---|---|
| F-PL-01 `dispose()`/`run()`/failed `enter()` waited for the full initialization deadline of running attempts (forever with `Infinity`) | major | fixed (I-17) | every in-flight attempt gets at most `disposal.graceMs`, per slot concurrently; running attempts are abandoned through a third arm of the deadline race and their late result is still discarded, cleaned and reported | F-PL-01 ×3 (30 s deadline, `Infinity`, cooperative signal control) |
| F-PL-02 `onDispose()` after the deadline threw and leaked the late resource | major | fixed (I-18) | accepted while the raw setup Promise is pending; refused once settled | F-PL-02 ×3 |
| F-PL-03 ancestor disposal did not broadcast to descendants before waiting; siblings accepted new work | major | fixed (I-19) | the whole subtree is marked `disposing` and every signal aborted synchronously; children and roots close concurrently | F-PL-03 ×2 |
| F-PL-04 Env reported `disposed` and left `inspect()` while an abandoned attempt still ran | minor | fixed (I-20, M-18) | Env stays `disposing` and registered until abandoned attempts settled and descendants finalized; `runtime.dispose()` re-reports | F-PL-04 ×2, K08 test updated |
| F-PL-05 disposal order lost A→(dormant B)→C | minor | fixed (I-21) | adjacency traverses non-disposable intermediates | F-PL-05 |
| F-PL-06 forgotten `load()` was an unhandled rejection only on some paths | minor | fixed (I-22, M-19) | every caller gets its own Promise | F-PL-06 ×2 (incl. `--unhandled-rejections=strict` child process) |
| F-PL-07 pre-aborted `signal` started the dormant slot | minor | fixed (I-23) | checked before the slot is touched | F-PL-07 |
| F-PL-08 a disposed child handle can start parent-owned dormant slots | uncertain | documented (D22) | refs are slot-bound; validity follows the owner Env (API_REFERENCE lifecycle notes) | — |

### Application / permissions / resources

| finding | severity | status | fix | regression |
|---|---|---|---|---|
| F-AP-01 SiteEnv rotated while creating was never disposed | major | fixed (I-35) | `settle()` after creation/join; sweep disposes idle draining records; acquire retries bounded by `acquireTimeoutMs` (I-48) | F-AP-01 |
| F-AP-02 `invalidate()` made the tenant unacquirable while a lease was held | major | fixed (I-36) | per-tenant generation in the SiteEnv key | F-AP-02 |
| F-AP-03 URL parsing exceptions escaped both HTTP handlers | major | fixed (I-37) | 400 for unparsable targets; `guarded()` wrapper; dot-files refused | F-AP-03 ×2 |
| F-AP-04 page cache never invalidated by content changes | major | fixed (I-38, D25) | store `contentVersion()` (PostgreSQL table / filesystem file, advanced in every mutation) in the cache key | F-AP-04; conformance case on both backends |
| F-AP-05 fast-failing creation not single-flight | minor | fixed (I-39) | backoff re-checked after the store round-trip; `SITE_CREATION_BACKOFF` with `cause` | F-AP-05 |
| F-AP-06 internal diagnostics echoed to clients | minor | fixed (I-40, D29) | generic bodies with codes; `onError` hook | F-AP-06 |
| F-AP-07 `pool.end()` twice on failed setup | minor | fixed (I-41) | `onDispose` registered after the probe | F-AP-07 |
| F-AP-08 static builder deleted files it never wrote | minor | fixed (I-42, D28) | `.hyla-build.json` manifest; only listed files removed; foreign non-empty directories refused | F-AP-08 |
| F-AP-09 `stop()` during `start()` lost | minor | fixed (I-43) | `starting` state; stop wins | F-AP-09 |
| F-AP-10 interface-incompatible authenticator override failed on the first request | limitation | fixed in the app (I-44) | shape check at site creation; the core cannot check TypeScript interfaces at runtime (K11) | F-AP-10 |
| F-AP-11 `createHylaApp()` resolved without touching the database; runtime kept on failure | minor | fixed (I-45) | store loaded at startup inside a try/catch that disposes the runtime | F-AP-11 |
| F-AP-12 `close()` discarded the unreleased-lease report | minor | fixed (I-46) | `close()` returns `HylaShutdownReport` | F-AP-12 |
| F-AP-13 a tenant claiming another tenant's domain stopped the whole domain table | limitation | fixed (I-47, D26) | stores refuse the save (`DomainConflictError`); a conflicted host is served to nobody and listed in `DomainTable.conflicts` | F-AP-13; conformance case on both backends |

### Cache / delivery / developer experience

| finding | severity | status | fix | regression |
|---|---|---|---|---|
| F-CD-01 `explain()` reported empty `missingInputs`/`missingBindings` for deep requirements | major | fixed (I-25) | missing ids collected from deep `details.missing` and nested `details.failures` | F-CD-01 |
| F-CD-02 candidate-independent failures wrapped into `UNSATISFIABLE_TOPOLOGY`; code depended on `requires` order | major | fixed (I-26, D27) | identical failures across all candidates are rethrown under their own code | F-CD-02 + control |
| F-CD-03 no evidence run matched the shipped source; G1 not run; root `SHA256SUMS.txt` is the task-document list | major (delivery) | closed by the release run (I-27, D23) | `node scripts/verify-v05.mjs --release` on the final source; release hashes in `validation/v0.5-release/SHA256SUMS.txt` | `docs/VALIDATION.md`, `RELEASE_MANIFEST.json` |
| F-CD-04 template keys embedded the parent's whole signature | minor | mitigated (I-28) | key carries a compact digest, parent signature verified on hit; the template's own signature is retained for its children | F-CD-04 |
| F-CD-05 tests rewrote tracked `validation/working-set.json` | minor | fixed (I-29, D30) | `SYNA_WORKING_SET_OUT`; provenance captured before the first step | orchestrator |
| F-CD-06 failing `todo` test passed the gate | minor | fixed (I-30) | `todo`/`cancelled` count as not run | orchestrator |
| F-CD-07 benchmark coverage gaps (BoundEntry case timed a one-node graph; v0.4 delta understated) | minor / limitation | fixed / documented (I-31) | `bound-entry-private-range-request-enter-dispose-100` plans a request chain under a budget; VALIDATION.md reports per-case deltas; backend request timing remains unmeasured | `benchmarks/budgets.json` |
| F-CD-08 manifests embedded absolute host paths | minor | fixed (I-32) | `<root>` substitution | orchestrator |
| F-CD-09 packed core README pointed at unshipped docs | minor | fixed (I-33) | README says where the docs live | — |
| F-CD-10 `run()` finalized on `exit` | uncertain | fixed (I-34) | `close` event; SIGTERM before SIGKILL | orchestrator |

## How the fixes were verified

- Each confirmed defect has a regression test that failed against the audited build and passes now; the full suites (core, type tests, application on the filesystem backend, PostgreSQL + matrix on a temporary cluster, benchmarks with budgets) pass on the fixed source. The release run records the exact counts (`docs/VALIDATION.md`).
- The reviewers' own probes were re-run against the fixed build. Remaining FAIL lines are behaviour changes made on purpose and are listed at the end of `work/v05/ISSUES.md` (for example the tenant-isolation probe whose own setup gives tenant beta alpha's domain, which the store now refuses). The lifecycle probe that expected `rootEnvCount 0` while an abandoned attempt is outstanding was right after all: the second review round (below) made the bounded close detach the Env.
- The fixes were verified by the implementer, not by a second independent audit. No claim is made that the code is defect-free; the claim is that every finding above is either fixed with a regression or documented as a decision or limitation.

## Residual risks and limitations

- `DependencyRef`s obtained from a disposed child keep working while the owner Env lives (D22). Callers that want child-scoped validity must hold refs from the child's own slots.
- Plan-cache templates still retain the graph plus their own signature; memory is bounded by `planCache.maxEntries`, not by template size.
- Runtime cannot verify behavioural compatibility of `override()`; only TypeScript checks instance types. Hyla-mini checks the authenticator shape at site creation.
- Hyla-mini request latency including PostgreSQL round trips is reported end to end by `benchmarks/hyla-request-latency.mjs` (gate step `hyla-request-latency`, VALIDATION section) but is not a budget.
- The CI `release-gate` job (`.github/workflows/ci.yml`) has not run in the cloud: the repository had not been pushed when it was written; only its syntax and the scripts it calls are verified locally.
- Filesystem publishing (content store and static builder) is per-file atomic, never multi-file ACID (H03); a process crash between a content write and its version bump is repaired at the next read, not prevented: the pending-version marker bumps the version, and two files left with one post id by a crash inside a rename are read as one post (the copy at the layout path, else the highest revision) with the surplus copy removed by the next save or delete of that post. Durability is a process-crash guarantee: nothing is fsync'ed, so after a power loss a rename may be durable while its data is not (D65).
- Content-version invalidation covers writers that go through the repositories; a foreign process writing the filesystem store without touching `content.version` is not detected.
- A `setup()` that ignores its stop signal past `disposal.graceMs` keeps running with dependencies that were closed in the normal order (second review round, item 4c). The report names those dependencies; the model cannot prevent the situation (see below).

## Second review round (2026-09-05)

After the audit fixes above, four items were reported by different reviewers. Each was reproduced with a probe against the fixed build, then either fixed with a regression test (`packages/core/tests/materialization/retry-and-late-results.test.mjs`, 6 tests; `apps/hyla-mini/tests/review-app.test.mjs`, 6 tests) or shown to be inherent to the semantic model and made explicit in the reports. Issue numbers I-50…I-57 in `work/v05/ISSUES.md`; decisions D31…D34.

| item | finding | status | fix | regression |
|---|---|---|---|---|
| 1, 4 | a failed rollback did not stop recovery: under `afterExhaustion: 'retry-on-next-load'` the next `load()` after the cooldown started a new attempt whose resources stacked on the ones the failed cleanup left behind (K08: a failed rollback must not be ignored and retried past) | fixed (I-50, D32, M-20) | `ServiceSlot.rollbackFailed` is permanent: recovery, and the re-check after the cooldown, reject with `ROLLBACK_FAILED` (`cause`: the cleanup error); a late cleanup that fails marks the slot the same way. A clean rollback still recovers | R-1 ×2, each with a clean-rollback control |
| 1, 4 | a caught `LOAD_CANCELLED` could still end in an unhandled rejection: the shared setup Promise the waiter had been attached to rejected later with nobody listening | fixed (I-51) | `waitWithSignal` takes over the shared Promise's rejection before rejecting the caller; every cancellation path (running/timed-out/abandoned attempts, dormant slots, closing owners, `run()`/`enter()`) exercised under `--unhandled-rejections=strict` | R-1/R-4 battery (14 paths in a child process) |
| 2 | a SiteEnv whose creation failed after it had been entered (authenticator shape check, manager closed meanwhile) was never disposed | fixed (I-52) | the record owns the Env from the moment it is entered; every failure path closes it | R-2 leak |
| 2 | eviction returned the unit of capacity before the evicted Env's close had settled, so `capacity` could be exceeded while closes were in flight | fixed (I-53, D33) | records enter a `disposing` state that keeps the unit until `dispose()` settles; waiters are granted in arrival order when it does | R-2 capacity (slow close, capacity 1, FIFO) |
| 2 | the page cache read the content first and the store version afterwards, so an edit landing between the two reads was cached under the new version | fixed (I-54) | the version is read before the content and keys the entry | R-2 cache (+ control) |
| 2, 4 | `void env.dispose()` in eviction and sweep could reject unobserved: a throwing close was an unhandled rejection (process death under Node's default policy) | fixed (I-55) | `disposeRecord()` never rejects; failures go to `onDisposalError` (default `console.error`) and `stats().disposalFailures`; the worker's abort listener is guarded as well | R-2/R-4 ×2 (hook and counts; default-policy child process) |
| 3 | an Env with an abandoned attempt stayed in the tree and in the Runtime's registries for as long as the attempt ran; with the whole graph retained, the bounded close had turned into unbounded retention | fixed (I-56, D31 supersedes that part of D24, M-18, M-21) | the Env leaves the tree and the registries at the end of its bounded close whatever is outstanding; abandoned and timed-out attempts live in a weak ledger (`inspect().unsettledAttempts`); when a setup Promise is garbage-collected its attempt is closed as `attempt-unreachable` (cleanups run, slot and Env `disposed`); `runtime.dispose()` and Hyla `close()` report the ledger instead of silently succeeding or rejecting | R-3 ×2 (20 stuck Envs; `--expose-gc` child), F-PL-04 tests updated, R-2/R-3 app `close()` |
| 4 | the dependencies of an abandoned attempt are disposed while that attempt may still be running | inherent (I-57, D34) | the report names the dependency slots and their states (`details.slots[].dependencies`); nothing else can be done inside the model (argument below) | R-4 |

Why item 4c cannot be solved under the model. The close of an Env must be bounded (K08/K09, audit F-PL-01: an `Infinity` deadline must not hang `dispose()`), and an attempt is user code that may ignore its signal. There are only three ways to treat such an attempt's dependencies: wait for the attempt before closing them, which is unbounded and contradicts the bounded close; terminate the attempt, which the model excludes (§14: no forced termination, no revocation of handed-out instances) and JavaScript cannot do to a Promise chain; or keep the dependencies alive after their owner closed, which is the unbounded retention of item 3 moved one level up and would stop the owner from ever disposing what it owns. The remaining behaviour, closing the dependencies in the normal order and acknowledging it in the report, is the one implemented and tested.

## Third review round (2026-09-05)

Two further auditors reviewed HEAD 6bb36c2 and reported about thirty-five findings across the core, the Hyla-mini site manager, caches and rendering, static output, the two backends, and delivery. Every claim was re-verified against the source of the time (aa196b5) by three read-only passes; the two core claims C3 and C4 were reproduced live before anything was changed. The rule of the round: stay inside the semantic model (`docs/SEMANTIC_MODEL.md`, task book K/H items) or show the item cannot be solved under it. Fixes were made in groups (core, site manager, caches and security, static output, backends, delivery), one commit each, every fix with a regression test shown to fail on the pre-fix sources. Issue numbers I-58…I-84 in `work/v05/ISSUES.md`; decisions D35…D53; migration notes M-22…M-30. This round's own probes are archived under `work/v05/probes/review-3-2026-09-05/`.

Three design questions were decided with the user: `Family.range()` types as the origin's Contract view (D36); post identity is `(tenantId, id)` on both backends (D51); the CI release-gate job is included and was labelled as not verified in the cloud until it ran (D53; verified on 2026-09-05 by GitHub Actions run 33995206873).

| finding | verdict | fix | regression |
|---|---|---|---|
| C1 a private Family referenced only through `range()` was unresolvable (`MISSING_SERVICE`); R07 and the benchmark were seeded by an exact edge | holds | ranges carry their origin; candidates are {origin} ∪ owner closure ∪ admitted (I-58, D35 supersedes D16, M-22) | R07 range-only Family; benchmark `privateRangeAndBoundEntryCase` without the exact helper |
| C2 `range()` typed as the origin's full instance | holds | range = Contract view (`ProvidedShape<Provides>`); the Runtime keeps only candidates providing the origin's Contracts, `INCOMPATIBLE_IMPLEMENTATION` otherwise (I-59, D36, M-23) | type tests `type-tests/api.ts`; R07 covering / non-covering revisions |
| C3 plan-template keys omitted the lineage anchors; the hit path never re-solved | holds, reproduced both ways | key carries an anchors digest; a backtrackable failure on a hit evicts and re-solves (I-60, D37) | R17 anchors (both orders, forced stale hit) |
| C4 `dispose()` before a deadline that fired inside the grace hid the attempt | holds, reproduced | the settling sequence falls through to the abandoned-attempt path with the remaining grace (I-61, D38, M-18) | R-5 (+ control) |
| C5 `check()`/`explain()` called pure while registering and consuming ids | holds | own id counter; `inspect().definitions`; wording (I-62, D39, M-25) | K12 (100 plans) |
| C6 same family+version with a different `setup` silently first-wins | holds | setup digest in the structural signature → `DUPLICATE_DEFINITION` (I-63, D40, M-24) | R20, core.test, hardening rewritten |
| C7 / C9 / C10 docs (§5 omission vs. undeclared; `preload()`; completion barrier in PACKAGE_AUTHORING) | hold | wording; `preload()` deprecated (I-64, D41) | — |
| C8 padded tests (vacuous override/fresh assertion; F-PL-04 waiting for the timeout) | holds | R06 asserts owners and a distinct instance; R-5 disposes first (I-65) | R06, R-5 |
| S1 SiteEnv leak after a failed creation | already fixed (0434be0, I-52) | — | R-2 leak |
| S2 redundant reservation released without waking the queue | holds | `releaseReservation()` (I-66) | S2 |
| S3 capacity vs. disposing Envs; H11 never asserted the bound | capacity already fixed (I-53); the test gap holds | H11 asserts `liveEnvCount − roots ≤ capacity` at every lease and sample, `maxSiteEnvsAlive` in `working-set.json` (I-66) | H11 |
| S4 background error channels (manager fixed; worker loop unobserved) | manager already fixed (I-55); the worker holds | supervised loop, `failed` state, `stop()` rethrows into `close().errors` (I-69, D44) | S4 ×2 (child process under the default policy) |
| S5 stale configuration read drained a newer Env; generation captured before the wait | holds | monotonic rotation by (generation, configRevision) (I-67, D42) | S5 ×2 |
| S6 `LeasePurpose` ignored | holds | `reservedForRequests`, purpose-aware queue (I-68, D43, M-26) | S6 ×2 |
| S7 `close()` swallowed manager errors | partly | idempotent `close()`, errors flattened to leaves (I-70, D45, M-27) | S7 |
| S8 request preflight not automatic for embedders | partly | third startup check from a synthetic `preflight` site world (I-70) | S8, H06 |
| S9 domain table never refreshed; `normalizeDomain` kept a trailing dot, no IDNA | holds | rate-limited reload on unknown host, worker tick reload, IDNA normalization (I-71, D46) | S9 ×2, H01/S9, conformance |
| R1 page cache unbounded, version read per hit, no single-flight; config read per acquire | holds | bounded single-flight cache, coalesced version and configuration reads; latency report (I-72, D47) | R-2b, `hyla-request-latency` |
| R2 / R5 pipeline cache unbounded; `factorySetupCounts` module-global | hold | LRU keyed by (trust, stable JSON); per-instance tokens (I-73) | R2, H05 |
| R3 no sanitizer policy for untrusted recipes | holds | `build(document, { trust })`, `sanitizer` role appended for `untrusted` (I-74, D48) | R3 ×2 (+ end-to-end) |
| R4 / B5 `href` scheme, `theme.accent` CSS, cookie decoding → 500; stored configuration unvalidated | hold | `parseSiteConfig` on save and read, `isSafeHref`, `isCssColor`, renderer fallbacks, tolerant cookies (I-75, D49, M-28) | conformance, filesystem, postgres, R4 ×2 |
| T1 static output prefix check only, symlinks followed | holds | resolved root, per-component symlink checks before the first write; static server follows no link (I-76, D50) | F-AP-08b |
| T2 / T3 build deleted then wrote in place, no lock; no content snapshot | hold | snapshot render, ordered atomic publish, manifest last with `contentVersion`, in-process mutex + `.hyla-build.lock` (I-77, D50, M-29) | F-AP-08c |
| B1 post id global on PostgreSQL, per-tenant on the filesystem | holds | `(tenant_id, id)` composite key, migrated in place (I-78, D51, M-30) | conformance, postgres |
| B2 domain claim race on both backends | holds | `domains` table under advisory locks; filesystem `__domains__` lock (I-79, D51) | conformance (5 rounds) |
| B3 content write and version bump not atomic | holds | transaction per public mutation; filesystem pending marker (I-80, D51) | postgres trigger, filesystem marker |
| B4 `withClient` destroyed the connection on every error | holds | destroy only on connection-level errors (I-81, D52) | pool policy |
| D1 / V2 demo `fetch` cannot set `Host` → dynamic cells 404; gate checked exit code only | holds (committed logs showed `404 22 bytes`) | self-asserting demo over `node:http`; `expectStdout` in the gate (I-82, D53) | gate steps `hyla-demo-filesystem`, `rebuild-demo` |
| V3 "530 tests" = 265 × 2 | holds | `distinctTests` / `rebuildTests`; VALIDATION wording (I-83, D53) | manifest |
| V1 / V5 no CI release gate; archives unpublished | holds | `release-gate` job with artifact upload (I-84, D53) | GitHub Actions run 33995206873 on 09e2931: `release-gate` success, gate COMPLETE 710/710 (2026-09-05) |
| extra: vacuous `revisionBefore` assertion; VALIDATION artefact table stale by construction | hold | assertion fixed; table replaced by a pointer to the run's hash list (I-79, I-83) | conformance |
| V4 other documentation claims (ALS, selector, `InputRef.load`) | inaccurate: already v0.5-correct | — | — |
| lineage key / template size grows with Env depth | kept as a limit | bounded by `planCache.maxEntries` (F-CD-04) | — |
| thenable Service instances only diagnosed at runtime | kept as a limit | `foreign-thenable-setup` (D17); no type-level guard | — |

Verification of this round: every new regression was run against the pre-fix sources first (stash of the group's source files, rebuild, run) and shown to fail there while everything else stayed green, then on the fix; the full suites, the archived probes of earlier rounds (updated where the intended behaviour changed: factory-sharing counts the appended sanitizer pass, static-export expects the D28 refusal, tenant-isolation expects the trailing-dot host to be served as its normalized spelling (I-71) and a claim on another tenant's domain to be refused by the store (I-47, normalized since I-71), postgres-backend expects the same post id in two tenants to be two posts (I-78) instead of the old refusal; the two lifecycle "observation" lines of the first round (F-PL-06, F-PL-07) still print FAIL because the observed defect is gone) and the development gate pass on the fixed source. The release runs and the independent re-audit of this round are recorded in `work/v05/STATE.md`.

## Independent re-audit of the third round

After the third round's fixes were committed (32d212a), three fresh-context reviewers examined the candidate without access to the implementer's conversation, one per line, writing only under `work/v05/audit-3/` (archived under `docs/audit/audit-3-core-lifecycle-planning/`, `docs/audit/audit-3-app-permissions-resources/`, `docs/audit/audit-3-backends-delivery/`, each with its report, probes, the reviewer's logs and the re-run logs against the fixed build).

| line | reviewer input | probes | findings |
|---|---|---|---|
| Core lifecycle and planning | selector expansion across Runtimes, drift on plan-template hits, the unreachable-attempt path when the Env handle is dropped, `requires` order, the ledger during rollbacks and late cleanups, tree close bound, range origin in the public realm, `run()` results, planning ids | 11 probes (`run-all.sh`, `RUN-LOG.txt`) | F-CL3-01…09: 3 major, 2 minor, 4 docs |
| Application permissions and resources | untrusted recipe policy, `isSafeHref`, capacity eviction, shutdown during creation, acquire deadline, foreign build manifests, closing records, static build cost | 10 probes (`p01`…`p09`, logs next to them) | F-AP3-01…08: 2 major, 5 minor, 1 docs/minor |
| Backends and delivery | silent ROLLBACK, domain rows under conflicts and overlapping saves, re-entrancy, transaction repository serialization, migration back-fill, deadlocks, pool disposal, rename crashes, cluster script signals, demo assertions, records | 12 probes (`p1`…`p12`) | F-BD3-01…18: 6 major, 6 minor, 6 docs |

| finding | verdict | fix | regression |
|---|---|---|---|
| F-CL3-01 selector candidate Entries cached per Contract across Runtimes; a second Runtime holding another physical copy failed or inherited a warning | holds (major) | cache keyed by the physical descriptor (I-85, D55) | F-CL3-01 |
| F-CL3-02 the D40 drift check ran on cold plans only; a template hit ran the canonical setup for a drifted copy; `check()` warmed the bypass | holds (major) | root-site descriptors registered and checked on a hit; `check()`/`explain()` raise like `enter()` (I-86, D56, M-32) | F-CL3-02 |
| F-CL3-03 the weak ledger let an attempt die with the user's Promise: no cleanups, no event, when nobody held the Env | holds (major) | strong ledger; retention bounded by the raw Promise (I-87, D54) | F-CL3-03 (child process); R-3 tightened but not discriminating on its own |
| F-CL3-04 plans depended on `requires` insertion order and admission order | holds (minor) | sites resolved in key order (I-88, D57, M-32) | F-CL3-04 |
| F-CL3-05 a slow rollback reported as "still running", never ledgered; the ledger emptied before a late cleanup ran | holds (minor) | `rolling-back` / `settling` states, `runtime.dispose()` grace, phase in reports (I-89, D58, M-31) | F-CL3-05a/b/c |
| F-CL3-06 "one grace regardless of `setupDeadlineMs`" is per Env; a tree closes in one grace per level | holds (docs) | documented as the bound; the order is kept (I-90, D59) | probe `04` keeps its FAIL line by design |
| F-CL3-07 the origin of a range promised as a candidate in the public realm | holds (docs) | wording: private realm only (I-91) | probe `03` (as coded) |
| F-CL3-08 `run()` discarded a successful result when the close reported | holds (docs) | `error.result` (I-92, D59, M-31) | F-CL3-08; probe `09` M1 asserts the old behaviour |
| F-CL3-09 `check()`/`explain()` consumed slot ids | holds (docs) | `check-slot-N` (I-93, D59, M-32) | F-CL3-09 |
| F-AP3-01 a recipe's `finalPass: true` merged the appended untrusted sanitizer away | holds (major) | per-configuration plugin identity; the builder verifies the appended pass (I-94, D61, M-33) | render F-AP3-01 |
| F-AP3-02 `isSafeHref` accepted backslash protocol-relative spellings | holds (minor) | backslashes refused (I-95, D61, M-33) | render R4 |
| F-AP3-03 an unservable build acquirer evicted idle Envs for nothing | holds (minor) | evict only what makes the acquirer servable (I-96, D60) | site-manager F-AP3-03 |
| F-AP3-04 a creation cut short by `shutdown()` counted as a tenant failure with backoff | holds (minor) | `SiteManagerClosedError({ cause })`, no count, no backoff (I-97, D60, M-33) | site-manager F-AP3-04 |
| F-AP3-05 an acquire could take nearly 2 × `acquireTimeoutMs` | holds (docs/minor) | one deadline for the whole acquire, paced re-reads (I-98, D60) | site-manager F-AP3-05 |
| F-AP3-06 any JSON with `files` was a previous build; foreign files deleted | holds (minor) | manifest provenance checked (I-99, D61, M-33) | audit-app F-AP3-06 |
| F-AP3-07 a closing record kept its key: configuration-read spin, `SITE_CAPACITY` with capacity free | holds (major) | closing records leave their key at once (I-100, D60) | site-manager F-AP3-07 |
| F-AP3-08 static builds O(N²) on the filesystem backend | holds (reasoning) | `SiteContext.renderPostPage` from the listing (I-101, D61, M-33) | audit-app F-AP3-08 |
| F-BD3-01 `transaction()` resolved after a silent ROLLBACK | holds (major) | `TransactionAbortedError` (I-102, D62, M-34) | postgres F-BD3-01 |
| F-BD3-02 a handled `DomainConflictError` committed the deletion of the tenant's own domain rows | holds (major) | conflicts checked before the delete (I-103, D62) | conformance F-BD3-02 |
| F-BD3-03 overlapping saves of one tenant's configuration orphaned domain rows | holds (major) | per-tenant advisory lock at the start of every unit of work (I-104, D62, M-34) | conformance F-BD3-03 |
| F-BD3-04 a public mutation inside the tenant's own unit of work waited forever; `app.close()` hung | holds (major) | `TransactionReentrancyError`, `lock_timeout` (I-105, D62, M-34) | conformance F-BD3-04, postgres F-BD3-04 |
| F-BD3-05 the transaction repository serialized nothing among its own calls | holds (major) | inner mutex / statement chaining (I-106, D62) | conformance F-BD3-05 |
| F-BD3-06 the domains back-fill ran on every start and failed on a malformed row | holds (major) | one-time guarded back-fill (I-107, D63) | postgres F-BD3-06 |
| F-BD3-07 same-tenant units of work deadlocked | holds (minor) | serialized by the tenant lock (I-108, D62) | postgres F-BD3-07 |
| F-BD3-08 a queued lease never settled after the pool was disposed | holds (minor) | bounded disposal (I-109, D62, M-34) | postgres F-BD3-08 |
| F-BD3-09 a crash inside a rename left two files with one id | holds (minor) | one file per id on scan; surplus removed (I-110, D63) | filesystem F-BD3-09 ×2 |
| F-BD3-10 the cluster wrapper ignored signals; a step's timeout could not end the step | holds (minor) | signal forwarding; process-group step runner (I-111, D64, M-35) | `scripts/tests` (10) |
| F-BD3-11 the `demos` step passed on exit code alone | holds (minor) | self-asserting demos, `expectStdout` (I-112, D64) | gate step `demos` |
| F-BD3-12 NUL accepted by one backend; `listTenants()` missed category-only tenants | holds (minor) | NUL refused on both; union over all tables (I-113, D63, M-34) | conformance F-BD3-12 ×2; probe `p1` keeps two FAIL lines that asserted the old divergence |
| F-BD3-13 I-83 said FIXED while the page was pending regeneration | holds (docs) | I-83 reworded; page regenerated by this round's release run (I-114) | — |
| F-BD3-14 the PostgreSQL server version was hand-typed | holds (docs) | recorded in the manifest from the step log (I-115, D64, M-35) | `pg-test-cluster.test.mjs` |
| F-BD3-15 "the gate fails on any deviation" | holds (docs) | `previousRun` recorded, never enforced; wording (I-116, D64, M-35) | — |
| F-BD3-16 "four-cell demo" | holds (docs) | three cells, named (I-117) | — |
| F-BD3-17 archived documents cite repository-only `work/v05/` paths | holds (docs) | stated in README and here (I-118, D64) | — |
| F-BD3-18 no fsync: the marker's guarantee is a process-crash guarantee | holds (reasoning) | documented boundary (I-119, D65) | — |

Verification of this round: every new regression was run against the pre-fix sources first (stash of the source files, rebuild with three stub error classes so the test files link, run) and shown to fail there, then on the fix. Pre-fix: core 9 of 16 failed (exactly the nine new cases; R-3 tightened passes there too, see I-87); site manager 4 of 14 (exactly the four new cases); filesystem/render/audit-app 13 of 99 — the new cases plus three collateral ones (F-AP-08c patches `renderPostPage`, which did not exist; the FS conformance `deleteTenant` case waits behind the re-entrancy deadlock the pre-fix F-BD3-04 case leaves behind, on both layouts); PostgreSQL: the new conformance and audit-3 cases fail and the pre-fix F-BD3-04 case deadlocks a connection and the tenant's version row, so the later transaction/pool cases of that file fail by timeout as collateral and the file was ended by the harness after 300 s; the cluster-script test fails by timeout (the pre-fix wrapper neither forwards the signal nor stops the cluster). On the fix everything is green; the full suites, the auditors' own probes (re-run logs archived as `*.rerun.log` / `RUN-LOG.txt`; the remaining FAIL lines are the documented bound of F-CL3-06 and checks that asserted the old behaviour: core `05` (a) "still running", `09` M1, backends `p1` NUL divergence; `p8-records` re-checked after the release run) and the earlier rounds' archived probes were re-run on the final candidate before the release runs recorded in `docs/VALIDATION.md`.

