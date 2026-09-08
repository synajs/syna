// v0.7 (Phase C, S7): the 0.6 "invalid Env state" code, thrown from 16 sites with six meanings, is split into
// ENV_CLOSED ({ env, state } | { env, state, slot, revision }), RUNTIME_CLOSED ({}), SLOT_NOT_LOADABLE
// ({ slot, revision, state }) and LIFECYCLE_MISUSE ({ slot, revision, attempt, state }); the four sites no caller
// can reach (plan consistency, owner assignment, attempts >= 1, single-flight recovery) are internal invariants
// without a public code. Trigger conditions and messages are the 0.6 ones. Every reachable site is exercised
// here with every details key asserted; the site numbers are those of work/v07/PROPOSAL.md §5.1.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntime, definePackage, isSynaError } from '../../dist/index.js'

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
const rejection = async promise => {
  try { await promise }
  catch (error) { return error }
  assert.fail('expected a rejection')
}
const slotOf = (env, revision) => env.inspect().nodes.find(node => node.nodeId === `service:${revision.id}`).slotId

const expectClosed = (error, message, details) => {
  assert.ok(isSynaError(error), `expected a SynaError, got ${error?.stack ?? error}`)
  assert.equal(error.code, 'ENV_CLOSED')
  assert.equal(error.message, message)
  assert.deepEqual(error.details, details)
  assert.ok(Object.isFrozen(error.details))
}

test('site 3 RUNTIME_CLOSED: every entry point of a disposed Runtime, details {}', async () => {
  const define = makeDefine('s7-runtime-closed')
  const Root = define.entry('root', {})
  const runtime = createRuntime({ services: [] })
  await runtime.dispose()
  const calls = [
    runtime.enter(Root),
    runtime.run(Root, () => assert.fail('the callback never runs')),
    runtime.check(Root),
    runtime.explain(Root),
  ]
  for (const call of calls) {
    const error = await rejection(call)
    assert.ok(isSynaError(error))
    assert.equal(error.code, 'RUNTIME_CLOSED')
    assert.equal(error.message, 'The Syna Runtime is disposed.')
    assert.deepEqual(error.details, {})
    assert.ok(Object.isFrozen(error.details))
  }
})

test('site 4 ENV_CLOSED { env, state }: enter / run / check / explain / derive from a disposing and from a disposed Env', async () => {
  const define = makeDefine('s7-env-closed')
  const gate = deferred()
  const Held = define.service('held', { setup: (_deps, { onDispose }) => { onDispose(() => gate.promise); return {} } })
  const Root = define.entry('root', { requires: { held: Held } })
  const Child = define.entry('child', {})
  const runtime = createRuntime({ services: [Held] })
  const root = await runtime.enter(Root)
  await root.deps.held.load()
  const calls = env => [
    env.enter(Child),
    env.run(Child, () => assert.fail('the callback never runs')),
    env.check(Child),
    env.explain(Child),
    env.derive({}),
  ]
  const disposing = root.dispose()
  assert.equal(root.state, 'disposing')
  for (const call of calls(root)) {
    expectClosed(await rejection(call), `Cannot enter from Env ${root.id} while it is disposing.`, { env: root.id, state: 'disposing' })
  }
  gate.resolve()
  await disposing
  assert.equal(root.state, 'disposed')
  for (const call of calls(root)) {
    expectClosed(await rejection(call), `Cannot enter from Env ${root.id} while it is disposed.`, { env: root.id, state: 'disposed' })
  }
  await runtime.dispose()
})

test('site 1 ENV_CLOSED { env, state }: an Env closed while activating fails its enter() with ENTRY_ACTIVATION_FAILED whose cause is the refusal', async () => {
  const define = makeDefine('s7-closed-while-activating')
  const Lazy = define.service('lazy', { setup: () => ({}) })
  const Root = define.entry('root', {})
  const Child = define.entry('child', { requires: { lazy: Lazy } })
  const runtime = createRuntime({ services: [Lazy] })
  const root = await runtime.enter(Root)
  // The child is in the tree as soon as enter() is called; the parent closes it before its activation completes.
  const entering = root.enter(Child)
  const disposing = root.dispose()
  const failure = await rejection(entering)
  assert.ok(isSynaError(failure))
  assert.equal(failure.code, 'ENTRY_ACTIVATION_FAILED')
  assert.equal(failure.details.entry, Child.id)
  assert.equal(failure.details.causeCode, 'ENV_CLOSED')
  const cause = failure.cause
  assert.ok(isSynaError(cause))
  assert.equal(cause.code, 'ENV_CLOSED')
  assert.equal(cause.message, `Env ${failure.details.env} was closed before activation completed.`)
  assert.deepEqual(Object.keys(cause.details).sort(), ['env', 'state'])
  assert.equal(cause.details.env, failure.details.env)
  assert.ok(['disposing', 'disposed'].includes(cause.details.state), cause.details.state)
  assert.deepEqual(failure.details.causeDetails, cause.details)
  await disposing
  assert.equal(runtime.inspect().liveEnvCount, 0)
  await runtime.dispose()
})

