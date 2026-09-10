/**
 * Fixtures that VIOLATE the Hyla plugin protocol on purpose. They are exported
 * for tests and preflight demonstrations; a deployment must never admit them.
 */
import remarkGfm from 'remark-gfm'
import { define } from '../syna.js'
import { MarkdownStageFactoryContract, createFactory } from '../render/stages.js'
import { CurrentRequest, SiteSnapshot } from '../site/inputs.js'
import { PipelineBuilder } from '../render/pipeline.js'
import { Renderer, type Renderer as RendererApi } from '../render/renderer.js'
import { SiteContext } from '../site/context.js'
import { RequestHandler, type RequestHandler as RequestHandlerApi } from '../site/request.js'
import type { ServiceRevision } from 'syna'

/** A shared factory that reads the current request: refused by the render-infrastructure preflight. */
export const RequestAwareStageFactory = define.service('request-aware-stage-factory', {
  provides: [MarkdownStageFactoryContract],
  requires: { request: CurrentRequest },
  setup({ request }) {
    const facts = request.read()
    return createFactory(
      { pluginId: 'request-aware-gfm', kind: 'transform', optionsVersion: 1, optionsSchema: { type: 'object', additionalProperties: false, properties: {} }, repeatable: false },
      () => processor => processor.use(remarkGfm, { singleTilde: facts.path.length % 2 === 0 }),
    )
  },
})

/** A renderer replacement that reads the site snapshot: plans, but forks per site and breaks the site budget. */
export const SiteAwareRenderer = define.service('site-aware-renderer', {
  requires: { pipelines: PipelineBuilder, snapshot: SiteSnapshot },
  async setup({ pipelines }): Promise<RendererApi> {
    const real = await Renderer.setup({ pipelines } as never, { signal: new AbortController().signal, onDispose() {} })
    return real
  },
})

/** Closure-pollution probe: a factory whose configure() mutates shared module state. Tests assert the protocol test catches it. */
export const pollutionLog: string[] = []
export const PollutingStageFactory = define.service('polluting-stage-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    let lastOptions: Record<string, unknown> = {}
    return createFactory(
      { pluginId: 'polluting-gfm', kind: 'transform', optionsVersion: 1, optionsSchema: { type: 'object', additionalProperties: false, properties: { tag: { type: 'string', default: 'a' } } }, repeatable: false },
      options => {
        lastOptions = { ...options } // shared across products: a protocol violation
        return processor => processor.use(remarkGfm, { singleTilde: String(lastOptions.tag).length > 0 }).use(() => () => { pollutionLog.push(String(lastOptions.tag)) })
      },
    )
  },
})

/**
 * A request handler replacement that drags a chain of ten request-scoped
 * helpers into every request: the infrastructure and site worlds plan and stay
 * inside their budgets, the request world breaks `REQUEST_BUDGET.maxLocalServices`.
 * Refused by the request preflight that `createHylaApp()` runs at startup.
 */
export const HeavyRequestHandler = define.service('heavy-request-handler', {
  requires: { request: CurrentRequest, context: SiteContext, helpers: requestHelperChain(10) },
  async setup({ request, context }, host): Promise<RequestHandlerApi> {
    return RequestHandler.setup({ request, context } as never, host)
  },
})

function requestHelperChain(depth: number): ServiceRevision<{ readonly depth: number }, unknown> {
  let chain: ServiceRevision<{ readonly depth: number }, unknown> = define.service('request-helper-1', {
    requires: { request: CurrentRequest },
    setup: () => ({ depth: 1 }),
  })
  for (let level = 2; level <= depth; level += 1) {
    const next = chain
    chain = define.service(`request-helper-${level}`, {
      requires: { request: CurrentRequest, next },
      setup: () => ({ depth: level }),
    })
  }
  return chain
}
