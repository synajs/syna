// v0.7 (Phase C, S6): the 0.6 code split here had four throw sites and only one kind of them was about
// `fresh`. Each site now carries its own code — INACTIVE_REUSE_TARGET, INVALID_INHERITED_CHOICE,
// FOREIGN_CANDIDATE_REF — with the trigger condition and the message unchanged; the old code has no throw site and
// is not a member of SynaErrorCode. Every site is exercised here and every details key is asserted.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntime, definePackage, forward, isSynaError } from '../../dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '../../dist')
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v07/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })

const rejection = async promise => {
  try { await promise }
  catch (error) { return error }
  assert.fail('expected a rejection')
}

const world = () => {
  const define = makeDefine('s6')
  const Db = define.service('db', { setup: () => ({}) })
  const Cache = define.service('cache', { requires: { db: Db }, setup: () => ({}) })
  const App = define.service('app', { requires: { db: Db, cache: Cache }, setup: () => ({}) })
  const Other = makeDefine('s6-other').service({ setup: () => ({}) })
  const Root = define.entry('root', { requires: { app: App } })
  const Child = define.entry('child', { requires: { app: App } })
  return { define, Db, Cache, App, Other, Root, Child }
}

test('INACTIVE_REUSE_TARGET: a fresh or share target that is not active in the parent world — revision and family form, from check(), enter(), run(), derive() and a definition-time constraint', async () => {
  const { define, Db, Cache, App, Other, Root, Child } = world()
  const runtime = createRuntime({ services: [Db, Cache, App, Other] })
  const root = await runtime.enter(Root)
  const cases = [
    { constraint: 'fresh', reuse: { fresh: [Other] }, message: `fresh targets inactive Service Revision ${Other.id}.`, target: { revision: Other.id } },
    { constraint: 'share', reuse: { share: [Other] }, message: `share targets inactive Service Revision ${Other.id}.`, target: { revision: Other.id } },
    { constraint: 'fresh', reuse: { fresh: [Other.family] }, message: `fresh targets inactive Service Family ${Other.family.id}.`, target: { family: Other.family.id } },
    { constraint: 'share', reuse: { share: [Other.family] }, message: `share targets inactive Service Family ${Other.family.id}.`, target: { family: Other.family.id } },
    // An active target next to the inactive one changes nothing: the inactive one is reported.
    { constraint: 'fresh', reuse: { fresh: [Cache, Other] }, message: `fresh targets inactive Service Revision ${Other.id}.`, target: { revision: Other.id } },
  ]
  for (const [index, { constraint, reuse, message, target }] of cases.entries()) {
    const expectDetails = (error, envPrefix) => {
      assert.equal(error.code, 'INACTIVE_REUSE_TARGET')
      assert.equal(error.message, message)
      assert.deepEqual(Object.keys(error.details).sort(), ['constraint', 'env', ...Object.keys(target)].sort())
      assert.equal(error.details.constraint, constraint)
      assert.match(error.details.env, envPrefix)
      for (const [key, value] of Object.entries(target)) assert.equal(error.details[key], value)
    }
    // check(): reported, not thrown (the code stays in the backtrackable set, as the 0.6 code was).
    const checked = await root.check(Child, undefined, { reuse })
    assert.equal(checked.ok, false)
    expectDetails(checked.error, /^check-\d+$/)
    // enter() / run(): thrown before activation, as the SynaError itself.
    const entered = await rejection(root.enter(Child, undefined, { reuse }))
    assert.ok(isSynaError(entered))
    expectDetails(entered, /^env-\d+$/)
    const ran = await rejection(root.run(Child, undefined, { reuse }, () => assert.fail('the callback never runs')))
    expectDetails(ran, /^env-\d+$/)
    // derive(): the same validation.
    const derived = await rejection(root.derive({ reuse }))
    expectDetails(derived, /^env-\d+$/)
    // The definition-time constraint of an Entry is validated the same way.
    const Constrained = define.entry(`constrained-${index}`, { requires: { app: App }, reuse })
    expectDetails((await root.check(Constrained)).error, /^check-\d+$/)
    expectDetails(await rejection(root.enter(Constrained)), /^env-\d+$/)
  }
  // The same targets are fine where they are active: the reference behaviour is unchanged.
  const fine = await root.enter(Child, undefined, { reuse: { fresh: [Cache], share: [Db.family] } })
  assert.equal(fine.state, 'ready')
  await fine.dispose()
  await root.dispose()
  await runtime.dispose()
})

