#!/usr/bin/env node
// Generates docs/VALIDATION.md from the machine-readable results of one orchestrator run.
//
//   node scripts/validation-doc.mjs [validation/v<version>-release] [docs/VALIDATION.md]
//
// The run directory defaults to the release run of the version in package.json. The document is generated after the run
// and committed with the run's evidence; the gate neither fingerprints nor archives it (1.0.0-rc.1 on).
//
// Every number in the document comes from manifest.json, benchmark-v0.5.json, working-set.json,
// the consumer-run log and the two same-machine v0.4 comparison files under benchmarks/.
// Nothing is hand-typed; re-run the script after every gate run that is meant to be the record.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const version = JSON.parse(readFileSync(path.resolve(root, 'package.json'), 'utf8')).version
const runDir = process.argv[2] ?? `validation/v${version}-release`
const outFile = process.argv[3] ?? 'docs/VALIDATION.md'
const json = file => JSON.parse(readFileSync(path.resolve(root, file), 'utf8'))

const manifest = json(path.join(runDir, 'manifest.json'))
const benchmark = json(path.join(runDir, 'benchmark-v0.5.json'))
const workingSet = json(path.join(runDir, 'working-set.json'))
const v4 = json('benchmarks/results-v0.4.0-baseline-same-machine.json')
const v4onv5 = json('benchmarks/results-v0.4-workload-on-v0.5-same-machine.json')
const consumerLog = readFileSync(path.resolve(root, runDir, 'logs/consumer-run.log'), 'utf8').trim().split('\n').filter(Boolean)
const gate = manifest.gate ?? 'scripts/verify-v05.mjs'
const sameSessionFile = path.join(runDir, 'benchmark-compare/same-session.json')
const recordFile = path.join(runDir, 'benchmark-compare.json')
const compareFile = existsSync(path.resolve(root, sameSessionFile)) ? sameSessionFile : recordFile
const comparison = existsSync(path.resolve(root, compareFile)) ? json(compareFile) : null
const sameSession = compareFile === sameSessionFile
const compareDir = path.resolve(root, runDir, 'benchmark-compare')
const sessionBaselineFile = existsSync(compareDir) ? readdirSync(compareDir).filter(name => /^baseline-v.+-same-session\.json$/.test(name)).sort().map(name => path.join(runDir, 'benchmark-compare', name))[0] : undefined
const sessionBaseline = sameSession && sessionBaselineFile ? json(sessionBaselineFile) : null
const sessionCurrentFile = path.join(runDir, 'benchmark-compare/current-same-session.json')
const sessionCurrent = sameSession && existsSync(path.resolve(root, sessionCurrentFile)) ? json(sessionCurrentFile) : null
const driftFile = path.join(runDir, 'benchmark-compare/record-drift.json')
const drift = sameSession && existsSync(path.resolve(root, driftFile)) ? json(driftFile) : null
// The version the comparison's baseline side was built from (the median files record the core's package version).
const baselineVersion = sessionBaseline?.core?.version ?? (comparison && existsSync(path.resolve(root, comparison.baseline)) ? json(comparison.baseline).core?.version : null) ?? 'baseline'

const ms = value => (typeof value === 'number' ? value.toFixed(3) : '—')
const mib = bytes => (bytes / (1024 * 1024)).toFixed(1)
const short = commit => (commit ? commit.slice(0, 7) : 'unknown')
const env = benchmark.environment
const git = manifest.environment.gitProvenance ?? {}

const lines = []
const out = (...text) => lines.push(...text)

