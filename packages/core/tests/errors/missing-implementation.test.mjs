// v0.7 (Phase C, S8): MISSING_IMPLEMENTATION keeps its code; its six throw sites produce three `details` shapes with
// every field required — `{ binding, implementation, version, available }` (the planner's Binding assignment),
// `{ contract, site }` (a bare Contract or auto() site with no implementer, two sites in the graph builder) and
// `{ contract, implementation, version, available }` (the catalog / collection: unknown family, unsatisfied
// version, candidate not held by the collection). `details.revision` no longer exists and nothing is `undefined`.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { auto, createRuntime, definePackage, isSynaError } from '../../dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '../../dist')
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v07/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })

const capture = async run => {
  try { await run() }
  catch (error) { return error }
  assert.fail('expected a throw or a rejection')
}

const SHAPES = [
  ['available', 'binding', 'implementation', 'version'],
  ['contract', 'site'],
  ['available', 'contract', 'implementation', 'version'],
]
const expectMissing = (error, message, details) => {
  assert.ok(isSynaError(error), `expected a SynaError, got ${error?.stack ?? error}`)
  assert.equal(error.code, 'MISSING_IMPLEMENTATION')
  assert.equal(error.message, message)
  assert.deepEqual(error.details, details)
  const keys = Object.keys(error.details).sort()
  assert.ok(SHAPES.some(shape => shape.join(',') === keys.join(',')), `keys ${keys.join(',')} are not one of the three shapes`)
  for (const [key, value] of Object.entries(error.details)) {
    assert.notEqual(value, undefined, `${key} is undefined`)
    if (key === 'available') assert.ok(Array.isArray(value) && value.every(item => typeof item === 'string'), 'available: string[]')
    else assert.equal(typeof value, 'string', `${key}: string`)
  }
}

const world = () => {
  const define = makeDefine('s8')
  const Capability = define.contract('capability')
  const Choice = define.binding('choice', Capability)
  const Provider = makeDefine('s8-provider', '1.0.0').service({ provides: [Capability], setup: () => ({ id: 'provider' }) })
  const Stranger = makeDefine('s8-stranger', '1.0.0').service({ provides: [Capability], setup: () => ({ id: 'stranger' }) })
  const Chooser = define.entry('chooser', { parameters: { choice: Choice } })
  return { define, Capability, Choice, Provider, Stranger, Chooser }
}

test('site 1 (planner): a Binding assignment no admitted revision satisfies — unknown family and unsatisfied version', async () => {
  const { Capability, Choice, Provider, Stranger, Chooser } = world()
  const runtime = createRuntime({ services: [Provider] })
  expectMissing(
    await capture(() => runtime.enter(Chooser, { choice: Choice.to(Provider, '^9.0.0') })),
    `No admitted ${Provider.family.id} revision satisfies ^9.0.0 and ${Capability.id}.`,
    { binding: Choice.id, implementation: Provider.family.id, version: '^9.0.0', available: ['1.0.0'] },
  )
  expectMissing(
    await capture(() => runtime.enter(Chooser, { choice: Choice.to(Stranger) })),
    `No admitted ${Stranger.family.id} revision satisfies ^1.0.0 and ${Capability.id}.`,
    { binding: Choice.id, implementation: Stranger.family.id, version: '^1.0.0', available: [] },
  )
  // check() reports the same error (the code is backtrackable, as in 0.6).
  const checked = await runtime.check(Chooser, { choice: Choice.to(Stranger) })
  assert.equal(checked.ok, false)
  assert.equal(checked.error.code, 'MISSING_IMPLEMENTATION')
  assert.deepEqual(checked.error.details, { binding: Choice.id, implementation: Stranger.family.id, version: '^1.0.0', available: [] })
  await runtime.dispose()
})

test('sites 2 and 3 (graph builder): a bare Contract site and an auto() site with no implementer', async () => {
  const { define, Capability } = world()
  const Bare = define.service('bare', { requires: { cap: Capability }, setup: () => ({}) })
  const Auto = define.service('auto-host', { requires: { cap: auto(Capability) }, setup: () => ({}) })
  const BareRoot = define.entry('bare-root', { requires: { bare: Bare } })
  const AutoRoot = define.entry('auto-root', { requires: { host: Auto } })
  const RootSite = define.entry('root-site', { requires: { cap: Capability } })
  const runtime = createRuntime({ services: [Bare, Auto] })
  const message = `No admitted Service implements Contract ${Capability.id}.`
  expectMissing(await capture(() => runtime.enter(BareRoot)), message, { contract: Capability.id, site: `service:${Bare.id}/dependency:cap` })
  expectMissing(await capture(() => runtime.enter(AutoRoot)), message, { contract: Capability.id, site: `service:${Auto.id}/dependency:cap` })
  const root = await capture(() => runtime.enter(RootSite))
  expectMissing(root, message, { contract: Capability.id, site: root.details.site })
  assert.match(root.details.site, /\/require:cap$/)
  const checked = await runtime.check(AutoRoot)
  assert.equal(checked.ok, false)
  assert.deepEqual(checked.error.details, { contract: Capability.id, site: `service:${Auto.id}/dependency:cap` })
  await runtime.dispose()
})

