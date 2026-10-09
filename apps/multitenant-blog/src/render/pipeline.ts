import { unified, type Processor } from 'unified'
import type { ImplementationSet } from 'synajs'
import type { RecipeDocument, RecipeStage } from '../domain/model.js'
import { define } from '../syna.js'
import { RecipeError, parseRecipeDocument, validateStageOptions } from './recipe.js'
import { MarkdownStageFactoryContract, STAGE_ORDER, type MarkdownStageFactory, type StageKind } from './stages.js'

/**
 * Who wrote the Markdown. `trusted` builds the recipe as written (article
 * bodies by the site's authors). `untrusted` (comments, previews of foreign
 * input) applies the platform policy on top of the recipe: raw HTML never
 * passes the bridge or the compiler, and a sanitizing factory is the last
 * rehype stage, appended when the recipe does not end its rehype stages with
 * one. A stage registered after the recipe's own sanitizer therefore cannot
 * re-introduce script or event handlers.
 */
export type RecipeTrust = 'trusted' | 'untrusted'

export interface PipelineBuildOptions {
  readonly trust?: RecipeTrust
}

/** Distinct (trust, recipe) pairs kept as built processors; the least recently used is dropped beyond this. */
export const PIPELINE_CACHE_MAX_ENTRIES = 64

/** Occurrence key of the sanitizer the builder appends to an untrusted pipeline. */
export const UNTRUSTED_SANITIZE_OCCURRENCE = 'untrusted-sanitize'

export interface BuiltStage {
  readonly occurrence: string
  readonly pluginId: string
  readonly kind: StageKind
  /** The exact factory revision this build resolved to (diagnostics; the recipe keeps the user's intent). */
  readonly resolvedVersion: string
  /** True for the stage the untrusted policy appended (not part of the recipe). */
  readonly appended?: boolean
}

export interface BuiltPipeline {
  readonly name: string
  readonly trust: RecipeTrust
  readonly stages: readonly BuiltStage[]
  /** Renders Markdown to an HTML fragment. Safe to call concurrently; the processor is frozen. */
  process(markdown: string): Promise<string>
}

export interface PipelineBuilderStats {
  /** Pipelines built (cache misses). */
  readonly builds: number
  readonly cacheHits: number
  readonly entries: number
  readonly evictions: number
  readonly maxEntries: number
}

export interface PipelineBuilder {
  build(document: unknown, options?: PipelineBuildOptions): Promise<BuiltPipeline>
  readonly stats: PipelineBuilderStats
  /** `configure()` counts of every admitted factory, for sharing proofs. */
  factoryStats(): Promise<Readonly<Record<string, number>>>
  /**
   * One token per admitted factory instance (minted at its setup). Equal across
   * recipes and requests of one Runtime, different between Runtimes: the
   * sharing proof that needs no module-global counter.
   */
  factoryInstances(): Promise<Readonly<Record<string, string>>>
}

function assertStageOrder(name: string, kinds: readonly StageKind[]): void {
  const problems: string[] = []
  const count = (kind: StageKind) => kinds.filter(item => item === kind).length
  if (kinds[0] !== 'parse') problems.push('the first stage must be a parse stage')
  if (kinds.at(-1) !== 'compile') problems.push('the last stage must be a compile stage')
  for (const kind of ['parse', 'bridge', 'compile'] as const) {
    if (count(kind) !== 1) problems.push(`exactly one ${kind} stage is required (found ${count(kind)})`)
  }
  let rank = -1
  for (const kind of kinds) {
    const next = STAGE_ORDER.indexOf(kind)
    if (next < rank) problems.push(`stage kind ${kind} appears after a later kind`)
    rank = Math.max(rank, next)
  }
  if (problems.length > 0) throw new RecipeError(`Recipe ${name} has an invalid stage order`, problems, name)
}

/** JSON with sorted object keys: the same recipe spelled in another key order is the same cache entry. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

interface ResolvedStage {
  readonly factory: MarkdownStageFactory
  readonly version: string
  readonly occurrence: string
  readonly stage: RecipeStage
  readonly appended: boolean
}

/**
 * Builds unified processors from JSON recipes using the shared factory
 * collection. Building produces independent processor products; the factory
 * Service slots are shared across recipes, sites and requests. Built pipelines
 * are cached per (trust, recipe) in a bounded LRU: a tenant that keeps saving
 * new recipes cannot grow the app world without limit.
 */
