// v0.8 (§2.2 F9 / F19, §4 A05): an implementation reference has exactly one serialized shape —
// `{ kind: 'implementation-ref', contractId, familyId, range }` — and it is the only shape anything writes
// (`Binding.to()`, `catalog.resolve()`, `catalog.implementations()`, `C.all` candidates) and the only shape
// anything reads (`Binding.parse()`, `catalog.resolve()`, a Binding assignment, `set.resolve()` / `set.load(ref)`).
// The pre-0.8 forms are taken from the 0.5.0 recording (snapshots/v05-explain-inspect.json), never spelled here:
// the recorded kind, the recorded family key and the recorded range key are all refused with INVALID_DESCRIPTOR.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntime, definePackage } from '../../dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v08/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })
const rejection = async promise => {
  try { await promise }
  catch (error) { return error }
  assert.fail('expected a rejection')
}
const thrown = fn => {
  try { fn() }
  catch (error) { return error }
  assert.fail('expected a throw')
}

const SHAPE = ['kind', 'contractId', 'familyId', 'range']
const recorded = JSON.parse(readFileSync(path.join(here, '../snapshots/v05-explain-inspect.json'), 'utf8')).pickerRef
const [recordedKindKey, recordedContractKey, recordedFamilyKey, recordedRangeKey] = Object.keys(recorded)
assert.deepEqual([recordedKindKey, recordedContractKey], ['kind', 'contractId'], 'the recording carries the 0.5 shape')
assert.notEqual(recorded.kind, 'implementation-ref', 'the recorded kind is the pre-0.8 one')
assert.notEqual(recordedFamilyKey, 'familyId', 'the recorded family key is the pre-0.6 one')
assert.notEqual(recordedRangeKey, 'range', 'the recorded range key is the pre-0.8 one')

const world = () => {
  const define = makeDefine('v08-ref')
  const Capability = define.contract('capability')
  const Choice = define.binding('choice', Capability)
  const Vendor = makeDefine('v08-ref-vendor', '1.2.0').service({ provides: [Capability], setup: () => ({ vendor: true }) })
  const Other = makeDefine('v08-ref-other', '2.0.0').service({ provides: [Capability], setup: () => ({ other: true }) })
  const Host = define.service('host', { requires: { all: Capability.all }, setup: ({ all }) => ({ all }) })
  const WithChoice = define.entry('with-choice', { parameters: { choice: Choice } })
  const HostEntry = define.entry('host-entry', { requires: { host: Host } })
  return { define, Capability, Choice, Vendor, Other, Host, WithChoice, HostEntry }
}

