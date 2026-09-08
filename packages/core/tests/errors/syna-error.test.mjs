// T1 (v0.6): `SynaError` is a union discriminated by `code`. The runtime object is unchanged (name, instanceof,
// frozen `details`, `cause`); what changed is the type: every code has a documented `details` shape. This test
// pins the shapes the Runtime actually produces against the per-code table in `docs/API_REFERENCE.md` and the
// `SynaErrorDetails` map in `dist/errors.d.ts`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createRuntime, definePackage, isSynaError, SynaError } from '../../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v06/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })
const root = new URL('../../../../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

const CODES = [
  'AMBIGUOUS_IMPLEMENTATION', 'DUPLICATE_DEFINITION', 'ENTRY_ACTIVATION_FAILED', 'ENV_CLOSED', 'FOREIGN_CANDIDATE_REF',
  'INACTIVE_REUSE_TARGET', 'INCOMPATIBLE_IMPLEMENTATION', 'INVALID_DESCRIPTOR', 'INVALID_INHERITED_CHOICE',
  'LIFECYCLE_MISUSE', 'LINEAGE_UNIQUENESS_CONFLICT', 'LOAD_CANCELLED', 'LOAD_TIMEOUT', 'MISSING_AUTO_POLICY', 'MISSING_BINDING',
  'MISSING_IMPLEMENTATION', 'MISSING_INPUT', 'MISSING_SERVICE', 'OWNER_NOT_READY', 'PLANNING_BUDGET_EXCEEDED',
  'ROLLBACK_FAILED', 'RUNTIME_CLOSED', 'RUNTIME_MISMATCH', 'SHARE_CONSTRAINT_FAILED', 'SLOT_NOT_LOADABLE', 'UNSATISFIABLE_TOPOLOGY',
]

const detailKeys = error => Object.keys(error.details).sort()

test('T1 the runtime object is unchanged: name, instanceof, frozen details, cause, isSynaError(error, code)', () => {
  const error = new SynaError('LOAD_CANCELLED', 'cancelled', { slot: 'slot-1', revision: 'a@1.0.0' }, { cause: new Error('inner') })
  assert.equal(error.name, 'SynaError')
  assert.ok(error instanceof SynaError)
  assert.ok(error instanceof Error)
  assert.equal(error.code, 'LOAD_CANCELLED')
  assert.equal(error.message, 'cancelled')
  assert.equal(error.cause.message, 'inner')
  assert.ok(Object.isFrozen(error.details))
  assert.deepEqual(error.details, { slot: 'slot-1', revision: 'a@1.0.0' })
  assert.equal(isSynaError(error), true)
  assert.equal(isSynaError(error, 'LOAD_CANCELLED'), true)
  assert.equal(isSynaError(error, 'MISSING_INPUT'), false)
  assert.equal(isSynaError(new Error('plain')), false)
  assert.equal(isSynaError({ name: 'SynaError', code: 'LOAD_CANCELLED' }), false)
  const bare = new SynaError('RUNTIME_MISMATCH', 'no details')
  assert.deepEqual(bare.details, {})
  assert.ok(Object.isFrozen(bare.details))
  assert.equal(typeof SynaError, 'function')
})

test('T1 the details the Runtime produces have the documented keys', async () => {
  const define = makeDefine('t1')
  const Flag = define.input('flag')
  const Db = define.service('db', { setup: () => ({}) })
  const Reader = define.service('reader', { requires: { db: Db, flag: Flag }, setup: () => ({}) })
  const Root = define.entry('root', { requires: { db: Db } })
  const Child = define.entry('child', { requires: { reader: Reader }, parameters: { flag: Flag } })
  const Other = makeDefine('t1-other').service({ setup: () => ({}) })
  const Internal = define.service('internal', { setup: () => ({}) })
  const App = define.service('app', { requires: { internal: Internal }, setup: () => ({}) })
  const PrivateEntry = define.entry('private', { requires: { internal: Internal } })
  const runtime = createRuntime({ services: [Db, Reader, App] })
  const seen = {}
  const capture = async (call) => {
    try { await call() }
    catch (error) {
      assert.ok(isSynaError(error), `expected a SynaError, got ${error?.stack}`)
      seen[error.code] ??= []
      seen[error.code].push(detailKeys(error))
      return error
    }
    assert.fail('expected a rejection')
  }

  const rootEnv = await runtime.enter(Root)
  // MISSING_INPUT (Entry call omits a declared parameter).
  const missing = await capture(() => rootEnv.enter(Child, {}))
  assert.deepEqual(detailKeys(missing), ['entry', 'missing', 'missingBindings', 'missingInputs'])
  // INACTIVE_REUSE_TARGET (inactive fresh target; S6 in 0.7) — twice: revision and family form.
  const inactiveRevision = await capture(() => rootEnv.enter(Child, { flag: 1 }, { reuse: { fresh: [Other] } }))
  assert.deepEqual(detailKeys(inactiveRevision), ['constraint', 'env', 'revision'])
  const inactiveFamily = await capture(() => rootEnv.enter(Child, { flag: 1 }, { reuse: { fresh: [Other.family] } }))
  assert.deepEqual(detailKeys(inactiveFamily), ['constraint', 'env', 'family'])
  // INVALID_DESCRIPTOR (bad reuse target; one shape at every site since 0.7, S7).
  const invalid = await capture(() => rootEnv.enter(Child, { flag: 1 }, { reuse: { fresh: ['nope'] } }))
  assert.equal(invalid.code, 'INVALID_DESCRIPTOR')
  assert.deepEqual(invalid.details, { descriptor: 'ReuseTarget', problem: 'not-an-object' })
  // ENV_CLOSED (enter from a disposed Env; S7 in 0.7).
  const child = await rootEnv.enter(Child, { flag: 1 })
  await child.dispose()
  const closed = await capture(() => child.enter(Child, { flag: 1 }))
  assert.equal(closed.code, 'ENV_CLOSED')
  assert.deepEqual(closed.details, { env: child.id, state: 'disposed' })
  // MISSING_SERVICE: a private revision from a public root (realm form) and a revision unknown to the Runtime.
  const missingService = await capture(() => rootEnv.enter(PrivateEntry))
  assert.equal(missingService.code, 'MISSING_SERVICE')
  assert.deepEqual(detailKeys(missingService), ['realm', 'revision', 'site'])
  const Unknown = define.service('unknown', { setup: () => ({}) })
  const unknownService = await capture(() => rootEnv.enter(define.entry('unknown', { requires: { unknown: Unknown } })))
  assert.equal(unknownService.code, 'MISSING_SERVICE')
  assert.deepEqual(detailKeys(unknownService), ['revision'])
  await runtime.dispose()

  // DUPLICATE_DEFINITION (same revision key, different structure).
  const duplicate = await capture(async () => {
    const other = makeDefine('t1')
    const Db2 = other.service('db', { requires: { flag: other.input('flag') }, setup: () => ({}) })
    createRuntime({ services: [Db, Db2] })
  })
  assert.equal(duplicate.code, 'DUPLICATE_DEFINITION')
  assert.ok(['actual,expected,revision', 'existing,received', 'revision'].includes(detailKeys(duplicate).join(',')), detailKeys(duplicate).join(','))

  // Every observed shape is one the reference table lists for that code.
  const reference = read('docs/API_REFERENCE.md')
  for (const [code, shapes] of Object.entries(seen)) {
    const row = reference.split('\n').find(line => line.startsWith(`| \`${code}\` |`))
    assert.ok(row, `API_REFERENCE has no row for ${code}`)
    for (const keys of shapes) {
      for (const key of keys) assert.ok(row.includes(key), `${code}: key ${key} is not in the documented details (${row})`)
    }
  }
})

test('T1 the declaration and the reference table cover every code exactly once', () => {
  const dts = read('packages/core/dist/errors.d.ts')
  assert.match(dts, /export type SynaError<Code extends SynaErrorCode = SynaErrorCode> = /)
  assert.match(dts, /export interface SynaErrorOf<Code extends SynaErrorCode> extends Error/)
  assert.match(dts, /export declare const SynaError: SynaErrorConstructor/)
  assert.match(dts, /export declare function isSynaError<Code extends SynaErrorCode = SynaErrorCode>\(error: unknown, code\?: Code\): error is SynaError<Code>/)
  const unionLine = dts.split('\n').find(line => line.startsWith('export type SynaErrorCode = '))
  const union = [...unionLine.matchAll(/'([A-Z_]+)'/g)].map(match => match[1])
  assert.deepEqual(union, CODES, 'SynaErrorCode union')
  const detailsBlock = dts.slice(dts.indexOf('export type SynaErrorDetails = {'), dts.indexOf('export interface SynaErrorOf'))
  const detailEntries = [...detailsBlock.matchAll(/^    readonly ([A-Z_]+):/gm)].map(match => match[1])
  assert.deepEqual(detailEntries, CODES, 'SynaErrorDetails has one entry per code, in code order')

  const reference = read('docs/API_REFERENCE.md')
  const rows = reference.split('\n').filter(line => /^\| `[A-Z_]+` \| /.test(line)).map(line => line.slice(3, line.indexOf('`', 3)))
  assert.deepEqual(rows, CODES, 'API_REFERENCE error table has one row per code, in code order')
  const index = read('packages/core/dist/index.d.ts')
  assert.match(index, /SynaErrorDetails/)
})
