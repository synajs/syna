// v0.8 (§2.6, §4 A07): the waiter deadlines of the whole process are kept by one `DeadlineQueue` (docs/ARCHITECTURE.md):
// one timer for the earliest expiry, `ref`ed while a waiter is queued and `unref`ed when the last one leaves. Two
// properties are observable and asserted here. (1) Isolation across Runtimes: a Runtime's waiters expire at their own
// deadlines whatever another Runtime queues, settles or disposes meanwhile. (2) The process exits naturally: a settled
// waiter holds nothing (the process ends as soon as the program does, not when a 10 s deadline would have fired), and
// a pending waiter holds the process exactly until its own deadline. (3) Re-arming: a waiter that is armed again — which
// is what every waiter of a slot gets when a new attempt starts — is the same waiter moved to its new place, never a
// second one, so the queue is genuinely empty once the last waiter leaves and the timer stops holding the process
// (the fix after 1.0.0-rc.5: `unlink` did not take the waiter out of the count, so a re-armed waiter left the count
// above zero for ever and the timer stayed `ref`ed until it fired).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { createRuntime, definePackage } from '../../dist/index.js'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
const QUEUE = fileURLToPath(new URL('../../dist/internal/deadline-queue.js', import.meta.url))
const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v08/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const child = (flags, script) =>
  run(process.execPath, [...flags, '--input-type=module', '-e', script])
    .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))

/** A Runtime with one Service whose setup resolves after `resolveAfterMs` (never, by default) under `loadTimeoutMs`. */
const world = (id, { loadTimeoutMs, resolveAfterMs = Infinity, disposalGraceMs = 20 }) => {
  const define = makeDefine(id)
  const Service = define.service('service', {
    setup: () => resolveAfterMs === Infinity ? new Promise(() => {}) : sleep(resolveAfterMs).then(() => ({ id })),
  })
  const Entry = define.entry('entry', { requires: { service: Service } })
  const runtime = createRuntime({ services: [Service], limits: { loadTimeoutMs, disposalGraceMs } })
  return { Service, Entry, runtime }
}
const timed = async promise => {
  const started = performance.now()
  const outcome = await promise.then(value => ({ value }), error => ({ error }))
  return { ...outcome, elapsed: performance.now() - started }
}

test('isolation: two Runtimes queue waiters with different deadlines; each expires at its own, the earlier one first', async () => {
  const early = world('dq-early', { loadTimeoutMs: 60 })
  const late = world('dq-late', { loadTimeoutMs: 220 })
  try {
    const lateEnv = await late.runtime.enter(late.Entry)
    const earlyEnv = await early.runtime.enter(early.Entry)
    // The later deadline is queued first; the earlier one arrives afterwards and must fire first.
    const lateWait = timed(lateEnv.deps.service.load())
    const earlyWait = timed(earlyEnv.deps.service.load())
    const first = await earlyWait
    assert.equal(first.error?.code, 'LOAD_TIMEOUT', 'the earlier deadline fired')
    assert.ok(first.elapsed >= 55 && first.elapsed < 200, `early waiter at ${first.elapsed} ms`)
    assert.equal(late.runtime.inspect().unsettledAttempts.length, 0, 'the other Runtime has no overdue attempt yet')
    assert.equal(early.runtime.inspect().unsettledAttempts.map(item => item.state).join(), 'overdue')
    const second = await lateWait
    assert.equal(second.error?.code, 'LOAD_TIMEOUT')
    assert.ok(second.elapsed >= 215 && second.elapsed < 1_000, `late waiter at ${second.elapsed} ms`)
    assert.equal(second.error.details.deadlineMs, 220)
    assert.equal(first.error.details.deadlineMs, 60)
  }
  finally {
    await early.runtime.dispose()
    await late.runtime.dispose()
  }
})

