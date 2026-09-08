// N5 — the raw setup has already failed and its rollback hangs: the waiter never
// settles, LOAD_TIMEOUT never fires, no event is reported, and a second load()
// hangs with it. No close is involved. Also probes eager activation (enter()).
import { createRuntime, definePackage } from '/Users/weibohan/Workspace/syna-v0.5/packages/core/dist/index.js'

const define = id => definePackage({ name: `@rc4-probe/${id}`, version: '1.0.0', syna: { id: `rc4.${id}` } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const settled = promise => { const state = { value: 'pending' }; promise.then(v => { state.value = `ok:${v}` }, e => { state.value = e?.code ?? String(e?.message ?? e) }); return state }
const show = (label, data) => console.log(`${label}\n    ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join('  ')}`)

async function lazy() {
  const d = define('n5a')
  const Slow = d.service('slow', {
    loadTimeoutMs: 100,
    setup(_deps, { onDispose }) {
      onDispose(() => new Promise(() => undefined))
      return sleep(10).then(() => { throw new Error('setup failed') })
    },
  })
  const Entry = d.entry({ requires: { slow: Slow } })
  const events = []
  const runtime = createRuntime({ services: [Slow], diagnostics: { onEvent: e => events.push(e.type) } })
  const env = await runtime.enter(Entry)
  const first = settled(env.deps.slow.load())
  await sleep(250)
  const second = settled(env.deps.slow.load())
  await sleep(250)
  show('N5a  lazy load(), rollback hangs, Env open', {
    first: first.value, second: second.value, envState: env.state,
    slot: env.inspect().nodes.filter(n => n.kind === 'service').map(n => n.state).join(','),
    ledger: runtime.inspect().unsettledAttempts.length, events: `[${events}]`,
  })
}

async function eager() {
  const d = define('n5b')
  const Eager = d.service('eager', {
    eager: true,
    loadTimeoutMs: 100,
    setup(_deps, { onDispose }) {
      onDispose(() => new Promise(() => undefined))
      return sleep(10).then(() => { throw new Error('eager setup failed') })
    },
  })
  const Entry = d.entry({ requires: { eager: Eager } })
  const events = []
  const runtime = createRuntime({ services: [Eager], limits: { disposalGraceMs: 60 }, diagnostics: { onEvent: e => events.push(e.type) } })
  const started = Date.now()
  const entered = settled(runtime.enter(Entry))
  await sleep(400)
  const elapsed = Date.now() - started
  show('N5b  eager activation, rollback hangs', {
    enter: entered.value, afterMs: elapsed, live: runtime.inspect().liveEnvCount,
    ledger: runtime.inspect().unsettledAttempts.length, events: `[${events}]`,
  })
}

await lazy()
await eager()
process.exit(0)
