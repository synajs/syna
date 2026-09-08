// N2/N3 — user code runs synchronously inside broadcastClosing()'s abort(), before
// the close has established its own invariants.
import { createRuntime, definePackage } from '/Users/weibohan/Workspace/syna-v0.5/packages/core/dist/index.js'

const define = id => definePackage({ name: `@rc4-probe/${id}`, version: '1.0.0', syna: { id: `rc4.${id}` } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const deferred = () => { let resolve; const promise = new Promise(s => { resolve = s }); return { promise, resolve } }
const show = (label, data) => console.log(`${label}\n    ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join('  ')}`)

/** N2a — an abort listener registered on the lifecycle signal re-enters env.dispose(). */
async function n2a() {
  const d = define('n2a')
  const events = []
  const hang = deferred()
  let cleanupCalls = 0
  let inner = 'not-called'
  const S = d.service('s', { setup(_deps, { onDispose, signal }) {
    signal.addEventListener('abort', () => { inner = env.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}`) }, { once: true })
    onDispose(() => { cleanupCalls += 1; return hang.promise })
    return { ok: true }
  } })
  const E = d.entry({ requires: { s: S } })
  const rt = createRuntime({ services: [S], limits: { disposalGraceMs: 500 }, diagnostics: { onEvent: e => events.push(`${e.type}${e.phase ? ':' + e.phase : ''}`) } })
  const env = await rt.enter(E)
  await env.deps.s.load()
  const t0 = Date.now()
  const outer = await env.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}`)
  show('N2a  abort listener re-enters dispose()', {
    outer, afterMs: Date.now() - t0, envState: env.state, live: rt.inspect().liveEnvCount,
    cleanupCalls, stillHanging: cleanupCalls === 1, events: `[${events}]`, ledger: rt.inspect().unsettledAttempts.length,
  })
  const innerOutcome = await Promise.race([inner, sleep(1200).then(() => 'still-pending')])
  show('N2a  the second flow', { inner: innerOutcome, events: `[${events}]`, elapsedMs: Date.now() - t0 })
  hang.resolve(); await sleep(20)
  await rt.dispose().catch(() => undefined)
}

/** N2b — the same re-entrancy at the Runtime level: a listener calls runtime.dispose(). */
async function n2b() {
  const d = define('n2b')
  const events = []
  const hang = deferred()
  let cleanupCalls = 0
  let inner = 'not-called'
  const S = d.service('s', { setup(_deps, { onDispose, signal }) {
    signal.addEventListener('abort', () => { inner = rt.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}`) }, { once: true })
    onDispose(() => { cleanupCalls += 1; return hang.promise })
    return { ok: true }
  } })
  const E = d.entry({ requires: { s: S } })
  const rt = createRuntime({ services: [S], limits: { disposalGraceMs: 400 }, diagnostics: { onEvent: e => events.push(`${e.type}${e.phase ? ':' + e.phase : ''}`) } })
  const env = await rt.enter(E)
  await env.deps.s.load()
  const t0 = Date.now()
  const outer = await rt.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}`)
  show('N2b  abort listener re-enters runtime.dispose()', {
    outer, afterMs: Date.now() - t0, envState: env.state, live: rt.inspect().liveEnvCount, cleanupCalls, events: `[${events}]`,
  })
  const innerOutcome = await Promise.race([inner, sleep(1000).then(() => 'still-pending')])
  show('N2b  the second flow', { inner: innerOutcome, elapsedMs: Date.now() - t0, events: `[${events}]` })
  hang.resolve(); await sleep(20)
}

/** N2c — a listener on a CHILD re-enters child.dispose() while the parent is closing. */
async function n2c() {
  const d = define('n2c')
  const events = []
  const hang = deferred()
  let cleanupCalls = 0
  let inner = 'not-called'
  const S = d.service('s', { setup(_deps, { onDispose, signal }) {
    signal.addEventListener('abort', () => { inner = child.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}`) }, { once: true })
    onDispose(() => { cleanupCalls += 1; return hang.promise })
    return { ok: true }
  } })
  const Root = d.entry('root', {})
  const Child = d.entry('child', { requires: { s: S } })
  const rt = createRuntime({ services: [S], limits: { disposalGraceMs: 300 }, diagnostics: { onEvent: e => events.push(`${e.type}${e.phase ? ':' + e.phase : ''}`) } })
  const root = await rt.enter(Root)
  const child = await root.enter(Child)
  await child.deps.s.load()
  const t0 = Date.now()
  const outer = await root.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}`)
  show('N2c  child listener re-enters child.dispose() during the parent close', {
    outerRoot: outer, afterMs: Date.now() - t0, childState: child.state, rootState: root.state, cleanupCalls, events: `[${events}]`,
  })
  hang.resolve(); await sleep(20)
  await rt.dispose().catch(() => undefined)
}

/** N3a — the parent's abort listener sees the child still `ready` and starts a dormant service in it. */
async function n3a() {
  const d = define('n3a')
  const events = []
  let childStateAtParentAbort = 'n/a'
  let dormantSetups = 0
  let childLoad = 'not-started'
  const Dormant = d.service('dormant', { setup(_deps, { onDispose }) { dormantSetups += 1; onDispose(() => undefined); return { ok: true } } })
  const Watcher = d.service('watcher', { setup(_deps, { signal }) {
    signal.addEventListener('abort', () => {
      childStateAtParentAbort = child.state
      childLoad = 'started'
      void child.deps.dormant.load().then(() => { childLoad = 'resolved' }, e => { childLoad = e?.code ?? 'error' })
    }, { once: true })
    return { ok: true }
  } })
  const Root = d.entry('root', { requires: { watcher: Watcher } })
  const Child = d.entry('child', { requires: { dormant: Dormant } })
  const rt = createRuntime({ services: [Watcher, Dormant], limits: { disposalGraceMs: 100 }, diagnostics: { onEvent: e => events.push(e.type) } })
  const root = await rt.enter(Root)
  const child = await root.enter(Child)
  await root.deps.watcher.load()
  const outcome = await root.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}`)
  await sleep(30)
  show('N3a  parent abort starts a dormant service in a not-yet-marked child', {
    dispose: outcome, childStateAtParentAbort, dormantSetupsAfterClose: dormantSetups, childLoad,
    childState: child.state, live: rt.inspect().liveEnvCount, events: `[${events}]`,
  })
  await rt.dispose().catch(() => undefined)
}

/** N3b — the parent's abort listener enters a NEW Env under the not-yet-marked child. */
async function n3b() {
  const d = define('n3b')
  let entered = 'not-tried'
  let grandchild
  const Quiet = d.service('quiet', { setup(_deps, { onDispose }) { onDispose(() => undefined); return { ok: true } } })
  const Watcher = d.service('watcher', { setup(_deps, { signal }) {
    signal.addEventListener('abort', () => {
      entered = 'pending'
      void child.enter(Grand).then(env => { grandchild = env; entered = 'entered' }, e => { entered = e?.code ?? 'error' })
    }, { once: true })
    return { ok: true }
  } })
  const Root = d.entry('root', { requires: { watcher: Watcher } })
  const Child = d.entry('child', {})
  const Grand = d.entry('grand', { requires: { quiet: Quiet } })
  const rt = createRuntime({ services: [Watcher, Quiet], limits: { disposalGraceMs: 100 } })
  const root = await rt.enter(Root)
  const child = await root.enter(Child)
  await root.deps.watcher.load()
  const outcome = await root.dispose().then(() => 'fulfilled', e => `rejected:${e?.name}`)
  await sleep(50)
  show('N3b  parent abort enters a new Env under a not-yet-marked child', {
    dispose: outcome, entered, grandchildState: grandchild?.state ?? 'none',
    live: rt.inspect().liveEnvCount, roots: rt.inspect().rootEnvCount,
  })
  await rt.dispose().catch(() => undefined)
}

for (const probe of [n2a, n2b, n2c, n3a, n3b]) { await probe(); console.log() }