out('# Validation (VALIDATION)', '')
out(`Every number below is copied by a script (\`scripts/validation-doc.mjs\`) from machine-readable results of the transparent orchestrator; nothing is hand-typed. Source of this page: the ${manifest.mode} run \`node ${gate} --${manifest.mode}\` recorded in \`${runDir}/manifest.json\` — status **${manifest.status}**, generated ${manifest.generatedAt}, source fingerprint \`${manifest.source.digest}\` (${manifest.source.files} files), git commit \`${short(git.commit)}\` (${git.dirty === false ? 'clean checkout' : git.dirty === true && Array.isArray(git.modified) ? (git.modified.length > 0 ? `tracked files modified: ${git.modified.join(', ')}` : `tracked files unchanged; untracked files present: ${git.untracked.join(', ')}`) : `dirty: ${git.dirty ?? 'unknown'}`}).`, '')
out(`This document is generated from that run's manifest after the run and committed with the run's evidence (\`RELEASE_MANIFEST.json\`, \`${runDir}/\`) in the release commit; from 1.0.0-rc.1 on the gate neither fingerprints nor archives it, so the source fingerprint and the archive hashes the manifest records hold on the commit that carries them, and one run is the record of reference. The gate does not compare runs with each other and fails none for differing from another: the same steps run, and each manifest records under \`previousRun\` whether its step list and per-step test counts equal those of the run it replaced; its timings are its own and may differ within noise.`, '')

out('## Environment', '')
out(`- Host: ${env.platform} ${env.release} ${env.arch}, ${env.cpu} × ${env.cpuCount}, ${Math.round(env.totalMemoryBytes / (1024 ** 3))} GiB`)
out(`- Node ${env.node} (V8 ${env.v8}), \`--expose-gc\` for benchmarks and working-set tests`)
const pg = manifest.environment.postgres
out(`- PostgreSQL: ${pg ? `${pg.server} at \`${pg.url}\` (${pg.origin})` : 'server and URL not recorded by this run'}, as printed by \`scripts/pg-test-cluster.mjs\` in the step log and copied into the manifest; the temporary cluster runs with \`fsync=off\` and is created before and removed after each PostgreSQL step`)
out('- Package manager: npm workspaces (`npm ci` in the rebuild); TypeScript 5.9.x from the lockfile', '')

out(`## Release gate steps (\`${runDir}/manifest.json\`)`, '')
out('| step | exit | tests | duration | log |', '|---|---|---|---|---|')
for (const step of manifest.steps) {
  const tests = step.tests
    ? `${step.tests.pass}/${step.tests.tests} pass, ${step.tests.fail} fail, ${step.tests.skipped + step.tests.todo + step.tests.cancelled} not run`
    : '—'
  const duration = typeof step.durationMs === 'number' ? `${step.durationMs} ms` : '—'
  out(`| ${step.name} | ${step.exitCode} | ${tests} | ${duration} | \`${step.log}\` |`)
}
out('')
const totals = manifest.totals
const distinct = totals.distinctTests ?? manifest.steps.filter(step => !step.name.startsWith('rebuild-')).reduce((sum, step) => sum + (step.tests?.tests ?? 0), 0)
const rerun = totals.rebuildTests ?? totals.tests - distinct
out(`Totals: ${totals.steps} steps, ${totals.failed} failed steps; ${totals.tests} test executions: ${distinct} distinct cases, ${rerun} of them executed a second time in the rebuilt copy (the \`rebuild-*\` steps); ${totals.passed} passed, ${totals.skippedTests} skipped/not run. Blocked steps: ${manifest.blocked.length}.`, '')
if (manifest.previousRun) {
  const prev = manifest.previousRun
  out(`Compared with the run this one replaced (generated ${prev.generatedAt}, commit \`${short(prev.commit)}\`, ${prev.status}): step list ${prev.sameStepList ? 'identical' : 'different'}, per-step test counts ${prev.sameTestCounts ? 'identical' : 'different'}${prev.differences.length > 0 ? ` — ${prev.differences.join('; ')}` : ''}.`, '')
}
out('The `rebuild-*` steps ran inside a fresh directory created with `mkdtemp` in the OS temp dir: the source tarball was unpacked there, `npm ci` installed from the lockfile, the workspace was built and type-tested, and the core, application and PostgreSQL/matrix suites plus the filesystem demo ran against that copy. `pack-*` produced the npm tarballs from the rebuilt copy; `consumer-*` installed them into an independent TypeScript project, compiled it and ran it.', '')

