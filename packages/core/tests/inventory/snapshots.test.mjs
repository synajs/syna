// Zero-semantics guard for the v0.6 API consolidation (A03), kept through 0.7 and the 0.8 rename: the
// check/explain/inspect/catalog output and the error diagnostics of one fixed world, recorded on 0.5.0
// (snapshots/v05-explain-inspect.json) before the first rename. A rename commit adds its entry to the mapping
// (snapshots/v05-renames.json: the key, value or addition it introduces); the recorded data itself never changes.
// Re-record only for a new baseline: SYNA_UPDATE_SNAPSHOTS=1 node --test packages/core/tests/inventory/snapshots.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { auto, createRuntime, definePackage } from '../../dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const snapshotFile = path.join(here, '../snapshots/v05-explain-inspect.json')

// The mapping from the recorded 0.5 data to the current names (data, next to the record), applied before the comparison:
//   keys:   { from, to, within?, whenHasKey? }   rename an object key (inside objects whose `kind` equals `within`, or
//                                                that carry `whenHasKey`, when given)
//   values: { key, from, to }                    replace the value of `key` when it equals `from`
//   added:  { whenEquals?, whenHasKeys?, key, value | merge }   set (or merge into) `key` on every recorded object the
//                                                predicates accept, after the renames
const MAPPING = JSON.parse(readFileSync(path.join(here, '../snapshots/v05-renames.json'), 'utf8'))

const accepts = (object, added) =>
  (added.whenEquals === undefined || Object.entries(added.whenEquals).every(([key, value]) => object[key] === value))
  && (added.whenHasKeys === undefined || added.whenHasKeys.every(key => key in object))

const applyRenames = value => {
  if (Array.isArray(value)) return value.map(applyRenames)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    const rename = MAPPING.keys.find(entry => entry.from === key
      && (entry.within === undefined || value.kind === entry.within)
      && (entry.whenHasKey === undefined || entry.whenHasKey in value))
    const target = rename ? rename.to : key
    const replaced = MAPPING.values.find(entry => entry.key === key && entry.from === inner)
    out[target] = replaced ? replaced.to : applyRenames(inner)
  }
  for (const added of MAPPING.added) {
    if (!accepts(value, added)) continue
    out[added.key] = 'merge' in added ? { ...added.merge, ...out[added.key] } : structuredClone(added.value)
  }
  return out
}

// Descriptors that appear inside error details are recorded by kind and id only; everything else verbatim.
const DESCRIPTOR_KINDS = new Set(['contract', 'input', 'binding', 'service-family', 'service-revision', 'entry', 'all-implementations', 'auto-implementation', 'forward', 'service-range'])
const plain = (value, seen = new Set()) => {
  if (Array.isArray(value)) return value.map(item => plain(item, seen))
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? '[function]' : value
  // Recorded on 0.5: every object whose `kind` is a descriptor kind is collapsed (a binding / input / entry node included); the
  // collection node was recorded in full because its kind was `all` then — since 0.8 it shares `all-implementations` with `C.all`
  // and is told apart by its `nodeId`.
  if (typeof value.kind === 'string' && DESCRIPTOR_KINDS.has(value.kind) && !(value.kind === 'all-implementations' && 'nodeId' in value)) return { $descriptor: value.kind, id: value.id ?? value.contract?.id ?? value.family?.id ?? null }
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  const out = {}
  for (const [key, inner] of Object.entries(value)) if (inner !== undefined) out[key] = plain(inner, seen)
  seen.delete(value)
  return out
}

const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@snap/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })

const capture = async run => {
  try {
    const value = await run()
    if (value && typeof value === 'object' && typeof value.inspect === 'function' && typeof value.dispose === 'function') {
      const inspection = value.inspect()
      await value.dispose()
      return { resolved: true, env: inspection }
    }
    return { resolved: true, value }
  } catch (error) {
    return { name: error.name, code: error.code, message: error.message, details: error.details }
  }
}

const buildWorld = () => {
  const define = makeDefine('snap')
  const Storage = define.contract('storage')
  const Plugin = define.contract('plugin')
  const Tenant = define.input('tenant')
  const Flag = define.input('flag')
  const Picker = define.binding('picker', Storage)
  const Config = define.service('config', {
    requires: { tenant: Tenant, flag: Flag },
    setup: ({ tenant, flag }) => ({ tenant: tenant.read(), flag: flag.read() }),
  })
  const Db1 = makeDefine('snap-db', '1.0.0').service({ setup: () => ({ version: 1 }) })
  const Db2 = makeDefine('snap-db', '2.0.0').service({ setup: () => ({ version: 2 }) })
  const Cache = define.service('cache', { requires: { db: Db1.range('^1.0.0') }, setup: () => ({}) })
  const Memory = makeDefine('snap-memory').service({ provides: [Storage], setup: () => ({ get: key => `memory:${key}` }) })
  const Files = makeDefine('snap-files', '1.2.3').service({ provides: [Storage], eager: true, setup: () => ({ get: key => `files:${key}` }) })
  const PluginA = makeDefine('snap-plugin-a').service({ provides: [Plugin], setup: () => ({ id: 'a' }) })
  const PluginB = makeDefine('snap-plugin-b', '1.1.0').service({ provides: [Plugin], setup: () => ({ id: 'b' }) })
  const Host = define.service('host', { requires: { plugins: Plugin.all }, setup: () => ({}) })
  const App = define.service('app', {
    requires: { config: Config, db: Db1, cache: Cache, storage: Picker, host: Host },
    setup: () => ({}),
  })
  const Root = define.entry('root', { requires: { app: App, storage: Picker }, parameters: { tenant: Tenant, flag: Flag, picker: Picker } })
  const Child = define.entry('child', { requires: { app: App }, parameters: { flag: Flag }, reuse: { fresh: [Cache] } })
  const Shared = define.entry('shared', { requires: { app: App }, reuse: { share: [Db1] } })
  const Chooser = define.entry('chooser', { requires: { storage: auto(Storage) } })
  const runtime = createRuntime({ services: [Config, Db1, Db2, Cache, Memory, Files, PluginA, PluginB, Host, App], limits: { planCacheEntries: 8 } })
  return { Storage, Plugin, Picker, Memory, Db1, Db2, Cache, Config, Root, Child, Shared, Chooser, runtime }
}

