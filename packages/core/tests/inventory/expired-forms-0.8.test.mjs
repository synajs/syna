// syna-v08-rename: this test spells 0.7 names on purpose — it asserts that each expired form is refused, never ignored.
// codemod-v08: off
// 0.8 (the last rename before 1.0; docs/MIGRATION_V07_TO_V08.md): a 0.7 form that the Runtime could otherwise read
// silently as "nothing" — a renamed definition option, the renamed limit, the old `derive(constraints)` argument, the
// old `revisions(familyId)` argument — is refused with an error naming the current form, exactly as 0.7 refused the
// forms it removed. Every current form works, and the values it sets are observable.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage, isSynaError } from '../../dist/index.js'

const define = definePackage({ name: '@v08/expired-forms', version: '1.0.0', syna: { id: 'v08-expired' } })
const setup = () => ({ ok: true })
const thrown = fn => { try { fn() } catch (error) { return error } throw new Error('expected a throw') }
const rejection = promise => promise.then(() => { throw new Error('expected a rejection') }, error => error)

test('F16 / F4: a Service definition in the 0.7 spelling is refused, never read as "no option"', () => {
  assert.throws(() => define.service('slow', { setupDeadlineMs: 5_000, setup }), { name: 'TypeError', message: 'Service v08-expired/slow uses the option setupDeadlineMs, renamed in 0.8.0; use loadTimeoutMs.' })
  assert.throws(() => define.service('labelled', { metadata: { displayName: 'x' }, setup }), { name: 'TypeError', message: 'Service v08-expired/labelled uses the option metadata, renamed in 0.8.0; use familyMetadata.' })
  assert.throws(() => define.service('unique', { uniqueWithin: 'none', setup }), { name: 'TypeError', message: 'uniqueWithin must be "lineage" when provided.' })
  const Slow = define.service('slow', { loadTimeoutMs: 5_000, familyMetadata: { displayName: 'Slow' }, revisionMetadata: { displayName: 'Slow 1.0.0' }, setup })
  assert.equal(Slow.loadTimeoutMs, 5_000)
  assert.equal(Slow.family.metadata.displayName, 'Slow')
  assert.equal(Slow.revisionMetadata.displayName, 'Slow 1.0.0')
  assert.equal('setupDeadlineMs' in Slow, false)
  assert.equal('metadata' in Slow, false)
  assert.equal('uniqueWithin' in define.service('plain', { setup }).family, false)
})

test('F16: `limits.setupDeadlineMs` is refused, never silently the default', () => {
  assert.throws(() => createRuntime({ services: [], limits: { setupDeadlineMs: 1_000 } }), { name: 'TypeError', message: 'limits.setupDeadlineMs was renamed in 0.8.0; use limits.loadTimeoutMs.' })
  const runtime = createRuntime({ services: [], limits: { loadTimeoutMs: 1_000 } })
  assert.ok(runtime)
})

test('S1: `derive(constraints)` is refused, never read as "no constraint"; `derive({ reuse })` constrains', async () => {
  const Db = define.service('db', { setup })
  const Main = define.entry('main', { requires: { db: Db } })
  const runtime = createRuntime({ services: [Db] })
  try {
    const env = await runtime.enter(Main)
    for (const options of [{ fresh: [Db] }, { share: [Db] }, { fresh: [Db], reuse: { fresh: [Db] } }]) {
      const error = await rejection(env.derive(options))
      assert.equal(error.name, 'TypeError')
      assert.equal(error.message, 'fresh and share are reuse constraints, not call options: pass them as { reuse: { fresh, share } }.')
    }
    assert.equal((await rejection(runtime.enter(Main, {}, { fresh: [Db] }))).name, 'TypeError', 'the same options record on every Entry call')
    const child = await env.derive({ reuse: { fresh: [Db] } })
    const explanation = await env.explain(Main, {}, { reuse: { fresh: [Db] } })
    assert.equal(explanation.ok, true)
    assert.equal(explanation.services.forked + explanation.services.new, 1, 'the constraint is applied')
    await child.dispose()
    assert.equal(runtime.inspect().liveEnvCount, 1)
  }
  finally { await runtime.dispose() }
})

test('S2: `catalog.revisions(familyId)` is refused with INVALID_DESCRIPTOR, never an empty list; `revisions(family)` lists', () => {
  const Db = define.service('db', { setup })
  const runtime = createRuntime({ services: [Db] })
  const byId = thrown(() => runtime.catalog.revisions(Db.family.id))
  assert.ok(isSynaError(byId, 'INVALID_DESCRIPTOR'))
  assert.deepEqual(byId.details, { descriptor: 'ServiceFamily', problem: 'not-an-object' })
  assert.equal(byId.message, 'catalog.revisions() expects a ServiceFamily descriptor (revision.family), not a family id.')
  const byRevision = thrown(() => runtime.catalog.revisions(Db))
  assert.ok(isSynaError(byRevision, 'INVALID_DESCRIPTOR'))
  assert.deepEqual(byRevision.details, { descriptor: 'ServiceFamily', problem: 'wrong-kind' })
  assert.deepEqual(runtime.catalog.revisions(Db.family), ['1.0.0'])
  assert.deepEqual(runtime.catalog.revisions(define.service('other', { setup }).family), [], 'an unknown family is an empty list, not an error')
})
// codemod-v08: on
