// N4 — which of the four "something outlives the close" paths still retain the closed Env graph.
// Run with --expose-gc. Each case: 1 MB unrelated Input in the closed Env, WeakRef on the Env and
// on the payload, plus a control Env that has nothing outstanding.
import { createRuntime, definePackage } from '/Users/weibohan/Workspace/syna-v0.5/packages/core/dist/index.js'

if (typeof globalThis.gc !== 'function') throw new Error('run with --expose-gc')
const define = id => definePackage({ name: `@rc4-probe/${id}`, version: '1.0.0', syna: { id: `rc4.${id}` } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const deferred = () => { let resolve, reject; const promise = new Promise((s, j) => { resolve = s; reject = j }); return { promise, resolve, reject } }
const collect = async () => { for (let i = 0; i < 8; i += 1) { globalThis.gc(); await sleep(20) } }
const show = (label, data) => console.log(`${label}\n    ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join('  ')}`)

/**
 * `make` returns { runtime, env, release } — `env` is closed and something of it is
 * outstanding; `release` ends it. Failures are strings, never Errors: an Error's
 * structured stack keeps the receiver of every frame.
 */
async function retention(id, make) {
  const { rt, envs, release, note } = await make()
  const refs = envs.map(env => ({ env: new WeakRef(env), payload: new WeakRef(env.deps.payload.read()) }))
  const ledger = rt.inspect().unsettledAttempts.map(a => a.state)
  envs.length = 0
  await collect()
  const alive = refs.map(r => `env=${r.env.deref() !== undefined} payload=${r.payload.deref() !== undefined}`)
  show(`${id}  while it is outstanding`, { subject: alive[0], control: alive[1], ledger: `[${ledger}]`, note: note ?? '' })
  await release()
  await sleep(30)
  await collect()
  const after = refs.map(r => `env=${r.env.deref() !== undefined} payload=${r.payload.deref() !== undefined}`)
  show(`${id}  after it ended`, { subject: after[0], ledger: `[${rt.inspect().unsettledAttempts.map(a => a.state)}]` })
  await rt.dispose().catch(() => undefined)
  console.log()
}

const payload = () => ({ marker: new Uint8Array(1 << 20) })

/** P1 — setup pending (the L3 path, fixed in rc.3). */
await retention('P1 setup pending      ', async () => {
  const d = define('p1')
  const Payload = d.input('payload')
  const hold = []
  const Pending = d.service('pending', { setup(_deps, { onDispose }) { onDispose(() => undefined); return new Promise(r => { hold.push(r) }) } })
  const Quiet = d.service('quiet', { setup() { return { ok: true } } })
  const Root = d.entry('root', {})
  const Sub = d.entry('sub', { requires: { pending: Pending, payload: Payload }, parameters: { payload: Payload } })
  const Ctl = d.entry('ctl', { requires: { quiet: Quiet, payload: Payload }, parameters: { payload: Payload } })
  const rt = createRuntime({ services: [Pending, Quiet], limits: { disposalGraceMs: 20 } })
  const root = await rt.enter(Root)
  const env = await root.enter(Sub, { payload: payload() })
  void env.deps.pending.load().catch(() => undefined)
  await sleep(5)
  await env.dispose().catch(() => undefined)
  const ctl = await root.enter(Ctl, { payload: payload() })
  await ctl.deps.quiet.load(); await ctl.dispose()
  return { rt, envs: [env, ctl], release: async () => { for (const r of hold) r({}) } }
})

/** P2 — rollback pending: the setup FAILED (determined) and its cleanup hangs. */
await retention('P2 rollback pending   ', async () => {
  const d = define('p2')
  const Payload = d.input('payload')
  const hang = deferred()
  const gate = deferred()
  const Failing = d.service('failing', { failure: { attempts: 1 }, setup(_deps, { onDispose }) { onDispose(() => hang.promise); return gate.promise } })
  const Quiet = d.service('quiet', { setup() { return { ok: true } } })
  const Root = d.entry('root', {})
  const Sub = d.entry('sub', { requires: { failing: Failing, payload: Payload }, parameters: { payload: Payload } })
  const Ctl = d.entry('ctl', { requires: { quiet: Quiet, payload: Payload }, parameters: { payload: Payload } })
  const rt = createRuntime({ services: [Failing, Quiet], limits: { disposalGraceMs: 20 } })
  const root = await rt.enter(Root)
  const env = await root.enter(Sub, { payload: payload() })
  void env.deps.failing.load().catch(() => undefined)
  await sleep(5)
  gate.reject('setup failed')          // a string, not an Error: no stack frames retained
  await sleep(5)
  await env.dispose().catch(() => undefined)
  const ctl = await root.enter(Ctl, { payload: payload() })
  await ctl.deps.quiet.load(); await ctl.dispose()
  return { rt, envs: [env, ctl], release: async () => hang.resolve() }
})

/** P3 — Ready-slot cleanup pending (the rc.3 L1 abandonment path). */
await retention('P3 ready cleanup      ', async () => {
  const d = define('p3')
  const Payload = d.input('payload')
  const hang = deferred()
  const Hanging = d.service('hanging', { setup(_deps, { onDispose }) { onDispose(() => hang.promise); return { ok: true } } })
  const Quiet = d.service('quiet', { setup() { return { ok: true } } })
  const Root = d.entry('root', {})
  const Sub = d.entry('sub', { requires: { hanging: Hanging, payload: Payload }, parameters: { payload: Payload } })
  const Ctl = d.entry('ctl', { requires: { quiet: Quiet, payload: Payload }, parameters: { payload: Payload } })
  const rt = createRuntime({ services: [Hanging, Quiet], limits: { disposalGraceMs: 20 } })
  const root = await rt.enter(Root)
  const env = await root.enter(Sub, { payload: payload() })
  await env.deps.hanging.load()
  await env.dispose().catch(() => undefined)
  const ctl = await root.enter(Ctl, { payload: payload() })
  await ctl.deps.quiet.load(); await ctl.dispose()
  return { rt, envs: [env, ctl], release: async () => hang.resolve() }
})

/** P4 — late-settlement cleanup pending: the attempt settles after the close, its cleanup hangs. */
await retention('P4 late cleanup       ', async () => {
  const d = define('p4')
  const Payload = d.input('payload')
  const hang = deferred()
  const gate = deferred()
  const Late = d.service('late', { setup(_deps, { onDispose }) { onDispose(() => hang.promise); return gate.promise } })
  const Quiet = d.service('quiet', { setup() { return { ok: true } } })
  const Root = d.entry('root', {})
  const Sub = d.entry('sub', { requires: { late: Late, payload: Payload }, parameters: { payload: Payload } })
  const Ctl = d.entry('ctl', { requires: { quiet: Quiet, payload: Payload }, parameters: { payload: Payload } })
  const rt = createRuntime({ services: [Late, Quiet], limits: { disposalGraceMs: 20 } })
  const root = await rt.enter(Root)
  const env = await root.enter(Sub, { payload: payload() })
  void env.deps.late.load().catch(() => undefined)
  await sleep(5)
  await env.dispose().catch(() => undefined)   // abandons the attempt (setup still pending)
  const ctl = await root.enter(Ctl, { payload: payload() })
  await ctl.deps.quiet.load(); await ctl.dispose()
  gate.resolve({ ok: true })                    // it settles late → closeUnsettled → runCleanups hangs
  await sleep(30)
  return { rt, envs: [env, ctl], release: async () => hang.resolve(), note: 'attempt settled late, its cleanup hangs' }
})
