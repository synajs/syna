// N2, second consequence: with two close flows, which one gets the cleanup error?
import { createRuntime, definePackage } from '/Users/weibohan/Workspace/syna-v0.5/packages/core/dist/index.js'
const d = definePackage({ name: '@rc4-probe/n2err', version: '1.0.0', syna: { id: 'rc4.n2err' } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let env, inner = 'not-called'
const S = d.service('s', { setup(_deps, { onDispose, signal }) {
  signal.addEventListener('abort', () => { inner = env.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}(${e?.errors?.length ?? 0})`) }, { once: true })
  onDispose(() => { throw new Error('cleanup failed during the close') })
  return { ok: true }
} })
const E = d.entry({ requires: { s: S } })
const events = []
const rt = createRuntime({ services: [S], limits: { disposalGraceMs: 100 }, diagnostics: { onEvent: e => events.push(e.type) } })
env = await rt.enter(E)
await env.deps.s.load()
const outer = await env.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}(${e?.errors?.length ?? 0})`)
await sleep(50)
console.log(`the caller's dispose(): ${outer}`)
console.log(`the flow nobody awaits: ${typeof inner === 'string' ? inner : await inner}`)
console.log(`events=[${events}]  ledger=${rt.inspect().unsettledAttempts.length}  envState=${env.state}`)
process.exit(0)
