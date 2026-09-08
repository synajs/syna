# Validation (VALIDATION)

Every number below is copied by a script (`scripts/validation-doc.mjs`) from machine-readable results of the transparent orchestrator; nothing is hand-typed. Source of this page: the release run `node scripts/verify-release.mjs --release` recorded in `validation/v1.0.0-rc.5-release/manifest.json` — status **COMPLETE**, generated 2026-09-08T18:17:05.394Z, source fingerprint `aef69d271c317bf8ae94a7e3021a5229c7fd53717b4d00b0dcc7928c49e6a8db` (396 files), git commit `b619983` (clean checkout).

This document is generated from that run's manifest after the run and committed with the run's evidence (`RELEASE_MANIFEST.json`, `validation/v1.0.0-rc.5-release/`) in the release commit; from 1.0.0-rc.1 on the gate neither fingerprints nor archives it, so the source fingerprint and the archive hashes the manifest records hold on the commit that carries them, and one run is the record of reference. The gate does not compare runs with each other and fails none for differing from another: the same steps run, and each manifest records under `previousRun` whether its step list and per-step test counts equal those of the run it replaced; its timings are its own and may differ within noise.

## Environment

- Host: darwin 25.2.0 arm64, Apple M4 Pro × 14, 48 GiB
- Node v26.0.0 (V8 14.6.202.33-node.19), `--expose-gc` for benchmarks and working-set tests
- PostgreSQL: PostgreSQL 17.10 at `postgres://syna@127.0.0.1:54329/postgres` (temporary cluster), as printed by `scripts/pg-test-cluster.mjs` in the step log and copied into the manifest; the temporary cluster runs with `fsync=off` and is created before and removed after each PostgreSQL step
- Package manager: npm workspaces (`npm ci` in the rebuild); TypeScript 5.9.x from the lockfile

## Release gate steps (`validation/v1.0.0-rc.5-release/manifest.json`)