test('INVALID_INHERITED_CHOICE: the resolution a site inherited from the parent lineage is no longer among the site\'s candidates', async () => {
  const define = makeDefine('s6-inherited')
  const F1 = makeDefine('s6-f', '1.0.0').service({ setup: () => ({ v: 1 }) })
  const F2 = makeDefine('s6-f', '2.0.0').service({ setup: () => ({ v: 2 }) })
  // A forward dependency is read at every plan; here its target moves between the parent's plan and the child's.
  let range = '^1'
  const Leaf = define.service('leaf', { requires: { f: forward(() => F1.range(range)) }, setup: () => ({}) })
  const Root = define.entry('root', { requires: { leaf: Leaf } })
  const Same = define.entry('same', { requires: { leaf: Leaf } })
  const Child = define.entry('child', { requires: { leaf: Leaf } })
  const runtime = createRuntime({ services: [F1, F2, Leaf] })
  const root = await runtime.enter(Root)
  const site = `service:${Leaf.id}/dependency:f`
  assert.equal(root.inspect().nodes.find(node => node.nodeId === `service:${F1.id}`)?.ownerEnvId, root.id, 'the parent chose 1.0.0 at the site')
  // Unchanged target: a child inherits the choice and plans (its template is now cached; a cached template is not
  // re-solved, so the moved target below is observed by an Entry that has not been planned in this lineage yet).
  const same = await root.check(Same)
  assert.equal(same.ok, true)
  range = '^2'
  const checked = await root.check(Child)
  assert.equal(checked.ok, false)
  const expectDetails = error => {
    assert.equal(error.code, 'INVALID_INHERITED_CHOICE')
    assert.equal(error.message, `The inherited resolution ${F1.id} is no longer valid at ${site}.`)
    assert.deepEqual(error.details, { site, selectedRevision: F1.id, candidates: [F2.id] })
  }
  expectDetails(checked.error)
  const entered = await rejection(root.enter(Child))
  assert.ok(isSynaError(entered))
  expectDetails(entered)
  // A fresh root lineage inherits nothing and plans with the moved target.
  const fresh = await runtime.enter(Child)
  assert.equal(fresh.inspect().nodes.find(node => node.nodeId === `service:${F2.id}`)?.ownerEnvId, fresh.id)
  await fresh.dispose()
  await root.dispose()
  await runtime.dispose()
})

test('FOREIGN_CANDIDATE_REF: a CandidateRef of another implementation collection, on set.load(ref) and set.load(candidate); set.resolve() takes implementation refs only', async () => {
  const define = makeDefine('s6-foreign')
  const Capability = define.contract('capability')
  const A = makeDefine('s6-a').service({ provides: [Capability], setup: () => ({ id: 'a' }) })
  const B = makeDefine('s6-b').service({ provides: [Capability], setup: () => ({ id: 'b' }) })
  const Host = define.service('host', { requires: { all: Capability.all }, setup: ({ all }) => ({ all }) })
  const Entry = define.entry('entry', { requires: { host: Host } })
  const runtime = createRuntime({ services: [A, B, Host] })
  const first = await runtime.enter(Entry)
  const second = await runtime.enter(Entry)
  const firstSet = await (await first.deps.host.load()).all.load()
  const secondSet = await (await second.deps.host.load()).all.load()
  const foreign = firstSet.candidates[0]
  const own = secondSet.resolve(foreign.implementationRef)
  assert.equal(own.familyId, foreign.familyId)
  assert.notEqual(own.candidateRef, foreign.candidateRef)

  const expectDetails = (error, expected, received) => {
    assert.ok(isSynaError(error))
    assert.equal(error.code, 'FOREIGN_CANDIDATE_REF')
    assert.equal(error.message, 'CandidateRef belongs to another implementation collection.')
    assert.deepEqual(Object.keys(error.details).sort(), ['expectedSourceSlot', 'receivedSourceSlot'])
    assert.equal(typeof error.details.expectedSourceSlot, 'string')
    assert.equal(typeof error.details.receivedSourceSlot, 'string')
    assert.notEqual(error.details.expectedSourceSlot, error.details.receivedSourceSlot)
    if (expected !== undefined) assert.equal(error.details.expectedSourceSlot, expected)
    if (received !== undefined) assert.equal(error.details.receivedSourceSlot, received)
  }
  const viaRef = await rejection(secondSet.load(foreign.candidateRef))
  expectDetails(viaRef)
  const { expectedSourceSlot: secondSlot, receivedSourceSlot: firstSlot } = viaRef.details
  expectDetails(await rejection(secondSet.load(foreign)), secondSlot, firstSlot)
  assert.throws(() => secondSet.resolve(foreign.candidateRef), { code: 'INVALID_DESCRIPTOR', message: 'resolve() expects an implementation reference.' })
  // The mirror image names the slots the other way round.
  expectDetails(await rejection(firstSet.load(secondSet.candidates[0].candidateRef)), firstSlot, secondSlot)
  // The collection's own refs load.
  assert.equal((await secondSet.load(own.candidateRef)).id, own.familyId === A.family.id ? 'a' : 'b')
  await first.dispose()
  await second.dispose()
  await runtime.dispose()
})

test('FRESH_CONSTRAINT_FAILED has no throw site and is not a code: neither the compiled sources nor the declarations spell it', () => { // syna-v05-compat: the removed code is spelled to assert its absence
  const files = readdirSync(dist).filter(name => name.endsWith('.js') || name.endsWith('.d.ts'))
  const internal = readdirSync(path.join(dist, 'internal')).map(name => path.join('internal', name))
  assert.ok(files.length > 5 && internal.length > 5)
  for (const name of [...files, ...internal]) {
    assert.ok(!readFileSync(path.join(dist, name), 'utf8').includes('FRESH_CONSTRAINT_FAILED'), `${name} still spells the removed code`) // syna-v05-compat
  }
  const codes = readFileSync(path.join(dist, 'errors.d.ts'), 'utf8')
  for (const code of ['FOREIGN_CANDIDATE_REF', 'INACTIVE_REUSE_TARGET', 'INVALID_INHERITED_CHOICE']) assert.match(codes, new RegExp(`'${code}'`))
})
