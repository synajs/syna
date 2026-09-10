// H06 / H12 / H13 / H01 — startup preflight, request fork budget, worker lifecycle, model normalization.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage, override } from 'syna'
import {
  CORE_SERVICES,
  PROBE_REQUEST,
  PreflightError,
  REQUEST_BUDGET,
  RenderInfrastructureEntry,
  RequestEntry,
  RequestHandler,
  Renderer,
  SiteContext,
  SiteEntry,
  WorkerEntry,
  comparePosts,
  createHylaApp,
  define,
  evaluateBudget,
  explainRequest,
  matchesFilter,
  normalizeDomain,
  normalizePostInput,
  preflightRequests,
  violations,
} from '../dist/index.js'
import { createFilesystemApp } from './helpers/app-harness.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('H06 the render infrastructure preflight refuses a factory that depends on the current request before anything listens', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-preflight-'))
  try {
    await assert.rejects(
      createHylaApp({ backend: { kind: 'filesystem', rootDir }, extraServices: [violations.RequestAwareStageFactory] }),
      error => {
        assert.ok(error instanceof PreflightError)
        const report = error.reports.find(item => item.entry === RenderInfrastructureEntry.id)
        assert.ok(report && !report.ok)
        assert.match(report.violations[0], /MISSING_INPUT/)
        assert.match(report.violations[0], new RegExp(violations.RequestAwareStageFactory.id.replaceAll('/', '\\/')))
        return true
      },
    )
    // The same deployment without the offending factory starts. Three shapes are
    // checked before anything listens: infrastructure, site, and one request.
    const app = await createHylaApp({ backend: { kind: 'filesystem', rootDir } })
    assert.equal(app.preflight.every(report => report.ok), true)
    assert.deepEqual(app.preflight.map(report => report.entry), [RenderInfrastructureEntry.id, SiteEntry.id, RequestEntry.id])
    assert.equal(app.runtime.inspect().liveEnvCount, 2, 'the synthetic preflight site world is disposed again')
    await app.close()
  }
  finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('H06 a replacement renderer that reads site facts is refused at the infrastructure preflight with the dependency path', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-preflight-site-'))
  try {
    await assert.rejects(
      createHylaApp({
        backend: { kind: 'filesystem', rootDir },
        extraServices: [],
        runtime: { overrides: [override(Renderer, violations.SiteAwareRenderer)] },
      }),
      error => {
        assert.ok(error instanceof PreflightError)
        const report = error.reports.at(-1)
        assert.equal(report.ok, false)
        assert.equal(report.entry, RenderInfrastructureEntry.id, 'site facts are not available to shared infrastructure, so the root plan already fails')
        assert.match(report.violations.join('\n'), /MISSING_INPUT: Input hyla.mini\/input\/site-snapshot\/v1 is required at service:hyla.mini\/renderer@0.1.0\/dependency:snapshot/)
        return true
      },
    )
  }
  finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('H06 the concurrent plugin-protocol probe detects closure pollution between products (check() cannot; a runtime test can)', async () => {
  const runtime = createRuntime({ services: [...CORE_SERVICES, violations.PollutingStageFactory] })
  const Probe = define.entry('pollution-probe', { requires: { factories: RenderInfrastructureEntry.requires.factories } })
  const env = await runtime.enter(Probe)
  const set = await env.deps.factories.load()
  const polluting = await set.load(set.candidates.find(candidate => candidate.familyId === violations.PollutingStageFactory.family.id))
  const good = await set.load(set.candidates.find(candidate => candidate.familyId.endsWith('remark-gfm-factory')))
  // Two products configured with different options; a protocol-conformant factory keeps them independent.
  const a = polluting.configure({ tag: 'a' })
  const b = polluting.configure({ tag: 'bb' })
  const { unified } = await import('unified')
  const remarkParse = (await import('remark-parse')).default
  const remarkRehype = (await import('remark-rehype')).default
  const rehypeStringify = (await import('rehype-stringify')).default
  const run = async stage => String(await stage.apply(unified().use(remarkParse)).use(remarkRehype).use(rehypeStringify).process('x'))
  violations.pollutionLog.length = 0
  await run(a)
  await run(b)
  await run(a)
  assert.deepEqual(violations.pollutionLog, ['bb', 'bb', 'bb'], 'the polluting factory leaks the last configuration into every product: caught by the runtime probe')
  const g1 = good.configure({ singleTilde: true })
  const g2 = good.configure({ singleTilde: false })
  assert.notStrictEqual(g1, g2)
  await runtime.dispose()
})

test('S8 createHylaApp() refuses a deployment whose request world breaks the request budget, before any tenant exists', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-preflight-request-'))
  try {
    await assert.rejects(
      createHylaApp({
        backend: { kind: 'filesystem', rootDir },
        runtime: { overrides: [override(RequestHandler, violations.HeavyRequestHandler)] },
      }),
      error => {
        assert.ok(error instanceof PreflightError)
        assert.deepEqual(error.reports.map(report => report.ok), [true, true, false], 'infrastructure and site pass; the request shape fails')
        const report = error.reports.at(-1)
        assert.equal(report.entry, RequestEntry.id)
        assert.match(report.violations.join('\n'), /11 local Services exceed the budget of 10/)
        return true
      },
    )
  }
  finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('H12 request budget: the real request world stays within budget, and explain() shows what would break it', async () => {
  const harness = await createFilesystemApp()
  try {
    const reports = await preflightRequests(harness.app)
    assert.equal(reports.length, 2)
    for (const report of reports) {
      assert.equal(report.ok, true, JSON.stringify(report))
      assert.equal(report.localServices, 1, 'only the request handler is request-local')
      assert.equal(report.cost, 1)
      assert.equal(report.eagerToStart, 0)
      assert.ok(report.synthetic >= 3, 'AnchoredEntry, all-collection and binding projections are counted separately')
    }
    const manager = await harness.app.app.deps.sites.load()
    const lease = await manager.acquire('alpha', 'background')
    try {
      const explanation = await lease.env.explain(RequestEntry, { request: PROBE_REQUEST })
      assert.equal(explanation.ok, true)
      assert.deepEqual(explanation.services, { reused: explanation.services.reused, new: 1, forked: 0, eagerToStart: 0, eagerReused: 0 })
      assert.ok(explanation.services.reused >= 12, `shared infrastructure is inherited: ${explanation.services.reused}`)
      assert.deepEqual(explanation.inputs, { inherited: explanation.inputs.inherited, provided: 1 })
      const handler = explanation.nodes.find(node => node.nodeId === `service:${RequestHandler.id}`)
      assert.deepEqual(handler.cause, { kind: 'not-in-parent' })
      // A tighter budget that forbids even the handler reports the violation with its path.
      const tight = await explainRequest(lease.env, PROBE_REQUEST, { ...REQUEST_BUDGET, maxLocalServices: 0, mustInherit: [`service:${RequestHandler.id}`] })
      assert.equal(tight.ok, false)
      assert.match(tight.violations.join('\n'), /1 local Services exceed the budget of 0/)
      assert.match(tight.violations.join('\n'), /must be inherited but is new/)
    }
    finally {
      lease.release()
    }
  }
  finally {
    await harness.close()
  }
})

test('H12 a transitive CurrentRequest dependency in infrastructure is explained as a per-request fork and blocked by the budget', async () => {
  const define2 = definePackage({ name: '@fixture/budget', version: '1.0.0', syna: { id: 'fixture.budget' } })
  const CurrentRequest = define2.input('current-request')
  const Logger = define2.service('logger', { setup: () => ({}) })
  const RequestAwareLogger = define2.service('request-aware-logger', { requires: { request: CurrentRequest, logger: Logger }, setup: () => ({}) })
  const DatabasePool = define2.service('database-pool', { requires: { logger: RequestAwareLogger }, setup: () => ({}) })
  const Handler = define2.service('handler', { requires: { pool: DatabasePool }, setup: () => ({}) })
  const Root = define2.entry('root', { requires: { pool: DatabasePool, logger: Logger }, parameters: { request: CurrentRequest } })
  const Request = define2.entry('request', { requires: { handler: Handler }, parameters: { request: CurrentRequest } })
  const runtime = createRuntime({ services: [DatabasePool, Handler, Logger] })
  const root = await runtime.enter(Root, { request: 'boot' })
  const report = evaluateBudget(await root.explain(Request, { request: 'r1' }), {
    maxLocalServices: 10,
    mustInherit: [`service:${DatabasePool.id}`],
    costs: { [DatabasePool.id]: 10 },
    maxCost: 5,
  })
  assert.equal(report.ok, false)
  assert.equal(report.localServices, 3)
  assert.equal(report.cost, 12)
  assert.match(report.violations.join('\n'), /resource cost 12 exceeds the budget of 5/)
  assert.match(report.violations.join('\n'), new RegExp(`service:${DatabasePool.id.replaceAll('/', '\\/')} must be inherited but is forked: .*dependency-forked.*via service:${DatabasePool.id.replaceAll('/', '\\/')} -> service:${RequestAwareLogger.id.replaceAll('/', '\\/')} -> input:`))
  await runtime.dispose()
})

test('H13 the worker is started by the host after the root is Ready, loops in its own child world and stops before shared resources close', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { idleTtlMs: 10, sweepIntervalMs: 10_000 } } })
  const worker = await harness.app.app.deps.worker.load()
  assert.equal(worker.state, 'idle')
  const manager = await harness.app.app.deps.sites.load()
  const lease = await manager.acquire('alpha', 'request')
  lease.release()
  const liveBefore = harness.app.runtime.inspect().liveEnvCount
  await worker.start({ intervalMs: 5 })
  assert.equal(worker.state, 'running')
  assert.equal(harness.app.runtime.inspect().liveEnvCount, liveBefore + 1, 'the worker world is a real child Env')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.ok(worker.ticks >= 3)
  assert.equal(manager.records().length, 0, 'the worker swept the idle site env')
  await worker.stop()
  assert.equal(worker.state, 'stopped')
  assert.equal(harness.app.runtime.inspect().liveEnvCount, liveBefore - 1, 'the worker released its child world; the swept site env is gone too (infrastructure + app remain)')
  assert.equal(harness.app.runtime.inspect().liveEnvCount, 2)
  // Opening the worker world from inside an eager setup is refused: OWNER_NOT_READY (the documented boundary).
  const EagerStarter = define.service('eager-starter', {
    eager: true,
    requires: { worlds: WorkerEntry },
    async setup({ worlds }) {
      const bound = await worlds.load()
      return { attempt: await bound.enter().then(() => 'entered', error => error.code) }
    },
  })
  const Probe = define.entry('eager-starter-probe', { requires: { starter: EagerStarter } })
  const runtime = createRuntime({ services: [EagerStarter] })
  void SiteContext
  void CORE_SERVICES
  const probe = await runtime.enter(Probe)
  assert.equal((await probe.deps.starter.load()).attempt, 'OWNER_NOT_READY')
  await runtime.dispose()
  await harness.close()
})

