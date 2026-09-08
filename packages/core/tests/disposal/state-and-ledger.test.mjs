// v0.7 (Phase E, S2): `env.state` is advanced only by Runtime actions — activating → ready → disposing → disposed —
// and is `disposed` at the end of the bounded close whatever is still outstanding. Attempts the close abandoned are
// recorded in `runtime.inspect().unsettledAttempts` and `env.inspect().abandonedAttempts` until they settle
// (`late-setup-*`) or their setup Promise is collected (`attempt-unreachable`); `dispose()` never rejects because
// user code ignored cancellation (only a cleanup that threw is a close error), `attempt-abandoned` carries the
// dependencies list, and `runtime.dispose()` reports a non-empty ledger once as `runtime-attempts-outstanding`.
// No test here uses `--expose-gc`: the state never depends on garbage collection.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntime, definePackage } from '../../dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '../../dist')
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v07/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })
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
const withoutTiming = entries => entries.map(({ elapsedMs, ...rest }) => (assert.equal(typeof elapsedMs, 'number'), rest))

test('1. a setup that never settles: dispose() fulfils after the grace, the Env is disposed, liveEnvCount drops, the ledger and the Env list the abandoned attempt, attempt-abandoned names the dependencies', async () => {
  const define = makeDefine('s2-never-settles')
  const events = []
  const Dep = define.service('dep', { setup: () => ({ id: 'dep' }) })
  const Stuck = define.service('stuck', { requires: { dep: Dep }, setup: () => new Promise(() => {}) })
  const Entry = define.entry('entry', { requires: { stuck: Stuck, dep: Dep } })
  const runtime = createRuntime({ services: [Dep, Stuck], limits: { disposalGraceMs: 20 }, diagnostics: { onEvent: event => events.push(event) } })
  const env = await runtime.enter(Entry)
  await env.deps.dep.load()
  void env.deps.stuck.load().catch(() => undefined)
  await sleep(5)
  assert.equal(runtime.inspect().liveEnvCount, 1)
  const started = Date.now()
  await env.dispose()
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 15 && elapsed < 1_000, `bounded by the grace (${elapsed} ms)`)
  assert.equal(env.state, 'disposed')
  assert.equal(runtime.inspect().liveEnvCount, 0)
  assert.equal(runtime.inspect().rootEnvCount, 0)
  const stuck = nodeOf(env, Stuck)
  assert.equal(stuck.state, 'abandoned')
  assert.equal(nodeOf(env, Dep).state, 'disposed', 'the dependency was closed in the normal order after the grace')
  const ledger = runtime.inspect().unsettledAttempts
  assert.deepEqual(withoutTiming(ledger), [{ attemptNumber: ledger[0].attemptNumber, slot: stuck.slotId, revision: Stuck.id, env: env.id, state: 'abandoned' }])
  assert.deepEqual(withoutTiming(env.inspect().abandonedAttempts), withoutTiming(ledger), 'the Env lists the attempt its close left behind')
  assert.deepEqual(events.map(event => event.type), ['attempt-abandoned'])
  assert.deepEqual(events[0], {
    type: 'attempt-abandoned',
    phase: 'setup',
    slot: stuck.slotId,
    revision: Stuck.id,
    env: env.id,
    elapsedMs: events[0].elapsedMs,
    dependencies: [{ dependency: 'dep', slot: nodeOf(env, Dep).slotId, revision: Dep.id, state: 'ready' }],
  })
  assert.ok(events[0].elapsedMs >= 15)
  await runtime.dispose()
})

