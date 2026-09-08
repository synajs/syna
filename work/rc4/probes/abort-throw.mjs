// Root cause A, the格 I had not tested: an abort listener that throws.
import { createRuntime, definePackage } from '/Users/weibohan/Workspace/syna-v0.5/packages/core/dist/index.js'
const d = definePackage({ name: '@rc4-probe/abortthrow', version: '1.0.0', syna: { id: 'rc4.abortthrow' } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const uncaught = []
process.on('uncaughtException', error => uncaught.push(String(error.message)))

let child, grandchild
const Thrower = d.service('thrower', { setup(_deps, { signal }) {
  signal.addEventListener('abort', () => { throw new Error('listener threw') }, { once: true })
  return { ok: true }
} })
const Quiet = d.service('quiet', { setup(_deps, { onDispose }) { onDispose(() => undefined); return { ok: true } } })
const Root = d.entry('root', { requires: { thrower: Thrower } })
const Child = d.entry('child', { requires: { quiet: Quiet } })
const Grand = d.entry('grand', { requires: { quiet: Quiet } })
const rt = createRuntime({ services: [Thrower, Quiet], limits: { disposalGraceMs: 40 } })
const root = await rt.enter(Root)
child = await root.enter(Child)
grandchild = await child.enter(Grand)
await root.deps.thrower.load(); await child.deps.quiet.load(); await grandchild.deps.quiet.load()
const outcome = await root.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}`)
await sleep(30)
console.log(`dispose=${outcome}  root=${root.state}  child=${child.state}  grandchild=${grandchild.state}  live=${rt.inspect().liveEnvCount}  uncaught=[${uncaught}]`)
process.exit(0)
