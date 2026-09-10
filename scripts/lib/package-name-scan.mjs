// The package identity scan (1.0.0-rc.1, the first public candidate): the current line installs and imports `syna`,
// and its TypeScript presets are `@synajs/tsconfig`. The temporary identities the runtime was developed under —
// `@syna/core` and `@syna/tsconfig` — are not rewritten out of the record: the history, the migrations, the recorded
// gate runs, the ledgers under work/ and the benchmark records keep them, because they are their subject.
//
// What this scan asserts is narrower and is the thing that can rot: no *current* file — sources, examples, fixtures,
// the reference application, the release tooling, package metadata, the current documents — recommends a package that
// will not exist on the registry. Two lines of the current line are the old names on purpose, and both are allowed by
// literal so that the exception stays visible in every run:
//
//   - the runtime's own nominal package identity (`packages/core/src/runtime.ts`). It is serialized — it names the
//     internal derive Entry — so it is frozen for the same reason every other identity is: the npm specifier changed,
//     the runtime identity did not (docs/API_STABILITY.md).
//   - the sentence in `docs/API_STABILITY.md` that says under which name the frozen surface was developed.
//
// A line that has to spell an earlier name to explain the rename — the paragraph of docs/API_STABILITY.md that records
// which names the earlier candidates were validated under, the comment of the gate step, the sentence the validation
// document generates about it — carries the marker `syna-public-rename`, the idiom the earlier renames used
// (`syna-v05-compat`, `syna-v08-rename`, scripts/tests/no-old-names.test.mjs). Marked lines are listed in every run too.
//
// The shape follows scripts/lib/vendor-name-scan.mjs: same walk, same allow-by-literal, same visibility.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** Directories that are records, generated or not ours: never scanned. */
export const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-local', '.git', 'work', 'coverage'])

/** Files whose subject is the earlier identity: records are not rewritten. */
export const HISTORICAL_FILES = [
  /^validation\/v[^/]+\//,
  /^docs\/audit\//,
  /^docs\/(AUDIT|ADVERSARIAL_AUDIT|HISTORY|VALIDATION)\.md$/,
  /^docs\/(MIGRATION_V\d+_TO_V\d+|SEMANTIC_CHANGES_(V\d+|RC\d+))\.md$/,
  /^CHANGELOG\.md$/,
  /^RELEASE_MANIFEST\.json$/,
  // The profiles and the recorded benchmark baselines of the releases made under the earlier identity.
  /^scripts\/release-profiles\/(0\.\d+\.\d+|1\.0\.0-rc\.[1-5])\.json$/,
  /^benchmarks\/results-v(0\.[0-9.]+|1\.0\.0-rc\.[1-5])(-[a-z0-9-]+)?\.json$/,
  // The task-document package that ships with the workspace.
  /^(SHA256SUMS\.txt|START_HERE_ZH\.md|CLAUDE_CODE_RESEARCH\.md|SYNA_V05_EXECUTION_PROMPT\.md|SYNA_V05_GOAL\.txt)$/,
  // This scan and its test spell the names they look for.
  /^scripts\/lib\/package-name-scan\.mjs$/,
  /^scripts\/tests\/no-legacy-package-names\.test\.mjs$/,
]

/** A line that spells an earlier name on purpose, to explain the rename, carries this marker. */
export const MARKER = 'syna-public-rename'

/** The temporary identities, and what the current line uses instead. */
export const PATTERNS = [
  { name: '@syna/core', pattern: /@syna\/core/, replacement: 'syna' },
  { name: '@syna/tsconfig', pattern: /@syna\/tsconfig/, replacement: '@synajs/tsconfig' },
]

/** The two places where an old name is the current truth, longest literal first (a line is stripped in this order). */
export const ALLOWED_LITERALS = [
  { literal: "id: '@syna/core/entry/derive/v1'", reason: "the id of the runtime's internal derive Entry: serialized, frozen with every other identity" },
  { literal: 'developed and validated under the temporary name `@syna/core`', reason: 'docs/API_STABILITY.md: the name the frozen surface was developed under' },
  { literal: "name: '@syna/core'", reason: "the runtime's own nominal package identity, unchanged by the npm rename" },
  { literal: "id: '@syna/core'", reason: "the id of the runtime's own nominal package, unchanged by the npm rename" },
]

const TEXT_EXTENSIONS = new Set(['.ts', '.mjs', '.js', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt', '.npmrc', '.gitignore'])

function isText(file) {
  const base = path.basename(file)
  return TEXT_EXTENSIONS.has(path.extname(file)) || TEXT_EXTENSIONS.has(base) || base === 'LICENSE'
}

export function isHistorical(relative) {
  return HISTORICAL_FILES.some(pattern => pattern.test(relative))
}

/** Every scanned file of the current line, relative to `root`, sorted. */
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

/** @returns {{ files: string[], hits: object[], allowed: object[], marked: { file: string, line: number }[] }} */
export function scanPackageNames(root) {
  const files = scannedFiles(root)
  const literals = [...ALLOWED_LITERALS].sort((a, b) => b.literal.length - a.literal.length)
  const hits = []
  const allowed = []
  const marked = []
  for (const file of files) {
    let content
    try { content = readFileSync(path.join(root, file), 'utf8') }
    catch { continue }
    if (statSync(path.join(root, file)).size > 4 * 1024 * 1024) continue
    content.split('\n').forEach((line, index) => {
      for (const { name, pattern } of PATTERNS) {
        if (!pattern.test(line)) continue
        if (line.includes(MARKER)) {
          if (!marked.some(item => item.file === file && item.line === index + 1)) marked.push({ file, line: index + 1 })
          continue
        }
        let rest = line
        const used = []
        for (const item of literals) {
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
  return { files, hits, allowed, marked }
}