test('sites 4 and 5 (catalog and collection): an implementation reference to an unknown family (available: []) and to an unsatisfied version', async () => {
  const { define, Capability, Choice, Provider, Stranger } = world()
  const Host = define.service('host', { requires: { all: Capability.all }, setup: ({ all }) => ({ all }) })
  const Entry = define.entry('entry', { requires: { host: Host } })
  const runtime = createRuntime({ services: [Provider, Host] })
  const env = await runtime.enter(Entry)
  const set = await (await env.deps.host.load()).all.load()
  const unknownFamily = Choice.to(Stranger)
  const unknownVersion = Choice.to(Provider, '^9.0.0')
  const familyMessage = `Implementation family ${Stranger.family.id} is not admitted by this Runtime; no supplier substitution is attempted.`
  const versionMessage = `No ${Provider.family.id} candidate for ${Capability.id} satisfies ^9.0.0.`
  for (const resolve of [ref => runtime.catalog.resolve(ref), ref => set.resolve(ref), ref => set.load(ref)]) {
    expectMissing(await capture(() => resolve(unknownFamily)), familyMessage,
      { contract: Capability.id, implementation: Stranger.family.id, version: '^1.0.0', available: [] })
    expectMissing(await capture(() => resolve(unknownVersion)), versionMessage,
      { contract: Capability.id, implementation: Provider.family.id, version: '^9.0.0', available: ['1.0.0'] })
  }
  // F9 (0.8): the read path accepts the one serialized shape only; a reference without a family is refused, not read.
  const malformed = await capture(() => runtime.catalog.resolve({ kind: 'implementation-ref', contractId: Capability.id, range: '^1.0.0' }))
  assert.equal(malformed.code, 'INVALID_DESCRIPTOR')
  assert.deepEqual(malformed.details, { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' })
  await runtime.dispose()
})

test('site 6 (collection): a CandidateRef this collection does not hold — another Runtime\'s ref with coinciding slot ids, and a version the collection lacks', async () => {
  const { define, Capability, Provider, Stranger } = world()
  const Host = define.service('host', { requires: { all: Capability.all }, setup: ({ all }) => ({ all }) })
  const Entry = define.entry('entry', { requires: { host: Host } })
  const setOf = async runtime => (await (await (await runtime.enter(Entry)).deps.host.load()).all.load())
  // Two Runtimes with the same world shape number their slots alike; each admits a different family.
  const providers = createRuntime({ services: [Provider, Host] })
  const strangers = createRuntime({ services: [Stranger, Host] })
  const providerSet = await setOf(providers)
  const strangerSet = await setOf(strangers)
  const message = 'Candidate does not belong to this implementation collection.'
  expectMissing(await capture(() => providerSet.load(strangerSet.candidates[0].candidateRef)), message,
    { contract: Capability.id, implementation: Stranger.family.id, version: '1.0.0', available: [] })
  expectMissing(await capture(() => strangerSet.load(providerSet.candidates[0])), message,
    { contract: Capability.id, implementation: Provider.family.id, version: '1.0.0', available: [] })
  // A key of a held family with a version the collection lacks lists the versions it holds.
  const foreign = await capture(() => providerSet.load({ kind: 'candidate-ref', sourceSlotId: 'slot-0', revisionKey: Provider.id }))
  assert.equal(foreign.code, 'FOREIGN_CANDIDATE_REF')
  const own = foreign.details.expectedSourceSlot
  expectMissing(await capture(() => providerSet.load({ kind: 'candidate-ref', sourceSlotId: own, revisionKey: `${Provider.family.id}@9.9.9` })), message,
    { contract: Capability.id, implementation: Provider.family.id, version: '9.9.9', available: ['1.0.0'] })
  // A scoped family id keeps its own `@`: the version is what follows the last one.
  expectMissing(await capture(() => providerSet.load({ kind: 'candidate-ref', sourceSlotId: own, revisionKey: '@scope/pkg/service@2.0.0' })), message,
    { contract: Capability.id, implementation: '@scope/pkg/service', version: '2.0.0', available: [] })
  assert.equal((await providerSet.load(providerSet.candidates[0].candidateRef)).id, 'provider')
  await providers.dispose()
  await strangers.dispose()
})

test('the compiled sources have exactly six MISSING_IMPLEMENTATION throw sites and the declaration has three shapes without an optional or undefined field', () => {
  const counts = {}
  for (const dir of [dist, path.join(dist, 'internal')]) {
    for (const name of readdirSync(dir).filter(name => name.endsWith('.js'))) {
      const sites = [...readFileSync(path.join(dir, name), 'utf8').matchAll(/new SynaError\('MISSING_IMPLEMENTATION'/g)].length
      if (sites > 0) counts[name] = sites
    }
  }
  assert.deepEqual(counts, { 'entry-planner.js': 1, 'graph-builder.js': 2, 'implementation-directory.js': 3 })
  const dts = readFileSync(path.join(dist, 'errors.d.ts'), 'utf8')
  const entry = dts.slice(dts.indexOf('readonly MISSING_IMPLEMENTATION:'), dts.indexOf('readonly MISSING_INPUT:'))
  const shapes = [...entry.matchAll(/\{([^{}]*)\}/g)].map(match => match[1].split(';').map(part => part.trim().replace(/^readonly /, '')).filter(Boolean))
  assert.equal(shapes.length, 3)
  for (const shape of shapes) {
    for (const field of shape) {
      assert.doesNotMatch(field, /\?:/, `optional field ${field}`)
      assert.doesNotMatch(field, /undefined/, `undefined in ${field}`)
    }
  }
  assert.deepEqual(shapes.map(shape => shape.map(field => field.split(':')[0]).sort()), SHAPES)
})