test('site 2 ENV_CLOSED { env, state }: an anchored Entry whose anchor Env is gone', async () => {
  const define = makeDefine('s7-anchor-gone')
  const Root = define.entry('root', {})
  const Child = define.entry('child', {})
  const runtime = createRuntime({ services: [] })
  const root = await runtime.enter(Root)
  const anchored = root.anchor(Child)
  assert.equal((await anchored.enter()).inspect().parentId, root.id)
  await root.dispose()
  const calls = [
    anchored.enter(),
    anchored.run(() => assert.fail('the callback never runs')),
    anchored.check(),
    anchored.explain(),
  ]
  for (const call of calls) {
    expectClosed(await rejection(call), `Env ${root.id} is no longer live.`, { env: root.id, state: 'disposed' })
  }
  await runtime.dispose()
})

test('site 6 SLOT_NOT_LOADABLE { slot, revision, state }: load() on a disposed, a disposing and an abandoned slot', async () => {
  const define = makeDefine('s7-slot-not-loadable')
  // disposed: a dormant slot whose owner closed.
  {
    let starts = 0
    const Lazy = define.service('lazy', { setup() { starts += 1; return {} } })
    const Root = define.entry('root', { requires: { lazy: Lazy } })
    const runtime = createRuntime({ services: [Lazy] })
    const env = await runtime.enter(Root)
    const slot = slotOf(env, Lazy)
    const ref = env.deps.lazy
    await env.dispose()
    const error = await rejection(ref.load())
    assert.equal(error.code, 'SLOT_NOT_LOADABLE')
    assert.equal(error.message, `Service slot ${slot} (${Lazy.id}) is disposed.`)
    assert.deepEqual(error.details, { slot, revision: Lazy.id, state: 'disposed' })
    assert.equal(starts, 0)
    await runtime.dispose()
  }
  // disposing: a Ready slot whose cleanup is running.
  {
    const gate = deferred()
    const started = deferred()
    const Held = define.service('held', { setup: (_deps, { onDispose }) => { onDispose(() => { started.resolve(); return gate.promise }); return {} } })
    const Root = define.entry('root-held', { requires: { held: Held } })
    const runtime = createRuntime({ services: [Held] })
    const env = await runtime.enter(Root)
    await env.deps.held.load()
    const slot = slotOf(env, Held)
    const disposing = env.dispose()
    await started.promise
    const error = await rejection(env.deps.held.load())
    assert.equal(error.code, 'SLOT_NOT_LOADABLE')
    assert.equal(error.message, `Service slot ${slot} (${Held.id}) is disposing.`)
    assert.deepEqual(error.details, { slot, revision: Held.id, state: 'disposing' })
    gate.resolve()
    await disposing
    await runtime.dispose()
  }
  // abandoned: a timed-out attempt that never settled before its owner's close finished.
  {
    const Stuck = define.service('stuck', { setup: () => new Promise(() => undefined) })
    const Root = define.entry('root-stuck', { requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], limits: { loadTimeoutMs: 20, disposalGraceMs: 20 } })
    const env = await runtime.enter(Root)
    const slot = slotOf(env, Stuck)
    assert.equal((await rejection(env.deps.stuck.load())).code, 'LOAD_TIMEOUT')
    await env.dispose() // the attempt that ignores cancellation is abandoned onto the ledger (S2)
    const error = await rejection(env.deps.stuck.load())
    assert.equal(error.code, 'SLOT_NOT_LOADABLE')
    assert.equal(error.message, `Service slot ${slot} (${Stuck.id}) is abandoned.`)
    assert.deepEqual(error.details, { slot, revision: Stuck.id, state: 'abandoned' })
    await runtime.dispose()
  }
})

