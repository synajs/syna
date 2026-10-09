#!/usr/bin/env node
// Syna release acceptance orchestrator (1.0.0-rc.1 on): the 0.8 gate with the version read from package.json — the
// archive name and the manifest carry it, and the release profile of that version names the directory the run writes
// its evidence to — and with the records of the previous release as the baselines. 1.0.0-rc.2: the public API
// inventory must be identical to the 0.8.0 record (the surface is frozen from 0.8.0, docs/API_STABILITY.md) and its
// diff against the 1.0.0-rc.1 record empty; the same-session benchmark comparison
// runs against the 1.0.0-rc.1 source with `--no-maglev` on both sides (its recorded baseline is the 1.0.0-rc.1 side of
// the 1.0.0-rc.1 release run on this machine); the `any` budget stays at the 0.7.0 record, re-keyed under the rename of
// the reference application. The demos are the seven examples (apps/01-* … apps/07-*, each a step that must print the
// stable lines of its README) and the multitenant-blog demo (apps/multitenant-blog, the reference application under
// its 1.0.0-rc.2 name, docs/HISTORY.md: the same three cells). Everything else is the 0.8 gate unchanged: no
// @deprecated item, the rename codemod idempotent over the tree, no pre-0.8 reference token in the core, the
// benchmarks and their budgets.
//
// 1.0.0-rc.6 is the workspace's validation line for the first *public* release candidate: what it publishes restarts at
// `synajs@1.0.0-rc.1` and `@synajs/tsconfig@1.0.0-rc.1` (the runtime was developed and validated under the temporary
// `@syna/core` identity through the earlier candidates, docs/HISTORY.md; syna-public-rename). The candidate was first
// prepared as the unscoped `syna`, which npm rejected under its package-name similarity policy before anything was
// published; the runtime package is `synajs`, the content and the surface are the same, and the `syna` preparation
// stays on record (`validation/public/syna-v1.0.0-rc.1-release/`, docs/HISTORY.md). Three steps came with
// them: `no-legacy-package-names` (no current file installs, imports or extends a package that will not be on the
// registry), `pack-metadata` (the two tarballs are the packages the profile declares, carry what their `files` says
// and no more, ask a consumer for nothing of this workspace, and the runtime's README is the canonical root README
// byte for byte)
// and `readme-consumer-*` (a project whose package.json, tsconfig.json and programs are the blocks of that README,
// with the packed runtime tarball as its only dependency, printing what the README says it prints).
//
// Because the published version is no longer the workspace version, the evidence of a public release is no longer
// named after it either: `constants.validation` of the profile names the directory, and the public runs are a lineage
// of their own under `validation/public/synajs-v<package version>-release/`. The top-level `validation/v<version>-*/`
// directories are the repository's own validation rounds and stay exactly as they were recorded
// (`validation/README.md`).
//
//   node scripts/verify-release.mjs --dev       G0: build + type tests + core/regression + real PostgreSQL/FS + app matrix + tooling
//                                                + API inventory (0 deprecated items; identical to the 0.8.0 record; unchanged since 1.0.0-rc.1)
//                                                + codemod idempotency + old-token scan + same-machine benchmark comparison with 1.0.0-rc.1
//                                                + package-identity scan + `any` budget + the seven examples + the multitenant-blog demo + benchmarks
//   node scripts/verify-release.mjs --release   G0 + G1: source archive, rebuild from the archive in an empty dir, pack + tarball audit +
//                                                consumer smoke + the README's own programs in a project built from the README,
//                                                release manifest and SHA256SUMS. Prints COMPLETE / PARTIAL / BLOCKED and exits 0 only on COMPLETE.
//
// This is a transparent runner: every sub-command is spawned, awaited, and recorded with exit code, timing,
// pass/fail/skip counts (parsed from TAP) and a log path. Nothing here writes "passed" by hand.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { constants, cpus, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { scanPackageNames } from './lib/package-name-scan.mjs'
import { readmePrograms } from './lib/readme-programs.mjs'
import { createStepRunner } from './lib/step-runner.mjs'
import { scanVendorNames } from './lib/vendor-name-scan.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const release = args.has('--release')
const dev = args.has('--dev') || !release
const insideArchive = args.has('--inside-archive') // set by the release step when re-running inside the unpacked archive
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
/** The workspace version, read from package.json: it names the release profile, the source archive and the manifest. */
const version = packageJson.version

/**
 * What this release is measured against, and the steps it must run: `scripts/release-profiles/<version>.json`.
 * The gate carries the machinery; the profile carries everything that changes from one release to the next — the
 * benchmark baseline and its commit, the inventory records this source must be identical to and the increment
 * registered against each, the `any` budget, the mutation-audit record, the packages this workspace publishes, where
 * the run writes its evidence, and the ordered list of step names. Every earlier release has a profile of its own in
 * that directory, extracted from its own manifest: a record of what it ran, so an old release can be reproduced from
 * its commit without the script that produced it.
 */
const profilePath = path.join(root, 'scripts', 'release-profiles', `${version}.json`)
if (!existsSync(profilePath)) {
  throw new Error(`No release profile for ${version}: expected ${path.relative(root, profilePath)}.`)
}
const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
if (profile.version !== version) {
  throw new Error(`Release profile ${path.relative(root, profilePath)} is for ${profile.version}, not ${version}.`)
}
/**
 * Where this run writes its evidence. Through 1.0.0-rc.5 the workspace version *was* the release's version, so the
 * gate composed `validation/v<version>-<mode>/` from it. Since the first public candidate the two are separate
 * numbers — `synajs@1.0.0-rc.1` published out of workspace 1.0.0-rc.6 — and a public release's evidence must not be
 * named after a private version that is not its own: the profile names the directory, and the public runs have a
 * lineage of their own under `validation/public/` (`validation/README.md`). A profile that names none keeps the
 * composed path, which is what the earlier releases ran with.
 */
const VALIDATION = profile.constants.validation ?? {}
const validationRel = (release ? VALIDATION.release : VALIDATION.dev) ?? `validation/v${version}-${release ? 'release' : 'dev'}`
const validationDir = path.join(root, validationRel)
const logsDir = path.join(validationDir, 'logs')
mkdirSync(logsDir, { recursive: true })
// The manifest this run replaces (if any) is read for comparison only; it never fails a run (I-116). The first run of
// a new validation line has no run of its own to replace: `validation.previousRelease` names the release run it
// continues from, so moving the line does not silently drop the comparison.
const manifestPath = path.join(validationDir, 'manifest.json')
const previousReleaseManifest = VALIDATION.previousRelease ? path.join(root, VALIDATION.previousRelease, 'manifest.json') : null
const previousPath = existsSync(manifestPath) ? manifestPath
  : release && previousReleaseManifest && existsSync(previousReleaseManifest) ? previousReleaseManifest
  : null
const previousManifest = previousPath ? JSON.parse(readFileSync(previousPath, 'utf8')) : null
let postgresInfo = null

const {
  benchmark: BENCHMARK,
  anyBaseline: ANY_BASELINE,
  inventory: INVENTORY,
  mutation: MUTATION,
  packages: PACKAGES,
} = profile.constants
// The baseline side of the same-session comparison, measured on this machine with `--no-maglev` on both sides
// (scripts/benchmark-same-session.mjs): the recorded file is the reference of the informational record-drift check,
// and the baseline itself only when the commit cannot be exported.
const BENCHMARK_BASELINE = BENCHMARK.baseline
const BASELINE_COMMIT = BENCHMARK.baselineCommit
const BASELINE_LABEL = BENCHMARK.baselineLabel
// Rounds per side (each round benchmarks both sides); the element-wise median of the rounds is compared, within ±10 %.
const BENCHMARK_RUNS = BENCHMARK.runs
// Rows this release is registered as faster on than the baseline by more than the tolerance. A registered row still
// fails when it is slower, an unregistered row still fails when it is faster, and a registered row fails when it is
// faster than the floor: a registration accounts for an improvement, it never hides a regression
// (scripts/tests/benchmark-registered-faster.test.mjs asserts all three).
const BENCHMARK_REGISTERED_FASTER = BENCHMARK.registeredFaster
const BENCHMARK_REGISTERED_FASTER_FLOOR = BENCHMARK.registeredFasterFloor
// The public API as the previous release gate recorded it, and the 0.8.0 record: the frozen surface
// (docs/API_STABILITY.md). This source's inventory must be identical to each, item by item, up to the registrations
// below. The two checks ask different questions: the diff against the previous release candidate must be empty, and
// the drift from the frozen surface must be exactly what has been registered against it since 0.8.0 — cumulative.
const INVENTORY_PREVIOUS = INVENTORY.previous
const INVENTORY_FROZEN = INVENTORY.frozen
const INVENTORY_REGISTERED_CHANGES = INVENTORY.registeredChanges
const INVENTORY_FROZEN_REGISTERED_CHANGES = INVENTORY.frozenRegisteredChanges
// The mutation audit is manual (scripts/mutation-audit.mjs); the gate reads the record of its last run.
const MUTATION_SCRIPT = MUTATION.script
const MUTATION_RECORD = MUTATION.record

