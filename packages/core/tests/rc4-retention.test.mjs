// 1.0.0-rc.4 / N4 — nothing the Runtime keeps outlives a closed Env.
//
// §13: "An attempt on the ledger … holds nothing of the Env it belonged to: not
// the Env, not its plan, not its Input payloads, not its sibling slots." rc.3
// established that for the one path where the raw setup Promise is still pending.
// Three more things can outlive a close — the rollback of a failed attempt, the
// cleanup phase of a Ready slot, and the late close of an attempt that settled
// afterwards — and two of them still kept the whole graph alive
// (work/rc4/BASELINE.md §4), because an `async` frame suspended on a cleanup keeps
// `slot` and `owner` in its register file whether or not the code after the await
// still mentions them. That is invisible to review: only `WeakRef` + `--expose-gc`
// can decide it, which is why every case below runs in a child process.
//
// Every case carries a control Env that has nothing outstanding — it is what shows
// the method can see a collection at all — and a positive control shows that an Env
// the user still holds is of course retained.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const child = script =>
  run(process.execPath, ['--expose-gc', '--unhandled-rejections=strict', '--input-type=module', '-e', script])
    .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))

/**
 * The scaffolding every case shares: a subject Env with one Service and a 1 MB
 * Input payload nothing depends on, a control Env with neither, eight collections
 * across macrotasks, then the reachability of both and of the payload.
 *
 * The subject's failures are strings, never Errors: an Error's structured stack
 * keeps the receiver of every frame it was created in until someone reads `.stack`,
 * which would make the measurement say more about V8 than about Syna.
 */
const scenario = body => `
  import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
  const define = definePackage({ name: '@rc4/retention', version: '1.0.0', syna: { id: 'rc4.retention' } })
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const deferred = () => { let resolve; const promise = new Promise(settle => { resolve = settle }); return { promise, resolve } }
  const collect = async () => { for (let round = 0; round < 8; round += 1) { globalThis.gc(); await sleep(20) } }
  const payload = () => ({ marker: new Uint8Array(1 << 20) })
  const hang = deferred()
  const gate = deferred()
  const Payload = define.input('payload')
  const Quiet = define.service('quiet', { setup() { return { ok: true } } })
  const Root = define.entry('root', {})
  const Control = define.entry('control', { requires: { quiet: Quiet, payload: Payload }, parameters: { payload: Payload } })
  ${body}
  const runtime = createRuntime({ services: [Subject, Quiet], limits: { disposalGraceMs: 20 } })
  const root = await runtime.enter(Root)
  let subject = await root.enter(Sub, { payload: payload() })
  await arrange(subject)
  let control = await root.enter(Control, { payload: payload() })
  await control.deps.quiet.load()
  await control.dispose()

  const subjectRef = new WeakRef(subject)
  const payloadRef = new WeakRef(subject.deps.payload.read())
  const controlRef = new WeakRef(control)
  const ledger = runtime.inspect().unsettledAttempts.map(entry => entry.state)
  const held = hold ? subject : undefined            // the positive control keeps its Env
  subject = undefined
  control = undefined
  await collect()
  const reachability = {
    subject: subjectRef.deref() !== undefined,
    payload: payloadRef.deref() !== undefined,
    control: controlRef.deref() !== undefined,
  }
  // Release everything the case left outstanding, in order: a late raw settlement
  // first (a no-op where it already settled), then the cleanup that was hanging.
  gate.resolve({ late: true })
  await sleep(20)
  hang.resolve()
  await sleep(40)
  await collect()
  console.log(JSON.stringify({
    ledger,
    reachability,
    after: { subject: subjectRef.deref() !== undefined, payload: payloadRef.deref() !== undefined },
    ledgerAfter: runtime.inspect().unsettledAttempts.length,
    heldIsTheSameEnv: held === undefined ? null : held === subjectRef.deref(),
  }))
  await runtime.dispose().catch(() => undefined)
`

const CASES = [
  {
    id: 'P1 the raw setup is still pending',
    ledger: ['abandoned'],
    body: `
      const hold = false
      const Subject = define.service('subject', {
        loadTimeoutMs: 30, setup(_deps, { onDispose }) { onDispose(() => hang.promise); return gate.promise },
      })
      const Sub = define.entry('sub', { requires: { subject: Subject, payload: Payload }, parameters: { payload: Payload } })
      const arrange = async env => {
        void env.deps.subject.load().catch(() => undefined)
        await sleep(5)
        await env.dispose().catch(() => undefined)
      }`,
  },
  {
    id: 'P2 the rollback of a failed setup is still running',
    ledger: ['rolling-back'],
    body: `
      const hold = false
      const Subject = define.service('subject', {
        failure: { attempts: 1 }, loadTimeoutMs: 30,
        setup(_deps, { onDispose }) { onDispose(() => hang.promise); return gate.promise },
      })
      const Sub = define.entry('sub', { requires: { subject: Subject, payload: Payload }, parameters: { payload: Payload } })
      const arrange = async env => {
        void env.deps.subject.load().catch(() => undefined)
        await sleep(5)
        gate.resolve(Promise.reject('setup failed'))
        await sleep(5)
        await env.dispose().catch(() => undefined)
      }`,
  },
  {
    id: 'P3 the cleanup phase of a Ready slot is still running',
    ledger: ['abandoned'],
    body: `
      const hold = false
      const Subject = define.service('subject', { setup(_deps, { onDispose }) { onDispose(() => hang.promise); return { ok: true } } })
      const Sub = define.entry('sub', { requires: { subject: Subject, payload: Payload }, parameters: { payload: Payload } })
      const arrange = async env => {
        await env.deps.subject.load()
        await env.dispose().catch(() => undefined)
      }`,
  },
  {
    id: 'P4 the late close of an attempt that settled after the close is still running',
    ledger: ['settling'],
    body: `
      const hold = false
      const Subject = define.service('subject', {
        loadTimeoutMs: 30, setup(_deps, { onDispose }) { onDispose(() => hang.promise); return gate.promise },
      })
      const Sub = define.entry('sub', { requires: { subject: Subject, payload: Payload }, parameters: { payload: Payload } })
      const arrange = async env => {
        void env.deps.subject.load().catch(() => undefined)
        await sleep(5)
        await env.dispose().catch(() => undefined)
        gate.resolve({ late: true })
        await sleep(30)
      }`,
  },
]