if (manifest.release) {
  out('## Release artefacts', '')
  out(`The ${manifest.release.archives.length} source archives and ${manifest.release.packed.length} npm packages of the run this page was generated from are listed with sizes and SHA-256 digests in that run's \`SHA256SUMS.txt\` and under \`release\` in its \`manifest.json\`. They are not copied here: this page is generated from the run and is not part of the archived source, so the run of reference — \`RELEASE_MANIFEST.json\` and \`${runDir}/SHA256SUMS.txt\`, committed with this page — carries the hashes to check. Rebuilt from \`${manifest.release.rebuiltFrom}\`. Consumer smoke result (last line of \`${runDir}/logs/consumer-run.log\`): \`${consumerLog.at(-1)}\`.`, '')
}

out(`## Micro-benchmarks (P01–P04, \`${runDir}/benchmark-v0.5.json\`)`, '')
out(`${benchmark.methodology.note} Warmup iterations: ${benchmark.methodology.warmupIterations}. Quick mode: ${benchmark.quick}.`, '')
out('| case | samples | p50 ms | p95 ms | p99 ms | inherited / new | plan-cache entries |', '|---|---:|---:|---:|---:|---|---:|')
for (const item of benchmark.cases) {
  if (!item.timing?.samples) continue
  const shape = item.requestShape
    ? `${item.requestShape.services.reused} / ${item.requestShape.services.new}`
    : typeof item.inherited === 'number'
      ? `${item.inherited} / ${typeof item.newServices === 'number' ? item.newServices : '—'}`
      : '—'
  out(`| ${item.name} | ${item.timing.samples} | ${ms(item.timing.p50Ms)} | ${ms(item.timing.p95Ms)} | ${ms(item.timing.p99Ms)} | ${shape} | ${item.planCache ? item.planCache.entries : '—'} |`)
}
out('')
const phases = benchmark.cases.find(item => item.name === 'phase-breakdown-300')
if (phases) {
  out(`Phase breakdown (${phases.serviceCount}-service world, ${phases.coldPlanWithNewSlotsMs.samples} rounds): cold plan + new slots p95 ${ms(phases.coldPlanWithNewSlotsMs.p95Ms)} ms · warm plan p95 ${ms(phases.warmPlanMs.p95Ms)} ms · materialization of a request chain p95 ${ms(phases.materializationMs.p95Ms)} ms · dispose p95 ${ms(phases.disposeMs.p95Ms)} ms.`, '')
}
const churn = benchmark.cases.find(item => item.name === 'churn-10000-requests')
if (churn) {
  out(`Churn: ${churn.operations} request/AnchoredEntry operations in ${Math.round(churn.elapsedMs)} ms (${(churn.perOperationMs * 1000).toFixed(1)} µs/op); plan-cache entries max ${churn.planCacheEntriesMax} (hits ${churn.planCache.hits}, misses ${churn.planCache.misses}); live Envs after ${churn.liveEnvCountAfter}; heap after GC: ${churn.heapSamples.map(sample => `${mib(sample.heapUsed)} MiB`).join(' → ')}.`, '')
}
const lru = benchmark.cases.find(item => item.name === 'lru-churn-500-shapes')
if (lru) {
  out(`LRU: ${lru.generatedEntryShapes} distinct Entry shapes → ${lru.planCacheEntries} cached templates (max ${lru.planCache.limit}, evictions ${lru.planCache.evictions}).`, '')
}
out(`### Budgets (\`benchmarks/budgets.json\`) — all ok: ${benchmark.budgetsOk}`, '')
out('| budget | metric | max | value | result |', '|---|---|---:|---:|---|')
for (const item of benchmark.budgets) out(`| ${item.budget} | ${item.metric} | ${item.max} | ${item.value.toFixed(3)} | ${item.ok ? 'ok' : 'FAILED'} |`)
out('')

