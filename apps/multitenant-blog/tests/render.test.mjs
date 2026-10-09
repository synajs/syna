// H05 / H06 / H07 — three recipes share one set of factory slots; recipes persist and resolve.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage } from 'synajs'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import {
  DEFAULT_ACCENT,
  MarkdownStageFactoryContract,
  PIPELINE_CACHE_MAX_ENTRIES,
  PipelineBuilder,
  RecipeError,
  RenderInfrastructureEntry,
  Renderer,
  STAGE_FACTORIES,
  StageFactoryRef,
  RemarkGfmFactory,
  RehypeSanitizeFactory,
  RemarkParseFactory,
  RemarkRehypeFactory,
  RehypeStringifyFactory,
  UNTRUSTED_SANITIZE_OCCURRENCE,
  bodyRecipe,
  commentRecipe,
  createFactory,
  defaultRecipes,
  define,
  factorySetupCounts,
  isCssColor,
  isSafeHref,
  parseRecipeDocument,
  previewRecipe,
  stageRef,
} from '../dist/index.js'

const siteConfig = (tenantId, recipes = defaultRecipes()) => ({
  tenantId,
  title: `Site ${tenantId}`,
  domains: [`${tenantId}.test`],
  defaultLocale: 'en',
  theme: { name: 'paper', accent: '#3366cc' },
  navigation: [{ label: 'Home', href: '/' }],
  recipes,
  auth: { implementation: { kind: 'implementation-ref', contractId: 'x', familyId: 'y', range: '*' }, options: {} },
  configRevision: 1,
})

const untrusted = 'Hello <script>alert(1)</script> [link](https://evil.test/x) <img src=x onerror=alert(2)> *ok*'

/** A third-party rehype stage that injects script and an event handler into the tree, after any sanitizer the recipe placed. */
const EvilRehypeFactory = define.service('evil-rehype-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    return createFactory(
      { pluginId: 'evil-rehype', kind: 'rehype', optionsVersion: 1, optionsSchema: { type: 'object', additionalProperties: false, properties: {} }, repeatable: false },
      () => processor => processor.use(() => tree => {
        tree.children.push(
          { type: 'element', tagName: 'script', properties: {}, children: [{ type: 'text', value: 'alert(1)' }] },
          { type: 'element', tagName: 'img', properties: { src: 'x', onError: 'alert(2)' }, children: [] },
        )
      }),
    )
  },
})
const withEvilStage = recipe => ({
  ...recipe,
  stages: [...recipe.stages.slice(0, -1), { occurrence: 'evil', ref: stageRef(EvilRehypeFactory), optionsVersion: 1, options: {} }, recipe.stages.at(-1)],
})