/** The pre-0.8 forms of one reference, built from the recording's keys around the current values. */
const oldForms = (Capability, familyId, range) => ({
  // the 0.5 form: the recorded kind, the recorded family key, the recorded range key
  recordedShape: { kind: recorded.kind, contractId: Capability.id, [recordedFamilyKey]: familyId, [recordedRangeKey]: range },
  // the 0.6/0.7 form: the recorded kind with the 0.6 family key and the recorded range key
  previousKind: { kind: recorded.kind, contractId: Capability.id, familyId, [recordedRangeKey]: range },
  // the 0.8 kind with the pre-0.8 family key
  oldFamilyKey: { kind: 'implementation-ref', contractId: Capability.id, [recordedFamilyKey]: familyId, range },
  // the 0.8 kind with the pre-0.8 range key
  oldRangeKey: { kind: 'implementation-ref', contractId: Capability.id, familyId, [recordedRangeKey]: range },
  // both keys present: the old one is not an alias of the new one
  bothFamilyKeys: { kind: 'implementation-ref', contractId: Capability.id, [recordedFamilyKey]: familyId, range },
})
const expectRefused = (error, form, site, wrongKind = { descriptor: 'ImplementationRef', problem: 'wrong-kind' }) => {
  assert.equal(error?.code, 'INVALID_DESCRIPTOR', `${site}: ${error?.message}`)
  const expected = form.kind === 'implementation-ref' ? { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' } : wrongKind
  assert.deepEqual(error.details, expected, site)
}

test('A05 every write has the one shape: Binding.to(), parse(), catalog.resolve(), catalog.implementations() and the C.all candidates', async () => {
  const { Capability, Choice, Vendor, Other, Host, HostEntry } = world()
  const ref = Choice.to(Vendor)
  assert.deepEqual(Object.keys(ref), SHAPE)
  assert.deepEqual(ref, { kind: 'implementation-ref', contractId: Capability.id, familyId: Vendor.family.id, range: '^1.2.0' })
  assert.deepEqual(Choice.to(Vendor, '>=1.0.0 <3'), { kind: 'implementation-ref', contractId: Capability.id, familyId: Vendor.family.id, range: '>=1.0.0 <3' })
  const parsed = Choice.parse(JSON.parse(JSON.stringify(ref)))
  assert.deepEqual(Object.keys(parsed), SHAPE)
  assert.deepEqual(parsed, ref)

  const runtime = createRuntime({ services: [Vendor, Other, Host] })
  try {
    const record = runtime.catalog.resolve(ref)
    assert.deepEqual(Object.keys(record.implementationRef), SHAPE)
    assert.deepEqual(record.implementationRef, ref, 'the record carries the reference to() writes: the default range of its version')
    for (const item of runtime.catalog.implementations(Capability)) assert.deepEqual(Object.keys(item.implementationRef), SHAPE)
    assert.deepEqual(Object.keys(record).sort(), ['contractId', 'eager', 'familyId', 'familyMetadata', 'implementationRef', 'revisionMetadata', 'version'])

    const env = await runtime.enter(HostEntry)
    const set = await (await env.deps.host.load()).all.load()
    assert.equal(set.candidates.length, 2)
    for (const candidate of set.candidates) {
      assert.deepEqual(Object.keys(candidate.implementationRef), SHAPE)
      for (const key of ['kind', 'contract', 'familyId', 'version']) assert.ok(key in candidate.candidateRef, `candidateRef.${key}`)
      assert.equal(candidate.candidateRef.kind, 'candidate-ref')
    }
    assert.equal(set.resolve(ref).familyId, Vendor.family.id)
    assert.deepEqual(await set.load(ref), { vendor: true })
  }
  finally { await runtime.dispose() }
})

test('A05 parse() refuses every pre-0.8 form with INVALID_DESCRIPTOR: the recorded kind is wrong-kind, a missing familyId or range is malformed', () => {
  const { Capability, Choice, Vendor } = world()
  const forms = oldForms(Capability, Vendor.family.id, '^1.0.0')
  for (const [name, form] of Object.entries(forms)) expectRefused(thrown(() => Choice.parse(form)), form, `parse ${name}`)
  // The reasons, one each: the kind is checked first, then the shape (a non-object is its own token).
  assert.deepEqual(thrown(() => Choice.parse(forms.recordedShape)).details, { descriptor: 'ImplementationRef', problem: 'wrong-kind' })
  assert.deepEqual(thrown(() => Choice.parse(forms.oldFamilyKey)).details, { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' })
  assert.deepEqual(thrown(() => Choice.parse(forms.oldRangeKey)).details, { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' })
  assert.deepEqual(thrown(() => Choice.parse('nope')).details, { descriptor: 'ImplementationRef', problem: 'not-an-object' })
  assert.deepEqual(thrown(() => Choice.parse({ kind: 'implementation-ref', contractId: Capability.id, familyId: '', range: '^1.0.0' })).details, { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' })
  assert.deepEqual(thrown(() => Choice.parse({ kind: 'implementation-ref', contractId: Capability.id, familyId: Vendor.family.id, range: 'not a range' })).details, { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' })
  assert.deepEqual(thrown(() => Choice.parse({ kind: 'implementation-ref', contractId: 'another/contract/v1', familyId: Vendor.family.id, range: '^1.0.0' })).details, { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' })
  // The messages name the Contract and, for the kind, the one kind.
  assert.equal(thrown(() => Choice.parse(forms.recordedShape)).message, `Invalid implementation reference for Contract ${Capability.id}: kind must be "implementation-ref".`)
  assert.equal(thrown(() => Choice.parse(forms.oldFamilyKey)).message, `Invalid implementation reference for Contract ${Capability.id}.`)
})

test('A05 the Runtime read paths refuse the same forms: catalog.resolve(), a Binding assignment, set.resolve() and set.load(ref)', async () => {
  const { Capability, Choice, Vendor, Other, Host, WithChoice, HostEntry } = world()
  const forms = oldForms(Capability, Vendor.family.id, '^1.0.0')
  const runtime = createRuntime({ services: [Vendor, Other, Host] })
  try {
    const env = await runtime.enter(HostEntry)
    const set = await (await env.deps.host.load()).all.load()
    for (const [name, form] of Object.entries(forms)) {
      expectRefused(thrown(() => runtime.catalog.resolve(form)), form, `catalog.resolve ${name}`)
      // A Binding assignment checks the kind as part of the assignment shape (0.7 S7): a wrong kind names the Binding.
      expectRefused(await rejection(runtime.enter(WithChoice, { choice: form })), form, `assignment ${name}`, { descriptor: Choice.id, problem: 'invalid-assignment' })
      expectRefused(thrown(() => set.resolve(form)), form, `set.resolve ${name}`)
      // set.load() reads anything that is not an implementation ref as a candidate ref (0.7 S7, unchanged): refused as one.
      expectRefused(await rejection(set.load(form)), form, `set.load ${name}`, { descriptor: 'CandidateRef', problem: 'not-from-this-runtime' })
    }
    // The assignment path names the Binding; the collection paths name the call.
    assert.equal((await rejection(runtime.enter(WithChoice, { choice: forms.oldFamilyKey }))).message, `Malformed implementation reference assigned to Binding ${Choice.id}.`)
    assert.equal(thrown(() => runtime.catalog.resolve(forms.oldFamilyKey)).message, 'catalog.resolve() received a malformed implementation reference.')
    assert.equal(thrown(() => set.resolve(forms.oldFamilyKey)).message, 'resolve() received a malformed implementation reference.')
    // Nothing was read: the world is untouched and the current form still resolves.
    assert.equal(runtime.inspect().liveEnvCount, 1)
    const explanation = await runtime.explain(WithChoice, { choice: Choice.to(Vendor) })
    assert.equal(explanation.ok, true)
    assert.deepEqual(explanation.parameters.bindingsAssigned, { [Choice.id]: Vendor.id })
    const chosen = await runtime.enter(WithChoice, { choice: Choice.to(Vendor) })
    assert.equal(chosen.state, 'ready')
    await chosen.dispose()
  }
  finally { await runtime.dispose() }
})

test('A05 the kind is a discriminator, not a preference: a reference of the one shape resolves; without the family it is MISSING_IMPLEMENTATION, never a substitution', () => {
  const { Capability, Choice, Vendor, Other } = world()
  const runtime = createRuntime({ services: [Other] })
  const error = thrown(() => runtime.catalog.resolve(Choice.to(Vendor)))
  assert.equal(error.code, 'MISSING_IMPLEMENTATION')
  assert.deepEqual(error.details, { contract: Capability.id, implementation: Vendor.family.id, version: '^1.2.0', available: [] })
})