const startedAt = new Date()
const steps = []
let blocked = []

function log(message) {
  process.stdout.write(`${message}\n`)
}

// Steps run in their own process groups under a bounded timeout policy: scripts/lib/step-runner.mjs (I-111).
// Every finished step is appended to the manifest by the runner itself (`onStep`), so no step can run unrecorded.
const runner = createStepRunner({ root, logsDir, log, portable, onStep: step => steps.push(step) })
const run = runner.run
// A signal to the gate ends the running step's whole process tree before the gate exits.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    log(`${signal}: ending the running step`)
    void runner.abort('SIGTERM').then(() => process.exit(128 + constants.signals[signal]))
  })
}

/** The multitenant-blog demo must have served all three cells (two HTTP tenants, one static build) with 200 and said so. */
function demoServedAllCells(output) {
  return /^demo: .* → HTTP alpha \/posts\/shared-slug: 200 /m.test(output)
    && /^demo: .* → HTTP beta \/posts\/shared-slug: 200 /m.test(output)
    && /^demo: .* → static alpha \/posts\/shared-slug\/ \(\d+ files\): 200 /m.test(output)
    && /^demo: OK$/m.test(output)
}

/**
 * The seven examples (apps/01-basics … apps/07-failure-modes; docs/EXAMPLES.md): each program asserts its own results
 * and exits non-zero otherwise, and each must print the stable lines its README lists and its `<name>: OK` line —
 * exit 0 alone is not enough. The lines are the ones the READMEs show under "What it prints".
 */
const EXAMPLES = [
  { name: '01-basics', lines: [
    /^01-basics: delivered welcome-1 to ada@example\.test \(receipt acme-1\)$/m,
    /^01-basics: connection opened only on the first delivery: true$/m,
    /^01-basics: connection closed after the world ended: true$/m,
    /^01-basics: logger closed last, by its own cleanup: true$/m,
  ] },
  { name: '02-per-tenant', lines: [
    /^02-per-tenant: a tenant world: 3 new, 0 forked, 2 reused services$/m,
    /^02-per-tenant: acme-corp → acme\/2\/1-1; globex-fans → acme\/2\/2-1$/m,
    /^02-per-tenant: separate outboxes and Acme clients per tenant: true; one store pool and one logger for all: true$/m,
    /^02-per-tenant: a sandbox world below acme-corp: 0 new, 3 forked, 2 reused services$/m,
    /^02-per-tenant: the sandbox has its own Acme client \(true\) on the shared pool #1: acme\/2\/3-1$/m,
    /^02-per-tenant: a caller asking for a fresh store under a shared one is refused: SHARE_CONSTRAINT_FAILED$/m,
  ] },
  { name: '03-user-configurable', lines: [
    /^03-user-configurable: settings page of globex-fans: Acme Notify 2\.4\.1, Globex Notify 3\.1\.0$/m,
    /^03-user-configurable: stored choice of globex-fans: \{"kind":"implementation-ref","contractId":"demo\.notify\.contract\/notifier\/v1","familyId":"demo\.notify\.globex","range":"\^3\.1\.0"\}$/m,
    /^03-user-configurable: acme-corp → Acme 2\.4\.1 \(receipt acme\/2\/1-1\); globex-fans → Globex 3\.1\.0 \(receipt globex\/1-1\)$/m,
    /^03-user-configurable: a hand-written document without a range is refused: INVALID_DESCRIPTOR \(malformed-implementation-ref\)$/m,
  ] },
  { name: '04-two-versions', lines: [
    /^04-two-versions: catalog: demo\.notify\.acme@2\.4\.1, demo\.notify\.acme@1\.8\.4, demo\.notify\.globex@3\.1\.0; Acme revisions: 2\.4\.1, 1\.8\.4$/m,
    /^04-two-versions: legacy tenant \(stored \^1\.8\.0\) → Acme 1\.8\.4, batches: no; new tenant \(\^2\.4\.1\) → Acme 2\.4\.1, batches: yes$/m,
    /^04-two-versions: a range taken from the 1\.x code: >=1\.8\.0 → 2\.4\.1, \^1\.8\.0 → 1\.8\.4$/m,
    /^04-two-versions: a stored choice for \^0\.9\.0 is refused: MISSING_IMPLEMENTATION \(available: 2\.4\.1, 1\.8\.4\); a world entered with it: MISSING_IMPLEMENTATION$/m,
  ] },
  { name: '05-scheduled-jobs', lines: [
    /^05-scheduled-jobs: the scheduler planned a digest world while it was starting: ok$/m,
    /^05-scheduled-jobs: digests for 2026-09-07: acme-corp \(pool #1\), globex-fans \(pool #1\); batches: acme\/2\/batch-1-1, acme\/2\/batch-2-1$/m,
    /^05-scheduled-jobs: worlds alive after the run: 1 \(each digest world closed when its run\(\) returned\)$/m,
    /^05-scheduled-jobs: entering a child world from inside setup is refused: ENTRY_ACTIVATION_FAILED \(cause OWNER_NOT_READY\)$/m,
  ] },
  { name: '06-testing', lines: [
    /^06-testing: real runtime: acme-corp\/welcome-1 via Acme 2\.4\.1, globex-fans\/invoice-2 via Acme 2\.4\.1$/m,
    /^06-testing: fake runtime: acme-corp\/welcome-1 via Acme fake, globex-fans\/invoice-2 via Acme fake$/m,
    /^06-testing: same tenants, notifications and outcomes under both: true$/m,
    /^06-testing: the fake recorded: acme-corp:welcome-1, globex-fans:invoice-2; overridden in the fake runtime: demo\.notify\.acme@2\.4\.1$/m,
  ] },
  { name: '07-failure-modes', lines: [
    /^07-failure-modes: sticky failure: 2 loads, 1 attempt; both rejected with "Acme refused the API key"; slot state: failed$/m,
    /^07-failure-modes: retry: flaky provider ready after attempt 3 of 3; provider down after 2 attempts \("Acme is down \(attempt 2\)"\); the next load after the cooldown started a new sequence: ready after 3 attempts in total$/m,
    /^07-failure-modes: slow start: LOAD_TIMEOUT for slot slow-start@1\.0\.0 after ≥ 50 ms \(attempt still running: true\); the slot stayed starting and overdue: true; a later load got the instance: true; events: attempt-overdue, attempt-succeeded-late \(adopted: true\); cleanup ran at close: true$/m,
    /^07-failure-modes: bounded close: dispose\(\) returned within the grace: true; env state: disposed; unsettled attempts on the runtime: 1 \(abandoned\); attempt-abandoned phase=setup dependencies=\[credentials: ready\]; runtime-attempts-outstanding: 1$/m,
    /^07-failure-modes: wait cycle: LOAD_TIMEOUT; suspected cycle over cycle-audit@1\.0\.0, cycle-client@1\.0\.0 \(an observation, not a proof\); pending loads: 1$/m,
  ] },
]
/** Every stable line of the example and its `<name>: OK` line are in the output. */
const examplePrinted = example => output => example.lines.every(line => line.test(output)) && new RegExp(`^${example.name}: OK$`, 'm').test(output)

/** The cluster script prints the server the step ran against; the manifest records it instead of a hand-typed version (I-115). */
function describePostgres(step) {
  const match = readFileSync(path.join(root, step.log), 'utf8').match(/^pg-test-cluster: server (.+?) at (postgres:\/\/\S+) \((.+?)\)$/m)
  return match ? { server: match[1], url: match[2], origin: match[3] } : null
}

/**
 * How this run relates to the manifest it replaces: same step list, same per-step test counts, or which
 * differences. Recorded, never used to fail the run — a new test is a legitimate difference (I-116).
 */
function compareWithPrevious(previous) {
  if (!previous || !Array.isArray(previous.steps)) return null
  const names = list => list.map(step => step.name)
  const before = new Map(previous.steps.map(step => [step.name, step]))
  const after = new Map(steps.map(step => [step.name, step]))
  const differences = []
  for (const name of before.keys()) if (!after.has(name)) differences.push(`step ${name} no longer runs`)
  for (const name of after.keys()) if (!before.has(name)) differences.push(`step ${name} is new`)
  const countChanges = []
  for (const [name, step] of after) {
    const old = before.get(name)
    if (!old?.tests || !step.tests) continue
    if (step.tests.tests !== old.tests.tests || step.tests.pass !== old.tests.pass) countChanges.push(`${name}: ${old.tests.pass}/${old.tests.tests} → ${step.tests.pass}/${step.tests.tests}`)
  }
  return {
    from: previousPath ? path.relative(root, previousPath) : null,
    generatedAt: previous.generatedAt ?? null,
    commit: previous.environment?.gitProvenance?.commit ?? null,
    sourceDigest: previous.source?.digest ?? null,
    status: previous.status ?? null,
    sameStepList: JSON.stringify(names(previous.steps)) === JSON.stringify(names(steps)),
    sameTestCounts: countChanges.length === 0,
    differences: [...differences, ...countChanges],
  }
}

/** Manifests must not leak the host's directory layout: the workspace root becomes `<root>`. */
function portable(text) {
  return text.split(root).join('<root>')
}

function gitInfo() {
  try {
    const { execSync } = process.getBuiltinModule('node:child_process')
    const commit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    // `dirty` keeps its 0.5 meaning (any porcelain line); `modified` and `untracked` say what made the tree dirty,
    // so an untracked file outside the archived set (a local task document) is not mistaken for a source change.
    const lines = execSync('git status --porcelain', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)
    const untracked = lines.filter(line => line.startsWith('??')).map(line => line.slice(3))
    const modified = lines.filter(line => !line.startsWith('??')).map(line => line.slice(3))
    return { commit, dirty: lines.length > 0, modified, untracked }
  }
  catch {
    return { commit: null, dirty: null, note: 'not a git repository or git unavailable' }
  }
}

/**
 * The source files of this release. `forArchive` adds `docs/VALIDATION.md`, which is generated
 * from a run's own manifest after that run and committed with it: it cannot be part of the
 * fingerprint the run records (the file the fingerprint would cover does not exist yet), but
 * leaving it out of the tarball too — as 1.0.0-rc.1 did — meant whoever unpacked the archive was
 * missing the one document that says what was verified. The archived copy is therefore the
 * previous run's, one release behind; this run's own record is the manifest in the evidence
 * directory the profile names, which is a sidecar of the archive and not inside it.
 */
function listSourceFiles({ forArchive = false } = {}) {
  const include = ['packages', 'apps', 'benchmarks', 'docs', 'scripts', 'validation/README.md']
  const rootFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'LICENSE', 'CHANGELOG.md', '.gitignore', '.npmrc']
  const excludeDir = new Set(['node_modules', 'dist', 'dist-local', '.tsbuildinfo', 'work', 'coverage'])
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (excludeDir.has(entry.name) || entry.name.startsWith('.tsbuildinfo') || entry.name === '.DS_Store') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(path.relative(root, full))
    }
  }
  for (const dir of include) {
    const full = path.join(root, dir)
    if (existsSync(full) && statSync(full).isDirectory()) walk(full)
    else if (existsSync(full)) files.push(dir)
  }
  for (const file of rootFiles) if (existsSync(path.join(root, file))) files.push(file)
  const githubDir = path.join(root, '.github')
  if (existsSync(githubDir)) walk(githubDir)
  // docs/VALIDATION.md is generated from this run's manifest after the run and committed with it (one run, one release
  // commit from 1.0.0-rc.1 on), so it is never fingerprinted: the fingerprint the run records has to hold on the commit
  // that carries it. Since 1.0.0-rc.5 it is archived anyway (see above).
  return [...new Set(files)].filter(file => (forArchive || file !== 'docs/VALIDATION.md') && !file.includes('/dist/') && !/^validation\/v[^/]+-dev\//.test(file)).sort()
}