test('site 9 LIFECYCLE_MISUSE { slot, revision, attempt, state }: onDispose() on a lifecycle whose attempt succeeded or failed', async () => {
  const define = makeDefine('s7-lifecycle-misuse')
  const message = revision => `onDispose() for ${revision.id} may only be called while its setup attempt is still executing.`
  {
    let stale
    const Svc = define.service('svc', { setup(_deps, lifecycle) { stale = lifecycle; return {} } })
    const Root = define.entry('root', { requires: { svc: Svc } })
    const runtime = createRuntime({ services: [Svc] })
    const env = await runtime.enter(Root)
    await env.deps.svc.load()
    assert.throws(() => stale.onDispose(() => undefined), error => {
      assert.ok(isSynaError(error))
      assert.equal(error.code, 'LIFECYCLE_MISUSE')
      assert.equal(error.message, message(Svc))
      assert.deepEqual(error.details, { slot: slotOf(env, Svc), revision: Svc.id, attemptNumber: 1, state: 'succeeded' })
      return true
    })
    // A lifecycle is only stale after the attempt settled: a cleanup registered during setup runs.
    await runtime.dispose()
  }
  {
    let stale
    const Broken = define.service('broken', { failure: { attempts: 1 }, setup(_deps, lifecycle) { stale = lifecycle; throw new Error('boom') } })
    const Root = define.entry('root-broken', { requires: { broken: Broken } })
    const runtime = createRuntime({ services: [Broken] })
    const env = await runtime.enter(Root)
    assert.equal((await rejection(env.deps.broken.load())).message, 'boom')
    assert.throws(() => stale.onDispose(() => undefined), error => {
      assert.equal(error.code, 'LIFECYCLE_MISUSE')
      assert.equal(error.message, message(Broken))
      assert.deepEqual(error.details, { slot: slotOf(env, Broken), revision: Broken.id, attemptNumber: 1, state: 'failed' })
      return true
    })
    await runtime.dispose()
  }
})

test('site 11 ENV_CLOSED { env, state, slot, revision }: a setup still pending when its owner closed', async () => {
  const define = makeDefine('s7-pending-at-close')
  const Stuck = define.service('stuck', { setup: () => new Promise(() => undefined) })
  const Root = define.entry('root', { requires: { stuck: Stuck } })
  const runtime = createRuntime({ services: [Stuck], limits: { disposalGraceMs: 20 } })
  const env = await runtime.enter(Root)
  const slot = slotOf(env, Stuck)
  const loading = env.deps.stuck.load().catch(error => error)
  await sleep(5)
  await env.dispose()
  expectClosed(
    await loading,
    `Setup of ${Stuck.id} was still pending when owner Env ${env.id} closed; its eventual result will be discarded.`,
    { env: env.id, state: 'disposing', slot, revision: Stuck.id },
  )
  await runtime.dispose()
})

test('site 12 ENV_CLOSED { env, state, slot, revision }: a setup that completed after its owner began closing is discarded and cleaned up', async () => {
  const define = makeDefine('s7-completed-after-close')
  const gate = deferred()
  const started = deferred()
  const events = []
  const Slow = define.service('slow', {
    async setup(_deps, { onDispose }) {
      onDispose(() => { events.push('cleanup') })
      started.resolve()
      await gate.promise
      return { late: true }
    },
  })
  const Root = define.entry('root', { requires: { slow: Slow } })
  const runtime = createRuntime({ services: [Slow] })
  const env = await runtime.enter(Root)
  const slot = slotOf(env, Slow)
  const loading = env.deps.slow.load().catch(error => error)
  await started.promise
  const disposing = env.dispose()
  gate.resolve()
  await disposing
  expectClosed(
    await loading,
    `Setup of ${Slow.id} completed after owner Env ${env.id} began closing; the instance was discarded.`,
    { env: env.id, state: 'disposing', slot, revision: Slow.id },
  )
  assert.deepEqual(events, ['cleanup'])
  await runtime.dispose()
})

test('sites 13/14 ENV_CLOSED { env, state, slot, revision }: materialize and recover under a closing owner', async () => {
  const define = makeDefine('s7-owner-closing')
  const gate = deferred()
  const started = deferred()
  const Held = define.service('held', { setup: (_deps, { onDispose }) => { onDispose(() => { started.resolve(); return gate.promise }); return {} } })
  let lazyStarts = 0
  const Lazy = define.service('lazy', { setup() { lazyStarts += 1; return {} } })
  const Broken = define.service('broken', {
    failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 0 },
    setup() { throw new Error('boom') },
  })
  const Root = define.entry('root', { requires: { held: Held, lazy: Lazy, broken: Broken } })
  const runtime = createRuntime({ services: [Held, Lazy, Broken] })
  const root = await runtime.enter(Root)
  await root.deps.held.load()
  assert.equal((await rejection(root.deps.broken.load())).message, 'boom')
  const disposing = root.dispose()
  await started.promise
  expectClosed(
    await rejection(root.deps.lazy.load()),
    `Cannot materialize ${Lazy.id}: owner Env ${root.id} is closing.`,
    { env: root.id, state: 'disposing', slot: slotOf(root, Lazy), revision: Lazy.id },
  )
  expectClosed(
    await rejection(root.deps.broken.load()),
    `Cannot recover ${Broken.id}: owner Env ${root.id} is closing.`,
    { env: root.id, state: 'disposing', slot: slotOf(root, Broken), revision: Broken.id },
  )
  assert.equal(lazyStarts, 0)
  gate.resolve()
  await disposing
  await runtime.dispose()
})