const recordWorld = async () => {
  const { Storage, Plugin, Picker, Memory, Db1, Db2, Cache, Config, Root, Child, Shared, Chooser, runtime } = buildWorld()
  const record = {}
  record.inspectInitial = runtime.inspect()
  record.catalogStorage = runtime.catalog.implementations(Storage)
  record.catalogPlugin = runtime.catalog.implementations(Plugin)
  record.revisionsDb = runtime.catalog.revisions(Db1.family)
  const ref = Picker.to(Memory)
  record.pickerRef = ref
  record.pickerRefJson = JSON.stringify(ref)
  record.pickerParsed = Picker.parse(JSON.parse(JSON.stringify(ref)))
  record.catalogResolve = runtime.catalog.resolve(ref)
  const rootArgs = { tenant: { id: 't1' }, flag: false, picker: ref }
  record.checkRootOk = await runtime.check(Root, rootArgs)
  record.checkRootMissing = await runtime.check(Root, { tenant: { id: 't1' } })
  record.explainRoot = await runtime.explain(Root, rootArgs)
  record.explainRootMissing = await runtime.explain(Root, {})
  const root = await runtime.enter(Root, rootArgs)
  record.rootInspect = root.inspect()
  record.explainChild = await root.explain(Child, { flag: true })
  record.explainShared = await root.explain(Shared)
  record.checkChildFreshInactive = await root.check(Child, { flag: true }, { reuse: { fresh: [Db2] } })
  record.checkChildShareForked = await root.check(Child, { flag: true }, { reuse: { share: [Cache] } })
  record.explainChildShareConfig = await root.explain(Child, { flag: true }, { reuse: { share: [Config] } })
  const child = await root.enter(Child, { flag: true })
  record.childInspect = child.inspect()
  record.inspectLive = runtime.inspect()
  record.errors = {
    deriveFreshInactive: await capture(() => root.derive({ reuse: { fresh: [Db2] } })),
    deriveShareForked: await capture(() => root.derive({ reuse: { fresh: [Db1], share: [Cache] } })),
    deriveFreshDb: await capture(() => root.derive({ reuse: { fresh: [Db1] } })),
    enterMissingBinding: await capture(() => runtime.enter(Root, { tenant: { id: 't2' }, flag: true })),
    enterMissingInput: await capture(() => runtime.enter(Root, { picker: ref })),
    chooserWithoutPolicy: await capture(() => runtime.enter(Chooser)),
    parseWithoutId: await capture(() => Picker.parse({ kind: 'implementation-ref', contractId: Storage.id, range: '1.0.0' })),
    parseForeignContract: await capture(() => Picker.parse({ ...JSON.parse(JSON.stringify(ref)), contractId: Plugin.id })),
    resolveUnavailable: await capture(() => runtime.catalog.resolve(Picker.to(Memory, '^9.0.0'))),
    enterUnavailable: await capture(() => runtime.enter(Root, { ...rootArgs, picker: Picker.to(Memory, '^9.0.0') })),
  }
  await child.dispose()
  await root.dispose()
  record.inspectAfterDispose = runtime.inspect()
  await runtime.dispose()
  return plain(record)
}

test('A03 check/explain/inspect/catalog snapshots of the fixed world match the 0.5.0 recording (renamed fields mapped)', async () => {
  const actual = await recordWorld()
  if (process.env.SYNA_UPDATE_SNAPSHOTS === '1') {
    mkdirSync(path.dirname(snapshotFile), { recursive: true })
    writeFileSync(snapshotFile, JSON.stringify(actual, null, 2) + '\n')
  }
  assert.ok(existsSync(snapshotFile), `missing ${snapshotFile}; record it with SYNA_UPDATE_SNAPSHOTS=1`)
  const recorded = JSON.parse(readFileSync(snapshotFile, 'utf8'))
  assert.deepEqual(actual, applyRenames(recorded))
})

test('A03 the recording is stable across two runs of the same build', async () => {
  assert.deepEqual(await recordWorld(), await recordWorld())
})