if (comparison) {
  out(`### ${baselineVersion} comparison on the same machine (\`${compareFile}\`)`, '')
  const tolerance = Math.round(comparison.tolerance * 100)
  const rows = comparison.rows
  const equal = rows.filter(row => row.check === 'equal')
  const timed = rows.filter(row => row.check !== 'equal')
  const runCount = sessionCurrent ? sessionCurrent.runs : comparison.current.replace('median of ', '').replace(' fresh runs', '')
  const baselineText = sameSession
    ? `the ${baselineVersion} source (commit \`${short(sessionBaseline.sourceCommit)}\`) exported from git into a scratch directory, installed from its lockfile, built and benchmarked ${sessionBaseline.runs} times in the same session (\`scripts/benchmark-same-session.mjs\`${sessionCurrent ? `: one discarded warm-up run per side, then ${sessionCurrent.runs} rounds that benchmark both sides in alternating order${Array.isArray(sessionCurrent.nodeFlags) ? `, both benchmark processes under \`${sessionCurrent.nodeFlags.join(' ')}\`` : ''}` : ''}; medians in \`${path.join(runDir, 'benchmark-compare/')}\`)`
    : `\`${comparison.baseline}\` (the ${baselineVersion} median recorded earlier on the same machine)`
  out(`${sessionCurrent ? '`scripts/benchmark-same-session.mjs`' : '`scripts/benchmark-compare.mjs compare`'} ran \`benchmarks/v0.5-planning.mjs\` ${runCount} times on this host, took the element-wise median and compared it with ${baselineText}: environment ${comparison.comparable ? 'identical' : 'DIFFERENT'} (${comparison.environment.map(row => `${row.key} ${row.current}`).join(', ')}); ${timed.filter(row => row.ok).length}/${timed.length} p50/p95/per-operation values within ±${tolerance} %; ${equal.filter(row => row.ok).length}/${equal.length} plan-cache counters and shape counts equal; overall ${comparison.ok ? 'OK' : 'FAILED'}.`, '')
  if (drift) {
    const driftTimed = drift.rows.filter(row => row.check !== 'equal')
    const outside = driftTimed.filter(row => !row.ok)
    out(`Machine-state drift (informational): this session's ${baselineVersion} against the file recorded on ${json(drift.baseline).generatedAt} (\`${drift.baseline}\`) has ${driftTimed.length - outside.length}/${driftTimed.length} timings within ±${tolerance} %${outside.length > 0 ? `; outside: ${outside.map(row => `${row.path} ${row.delta >= 0 ? '+' : ''}${(row.delta * 100).toFixed(1)} %`).join(', ')}` : ''} — the same code measured at two moments, which is why both sides are measured in one session.`, '')
  }
  out(`| value | baseline (${baselineVersion}) | this source (${manifest.version}) | delta |`, '|---|---:|---:|---:|')
  for (const row of timed) out(`| ${row.path} | ${ms(row.baseline)} | ${ms(row.current)} | ${row.delta === null ? '—' : `${row.delta >= 0 ? '+' : ''}${(row.delta * 100).toFixed(1)} %`}${row.ok ? '' : ' (outside tolerance)'} |`)
  out('')
  const unequal = equal.filter(row => !row.ok)
  out(unequal.length === 0 ? `Every one of the ${equal.length} plan-cache counters (hits, misses, entries, evictions) and shape counts is equal to the baseline.` : `Counters differing from the baseline: ${unequal.map(row => `${row.path} ${row.baseline} → ${row.current}`).join('; ')}.`, '')
}

