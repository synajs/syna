// v0.8 (§2.6, §4 A07): the waiter deadlines of the whole process are kept by one `DeadlineQueue` (docs/ARCHITECTURE.md):
// one timer for the earliest expiry, `ref`ed while a waiter is queued and `unref`ed when the last one leaves. Two
// properties are observable and asserted here. (1) Isolation across Runtimes: a Runtime's waiters expire at their own
// deadlines whatever another Runtime queues, settles or disposes meanwhile. (2) The process exits naturally: a settled
// waiter holds nothing (the process ends as soon as the program does, not when a 10 s deadline would have fired), and
// a pending waiter holds the process exactly until its own deadline.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { createRuntime, definePackage } from '../../dist/index.js'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
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