test('isolation: disposing one Runtime while its waiter is queued leaves the other Runtime\'s waiter armed; a waiter that settles leaves the others untouched', async () => {
  const doomed = world('dq-doomed', { loadTimeoutMs: 5_000 })
  const kept = world('dq-kept', { loadTimeoutMs: 150 })
  const quick = world('dq-quick', { loadTimeoutMs: 5_000, resolveAfterMs: 20 })
  try {
    const doomedEnv = await doomed.runtime.enter(doomed.Entry)
    const keptEnv = await kept.runtime.enter(kept.Entry)
    const quickEnv = await quick.runtime.enter(quick.Entry)
    // Three waiters: a 5 s deadline that will be abandoned by a close, a 150 ms one, and a 5 s one that settles at 20 ms.
    const doomedWait = timed(doomedEnv.deps.service.load())
    const keptWait = timed(keptEnv.deps.service.load())
    const quickWait = timed(quickEnv.deps.service.load())
    assert.deepEqual((await quickWait).value, { id: 'dq-quick' }, 'the settled waiter got its instance')
    await sleep(10)
    // The close of the first Runtime abandons its attempt (grace 20 ms) and takes its waiter out of the queue.
    await doomed.runtime.dispose()
    const doomedOutcome = await doomedWait
    assert.equal(doomedOutcome.error?.code, 'ENV_CLOSED', 'the abandoned waiter is refused by the close, not timed out')
    assert.ok(doomedOutcome.elapsed < 1_000)
    // The kept Runtime's waiter still expires at its own 150 ms deadline.
    const keptOutcome = await keptWait
    assert.equal(keptOutcome.error?.code, 'LOAD_TIMEOUT')
    assert.ok(keptOutcome.elapsed >= 145 && keptOutcome.elapsed < 1_000, `kept waiter at ${keptOutcome.elapsed} ms`)
    assert.equal(keptOutcome.error.details.deadlineMs, 150)
    assert.deepEqual(kept.runtime.inspect().unsettledAttempts.map(item => [item.env, item.state]), [[keptEnv.id, 'overdue']])
    assert.equal(quick.runtime.inspect().unsettledAttempts.length, 0)
  }
  finally {
    await kept.runtime.dispose()
    await quick.runtime.dispose()
  }
})

test('the process exits naturally: a settled waiter under a 10 s deadline holds nothing, with or without runtime.dispose()', async () => {
  for (const dispose of [true, false]) {
    const script = `
      import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
      const define = definePackage({ name: '@v08/dq-exit', version: '1.0.0', syna: { id: 'dq-exit' } })
      const Service = define.service('service', { setup: () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 30)) })
      const Entry = define.entry('entry', { requires: { service: Service } })
      const runtime = createRuntime({ services: [Service], limits: { loadTimeoutMs: 10_000 } })
      const env = await runtime.enter(Entry)
      const instance = await env.deps.service.load()
      ${dispose ? 'await runtime.dispose()' : ''}
      console.log(JSON.stringify({ instance, state: env.state }))
    `
    const started = performance.now()
    const result = await child(['--unhandled-rejections=strict'], script)
    const elapsed = performance.now() - started
    assert.equal(result.code, 0, `child failed:\n${result.stderr}`)
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), { instance: { ok: true }, state: dispose ? 'disposed' : 'ready' })
    assert.ok(elapsed < 5_000, `the process ended after ${Math.round(elapsed)} ms (dispose: ${dispose}); a 10 s deadline must not hold it`)
  }
})

test('the process exits naturally: a pending waiter holds the process exactly until its own deadline, then it ends', async () => {
  const script = `
    import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
    const define = definePackage({ name: '@v08/dq-hold', version: '1.0.0', syna: { id: 'dq-hold' } })
    const Service = define.service('service', { setup: () => new Promise(() => {}) })
    const Entry = define.entry('entry', { requires: { service: Service } })
    const runtime = createRuntime({ services: [Service], limits: { loadTimeoutMs: 300 } })
    const env = await runtime.enter(Entry)
    const started = performance.now()
    env.deps.service.load().catch(error => console.log(JSON.stringify({ code: error.code, waited: Math.round(performance.now() - started) })))
    // No await: the program is over; only the queued deadline keeps the process alive.
  `
  const started = performance.now()
  const result = await child(['--unhandled-rejections=strict'], script)
  const elapsed = performance.now() - started
  assert.equal(result.code, 0, `child failed:\n${result.stderr}`)
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.equal(out.code, 'LOAD_TIMEOUT', 'the deadline fired before the process ended')
  assert.ok(out.waited >= 295, `waited ${out.waited} ms`)
  assert.ok(elapsed >= 295 && elapsed < 5_000, `the process ended after ${Math.round(elapsed)} ms`)
})

