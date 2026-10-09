#!/usr/bin/env node
// syna-v08-rename: this file spells every pre-0.8 name on purpose — it is the migration.
// Mechanical migration of TypeScript / JavaScript sources from the 0.7 names to the 0.8 names (SYNA v0.8 §2;
// docs/MIGRATION_V07_TO_V08.md has the item table). Syntax-driven (the TypeScript compiler API), with type
// information wherever the program resolves it (the built `synajs`, a consumer's own `dist`) and a name
// heuristic where it does not (an `any`-typed receiver in a test).
//
//   node scripts/codemod-v08.mjs [--dry-run] [--verbose] [--json <report.json>] [<path>...]
//
// Paths (files or directories) default to the workspace consumers: apps, benchmarks, packages/* except core and
// tsconfig, packages/core/tests, scripts (except scripts/tests and this file). `dist`, `node_modules` and `work`
// are never entered. A line carrying `syna-v05-compat`, `syna-v08-rename` or `codemod-v08: skip`, and the lines
// between `codemod-v08: off` and `codemod-v08: on`, are left as they are. Exit 0 when every occurrence was
// rewritten, 2 when sites that need a hand remain (they are listed with the reason); `--dry-run` writes nothing.
// Idempotent: a second run over migrated sources makes 0 edits.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = name => args.includes(name)
const valueOf = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1] }
const dryRun = has('--dry-run')
const verbose = has('--verbose')
const jsonOut = valueOf('--json')
const positionals = args.filter((argument, index) => !argument.startsWith('--') && args[index - 1] !== '--json')

const SELF = 'scripts/codemod-v08.mjs'
const SKIP_DIRS = new Set(['node_modules', 'dist', 'work', '.git'])
const SKIP_PATHS = new Set([SELF, 'scripts/tests'])
const EXTENSIONS = ['.ts', '.mts', '.cts', '.mjs', '.cjs', '.js']
const LINE_MARKERS = ['syna-v05-compat', 'syna-v08-rename', 'codemod-v08: skip']

// ---------------------------------------------------------------------------------------------------------------
// The table (§2). Names that mean one thing wherever they appear are rewritten as tokens (identifiers, property
// names, string literals, comments); the others are rewritten by syntax and type (below).
const TOKENS = [
  ['T1', /\bEnvHandle\b/g, 'Env'],
  ['T2', /\bEntryDescriptor\b/g, 'Entry'],
  ['T3', /\bImplementationDescriptor\b/g, 'ImplementationRecord'],
  ['T4', /\bNodeDisposition\b/g, 'NodePlacement'],
  ['T5', /\bInputType\b/g, 'InputValue'],
  ['F2', /\bparentActiveRevisionKeys\b/g, 'parentActiveRevisionIds'],
  ['F3', /\bselectedKey\b/g, 'selectedRevision'],
  ['F7', /\bpersistentRef\b/g, 'implementationRef'],
  ['F10', /\binternalServices\b/g, 'privateServices'],
  ['F12', /\bbindingsResolved\b/g, 'bindingsAssigned'],
  ['F13', /\bdisposition\b/g, 'placement'],
  ['F14', /\brunningForMs\b/g, 'elapsedMs'],
  ['F16', /\bsetupDeadlineMs\b/g, 'loadTimeoutMs'],
  ['F18', /\banchorSlot\b/g, 'pinnedSlot'],
  ['F18', /\banchorRevision\b/g, 'pinnedRevision'],
  ['F19', /\bpersistent-implementation-ref\b/g, 'implementation-ref'],
  ['D1', /\bINITIALIZATION_TIMEOUT\b/g, 'LOAD_TIMEOUT'],
  ['D2', /\banchor-dependency-mismatch\b/g, 'pinned-dependency-mismatch'],
  ['D5', /\beagerInherited\b/g, 'eagerReused'],
  ['D7', /(['"`])timed-out\1/g, '$1overdue$1'],
  ['D8', /\blate-setup-result\b/g, 'attempt-succeeded-late'],
  ['D8', /\blate-setup-failure\b/g, 'attempt-failed-late'],
  ['D8', /(?<!runtime-)\battempts-outstanding\b/g, 'runtime-attempts-outstanding'],
  ['D8', /\bforeign-thenable-setup\b/g, 'setup-returned-thenable'],
]

// Occurrences the migration cannot rewrite: the reason names what to do by hand.
const MANUAL = [
  ['F9', /\bimplementationId\b/, 'the 0.5 key is not read any more: write { kind: "implementation-ref", contractId, familyId, range } and delete the old-key form'],
  ['D10', /\blegacy-implementation-ref\b/, 'the event no longer exists: delete the handler or the assertion'],
  ['F9', /\b(isLegacyImplementationRef|normalizeImplementationRef|familyIdOf)\b/, 'deleted with the old-key read path'],
]

const REF_KINDS = new Set(['persistent-implementation-ref', 'implementation-ref'])
const REVISION_RECEIVERS = new Set(['revision', 'service', 'candidate', 'origin', 'target', 'canonical', 'copy', 'copyA', 'copyB'])
const COUNT_RECEIVERS = new Set(['services', 'synthetic'])
const PLACEMENTS = new Set(['inherited', 'reused', 'new', 'forked'])
const PLAN_CACHE_KEYS = new Set(['hits', 'misses', 'entries', 'evictions', 'maxEntries', 'limit'])

// ---------------------------------------------------------------------------------------------------------------
// Files.
const relative = file => path.relative(root, file).split(path.sep).join('/')
const isSkipped = file => { const rel = relative(file); return rel === SELF || [...SKIP_PATHS].some(prefix => rel === prefix || rel.startsWith(`${prefix}/`)) }

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) yield* walk(file)
    else if (EXTENSIONS.some(extension => name.endsWith(extension))) yield file
  }
}

