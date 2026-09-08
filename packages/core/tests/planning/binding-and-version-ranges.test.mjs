// K01 / K06 / R01 / R20 — definitions, versions, admission.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage } from '../../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@v05/${id.replaceAll('.', '-')}-${version}`,
  version,
  syna: { id },
})

test('R01 Binding.to resolves 0.2.x, 0.0.x and ordinary 2.x providers and never widens to lower published versions', async () => {
  const define = makeDefine('v05.binding-ranges')
  const Capability = define.contract()
  const Choice = define.binding('choice', Capability)
  const Zero20 = makeDefine('v05.br.zero', '0.2.0').service({ provides: [Capability], setup: () => ({ v: '0.2.0' }) })
  const Zero23 = makeDefine('v05.br.zero', '0.2.3').service({ provides: [Capability], setup: () => ({ v: '0.2.3' }) })
  const Zero10 = makeDefine('v05.br.zero', '0.1.0').service({ provides: [Capability], setup: () => ({ v: '0.1.0' }) })
  const Tiny5 = makeDefine('v05.br.tiny', '0.0.5').service({ provides: [Capability], setup: () => ({ v: '0.0.5' }) })
  const Tiny6 = makeDefine('v05.br.tiny', '0.0.6').service({ provides: [Capability], setup: () => ({ v: '0.0.6' }) })
  const Two40 = makeDefine('v05.br.two', '2.4.0').service({ provides: [Capability], setup: () => ({ v: '2.4.0' }) })
  const Two49 = makeDefine('v05.br.two', '2.4.9').service({ provides: [Capability], setup: () => ({ v: '2.4.9' }) })
  const Three = makeDefine('v05.br.two', '3.0.0').service({ provides: [Capability], setup: () => ({ v: '3.0.0' }) })
  const Consumer = define.service('consumer', { requires: { choice: Choice }, setup: ({ choice }) => ({ choice }) })
  const Entry = define.entry({ requires: { consumer: Consumer }, parameters: { choice: Choice } })
  const runtime = createRuntime({ services: [Consumer, Zero20, Zero23, Zero10, Tiny5, Tiny6, Two40, Two49, Three] })
  const resolve = async ref => {
    const env = await runtime.enter(Entry, { choice: ref })
    const value = await (await env.deps.consumer.load()).choice.load()
    await env.dispose()
    return value.v
  }
  assert.equal(Choice.to(Zero20).range, '^0.2.0')
  assert.equal(await resolve(Choice.to(Zero20)), '0.2.3', 'highest compatible 0.2.x, never 0.1.0')
  assert.equal(Choice.to(Tiny5).range, '^0.0.5')
  assert.equal(await resolve(Choice.to(Tiny5)), '0.0.5', '^0.0.5 is exactly 0.0.5')
  assert.equal(await resolve(Choice.to(Two40)), '2.4.9', 'never 3.0.0')
  assert.equal(await resolve(Choice.to(Two40, '2.4.0')), '2.4.0')
  assert.equal(await resolve(Choice.to(Two40, '>=2.4.5 <4')), '3.0.0')
  await assert.rejects(resolve(Choice.to(Two40, '^4')), error => error.code === 'MISSING_IMPLEMENTATION')
  assert.throws(() => Choice.to(Two40, 'nonsense range'), /not a valid semver range/)
  assert.deepEqual(runtime.catalog.revisions(Two40.family), ['3.0.0', '2.4.9', '2.4.0'])
  await runtime.dispose()
})