test('H05 three recipes with observable differences are built from one shared set of factory slots', async () => {
  assert.deepEqual(factorySetupCounts, {}, 'the module-global setup counter is deprecated and never written (I-73)')
  const runtime = createRuntime({ services: [PipelineBuilder, Renderer, ...STAGE_FACTORIES] })
  const env = await runtime.enter(RenderInfrastructureEntry)
  const builder = await env.deps.pipelines.load()
  const { body, comment, preview } = defaultRecipes()
  const [bodyPipe, commentPipe, previewPipe] = await Promise.all([builder.build(body), builder.build(comment), builder.build(preview)])

  assert.deepEqual(bodyPipe.stages.map(stage => stage.pluginId), ['remark-parse', 'remark-gfm', 'remark-rehype', 'rehype-external-links', 'rehype-stringify'])
  assert.deepEqual(commentPipe.stages.map(stage => stage.pluginId), ['remark-parse', 'remark-gfm', 'remark-rehype', 'rehype-sanitize', 'rehype-external-links', 'rehype-stringify'])
  assert.deepEqual(previewPipe.stages.map(stage => stage.pluginId), ['remark-parse', 'remark-excerpt', 'remark-rehype', 'rehype-sanitize', 'rehype-stringify'])

  const bodyHtml = await bodyPipe.process(untrusted)
  const commentHtml = await commentPipe.process(untrusted)
  const previewHtml = await previewPipe.process(`# Title\n\nFirst paragraph.\n\n${'Second paragraph that is long enough to be cut by the excerpt budget of the preview recipe. '.repeat(3)}\n\nThird.`)
  assert.match(bodyHtml, /<script>alert\(1\)<\/script>/, 'trusted body keeps raw HTML')
  assert.match(bodyHtml, /rel="noopener" target="_blank"/)
  assert.doesNotMatch(commentHtml, /<script|onerror|<img/, 'untrusted comment is sanitized')
  assert.match(commentHtml, /rel="nofollow noopener ugc" target="_blank"/, 'later plugins run on the sanitized tree and add safe attributes only')
  assert.match(commentHtml, /<em>ok<\/em>/)
  assert.doesNotMatch(previewHtml, /<h1>/, 'preview drops headings')
  assert.match(previewHtml, /First paragraph/)
  assert.doesNotMatch(previewHtml, /Third/)

  // Every factory Service is one instance in this Runtime world (one token per factory, the same
  // before and after the builds); another Runtime gets other instances. Products differ per recipe.
  const instances = await builder.factoryInstances()
  assert.equal(Object.keys(instances).length, STAGE_FACTORIES.length)
  assert.equal(new Set(Object.values(instances)).size, STAGE_FACTORIES.length, 'one token per factory')
  assert.deepEqual(await builder.factoryInstances(), instances, 'the tokens are stable: no factory was set up again')
  const other = createRuntime({ services: [PipelineBuilder, Renderer, ...STAGE_FACTORIES] })
  const otherBuilder = await (await other.enter(RenderInfrastructureEntry)).deps.pipelines.load()
  const otherInstances = await otherBuilder.factoryInstances()
  assert.deepEqual(Object.keys(otherInstances).sort(), Object.keys(instances).sort())
  for (const key of Object.keys(instances)) assert.notEqual(otherInstances[key], instances[key], `${key}: a separate Runtime world has its own instance`)
  await other.dispose()
  const stats = await builder.factoryStats()
  assert.equal(stats[`${RemarkParseFactory.family.id}@${RemarkParseFactory.version}`], 3, 'parse configured once per recipe')
  assert.equal(stats[`${RehypeSanitizeFactory.family.id}@${RehypeSanitizeFactory.version}`], 2)
  assert.equal(builder.stats.builds, 3)
  await builder.build(body)
  assert.equal(builder.stats.cacheHits, 1)
  await runtime.dispose()
})