function defaultTargets() {
  const targets = ['apps', 'benchmarks', 'packages/core/tests']
  for (const name of readdirSync(path.join(root, 'packages')).sort()) if (name !== 'core' && name !== 'tsconfig') targets.push(`packages/${name}`)
  targets.push('scripts')
  return targets.filter(target => existsSync(path.join(root, target)))
}

function collectFiles(targets) {
  const files = new Set()
  for (const target of targets) {
    const file = path.resolve(root, target)
    if (!existsSync(file)) throw new Error(`no such path: ${target}`)
    if (statSync(file).isDirectory()) { for (const inner of walk(file)) if (!isSkipped(inner)) files.add(inner) }
    else if (!isSkipped(file)) files.add(file)
  }
  return [...files].sort()
}

// ---------------------------------------------------------------------------------------------------------------
// Program: the consumers plus whatever they import (the built `synajs` gives the descriptor types).
function createProgram(files) {
  return ts.createProgram(files, {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts', 'lib.esnext.disposable.d.ts'],
    types: ['node'],
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
    strict: true,
    exactOptionalPropertyTypes: true,
  })
}

// ---------------------------------------------------------------------------------------------------------------
// One file.
function migrateFile(sourceFile, checker) {
  const text = sourceFile.text
  const lines = text.split('\n')
  const frozen = new Set()
  let off = false
  lines.forEach((line, index) => {
    if (line.includes('codemod-v08: off')) off = true
    if (off || LINE_MARKERS.some(marker => line.includes(marker))) frozen.add(index)
    if (line.includes('codemod-v08: on')) off = false
  })
  const lineOf = position => sourceFile.getLineAndCharacterOfPosition(position).line
  const edits = []
  const manual = []
  const edit = (start, end, replacement, rule) => {
    if (frozen.has(lineOf(start))) return
    if (text.slice(start, end) === replacement) return
    edits.push({ start, end, text: replacement, rule })
  }
  const needsHand = (node, rule, reason) => {
    if (frozen.has(lineOf(node.getStart(sourceFile)))) return
    manual.push({ line: lineOf(node.getStart(sourceFile)) + 1, rule, reason, text: lines[lineOf(node.getStart(sourceFile))].trim().slice(0, 120) })
  }

  // ---- type helpers (undefined = no information) ----
  const typeAt = node => { try { return checker.getTypeAtLocation(node) } catch { return undefined } }
  const untyped = type => !type || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || (type.flags & ts.TypeFlags.Never) !== 0
  const eachMember = (type, visit) => { if (type.isUnionOrIntersection()) type.types.forEach(member => eachMember(member, visit)); else visit(type) }
  const namesOf = type => { const names = new Set(); eachMember(type, member => { if (member.aliasSymbol) names.add(member.aliasSymbol.name); if (member.symbol) names.add(member.symbol.name) }); return names }
  const typedAs = (node, ...names) => { const type = typeAt(node); if (untyped(type)) return undefined; const found = namesOf(type); return names.some(name => found.has(name)) }
  const propertiesOf = type => { const names = new Set(); eachMember(type, member => { for (const property of member.getProperties()) names.add(property.name) }); return names }
  const typedWith = (node, ...properties) => { const type = typeAt(node); if (untyped(type)) return undefined; const found = propertiesOf(type); return properties.every(property => found.has(property)) }
  const kindLiterals = (type, node) => {
    const values = new Set()
    eachMember(type, member => {
      const property = member.getProperty('kind')
      if (!property) return
      const collect = inner => { if (inner.isUnion()) inner.types.forEach(collect); else if (inner.isStringLiteral()) values.add(inner.value) }
      collect(checker.getTypeOfSymbolAtLocation(property, node))
    })
    return values
  }
  const refShaped = node => { const type = typeAt(node); if (untyped(type)) return undefined; for (const value of kindLiterals(type, node)) if (REF_KINDS.has(value)) return true; return false }

  // ---- syntax helpers ----
  const unwrap = node => (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression?.(node)) ? unwrap(node.expression) : node
  const lastName = expression => {
    const node = unwrap(expression)
    if (ts.isPropertyAccessExpression(node)) return node.name.text
    if (ts.isIdentifier(node)) return node.text
    if (ts.isElementAccessExpression(node) || ts.isCallExpression(node)) return lastName(node.expression)
    return ''
  }
  const refNamed = name => /(^|[^A-Za-z])ref$|Ref$/.test(name)
  const propertyName = property => {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property) || ts.isPropertySignature(property) || ts.isGetAccessorDeclaration(property)) {
      const name = property.name
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
    }
    return undefined
  }
  const namesOfLiteral = literal => new Set(literal.properties.map(propertyName).filter(name => name !== undefined))
  const renameKey = (literal, from, to, rule) => {
    for (const property of literal.properties) {
      if (propertyName(property) !== from) continue
      if (ts.isShorthandPropertyAssignment(property)) edit(property.name.getStart(sourceFile), property.name.getEnd(), `${to}: ${from}`, rule)
      else edit(property.name.getStart(sourceFile), property.name.getEnd(), to, rule)
    }
  }
  const stringValue = node => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) ? node.text : undefined
  const initializerOf = (literal, name) => { for (const property of literal.properties) if (propertyName(property) === name && ts.isPropertyAssignment(property)) return property.initializer; return undefined }
  const literalIsRef = literal => {
    const kind = initializerOf(literal, 'kind')
    if (!kind) return false
    const value = stringValue(unwrap(kind))
    if (value !== undefined) return REF_KINDS.has(value)
    if (ts.isObjectLiteralExpression(kind)) return REF_KINDS.has(stringValue(initializerOf(kind, 'const')) ?? '') // a JSON schema: kind: { const: '…' }
    return false
  }
  const spreadsRef = literal => literal.properties.some(property => ts.isSpreadAssignment(property) && (refShaped(property.expression) ?? refNamed(lastName(property.expression))))
  const comparedWith = (node, predicate) => {
    const parent = node.parent
    if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)) {
      const other = unwrap(parent.left === node ? parent.right : parent.left)
      return ts.isPropertyAccessExpression(other) && predicate(other.name.text)
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === node) return predicate(propertyName(parent) ?? '')
    if (ts.isCaseClause(parent)) {
      const subject = unwrap(parent.parent.parent.expression)
      return ts.isPropertyAccessExpression(subject) && predicate(subject.name.text)
    }
    return false
  }
  const replaceString = (node, value, rule) => edit(node.getStart(sourceFile), node.getEnd(), node.getText(sourceFile).replace(node.text, value), rule)
  const statementOf = node => { let current = node; while (current && !ts.isStatement(current)) current = current.parent; return current }

  // ---- rules ----
  const propertyAccess = node => {
    const name = node.name.text
    const receiver = node.expression
    const rename = (to, rule) => edit(node.name.getStart(sourceFile), node.name.getEnd(), to, rule)
    if (name === 'key') { // F1 ServiceRevision.key → id
      const typed = typedAs(receiver, 'ServiceRevision')
      const heuristic = (ts.isIdentifier(unwrap(receiver)) && /^[A-Z]/.test(unwrap(receiver).text)) || REVISION_RECEIVERS.has(lastName(receiver))
      if (typed === true || (typed === undefined && heuristic)) rename('id', 'F1')
    } else if (name === 'metadata') { // F5 ServiceRevision.metadata → revisionMetadata
      const typed = typedAs(receiver, 'ServiceRevision')
      const heuristic = ts.isIdentifier(unwrap(receiver)) && /^[A-Z]/.test(unwrap(receiver).text)
      if (typed === true || (typed === undefined && heuristic)) rename('revisionMetadata', 'F5')
    } else if (name === 'ref') { // F6 ImplementationCandidate.ref → candidateRef
      const typed = typedAs(receiver, 'ImplementationCandidate')
      if (typed === true || (typed === undefined && /candidate/i.test(lastName(receiver)))) rename('candidateRef', 'F6')
    } else if (name === 'version') { // F9 ImplementationRef.version → range
      const typed = refShaped(receiver)
      if (typed === true || (typed === undefined && refNamed(lastName(receiver)))) rename('range', 'F9')
    } else if (name === 'inherited') { // D5 ExplainCounts.inherited → reused (inputs.inherited stays)
      // An assertion (assert.deepEqual) narrows the receiver to the literal it was compared with: the shape counts too.
      const typed = typedAs(receiver, 'ExplainCounts') === true || typedWith(receiver, 'inherited', 'new', 'forked')
      if (typed === true || (typed === undefined && COUNT_RECEIVERS.has(lastName(receiver)))) rename('reused', 'D5')
    } else if (name === 'maxEntries') { // F11 planCache.maxEntries → limit
      if (lastName(receiver) === 'planCache') rename('limit', 'F11')
    } else if (name === 'attempt') { // F15 attempt (events, ledger, details) → attemptNumber
      // Typed with the 0.7 shape, or — the usual case, the codemod runs after the upgrade — with the 0.8 shape of the same record.
      const typed = typedWith(receiver, 'attempt', 'slot', 'revision') === true || typedWith(receiver, 'attemptNumber', 'slot', 'revision')
      const heuristic = lastName(receiver) === 'details' || /event/i.test(lastName(receiver))
      if (typed === true || (typed === undefined && heuristic)) rename('attemptNumber', 'F15')
    }
  }

  const call = node => {
    const callee = unwrap(node.expression)
    if (!ts.isPropertyAccessExpression(callee)) return
    const name = callee.name.text
    if (name === 'derive' && node.arguments.length === 1) { // S1 derive(reuse) → derive({ reuse })
      const argument = unwrap(node.arguments[0])
      const wrap = () => edit(node.arguments[0].getStart(sourceFile), node.arguments[0].getEnd(), ts.isIdentifier(argument) && argument.text === 'reuse' ? '{ reuse }' : `{ reuse: ${node.arguments[0].getText(sourceFile)} }`, 'S1')
      if (ts.isObjectLiteralExpression(argument)) {
        const names = namesOfLiteral(argument)
        if (names.size === 0 || names.has('reuse')) return
        if ([...names].every(key => key === 'fresh' || key === 'share')) wrap()
        else needsHand(node, 'S1', 'derive() takes EntryOptions ({ reuse }): this argument is neither reuse constraints nor options')
        return
      }
      const withReuse = typedWith(argument, 'reuse')
      if (withReuse === true) return
      const constraints = typedWith(argument, 'fresh') === true || typedWith(argument, 'share') === true
      if (constraints) wrap()
      else needsHand(node, 'S1', 'derive() takes EntryOptions ({ reuse }): wrap the argument if it is reuse constraints')
    } else if (name === 'revisions' && node.arguments.length === 1 && (lastName(callee.expression) === 'catalog' || typedAs(callee.expression, 'RuntimeCatalog') === true)) { // S2 revisions(familyId) → revisions(family)
      const argument = unwrap(node.arguments[0])
      if (typedAs(argument, 'ServiceFamily') === true) return
      if (ts.isPropertyAccessExpression(argument) && argument.name.text === 'id' && (typedAs(argument.expression, 'ServiceFamily') ?? lastName(argument.expression) === 'family')) {
        edit(node.arguments[0].getStart(sourceFile), node.arguments[0].getEnd(), argument.expression.getText(sourceFile), 'S2')
      } else needsHand(node, 'S2', 'catalog.revisions() takes the ServiceFamily descriptor (revision.family), not its id')
    } else if (name === 'service' && node.arguments.length > 0) { // F4 ServiceDefinition.metadata → familyMetadata
      const definition = unwrap(node.arguments[node.arguments.length - 1])
      if (ts.isObjectLiteralExpression(definition) && namesOfLiteral(definition).has('setup')) renameKey(definition, 'metadata', 'familyMetadata', 'F4')
    }
  }

  const objectLiteral = node => {
    const names = namesOfLiteral(node)
    if (names.has('attempt') && names.has('slot') && names.has('revision')) renameKey(node, 'attempt', 'attemptNumber', 'F15')
    if (names.has('version') && (literalIsRef(node) || spreadsRef(node))) renameKey(node, 'version', 'range', 'F9')
    if (names.has('inherited') && (names.has('eagerToStart') || names.has('eagerInherited') || names.has('eagerReused') || (names.has('new') && names.has('forked')))) renameKey(node, 'inherited', 'reused', 'D5')
    if (names.has('maxEntries') && names.has('hits') && names.has('misses') && [...names].every(name => PLAN_CACHE_KEYS.has(name))) renameKey(node, 'maxEntries', 'limit', 'F11')
    // A JSON schema of the reference: `required: ['kind', 'contractId', 'version']` next to `properties: { kind: { const } }`.
    const properties = initializerOf(node, 'properties')
    const required = initializerOf(node, 'required')
    if (properties && required && ts.isObjectLiteralExpression(properties) && literalIsRef(properties) && ts.isArrayLiteralExpression(required)) {
      for (const element of required.elements) if (stringValue(element) === 'version') replaceString(element, 'range', 'F9')
    }
  }

  const typeMembers = node => { // F9 in a declared shape: { kind: 'implementation-ref'; …; version } → range
    const kind = node.members.find(member => propertyName(member) === 'kind')
    if (!kind || !ts.isPropertySignature(kind) || !kind.type || !/implementation-ref/.test(kind.type.getText(sourceFile))) return
    for (const member of node.members) if (propertyName(member) === 'version' && ts.isPropertySignature(member)) edit(member.name.getStart(sourceFile), member.name.getEnd(), 'range', 'F9')
  }

  const stringLiteral = node => {
    const value = node.text
    if (value === 'all') { // D3 the node kind
      if (comparedWith(node, name => name === 'kind')) replaceString(node, 'all-implementations', 'D3')
    } else if (value === 'inherited') { // D4 the placement value
      const isPlacement = name => name === 'disposition' || name === 'placement'
      if (comparedWith(node, isPlacement)) replaceString(node, 'reused', 'D4')
      else if (ts.isCallExpression(node.parent) && node.parent.arguments.includes(node) && node.parent.arguments.some(argument => argument !== node && /\.(disposition|placement)\b/.test(argument.getText(sourceFile)))) replaceString(node, 'reused', 'D4') // assert.equal(node.disposition, 'inherited')
      else if (ts.isArrayLiteralExpression(node.parent) && node.parent.elements.every(element => PLACEMENTS.has(stringValue(element) ?? 'reused')) && node.parent.elements.some(element => ['forked', 'new'].includes(stringValue(element)))) replaceString(node, 'reused', 'D4')
    } else if (value === 'none') { // D9 uniqueWithin: undefined when undeclared
      const statement = statementOf(node)
      if (statement && /\buniqueWithin\b/.test(statement.getText(sourceFile))) edit(node.getStart(sourceFile), node.getEnd(), 'undefined', 'D9')
    }
  }

  const literalType = node => {
    const value = node.literal.text
    const union = ts.isUnionTypeNode(node.parent) ? node.parent : undefined
    const siblings = union ? union.types.map(type => ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal) ? type.literal.text : undefined) : []
    if (value === 'inherited' && siblings.includes('forked')) replaceString(node.literal, 'reused', 'D4')
    else if (value === 'all' && siblings.includes('service') && siblings.includes('entry')) replaceString(node.literal, 'all-implementations', 'D3')
    else if (value === 'none' && siblings.includes('lineage')) {
      const kept = union.types.filter(type => type !== node).map(type => type.getText(sourceFile)).join(' | ')
      edit(union.getStart(sourceFile), union.getEnd(), kept, 'D9')
    }
  }

  const bindingElement = node => { // const { key } = revision; const { attempt } = error.details
    if (node.propertyName || !ts.isIdentifier(node.name) || !ts.isObjectBindingPattern(node.parent)) return
    const declaration = node.parent.parent
    const source = ts.isVariableDeclaration(declaration) ? declaration.initializer : ts.isParameter(declaration) ? declaration : undefined
    if (!source) return
    if (node.name.text === 'key' && typedAs(source, 'ServiceRevision') === true) edit(node.name.getStart(sourceFile), node.name.getEnd(), 'id: key', 'F1')
    if (node.name.text === 'attempt') {
      const typed = typedWith(source, 'attempt', 'slot', 'revision') === true || typedWith(source, 'attemptNumber', 'slot', 'revision')
      if (typed === true || (typed === undefined && ts.isVariableDeclaration(declaration) && (lastName(declaration.initializer) === 'details' || /event/i.test(lastName(declaration.initializer))))) edit(node.name.getStart(sourceFile), node.name.getEnd(), 'attemptNumber: attempt', 'F15')
    }
  }

  const visit = node => {
    if (ts.isPropertyAccessExpression(node)) propertyAccess(node)
    else if (ts.isCallExpression(node)) call(node)
    else if (ts.isObjectLiteralExpression(node)) objectLiteral(node)
    else if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) typeMembers(node)
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) stringLiteral(node)
    else if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) literalType(node)
    else if (ts.isBindingElement(node)) bindingElement(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  // ---- tokens and the sites that need a hand ----
  for (const [rule, pattern, replacement] of TOKENS) {
    for (const match of text.matchAll(pattern)) {
      const replaced = match[0].replace(pattern, replacement)
      edit(match.index, match.index + match[0].length, replaced, rule)
    }
  }
  lines.forEach((line, index) => {
    if (frozen.has(index)) return
    for (const [rule, pattern, reason] of MANUAL) if (pattern.test(line)) manual.push({ line: index + 1, rule, reason, text: line.trim().slice(0, 120) })
  })

  // ---- apply: later edits first; an overlap keeps the earlier (syntax) edit ----
  const unique = new Map()
  for (const item of edits) unique.set(`${item.start}:${item.end}:${item.text}`, item)
  const ordered = [...unique.values()].sort((a, b) => b.start - a.start || b.end - a.end)
  const applied = []
  let cursor = Infinity
  for (const item of ordered) {
    if (item.end > cursor) continue // overlaps an edit already applied (a wrapped argument, a rebuilt union)
    applied.push(item)
    cursor = item.start
  }
  let output = text
  for (const item of applied) output = output.slice(0, item.start) + item.text + output.slice(item.end)
  const changes = applied.map(item => ({ line: lineOf(item.start) + 1, rule: item.rule, from: text.slice(item.start, item.end), to: item.text }))
  return { output, changes, manual: manual.sort((a, b) => a.line - b.line) }
}