| step | exit | tests | duration | log |
|---|---|---|---|---|
| clean | 0 | — | 168 ms | `validation/v1.0.0-rc.5-release/logs/clean.log` |
| build | 0 | — | 8197 ms | `validation/v1.0.0-rc.5-release/logs/build.log` |
| type-tests | 0 | — | 3498 ms | `validation/v1.0.0-rc.5-release/logs/type-tests.log` |
| core-tests | 0 | 338/338 pass, 0 fail, 0 not run | 3030 ms | `validation/v1.0.0-rc.5-release/logs/core-tests.log` |
| blog-filesystem-tests | 0 | 69/69 pass, 0 fail, 0 not run | 980 ms | `validation/v1.0.0-rc.5-release/logs/blog-filesystem-tests.log` |
| blog-render-tests | 0 | 8/8 pass, 0 fail, 0 not run | 284 ms | `validation/v1.0.0-rc.5-release/logs/blog-render-tests.log` |
| blog-tenants-auth-preflight-tests | 0 | 12/12 pass, 0 fail, 0 not run | 422 ms | `validation/v1.0.0-rc.5-release/logs/blog-tenants-auth-preflight-tests.log` |
| blog-audit-regression-tests | 0 | 22/22 pass, 0 fail, 0 not run | 5495 ms | `validation/v1.0.0-rc.5-release/logs/blog-audit-regression-tests.log` |
| blog-review-regression-tests | 0 | 8/8 pass, 0 fail, 0 not run | 1661 ms | `validation/v1.0.0-rc.5-release/logs/blog-review-regression-tests.log` |
| blog-close-path-tests | 0 | 12/12 pass, 0 fail, 0 not run | 1294 ms | `validation/v1.0.0-rc.5-release/logs/blog-close-path-tests.log` |
| blog-site-manager-working-set-tests | 0 | 14/14 pass, 0 fail, 0 not run | 5313 ms | `validation/v1.0.0-rc.5-release/logs/blog-site-manager-working-set-tests.log` |
| blog-postgres-and-matrix-tests | 0 | 45/45 pass, 0 fail, 0 not run | 2452 ms | `validation/v1.0.0-rc.5-release/logs/blog-postgres-and-matrix-tests.log` |
| gate-self-tests | 0 | 38/38 pass, 0 fail, 0 not run | 4376 ms | `validation/v1.0.0-rc.5-release/logs/gate-self-tests.log` |
| mutation-audit-record | 0 | — | — | `work/rc5/mutations/RESULTS.json` |
| api-inventory | 0 | — | 3541 ms | `validation/v1.0.0-rc.5-release/logs/api-inventory.log` |
| api-inventory-no-deprecated | 0 | — | — | `validation/v1.0.0-rc.5-release/api-inventory.json` |
| api-inventory-diff | 0 | — | 166 ms | `validation/v1.0.0-rc.5-release/logs/api-inventory-diff.log` |
| api-inventory-unchanged | 0 | — | — | `validation/v1.0.0-rc.5-release/api-inventory-diff.md` |
| api-inventory-frozen | 0 | — | — | `validation/v1.0.0-rc.5-release/api-inventory.json` |
| codemod-idempotent | 0 | — | 763 ms | `validation/v1.0.0-rc.5-release/logs/codemod-idempotent.log` |
| no-old-reference-tokens | 0 | — | — | `validation/v1.0.0-rc.5-release/old-reference-tokens.json` |
| no-vendor-names | 0 | — | — | `validation/v1.0.0-rc.5-release/vendor-name-scan.json` |
| any-count | 0 | — | 221 ms | `validation/v1.0.0-rc.5-release/logs/any-count.log` |
| demo-01-basics | 0 | — | 69 ms | `validation/v1.0.0-rc.5-release/logs/demo-01-basics.log` |
| demo-02-per-tenant | 0 | — | 76 ms | `validation/v1.0.0-rc.5-release/logs/demo-02-per-tenant.log` |
| demo-03-user-configurable | 0 | — | 82 ms | `validation/v1.0.0-rc.5-release/logs/demo-03-user-configurable.log` |
| demo-04-two-versions | 0 | — | 79 ms | `validation/v1.0.0-rc.5-release/logs/demo-04-two-versions.log` |
| demo-05-scheduled-jobs | 0 | — | 75 ms | `validation/v1.0.0-rc.5-release/logs/demo-05-scheduled-jobs.log` |
| demo-06-testing | 0 | — | 79 ms | `validation/v1.0.0-rc.5-release/logs/demo-06-testing.log` |
| demo-07-failure-modes | 0 | — | 570 ms | `validation/v1.0.0-rc.5-release/logs/demo-07-failure-modes.log` |
| blog-demo-filesystem | 0 | — | 279 ms | `validation/v1.0.0-rc.5-release/logs/blog-demo-filesystem.log` |
| benchmarks | 0 | — | 3418 ms | `validation/v1.0.0-rc.5-release/logs/benchmarks.log` |
| benchmark-compare | 0 | — | 156707 ms | `validation/v1.0.0-rc.5-release/logs/benchmark-compare.log` |
| blog-request-latency | 0 | — | 1903 ms | `validation/v1.0.0-rc.5-release/logs/blog-request-latency.log` |
| archive-scan | 0 | — | — | `validation/v1.0.0-rc.5-release/archive-scan.json` |
| archive-tar | 0 | — | 211 ms | `validation/v1.0.0-rc.5-release/logs/archive-tar.log` |
| archive-zip | 0 | — | 63 ms | `validation/v1.0.0-rc.5-release/logs/archive-zip.log` |
| rebuild-unpack | 0 | — | 154 ms | `validation/v1.0.0-rc.5-release/logs/rebuild-unpack.log` |
| rebuild-install | 0 | — | 569 ms | `validation/v1.0.0-rc.5-release/logs/rebuild-install.log` |
| rebuild-build | 0 | — | 8564 ms | `validation/v1.0.0-rc.5-release/logs/rebuild-build.log` |
| rebuild-type-tests | 0 | — | 3624 ms | `validation/v1.0.0-rc.5-release/logs/rebuild-type-tests.log` |
| rebuild-core-tests | 0 | 338/338 pass, 0 fail, 0 not run | 3137 ms | `validation/v1.0.0-rc.5-release/logs/rebuild-core-tests.log` |
| rebuild-app-tests | 0 | 145/145 pass, 0 fail, 0 not run | 5631 ms | `validation/v1.0.0-rc.5-release/logs/rebuild-app-tests.log` |
| rebuild-postgres-matrix-tests | 0 | 45/45 pass, 0 fail, 0 not run | 2393 ms | `validation/v1.0.0-rc.5-release/logs/rebuild-postgres-matrix-tests.log` |
| rebuild-gate-self-tests | 0 | 38/38 pass, 0 fail, 0 not run | 4220 ms | `validation/v1.0.0-rc.5-release/logs/rebuild-gate-self-tests.log` |
| rebuild-codemod-idempotent | 0 | — | 819 ms | `validation/v1.0.0-rc.5-release/logs/rebuild-codemod-idempotent.log` |
| rebuild-demo | 0 | — | 259 ms | `validation/v1.0.0-rc.5-release/logs/rebuild-demo.log` |
| rebuild-examples | 0 | — | 9904 ms | `validation/v1.0.0-rc.5-release/logs/rebuild-examples.log` |
| pack-core | 0 | — | 349 ms | `validation/v1.0.0-rc.5-release/logs/pack-core.log` |
| pack-tsconfig | 0 | — | 170 ms | `validation/v1.0.0-rc.5-release/logs/pack-tsconfig.log` |
| consumer-install | 0 | — | 1042 ms | `validation/v1.0.0-rc.5-release/logs/consumer-install.log` |
| consumer-build | 0 | — | 894 ms | `validation/v1.0.0-rc.5-release/logs/consumer-build.log` |
| consumer-run | 0 | — | 170 ms | `validation/v1.0.0-rc.5-release/logs/consumer-run.log` |
| consumer-smoke-result | 0 | — | — | `validation/v1.0.0-rc.5-release/logs/consumer-run.log` |
| release-profile | 0 | — | — | `scripts/release-profiles/1.0.0-rc.5.json` |