function fingerprint(files) {
  const hash = createHash('sha256')
  const entries = files.map(file => {
    const digest = createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')
    hash.update(`${file}\n${digest}\n`)
    return { file, sha256: digest }
  })
  return { algorithm: 'sha256(path\\nsha256(content)\\n...)', files: entries.length, digest: hash.digest('hex') }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** The same-machine comparison is only meaningful on the machine the baseline was recorded on; elsewhere it is recorded as not comparable, never as a pass. */
function benchmarkBaselineEnvironment() {
  const baseline = JSON.parse(readFileSync(path.join(root, BENCHMARK_BASELINE), 'utf8')).environment ?? {}
  const host = { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length, node: process.version.split('.')[0] }
  const expected = { platform: baseline.platform, arch: baseline.arch, cpu: baseline.cpu, cpuCount: baseline.cpuCount, node: String(baseline.node ?? '').split('.')[0] }
  const differences = Object.keys(expected).filter(key => expected[key] !== host[key]).map(key => `${key}: baseline ${expected[key]}, host ${host[key]}`)
  return { comparable: differences.length === 0, differences, host, expected }
}

async function developmentGate() {
  // Build from source: never trust an existing dist.
  await run('clean', 'npm', ['run', 'clean'], { mustRun: true })
  await run('build', 'npm', ['run', 'build'])
  await run('type-tests', 'npm', ['run', 'type-tests'])
  await run('core-tests', 'node', ['--test', '--test-reporter=tap', ...glob('packages/core/tests', '.test.mjs')], { noSkip: true })
  // The reference application (apps/multitenant-blog): the same suites the runs up to 1.0.0-rc.1 ran under its former name.
  await run('blog-filesystem-tests', 'node', ['--test', '--test-reporter=tap', 'apps/multitenant-blog/tests/filesystem.test.mjs'], { noSkip: true })
  await run('blog-render-tests', 'node', ['--test', '--test-reporter=tap', 'apps/multitenant-blog/tests/render.test.mjs'], { noSkip: true })
  await run('blog-tenants-auth-preflight-tests', 'node', ['--test', '--test-reporter=tap', 'apps/multitenant-blog/tests/tenants-auth.test.mjs', 'apps/multitenant-blog/tests/preflight.test.mjs'], { noSkip: true })
  await run('blog-audit-regression-tests', 'node', ['--test', '--test-reporter=tap', 'apps/multitenant-blog/tests/audit-app.test.mjs'], { noSkip: true })
  await run('blog-review-regression-tests', 'node', ['--test', '--test-reporter=tap', 'apps/multitenant-blog/tests/review-app.test.mjs'], { noSkip: true })
  await run('blog-close-path-tests', 'node', ['--test', '--test-reporter=tap', 'apps/multitenant-blog/tests/rc3-close-paths.test.mjs', 'apps/multitenant-blog/tests/rc4-acquire-deadline.test.mjs'], { noSkip: true })
  await run('blog-site-manager-working-set-tests', 'node', ['--test', '--test-reporter=tap', '--expose-gc', 'apps/multitenant-blog/tests/site-manager.test.mjs'], { noSkip: true, env: { SYNA_WORKING_SET_OUT: path.join(validationDir, 'working-set.json') } })
  // Real PostgreSQL: a temporary cluster (or SYNA_TEST_PG_URL). Never skipped; a missing server is BLOCKED.
  const pgStep = await run('blog-postgres-and-matrix-tests', 'node', [
    'scripts/pg-test-cluster.mjs', 'with', '--',
    'node', '--test', '--test-reporter=tap', 'apps/multitenant-blog/tests/postgres.test.mjs', 'apps/multitenant-blog/tests/matrix.test.mjs',
  ], { noSkip: true, env: { SYNA_PG_CLUSTER_DIR: path.join(root, 'work', release ? 'pg-release' : 'pg-dev') } })
  if (!pgStep.ok && !pgStep.tests) {
    blocked.push({ step: pgStep.name, reason: 'PostgreSQL could not be started or reached (see log). Provide SYNA_TEST_PG_URL or install postgresql@17 binaries.' })
  }
  postgresInfo = describePostgres(pgStep)
  // The gate's own tooling plus the v0.8 assertions: empty deprecation register, the no-old-names scan (every pre-0.8 name),
  // the README example, the API inventory and its doc-aware diff, the codemod on a fixture, the `any` budget; 1.0.0-rc.2:
  // the vendor-name scan and the re-keyed `any` baseline.
  await run('gate-self-tests', 'node', ['--test', '--test-reporter=tap', ...glob('scripts/tests', '.test.mjs')], { noSkip: true })
  // 1.0.0-rc.5: the mutation audit is a manual check, not a step of every run — a full
  // mutation engine in CI would cost far more than it tells anyone. What the gate asserts is
  // that the record of the last manual run says both standing counter-examples were killed,
  // and that the sources and tests it was produced from are byte for byte the ones in this
  // tree. A record from other sources is stale, and stale is not evidence.
  {
    const script = path.join(root, MUTATION_SCRIPT)
    const recordFile = path.join(root, MUTATION_RECORD)
    const record = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) : null
    const stale = record ? Object.entries(record.inputs ?? {}).filter(([file, digest]) =>
      !existsSync(path.join(root, file)) || sha256File(path.join(root, file)) !== digest).map(([file]) => file) : []
    const survived = record ? (record.results ?? []).filter(item => !item.killed).map(item => item.name) : []
    const ok = existsSync(script) && record !== null && record.status === 'ALL_KILLED'
      && record.partial === undefined && survived.length === 0 && stale.length === 0
      && (record.results ?? []).length >= 2
    const note = record === null
      ? `${MUTATION_RECORD} is absent: run \`node ${MUTATION_SCRIPT}\``
      : `${(record.results ?? []).length} mutant(s) recorded ${record.generatedAt} on ${record.node}`
        + `, ${survived.length} survived, ${Object.keys(record.inputs ?? {}).length} input file(s) checked`
        + `${stale.length > 0 ? `, ${stale.length} changed since` : ''}`
    steps.push({ name: 'mutation-audit-record', ok, exitCode: ok ? 0 : 1, mustRun: true, command: 'internal', log: MUTATION_RECORD, note, ...(survived.length > 0 ? { survived } : {}), ...(stale.length > 0 ? { stale } : {}) })
    log(`${ok ? 'ok  ' : 'FAIL'} mutation-audit-record (${note})`)
  }
  // The public API inventory of this source, the gate's own assertion that no item of it is deprecated (A11 in 0.7,
  // a success criterion of 0.8), its diff against the 1.0.0-rc.2 record when that record is present, and — the frozen
  // surface — the assertion that the inventory differs from the 1.0.0-rc.2 record and from the 0.8.0 record by exactly
  // the registered increment of this round and by nothing else, item by item.
  const inventoryStep = await run('api-inventory', 'node', ['scripts/api-inventory.mjs', '--out', path.join(validationDir, 'api-inventory.md'), '--json', path.join(validationDir, 'api-inventory.json')])
  {
    const inventoryFile = path.join(validationDir, 'api-inventory.json')
    const inventory = inventoryStep.ok && existsSync(inventoryFile) ? JSON.parse(readFileSync(inventoryFile, 'utf8')) : null
    const deprecated = inventory ? inventory.items.filter(item => item.deprecated).map(item => item.path) : null
    const ok = deprecated !== null && deprecated.length === 0
    const note = inventory ? `${inventory.items.length} items, ${deprecated.length} @deprecated` : 'no inventory was produced'
    steps.push({ name: 'api-inventory-no-deprecated', ok, exitCode: ok ? 0 : 1, mustRun: true, command: 'internal', log: path.relative(root, inventoryFile), note, ...(deprecated && deprecated.length > 0 ? { deprecated } : {}) })
    log(`${ok ? 'ok  ' : 'FAIL'} api-inventory-no-deprecated (${note})`)
  }
  // Identity with a recorded inventory, up to the registered increment: every item of the record — path, kind,
  // signature, JSDoc, deprecation — is in this source's inventory unchanged except the registered ones, each of which
  // must differ; nothing is added or removed, so the two item lists have the same size.
  const identicalTo = (name, recordFile, logFile, registeredChanges) => {
    const inventoryFile = path.join(validationDir, 'api-inventory.json')
    const record = JSON.parse(readFileSync(path.join(root, recordFile), 'utf8'))
    const current = existsSync(inventoryFile) ? JSON.parse(readFileSync(inventoryFile, 'utf8')) : null
    const key = item => JSON.stringify([item.path, item.kind, item.signature, item.doc ?? '', item.deprecated === true, item.note ?? ''])
    const registered = item => registeredChanges.includes(item.path)
    const recordKeys = new Set(record.items.map(key))
    const currentKeys = new Set(current ? current.items.map(key) : [])
    const gone = current ? record.items.filter(item => !currentKeys.has(key(item))).map(item => item.path) : []
    const fresh = current ? current.items.filter(item => !recordKeys.has(key(item))).map(item => item.path) : []
    // A changed item is on both lists (its recorded form is gone, its current form is new);
    // a removal would be on `gone` alone and an addition on `fresh` alone.
    const changed = gone.filter(item => fresh.includes(item))
    const removed = gone.filter(item => !fresh.includes(item))
    const added = fresh.filter(item => !gone.includes(item))
    const unregistered = [...new Set([...changed, ...removed, ...added])].filter(item => !registeredChanges.includes(item))
    const missing = registeredChanges.filter(item => !changed.includes(item))
    const ok = current !== null && unregistered.length === 0 && missing.length === 0
      && removed.length === 0 && added.length === 0 && current.items.length === record.items.length
      && current.items.filter(registered).length === registeredChanges.length
    const note = current
      ? `${current.items.length} items here, ${record.items.length} in the ${record.version} record (${recordFile}, commit ${record.commit}); 0 added, ${removed.length} removed, ${changed.length} changed — the registration of ${version} for this comparison is ${registeredChanges.length} item(s)${unregistered.length > 0 ? `, and ${unregistered.length} unregistered` : ''}${missing.length > 0 ? `; ${missing.length} registered item did not change` : ''}`
      : 'no inventory was produced'
    steps.push({ name, ok, exitCode: ok ? 0 : 1, mustRun: true, command: 'internal', log: path.relative(root, logFile), note, ...(changed.length > 0 ? { changed } : {}), ...(added.length > 0 ? { added } : {}), ...(removed.length > 0 ? { removed } : {}), ...(unregistered.length > 0 ? { unregistered } : {}), ...(missing.length > 0 ? { missing } : {}) })
    log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${note})`)
  }
  if (existsSync(path.join(root, INVENTORY_PREVIOUS))) {
    // The doc-aware diff against the previous release candidate, and the assertion that it is exactly the registered
    // increment of this round: 0 added, 0 removed, 3 changed.
    await run('api-inventory-diff', 'node', ['scripts/api-inventory.mjs', '--diff', INVENTORY_PREVIOUS, path.join(validationDir, 'api-inventory.json'), '--out', path.join(validationDir, 'api-inventory-diff.md')])
    identicalTo('api-inventory-unchanged', INVENTORY_PREVIOUS, path.join(validationDir, 'api-inventory-diff.md'), INVENTORY_REGISTERED_CHANGES)
  }
  else {
    steps.push({ name: 'api-inventory-diff', ok: true, exitCode: 0, mustRun: false, command: 'internal', log: path.relative(root, path.join(validationDir, 'api-inventory.json')), note: `${INVENTORY_PREVIOUS} is not part of this tree (the records live in the source repository); the inventory of this source was recorded` })
    log(`skip api-inventory-diff (${INVENTORY_PREVIOUS} absent; not a test)`)
  }
  // Frozen surface (docs/API_STABILITY.md): identical to the 0.8.0 record.
  if (existsSync(path.join(root, INVENTORY_FROZEN))) identicalTo('api-inventory-frozen', INVENTORY_FROZEN, path.join(validationDir, 'api-inventory.json'), INVENTORY_FROZEN_REGISTERED_CHANGES)
  // v0.8 evidence: the rename codemod makes no edit on the migrated tree and finds no site that needs a hand (idempotent).
  await run('codemod-idempotent', 'node', ['scripts/codemod-v08.mjs', '--dry-run', '--json', path.join(validationDir, 'codemod-idempotent.json')], { expectStdout: output => /^codemod-v08 \(dry run\): 0 edits in 0 files; 0 manual$/m.test(output) })
  // v0.8 evidence (A05): the core source, tests and type tests spell none of the pre-0.8 reference tokens — the old
  // serialized key, the old kind and the word that named the old read path (the 0.5 recording and its mapping are JSON data).
  {
    const tokens = /\b(implementationId|legacy)\b|persistent-implementation-ref/ // syna-v08-rename
    const scanned = []
    const hits = []
    const walkDir = current => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) walkDir(full)
        else if (/\.(ts|mjs)$/.test(entry.name)) {
          const rel = path.relative(root, full)
          scanned.push(rel)
          readFileSync(full, 'utf8').split('\n').forEach((line, index) => { if (tokens.test(line)) hits.push(`${rel}:${index + 1}: ${line.trim().slice(0, 120)}`) })
        }
      }
    }
    for (const dir of ['packages/core/src', 'packages/core/tests', 'packages/core/type-tests']) walkDir(path.join(root, dir))
    const scanFile = path.join(validationDir, 'old-reference-tokens.json')
    writeFileSync(scanFile, JSON.stringify({ pattern: tokens.source, scanned, hits }, null, 2))
    const ok = hits.length === 0
    steps.push({ name: 'no-old-reference-tokens', ok, exitCode: ok ? 0 : 1, mustRun: true, command: 'internal', log: path.relative(root, scanFile), note: `${scanned.length} files scanned, ${hits.length} hits`, ...(hits.length > 0 ? { hits } : {}) })
    log(`${ok ? 'ok  ' : 'FAIL'} no-old-reference-tokens (${scanned.length} files scanned, ${hits.length} hits)`)
  }
  // 1.0.0-rc.2 evidence (docs/EXAMPLES.md, the naming rule): no real vendor name as a fictional component name and no
  // pre-rc.2 name of the reference application as a component name or path, in any current file — sources, tests,
  // examples, benchmarks, scripts, workflow, documents, package metadata. The historical documents, the ledgers under
  // work/ and the recorded evidence keep their wording; the application's own on-disk literals that the rename left
  // alone are allowed by name and every allowed hit is listed, so the allow-list stays visible.
  {
    const scan = scanVendorNames(root)
    const scanFile = path.join(validationDir, 'vendor-name-scan.json')
    writeFileSync(scanFile, JSON.stringify({ files: scan.files.length, hits: scan.hits, allowed: scan.allowed }, null, 2))
    const ok = scan.hits.length === 0
    const note = `${scan.files.length} files scanned, ${scan.hits.length} hits, ${scan.allowed.length} allowed literals of the application`
    steps.push({ name: 'no-vendor-names', ok, exitCode: ok ? 0 : 1, mustRun: true, command: 'internal', log: path.relative(root, scanFile), note, ...(scan.hits.length > 0 ? { hits: scan.hits.map(hit => `${hit.file}:${hit.line} [${hit.name}] ${hit.text}`) } : {}) })
    log(`${ok ? 'ok  ' : 'FAIL'} no-vendor-names (${note})`)
  }
  // 1.0.0-rc.1 evidence (the first public candidate): no current file installs, imports or extends the temporary
  // package identities `@syna/core` and `@syna/tsconfig` (syna-public-rename). The record keeps them — history,
  // migrations, recorded runs, ledgers, benchmark records — and the two current lines that spell one on purpose (the
  // runtime's own nominal package identity, which is serialized, and the sentence of docs/API_STABILITY.md that names
  // it) are allowed by literal and listed, so the allow-list stays visible (scripts/lib/package-name-scan.mjs).
  {
    const scan = scanPackageNames(root)
    const scanFile = path.join(validationDir, 'package-name-scan.json')
    writeFileSync(scanFile, JSON.stringify({ files: scan.files.length, hits: scan.hits, allowed: scan.allowed, marked: scan.marked }, null, 2))
    const ok = scan.hits.length === 0
    const note = `${scan.files.length} files scanned, ${scan.hits.length} hits, ${scan.allowed.length} allowed lines of the frozen identity, ${scan.marked.length} explaining the rename`
    steps.push({ name: 'no-legacy-package-names', ok, exitCode: ok ? 0 : 1, mustRun: true, command: 'internal', log: path.relative(root, scanFile), note, ...(scan.hits.length > 0 ? { hits: scan.hits.map(hit => `${hit.file}:${hit.line} [${hit.name}] ${hit.text}`) } : {}) })
    log(`${ok ? 'ok  ' : 'FAIL'} no-legacy-package-names (${note})`)
  }
  // `any` per file at or under the 0.7.0 record re-keyed for this line (files absent from it may not use `any` at all).
  await run('any-count', 'node', ['scripts/any-count.mjs', '--check', ANY_BASELINE])
  // The seven examples, one step each: the program asserts its own results (exit 1 otherwise) and must print the
  // stable lines of its README and its `<name>: OK` line.
  for (const example of EXAMPLES) await run(`demo-${example.name}`, 'node', [`apps/${example.name}/dist/index.js`], { expectStdout: examplePrinted(example) })
  await run('blog-demo-filesystem', 'node', ['apps/multitenant-blog/bin/multitenant-blog.mjs', 'demo', '--root', path.join(root, 'work', 'demo-content')], { expectStdout: demoServedAllCells })
  rmSync(path.join(root, 'work', 'demo-content'), { recursive: true, force: true })
  await run('benchmarks', 'node', ['--expose-gc', 'benchmarks/v0.5-planning.mjs', path.join(validationDir, 'benchmark-v0.5.json')])
  // Same-machine comparison with 1.0.0-rc.1: every p50/p95 within ±10 %, every plan-cache counter equal; both benchmark
  // processes run with `--no-maglev`. Same session when the 1.0.0-rc.1 commit can be exported (both sides measured under
  // the same machine state, interleaved rounds); else the recorded baseline file, and only where the host matches the
  // machine it was recorded on.
  const baselineExportable = spawnSync('git', ['cat-file', '-e', `${BASELINE_COMMIT}^{commit}`], { cwd: root, stdio: 'ignore' }).status === 0
  const comparability = benchmarkBaselineEnvironment()
  if (baselineExportable) {
    await run('benchmark-compare', 'node', ['scripts/benchmark-same-session.mjs', '--commit', BASELINE_COMMIT, '--baseline-label', BASELINE_LABEL, '--record', BENCHMARK_BASELINE, '--runs', String(BENCHMARK_RUNS), '--faster-ok', BENCHMARK_REGISTERED_FASTER.join(','), '--faster-floor', BENCHMARK_REGISTERED_FASTER_FLOOR, '--out-dir', path.join(validationDir, 'benchmark-compare')], { expectStdout: output => /^SAME-SESSION BENCHMARK COMPARISON OK$/m.test(output) })
  }
  else if (comparability.comparable) {
    await run('benchmark-compare', 'node', ['scripts/benchmark-compare.mjs', 'compare', '--baseline', BENCHMARK_BASELINE, '--runs', String(BENCHMARK_RUNS), '--faster-ok', BENCHMARK_REGISTERED_FASTER.join(','), '--faster-floor', BENCHMARK_REGISTERED_FASTER_FLOOR, '--out', path.join(validationDir, 'benchmark-compare.json')], { expectStdout: output => /^BENCHMARK COMPARISON OK$/m.test(output) })
  }
  else {
    steps.push({ name: 'benchmark-compare', ok: true, exitCode: 0, mustRun: false, command: 'internal', log: path.relative(root, path.join(validationDir, 'benchmark-v0.5.json')), note: `not comparable on this host (${comparability.differences.join('; ')}); the same-machine comparison is recorded only on the baseline's machine` })
    log(`skip benchmark-compare (${comparability.differences.join('; ')}; not a test)`)
  }
  // Report only (no budget): end-to-end request latency on both backends, PostgreSQL through the temporary cluster.
  await run('blog-request-latency', 'node', [
    'scripts/pg-test-cluster.mjs', 'with', '--',
    'node', 'benchmarks/blog-request-latency.mjs', path.join(validationDir, 'blog-request-latency.json'),
  ], { env: { SYNA_PG_CLUSTER_DIR: path.join(root, 'work', release ? 'pg-release' : 'pg-dev') } })
  if (!existsSync(path.join(validationDir, 'working-set.json'))) {
    steps.push({ name: 'working-set-report', ok: false, exitCode: 1, mustRun: true, command: 'internal', log: path.relative(root, path.join(validationDir, 'working-set.json')), note: 'site-manager tests did not write the working-set report' })
  }
}

