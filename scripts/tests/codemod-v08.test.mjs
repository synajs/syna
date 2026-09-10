// syna-v08-rename: this test spells pre-0.8 names on purpose — they are the fixture the codemod must rewrite.
// The rename codemod (scripts/codemod-v08.mjs) on a fixture consumer inside this workspace (so `syna` resolves to
// the built 0.8 declarations, as it does for a consumer that upgraded before running it): every rule of the table
// rewrites its occurrence, a second run makes no edit (idempotent), and a site the codemod cannot rewrite is reported
// with exit code 2 and left alone.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
const codemod = path.join(root, 'scripts/codemod-v08.mjs')
const run = args => spawnSync(process.execPath, [codemod, ...args], { cwd: root, encoding: 'utf8' })

const BEFORE = `import { createRuntime, definePackage, isSynaError, type EnvHandle, type EntryDescriptor, type ImplementationDescriptor, type NodeDisposition, type InputType } from 'syna'

const define = definePackage({ name: '@fixture/consumer', version: '1.0.0', syna: { id: 'fixture' } })
const Flag = define.input<boolean>('flag')
type FlagValue = InputType<typeof Flag>
const Cap = define.contract<{ run(): void }>('cap')
const Choice = define.binding('choice', Cap)
const Db = define.service('db', {
  provides: [Cap],
  metadata: { displayName: 'Db' },
  setupDeadlineMs: 5_000,
  setup: () => ({ run() {} }),
})
const Host = define.service('host', { requires: { all: Cap.all }, setup: ({ all }) => ({ all }) })
const Main: EntryDescriptor = define.entry('main', { requires: { db: Db, host: Host }, parameters: { flag: Flag, choice: Choice } })
const runtime = createRuntime({
  services: [Db, Host],
  limits: { setupDeadlineMs: 1_000 },
  policy: {
    orderAutoCandidates: (_contract, candidates, context) => [...candidates].sort(left => (context.parentActiveRevisionKeys.has(left.key) ? -1 : 1)),
    orderVersionCandidates: (_family, candidates) => candidates,
  },
  diagnostics: {
    onEvent(event) {
      if (event.type === 'late-setup-result' || event.type === 'late-setup-failure' || event.type === 'attempts-outstanding' || event.type === 'foreign-thenable-setup') return
      if (event.type === 'attempt-overdue') console.log(event.attempt)
    },
  },
})
const env: EnvHandle = await runtime.enter(Main, { flag: true as FlagValue, choice: Choice.to(Db) })
const child = await env.derive({ fresh: [Db] })
const explanation = await runtime.explain(Main, { flag: true, choice: Choice.to(Db) })
if (explanation.ok) {
  const placement: NodeDisposition = explanation.nodes[0].disposition
  console.log(placement, explanation.nodes[0].disposition === 'inherited', explanation.services.inherited, explanation.services.eagerInherited, explanation.parameters.bindingsResolved)
}
const record: ImplementationDescriptor = runtime.catalog.resolve(Choice.to(Db))
console.log(record.persistentRef.version, Db.key, Db.metadata, runtime.catalog.revisions(Db.family.id), runtime.inspect().internalServices, runtime.inspect().planCache.maxEntries)
for (const item of runtime.inspect().unsettledAttempts) console.log(item.attempt, item.runningForMs, item.state === 'timed-out')
const set = await (await env.deps.host.load()).all.load()
for (const candidate of set.candidates) console.log(candidate.ref.familyId)
try { await env.deps.db.load() }
catch (error) {
  if (isSynaError(error, 'INITIALIZATION_TIMEOUT')) console.log(error.details.attempt)
  if (isSynaError(error, 'LINEAGE_UNIQUENESS_CONFLICT') && 'anchorSlot' in error.details) console.log(error.details.anchorSlot, error.details.anchorRevision)
  if (isSynaError(error, 'INVALID_INHERITED_CHOICE')) console.log(error.details.selectedKey)
}
for (const node of env.inspect().nodes) if (node.kind === 'all') console.log(node.state)
const stored = JSON.parse('{}') as { kind: 'persistent-implementation-ref'; contractId: string; familyId: string; version: string }
console.log(stored.version, stored.kind === 'persistent-implementation-ref', child.state)
await runtime.dispose()
`