test('site 15 ENV_CLOSED { env, state, slot, revision }: a retry backoff cancelled by the owner\'s close', async () => {
  const define = makeDefine('s7-retry-cancelled')
  let attempts = 0
  const Flaky = define.service('flaky', { failure: { attempts: 5, delayMs: 400 }, setup() { attempts += 1; throw new Error('transient') } })
  const Root = define.entry('root', { requires: { flaky: Flaky } })
  const runtime = createRuntime({ services: [Flaky] })
  const env = await runtime.enter(Root)
  const slot = slotOf(env, Flaky)
  const loading = env.deps.flaky.load().catch(error => error)
  await waitFor(() => attempts >= 1)
  await sleep(20) // inside the backoff
  const started = Date.now()
  await env.dispose()
  assert.ok(Date.now() - started < 300, 'the backoff was cancelled by the close')
  expectClosed(
    await loading,
    `Retry of ${Flaky.id} was cancelled because owner Env ${env.id} is closing.`,
    { env: env.id, state: 'disposing', slot, revision: Flaky.id },
  )
  assert.equal(attempts, 1)
  await runtime.dispose()
})

test('site 16 ENV_CLOSED { env, state, slot, revision }: a recovery cooldown cancelled by the owner\'s close', async () => {
  const define = makeDefine('s7-recovery-cancelled')
  let attempts = 0
  const Broken = define.service('broken', {
    failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 400 },
    setup() { attempts += 1; throw new Error('boom') },
  })
  const Root = define.entry('root', { requires: { broken: Broken } })
  const runtime = createRuntime({ services: [Broken] })
  const env = await runtime.enter(Root)
  const slot = slotOf(env, Broken)
  assert.equal((await rejection(env.deps.broken.load())).message, 'boom')
  const recovering = env.deps.broken.load().catch(error => error)
  await sleep(10) // inside the cooldown
  const started = Date.now()
  await env.dispose()
  assert.ok(Date.now() - started < 300, 'the cooldown was cancelled by the close')
  expectClosed(
    await recovering,
    `Recovery of ${Broken.id} was cancelled because owner Env ${env.id} is closing.`,
    { env: env.id, state: 'disposing', slot, revision: Broken.id },
  )
  assert.equal(attempts, 1)
  await runtime.dispose()
})

test('the four codes are declared and the compiled sources spell neither the 0.6 code nor an ENV_CLOSED details without env and state', () => {
  const files = [
    ...readdirSync(dist).filter(name => name.endsWith('.js') || name.endsWith('.d.ts')).map(name => path.join(dist, name)),
    ...readdirSync(path.join(dist, 'internal')).filter(name => name.endsWith('.js') || name.endsWith('.d.ts')).map(name => path.join(dist, 'internal', name)),
  ]
  assert.ok(files.length > 10)
  let closedSites = 0
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    assert.ok(!source.includes('INVALID_ENV_STATE'), `${path.basename(file)} still spells the 0.6 code`) // syna-v05-compat
    closedSites += [...source.matchAll(/new SynaError\('ENV_CLOSED'/g)].length
  }
  // Sites 1, 2, 4 in runtime.js and the helper `closedError` (sites 6/11/12/13-16 go through it) in abort.js.
  assert.equal(closedSites, 4)
  const codes = readFileSync(path.join(dist, 'errors.d.ts'), 'utf8')
  for (const code of ['ENV_CLOSED', 'LIFECYCLE_MISUSE', 'RUNTIME_CLOSED', 'SLOT_NOT_LOADABLE']) assert.match(codes, new RegExp(`'${code}'`))
  const internal = readFileSync(path.join(dist, 'internal/materializer.js'), 'utf8') + readFileSync(path.join(dist, 'runtime.js'), 'utf8')
  // Three from S7 (Q7) plus the recovery-path guard of S2: an unsettled attempt always belongs to an abandoned slot,
  // which refuses load() with SLOT_NOT_LOADABLE, so the former error code of that guard has no site. The fourth S7 site
  // ("exhausted setup attempts") went with 1.0.0-rc.4's sequence driver: the attempts are chained by reaction rather
  // than by a `for` loop, so there is no loop end that the attempt count could fall out of.
  assert.equal([...internal.matchAll(/Syna internal invariant: /g)].length, 4, 'the four unreachable sites are internal invariants (Q7)')
})