Totals: 55 steps, 0 failed steps; 1132 test executions: 566 distinct cases, 566 of them executed a second time in the rebuilt copy (the `rebuild-*` steps); 1132 passed, 0 skipped/not run. Blocked steps: 0.

The `rebuild-*` steps ran inside a fresh directory created with `mkdtemp` in the OS temp dir: the source tarball was unpacked there, `npm ci` installed from the lockfile, the workspace was built and type-tested, and the core, application and PostgreSQL/matrix suites plus the filesystem demo ran against that copy. `pack-*` produced the npm tarballs from the rebuilt copy; `consumer-*` installed them into an independent TypeScript project, compiled it and ran it.

## Release artefacts

The 2 source archives and 2 npm packages of the run this page was generated from are listed with sizes and SHA-256 digests in that run's `SHA256SUMS.txt` and under `release` in its `manifest.json`. They are not copied here: this page is generated from the run and is not part of the archived source, so the run of reference — `RELEASE_MANIFEST.json` and `validation/v1.0.0-rc.5-release/SHA256SUMS.txt`, committed with this page — carries the hashes to check. Rebuilt from `work/release/syna-v1.0.0-rc.5-source.tar.gz`. Consumer smoke result (last line of `validation/v1.0.0-rc.5-release/logs/consumer-run.log`): `{"result":84,"revision":"7.3.1","explainOk":true,"missing":"smoke.consumer/input/answer/v1","abandoned":0,"revisions":"7.3.1","slots":"ready,ready"}`.

## Micro-benchmarks (P01–P04, `validation/v1.0.0-rc.5-release/benchmark-v0.5.json`)

Setups are empty and involve no network. Warm cases measure enter+dispose of a sibling Entry with a cached plan template; percentiles are over individual iterations after warmup. Numbers are machine-specific; cache cardinality and bounded growth are the portable assertions. Warmup iterations: 50. Quick mode: false.

| case | samples | p50 ms | p95 ms | p99 ms | inherited / new | plan-cache entries |
|---|---:|---:|---:|---:|---|---:|
| warm-enter-dispose-100-depth-2 | 500 | 0.111 | 0.192 | 0.247 | 100 / 20 | 4 |
| warm-enter-dispose-100-depth-6 | 500 | 0.108 | 0.169 | 0.216 | 100 / 20 | 8 |
| warm-enter-dispose-300-depth-2 | 500 | 0.254 | 0.377 | 0.420 | 260 / 60 | 4 |
| warm-enter-dispose-300-depth-6 | 500 | 0.250 | 0.376 | 0.410 | 260 / 60 | 8 |
| site-enter-tenant-input-reverse-closure-200 | 300 | 0.196 | 0.288 | 0.392 | 140 / — | 2 |
| bound-entry-private-range-request-enter-dispose-100 | 500 | 0.123 | 0.179 | 0.223 | 101 / 21 | 4 |
| override-and-all-request-enter-dispose-100 | 500 | 0.121 | 0.169 | 0.203 | — | — |

