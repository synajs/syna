// 07-failure-modes: what happens when setup fails, hangs, or the world closes.
//
// Five scenes with provider clients that misbehave. Each scene is its own Runtime with
// short limits, and prints the error code and the `details` fields worth looking at.
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage, forward, isSynaError, type RuntimeEvent, type ServiceRevision } from '@syna/core'

const define = definePackage(packageJson)
const errorOf = async (work: Promise<unknown>): Promise<unknown> => work.then(() => undefined, (error: unknown) => error)
const short = (id: string): string => id.slice(id.lastIndexOf('/') + 1)

// --- 1. sticky failure -----------------------------------------------------------------

{
  let attempts = 0
  const RefusedCredentials = define.service('refused-credentials', {
    setup() {
      attempts += 1
      throw new Error('Acme refused the API key')
    },
  })
  const World = define.entry('sticky', { requires: { client: RefusedCredentials } })
  const runtime = createRuntime({ services: [RefusedCredentials] })
  const world = await runtime.enter(World)
  const first = await errorOf(world.deps.client.load())
  const second = await errorOf(world.deps.client.load())
  const state = world.inspect().nodes.find(node => node.label.includes('refused-credentials'))?.state
  await runtime.dispose()
  const message = first instanceof Error ? first.message : String(first)
  console.log(`07-failure-modes: sticky failure: 2 loads, ${attempts} attempt; both rejected with "${message}"; slot state: ${state}`)
  assert.equal(attempts, 1)
  assert.equal(message, 'Acme refused the API key')
  assert.equal(second, first)
  assert.equal(state, 'failed')
}

// --- 2. a retry policy -----------------------------------------------------------------

{
  let flakyCalls = 0
  const FlakyProvider = define.service('flaky-provider', {
    failure: { attempts: 3, delayMs: 5 },
    setup() {
      flakyCalls += 1
      if (flakyCalls < 3) throw new Error(`handshake ${flakyCalls} timed out`)
      return { ready: true }
    },
  })
  let downCalls = 0
  let providerBack = false
  const ProviderDown = define.service('provider-down', {
    failure: { attempts: 2, delayMs: 5, afterExhaustion: 'retry-on-next-load', cooldownMs: 20 },
    setup() {
      downCalls += 1
      if (!providerBack) throw new Error(`Acme is down (attempt ${downCalls})`)
      return { ready: true }
    },
  })
  const World = define.entry('retry', { requires: { flaky: FlakyProvider, down: ProviderDown } })
  const runtime = createRuntime({ services: [FlakyProvider, ProviderDown] })
  const world = await runtime.enter(World)
  const flaky = await world.deps.flaky.load()
  const exhausted = await errorOf(world.deps.down.load())
  const callsAfterExhaustion = downCalls
  providerBack = true
  await sleep(30)
  const recovered = await world.deps.down.load()
  await runtime.dispose()
  const exhaustedMessage = exhausted instanceof Error ? exhausted.message : String(exhausted)
  console.log(`07-failure-modes: retry: flaky provider ready after attempt ${flakyCalls} of 3; provider down after ${callsAfterExhaustion} attempts ("${exhaustedMessage}"); the next load after the cooldown started a new sequence: ${recovered.ready ? 'ready' : 'still down'} after ${downCalls} attempts in total`)
  assert.deepEqual(flaky, { ready: true })
  assert.equal(flakyCalls, 3)
  assert.equal(callsAfterExhaustion, 2)
  assert.equal(exhaustedMessage, 'Acme is down (attempt 2)')
  assert.deepEqual(recovered, { ready: true })
  assert.equal(downCalls, 3)
}

// --- 3. a slow start: the load timeout is the waiter's, the attempt keeps running ---------

{
  const events: RuntimeEvent[] = []
  const cleanups: string[] = []
  const SlowStart = define.service('slow-start', {
    loadTimeoutMs: 50,
    async setup(_dependencies, { onDispose }) {
      await sleep(150)
      onDispose(() => { cleanups.push('slow-start') })
      return { ready: true }
    },
  })
  const World = define.entry('slow', { requires: { client: SlowStart } })
  const runtime = createRuntime({ services: [SlowStart], diagnostics: { onEvent: event => events.push(event) } })
  const world = await runtime.enter(World)
  const timedOut = await errorOf(world.deps.client.load())
  const node = world.inspect().nodes.find(item => item.label.includes('slow-start'))
  const overdue = node?.state === 'starting' && typeof node.overdueMs === 'number'
  await sleep(250)
  const late = await world.deps.client.load()
  await world.dispose()
  await runtime.dispose()
  if (!isSynaError(timedOut, 'LOAD_TIMEOUT')) throw new Error(`expected LOAD_TIMEOUT, got ${String(timedOut)}`)
  const adopted = events.find(event => event.type === 'attempt-succeeded-late')
  console.log(`07-failure-modes: slow start: ${timedOut.code} for slot ${short(timedOut.details.revision)} after ${timedOut.details.elapsedMs >= 50 ? '≥' : '<'} 50 ms (attempt still running: ${timedOut.details.attemptStillRunning}); the slot stayed starting and overdue: ${overdue}; a later load got the instance: ${late.ready}; events: ${events.map(event => event.type === 'attempt-succeeded-late' ? `${event.type} (adopted: ${event.adopted})` : event.type).join(', ')}; cleanup ran at close: ${cleanups.length === 1}`)
  assert.ok(timedOut.details.elapsedMs >= 50)
  assert.equal(timedOut.details.attemptStillRunning, true)
  assert.equal(overdue, true)
  assert.deepEqual(late, { ready: true })
  assert.deepEqual(events.map(event => event.type), ['attempt-overdue', 'attempt-succeeded-late'])
  assert.equal(adopted?.type === 'attempt-succeeded-late' && adopted.adopted, true)
  assert.deepEqual(cleanups, ['slow-start'])
}