test('2. the state does not depend on the setup Promise: disposed before and after several macrotasks, with the Promise held or released; the ledger keeps the entry until settlement', async () => {
  const define = makeDefine('s2-promise-held')
  let held
  const Held = define.service('held', { setup: () => { held = new Promise(() => {}); return held } })
  const Released = define.service('released', { setup: () => new Promise(() => {}) })
  const Entry = define.entry('entry', { requires: { held: Held, released: Released } })
  const runtime = createRuntime({ services: [Held, Released], limits: { disposalGraceMs: 20 } })
  const env = await runtime.enter(Entry)
  void env.deps.held.load().catch(() => undefined)
  void env.deps.released.load().catch(() => undefined)
  await sleep(5)
  await env.dispose()
  assert.equal(env.state, 'disposed')
  assert.deepEqual(env.inspect().abandonedAttempts.map(item => item.state), ['abandoned', 'abandoned'])
  for (let round = 0; round < 5; round += 1) {
    await sleep(10)
    assert.equal(env.state, 'disposed')
    assert.equal(runtime.inspect().unsettledAttempts.length, 2)
  }
  held = undefined // releasing the reference changes nothing the state could observe
  for (let round = 0; round < 5; round += 1) {
    await sleep(10)
    assert.equal(env.state, 'disposed')
    assert.equal(runtime.inspect().unsettledAttempts.length, 2)
  }
  assert.deepEqual(env.inspect().nodes.filter(node => node.kind === 'service').map(node => node.state), ['abandoned', 'abandoned'])
  await runtime.dispose()
})

test('3. late settlement of an abandoned attempt: the entry leaves the ledger, attempt-succeeded-late reports adopted: false, the cleanup ran, the slot is disposed', async () => {
  const define = makeDefine('s2-late-settlement')
  const gate = deferred()
  const events = []
  const log = []
  const Slow = define.service('slow', {
    async setup(_deps, { onDispose }) {
      onDispose(() => log.push('cleanup'))
      await gate.promise
      return { id: 'slow' }
    },
  })
  const Entry = define.entry('entry', { requires: { slow: Slow } })
  const runtime = createRuntime({ services: [Slow], limits: { disposalGraceMs: 20 }, diagnostics: { onEvent: event => events.push(event) } })
  const env = await runtime.enter(Entry)
  const loading = env.deps.slow.load().catch(error => error)
  await sleep(5)
  await env.dispose()
  assert.equal(env.state, 'disposed')
  assert.equal((await loading).code, 'ENV_CLOSED')
  assert.equal(env.inspect().abandonedAttempts.length, 1)
  assert.deepEqual(log, [])
  gate.resolve()
  await waitFor(() => events.some(event => event.type === 'attempt-succeeded-late'))
  const slot = nodeOf(env, Slow)
  assert.deepEqual(events.map(event => event.type), ['attempt-abandoned', 'attempt-succeeded-late'])
  assert.deepEqual(events[1], { type: 'attempt-succeeded-late', slot: slot.slotId, revision: Slow.id, env: env.id, adopted: false, cleanupErrors: [] })
  assert.deepEqual(log, ['cleanup'])
  assert.equal(slot.state, 'disposed')
  assert.deepEqual(env.inspect().abandonedAttempts, [])
  assert.deepEqual(runtime.inspect().unsettledAttempts, [])
  assert.equal(env.state, 'disposed')
  await runtime.dispose()
  assert.deepEqual(events.map(event => event.type), ['attempt-abandoned', 'attempt-succeeded-late'], 'nothing outstanding: no summary event')
})

test('4. a parent whose child abandoned an attempt: the parent\'s dispose() fulfils, both are disposed, the child lists the attempt and the parent does not', async () => {
  const define = makeDefine('s2-parent-child')
  const gate = deferred()
  const Slow = define.service('slow', { async setup() { await gate.promise; return {} } })
  const Root = define.entry('root', {})
  const Child = define.entry('child', { requires: { slow: Slow } })
  const runtime = createRuntime({ services: [Slow], limits: { disposalGraceMs: 20 } })
  const root = await runtime.enter(Root)
  const child = await root.enter(Child)
  void child.deps.slow.load().catch(() => undefined)
  await sleep(5)
  await root.dispose()
  assert.deepEqual([root.state, child.state], ['disposed', 'disposed'])
  assert.deepEqual([runtime.inspect().rootEnvCount, runtime.inspect().liveEnvCount], [0, 0])
  assert.equal(runtime.inspect().unsettledAttempts.length, 1)
  assert.deepEqual(root.inspect().abandonedAttempts, [], 'a parent does not list its descendants\' attempts')
  assert.deepEqual(child.inspect().abandonedAttempts.map(item => [item.env, item.state]), [[child.id, 'abandoned']])
  gate.resolve()
  await waitFor(() => runtime.inspect().unsettledAttempts.length === 0)
  assert.deepEqual([root.state, child.state], ['disposed', 'disposed'])
  assert.deepEqual(child.inspect().abandonedAttempts, [])
  await runtime.dispose()
})