Phase breakdown (300-service world, 60 rounds): cold plan + new slots p95 22.346 ms · warm plan p95 0.497 ms · materialization of a request chain p95 0.055 ms · dispose p95 0.120 ms.

Churn: 10000 request/AnchoredEntry operations in 1245 ms (124.5 µs/op); plan-cache entries max 4 (hits 9998, misses 4); live Envs after 2; heap after GC: 7.1 MiB → 7.3 MiB → 7.4 MiB → 7.4 MiB → 7.4 MiB.

LRU: 500 distinct Entry shapes → 16 cached templates (max 16, evictions 484).

### Budgets (`benchmarks/budgets.json`) — all ok: true

| budget | metric | max | value | result |
|---|---|---:|---:|---|
| warm-enter-dispose-300-depth-2 | p95Ms | 2 | 0.377 | ok |
| warm-enter-dispose-300-depth-6 | p95Ms | 2 | 0.376 | ok |
| warm-enter-dispose-100-depth-2 | p95Ms | 1 | 0.192 | ok |
| bound-entry-private-range-request-enter-dispose-100 | p95Ms | 1 | 0.179 | ok |
| churn-10000-requests | planCacheEntriesMax | 8 | 4.000 | ok |
| churn-10000-requests-liveEnvs | liveEnvCountAfter | 2 | 2.000 | ok |
| lru-churn-500-shapes | planCacheEntries | 16 | 16.000 | ok |

### 1.0.0-rc.4 comparison on the same machine (`validation/v1.0.0-rc.5-release/benchmark-compare/same-session.json`)

`scripts/benchmark-same-session.mjs` ran `benchmarks/v0.5-planning.mjs` 21 times on this host, took the element-wise median and compared it with the 1.0.0-rc.4 source (commit `b691067`) exported from git into a scratch directory, installed from its lockfile, built and benchmarked 21 times in the same session (`scripts/benchmark-same-session.mjs`: one discarded warm-up run per side, then 21 rounds that benchmark both sides in alternating order, both benchmark processes under `--expose-gc --no-maglev`; medians in `validation/v1.0.0-rc.5-release/benchmark-compare/`): environment identical (platform darwin, arch arm64, cpu Apple M4 Pro, cpuCount 14, node (major) v26, node flags --expose-gc --no-maglev); 23/23 p50/p95/per-operation values within ±10 %; 116/116 plan-cache counters and shape counts equal; overall OK.

Machine-state drift (informational): this session's 1.0.0-rc.4 against the file recorded on 2026-09-08T04:39:30.294Z (`benchmarks/results-v1.0.0-rc.4-baseline-same-machine.json`) has 23/23 timings within ±10 % — the same code measured at two moments, which is why both sides are measured in one session.

