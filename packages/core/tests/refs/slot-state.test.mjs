// v0.8 (§2.1 T6, §2.3 D6, §4 A06): `SlotState` names the states of a Service slot, and it is exactly the set of
// states a slot can be observed in — `dormant`, `starting`, `ready`, `failed`, `disposing`, `disposed`,
// `abandoned` — no more (a member nothing reports) and no less (a state the union does not name). The three
// `state` fields that were `string` in 0.7 are typed: `EnvInspection.state: EnvState`,
// `EnvInspectionNode.state: SlotState`, `attempt-abandoned.dependencies[].state: SlotState`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntime, definePackage } from '../../dist/index.js'

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist')
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v08/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const waitFor = async (condition, timeoutMs = 2_000) => {
  const started = Date.now()
  while (!condition()) {
    assert.ok(Date.now() - started < timeoutMs, 'condition not met in time')
    await sleep(2)
  }
}
const nodeOf = (env, revision) => env.inspect().nodes.find(node => node.nodeId === `service:${revision.id}`)

const declaration = readFileSync(path.join(dist, 'descriptors.d.ts'), 'utf8')
const unionLine = declaration.split('\n').find(line => line.startsWith('export type SlotState = '))
const DECLARED = [...unionLine.matchAll(/'([a-z-]+)'/g)].map(match => match[1])

test('A06 the declaration: SlotState is exported with seven members, and the three state fields are typed with it or with EnvState', () => {
  assert.deepEqual(DECLARED, ['dormant', 'starting', 'ready', 'failed', 'disposing', 'disposed', 'abandoned'])
  const block = (name, end = '}') => declaration.slice(declaration.indexOf(name), declaration.indexOf(end, declaration.indexOf(name)))
  assert.match(block('export interface EnvInspection {'), /readonly state: EnvState;/, 'EnvInspection.state is an EnvState')
  assert.match(block('export interface EnvInspectionNode {'), /readonly state: SlotState;/, 'EnvInspectionNode.state is a SlotState')
  const abandoned = declaration.slice(declaration.indexOf("readonly type: 'attempt-abandoned';"), declaration.indexOf("readonly type: 'runtime-attempts-outstanding';"))
  assert.match(abandoned, /readonly dependencies: readonly \{[\s\S]*?readonly state: SlotState;[\s\S]*?\}\[\];/, 'attempt-abandoned.dependencies[].state is a SlotState')
  assert.ok(!/readonly state: string;/.test(block('export interface EnvInspectionNode {')), 'no untyped state on the node')
  assert.match(declaration, /^export type EnvState = 'activating' \| 'ready' \| 'disposing' \| 'disposed';$/m)
  assert.match(readFileSync(path.join(dist, 'index.d.ts'), 'utf8'), /\bSlotState\b/, 'SlotState is exported from the package entry')
})

test('A06 the observable set: every member of SlotState is a state a slot is seen in, and no slot is ever seen in another state', async () => {
  const seen = new Set()
  const observe = env => { for (const node of env.inspect().nodes) if (node.kind === 'service') seen.add(node.state) }
  const define = makeDefine('v08-slot-state')
  const events = []

  // dormant → starting → ready, then disposing → disposed through a slow cleanup.
  const gate = deferred()
  const cleanupGate = deferred()
  const Slow = define.service('slow', { async setup(_deps, { onDispose }) { onDispose(() => cleanupGate.promise); await gate.promise; return { ok: true } } })
  // failed: one attempt, sticky.
  const Broken = define.service('broken', { failure: { attempts: 1, afterExhaustion: 'sticky' }, setup: () => { throw new Error('broken') } })
  // abandoned: a setup that never settles, under a short grace.
  const Stuck = define.service('stuck', { requires: { slow: Slow }, setup: () => new Promise(() => {}) })
  const Entry = define.entry('entry', { requires: { slow: Slow, broken: Broken, stuck: Stuck } })
  const runtime = createRuntime({ services: [Slow, Broken, Stuck], limits: { disposalGraceMs: 20 }, diagnostics: { onEvent: event => events.push(event) } })
  const env = await runtime.enter(Entry)
  observe(env)
  assert.deepEqual([...seen], ['dormant'], 'planned, never loaded')

  const loading = env.deps.slow.load()
  await waitFor(() => nodeOf(env, Slow).state === 'starting')
  observe(env)
  gate.resolve()
  await loading
  assert.equal(nodeOf(env, Slow).state, 'ready')
  observe(env)

  await assert.rejects(env.deps.broken.load(), /broken/)
  assert.equal(nodeOf(env, Broken).state, 'failed')
  const notLoadable = await env.deps.broken.load().catch(error => error)
  assert.equal(notLoadable.message, 'broken', 'sticky: the failure is the slot\'s state, not a refusal')
  observe(env)

  void env.deps.stuck.load().catch(() => undefined)
  await waitFor(() => nodeOf(env, Stuck).state === 'starting')

  const closing = env.dispose()
  await waitFor(() => nodeOf(env, Stuck).state === 'abandoned', 1_000)
  observe(env)
  await waitFor(() => nodeOf(env, Slow).state === 'disposing', 1_000)
  observe(env)
  cleanupGate.resolve()
  await closing
  assert.equal(env.state, 'disposed')
  assert.equal(nodeOf(env, Slow).state, 'disposed')
  observe(env)

  assert.deepEqual([...seen].sort(), [...DECLARED].sort(), 'the observed states are exactly the declared union')
  for (const node of env.inspect().nodes) assert.ok(DECLARED.includes(node.state), `${node.nodeId}: ${node.state}`)

  // The typed event field carries the same vocabulary: the abandoned attempt's dependency is reported with its slot state.
  const abandoned = events.filter(event => event.type === 'attempt-abandoned')
  assert.equal(abandoned.length, 1)
  assert.deepEqual(abandoned[0].dependencies.map(item => item.dependency), ['slow'])
  assert.ok(DECLARED.includes(abandoned[0].dependencies[0].state), abandoned[0].dependencies[0].state)

  // SLOT_NOT_LOADABLE names the closed slot's state with the same vocabulary.
  const closed = await env.deps.slow.load().catch(error => error)
  assert.equal(closed.code, 'SLOT_NOT_LOADABLE')
  assert.ok(['disposing', 'disposed', 'abandoned'].includes(closed.details.state), closed.details.state)
  await runtime.dispose()
})