for (const item of CASES) {
  test(`N4 ${item.id}: the closed Env, its Input payload and the control are all collected while it runs`, async () => {
    const result = await child(scenario(item.body))
    assert.equal(result.code, 0, result.stderr)
    const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
    assert.deepEqual(out.ledger, item.ledger, 'the ledger says honestly what is still outstanding')
    assert.equal(out.reachability.control, false, 'the control Env is collected: the measurement can see a collection')
    assert.equal(out.reachability.subject, false, 'the closed Env is unreachable while its cleanup is still pending')
    assert.equal(out.reachability.payload, false, 'and so is the Input payload nothing else refers to')
    assert.equal(out.ledgerAfter, 0, 'the ledger empties when the outstanding work ends')
  })
}

test('N4 positive control: an Env the user still holds is retained, payload and all — the difference is the framework\'s, not the collector\'s', async () => {
  const result = await child(scenario(`
    const hold = true
    const Subject = define.service('subject', {
      failure: { attempts: 1 }, loadTimeoutMs: 30,
      setup(_deps, { onDispose }) { onDispose(() => hang.promise); return gate.promise },
    })
    const Sub = define.entry('sub', { requires: { subject: Subject, payload: Payload }, parameters: { payload: Payload } })
    const arrange = async env => {
      void env.deps.subject.load().catch(() => undefined)
      await sleep(5)
      gate.resolve(Promise.reject('setup failed'))
      await sleep(5)
      await env.dispose().catch(() => undefined)
    }`))
  assert.equal(result.code, 0, result.stderr)
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.deepEqual(out.ledger, ['rolling-back'])
  assert.equal(out.reachability.control, false, 'the control Env is still collected')
  assert.equal(out.reachability.subject, true, 'the Env the user kept is retained — by the user')
  assert.equal(out.reachability.payload, true, 'and so is its payload, reachable through that Env')
  assert.equal(out.heldIsTheSameEnv, true)
})

test('N4 after runtime.dispose(): the same four paths keep nothing either', async () => {
  const result = await child(`
    import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
    const define = definePackage({ name: '@rc4/retention-runtime', version: '1.0.0', syna: { id: 'rc4.retention.runtime' } })
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const collect = async () => { for (let round = 0; round < 8; round += 1) { globalThis.gc(); await sleep(20) } }
    const hangs = []
    const Rollback = define.service('rollback', {
      failure: { attempts: 1 }, loadTimeoutMs: 30,
      setup(_deps, { onDispose }) { onDispose(() => new Promise(resolve => hangs.push(resolve))); return Promise.reject('setup failed') },
    })
    const Ready = define.service('ready', { setup(_deps, { onDispose }) { onDispose(() => new Promise(resolve => hangs.push(resolve))); return { ok: true } } })
    const Payload = define.input('payload')
    const Entry = define.entry('entry', { requires: { rollback: Rollback, ready: Ready, payload: Payload }, parameters: { payload: Payload } })
    const runtime = createRuntime({ services: [Rollback, Ready], limits: { disposalGraceMs: 20 } })
    let env = await runtime.enter(Entry, { payload: { marker: new Uint8Array(1 << 20) } })
    void env.deps.rollback.load().catch(() => undefined)
    await env.deps.ready.load()
    await sleep(10)
    const envRef = new WeakRef(env)
    const payloadRef = new WeakRef(env.deps.payload.read())
    await runtime.dispose().catch(() => undefined)
    const ledger = runtime.inspect().unsettledAttempts.map(entry => entry.state).sort()
    env = undefined
    await collect()
    console.log(JSON.stringify({ ledger, env: envRef.deref() !== undefined, payload: payloadRef.deref() !== undefined }))
    for (const resolve of hangs) resolve()
  `)
  assert.equal(result.code, 0, result.stderr)
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.deepEqual(out.ledger, ['abandoned', 'rolling-back'], 'both kinds of outstanding work are listed')
  assert.equal(out.env, false, 'the Env is collected after runtime.dispose() too')
  assert.equal(out.payload, false)
})
