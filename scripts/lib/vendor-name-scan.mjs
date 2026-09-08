// The vendor-name scan (1.0.0-rc.2, docs/EXAMPLES.md): the examples use fictional names; a real product's name appears
// only where the code really interacts with that product. Three names are scanned for as component names or paths —
// `OpenAI` and `Claude`, the vendors the pre-rc.2 fixtures were named after, and `hyla-mini`, the pre-rc.2 name of the
// reference application (apps/multitenant-blog since rc.2) — over every tracked file of the current line. Historical
// documents, the ledgers, the recorded evidence and the earlier gates keep their wording: records are not rewritten.
//
// The reference application's behaviour is unchanged line for line by the rename (its `syna.id`, its on-disk manifest
// tag, its advisory-lock namespaces and its error-log prefixes are what they were); those literals are data the scan
// allows by name, and every allowed hit is reported so the allow-list stays visible.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** Directories that are records or generated: never scanned. */
export const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-local', '.git', 'work', 'coverage'])

/** Historical documents and records of earlier releases: the old names are their subject. */
export const HISTORICAL_FILES = [
  // The recorded gate runs (validation/README.md, which describes them, is current).
  /^validation\/v[^/]+\//,
  /^docs\/audit\//,
  /^docs\/(AUDIT|ADVERSARIAL_AUDIT|HISTORY|VALIDATION)\.md$/,
  /^docs\/(MIGRATION_V\d+_TO_V\d+|SEMANTIC_CHANGES_V\d+)\.md$/,
  /^CHANGELOG\.md$/,
  /^RELEASE_MANIFEST\.json$/,
  // The profiles of earlier releases: the step names they record are the ones those releases ran
  // (scripts/release-profiles/README.md). The current release's profile is scanned like any other file.
  /^scripts\/release-profiles\/(0\.\d+\.\d+|1\.0\.0-rc\.[1-4])\.json$/,
  /^scripts\/any-baseline-v0\.\d\.\d\.json$/,
  /^benchmarks\/results-v0\.[0-9.]+(-[a-z0-9-]+)?\.json$/,
  // The task-document package that ships with the workspace (listed in the root SHA256SUMS.txt) and the task books.
  /^(SHA256SUMS\.txt|START_HERE_ZH\.md|CLAUDE_CODE_RESEARCH\.md|SYNA_V05_EXECUTION_PROMPT\.md|SYNA_V05_GOAL\.txt)$/,
  // This scan and its test spell the names they look for.
  /^scripts\/lib\/vendor-name-scan\.mjs$/,
  /^scripts\/tests\/no-vendor-names\.test\.mjs$/,
]

/** The names, as component names or paths. */
export const PATTERNS = [
  { name: 'OpenAI', pattern: /openai/i },
  { name: 'Claude', pattern: /\bclaude\b/i },
  { name: 'hyla-mini', pattern: /hyla[-_]mini/i },
]

/**
 * Literals of the reference application that the rename left as they are (behaviour, not names): the static build
 * manifest tag, the PostgreSQL advisory-lock namespaces and the error-log prefixes, in the sources and where the
 * application document and its tests describe them.
 */
export const ALLOWED_LITERALS = [
  { literal: "builder: 'hyla-mini'", reason: 'the tag of a static build manifest this builder wrote (on disk)' },
  { literal: "record.builder !== 'hyla-mini'", reason: 'the same tag, checked when a previous build is recognised' },
  { literal: 'builder "hyla-mini"', reason: 'the same tag, named in the BAD_MANIFEST message and the document' },
  { literal: 'builder: "hyla-mini"', reason: 'the same tag, named in the document' },
  { literal: 'hyla-mini:tenant:', reason: 'the per-tenant advisory-lock namespace (PostgreSQL)' },
  { literal: 'hyla-mini:domain:', reason: 'the per-host advisory-lock namespace (PostgreSQL)' },
  { literal: 'hyla-mini:migrations:', reason: 'the migration advisory-lock namespace (PostgreSQL)' },
  { literal: '[hyla-mini http]', reason: 'the error-log prefix of the HTTP server' },
  { literal: '[hyla-mini static]', reason: 'the error-log prefix of the static server' },
  { literal: '[hyla-mini sites]', reason: 'the error-log prefix of the site manager' },
  { literal: 'hyla_mini', reason: 'the default PostgreSQL schema name of the application' },
]

const TEXT_EXTENSIONS = new Set(['.ts', '.mjs', '.js', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt', '.npmrc', '.gitignore'])

function isText(file) {
  const base = path.basename(file)
  return TEXT_EXTENSIONS.has(path.extname(file)) || TEXT_EXTENSIONS.has(base) || base === 'LICENSE'
}

export function isHistorical(relative) {
  return HISTORICAL_FILES.some(pattern => pattern.test(relative))
}

/** Every scanned file of the tree, relative to `root`, sorted. */
export function scannedFiles(root) {
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name === '.DS_Store') continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && isText(full)) {
        const relative = path.relative(root, full)
        if (!isHistorical(relative)) files.push(relative)
      }
    }
  }
  walk(root)
  return files.sort()
}

/** @returns {{ files: string[], hits: { file: string, line: number, name: string, text: string }[], allowed: { file: string, line: number, literal: string, reason: string }[] }} */
export function scanVendorNames(root) {
  const files = scannedFiles(root)
  const hits = []
  const allowed = []
  for (const file of files) {
    let content
    try { content = readFileSync(path.join(root, file), 'utf8') }
    catch { continue }
    if (statSync(path.join(root, file)).size > 4 * 1024 * 1024) continue
    content.split('\n').forEach((line, index) => {
      for (const { name, pattern } of PATTERNS) {
        if (!pattern.test(line)) continue
        // A line may carry only allowed literals of that name: strip them and test again.
        let rest = line
        const used = []
        for (const item of ALLOWED_LITERALS) {
          if (rest.includes(item.literal)) { used.push(item); rest = rest.split(item.literal).join('') }
        }
        if (used.length > 0 && !pattern.test(rest)) {
          for (const item of used) allowed.push({ file, line: index + 1, literal: item.literal, reason: item.reason })
          continue
        }
        hits.push({ file, line: index + 1, name, text: line.trim().slice(0, 160) })
      }
    })
  }
  return { files, hits, allowed }
}