const AFTER = `import { createRuntime, definePackage, isSynaError, type Env, type Entry, type ImplementationRecord, type NodePlacement, type InputValue } from 'syna'

const define = definePackage({ name: '@fixture/consumer', version: '1.0.0', syna: { id: 'fixture' } })
const Flag = define.input<boolean>('flag')
type FlagValue = InputValue<typeof Flag>
const Cap = define.contract<{ run(): void }>('cap')
const Choice = define.binding('choice', Cap)
const Db = define.service('db', {
  provides: [Cap],
  familyMetadata: { displayName: 'Db' },
  loadTimeoutMs: 5_000,
  setup: () => ({ run() {} }),
})
const Host = define.service('host', { requires: { all: Cap.all }, setup: ({ all }) => ({ all }) })
const Main: Entry = define.entry('main', { requires: { db: Db, host: Host }, parameters: { flag: Flag, choice: Choice } })
const runtime = createRuntime({
  services: [Db, Host],
  limits: { loadTimeoutMs: 1_000 },
  policy: {
    orderAutoCandidates: (_contract, candidates, context) => [...candidates].sort(left => (context.parentActiveRevisionIds.has(left.id) ? -1 : 1)),
    orderVersionCandidates: (_family, candidates) => candidates,
  },
  diagnostics: {
    onEvent(event) {
      if (event.type === 'attempt-succeeded-late' || event.type === 'attempt-failed-late' || event.type === 'runtime-attempts-outstanding' || event.type === 'setup-returned-thenable') return
      if (event.type === 'attempt-overdue') console.log(event.attemptNumber)
    },
  },
})
const env: Env = await runtime.enter(Main, { flag: true as FlagValue, choice: Choice.to(Db) })
const child = await env.derive({ reuse: { fresh: [Db] } })
const explanation = await runtime.explain(Main, { flag: true, choice: Choice.to(Db) })
if (explanation.ok) {
  const placement: NodePlacement = explanation.nodes[0].placement
  console.log(placement, explanation.nodes[0].placement === 'reused', explanation.services.reused, explanation.services.eagerReused, explanation.parameters.bindingsAssigned)
}
const record: ImplementationRecord = runtime.catalog.resolve(Choice.to(Db))
console.log(record.implementationRef.range, Db.id, Db.revisionMetadata, runtime.catalog.revisions(Db.family), runtime.inspect().privateServices, runtime.inspect().planCache.limit)
for (const item of runtime.inspect().unsettledAttempts) console.log(item.attemptNumber, item.elapsedMs, item.state === 'overdue')
const set = await (await env.deps.host.load()).all.load()
for (const candidate of set.candidates) console.log(candidate.candidateRef.familyId)
try { await env.deps.db.load() }
catch (error) {
  if (isSynaError(error, 'LOAD_TIMEOUT')) console.log(error.details.attemptNumber)
  if (isSynaError(error, 'LINEAGE_UNIQUENESS_CONFLICT') && 'pinnedSlot' in error.details) console.log(error.details.pinnedSlot, error.details.pinnedRevision)
  if (isSynaError(error, 'INVALID_INHERITED_CHOICE')) console.log(error.details.selectedRevision)
}
for (const node of env.inspect().nodes) if (node.kind === 'all-implementations') console.log(node.state)
const stored = JSON.parse('{}') as { kind: 'implementation-ref'; contractId: string; familyId: string; range: string }
console.log(stored.range, stored.kind === 'implementation-ref', child.state)
await runtime.dispose()
`

// A stored-document reader in the 0.5 key form: the codemod cannot rewrite it (F9 needs the document rewritten, not the code).
const MANUAL = `export const familyOf = (ref: { implementationId?: string; familyId?: string }) => ref.familyId ?? ref.implementationId
`

test('the codemod rewrites every rule of the table on a fixture consumer, and a second run makes no edit', () => {
  const dir = mkdtempSync(path.join(root, 'work', 'codemod-fixture-'))
  try {
    const file = path.join(dir, 'consumer.ts')
    const report = path.join(dir, 'report.json')
    writeFileSync(file, BEFORE)
    const first = run([file, '--json', report])
    assert.equal(first.status, 0, `first run failed:\n${first.stdout}\n${first.stderr}`)
    assert.equal(readFileSync(file, 'utf8'), AFTER)
    const summary = JSON.parse(readFileSync(report, 'utf8'))
    assert.equal(summary.manual, 0)
    assert.equal(summary.filesChanged, 1)
    assert.ok(summary.edits >= 45, `edits: ${summary.edits}`)
    for (const rule of ['T1', 'T2', 'T3', 'T4', 'T5', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F16', 'F18', 'F19', 'D1', 'D3', 'D4', 'D5', 'D7', 'D8', 'S1', 'S2']) {
      assert.ok(summary.rules[rule] > 0, `rule ${rule} made no edit`)
    }
    const second = run([file, '--json', report])
    assert.equal(second.status, 0, second.stdout)
    assert.match(second.stdout, /^codemod-v08: 0 edits in 0 files; 0 manual$/m)
    assert.equal(readFileSync(file, 'utf8'), AFTER, 'idempotent')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a site the codemod cannot rewrite is reported with exit code 2, named with its reason, and left as it is; --dry-run writes nothing', () => {
  const dir = mkdtempSync(path.join(root, 'work', 'codemod-fixture-'))
  try {
    const file = path.join(dir, 'stored.ts')
    writeFileSync(file, MANUAL)
    const result = run([file])
    assert.equal(result.status, 2)
    assert.match(result.stdout, /stored\.ts:1 needs a hand \(F9\): the 0\.5 key is not read any more/)
    assert.match(result.stdout, /^codemod-v08: 0 edits in 0 files; 1 manual$/m)
    assert.equal(readFileSync(file, 'utf8'), MANUAL, 'a hand site is not touched')
    const consumer = path.join(dir, 'consumer.ts')
    writeFileSync(consumer, BEFORE)
    const dry = run(['--dry-run', consumer])
    assert.equal(dry.status, 0, dry.stdout)
    assert.match(dry.stdout, /^codemod-v08 \(dry run\): \d+ edits in 1 files; 0 manual/m)
    assert.equal(readFileSync(consumer, 'utf8'), BEFORE, 'a dry run writes nothing')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