export const PipelineBuilder = define.service('pipeline-builder', {
  provides: [],
  requires: { factories: MarkdownStageFactoryContract.all },
  async setup({ factories }): Promise<PipelineBuilder> {
    const set: ImplementationSet<typeof MarkdownStageFactoryContract> = await factories.load()
    const cache = new Map<string, Promise<BuiltPipeline>>() // insertion order = recency
    let builds = 0
    let cacheHits = 0
    let evictions = 0

    const loadAll = async () => Promise.all(set.candidates.map(async candidate => ({ candidate, factory: await set.load(candidate) })))

    let sanitizer: Promise<{ factory: MarkdownStageFactory; version: string } | undefined> | undefined
    /** The admitted sanitizing factory the untrusted policy appends (the first in candidate order; the set is fixed per Runtime). */
    const platformSanitizer = () => {
      sanitizer ??= loadAll().then(loaded => {
        const found = loaded.find(item => item.factory.sanitizer !== undefined)
        return found ? { factory: found.factory, version: found.candidate.version } : undefined
      })
      return sanitizer
    }

    const buildUncached = async (document: RecipeDocument, trust: RecipeTrust): Promise<BuiltPipeline> => {
      builds += 1
      const resolved: ResolvedStage[] = []
      for (const stage of document.stages) {
        if (stage.ref.contractId !== MarkdownStageFactoryContract.id) {
          throw new RecipeError(`Stage ${stage.occurrence} references Contract ${stage.ref.contractId}`, ['only markdown stage factories may appear in a recipe'], document.name)
        }
        const candidate = set.resolve(stage.ref)
        const factory = await set.load(candidate)
        resolved.push({ factory, version: candidate.version, occurrence: stage.occurrence, stage, appended: false })
      }
      if (trust === 'untrusted') {
        // The last rehype stage must be a sanitizer; otherwise the platform's one goes there.
        const lastRehype = [...resolved].reverse().find(item => item.factory.kind === 'rehype')
        if (lastRehype?.factory.sanitizer === undefined) {
          const platform = await platformSanitizer()
          if (!platform) {
            throw new RecipeError(`Recipe ${document.name} cannot be built for untrusted input`, ['no admitted stage factory declares the sanitizer role'], document.name)
          }
          const compileIndex = resolved.findIndex(item => item.factory.kind === 'compile')
          const insertAt = compileIndex >= 0 ? compileIndex : resolved.length
          const stage: RecipeStage = {
            occurrence: UNTRUSTED_SANITIZE_OCCURRENCE,
            ref: document.stages[0]!.ref, // diagnostics only; the factory is already resolved
            optionsVersion: platform.factory.optionsVersion,
            options: platform.factory.sanitizer!.options,
          }
          resolved.splice(insertAt, 0, { factory: platform.factory, version: platform.version, occurrence: UNTRUSTED_SANITIZE_OCCURRENCE, stage, appended: true })
        }
      }
      assertStageOrder(document.name, resolved.map(item => item.factory.kind))
      const seenPlugins = new Set<string>()
      for (const { factory, stage, appended } of resolved) {
        // The appended sanitizer is a pass of its own (SanitizerRole); the recipe's own stages may not repeat a plugin.
        if (!appended && seenPlugins.has(factory.pluginId) && !factory.repeatable) {
          throw new RecipeError(
            `Recipe ${document.name} uses ${factory.pluginId} twice`,
            [`stage ${stage.occurrence}: unified would merge repeated .use() settings; the factory is not marked repeatable`],
            document.name,
          )
        }
        seenPlugins.add(factory.pluginId)
      }
      let processor: Processor<any, any, any, any, any> = unified()
      const stages: BuiltStage[] = []
      for (const { factory, version, occurrence, stage, appended } of resolved) {
        let options = validateStageOptions(factory, stage)
        // Untrusted input: raw HTML never passes the bridge or the compiler. `allowDangerousHtml`
        // is the option name of the unified ecosystem; the appended sanitizer is the guarantee
        // for factories that spell it differently.
        if (trust === 'untrusted' && (factory.kind === 'bridge' || factory.kind === 'compile') && options['allowDangerousHtml'] === true) {
          options = Object.freeze({ ...options, allowDangerousHtml: false })
        }
        const attachersBefore = processor.attachers.length
        processor = factory.configure(options).apply(processor)
        if (appended && processor.attachers.length <= attachersBefore) {
          // unified merges a repeated use of one plugin function into the earlier one: a
          // sanitizer whose plugin identity a recipe stage already used would run there,
          // before the stages it is meant to guard. The guarantee is checked, not assumed.
          throw new RecipeError(
            `Recipe ${document.name} cannot be built for untrusted input`,
            [`the sanitizer ${factory.pluginId} appended as the last rehype stage did not add a pass of its own: unified merged it into an earlier use of the same plugin function; a sanitizer factory must give every configuration its own plugin identity`],
            document.name,
          )
        }
        stages.push(Object.freeze({ occurrence, pluginId: factory.pluginId, kind: factory.kind, resolvedVersion: version, ...(appended ? { appended: true } : {}) }))
      }
      processor.freeze()
      return Object.freeze({
        name: document.name,
        trust,
        stages: Object.freeze(stages),
        async process(markdown: string) {
          const file = await processor.process(markdown)
          return String(file)
        },
      })
    }

    return {
      stats: {
        get builds() { return builds },
        get cacheHits() { return cacheHits },
        get entries() { return cache.size },
        get evictions() { return evictions },
        get maxEntries() { return PIPELINE_CACHE_MAX_ENTRIES },
      },
      async factoryStats() {
        const loaded = await loadAll()
        return Object.freeze(Object.fromEntries(loaded.map(({ candidate, factory }) => [`${candidate.familyId}@${candidate.version}`, factory.stats.configured])))
      },
      async factoryInstances() {
        const loaded = await loadAll()
        return Object.freeze(Object.fromEntries(loaded.map(({ candidate, factory }) => [`${candidate.familyId}@${candidate.version}`, factory.stats.instance])))
      },
      build(input, options = {}) {
        const trust: RecipeTrust = options.trust ?? 'trusted'
        let document: RecipeDocument
        try {
          document = parseRecipeDocument(input)
        }
        catch (error) {
          return Promise.reject(error)
        }
        const key = `${trust}|${stableJson(document)}`
        const cached = cache.get(key)
        if (cached) {
          cacheHits += 1
          cache.delete(key)
          cache.set(key, cached) // most recently used
          return cached
        }
        const pending = buildUncached(document, trust)
        cache.set(key, pending)
        pending.then(() => {
          // Only a build that succeeded takes room: a failing one is dropped and evicts nothing.
          if (cache.size > PIPELINE_CACHE_MAX_ENTRIES) {
            const oldest = cache.keys().next().value
            if (oldest !== undefined) {
              cache.delete(oldest)
              evictions += 1
            }
          }
        }, () => cache.delete(key))
        return pending
      },
    }
  },
})