| value | baseline (1.0.0-rc.4) | this source (1.0.0-rc.5) | delta |
|---|---:|---:|---:|
| cases.warm-enter-dispose-100-depth-2.timing.p50Ms | 0.100 | 0.100 | -0.2 % |
| cases.warm-enter-dispose-100-depth-2.timing.p95Ms | 0.183 | 0.185 | +0.9 % |
| cases.warm-enter-dispose-100-depth-6.timing.p50Ms | 0.096 | 0.097 | +1.1 % |
| cases.warm-enter-dispose-100-depth-6.timing.p95Ms | 0.181 | 0.182 | +1.0 % |
| cases.warm-enter-dispose-300-depth-2.timing.p50Ms | 0.250 | 0.252 | +1.1 % |
| cases.warm-enter-dispose-300-depth-2.timing.p95Ms | 0.333 | 0.334 | +0.3 % |
| cases.warm-enter-dispose-300-depth-6.timing.p50Ms | 0.245 | 0.246 | +0.5 % |
| cases.warm-enter-dispose-300-depth-6.timing.p95Ms | 0.325 | 0.322 | -0.8 % |
| cases.phase-breakdown-300.coldPlanWithNewSlotsMs.p50Ms | 19.703 | 19.783 | +0.4 % |
| cases.phase-breakdown-300.coldPlanWithNewSlotsMs.p95Ms | 22.072 | 22.043 | -0.1 % |
| cases.phase-breakdown-300.warmPlanMs.p50Ms | 0.307 | 0.304 | -0.9 % |
| cases.phase-breakdown-300.warmPlanMs.p95Ms | 0.432 | 0.456 | +5.4 % |
| cases.phase-breakdown-300.materializationMs.p50Ms | 0.029 | 0.028 | -3.0 % |
| cases.phase-breakdown-300.materializationMs.p95Ms | 0.065 | 0.062 | -4.3 % |
| cases.phase-breakdown-300.disposeMs.p50Ms | 0.082 | 0.081 | -1.1 % |
| cases.phase-breakdown-300.disposeMs.p95Ms | 0.135 | 0.136 | +1.2 % |
| cases.site-enter-tenant-input-reverse-closure-200.timing.p50Ms | 0.177 | 0.179 | +1.0 % |
| cases.site-enter-tenant-input-reverse-closure-200.timing.p95Ms | 0.235 | 0.232 | -1.3 % |
| cases.bound-entry-private-range-request-enter-dispose-100.timing.p50Ms | 0.112 | 0.110 | -1.8 % |
| cases.bound-entry-private-range-request-enter-dispose-100.timing.p95Ms | 0.190 | 0.190 | +0.4 % |
| cases.override-and-all-request-enter-dispose-100.timing.p50Ms | 0.109 | 0.109 | -0.5 % |
| cases.override-and-all-request-enter-dispose-100.timing.p95Ms | 0.181 | 0.183 | +0.9 % |
| cases.churn-10000-requests.perOperationMs | 0.117 | 0.117 | -0.2 % |

Every one of the 116 plan-cache counters (hits, misses, entries, evictions) and shape counts is equal to the baseline.

### v0.4 comparison on the same machine (P03)

The v0.4.0 baseline archive (sha256 `e0f21a94765aeb9f8e9e7987d596844e4d1bf56fce3584c8de1358131f42a96c`) was rebuilt in a scratch directory and its own benchmark (`benchmarks/v0.4-planning.mjs`) was run unchanged (`benchmarks/results-v0.4.0-baseline-same-machine.json`); the same script was then run against the v0.5 core (`benchmarks/results-v0.4-workload-on-v0.5-same-machine.json`). Same workload, same host, same Node:

| case (v0.4 workload) | v0.4 core p95 ms | v0.5 core p95 ms | delta |
|---|---:|---:|---:|
| request-chain-100-depth-2 | 0.148 | 0.182 | +22 % |
| request-chain-100-depth-6 | 0.071 | 0.093 | +31 % |
| request-chain-300-depth-2 | 0.304 | 0.336 | +11 % |
| request-chain-300-depth-6 | 0.323 | 0.349 | +8 % |
| selector-request-3-candidates | 0.056 | 0.072 | +28 % |
| binding-request-2-choices | 0.023 | 0.029 | +23 % |

On the v0.4 workload the v0.5 core is slower by +8 % to +31 % at p95 (all cases stay far inside the 2 ms budget). The v0.5 representative world (Bindings, `auto`, `C.all`, SCC, AnchoredEntry private realm, Input closures) is heavier than the v0.4 request chain and is reported separately above. These values are targets for this machine, not cross-machine guarantees.

## Working set (H11 / P05, `validation/v1.0.0-rc.5-release/working-set.json`)

120 tenants configured, capacity 6; max SiteEnv records per phase: hot 3, rotation 6, long tail 6, mixed 6; final records 0, evictions 480, creations 481, creation failures 0, leases 0, pending acquires 0. Heap after GC per phase: start 19.2 MiB (records 0, live envs 2, disposing 0); after-hot 20.0 MiB (records 3, live envs 5, disposing 0); after-rotation 20.4 MiB (records 6, live envs 8, disposing 0); after-tail 20.3 MiB (records 5, live envs 7, disposing 0); after-mixed 20.6 MiB (records 6, live envs 8, disposing 0); after-idle-sweep 19.9 MiB (records 0, live envs 2, disposing 0). Site Envs alive at any acquire (live envs minus the two roots, sampled on every lease): at most 6 of capacity 6. Plan cache at the end: {"hits":482,"misses":6,"entries":6,"evictions":0,"limit":512}.