test('R01 implementation refs: no target family means an explicit failure, never a supplier substitution; upgrades resolve inside the intent', () => {
  const define = makeDefine('v05.persistent')
  const Capability = define.contract()
  const Choice = define.binding('choice', Capability)
  const Vendor12 = makeDefine('v05.persistent.vendor', '1.2.0').service({ provides: [Capability], setup: () => ({}) })
  const Vendor19 = makeDefine('v05.persistent.vendor', '1.9.0').service({ provides: [Capability], setup: () => ({}) })
  const Other = makeDefine('v05.persistent.other', '1.5.0').service({ provides: [Capability], setup: () => ({}) })
  const saved = JSON.parse(JSON.stringify(Choice.to(Vendor12)))
  const upgraded = createRuntime({ services: [Vendor19, Other] })
  assert.equal(upgraded.catalog.resolve(Choice.parse(saved)).version, '1.9.0')
  const otherOnly = createRuntime({ services: [Other] })
  assert.throws(() => otherOnly.catalog.resolve(Choice.parse(saved)), error =>
    error.code === 'MISSING_IMPLEMENTATION' && /no supplier substitution/.test(error.message))
  const Major2 = makeDefine('v05.persistent.vendor', '2.0.0').service({ provides: [Capability], setup: () => ({}) })
  const breaking = createRuntime({ services: [Major2] })
  assert.throws(() => breaking.catalog.resolve(Choice.parse(saved)), error =>
    error.code === 'MISSING_IMPLEMENTATION' && error.details.available.includes('2.0.0'))
  // 0.8 (F9): another Contract's id is refused by parse() with INVALID_DESCRIPTOR, not a TypeError.
  assert.throws(() => Choice.parse({ kind: 'implementation-ref', contractId: 'wrong', familyId: 'x', range: '*' }),
    { code: 'INVALID_DESCRIPTOR', details: { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' } })
})

test('R20 exported names stay stable, package version is injected, descriptor apiVersion is independent of package major, physical duplicates canonicalize', async () => {
  const manifest = { name: '@vendor/storage', version: '3.7.1', description: 'Storage', extra: { ignored: true }, syna: { id: 'vendor.storage' } }
  const define = definePackage(manifest)
  const Storage = define.service('storage', { setup: () => ({}) })
  assert.equal(Storage.id, 'vendor.storage/storage@3.7.1')
  assert.equal(Storage.version, '3.7.1')
  assert.equal(define.package.metadata.description, 'Storage')
  const Config = define.input('config')
  assert.equal(Config.id, 'vendor.storage/input/config/v1')
  const next = definePackage({ ...manifest, version: '4.0.0' })
  assert.equal(next.input('config').id, Config.id, 'apiVersion does not follow the package major')
  assert.equal(next.service('storage', { setup: () => ({}) }).family.id, Storage.family.id)
  assert.throws(() => definePackage({ name: '@vendor/bad', version: '4' }), /Invalid semantic version/)
  assert.throws(() => definePackage({ name: '', version: '1.0.0' }), /must not be empty/)

  // Two physical copies of the same revision canonicalize when structurally equal,
  // the setup source text included; a copy whose setup body differs is a conflicting
  // definition (third review round, C6), like any other manifest drift.
  const copyA = definePackage(manifest).service('storage', { setup: () => ({ copy: 'same' }) })
  const copyB = definePackage(manifest).service('storage', { setup: () => ({ copy: 'same' }) })
  const Entry = define.entry({ requires: { storage: copyB } })
  const runtime = createRuntime({ services: [copyA, copyB] })
  assert.deepEqual(runtime.inspect().admittedServices, [copyA.id])
  const env = await runtime.enter(Entry)
  assert.equal((await env.deps.storage.load()).copy, 'same')
  await runtime.dispose()
  const drifted = definePackage(manifest).service('storage', { setup: () => ({ copy: 'drifted' }) })
  assert.throws(() => createRuntime({ services: [copyA, drifted] }), error => error.code === 'DUPLICATE_DEFINITION'
    && /\|setup=/.test(error.details.expected) && error.details.expected !== error.details.actual)
  const referencing = createRuntime({ services: [copyA] })
  await assert.rejects(referencing.enter(define.entry('drifted-entry', { requires: { storage: drifted } })), error => error.code === 'DUPLICATE_DEFINITION')
  await referencing.dispose()
  const conflicting = definePackage(manifest).service('storage', { eager: true, setup: () => ({ copy: 'same' }) })
  assert.throws(() => createRuntime({ services: [copyA, conflicting] }), error => error.code === 'DUPLICATE_DEFINITION')
})

test('K01 Runtime construction is closed and inert: no Env, slot or instance; unknown definitions are refused; invalid options are TypeErrors', async () => {
  const define = makeDefine('v05.closed')
  let starts = 0
  const Eager = define.service('eager', { eager: true, setup: () => { starts += 1; return {} } })
  const Stranger = makeDefine('v05.closed.stranger').service({ setup: () => ({}) })
  const runtime = createRuntime({ services: [Eager] })
  assert.equal(starts, 0)
  assert.equal(runtime.inspect().rootEnvCount, 0)
  assert.equal(runtime.inspect().liveEnvCount, 0)
  await assert.rejects(runtime.enter(define.entry('stranger', { requires: { stranger: Stranger } })), error => error.code === 'MISSING_SERVICE')
  assert.throws(() => createRuntime({ services: [Eager], limits: { loadTimeoutMs: -1 } }), TypeError)
  assert.throws(() => createRuntime({ services: [Eager], limits: { planningBudget: 0 } }), TypeError)
  assert.throws(() => createRuntime({ services: [Eager], limits: { planCacheEntries: 0 } }), TypeError)
  assert.throws(() => createRuntime({ services: [{ kind: 'nope' }] }), error => error.code === 'INVALID_DESCRIPTOR')
  await assert.rejects(runtime.enter({ kind: 'service-revision' }), error => error.code === 'INVALID_DESCRIPTOR')
  const env = await runtime.enter(define.entry('root', { requires: { eager: Eager } }))
  assert.equal(starts, 1)
  await runtime.dispose()
  await assert.rejects(runtime.enter(define.entry('again', {})), error => error.code === 'RUNTIME_CLOSED')
  assert.equal(env.state, 'disposed')
})