// ---------------------------------------------------------------------------------------------------------------
const targets = positionals.length > 0 ? positionals : defaultTargets()
const files = collectFiles(targets)
const program = createProgram(files)
const checker = program.getTypeChecker()
const report = { dryRun, targets, files: [], rules: {}, edits: 0, filesChanged: 0, manual: 0 }
for (const file of files) {
  const sourceFile = program.getSourceFile(file)
  if (!sourceFile) continue
  const { output, changes, manual } = migrateFile(sourceFile, checker)
  const rel = relative(file)
  for (const change of changes) report.rules[change.rule] = (report.rules[change.rule] ?? 0) + 1
  report.edits += changes.length
  report.manual += manual.length
  if (changes.length > 0) report.filesChanged += 1
  if (changes.length > 0 || manual.length > 0) report.files.push({ file: rel, edits: changes.length, changes: verbose || jsonOut ? changes : undefined, manual })
  if (verbose) for (const change of changes) console.log(`${rel}:${change.line} ${change.rule}: ${change.from.replace(/\s+/g, ' ')} → ${change.to.replace(/\s+/g, ' ')}`)
  for (const item of manual) console.log(`${rel}:${item.line} needs a hand (${item.rule}): ${item.reason}\n    ${item.text}`)
  if (!dryRun && changes.length > 0) writeFileSync(file, output)
}
if (jsonOut) writeFileSync(path.resolve(root, jsonOut), `${JSON.stringify(report, null, 2)}\n`)
const byRule = Object.entries(report.rules).sort(([a], [b]) => a.localeCompare(b)).map(([rule, count]) => `${rule} ${count}`).join(', ')
console.log(`codemod-v08${dryRun ? ' (dry run)' : ''}: ${report.edits} edits in ${report.filesChanged} files; ${report.manual} manual${byRule ? ` — ${byRule}` : ''}`)
process.exit(report.manual > 0 ? 2 : 0)