/** Every matching file under `dir`, recursively: the core suites are grouped by behaviour domain (packages/core/tests/README.md). */
function glob(dir, suffix, base = root) {
  const walk = (current) => readdirSync(path.join(base, current), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(path.join(current, entry.name)) : entry.name.endsWith(suffix) ? [path.join(current, entry.name)] : [])
  return walk(dir).sort()
}

/**
 * What the two tarballs of this release are (1.0.0-rc.1, the first public candidate). The names, the versions and the
 * directories come from the release profile, not from the tree, so a rename cannot pass unnoticed: the manifest inside
 * each tarball must be the package the profile declares. The runtime tarball must carry exactly what its `files` says —
 * `package.json`, `README.md`, `LICENSE` and `dist/` — with the README byte for byte the canonical root README (npm and
 * GitHub show one document), and it must not ask a consumer for the temporary package identity or for the tsconfig
 * preset package, which belongs to package authors — nor for the unscoped `syna` the candidate was first prepared as.
 */
function packMetadata(runtimePack, tsconfigPack) {
  const problems = []
  const listing = pack => {
    if (!pack.item) {
      problems.push(`${pack.file}: npm pack produced no such tarball (${pack.declared.name}@${pack.declared.version})`)
      return []
    }
    const result = spawnSync('tar', ['-tzf', path.join(root, pack.item.path)], { encoding: 'utf8' })
    if (result.status !== 0) {
      problems.push(`${pack.file}: tar -tzf exited ${result.status}`)
      return []
    }
    return result.stdout.split('\n').filter(Boolean).map(entry => entry.replace(/^package\//, '')).filter(entry => entry !== '' && !entry.endsWith('/'))
  }
  const contents = (pack, file) => spawnSync('tar', ['-xzOf', path.join(root, pack.item.path), `package/${file}`], { encoding: 'utf8' }).stdout
  for (const pack of [runtimePack, tsconfigPack]) {
    if (pack.manifest.name !== pack.declared.name) problems.push(`${pack.declared.directory}: name is ${pack.manifest.name}, the profile declares ${pack.declared.name}`)
    if (pack.manifest.version !== pack.declared.version) problems.push(`${pack.declared.name}: version is ${pack.manifest.version}, the profile declares ${pack.declared.version}`)
  }
  const runtimeEntries = listing(runtimePack)
  const tsconfigEntries = listing(tsconfigPack)
  const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']
  for (const file of REQUIRED) if (!runtimeEntries.includes(file)) problems.push(`${runtimePack.file}: ${file} is missing`)
  // `files: ["dist", "README.md", "LICENSE"]` — anything else is monorepo material that escaped into the package.
  for (const entry of runtimeEntries) {
    if (!entry.startsWith('dist/') && !['package.json', 'README.md', 'LICENSE'].includes(entry)) problems.push(`${runtimePack.file}: ${entry} is not part of the published package`)
  }
  const TSCONFIG_FILES = ['package.json', 'README.md', 'LICENSE', 'node-app.json', 'node-library.json']
  for (const file of TSCONFIG_FILES) if (!tsconfigEntries.includes(file)) problems.push(`${tsconfigPack.file}: ${file} is missing`)
  for (const entry of tsconfigEntries) if (!TSCONFIG_FILES.includes(entry)) problems.push(`${tsconfigPack.file}: ${entry} is not part of the published package`)
  // The runtime a consumer installs asks for `semver` and for nothing of this workspace.
  if (runtimePack.item) {
    const packedManifest = JSON.parse(contents(runtimePack, 'package.json'))
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(packedManifest[field] ?? {})) {
        if (name.startsWith('@syna/') || name === 'syna' || name === '@synajs/tsconfig' || name.startsWith('@syna-demo/') || name.startsWith('@syna-app/')) {
          problems.push(`${runtimePack.file}: ${field} asks for ${name}`)
        }
      }
    }
    const canonical = readFileSync(path.join(root, 'README.md'), 'utf8')
    if (contents(runtimePack, 'README.md') !== canonical) problems.push(`${runtimePack.file}: README.md is not the canonical root README`)
  }
  const auditFile = path.join(validationDir, 'pack-audit.json')
  writeFileSync(auditFile, JSON.stringify({
    runtime: { file: runtimePack.file, declared: runtimePack.declared, entries: runtimeEntries },
    tsconfig: { file: tsconfigPack.file, declared: tsconfigPack.declared, entries: tsconfigEntries },
    problems,
  }, null, 2))
  const ok = problems.length === 0
  const note = `${runtimePack.file} (${runtimeEntries.length} files), ${tsconfigPack.file} (${tsconfigEntries.length} files), ${problems.length} problem(s)`
  steps.push({ name: 'pack-metadata', ok, exitCode: ok ? 0 : 1, mustRun: true, command: 'internal', log: path.relative(root, auditFile), note, ...(problems.length > 0 ? { problems } : {}) })
  log(`${ok ? 'ok  ' : 'FAIL'} pack-metadata (${note})`)
}

