// Further dimensions of the same two root causes.
import { createRuntime, definePackage } from '/Users/weibohan/Workspace/syna-v0.5/packages/core/dist/index.js'
const define = id => definePackage({ name: `@rc4-probe/${id}`, version: '1.0.0', syna: { id: `rc4.${id}` } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const deferred = () => { let resolve; const p = new Promise(s => { resolve = s }); return { promise: p, resolve } }
const show = (label, data) => console.log(`${label}\n    ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join('  ')}`)

/** N2d — a diagnostics onEvent handler re-enters dispose() while the close runs. */
async function n2d() {
  const d = define('n2d')
  const hang = deferred()
  const seen = []
  let rt, env, inner = 'not-called'
  const S = d.service('s', { setup(_deps, { onDispose }) { onDispose(() => hang.promise); return { ok: true } } })
  const E = d.entry({ requires: { s: S } })
  rt = createRuntime({ services: [S], limits: { disposalGraceMs: 60 }, diagnostics: { onEvent: e => {
    seen.push(e.type)
    if (e.type === 'attempt-abandoned' && inner === 'not-called') inner = env.dispose().then(() => 'fulfilled', x => `rejected:${x?.name}`)
  } } })
  env = await rt.enter(E)
  await env.deps.s.load()
  const t0 = Date.now()
  const outer = await env.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}`)
  show('N2d  onEvent re-enters dispose() during the close', { outer, ms: Date.now() - t0, inner: typeof inner === 'string' ? inner : await Promise.race([inner, sleep(300).then(() => 'still-pending')]), events: `[${seen}]` })
  hang.resolve(); await sleep(20); await rt.dispose().catch(() => undefined)
}

/** N2e — a cleanup function awaits its own Env's dispose(): bounded, or deadlock? */
async function n2e() {
  const d = define('n2e')
  let cleanupOutcome = 'pending'
  const S = d.service('s', { setup(_deps, { onDispose }) {
    onDispose(async () => { await env.dispose(); cleanupOutcome = 'returned' })
    return { ok: true }
  } })
  const E = d.entry({ requires: { s: S } })
  const rt = createRuntime({ services: [S], limits: { disposalGraceMs: 60 } })
  const env = await rt.enter(E)
  await env.deps.s.load()
  const t0 = Date.now()
  const outer = await Promise.race([env.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}`), sleep(800).then(() => 'STILL-PENDING (deadlock)')])
  await sleep(30)
  show('N2e  a cleanup awaits its own dispose()', { outer, ms: Date.now() - t0, cleanup: cleanupOutcome, envState: env.state })
  await rt.dispose().catch(() => undefined)
}

/** N3c — the setup started from the parent's abort listener hangs: the close pays a grace it did not plan for. */
async function n3c() {
  const d = define('n3c')
  const grace = 80
  const Dormant = d.service('dormant', { setup() { return new Promise(() => undefined) } })
  const Watcher = d.service('watcher', { setup(_deps, { signal }) {
    signal.addEventListener('abort', () => { void child.deps.dormant.load().catch(() => undefined) }, { once: true })
    return { ok: true }
  } })
  const Root = d.entry('root', { requires: { watcher: Watcher } })
  const Child = d.entry('child', { requires: { dormant: Dormant } })
  const rt = createRuntime({ services: [Watcher, Dormant], limits: { disposalGraceMs: grace } })
  const root = await rt.enter(Root)
  const child = await root.enter(Child)
  await root.deps.watcher.load()
  const t0 = Date.now()
  await root.dispose().catch(() => undefined)
  const withListener = Date.now() - t0

  // Control: the same tree, no listener starting anything.
  const d2 = define('n3c-ctl')
  const Dormant2 = d2.service('dormant', { setup() { return new Promise(() => undefined) } })
  const Quiet = d2.service('quiet', { setup() { return { ok: true } } })
  const Root2 = d2.entry('root', { requires: { quiet: Quiet } })
  const Child2 = d2.entry('child', { requires: { dormant: Dormant2 } })
  const rt2 = createRuntime({ services: [Quiet, Dormant2], limits: { disposalGraceMs: grace } })
  const root2 = await rt2.enter(Root2)
  await root2.enter(Child2)
  await root2.deps.quiet.load()
  const t1 = Date.now()
  await root2.dispose().catch(() => undefined)
  const control = Date.now() - t1
  show('N3c  close time with vs without the listener-started setup', { graceMs: grace, withListener: `${withListener} ms`, control: `${control} ms`, ledger: rt.inspect().unsettledAttempts.length })
  await rt.dispose().catch(() => undefined); await rt2.dispose().catch(() => undefined)
}

/** N3d — during runtime.dispose(), the first root's listener starts work in a second, not-yet-marked root. */
async function n3d() {
  const d = define('n3d')
  let stateAtAbort = 'n/a', setups = 0, outcome = 'not-started'
  const Dormant = d.service('dormant', { setup() { setups += 1; return { ok: true } } })
  const Watcher = d.service('watcher', { setup(_deps, { signal }) {
    signal.addEventListener('abort', () => {
      stateAtAbort = second.state
      outcome = 'started'
      void second.deps.dormant.load().then(() => { outcome = 'resolved' }, e => { outcome = e?.code ?? 'error' })
    }, { once: true })
    return { ok: true }
  } })
  const First = d.entry('first', { requires: { watcher: Watcher } })
  const Second = d.entry('second', { requires: { dormant: Dormant } })
  const rt = createRuntime({ services: [Watcher, Dormant], limits: { disposalGraceMs: 60 } })
  const first = await rt.enter(First)
  const second = await rt.enter(Second)
  await first.deps.watcher.load()
  await rt.dispose().catch(() => undefined)
  await sleep(30)
  show('N3d  runtime.dispose(): the first root starts work in the second', { secondStateAtAbort: stateAtAbort, dormantSetups: setups, load: outcome, live: rt.inspect().liveEnvCount })
}

for (const p of [n2d, n2e, n3c, n3d]) { await p(); console.log() }
process.exit(0)