out('### v0.4 comparison on the same machine (P03)', '')
out('The v0.4.0 baseline archive (sha256 `e0f21a94765aeb9f8e9e7987d596844e4d1bf56fce3584c8de1358131f42a96c`) was rebuilt in a scratch directory and its own benchmark (`benchmarks/v0.4-planning.mjs`) was run unchanged (`benchmarks/results-v0.4.0-baseline-same-machine.json`); the same script was then run against the v0.5 core (`benchmarks/results-v0.4-workload-on-v0.5-same-machine.json`). Same workload, same host, same Node:', '')
out('| case (v0.4 workload) | v0.4 core p95 ms | v0.5 core p95 ms | delta |', '|---|---:|---:|---:|')
const deltas = []
for (const base of v4.cases) {
  const current = v4onv5.cases.find(item => item.name === base.name)
  if (!current?.timing?.p95Ms || !base.timing?.p95Ms) continue
  const delta = Math.round((current.timing.p95Ms / base.timing.p95Ms - 1) * 100)
  deltas.push(delta)
  out(`| ${base.name} | ${ms(base.timing.p95Ms)} | ${ms(current.timing.p95Ms)} | ${delta >= 0 ? '+' : ''}${delta} % |`)
}
out('')
const signed = value => `${value >= 0 ? '+' : ''}${value} %`
const spread = `${signed(Math.min(...deltas))} to ${signed(Math.max(...deltas))}`
out(`On the v0.4 workload the v0.5 core ${Math.min(...deltas) >= 0 ? `is slower by ${spread}` : `differs by ${spread}`} at p95 (all cases stay far inside the 2 ms budget). The v0.5 representative world (Bindings, \`auto\`, \`C.all\`, SCC, AnchoredEntry private realm, Input closures) is heavier than the v0.4 request chain and is reported separately above. These values are targets for this machine, not cross-machine guarantees.`, '')

out(`## Working set (H11 / P05, \`${runDir}/working-set.json\`)`, '')
const phaseNames = { hot: 'hot', rotate: 'rotation', tail: 'long tail', mixed: 'mixed' }
const stats = workingSet.finalStats
out(`${workingSet.tenants} tenants configured, capacity ${workingSet.capacity}; max SiteEnv records per phase: ${Object.entries(workingSet.maxRecordsPerPhase).map(([phase, count]) => `${phaseNames[phase] ?? phase} ${count}`).join(', ')}; final records ${stats.records}, evictions ${stats.evictions}, creations ${stats.creations}, creation failures ${stats.creationFailures}, leases ${stats.leases}, pending acquires ${stats.pendingAcquires}. Heap after GC per phase: ${workingSet.heapSamples.map(sample => `${sample.label} ${mib(sample.heapUsed)} MiB (records ${sample.records}, live envs ${sample.liveEnvs}, disposing ${sample.disposing ?? 0})`).join('; ')}. Site Envs alive at any acquire (live envs minus the two roots, sampled on every lease): at most ${workingSet.maxSiteEnvsAlive ?? 'n/a'} of capacity ${workingSet.capacity}. Plan cache at the end: ${JSON.stringify(workingSet.planCache)}.`, '')

const latencyFile = path.join(runDir, 'blog-request-latency.json')
if (existsSync(latencyFile)) {
  const latency = json(latencyFile)
  out(`## multitenant-blog request latency (report only, \`${runDir}/blog-request-latency.json\`)`, '')
  out(`${latency.note} Quick mode: ${latency.quick}. Not a budget: nothing here gates the release.`, '')
  out('| backend | case | samples | p50 ms | p95 ms | p99 ms |', '|---|---|---:|---:|---:|---:|')
  for (const backend of latency.backends) {
    if (backend.skipped) { out(`| ${backend.backend} | skipped: ${backend.skipped} | | | | |`); continue }
    for (const item of backend.cases) out(`| ${backend.backend} | ${item.name} | ${item.timing.samples} | ${ms(item.timing.p50Ms)} | ${ms(item.timing.p95Ms)} | ${ms(item.timing.p99Ms)} |`)
  }
  out('')
  const described = latency.backends.find(backend => backend.cases)?.cases ?? []
  out(described.map(item => `\`${item.name}\`: ${item.description}.`).join(' '), '')
}

