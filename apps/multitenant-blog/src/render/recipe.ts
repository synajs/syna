import { Ajv, type ValidateFunction } from 'ajv'
import type { RecipeDocument, RecipeStage, StoredImplementationRef } from '../domain/model.js'
import { RECIPE_FORMAT_VERSION, recipeDocumentSchema } from '../domain/recipe-schema.js'
import type { ServiceRevision } from 'syna'
import { StageFactoryRef, type MarkdownStageFactory } from './stages.js'
import {
  RehypeExternalLinksFactory,
  RehypeSanitizeFactory,
  RehypeStringifyFactory,
  RemarkExcerptFactory,
  RemarkGfmFactory,
  RemarkParseFactory,
  RemarkRehypeFactory,
} from './factories.js'

export { RECIPE_FORMAT_VERSION }

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: true })

const validateDocument: ValidateFunction = ajv.compile(recipeDocumentSchema)

export class RecipeError extends Error {
  readonly recipe: string | undefined
  readonly problems: readonly string[]
  constructor(message: string, problems: readonly string[], recipe?: string) {
    super(problems.length > 0 ? `${message}: ${problems.join('; ')}` : message)
    this.name = 'RecipeError'
    this.problems = problems
    this.recipe = recipe
  }
}

/** Structural validation of a recipe document (format, stage shape). Options are validated per factory later. */
export function parseRecipeDocument(input: unknown): RecipeDocument {
  if (!validateDocument(input)) {
    const problems = (validateDocument.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
    throw new RecipeError('Invalid recipe document', problems)
  }
  const document = input as RecipeDocument
  const seen = new Set<string>()
  for (const stage of document.stages) {
    if (seen.has(stage.occurrence)) {
      throw new RecipeError('Invalid recipe document', [`duplicate occurrence key ${stage.occurrence}`], document.name)
    }
    seen.add(stage.occurrence)
  }
  return document
}

/** Compiles a JSON schema once per factory and validates/defaults options. */
const optionValidators = new WeakMap<MarkdownStageFactory, ValidateFunction>()
export function validateStageOptions(
  factory: MarkdownStageFactory,
  stage: RecipeStage,
): Readonly<Record<string, unknown>> {
  if (stage.optionsVersion !== factory.optionsVersion) {
    throw new RecipeError(
      `Stage ${stage.occurrence} (${factory.pluginId}) uses options version ${stage.optionsVersion}, but the admitted factory speaks version ${factory.optionsVersion}`,
      ['no automatic option migration is attempted; re-save the recipe for the new options version'],
    )
  }
  const cached = optionValidators.get(factory)
  const validate: ValidateFunction = cached ?? ajv.compile(factory.optionsSchema)
  if (!cached) optionValidators.set(factory, validate)
  const options = structuredClone(stage.options) as Record<string, unknown>
  if (!validate(options)) {
    const problems = (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
    throw new RecipeError(`Invalid options for stage ${stage.occurrence} (${factory.pluginId})`, problems)
  }
  return Object.freeze(options)
}

export function stageRef(factory: ServiceRevision<MarkdownStageFactory>, version?: string): StoredImplementationRef {
  return StageFactoryRef.to(factory, version)
}

function stage(
  occurrence: string,
  factory: ServiceRevision<MarkdownStageFactory>,
  options: Readonly<Record<string, unknown>> = {},
): RecipeStage {
  return { occurrence, ref: stageRef(factory), optionsVersion: 1, options }
}

/** Article bodies: trusted authors, raw HTML allowed, GFM. */
export function bodyRecipe(): RecipeDocument {
  return {
    formatVersion: RECIPE_FORMAT_VERSION,
    name: 'body',
    stages: [
      stage('parse', RemarkParseFactory),
      stage('gfm', RemarkGfmFactory, { singleTilde: true }),
      stage('bridge', RemarkRehypeFactory, { allowDangerousHtml: true }),
      stage('links', RehypeExternalLinksFactory, { rel: ['noopener'] }),
      stage('compile', RehypeStringifyFactory, { allowDangerousHtml: true }),
    ],
  }
}

/** Comments: untrusted input. Sanitize runs on hast BEFORE any later rehype plugin, and raw HTML is never passed through. */
export function commentRecipe(): RecipeDocument {
  return {
    formatVersion: RECIPE_FORMAT_VERSION,
    name: 'comment',
    stages: [
      stage('parse', RemarkParseFactory),
      stage('gfm', RemarkGfmFactory, { singleTilde: false }),
      stage('bridge', RemarkRehypeFactory, { allowDangerousHtml: false }),
      stage('sanitize', RehypeSanitizeFactory, { allowImages: false }),
      stage('links', RehypeExternalLinksFactory, { rel: ['nofollow', 'noopener', 'ugc'] }),
      stage('compile', RehypeStringifyFactory, { allowDangerousHtml: false }),
    ],
  }
}

/** Previews: excerpt of the body, sanitized, no raw HTML. */
export function previewRecipe(maxCharacters = 160): RecipeDocument {
  return {
    formatVersion: RECIPE_FORMAT_VERSION,
    name: 'preview',
    stages: [
      stage('parse', RemarkParseFactory),
      stage('excerpt', RemarkExcerptFactory, { maxCharacters }),
      stage('bridge', RemarkRehypeFactory, { allowDangerousHtml: false }),
      stage('sanitize', RehypeSanitizeFactory, { allowImages: false }),
      stage('compile', RehypeStringifyFactory, { allowDangerousHtml: false }),
    ],
  }
}

export function defaultRecipes(): { body: RecipeDocument; comment: RecipeDocument; preview: RecipeDocument } {
  return { body: bodyRecipe(), comment: commentRecipe(), preview: previewRecipe() }
}