## multitenant-blog request latency (report only, `validation/v1.0.0-rc.5-release/blog-request-latency.json`)

Full HTTP round trips on 127.0.0.1 measured from a node:http client in the same process; not a budget and not a cross-machine claim. Quick mode: false. Not a budget: nothing here gates the release.

| backend | case | samples | p50 ms | p95 ms | p99 ms |
|---|---|---:|---:|---:|---:|
| filesystem | post-page-cached | 200 | 1.194 | 1.712 | 1.946 |
| filesystem | index-cached | 200 | 0.444 | 0.532 | 0.583 |
| filesystem | comment-preview-untrusted | 200 | 0.459 | 0.586 | 0.747 |
| filesystem | post-page-cold-site | 50 | 1.332 | 1.575 | 1.871 |
| postgres | post-page-cached | 200 | 0.516 | 0.806 | 1.010 |
| postgres | index-cached | 200 | 0.329 | 0.405 | 0.483 |
| postgres | comment-preview-untrusted | 200 | 0.351 | 0.426 | 0.492 |
| postgres | post-page-cold-site | 50 | 0.728 | 0.904 | 1.069 |

`post-page-cached`: GET /posts/shared-slug on a warm SiteEnv (page cache hit; still one content-version read per request). `index-cached`: GET / on a warm SiteEnv (page cache hit). `comment-preview-untrusted`: GET /comments/preview?text=… (untrusted pipeline, never cached). `post-page-cold-site`: GET /posts/shared-slug after invalidate(): SiteEnv creation (configuration read, Env, authenticator, context) plus a page-cache miss.

## Audit and review fixes covered by this run