/**
 * The README consumer (1.0.0-rc.1): a project that exists only because the canonical README says so. Its
 * `package.json`, its `tsconfig.json` and its programs are the blocks of the README, read out of the document itself
 * (`scripts/lib/readme-programs.mjs`); its one dependency is the runtime tarball this run packed — what
 * `npm install synajs@rc` would fetch — and TypeScript is a build tool of the consumer, not a dependency of the runtime.
 * Each program must print exactly what the README says it prints, and nothing of this workspace may appear in the
 * installed tree: not the temporary package identity, not the unscoped `syna` the candidate was first prepared as,
 * and not the tsconfig preset package.
 */
async function readmeConsumer(directory, runtimePack) {
  const { files, outputs } = readmePrograms(readFileSync(path.join(root, 'README.md'), 'utf8'))
  mkdirSync(directory, { recursive: true })
  for (const { file, code } of files) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
    writeFileSync(path.join(directory, file), code)
  }
  const workspaceManifest = readFileSync(path.join(root, 'package.json'), 'utf8')
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
  manifest.dependencies = { [PACKAGES.runtime.name]: `file:${path.join(root, runtimePack.item.path)}` }
  manifest.devDependencies = {
    typescript: workspaceManifest.match(/"typescript": "([^"]+)"/)[1],
    '@types/node': workspaceManifest.match(/"@types\/node": "([^"]+)"/)[1],
  }
  writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await run('readme-consumer-install', 'npm', ['install', '--no-fund', '--no-audit'], { cwd: directory })
  await run('readme-consumer-build', 'node', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: directory })
  for (const [file, printed] of outputs) {
    const built = file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')
    await run(`readme-consumer-${path.basename(file, '.ts')}`, 'node', [built], { cwd: directory, expectStdout: output => output === printed })
  }
  const lock = existsSync(path.join(directory, 'package-lock.json')) ? JSON.parse(readFileSync(path.join(directory, 'package-lock.json'), 'utf8')) : { packages: {} }
  const installed = Object.keys(lock.packages ?? {}).filter(key => key.startsWith('node_modules/')).map(key => key.slice('node_modules/'.length))
  const problems = []
  for (const name of installed) {
    if (name.startsWith('@syna/') || name === 'syna' || name === '@synajs/tsconfig') problems.push(`the README consumer installed ${name}`)
  }
  if (!installed.includes(PACKAGES.runtime.name)) problems.push(`the README consumer did not install ${PACKAGES.runtime.name}`)
  if (files.some(item => item.file === 'tsconfig.json') === false) problems.push('the README prints no tsconfig.json of its own')
  const resultFile = path.join(validationDir, 'readme-consumer.json')
  writeFileSync(resultFile, JSON.stringify({
    readme: { sha256: createHash('sha256').update(readFileSync(path.join(root, 'README.md'))).digest('hex'), files: files.map(item => item.file), programs: [...outputs.keys()] },
    tarball: runtimePack.file, installed, problems,
  }, null, 2))
  const ok = problems.length === 0
  const note = `${files.length} README files, ${outputs.size} program(s) run, ${installed.length} package(s) installed, ${problems.length} problem(s)`
  steps.push({ name: 'readme-consumer-result', ok, exitCode: ok ? 0 : 1, mustRun: true, command: 'internal', log: path.relative(root, resultFile), note, ...(problems.length > 0 ? { problems } : {}) })
  log(`${ok ? 'ok  ' : 'FAIL'} readme-consumer-result (${note})`)
}

