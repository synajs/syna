// A4 — does `acquireTimeoutMs` cover the whole acquire, and does shutdown() end the
// wait of a caller that is inside create()? The gate sits in the site authenticator's
// setup, which create() awaits after boundSites.enter() and context.load().
import { createFilesystemApp, AUTH } from '/Users/weibohan/Workspace/syna-v0.5/apps/multitenant-blog/tests/helpers/app-harness.mjs'
import { define, AuthenticatorContract, AuthOptions, SiteAuth } from '/Users/weibohan/Workspace/syna-v0.5/apps/multitenant-blog/dist/index.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const show = (label, data) => console.log(`${label}\n    ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join('  ')}`)
const settledWithin = async (promise, ms) => {
  const marker = Symbol('pending')
  const result = await Promise.race([promise.then(v => ({ value: v }), e => ({ error: e })), sleep(ms).then(() => marker)])
  return result === marker ? undefined : result
}

let openGate
let gate = new Promise(resolve => { openGate = resolve })
let setups = 0
const SlowAuth = define.service('probe-slow-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  async setup({ options }) {
    setups += 1
    void options.read()
    await gate
    return { scheme: 'probe', async authenticate() { return { kind: 'anonymous', roles: [] } } }
  },
})

const authMap = { ...AUTH, alpha: { implementation: SiteAuth.to(SlowAuth), options: {} } }

async function harnessWith(siteManager) {
  return createFilesystemApp({ auth: authMap, app: { siteManager, extraServices: [SlowAuth] } })
}

/** A4a — the deadline does not cover create(). */
{
  const harness = await harnessWith({ capacity: 2, acquireTimeoutMs: 20, shutdownTimeoutMs: 200 })
  const manager = await harness.app.app.deps.sites.load()
  const started = Date.now()
  const acquiring = manager.acquire('alpha', 'request').then(lease => { lease.release(); return 'acquired' }, e => e.code ?? e.name)
  while (setups === 0) await sleep(2)
  const at80 = await settledWithin(acquiring, 80)
  show('A4a  acquireTimeoutMs=20 ms, the gate is inside create()', {
    afterMs: Date.now() - started, acquire: at80 === undefined ? 'still pending' : JSON.stringify(at80),
    stats: JSON.stringify({ inFlightAcquires: manager.stats().inFlightAcquires, creating: manager.stats().creating }),
  })
  openGate()
  const outcome = await settledWithin(acquiring, 500)
  show('A4a  after opening the gate', { totalMs: Date.now() - started, outcome: JSON.stringify(outcome) })
  await harness.close().catch(() => undefined)
}

/** A4b — a second acquirer joining record.creation is bounded by nothing either. */
{
  gate = new Promise(resolve => { openGate = resolve }); setups = 0
  const harness = await harnessWith({ capacity: 2, acquireTimeoutMs: 20, shutdownTimeoutMs: 200 })
  const manager = await harness.app.app.deps.sites.load()
  const first = manager.acquire('alpha', 'request').then(l => { l.release(); return 'acquired' }, e => e.code ?? e.name)
  while (setups === 0) await sleep(2)
  const started = Date.now()
  const second = manager.acquire('alpha', 'request').then(l => { l.release(); return 'acquired' }, e => e.code ?? e.name)
  const at80 = await settledWithin(second, 80)
  show('A4b  a joining acquirer', { afterMs: Date.now() - started, second: at80 === undefined ? 'still pending' : JSON.stringify(at80) })
  openGate()
  show('A4b  after opening the gate', { first: JSON.stringify(await settledWithin(first, 500)), second: JSON.stringify(await settledWithin(second, 500)) })
  await harness.close().catch(() => undefined)
}

/** A4c — shutdown() while an acquirer is inside create(). */
{
  gate = new Promise(resolve => { openGate = resolve }); setups = 0
  const harness = await harnessWith({ capacity: 2, acquireTimeoutMs: 30_000, shutdownTimeoutMs: 150 })
  const manager = await harness.app.app.deps.sites.load()
  const acquiring = manager.acquire('alpha', 'request').then(l => { l.release(); return 'acquired' }, e => e.code ?? e.name)
  while (setups === 0) await sleep(2)
  const t0 = Date.now()
  const shutdown = manager.shutdown()
  const shutdownDone = await settledWithin(shutdown, 400)
  const shutdownMs = Date.now() - t0
  const afterShutdown = await settledWithin(acquiring, 100)
  show('A4c  shutdown() with an acquirer inside create()', {
    shutdown: shutdownDone === undefined ? 'still pending' : JSON.stringify(shutdownDone), shutdownMs,
    acquirer: afterShutdown === undefined ? 'still pending' : JSON.stringify(afterShutdown),
  })
  openGate()
  const finalOutcome = await settledWithin(acquiring, 800)
  show('A4c  after opening the gate', { acquirer: JSON.stringify(finalOutcome), totalMs: Date.now() - t0 })
  await settledWithin(shutdown, 800)
  await harness.close().catch(() => undefined)
}
process.exit(0)