// --- 4. a bounded close: a setup that never settles ------------------------------------------

{
  const events: RuntimeEvent[] = []
  // The setup below parks on a wake-up this program keeps and never sends (and it ignores the stop
  // signal). Keeping the handle is part of the demonstration: a hang nothing refers to any more ends
  // differently, because the runtime can then prove the attempt dead (`attempt-unreachable`) and the
  // close has nothing left to abandon.
  const wakeUps: Array<() => void> = []
  const Credentials = define.service('credentials', { setup: () => ({ key: 'k' }) })
  const NeverSettles = define.service('never-settles', {
    requires: { credentials: Credentials },
    async setup({ credentials }) {
      await credentials.load()
      await new Promise<void>(resolve => { wakeUps.push(resolve) }) // nobody ever wakes it
    },
  })
  const World = define.entry('stuck', { requires: { client: NeverSettles } })
  const runtime = createRuntime({ services: [NeverSettles, Credentials], limits: { loadTimeoutMs: 30, disposalGraceMs: 50 }, diagnostics: { onEvent: event => events.push(event) } })
  const world = await runtime.enter(World)
  const timedOut = await errorOf(world.deps.client.load())
  const started = Date.now()
  await world.dispose()
  const closeMs = Date.now() - started
  const ledger = runtime.inspect().unsettledAttempts
  const abandoned = events.find(event => event.type === 'attempt-abandoned')
  await runtime.dispose()
  const outstanding = events.find(event => event.type === 'runtime-attempts-outstanding')
  if (!isSynaError(timedOut, 'LOAD_TIMEOUT')) throw new Error(`expected LOAD_TIMEOUT, got ${String(timedOut)}`)
  console.log(`07-failure-modes: bounded close: dispose() returned within the grace: ${closeMs >= 50 && closeMs < 1000}; env state: ${world.state}; unsettled attempts on the runtime: ${ledger.length} (${ledger.map(item => item.state).join(', ')}); attempt-abandoned phase=${abandoned?.type === 'attempt-abandoned' ? abandoned.phase : '-'} dependencies=[${abandoned?.type === 'attempt-abandoned' ? abandoned.dependencies.map(item => `${item.dependency}: ${item.state}`).join(', ') : ''}]; runtime-attempts-outstanding: ${outstanding?.type === 'runtime-attempts-outstanding' ? outstanding.attempts.length : 0}`)
  assert.ok(closeMs >= 50 && closeMs < 1000, `close took ${closeMs} ms`)
  assert.equal(world.state, 'disposed')
  assert.deepEqual(ledger.map(item => item.state), ['abandoned'])
  assert.equal(abandoned?.type === 'attempt-abandoned' && abandoned.phase, 'setup')
  assert.deepEqual(abandoned?.type === 'attempt-abandoned' ? abandoned.dependencies.map(item => item.dependency) : [], ['credentials'])
  assert.equal(outstanding?.type === 'runtime-attempts-outstanding' && outstanding.attempts.length, 1)
  assert.equal(runtime.inspect().liveEnvCount, 0)
}

// --- 5. a setup wait cycle ------------------------------------------------------------------

{
  let Audit!: ServiceRevision<object>
  let Client!: ServiceRevision<object>
  Audit = define.service('cycle-audit', {
    requires: { client: forward(() => Client) },
    async setup({ client }) {
      await client.load()
      return {}
    },
  })
  Client = define.service('cycle-client', {
    requires: { audit: forward(() => Audit) },
    async setup({ audit }) {
      await audit.load()
      return {}
    },
  })
  const World = define.entry('cycle', { requires: { client: Client } })
  const runtime = createRuntime({ services: [Client, Audit], limits: { loadTimeoutMs: 40, disposalGraceMs: 50 } })
  const world = await runtime.enter(World)
  const timedOut = await errorOf(world.deps.client.load())
  await world.dispose()
  await runtime.dispose()
  if (!isSynaError(timedOut, 'LOAD_TIMEOUT')) throw new Error(`expected LOAD_TIMEOUT, got ${String(timedOut)}`)
  const cycle = [...new Set(timedOut.details.suspectedWaitCycle ?? [])].map(short).sort()
  console.log(`07-failure-modes: wait cycle: ${timedOut.code}; suspected cycle over ${cycle.join(', ')} (an observation, not a proof); pending loads: ${timedOut.details.pendingLoads.length}`)
  assert.deepEqual(cycle, ['cycle-audit@1.0.0', 'cycle-client@1.0.0'])
  assert.ok(timedOut.details.pendingLoads.length >= 1)
}

console.log('07-failure-modes: OK')
