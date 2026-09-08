// Root cause A, other surface: onEvent is user code the Runtime calls synchronously.
import { createRuntime, definePackage } from '/Users/weibohan/Workspace/syna-v0.5/packages/core/dist/index.js'
const define = id => definePackage({ name: `@rc4-probe/${id}`, version: '1.0.0', syna: { id: `rc4.${id}` } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const deferred = () => { let resolve; const p = new Promise(s => { resolve = s }); return { promise: p, resolve } }
const show = (label, data) => console.log(`${label}\n    ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join('  ')}`)

const unhandled = []
process.on('unhandledRejection', reason => unhandled.push(String(reason?.message ?? reason)))

/** E1 — onEvent throws while the close reports an abandoned cleanup. */
{
  const d = define('e1')
  const hang = deferred()
  const seen = []
  const S = d.service('s', { setup(_deps, { onDispose }) { onDispose(() => hang.promise); return { ok: true } } })
  const Other = d.service('other', { setup(_deps, { onDispose }) { onDispose(() => { seen.push('other-cleanup') }); return { ok: true } } })
  const E = d.entry({ requires: { s: S, other: Other } })
  const rt = createRuntime({ services: [S, Other], limits: { disposalGraceMs: 40 }, diagnostics: { onEvent: e => { seen.push(e.type); throw new Error('reporting hook threw') } } })
  const env = await rt.enter(E)
  await env.deps.s.load(); await env.deps.other.load()
  const outcome = await env.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}:${e?.errors?.length ?? ''}`)
  await sleep(20)
  show('E1  onEvent throws inside the close', { dispose: outcome, envState: env.state, seen: `[${seen}]`, ledger: rt.inspect().unsettledAttempts.length, live: rt.inspect().liveEnvCount })
  hang.resolve(); await sleep(30)
  show('E1  after the abandoned cleanup ends', { seen: `[${seen}]`, ledger: rt.inspect().unsettledAttempts.length, unhandled: `[${unhandled}]` })
  await rt.dispose().catch(() => undefined)
}
console.log()
/** E2 — onEvent throws in a late reaction, after the close returned. */
{
  const d = define('e2')
  const gate = deferred()
  const seen = []
  const S = d.service('s', { setup(_deps, { onDispose }) { onDispose(() => undefined); return gate.promise } })
  const E = d.entry({ requires: { s: S } })
  const rt = createRuntime({ services: [S], limits: { disposalGraceMs: 20 }, diagnostics: { onEvent: e => { seen.push(e.type); if (e.type === 'attempt-succeeded-late') throw new Error('reporting hook threw late') } } })
  const env = await rt.enter(E)
  void env.deps.s.load().catch(() => undefined)
  await sleep(5)
  await env.dispose().catch(() => undefined)
  gate.resolve({ ok: true })
  await sleep(40)
  show('E2  onEvent throws in the late reaction', { seen: `[${seen}]`, ledger: rt.inspect().unsettledAttempts.length, unhandled: `[${unhandled}]` })
  await rt.dispose().catch(() => undefined)
  await sleep(20)
  show('E2  after runtime.dispose()', { ledger: rt.inspect().unsettledAttempts.length, unhandled: `[${unhandled}]` })
}
process.exit(0)