async function releaseGate(sourceFingerprint) {
  const releaseDir = path.join(root, 'work', 'release')
  rmSync(releaseDir, { recursive: true, force: true })
  mkdirSync(releaseDir, { recursive: true })
  const archiveBase = `syna-v${version}-source`
  const stagingDir = path.join(releaseDir, archiveBase)
  mkdirSync(stagingDir, { recursive: true })
  const files = listSourceFiles({ forArchive: true })
  for (const file of files) {
    const target = path.join(stagingDir, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(path.join(root, file)))
  }
  // Absolute-path and secret scan on the staged tree.
  const offenders = []
  for (const file of files) {
    const content = readFileSync(path.join(stagingDir, file), 'utf8')
    if (/\/Users\/[a-z]|\/home\/[a-z]/.test(content) && !file.startsWith('validation/')) offenders.push(`${file}: absolute home path`)
    if (/postgres:\/\/[^\s'"`$]+:[^\s'"`$]+@/.test(content)) offenders.push(`${file}: credential-bearing connection string`)
  }
  writeFileSync(path.join(validationDir, 'archive-scan.json'), JSON.stringify({ files: files.length, offenders }, null, 2))
  const scanLog = `${validationRel}/archive-scan.json`
  if (offenders.length > 0) {
    steps.push({ name: 'archive-scan', ok: false, exitCode: 1, mustRun: true, command: 'internal', log: scanLog, offenders })
    log(`FAIL archive-scan: ${offenders.join('; ')}`)
  }
  else {
    steps.push({ name: 'archive-scan', ok: true, exitCode: 0, mustRun: true, command: 'internal', log: scanLog })
    log('ok   archive-scan')
  }
  const tarPath = path.join(releaseDir, `${archiveBase}.tar.gz`)
  const zipPath = path.join(releaseDir, `${archiveBase}.zip`)
  await run('archive-tar', 'tar', ['-czf', tarPath, '-C', releaseDir, archiveBase])
  await run('archive-zip', 'zip', ['-qr', zipPath, archiveBase], { cwd: releaseDir })
  const archives = [tarPath, zipPath].filter(existsSync).map(file => ({ path: path.relative(root, file), bytes: statSync(file).size, sha256: sha256File(file) }))

  // Rebuild from the tarball in a fresh empty directory: install from lockfile, compile, run the must-run suites.
  const rebuildDir = await mkdtemp(path.join(tmpdir(), 'syna-release-rebuild-'))
  await run('rebuild-unpack', 'tar', ['-xzf', tarPath, '-C', rebuildDir])
  const unpacked = path.join(rebuildDir, archiveBase)
  const rebuildLogs = { cwd: unpacked }
  await run('rebuild-install', 'npm', ['ci', '--no-fund', '--no-audit'], rebuildLogs)
  await run('rebuild-build', 'npm', ['run', 'build'], rebuildLogs)
  await run('rebuild-type-tests', 'npm', ['run', 'type-tests'], rebuildLogs)
  await run('rebuild-core-tests', 'node', ['--test', '--test-reporter=tap', ...glob('packages/core/tests', '.test.mjs', unpacked)], { ...rebuildLogs, noSkip: true })
  await run('rebuild-app-tests', 'node', ['--test', '--test-reporter=tap', '--expose-gc', 'apps/multitenant-blog/tests/filesystem.test.mjs', 'apps/multitenant-blog/tests/render.test.mjs', 'apps/multitenant-blog/tests/tenants-auth.test.mjs', 'apps/multitenant-blog/tests/preflight.test.mjs', 'apps/multitenant-blog/tests/audit-app.test.mjs', 'apps/multitenant-blog/tests/review-app.test.mjs', 'apps/multitenant-blog/tests/rc3-close-paths.test.mjs', 'apps/multitenant-blog/tests/rc4-acquire-deadline.test.mjs', 'apps/multitenant-blog/tests/site-manager.test.mjs'], { ...rebuildLogs, noSkip: true })
  await run('rebuild-postgres-matrix-tests', 'node', ['scripts/pg-test-cluster.mjs', 'with', '--', 'node', '--test', '--test-reporter=tap', 'apps/multitenant-blog/tests/postgres.test.mjs', 'apps/multitenant-blog/tests/matrix.test.mjs'], { ...rebuildLogs, noSkip: true, env: { SYNA_PG_CLUSTER_DIR: path.join(rebuildDir, 'pg') } })
  // Inside the archive the gate self-tests also re-run the deprecation list, the no-old-names scan, the README example, the codemod fixture and the `any` budget.
  await run('rebuild-gate-self-tests', 'node', ['--test', '--test-reporter=tap', ...readdirSync(path.join(unpacked, 'scripts/tests')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `scripts/tests/${f}`)], { ...rebuildLogs, noSkip: true })
  await run('rebuild-codemod-idempotent', 'node', ['scripts/codemod-v08.mjs', '--dry-run'], { ...rebuildLogs, expectStdout: output => /^codemod-v08 \(dry run\): 0 edits in 0 files; 0 manual$/m.test(output) })
  await run('rebuild-demo', 'node', ['apps/multitenant-blog/bin/multitenant-blog.mjs', 'demo', '--root', path.join(rebuildDir, 'demo-content')], { ...rebuildLogs, expectStdout: demoServedAllCells })
  // The seven examples as the README runs them (`npm run demo`: build, then the seven programs), every stable line of every example in the output.
  await run('rebuild-examples', 'npm', ['run', 'demo'], { ...rebuildLogs, expectStdout: output => EXAMPLES.every(example => examplePrinted(example)(output)) })

  // Package tarball + independent consumer project.
  const packDir = path.join(releaseDir, 'pack')
  mkdirSync(packDir, { recursive: true })
  await run('pack-core', 'npm', ['pack', '--pack-destination', packDir, path.join(unpacked, PACKAGES.runtime.directory)], { cwd: packDir })
  await run('pack-tsconfig', 'npm', ['pack', '--pack-destination', packDir, path.join(unpacked, PACKAGES.tsconfig.directory)], { cwd: packDir })
  const packed = readdirSync(packDir).filter(file => file.endsWith('.tgz')).map(file => ({ path: path.relative(root, path.join(packDir, file)), bytes: statSync(path.join(packDir, file)).size, sha256: sha256File(path.join(packDir, file)) }))
  // The tarball of a package is the one npm names from the manifest: `synajs-1.0.0-rc.1.tgz`,
  // `synajs-tsconfig-1.0.0-rc.1.tgz`. Matching by substring would let one stand in for the other.
  const packedTarball = key => {
    const declared = PACKAGES[key]
    const manifest = JSON.parse(readFileSync(path.join(unpacked, declared.directory, 'package.json'), 'utf8'))
    const file = `${declared.name.replace('@', '').replace('/', '-')}-${declared.version}.tgz`
    return { declared, manifest, file, item: packed.find(entry => path.basename(entry.path) === file) }
  }
  const runtimePack = packedTarball('runtime')
  const tsconfigPack = packedTarball('tsconfig')
  packMetadata(runtimePack, tsconfigPack)
  const consumerDir = path.join(rebuildDir, 'consumer')
  mkdirSync(consumerDir, { recursive: true })
  const coreTgz = runtimePack.item
  writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({
    name: '@smoke/consumer', version: '7.3.1', private: true, type: 'module',
    imports: { '#syna/package': './package.json' },
    syna: { id: 'smoke.consumer' },
    scripts: { build: 'tsc -p tsconfig.json', start: 'node dist/index.js' },
    dependencies: { [PACKAGES.runtime.name]: `file:${path.join(root, coreTgz.path)}` },
    devDependencies: { typescript: readFileSync(path.join(root, 'package.json'), 'utf8').match(/"typescript": "([^"]+)"/)[1], '@types/node': readFileSync(path.join(root, 'package.json'), 'utf8').match(/"@types\/node": "([^"]+)"/)[1] },
  }, null, 2))
  // A standalone tsconfig, not the preset package: `@synajs/tsconfig` is for package authors, and a consumer of the
  // runtime must not need it (docs/PACKAGE_AUTHORING.md). These are the settings the README prints.
  writeFileSync(path.join(consumerDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', resolveJsonModule: true, strict: true,
      exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, skipLibCheck: true,
      lib: ['ES2022', 'ESNext.Disposable'], rootDir: 'src', outDir: 'dist',
    },
    include: ['src/**/*.ts'],
  }, null, 2))
  mkdirSync(path.join(consumerDir, 'src'), { recursive: true })
  // The consumer uses the 0.8 surface only (`Env` and `SlotState` types, `limits.loadTimeoutMs`, `derive({ reuse })`,
  // `catalog.revisions(family)`, `anchor`, `reuse`, `isSynaError` narrowing, `env.inspect().abandonedAttempts`) against the
  // packed declarations; a pre-0.8 name would not compile.
  writeFileSync(path.join(consumerDir, 'src/index.ts'), `import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage, isSynaError, type Env, type InputRef, type Runtime, type SlotState } from 'synajs'

const define = definePackage(packageJson)
const Answer = define.input<number>('answer')
const Doubler = define.service('doubler', {
  requires: { answer: Answer },
  setup({ answer }) {
    const ref: InputRef<number> = answer
    return { result: ref.read() * 2 }
  },
})
const Main = define.entry({ requires: { doubler: Doubler }, parameters: { answer: Answer } })
const Again = define.entry('again', { requires: { doubler: Doubler }, reuse: { fresh: [Doubler] } })
const runtime: Runtime = createRuntime({ services: [Doubler], limits: { loadTimeoutMs: 5_000, disposalGraceMs: 1_000 } })
let abandoned = -1
let slots: SlotState[] = []
const result = await runtime.run(Main, { answer: 21 }, async ({ doubler }, env) => {
  const shared = await doubler.load()
  const anchored = env.anchor(Again)
  const own = await anchored.run(async deps => (await deps.doubler.load()).result)
  const child: Env<{}> = await env.derive({ reuse: { fresh: [Doubler] } })
  await child.dispose()
  slots = env.inspect().nodes.map(node => node.state)
  abandoned = env.inspect().abandonedAttempts.length
  return shared.result + own
})
const explanation = await runtime.explain(Main, { answer: 1 })
const revisions = runtime.catalog.revisions(Doubler.family)
let missing = 'none'
try { await runtime.enter(Main, {} as { answer: number }) }
catch (error) { if (isSynaError(error, 'MISSING_INPUT')) missing = error.details.missing.join(',') }
console.log(JSON.stringify({ result, revision: Doubler.version, explainOk: explanation.ok, missing, abandoned, revisions: revisions.join(','), slots: slots.join(',') }))
await runtime.dispose()
`)
  await run('consumer-install', 'npm', ['install', '--no-fund', '--no-audit'], { cwd: consumerDir })
  await run('consumer-build', 'npm', ['run', 'build'], { cwd: consumerDir })
  const smoke = await run('consumer-run', 'npm', ['run', '-s', 'start'], { cwd: consumerDir })
  const smokeOutput = readFileSync(path.join(root, smoke.log), 'utf8').trim().split('\n').at(-1)
  let smokeJson
  try { smokeJson = JSON.parse(smokeOutput) } catch { smokeJson = null }
  const smokeOk = smokeJson?.result === 84 && smokeJson?.revision === '7.3.1' && smokeJson?.explainOk === true && smokeJson?.missing === 'smoke.consumer/input/answer/v1' && smokeJson?.abandoned === 0
    && smokeJson?.revisions === '7.3.1' && typeof smokeJson?.slots === 'string' && smokeJson.slots.split(',').includes('ready')
  steps.push({ name: 'consumer-smoke-result', ok: smokeOk, exitCode: smokeOk ? 0 : 1, mustRun: true, command: 'internal', log: smoke.log, output: smokeJson })
  log(`${smokeOk ? 'ok  ' : 'FAIL'} consumer-smoke-result ${smokeOutput}`)
  await readmeConsumer(path.join(rebuildDir, 'readme-consumer'), runtimePack)
  rmSync(rebuildDir, { recursive: true, force: true })
  return { archives, packed, sourceFingerprint, rebuiltFrom: path.relative(root, tarPath) }
}