The suites above include the regressions written for the independent audits and for the second and third review rounds (`docs/AUDIT.md`): `packages/core/tests/disposal/bounded-close.test.mjs`, `planning/explain-missing-inputs.test.mjs` and `materialization/retry-and-late-results.test.mjs` inside `core-tests` (the third round's core cases live in the `v05-*` files named in `work/v05/ISSUES.md` I-58…I-65), `apps/multitenant-blog/tests/audit-app.test.mjs` and `apps/multitenant-blog/tests/review-app.test.mjs` as their own steps, the site-manager, render and preflight cases of the third round inside their steps, and the repository-conformance cases (content version, domain claims and concurrent claims, tenant-scoped post identity, configuration validation) inside the filesystem and PostgreSQL suites. The demo steps are self-asserting: the multitenant-blog demo (`blog-demo-filesystem`, repeated as `rebuild-demo`) must print `demo: OK` and three `: 200` cells, and each of the seven example steps `demo-01-basics` … `demo-07-failure-modes` (repeated together as `rebuild-examples`) must print the stable lines its README lists and its `<name>: OK` line (each program asserts its own results); exit 0 alone is not enough. The `gate-self-tests` step covers the gate's own tooling (step process groups, cluster script signal forwarding).

## Frozen-surface evidence in this run

The claim of this line — the public surface of `@syna/core` frozen from 0.8.0 (`docs/API_STABILITY.md`) and the core unchanged since — rests on steps of this run. `api-inventory` (exit 0), `api-inventory-no-deprecated` (ok: 374 items, 0 @deprecated), `api-inventory-diff` (exit 0; 374 items in the 1.0.0-rc.1 record, 374 here: 0 added, 0 removed, 0 changed in signature, 0 changed in JSDoc only, 0 newly deprecated), `api-inventory-unchanged` (ok: 374 items here, 374 in the 1.0.0-rc.4 record (validation/v1.0.0-rc.4-release/api-inventory.json, commit e96871b); 0 added, 0 removed, 0 changed — the registration of 1.0.0-rc.5 for this comparison is 0 item(s)) and `api-inventory-frozen` (ok: 374 items here, 374 in the 0.8.0 record (validation/v0.8-release/api-inventory.json, commit 38a722e); 0 added, 0 removed, 3 changed — the registration of 1.0.0-rc.5 for this comparison is 3 item(s)) record the public API of this source, assert that no item of it is deprecated, diff it against the 1.0.0-rc.1 record (`validation/v1.0.0-rc.1-release/api-inventory.json`) and require it to be identical to that record and to the 0.8.0 record (`validation/v0.8-release/api-inventory.json`) item by item — path, kind, signature, JSDoc and deprecation. Planning layer unchanged: `core-tests` includes `inventory/snapshots.test.mjs` (the check/explain/inspect/catalog/error snapshots recorded on 0.5.0, rewritten by the registered renames only — `packages/core/tests/snapshots/v05-renames.json` — and identical otherwise, the limit defaults verbatim) and `property/reference-planner.test.mjs` (brute-force planner differential, unchanged). The 0.8 rename stays guarded, in `core-tests`: `refs/implementation-ref` (one serialized shape of an implementation reference on every write path; every pre-0.8 form refused by `parseImplementationRef()` and by the four Runtime read paths with `INVALID_DESCRIPTOR`), `refs/slot-state` (the declared `SlotState` union equals the set of states a slot is actually seen in), `materialization/deadline-queue` (the process-wide DeadlineQueue: Runtimes isolated, a settled waiter holds the process open for nothing), `inventory/expired-forms-0.8` (the four 0.7 forms the Runtime could otherwise read silently are refused naming the current form), `inventory/expired-forms-0.7` and `errors/invalid-descriptor`. `gate-self-tests` (38/38 pass) includes the empty deprecation register, the no-old-names scan of every application, benchmark, script, workflow, test suite and current document for the pre-0.8 names, the codemod run on a fixture consumer, the public-API inventory assertions (exactly the rename table against the 0.7.0 record; identity with the 0.8.0 record) and the doc-aware diff renderer, the README example compiled and run as printed, and the `any` budget; `codemod-idempotent` (exit 0; 0 edits in 0 files, 0 sites needing a hand) is `scripts/codemod-v08.mjs --dry-run` on this source, repeated inside the unpacked archive as `rebuild-codemod-idempotent` (exit 0); `no-old-reference-tokens` (ok: 69 files scanned, 0 hits) scans the core source, tests and type tests for the 0.5 serialized key, the old kind and the word that named the old read path; `no-vendor-names` (ok: 252 files scanned, 0 hits, 12 allowed literals of the application) scans every current file — sources, tests, examples, benchmarks, scripts, workflow, documents and package metadata; the historical documents, the ledgers and the recorded evidence excepted — for a real vendor name used as a fictional component name and for the pre-1.0.0-rc.2 name of the reference application (`docs/EXAMPLES.md`; the application's own on-disk literals are allowed by name and listed in `vendor-name-scan.json`); `any-count` (exit 0) checks every file against `scripts/any-baseline-v1.0.0-rc.2.json` (the 0.7.0 record re-keyed under the rename of the reference application; the examples and fixtures, absent from it, use no `any`); `benchmark-compare` (exit 0) is the same-machine comparison with 1.0.0-rc.1 above.

## What is not covered

- Coverage percentages are not a gate; the adversarial and application suites are.
- Benchmarks use empty setups; multitenant-blog request latency (section above) is reported end to end on this machine but is not a budget and not a cross-machine claim.
- The gate ran with no other workload on the machine; single-run timings still carry noise (see the v0.4 comparison for the spread between two runs of the same code).
- The same-machine comparison (section above) measures both benchmark processes under `--expose-gc --no-maglev` (1.0.0-rc.1 on; `scripts/benchmark-same-session.mjs`, the flags recorded in every run file). Without V8's Maglev tier the tier-up race that made a benchmark process fast or slow for its whole timed loop — the bimodal p95 of the 0.6 to 0.8 release runs, about 0.21 ms or 0.30 ms for `site-enter-tenant-input-reverse-closure-200` on both sides alike (`work/v08/STATE.md`, Phase E) — is gone: every process of a run lands at the former slow mode's p95 level (0.27–0.33 ms on this machine) with the fast mode's p50, on both sides. The tolerance (±10 %), the statistic (element-wise median of 21 interleaved rounds) and the counters' equality are unchanged, and `scripts/benchmark-compare.mjs` reports two records measured under different flags as not comparable. The budget table above (`benchmark-v0.5.json`) is still measured without the flag, so its p95 values are not comparable with the comparison's.
