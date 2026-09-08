// N1 — a cleanup that has already failed is hidden by a later cleanup that hangs.
// Four call sites of runCleanups() are candidates; these probe three of them.
import { createRuntime, definePackage } from '/Users/weibohan/Workspace/syna-v0.5/packages/core/dist/index.js'

const define = id => definePackage({ name: `@rc4-probe/${id}`, version: '1.0.0', syna: { id: `rc4.${id}` } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const deferred = () => { let resolve, reject; const promise = new Promise((s, j) => { resolve = s; reject = j }); return { promise, resolve, reject } }
const GRACE = 15

const show = (label, data) => console.log(`${label}\n    ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join('  ')}`)

/** N1a — Ready slot: cleanup that runs first throws, cleanup that runs second hangs. */
async function n1a() {
  const d = define('n1a')
  const events = []
  const hang = deferred()
  const S = d.service('s', { setup(_deps, { onDispose }) {
    onDispose(() => hang.promise)            // registered first  → runs second (LIFO)
    onDispose(() => { throw new Error('determined cleanup failure') }) // runs first
    return { ok: true }
  } })
  const E = d.entry({ requires: { s: S } })
  const rt = createRuntime({ services: [S], limits: { disposalGraceMs: GRACE }, diagnostics: { onEvent: e => events.push(`${e.type}${e.phase ? ':' + e.phase : ''}`) } })
  const env = await rt.enter(E)
  await env.deps.s.load()
  const outcome = await env.dispose().then(() => 'fulfilled', e => `rejected:${e.errors?.length ?? 1}`)
  const ledger = rt.inspect().unsettledAttempts.map(a => a.state)
  show('N1a  ready-slot cleanup: error then hang', { dispose: outcome, events: `[${events}]`, ledger: `[${ledger}]` })
  hang.resolve()
  await sleep(20)
  show('N1a  after releasing the hung cleanup', { events: `[${events}]`, ledger: `[${rt.inspect().unsettledAttempts.length}]` })
  await rt.dispose().catch(() => undefined)
}

/** N1b — the reverse order: the hang runs first, so the second cleanup never runs at all. */
async function n1b() {
  const d = define('n1b')
  const events = []
  const hang = deferred()
  let secondRan = false
  const S = d.service('s', { setup(_deps, { onDispose }) {
    onDispose(() => { secondRan = true })   // runs second — never reached
    onDispose(() => hang.promise)           // runs first — hangs
    return { ok: true }
  } })
  const E = d.entry({ requires: { s: S } })
  const rt = createRuntime({ services: [S], limits: { disposalGraceMs: GRACE }, diagnostics: { onEvent: e => events.push(`${e.type}${e.phase ? ':' + e.phase : ''}`) } })
  const env = await rt.enter(E)
  await env.deps.s.load()
  const outcome = await env.dispose().then(() => 'fulfilled', e => `rejected`)
  show('N1b  ready-slot cleanup: hang then (never-run) release', { dispose: outcome, events: `[${events}]`, secondCleanupRan: secondRan })
  hang.resolve(); await sleep(20)
  show('N1b  after releasing', { secondCleanupRan: secondRan })
  await rt.dispose().catch(() => undefined)
}

/** N1c — two determined failures behind one hang. */
async function n1c() {
  const d = define('n1c')
  const events = []
  const hang = deferred()
  const S = d.service('s', { setup(_deps, { onDispose }) {
    onDispose(() => hang.promise)
    onDispose(() => { throw new Error('failure 2') })
    onDispose(() => { throw new Error('failure 1') })
    return { ok: true }
  } })
  const E = d.entry({ requires: { s: S } })
  const rt = createRuntime({ services: [S], limits: { disposalGraceMs: GRACE }, diagnostics: { onEvent: e => events.push(e.type === 'attempt-failed-late' ? `attempt-failed-late(${e.cleanupErrors?.length ?? 0})` : e.type) } })
  const env = await rt.enter(E)
  await env.deps.s.load()
  const outcome = await env.dispose().then(() => 'fulfilled', e => `rejected:${e.errors?.length}`)
  show('N1c  two determined failures behind one hang', { dispose: outcome, events: `[${events}]` })
  hang.resolve(); await sleep(20)
  show('N1c  after releasing', { events: `[${events}]` })
  await rt.dispose().catch(() => undefined)
}

/** N1d — the SAME shape on the attempt-rollback call site: setup fails, its rollback has an error then a hang. */
async function n1d() {
  const d = define('n1d')
  const events = []
  const hang = deferred()
  const gate = deferred()
  const S = d.service('s', { failure: { attempts: 1 }, setup(_deps, { onDispose }) {
    onDispose(() => hang.promise)
    onDispose(() => { throw new Error('determined rollback failure') })
    return gate.promise
  } })
  const E = d.entry({ requires: { s: S } })
  const rt = createRuntime({ services: [S], limits: { disposalGraceMs: GRACE, loadTimeoutMs: 5_000 }, diagnostics: { onEvent: e => events.push(`${e.type}${e.phase ? ':' + e.phase : ''}`) } })
  const env = await rt.enter(E)
  let waiter = 'pending'
  void env.deps.s.load().then(() => { waiter = 'resolved' }, e => { waiter = e?.code ?? 'error' })
  await sleep(5)
  gate.reject(new Error('setup failed'))         // the setup is determined: it failed
  await sleep(5)
  const outcome = await env.dispose().then(() => 'fulfilled', e => `rejected:${e.errors?.length}`)
  await sleep(5)
  show('N1d  attempt rollback: error then hang', { dispose: outcome, events: `[${events}]`, waiter, ledger: `[${rt.inspect().unsettledAttempts.map(a => a.state)}]`, envState: env.state })
  hang.resolve(); await sleep(30)
  show('N1d  after releasing the hung rollback', { events: `[${events}]`, waiter, ledger: rt.inspect().unsettledAttempts.length })
  await rt.dispose().catch(() => undefined)
}

/** N1e — control: everything settles inside the grace, so the failure is reported normally. */
async function n1e() {
  const d = define('n1e')
  const events = []
  const S = d.service('s', { setup(_deps, { onDispose }) {
    onDispose(async () => { await sleep(1) })
    onDispose(() => { throw new Error('determined cleanup failure') })
    return { ok: true }
  } })
  const E = d.entry({ requires: { s: S } })
  const rt = createRuntime({ services: [S], limits: { disposalGraceMs: GRACE }, diagnostics: { onEvent: e => events.push(e.type) } })
  const env = await rt.enter(E)
  await env.deps.s.load()
  const outcome = await env.dispose().then(() => 'fulfilled', e => `rejected:${e.errors?.length}`)
  show('N1e  control, all inside the grace', { dispose: outcome, events: `[${events}]` })
  await rt.dispose().catch(() => undefined)
}

for (const probe of [n1a, n1b, n1c, n1d, n1e]) { await probe(); console.log() }