// Provenance is captured before any step runs, so files this run writes cannot make the checkout look dirty.
const gitProvenance = gitInfo()
const sourceFiles = listSourceFiles()
const sourceFingerprint = fingerprint(sourceFiles)
log(`Syna v${version} verify (${release ? 'release' : 'dev'}) — ${sourceFingerprint.files} source files, fingerprint ${sourceFingerprint.digest}`)
await developmentGate()
let releaseResult
if (release && !insideArchive) releaseResult = await releaseGate(sourceFingerprint)

// The last step of either run: the steps recorded are the steps the profile says this release runs.
// A gate that quietly stops running a check is a defect of the gate, and only the list can see it.
{
  const expected = insideArchive
    ? profile.steps.dev
    : release ? [...profile.steps.dev.filter(name => name !== 'release-profile'), ...profile.steps.release] : profile.steps.dev
  const ran = [...steps.map(step => step.name), 'release-profile']
  const missing = expected.filter(name => !ran.includes(name))
  const extra = ran.filter(name => !expected.includes(name))
  const inOrder = ran.length === expected.length && ran.every((name, index) => name === expected[index])
  const ok = missing.length === 0 && extra.length === 0 && inOrder
  const note = `${ran.length} step(s) ran, ${expected.length} in ${path.relative(root, profilePath)}`
    + `${missing.length > 0 ? `; ${missing.length} missing` : ''}${extra.length > 0 ? `; ${extra.length} not in the profile` : ''}`
    + `${ok ? '' : inOrder ? '' : '; the order differs'}`
  steps.push({ name: 'release-profile', ok, exitCode: ok ? 0 : 1, mustRun: true, command: 'internal', log: path.relative(root, profilePath), note, ...(missing.length > 0 ? { missing } : {}), ...(extra.length > 0 ? { extra } : {}) })
  log(`${ok ? 'ok  ' : 'FAIL'} release-profile (${note})`)
}

