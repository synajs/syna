// Regressions for the cache / delivery / DX audit (docs/audit/cache-delivery/REPORT.md):
// F-CD-01 explain() lists parameters missing deep inside the graph; F-CD-02 candidate-independent
// failures keep their own code; F-CD-04 plan-template keys carry a digest of the parent signature.
import assert from 'node:assert/strict'
import test from 'node:test'
import { auto, createRuntime, definePackage } from '../../dist/index.js'
import { PlanTemplateCache } from '../../dist/internal/plan-cache.js'

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@v05/${id.replaceAll('.', '-')}-${version}`,
  version,
  syna: { id },
})
const codeOf = async fn => { try { await fn(); return 'NO-ERROR' } catch (error) { return error.code } }

test('F-CD-01 explain() lists an Input or Binding required by a Service deep in the graph, not only declared Entry parameters', async () => {
  const define = makeDefine('v05.audit.deep-missing')
  const Cap = define.contract('cap')
  const Choice = define.binding('choice', Cap)
  const Tenant = define.input('tenant')
  const Impl = define.service('impl', { provides: [Cap], setup: () => ({}) })
  const NeedsChoice = define.service('needs-choice', { requires: { chosen: Choice }, setup: () => ({}) })
  const NeedsTenant = define.service('needs-tenant', { requires: { tenant: Tenant }, setup: () => ({}) })
  const DeepBinding = define.entry('deep-binding', { requires: { user: NeedsChoice } })
  const DeepInput = define.entry('deep-input', { requires: { user: NeedsTenant } })
  const DeclaredBinding = define.entry('declared-binding', { requires: { user: NeedsChoice }, parameters: { choice: Choice } })
  const DeclaredInput = define.entry('declared-input', { requires: { user: NeedsTenant }, parameters: { tenant: Tenant } })
  const runtime = createRuntime({ services: [Impl, NeedsChoice, NeedsTenant] })

  const deepBinding = await runtime.explain(DeepBinding)
  assert.equal(deepBinding.ok, false)
  assert.equal(deepBinding.error.code, 'MISSING_BINDING')
  assert.deepEqual(deepBinding.missingBindings, [Choice.id])
  assert.deepEqual(deepBinding.missingInputs, [])

  const deepInput = await runtime.explain(DeepInput)
  assert.equal(deepInput.error.code, 'MISSING_INPUT')
  assert.deepEqual(deepInput.missingInputs, [Tenant.id])
  assert.deepEqual(deepInput.missingBindings, [])

  // declared-but-unprovided parameters keep their v0.5 reporting (R16: a Binding never lands in missingInputs)
  const declaredBinding = await runtime.explain(DeclaredBinding, {})
  assert.deepEqual(declaredBinding.missingBindings, [Choice.id])
  assert.deepEqual(declaredBinding.missingInputs, [])
  const declaredInput = await runtime.explain(DeclaredInput, {})
  assert.deepEqual(declaredInput.missingInputs, [Tenant.id])
  assert.deepEqual(declaredInput.missingBindings, [])
  assert.equal(await codeOf(() => runtime.enter(DeepInput)), 'MISSING_INPUT')
  assert.equal(await codeOf(() => runtime.enter(DeepBinding)), 'MISSING_BINDING')
  await runtime.dispose()
})

test('F-CD-02 a failure every candidate shares keeps its own code instead of UNSATISFIABLE_TOPOLOGY, independent of requires order', async () => {
  const define = makeDefine('v05.audit.wrap')
  const Request = define.input('request')
  const Tenant = define.input('tenant')
  const Capability = define.contract('capability')
  const P1 = makeDefine('v05.audit.wrap.p1').service({ provides: [Capability], setup: () => ({}) })
  const P2 = makeDefine('v05.audit.wrap.p2').service({ provides: [Capability], setup: () => ({}) })
  const Pool = define.service('pool', { setup: () => ({}) })
  const Cache = define.service('cache', { requires: { tenant: Tenant, pool: Pool }, setup: () => ({}) })
  const NeedsRequest = define.service('needs-request', { requires: { request: Request }, setup: () => ({}) })
  const AutoUser = define.service('auto-user', { requires: { automatic: auto(Capability) }, setup: () => ({}) })
  const App = define.entry('app', { requires: { pool: Pool } })
  const Site = define.entry('site', { requires: { cache: Cache }, parameters: { tenant: Tenant } })
  const ShareOnly = define.entry('share-only', { requires: { cache: Cache }, parameters: { tenant: Tenant }, reuse: { share: [Cache] } })
  const ShareWithAuto = define.entry('share-with-auto', { requires: { automatic: AutoUser, cache: Cache }, parameters: { tenant: Tenant }, reuse: { share: [Cache] } })
  const MissingOnly = define.entry('missing-only', { requires: { needy: NeedsRequest } })
  const MissingAutoFirst = define.entry('missing-auto-first', { requires: { automatic: AutoUser, needy: NeedsRequest } })
  const MissingAutoLast = define.entry('missing-auto-last', { requires: { needy: NeedsRequest, automatic: AutoUser } })
  const policy = { orderAutoCandidates: (_c, candidates) => [...candidates].sort((l, r) => l.family.id.localeCompare(r.family.id)) }
  const runtime = createRuntime({ services: [Pool, Cache, NeedsRequest, AutoUser, P1, P2], policy })
  const app = await runtime.enter(App)
  const site = await app.enter(Site, { tenant: 'a' })

  const shareOnly = await site.explain(ShareOnly, { tenant: 'b' })
  const shareWithAuto = await site.explain(ShareWithAuto, { tenant: 'b' })
  assert.equal(shareOnly.error.code, 'SHARE_CONSTRAINT_FAILED')
  assert.equal(shareWithAuto.error.code, 'SHARE_CONSTRAINT_FAILED')
  assert.equal(await codeOf(() => site.enter(ShareWithAuto, { tenant: 'b' })), 'SHARE_CONSTRAINT_FAILED')

  const missingOnly = await app.explain(MissingOnly)
  const missingAutoFirst = await app.explain(MissingAutoFirst)
  const missingAutoLast = await app.explain(MissingAutoLast)
  for (const explanation of [missingOnly, missingAutoFirst, missingAutoLast]) {
    assert.equal(explanation.error.code, 'MISSING_INPUT')
    assert.deepEqual(explanation.missingInputs, [Request.id])
  }
  assert.equal(await codeOf(() => app.enter(MissingAutoFirst)), 'MISSING_INPUT')
  assert.equal(await codeOf(() => app.enter(MissingAutoLast)), 'MISSING_INPUT')
  assert.equal(runtime.inspect().liveEnvCount, 2)
  await runtime.dispose()
})

test('F-CD-02 control: candidates that fail for different reasons are still UNSATISFIABLE_TOPOLOGY and explain() collects every nested missing Input', async () => {
  const define = makeDefine('v05.audit.unsat')
  const Capability = define.contract('capability')
  const NeedX = define.input('x')
  const NeedY = define.input('y')
  const P1 = makeDefine('v05.audit.unsat.p1').service({ provides: [Capability], requires: { x: NeedX }, setup: () => ({}) })
  const P2 = makeDefine('v05.audit.unsat.p2').service({ provides: [Capability], requires: { y: NeedY }, setup: () => ({}) })
  const AutoUser = define.service('auto-user', { requires: { automatic: auto(Capability) }, setup: () => ({}) })
  const Entry = define.entry('entry', { requires: { automatic: AutoUser } })
  const policy = { orderAutoCandidates: (_c, candidates) => [...candidates].sort((l, r) => l.family.id.localeCompare(r.family.id)) }
  const runtime = createRuntime({ services: [AutoUser, P1, P2], policy })
  const explanation = await runtime.explain(Entry)
  assert.equal(explanation.ok, false)
  assert.equal(explanation.error.code, 'UNSATISFIABLE_TOPOLOGY')
  assert.deepEqual(explanation.error.details.failures.map(f => f.code), ['MISSING_INPUT', 'MISSING_INPUT'])
  assert.deepEqual([...explanation.missingInputs].sort(), [NeedX.id, NeedY.id].sort())
  assert.equal(await codeOf(() => runtime.enter(Entry)), 'UNSATISFIABLE_TOPOLOGY')
  await runtime.dispose()
})

test('F-CD-04 plan-template keys carry a digest of the parent signature: bounded key size, hits on repeats, misses under another parent', async () => {
  const recorded = []
  const originalSet = PlanTemplateCache.prototype.set
  PlanTemplateCache.prototype.set = function patchedSet(key, value) {
    recorded.push({ keyChars: key.length, signatureChars: value.signature?.length ?? -1 })
    return originalSet.call(this, key, value)
  }
  try {
    const define = makeDefine('v05.audit.template-key')
    const Request = define.input('request')
    const Tenant = define.input('tenant')
    const Logger = define.service('logger', { setup: () => ({}) })
    const stable = []
    for (let i = 0; i < 120; i += 1) {
      const previous = stable.at(-1)
      stable.push(define.service(`stable-${i}`, { requires: { logger: Logger, ...(previous ? { previous } : {}) }, setup: () => ({}) }))
    }
    const TenantScoped = define.service('tenant-scoped', { requires: { tenant: Tenant, top: stable.at(-1) }, setup: () => ({}) })
    const Extra = define.service('extra', { requires: { tenant: Tenant }, setup: () => ({}) })
    const Handler = define.service('handler', { requires: { request: Request, tenant: TenantScoped }, setup: () => ({}) })
    const App = define.entry('app', { requires: Object.fromEntries(stable.map((s, i) => [`s${i}`, s])) })
    const Site = define.entry('site', { requires: { scoped: TenantScoped }, parameters: { tenant: Tenant } })
    const WiderSite = define.entry('wider-site', { requires: { scoped: TenantScoped, extra: Extra }, parameters: { tenant: Tenant } })
    const RequestEntry = define.entry('request', { requires: { handler: Handler }, parameters: { request: Request } })
    const runtime = createRuntime({ services: [Logger, ...stable, TenantScoped, Extra, Handler] })
    const app = await runtime.enter(App)
    const siteA = await app.enter(Site, { tenant: 'a' })
    const siteB = await app.enter(Site, { tenant: 'b' })
    const siteC = await app.enter(WiderSite, { tenant: 'c' })
    const before = runtime.inspect().planCache
    for (let i = 0; i < 5; i += 1) await (await siteA.enter(RequestEntry, { request: { i } })).dispose()
    const afterA = runtime.inspect().planCache
    assert.equal(afterA.misses - before.misses, 1, 'one template per (parent shape, entry, parameter shape)')
    assert.equal(afterA.hits - before.hits, 4)
    await (await siteB.enter(RequestEntry, { request: { i: 0 } })).dispose()
    const afterB = runtime.inspect().planCache
    assert.equal(afterB.hits - afterA.hits, 1, 'a structurally identical sibling parent shares the template (R17 neutrality across siblings)')
    await (await siteC.enter(RequestEntry, { request: { i: 0 } })).dispose()
    const afterC = runtime.inspect().planCache
    assert.equal(afterC.misses - afterB.misses, 1, 'a parent with a different graph is a different template (parent signature verified on hit)')
    const parentSignatureChars = Math.max(...recorded.map(r => r.signatureChars))
    assert.ok(parentSignatureChars > 2000, `a 120-service world has a large signature (${parentSignatureChars})`)
    const requestKeys = recorded.slice(-2).map(r => r.keyChars)
    assert.ok(requestKeys.every(chars => chars < 1024 && chars * 4 < parentSignatureChars), `template keys stay small (${requestKeys.join(',')}) next to a ${parentSignatureChars}-char parent signature`)
    await runtime.dispose()
  } finally {
    PlanTemplateCache.prototype.set = originalSet
  }
})