test('H05 concurrent rendering across recipes and tenants shares no mutable state (outputs are independent of interleaving)', async () => {
  const runtime = createRuntime({ services: [PipelineBuilder, Renderer, ...STAGE_FACTORIES] })
  const env = await runtime.enter(RenderInfrastructureEntry)
  const renderer = await env.deps.renderer.load()
  const alpha = siteConfig('alpha', { ...defaultRecipes(), preview: previewRecipe(20) })
  const beta = siteConfig('beta', { ...defaultRecipes(), body: commentRecipe() })
  const post = (tenantId, index) => ({
    id: `${tenantId}-${index}`, tenantId, slug: `p${index}`, locale: 'en', title: `T${index}`, status: 'published',
    body: `Para ${tenantId} ${index} <b>raw</b> ~~gfm~~ [x](https://ext.test)\n\nSecond ${index}.`,
    categories: [], primaryCategory: undefined, tags: [], revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const sequential = []
  for (let index = 0; index < 6; index += 1) {
    sequential.push(await renderer.renderPostView(alpha, post('alpha', index)))
    sequential.push(await renderer.renderPostView(beta, post('beta', index)))
  }
  const concurrent = await Promise.all(Array.from({ length: 6 }, (_, index) => [
    renderer.renderPostView(alpha, post('alpha', index)),
    renderer.renderPostView(beta, post('beta', index)),
  ]).flat())
  assert.deepEqual(concurrent.map(view => [view.id, view.bodyHtml, view.previewHtml]), sequential.map(view => [view.id, view.bodyHtml, view.previewHtml]))
  assert.match(sequential[0].bodyHtml, /<b>raw<\/b>/, 'alpha body keeps raw HTML')
  assert.doesNotMatch(sequential[1].bodyHtml, /<b>raw<\/b>/, 'beta body uses the sanitizing comment recipe')
  assert.ok(sequential[0].previewHtml.length < sequential[1].previewHtml.length, 'alpha preview budget is shorter')
  await runtime.dispose()
})

test('H05 recipe validation: stage order, duplicate plugins, option schemas and defaults, unknown contract', async () => {
  const runtime = createRuntime({ services: [PipelineBuilder, ...STAGE_FACTORIES] })
  const env = await runtime.enter(define.entry('builder-only', { requires: { pipelines: PipelineBuilder } }))
  const builder = await env.deps.pipelines.load()
  const body = bodyRecipe()
  const swap = (document, i, j) => ({ ...document, stages: document.stages.map((stage, index) => index === i ? document.stages[j] : index === j ? document.stages[i] : stage) })
  await assert.rejects(builder.build(swap(body, 0, 1)), error => error instanceof RecipeError && /first stage must be a parse/.test(error.message))
  await assert.rejects(builder.build({ ...body, stages: [...body.stages, body.stages[1]] }), error => /duplicate occurrence key/.test(error.message))
  await assert.rejects(
    builder.build({ ...body, stages: [...body.stages.slice(0, 2), { ...body.stages[1], occurrence: 'gfm-again' }, ...body.stages.slice(2)] }),
    error => /uses remark-gfm twice/.test(error.message),
  )
  await assert.rejects(
    builder.build({ ...body, stages: body.stages.map(stage => stage.occurrence === 'gfm' ? { ...stage, options: { singleTilde: 'yes' } } : stage) }),
    error => /Invalid options for stage gfm/.test(error.message),
  )
  await assert.rejects(
    builder.build({ ...body, stages: body.stages.map(stage => stage.occurrence === 'gfm' ? { ...stage, optionsVersion: 2 } : stage) }),
    error => /options version 2/.test(error.message),
  )
  await assert.rejects(builder.build({ formatVersion: 2, name: 'x', stages: [] }), RecipeError)
  const defaulted = await builder.build({ ...body, stages: body.stages.map(stage => stage.occurrence === 'gfm' ? { ...stage, options: {} } : stage) })
  assert.equal(defaulted.stages.length, 5)
  await runtime.dispose()
})

test('R3 untrusted policy: a rehype stage after the recipe\'s sanitizer cannot re-introduce script under `untrusted`; the same recipe as `trusted` keeps it', async () => {
  const runtime = createRuntime({ services: [PipelineBuilder, Renderer, ...STAGE_FACTORIES, EvilRehypeFactory] })
  const env = await runtime.enter(RenderInfrastructureEntry)
  const builder = await env.deps.pipelines.load()
  const evilComment = withEvilStage(commentRecipe())
  const trusted = await builder.build(evilComment)
  const untrustedPipe = await builder.build(evilComment, { trust: 'untrusted' })
  assert.equal(builder.stats.builds, 2, 'trust is part of the cache key')
  assert.equal(trusted.trust, 'trusted')
  assert.equal(untrustedPipe.trust, 'untrusted')
  const trustedHtml = await trusted.process('hi [x](https://ext.test/)')
  assert.match(trustedHtml, /<script>alert\(1\)<\/script>/, 'as written, the late stage injects script')
  assert.match(trustedHtml, /onerror/i)
  const untrustedHtml = await untrustedPipe.process('hi [x](https://ext.test/)')
  assert.doesNotMatch(untrustedHtml, /<script|onerror/i, 'the appended final sanitizer strips what the late stage injected')
  assert.match(untrustedHtml, /rel="nofollow noopener ugc" target="_blank"/, 'the platform link attributes survive the final sanitizer')
  assert.deepEqual(untrustedPipe.stages.map(stage => stage.occurrence), ['parse', 'gfm', 'bridge', 'sanitize', 'links', 'evil', UNTRUSTED_SANITIZE_OCCURRENCE, 'compile'])
  assert.equal(untrustedPipe.stages.at(-2).appended, true)
  assert.equal(untrustedPipe.stages.at(-2).pluginId, 'rehype-sanitize')

  // A recipe with no sanitizer and raw HTML enabled (the trusted body recipe): under `untrusted`
  // raw HTML is turned off at the bridge and the compiler, and a sanitizer is appended.
  const bodyUntrusted = await builder.build(withEvilStage(bodyRecipe()), { trust: 'untrusted' })
  const html = await bodyUntrusted.process('<b onclick="x()">raw</b> <script>alert(3)</script> *ok* [x](https://ext.test/)')
  assert.doesNotMatch(html, /<script|onclick|onerror|<b/i, 'raw HTML is dropped at the bridge; the injected script and handler are stripped by the appended sanitizer')
  assert.match(html, /<em>ok<\/em>/)
  assert.match(html, /<img src="x">/, 'the injected image survives without its handler (images are allowed by the platform schema)')
  assert.ok(bodyUntrusted.stages.some(stage => stage.appended))
  // The recipe's own last rehype stage is the sanitizer: nothing is appended.
  const sanitizerLast = { ...commentRecipe(), stages: commentRecipe().stages.filter(stage => stage.occurrence !== 'links') }
  const plain = await builder.build(sanitizerLast, { trust: 'untrusted' })
  assert.ok(!plain.stages.some(stage => stage.appended))
  assert.doesNotMatch(await plain.process(untrusted), /<script|onerror|<img/)
  await runtime.dispose()

  // Without any admitted sanitizer, an untrusted build is refused explicitly; trusted builds still work.
  const bare = createRuntime({ services: [PipelineBuilder, ...STAGE_FACTORIES.filter(factory => factory !== RehypeSanitizeFactory)] })
  const bareEnv = await bare.enter(define.entry('builder-only-bare', { requires: { pipelines: PipelineBuilder } }))
  const bareBuilder = await bareEnv.deps.pipelines.load()
  await assert.rejects(bareBuilder.build(bodyRecipe(), { trust: 'untrusted' }), error => error instanceof RecipeError && /sanitizer role/.test(error.message))
  assert.ok(await bareBuilder.build(bodyRecipe()))
  await bare.dispose()
})

test('R2 the pipeline cache is a bounded LRU keyed by (trust, recipe); key order does not matter; failed builds are not kept', async () => {
  const runtime = createRuntime({ services: [PipelineBuilder, ...STAGE_FACTORIES] })
  const env = await runtime.enter(define.entry('builder-only-lru', { requires: { pipelines: PipelineBuilder } }))
  const builder = await env.deps.pipelines.load()
  assert.equal(builder.stats.maxEntries, PIPELINE_CACHE_MAX_ENTRIES)
  const body = bodyRecipe()
  const reordered = { stages: body.stages.map(stage => ({ options: stage.options, optionsVersion: stage.optionsVersion, ref: stage.ref, occurrence: stage.occurrence })), name: body.name, formatVersion: body.formatVersion }
  await builder.build(body)
  await builder.build(reordered)
  assert.deepEqual({ builds: builder.stats.builds, cacheHits: builder.stats.cacheHits, entries: builder.stats.entries }, { builds: 1, cacheHits: 1, entries: 1 })
  for (let index = 0; index < PIPELINE_CACHE_MAX_ENTRIES; index += 1) await builder.build({ ...body, name: `body-${index}` })
  assert.equal(builder.stats.entries, PIPELINE_CACHE_MAX_ENTRIES)
  assert.equal(builder.stats.evictions, 1, 'the original body, least recently used, was dropped')
  await builder.build(body)
  assert.equal(builder.stats.builds, PIPELINE_CACHE_MAX_ENTRIES + 2, 'rebuilt after its eviction')
  await builder.build({ ...body, name: 'body-1' }) // a hit makes it the most recently used
  await builder.build({ ...body, name: 'extra' })
  const builds = builder.stats.builds
  await builder.build({ ...body, name: 'body-1' })
  assert.equal(builder.stats.builds, builds, 'body-1 survived (recently used); another entry went')
  assert.equal(builder.stats.entries, PIPELINE_CACHE_MAX_ENTRIES)
  const bad = { ...body, stages: body.stages.map(stage => stage.occurrence === 'gfm' ? { ...stage, options: { singleTilde: 'yes' } } : stage) }
  await assert.rejects(builder.build(bad), RecipeError)
  await assert.rejects(builder.build(bad), RecipeError)
  assert.equal(builder.stats.entries, PIPELINE_CACHE_MAX_ENTRIES, 'a failed build holds no entry')
  await runtime.dispose()
})

test('R4 the renderer never emits an unsafe navigation href or a non-color accent, even from a configuration that bypassed validation', async () => {
  const runtime = createRuntime({ services: [PipelineBuilder, Renderer, ...STAGE_FACTORIES] })
  const env = await runtime.enter(RenderInfrastructureEntry)
  const renderer = await env.deps.renderer.load()
  const site = {
    ...siteConfig('alpha'),
    theme: { name: 'paper', accent: 'red; } body { display: none }' },
    navigation: [
      { label: 'js', href: 'javascript:alert(1)' },
      { label: 'ok', href: '/about' },
      { label: 'ext', href: 'https://example.test/' },
      { label: 'proto', href: '//evil.test/' },
      { label: 'data', href: 'data:text/html,x' },
      { label: 'backslash', href: '/\\evil.test/' },
    ],
  }
  const page = renderer.renderNotFound(site, '/x')
  assert.match(page.html, new RegExp(`--accent:${DEFAULT_ACCENT}`))
  assert.doesNotMatch(page.html, /display: none/)
  assert.match(page.html, /<a href="#">js<\/a>/)
  assert.match(page.html, /<a href="\/about">ok<\/a>/)
  assert.match(page.html, /<a href="https:\/\/example.test\/">ext<\/a>/)
  assert.match(page.html, /<a href="#">proto<\/a>/)
  assert.match(page.html, /<a href="#">data<\/a>/)
  assert.match(page.html, /<a href="#">backslash<\/a>/, 'a backslash spelling of a protocol-relative URL is not a site-relative href')
  const good = renderer.renderNotFound(siteConfig('alpha'), '/x')
  assert.match(good.html, /--accent:#3366cc/)
  for (const color of ['#3366cc', '#000', '#abcd', '#aabbccdd', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'hsl(120 50% 50%)', 'RebeccaPurple', 'transparent']) assert.equal(isCssColor(color), true, color)
  for (const bad of ['red;', 'url(x)', 'rgb(a)', 'expression(1)', '#12', '', 'red }']) assert.equal(isCssColor(bad), false, bad)
  for (const href of ['/', '/a/b?c=1#x', './x', '../x', 'posts/x', '#top', 'https://a.test/', 'HTTP://a.test', 'mailto:a@b.test']) assert.equal(isSafeHref(href), true, href)
  // Browsers resolve `/\host`, `\\host` and `\/host` as `//host` (WHATWG URL): every backslash is refused (audit 3, F-AP3-02).
  for (const href of ['javascript:alert(1)', 'JAVASCRIPT:x', 'data:text/html,x', 'vbscript:x', '//evil.test', 'a b', '', 'ftp://x', '/\\evil.test/', '\\\\evil.test', '\\/evil.test', '/a\\b']) assert.equal(isSafeHref(href), false, href)
  await runtime.dispose()
})

test('H07 recipes round-trip through JSON, resolve inside the saved version intent, upgrade in a new Runtime and fail explicitly without the family', async () => {
  const serialized = JSON.stringify(defaultRecipes())
  const parsed = JSON.parse(serialized)
  for (const role of ['body', 'comment', 'preview']) parseRecipeDocument(parsed[role])
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(defaultRecipes())))

  // Two admitted revisions of the gfm family; the saved ref keeps the user's intent; the resolved version is diagnostics.
  const gfmNext = definePackage({ name: '@syna-app/multitenant-blog', version: '0.2.0', syna: { id: 'hyla.mini' } })
    .service('remark-gfm-factory', { provides: [MarkdownStageFactoryContract], setup: () => (RemarkGfmFactory.setup({}, { signal: new AbortController().signal, onDispose() {} })) })
  const runtime = createRuntime({ services: [PipelineBuilder, ...STAGE_FACTORIES, gfmNext] })
  const env = await runtime.enter(define.entry('builder-multi', { requires: { pipelines: PipelineBuilder } }))
  const builder = await env.deps.pipelines.load()
  const saved = parseRecipeDocument(parsed.body)
  const gfmStage = saved.stages.find(stage => stage.occurrence === 'gfm')
  assert.equal(gfmStage.ref.range, '^0.1.0', 'saved intent is the caret of the version that authored it')
  const built = await builder.build(saved)
  assert.equal(built.stages.find(stage => stage.occurrence === 'gfm').resolvedVersion, '0.1.0', '^0.1.0 does not reach 0.2.0')
  const widened = { ...saved, stages: saved.stages.map(stage => stage.occurrence === 'gfm' ? { ...stage, ref: { ...stage.ref, range: '>=0.1.0 <1' } } : stage) }
  assert.equal((await builder.build(widened)).stages.find(stage => stage.occurrence === 'gfm').resolvedVersion, '0.2.0', 'a user range that admits the upgrade resolves to it')
  assert.deepEqual(runtime.catalog.revisions(RemarkGfmFactory.family), ['0.2.0', '0.1.0'])
  assert.equal(gfmStage.ref.familyId, RemarkGfmFactory.family.id, 'exported names carry no version')
  await runtime.dispose()

  const withoutGfm = createRuntime({ services: [PipelineBuilder, ...STAGE_FACTORIES.filter(factory => factory !== RemarkGfmFactory)] })
  const bare = await withoutGfm.enter(define.entry('builder-bare', { requires: { pipelines: PipelineBuilder } }))
  await assert.rejects((await bare.deps.pipelines.load()).build(saved), error => error.code === 'MISSING_IMPLEMENTATION' && /no supplier substitution/.test(error.message))
  await withoutGfm.dispose()

  const viaBinding = StageFactoryRef.to(RemarkParseFactory, '~0.1.0')
  assert.deepEqual(stageRef(RemarkParseFactory, '~0.1.0'), viaBinding)
  assert.throws(() => StageFactoryRef.to(PipelineBuilder), /does not explicitly provide/)
  void RemarkRehypeFactory
  void RehypeStringifyFactory
})

test('F-AP3-01 the appended untrusted sanitizer is a pass of its own even when the recipe\'s sanitizer says finalPass; a sanitizer factory that merges is refused, not trusted', async () => {
  const runtime = createRuntime({ services: [PipelineBuilder, Renderer, ...STAGE_FACTORIES, EvilRehypeFactory] })
  const env = await runtime.enter(RenderInfrastructureEntry)
  const builder = await env.deps.pipelines.load()
  const recipeWith = finalPass => {
    const base = withEvilStage(commentRecipe())
    return { ...base, stages: base.stages.map(stage => (stage.occurrence === 'sanitize' ? { ...stage, options: { ...stage.options, finalPass } } : stage)) }
  }
  for (const finalPass of [false, true]) {
    const pipeline = await builder.build(recipeWith(finalPass), { trust: 'untrusted' })
    const html = await pipeline.process('hi [x](https://ext.test/)')
    assert.doesNotMatch(html, /<script|onerror/i, `recipe sanitizer finalPass=${finalPass}: the appended pass runs last and strips what the late stage injected`)
    assert.match(html, /rel="nofollow noopener ugc" target="_blank"/)
    assert.equal(pipeline.stages.at(-2).occurrence, UNTRUSTED_SANITIZE_OCCURRENCE)
    assert.equal(pipeline.stages.at(-2).appended, true)
  }
  await runtime.dispose()

  // A sanitizer factory that hands unified one plugin identity for every configuration cannot
  // put the appended pass last (unified merges the repeated use into the recipe's own stage):
  // the builder checks that the appended stage added a pass and refuses the build.
  const MergingSanitizeFactory = define.service('merging-sanitize-factory', {
    provides: [MarkdownStageFactoryContract],
    setup() {
      return createFactory(
        { pluginId: 'merging-sanitize', kind: 'rehype', optionsVersion: 1, optionsSchema: { type: 'object', additionalProperties: false, properties: {} }, repeatable: false, sanitizer: { options: {} } },
        () => processor => processor.use(rehypeSanitize, defaultSchema),
      )
    },
  })
  const merging = createRuntime({ services: [PipelineBuilder, ...STAGE_FACTORIES.filter(factory => factory !== RehypeSanitizeFactory), MergingSanitizeFactory, EvilRehypeFactory] })
  const mergingEnv = await merging.enter(define.entry('builder-only-merging', { requires: { pipelines: PipelineBuilder } }))
  const mergingBuilder = await mergingEnv.deps.pipelines.load()
  const base = commentRecipe()
  const recipe = withEvilStage({ ...base, stages: base.stages.map(stage => (stage.occurrence === 'sanitize' ? { ...stage, ref: stageRef(MergingSanitizeFactory), options: {} } : stage)) })
  await assert.rejects(mergingBuilder.build(recipe, { trust: 'untrusted' }), error => error instanceof RecipeError && /did not add a pass of its own/.test(error.message))
  const trusted = await mergingBuilder.build(recipe)
  assert.match(await trusted.process('hi'), /<script>alert\(1\)<\/script>/, 'as written (trusted) the recipe runs; only the untrusted guarantee is refused')
  await merging.dispose()
})