// A manifest that recorded no test counts is not evidence of anything: BLOCKED, never COMPLETE.
if (!steps.some(step => step.tests)) blocked.push({ step: 'manifest', reason: 'no step recorded test counts; the run was not recorded' })
const mustRun = steps.filter(step => step.mustRun !== false)
const failed = mustRun.filter(step => !step.ok)
const skipped = mustRun.reduce((sum, step) => sum + (step.tests?.skipped ?? 0), 0)
// The `rebuild-*` steps run the same suites a second time inside the unpacked archive: their
// tests are executions of cases already counted, not additional cases.
const isRebuild = step => step.name.startsWith('rebuild-')
const sumTests = (predicate, key) => steps.filter(predicate).reduce((sum, step) => sum + (step.tests?.[key] ?? 0), 0)
const status = blocked.length > 0 ? 'BLOCKED' : failed.length === 0 && skipped === 0 ? 'COMPLETE' : 'PARTIAL'
const manifest = {
  name: `Syna v${version} + multitenant-blog`,
  version,
  /** The published identities this workspace version releases, and where this run's evidence lives (the profile). */
  packages: PACKAGES,
  validation: validationRel,
  gate: 'scripts/verify-release.mjs',
  status,
  mode: release ? 'release' : 'dev',
  generatedAt: new Date().toISOString(),
  startedAt: startedAt.toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch, cwd: '.', gitProvenance, postgres: postgresInfo },
  source: sourceFingerprint,
  steps,
  totals: {
    steps: steps.length,
    failed: failed.length,
    skippedTests: skipped,
    /** Test executions across all steps (a case run twice counts twice). */
    tests: sumTests(() => true, 'tests'),
    passed: sumTests(() => true, 'pass'),
    /** Distinct test cases: executions outside the `rebuild-*` steps. */
    distinctTests: sumTests(step => !isRebuild(step), 'tests'),
    /** Executions inside the `rebuild-*` steps (the same cases run a second time on the rebuilt copy). */
    rebuildTests: sumTests(isRebuild, 'tests'),
  },
  blocked,
  previousRun: compareWithPrevious(previousManifest),
  ...(releaseResult ? { release: releaseResult } : {}),
}
writeFileSync(path.join(validationDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
if (release && releaseResult) {
  writeFileSync(path.join(root, 'RELEASE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  // Release hashes live next to the release manifest. The hash list of the 0.5 task
  // package is that package's own (work/v05/task-package/SHA256SUMS.txt) and is never rewritten.
  const sums = [...releaseResult.archives, ...releaseResult.packed].map(item => `${item.sha256}  ${item.path}`).join('\n')
  writeFileSync(path.join(validationDir, 'SHA256SUMS.txt'), `${sums}\n`)
}
log('')
log(`== ${status} == ${manifest.totals.tests} test executions (${manifest.totals.distinctTests} distinct cases, ${manifest.totals.rebuildTests} re-run in the rebuilt copy), ${manifest.totals.passed} passed, ${failed.length} failed steps, ${skipped} skipped tests`)
log(`source fingerprint: ${sourceFingerprint.digest} (${sourceFingerprint.files} files)`)
if (manifest.previousRun) log(`previous run ${manifest.previousRun.generatedAt} (commit ${manifest.previousRun.commit?.slice(0, 7) ?? 'unknown'}, ${manifest.previousRun.status}): same step list ${manifest.previousRun.sameStepList}, same test counts ${manifest.previousRun.sameTestCounts}${manifest.previousRun.differences.length > 0 ? `; ${manifest.previousRun.differences.join('; ')}` : ''}`)
for (const step of steps) log(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.name.padEnd(40)} exit=${step.exitCode}${step.tests ? ` pass=${step.tests.pass} fail=${step.tests.fail} skip=${step.tests.skipped}` : ''}${step.mustRun === false ? ' (not a test)' : ''} log=${step.log}`)
if (releaseResult) {
  for (const item of [...releaseResult.archives, ...releaseResult.packed]) log(`  archive ${item.path} ${item.bytes} bytes sha256 ${item.sha256}`)
}
log(`manifest: ${path.relative(root, path.join(validationDir, 'manifest.json'))}`)
process.exit(status === 'COMPLETE' ? 0 : status === 'BLOCKED' ? 3 : 2)
