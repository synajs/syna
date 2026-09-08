// Same shape, but the Env is NEVER closed: does the load() deadline still apply?
import { createRuntime, definePackage } from '/Users/weibohan/Workspace/syna-v0.5/packages/core/dist/index.js'
const d = definePackage({ name: '@rc4-probe/waiter2', version: '1.0.0', syna: { id: 'rc4.waiter2' } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const deferred = () => { let resolve, reject; const p = new Promise((s, j) => { resolve = s; reject = j }); return { promise: p, resolve, reject } }

const gate = deferred()
const S = d.service('s', { failure: { attempts: 1 }, setup(_deps, { onDispose }) {
  onDispose(() => new Promise(() => undefined))
  return gate.promise
} })
const E = d.entry({ requires: { s: S } })
const events = []
const rt = createRuntime({ services: [S], limits: { disposalGraceMs: 2_000, loadTimeoutMs: 100 }, diagnostics: { onEvent: e => events.push(e.type) } })
const env = await rt.enter(E)
const t0 = Date.now()
let waiter = 'pending'
void env.deps.s.load().then(() => { waiter = 'resolved' }, e => { waiter = `${e?.code ?? e?.name} @${Date.now() - t0}ms` })
await sleep(10)
gate.reject(new Error('setup failed'))     // determined failure; the rollback hangs
await sleep(500)
console.log(`loadTimeoutMs=100, the Env is open: waiter=${waiter} after ${Date.now() - t0} ms; envState=${env.state}; slot=${env.inspect().nodes.map(n => n.state)}; events=[${events}]`)
let second = 'pending'
void env.deps.s.load().then(() => { second = 'resolved' }, e => { second = e?.code ?? e?.name })
await sleep(300)
console.log(`a second load() while the rollback hangs: ${second}`)
process.exit(0)