test('5. runtime.dispose() with a non-empty ledger fulfils and reports runtime-attempts-outstanding once; a cleanup that throws still rejects, without any coded member', async () => {
  const define = makeDefine('s2-runtime-close')
  const events = []
  const Stuck = define.service('stuck', { setup: () => new Promise(() => {}) })
  const Throwing = define.service('throwing', { setup: (_deps, { onDispose }) => { onDispose(() => { throw new Error('cleanup failed') }); return {} } })
  const Entry = define.entry('entry', { requires: { stuck: Stuck, throwing: Throwing } })
  const runtime = createRuntime({ services: [Stuck, Throwing], limits: { disposalGraceMs: 20 }, diagnostics: { onEvent: event => events.push(event) } })
  const env = await runtime.enter(Entry)
  await env.deps.throwing.load()
  void env.deps.stuck.load().catch(() => undefined)
  await sleep(5)
  const error = await runtime.dispose().catch(error => error)
  assert.ok(error instanceof AggregateError, 'the throwing cleanup is the close error')
  const leaves = item => item instanceof AggregateError ? item.errors.flatMap(leaves) : [item]
  assert.deepEqual(leaves(error).map(item => [item.message, item.code]), [['cleanup failed', undefined]], 'no coded member: an abandoned attempt is not an error of the close')
  assert.equal(env.state, 'disposed')
  const summary = events.filter(event => event.type === 'runtime-attempts-outstanding')
  assert.equal(summary.length, 1)
  assert.deepEqual(withoutTiming(summary[0].attempts), withoutTiming(runtime.inspect().unsettledAttempts))
  assert.deepEqual(summary[0].attempts.map(item => [item.env, item.revision, item.state]), [[env.id, Stuck.id, 'abandoned']])
  assert.deepEqual(events.map(event => event.type), ['attempt-abandoned', 'runtime-attempts-outstanding'])
  // A Runtime closes once: a later call returns the same close and reports nothing again.
  assert.strictEqual(await runtime.dispose().catch(item => item), error)
  assert.equal(events.filter(event => event.type === 'runtime-attempts-outstanding').length, 1)

  // Control: a clean ledger and a clean close report nothing and fulfil.
  const control = makeDefine('s2-runtime-close-control')
  const controlEvents = []
  const Fine = control.service('fine', { setup: () => ({}) })
  const ControlEntry = control.entry('entry', { requires: { fine: Fine } })
  const controlRuntime = createRuntime({ services: [Fine], diagnostics: { onEvent: event => controlEvents.push(event) } })
  const controlEnv = await controlRuntime.enter(ControlEntry)
  await controlEnv.deps.fine.load()
  await controlRuntime.dispose()
  assert.deepEqual(controlEvents, [])
  assert.equal(controlEnv.state, 'disposed')
})