test('re-arming a queued waiter moves it: the list keeps one entry per waiter in expiry order, and the queue is empty — timer included — once they leave', async () => {
  // The queue itself is process-wide and private, so the case drives it through `Waiters` (its only caller) in a child
  // process and reads two things back: the list, walked through the waiters' own `prev`/`next` links, and the count,
  // which is observable exactly where it matters — an empty queue must not hold the process. The deadlines are long
  // enough (10 s and up) that nothing fires; if the count is wrong the child lives until one of them does.
  const script = `
    import { Waiters } from ${JSON.stringify(QUEUE)}
    const waiters = new Waiters(10_000, () => {}, { registerOverdue: () => {} })
    const attempt = { id: 1, state: 'running', startedAt: Date.now(), rawSettled: false, overdueAt: undefined, pendingLoads: new Map() }
    const slotFor = timeout => ({ id: 'slot-' + timeout, ownerEnvId: 'env-1', waiters: new Set(), attempt, service: { key: 's@1.0.0', loadTimeoutMs: timeout } })
    const make = id => ({ id, slot: slotFor(0), attempt: undefined, deadlineMs: 0, expiresAt: 0, queued: false, prev: undefined, next: undefined, onDeadline: () => {}, settle: () => {} })
    const list = waiter => {
      let head = waiter
      while (head.prev !== undefined) head = head.prev
      const ids = []
      for (let node = head; node !== undefined; node = node.next) ids.push(node.id)
      return ids
    }
    const [one, two, three] = [make(1), make(2), make(3)]
    waiters.arm(one, slotFor(10_000), attempt)
    waiters.arm(two, slotFor(20_000), attempt)
    waiters.arm(three, slotFor(30_000), attempt)
    const armed = list(one)
    waiters.arm(one, slotFor(40_000), attempt)
    const moved = list(one)
    for (let round = 0; round < 4; round += 1) waiters.arm(one, slotFor(40_000), attempt)
    const reArmed = list(one)
    const held = process.getActiveResourcesInfo().filter(name => name === 'Timeout').length
    for (const waiter of [one, two, three]) waiters.disarm(waiter)
    const detached = [one, two, three].map(waiter => ({ queued: waiter.queued, unlinked: waiter.prev === undefined && waiter.next === undefined }))
    console.log(JSON.stringify({ armed, moved, reArmed, held, detached, after: process.getActiveResourcesInfo().filter(name => name === 'Timeout').length }))
    // No await and nothing else pending: an empty queue must let the process end here.
  `
  const started = performance.now()
  const result = await child(['--unhandled-rejections=strict'], script)
  const elapsed = performance.now() - started
  assert.equal(result.code, 0, `child failed:\n${result.stderr}`)
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.deepEqual(out.armed, [1, 2, 3], 'three waiters, in expiry order')
  assert.deepEqual(out.moved, [2, 3, 1], 'the re-armed waiter moved to its new place and left no copy behind')
  assert.deepEqual(out.reArmed, [2, 3, 1], 'four more re-arms of the same waiter are still one entry')
  assert.equal(out.held, 1, 'while waiters are queued the timer holds the process')
  assert.deepEqual(out.detached, [
    { queued: false, unlinked: true },
    { queued: false, unlinked: true },
    { queued: false, unlinked: true },
  ], 'every waiter left the list')
  assert.equal(out.after, 0, 'the last waiter to leave takes the process-holding timer with it')
  assert.ok(elapsed < 3_000, `the process ended after ${Math.round(elapsed)} ms; an empty queue holds nothing`)
})

test('a cycle of setups that start each other\'s load() without awaiting it: every load succeeds and the process ends with the program, not at loadTimeoutMs', async () => {
  // Both slots start an attempt while the other's waiters are already queued, so every one of them is armed a second
  // time (`materializer.ts` re-arms each waiter of a slot when a new attempt starts). Nothing here is overdue and
  // nothing times out; what the case holds is that the process is free the moment the last wait ends.
  const script = `
    import { createRuntime, definePackage, forward } from ${JSON.stringify(DIST)}
    const define = definePackage({ name: '@v08/dq-cycle', version: '1.0.0', syna: { id: 'dq-cycle' } })
    let A, B
    A = define.service('a', { requires: { b: forward(() => B) }, async setup({ b }) { void b.load().catch(() => undefined); return { id: 'a' } } })
    B = define.service('b', { requires: { a: forward(() => A) }, async setup({ a }) { void a.load().catch(() => undefined); return { id: 'b' } } })
    const Entry = define.entry('entry', { requires: { a: A, b: B } })
    const runtime = createRuntime({ services: [A, B], limits: { loadTimeoutMs: 3_000 } })
    const env = await runtime.enter(Entry)
    const loaded = await Promise.all([env.deps.a.load(), env.deps.b.load()])
    await env.dispose()
    await runtime.dispose()
    console.log(JSON.stringify({
      loaded: loaded.map(instance => instance.id),
      state: env.state,
      unsettled: runtime.inspect().unsettledAttempts.length,
      holding: process.getActiveResourcesInfo().filter(name => name === 'Timeout').length,
    }))
  `
  const started = performance.now()
  const result = await child(['--unhandled-rejections=strict'], script)
  const elapsed = performance.now() - started
  assert.equal(result.code, 0, `child failed:\n${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), { loaded: ['a', 'b'], state: 'disposed', unsettled: 0, holding: 0 })
  assert.ok(elapsed < 1_500, `the process ended after ${Math.round(elapsed)} ms; nothing was waiting, so the 3 s deadline must not have held it`)
})