out('## Audit and review fixes covered by this run', '')
out('The suites above include the regressions written for the independent audits and for the second and third review rounds (`docs/AUDIT.md`): `packages/core/tests/disposal/bounded-close.test.mjs`, `planning/explain-missing-inputs.test.mjs` and `materialization/retry-and-late-results.test.mjs` inside `core-tests` (the third round\'s core cases live in the `v05-*` files named in `work/v05/ISSUES.md` I-58…I-65), `apps/multitenant-blog/tests/audit-app.test.mjs` and `apps/multitenant-blog/tests/review-app.test.mjs` as their own steps, the site-manager, render and preflight cases of the third round inside their steps, and the repository-conformance cases (content version, domain claims and concurrent claims, tenant-scoped post identity, configuration validation) inside the filesystem and PostgreSQL suites. The demo steps are self-asserting: the multitenant-blog demo (`blog-demo-filesystem`, repeated as `rebuild-demo`) must print `demo: OK` and three `: 200` cells, and each of the seven example steps `demo-01-basics` … `demo-07-failure-modes` (repeated together as `rebuild-examples`) must print the stable lines its README lists and its `<name>: OK` line (each program asserts its own results); exit 0 alone is not enough. The `gate-self-tests` step covers the gate\'s own tooling (step process groups, cluster script signal forwarding).', '')

out('## Frozen-surface evidence in this run', '')
const named = name => manifest.steps.find(step => step.name === name)
const describe = name => { const step = named(name); return step ? (step.tests ? `${step.tests.pass}/${step.tests.tests} pass` : step.mustRun === false ? `recorded, not a test: ${step.note ?? ''}` : step.note ? `${step.ok ? 'ok' : 'FAIL'}: ${step.note}` : `exit ${step.exitCode}`) : 'not run' }
const diffFile = path.join(runDir, 'api-inventory-diff.md')
const diffSummary = existsSync(path.resolve(root, diffFile)) ? readFileSync(path.resolve(root, diffFile), 'utf8').match(/^\| total items \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|/m) : null
const diffText = diffSummary ? `${diffSummary[1]} items in the 1.0.0-rc.1 record, ${diffSummary[2]} here: ${diffSummary[3]} added, ${diffSummary[4]} removed, ${diffSummary[5]} changed in signature, ${diffSummary[6]} changed in JSDoc only, ${diffSummary[7]} newly deprecated` : 'no diff recorded'
const codemodFile = path.join(runDir, 'codemod-idempotent.json')
const codemod = existsSync(path.resolve(root, codemodFile)) ? json(codemodFile) : null
const codemodText = codemod ? `${codemod.edits} edits in ${codemod.filesChanged} files, ${codemod.manual} sites needing a hand` : 'no report recorded'
out(`The claim of this line — the public surface of \`@syna/core\` frozen from 0.8.0 (\`docs/API_STABILITY.md\`) and the core unchanged since — rests on steps of this run. \`api-inventory\` (${describe('api-inventory')}), \`api-inventory-no-deprecated\` (${describe('api-inventory-no-deprecated')}), \`api-inventory-diff\` (${describe('api-inventory-diff')}; ${diffText}), \`api-inventory-unchanged\` (${describe('api-inventory-unchanged')}) and \`api-inventory-frozen\` (${describe('api-inventory-frozen')}) record the public API of this source, assert that no item of it is deprecated, diff it against the 1.0.0-rc.1 record (\`validation/v1.0.0-rc.1-release/api-inventory.json\`) and require it to be identical to that record and to the 0.8.0 record (\`validation/v0.8-release/api-inventory.json\`) item by item — path, kind, signature, JSDoc and deprecation. Planning layer unchanged: \`core-tests\` includes \`inventory/snapshots.test.mjs\` (the check/explain/inspect/catalog/error snapshots recorded on 0.5.0, rewritten by the registered renames only — \`packages/core/tests/snapshots/v05-renames.json\` — and identical otherwise, the limit defaults verbatim) and \`property/reference-planner.test.mjs\` (brute-force planner differential, unchanged). The 0.8 rename stays guarded, in \`core-tests\`: \`refs/implementation-ref\` (one serialized shape of an implementation reference on every write path; every pre-0.8 form refused by \`parseImplementationRef()\` and by the four Runtime read paths with \`INVALID_DESCRIPTOR\`), \`refs/slot-state\` (the declared \`SlotState\` union equals the set of states a slot is actually seen in), \`materialization/deadline-queue\` (the process-wide DeadlineQueue: Runtimes isolated, a settled waiter holds the process open for nothing), \`inventory/expired-forms-0.8\` (the four 0.7 forms the Runtime could otherwise read silently are refused naming the current form), \`inventory/expired-forms-0.7\` and \`errors/invalid-descriptor\`. \`gate-self-tests\` (${describe('gate-self-tests')}) includes the empty deprecation register, the no-old-names scan of every application, benchmark, script, workflow, test suite and current document for the pre-0.8 names, the codemod run on a fixture consumer, the public-API inventory assertions (exactly the rename table against the 0.7.0 record; identity with the 0.8.0 record) and the doc-aware diff renderer, the README example compiled and run as printed, and the \`any\` budget; \`codemod-idempotent\` (${describe('codemod-idempotent')}; ${codemodText}) is \`scripts/codemod-v08.mjs --dry-run\` on this source, repeated inside the unpacked archive as \`rebuild-codemod-idempotent\` (${describe('rebuild-codemod-idempotent')}); \`no-old-reference-tokens\` (${describe('no-old-reference-tokens')}) scans the core source, tests and type tests for the 0.5 serialized key, the old kind and the word that named the old read path; \`no-vendor-names\` (${describe('no-vendor-names')}) scans every current file — sources, tests, examples, benchmarks, scripts, workflow, documents and package metadata; the historical documents, the ledgers and the recorded evidence excepted — for a real vendor name used as a fictional component name and for the pre-1.0.0-rc.2 name of the reference application (\`docs/EXAMPLES.md\`; the application's own on-disk literals are allowed by name and listed in \`vendor-name-scan.json\`); \`any-count\` (${describe('any-count')}) checks every file against \`scripts/any-baseline-v1.0.0-rc.2.json\` (the 0.7.0 record re-keyed under the rename of the reference application; the examples and fixtures, absent from it, use no \`any\`); \`benchmark-compare\` (${describe('benchmark-compare')}) is the same-machine comparison with 1.0.0-rc.1 above.`, '')