test('H01 the data model normalizes input, orders deterministically and treats locale and visibility as data', () => {
  const normalized = normalizePostInput('alpha', {
    id: 'p1', slug: 'hello', locale: 'zh-CN', title: 't', body: 'b', status: 'published',
    categories: ['b', 'a', 'b'], tags: ['x', 'x'],
  })
  assert.deepEqual(normalized.categories, ['b', 'a'])
  assert.equal(normalized.primaryCategory, 'b')
  assert.throws(() => normalizePostInput('alpha', { ...normalized, primaryCategory: 'zzz' }), /not one of the post categories/)
  assert.throws(() => normalizePostInput('alpha', { ...normalized, slug: '../x' }), /path-safe/)
  assert.throws(() => normalizePostInput('alpha', { ...normalized, locale: 'fr' }), /Unsupported locale/)
  assert.throws(() => normalizePostInput('a/b', normalized), /path-safe/)
  const posts = [
    { ...normalized, tenantId: 'alpha', primaryCategory: 'b', revision: 1, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '', slug: 'b' },
    { ...normalized, tenantId: 'alpha', primaryCategory: 'b', revision: 1, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '', slug: 'a' },
    { ...normalized, tenantId: 'alpha', primaryCategory: 'b', revision: 1, createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '', slug: 'c', status: 'draft' },
  ]
  assert.deepEqual([...posts].sort(comparePosts).map(post => post.slug), ['c', 'a', 'b'])
  assert.equal(matchesFilter(posts[2], { visibility: 'public' }), false)
  assert.equal(matchesFilter(posts[2], { visibility: 'all', locale: 'zh-CN' }), true)
  assert.equal(matchesFilter(posts[0], { visibility: 'public', category: 'a' }), true)
})

test('H01 / S9 normalizeDomain: one canonical spelling per host (case, port, trailing dot, IDNA), nothing else passes', () => {
  assert.equal(normalizeDomain('Example.COM.'), 'example.com')
  assert.equal(normalizeDomain(' EXAMPLE.com:8080 '), 'example.com')
  assert.equal(normalizeDomain('bücher.example'), 'xn--bcher-kva.example')
  assert.equal(normalizeDomain('XN--BCHER-KVA.example.'), 'xn--bcher-kva.example')
  assert.equal(normalizeDomain('日本.jp'), 'xn--wgv71a.jp')
  for (const bad of ['', '.', 'exa mple.com', 'a_b.com', 'host:80:80', 'a/b.com', undefined]) {
    assert.equal(normalizeDomain(bad), undefined, JSON.stringify(bad))
  }
})