test('6. a rollback that outlives the grace: dispose() fulfils, the Env is disposed, the ledger says rolling-back and empties when the rollback ends; the slot ends disposed', async () => {
  const define = makeDefine('s2-rolling-back')
  const rollbackGate = deferred()
  const events = []
  const Failing = define.service('failing', {
    async setup(_deps, { onDispose }) {
      onDispose(async () => { events.push('rollback-start'); await rollbackGate.promise; events.push('rollback-end') })
      throw new Error('setup failed')
    },
  })
  const Entry = define.entry('entry', { requires: { failing: Failing } })
  const runtime = createRuntime({ services: [Failing], limits: { disposalGraceMs: 20 }, diagnostics: { onEvent: event => events.push(event.type === 'attempt-abandoned' ? `attempt-abandoned:${event.phase}` : event.type) } })
  const env = await runtime.enter(Entry)
  const loading = env.deps.failing.load().catch(error => error)
  await waitFor(() => events.includes('rollback-start'))
  await env.dispose()
  assert.equal(env.state, 'disposed')
  assert.ok(events.includes('attempt-abandoned:rollback'))
  assert.deepEqual(runtime.inspect().unsettledAttempts.map(item => [item.env, item.state]), [[env.id, 'rolling-back']])
  assert.deepEqual(env.inspect().abandonedAttempts.map(item => item.state), ['rolling-back'])
  assert.equal(nodeOf(env, Failing).state, 'abandoned')
  rollbackGate.resolve()
  await waitFor(() => runtime.inspect().unsettledAttempts.length === 0)
  assert.ok(events.includes('rollback-end'))
  assert.equal(nodeOf(env, Failing).state, 'disposed')
  assert.deepEqual(env.inspect().abandonedAttempts, [])
  assert.equal((await loading).message, 'setup failed')
  assert.equal(env.state, 'disposed')
  await runtime.dispose()
})

test('7. run() fulfils with the callback\'s result when the only thing the close left behind is an abandoned attempt', async () => {
  const define = makeDefine('s2-run-result')
  const Stuck = define.service('stuck', { setup: () => new Promise(() => {}) })
  const Entry = define.entry('entry', { requires: { stuck: Stuck } })
  const runtime = createRuntime({ services: [Stuck], limits: { disposalGraceMs: 20 } })
  const result = await runtime.run(Entry, async deps => {
    void deps.stuck.load().catch(() => undefined)
    await sleep(5)
    return 'business result'
  })
  assert.equal(result, 'business result')
  assert.deepEqual(runtime.inspect().unsettledAttempts.map(item => item.state), ['abandoned'])
  assert.equal(runtime.inspect().liveEnvCount, 0)
  await runtime.dispose()
})

test('8. the public surface: the unsettled-attempt code left SynaErrorCode (26 members), env.inspect() of an open Env has abandonedAttempts: [], and the state union is unchanged', async () => {
  const errors = readFileSync(path.join(dist, 'errors.d.ts'), 'utf8')
  assert.equal(errors.includes('UNSETTLED_ATTEMPT'), false) // syna-v05-compat
  const union = errors.slice(errors.indexOf('export type SynaErrorCode ='), errors.indexOf('export type DiagnosticCode'))
  assert.equal([...union.matchAll(/'[A-Z_]+'/g)].length, 26)
  const descriptors = readFileSync(path.join(dist, 'descriptors.d.ts'), 'utf8')
  assert.match(descriptors, /readonly abandonedAttempts: readonly UnsettledAttemptInspection\[\];/)
  assert.match(descriptors, /readonly type: 'runtime-attempts-outstanding';\s*readonly attempts: readonly UnsettledAttemptInspection\[\];/)
  assert.match(descriptors, /readonly type: 'attempt-abandoned';[\s\S]*?readonly dependencies: readonly \{/)
  assert.match(descriptors, /export type EnvState = 'activating' \| 'ready' \| 'disposing' \| 'disposed';/)
  const define = makeDefine('s2-surface')
  const Fine = define.service('fine', { setup: () => ({}) })
  const Entry = define.entry('entry', { requires: { fine: Fine } })
  const runtime = createRuntime({ services: [Fine] })
  const env = await runtime.enter(Entry)
  assert.deepEqual(env.inspect().abandonedAttempts, [])
  assert.deepEqual(Object.keys(env.inspect()).sort(), ['abandonedAttempts', 'id', 'nodes', 'state'])
  await env.dispose()
  assert.equal(env.state, 'disposed')
  assert.deepEqual(env.inspect().abandonedAttempts, [])
  await runtime.dispose()
})