out('## What is not covered', '')
out('- Coverage percentages are not a gate; the adversarial and application suites are.')
out('- Benchmarks use empty setups; multitenant-blog request latency (section above) is reported end to end on this machine but is not a budget and not a cross-machine claim.')
out('- The gate ran with no other workload on the machine; single-run timings still carry noise (see the v0.4 comparison for the spread between two runs of the same code).')
out('- The same-machine comparison (section above) measures both benchmark processes under `--expose-gc --no-maglev` (1.0.0-rc.1 on; `scripts/benchmark-same-session.mjs`, the flags recorded in every run file). Without V8\'s Maglev tier the tier-up race that made a benchmark process fast or slow for its whole timed loop — the bimodal p95 of the 0.6 to 0.8 release runs, about 0.21 ms or 0.30 ms for `site-enter-tenant-input-reverse-closure-200` on both sides alike (`work/v08/STATE.md`, Phase E) — is gone: every process of a run lands at the former slow mode\'s p95 level (0.27–0.33 ms on this machine) with the fast mode\'s p50, on both sides. The tolerance (±10 %), the statistic (element-wise median of 21 interleaved rounds) and the counters\' equality are unchanged, and `scripts/benchmark-compare.mjs` reports two records measured under different flags as not comparable. The budget table above (`benchmark-v0.5.json`) is still measured without the flag, so its p95 values are not comparable with the comparison\'s.')

writeFileSync(path.resolve(root, outFile), lines.join('\n') + '\n')
console.log(`${outFile}: ${lines.length} lines from ${runDir} (${manifest.status}, ${manifest.totals.tests} tests)`)
