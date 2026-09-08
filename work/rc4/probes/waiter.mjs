// N1d follow-on: what ends the wait of a load() whose slot is stuck in an abandoned rollback?
import { createRuntime, definePackage } from '/Users/weibohan/Workspace/syna-v0.5/packages/core/dist/index.js'
const d = definePackage({ name: '@rc4-probe/waiter', version: '1.0.0', syna: { id: 'rc4.waiter' } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const deferred = () => { let resolve, reject; const p = new Promise((s, j) => { resolve = s; reject = j }); return { promise: p, resolve, reject } }

const gate = deferred()
const S = d.service('s', { failure: { attempts: 1 }, setup(_deps, { onDispose }) {
  onDispose(() => new Promise(() => undefined))   // never settles
  return gate.promise
} })
const E = d.entry({ requires: { s: S } })
const events = []
const rt = createRuntime({ services: [S], limits: { disposalGraceMs: 15, loadTimeoutMs: 120 }, diagnostics: { onEvent: e => events.push(`${e.type}${e.phase ? ':' + e.phase : ''}`) } })
const env = await rt.enter(E)
const t0 = Date.now()
let waiter = 'pending'
void env.deps.s.load().then(() => { waiter = 'resolved' }, e => { waiter = `${e?.code ?? e?.name} @${Date.now() - t0}ms` })
await sleep(5)
gate.reject(new Error('setup failed'))
await sleep(5)
const disposed = await env.dispose().then(() => `fulfilled @${Date.now() - t0}ms`, e => `rejected @${Date.now() - t0}ms`)
console.log(`dispose: ${disposed}  envState=${env.state}  waiter=${waiter}  events=[${events}]`)
await sleep(300)
console.log(`300 ms later: waiter=${waiter}  ledger=[${rt.inspect().unsettledAttempts.map(a => a.state)}]  events=[${events}]`)
process.exit(0)
