#!/usr/bin/env node
// Public API inventory of the syna runtime package, generated from the TypeScript sources behind
// packages/core/src/index.ts: every export, every member of every exported interface or class,
// every member of a string-literal union (the error codes), every `@deprecated` tag with its text and, since 0.8,
// the JSDoc text of every export and member, so that `--diff` tells a change of documentation from a change of signature.
//
//   node scripts/api-inventory.mjs [--out work/v08/API_INVENTORY_AFTER.md] [--json work/v08/API_INVENTORY_AFTER.json]
//   node scripts/api-inventory.mjs --diff work/v08/API_INVENTORY_BEFORE.json work/v08/API_INVENTORY_AFTER.json [--out work/v08/API_INVENTORY_DIFF.md]
//
// The Markdown is the human-readable list; the JSON is the flat list the diff mode works on. Both are deterministic
// for a given source tree (sorted by export name, members in declaration order). The diff lists the added, the removed
// and the changed items (a changed signature or deprecation) and, apart from them, the items whose JSDoc alone changed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const corePackage = path.join(root, 'packages/core')
const entryFile = path.join(corePackage, 'src/index.ts')

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const collapse = text => text.replace(/\s+/g, ' ').trim()

const deprecationOf = node => {
  for (const tag of ts.getJSDocTags(node)) {
    if (tag.tagName.text !== 'deprecated') continue
    const comment = ts.getTextOfJSDocComment(tag.comment)
    return { deprecated: true, note: comment ? collapse(comment) : '' }
  }
  return { deprecated: false, note: '' }
}

/** The JSDoc blocks attached to a declaration, collapsed to one line; '' when there is none. */
const docOf = node => collapse((node.jsDoc ?? []).map(block => block.getText()).join(' '))

const withoutBody = node => {
  const text = node.getText()
  if (!node.body) return collapse(text)
  return collapse(text.slice(0, node.body.getStart() - node.getStart()))
}

const memberName = member => {
  if (!member.name) return ts.isConstructorDeclaration(member) || ts.isConstructSignatureDeclaration(member) ? 'constructor' : ts.isCallSignatureDeclaration(member) ? '()' : ts.isIndexSignatureDeclaration(member) ? '[index]' : '?'
  return member.name.getText()
}

const memberText = member => {
  if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) return withoutBody(member)
  if (ts.isPropertyDeclaration(member)) {
    const text = member.getText()
    return collapse(member.initializer ? text.slice(0, member.initializer.getStart() - member.getStart()).replace(/=\s*$/, '') : text)
  }
  return collapse(member.getText())
}

const isPublicClassMember = member =>
  !(member.modifiers ?? []).some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword)
  && !(member.name && ts.isPrivateIdentifier(member.name))

const unionMembers = typeNode => {
  if (!typeNode) return []
  if (ts.isUnionTypeNode(typeNode)) return typeNode.types.flatMap(unionMembers)
  if (ts.isLiteralTypeNode(typeNode) && ts.isStringLiteral(typeNode.literal)) return [typeNode.literal.text]
  return []
}

export const inventory = () => {
  const configFile = ts.findConfigFile(corePackage, ts.sys.fileExists, 'tsconfig.json')
  const config = ts.readConfigFile(configFile, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, corePackage)
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true, composite: false, declaration: false, declarationMap: false, sourceMap: false })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'))
  }
  const checker = program.getTypeChecker()
  const sourceFile = program.getSourceFile(entryFile)
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  const entries = []
  const exportsOfModule = checker.getExportsOfModule(moduleSymbol).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  for (const exported of exportsOfModule) {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
    const declarations = target.declarations ?? []
    const kinds = new Set()
    const lines = []
    const docs = []
    const members = []
    let deprecation = { deprecated: false, note: '' }
    let unionCodes = []
    let sourceFiles = new Set()
    for (const declaration of declarations) {
      sourceFiles.add(path.relative(root, declaration.getSourceFile().fileName))
      const documented = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration
      const tag = deprecationOf(documented)
      if (tag.deprecated) deprecation = tag
      docs.push(docOf(documented))
      if (ts.isInterfaceDeclaration(declaration)) {
        kinds.add('interface')
        const heritage = declaration.heritageClauses ? ' ' + declaration.heritageClauses.map(clause => collapse(clause.getText())).join(' ') : ''
        lines.push(`interface ${declaration.name.text}${declaration.typeParameters ? `<${declaration.typeParameters.map(p => collapse(p.getText())).join(', ')}>` : ''}${heritage}`)
        for (const member of declaration.members) members.push({ name: memberName(member), signature: memberText(member), doc: docOf(member), ...deprecationOf(member) })
      } else if (ts.isTypeAliasDeclaration(declaration)) {
        kinds.add('type')
        lines.push(`type ${declaration.name.text}${declaration.typeParameters ? `<${declaration.typeParameters.map(p => collapse(p.getText())).join(', ')}>` : ''} = ${collapse(declaration.type.getText())}`)
        unionCodes = unionMembers(declaration.type)
      } else if (ts.isClassDeclaration(declaration)) {
        kinds.add('class')
        const heritage = declaration.heritageClauses ? ' ' + declaration.heritageClauses.map(clause => collapse(clause.getText())).join(' ') : ''
        lines.push(`class ${declaration.name.text}${declaration.typeParameters ? `<${declaration.typeParameters.map(p => collapse(p.getText())).join(', ')}>` : ''}${heritage}`)
        for (const member of declaration.members) {
          if (!isPublicClassMember(member)) continue
          members.push({ name: memberName(member), signature: memberText(member), doc: docOf(member), ...deprecationOf(member) })
        }
      } else if (ts.isFunctionDeclaration(declaration)) {
        kinds.add('function')
        lines.push(withoutBody(declaration).replace(/^export\s+/, ''))
      } else if (ts.isVariableDeclaration(declaration)) {
        kinds.add('const')
        const type = declaration.type ? collapse(declaration.type.getText()) : checker.typeToString(checker.getTypeOfSymbolAtLocation(target, declaration), declaration, ts.TypeFormatFlags.NoTruncation)
        lines.push(`const ${declaration.name.getText()}: ${type}`)
      } else if (ts.isEnumDeclaration(declaration)) {
        kinds.add('enum')
        lines.push(collapse(declaration.getText()))
      } else {
        kinds.add(ts.SyntaxKind[declaration.kind])
        lines.push(collapse(declaration.getText()))
      }
    }
    entries.push({
      name: exported.name,
      kinds: [...kinds].sort(),
      files: [...sourceFiles].sort(),
      signature: lines.join('\n'),
      doc: docs.filter(Boolean).join(' '),
      deprecated: deprecation.deprecated,
      note: deprecation.note,
      members,
      unionMembers: unionCodes,
    })
  }
  return entries
}

const flatten = entries => {
  const flat = []
  for (const entry of entries) {
    flat.push({ path: entry.name, kind: entry.kinds.join('+'), signature: entry.signature, doc: entry.doc, deprecated: entry.deprecated, note: entry.note })
    for (const member of entry.members) flat.push({ path: `${entry.name}.${member.name}`, kind: 'member', signature: member.signature, doc: member.doc, deprecated: member.deprecated, note: member.note })
    for (const code of entry.unionMembers) flat.push({ path: `${entry.name}['${code}']`, kind: 'union-member', signature: `'${code}'`, doc: '', deprecated: false, note: '' })
  }
  return flat
}

const gitHead = () => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

const renderMarkdown = entries => {
  const version = JSON.parse(readFileSync(path.join(corePackage, 'package.json'), 'utf8')).version
  const values = entries.filter(entry => entry.kinds.some(kind => kind === 'function' || kind === 'const' || kind === 'class' || kind === 'enum'))
  const types = entries.filter(entry => !values.includes(entry))
  const flat = flatten(entries)
  const deprecatedCount = flat.filter(item => item.deprecated).length
  const out = []
  out.push(`# \`syna\` public API inventory`)
  out.push('')
  out.push(`Generated by \`node scripts/api-inventory.mjs\` from \`packages/core/src/index.ts\` (package version ${version}, commit ${gitHead()}).`)
  out.push('')
  out.push(`| exports | value exports | type-only exports | members (interface/class) | union members | \`@deprecated\` items |`)
  out.push(`|---|---|---|---|---|---|`)
  out.push(`| ${entries.length} | ${values.length} | ${types.length} | ${flat.filter(item => item.kind === 'member').length} | ${flat.filter(item => item.kind === 'union-member').length} | ${deprecatedCount} |`)
  out.push('')
  const section = (title, list) => {
    out.push(`## ${title} (${list.length})`)
    out.push('')
    for (const entry of list) {
      out.push(`### \`${entry.name}\` — ${entry.kinds.join(' + ')}${entry.deprecated ? ` — **@deprecated** ${entry.note}` : ''}`)
      out.push('')
      out.push(`Declared in ${entry.files.map(file => `\`${file}\``).join(', ')}.`)
      out.push('')
      out.push('```ts')
      out.push(entry.signature)
      if (entry.members.length > 0) {
        for (const member of entry.members) out.push(`  ${member.deprecated ? `/** @deprecated ${member.note} */ ` : ''}${member.signature}`)
      }
      if (entry.unionMembers.length > 0) {
        for (const code of entry.unionMembers) out.push(`  | '${code}'`)
      }
      out.push('```')
      out.push('')
    }
  }
  section('Value exports', values)
  section('Type exports', types)
  if (deprecatedCount > 0) {
    out.push(`## \`@deprecated\` items (${deprecatedCount})`)
    out.push('')
    out.push('| item | kind | note |')
    out.push('|---|---|---|')
    for (const item of flat.filter(item => item.deprecated)) out.push(`| \`${item.path}\` | ${item.kind} | ${item.note || '(no note)'} |`)
    out.push('')
  }
  return out.join('\n')
}

const renderDiff = (beforePath, afterPath) => {
  const before = JSON.parse(readFileSync(beforePath, 'utf8'))
  const after = JSON.parse(readFileSync(afterPath, 'utf8'))
  // An overloaded member is several items with one path: a path is compared as the sorted set of its signatures.
  const groups = items => { const map = new Map(); for (const item of items) map.set(item.path, [...(map.get(item.path) ?? []), item]); return map }
  const beforeGroups = groups(before.items)
  const afterGroups = groups(after.items)
  const added = after.items.filter(item => !beforeGroups.has(item.path))
  const removed = before.items.filter(item => !afterGroups.has(item.path))
  const signatures = items => items.map(item => `${item.deprecated ? '@deprecated ' : ''}${item.signature}`).sort().join('\n\n')
  const docs = items => items.map(item => `${item.doc ?? ''}\n${item.note ?? ''}`).sort().join('\n\n')
  const kept = [...afterGroups.keys()].filter(item => beforeGroups.has(item))
  const sameSignature = item => signatures(beforeGroups.get(item)) === signatures(afterGroups.get(item))
  // One representative item per path (its kind counts it in the table); the listing prints every overload.
  const changed = kept.filter(item => !sameSignature(item)).map(item => afterGroups.get(item)[0])
  // 0.8 (§2.6): an item whose signature and deprecation are unchanged but whose JSDoc (or deprecation note) differs is a
  // documentation change, listed apart from the signature changes. A record made before the `doc` field reads as ''.
  const docOnly = kept.filter(item => sameSignature(item) && docs(beforeGroups.get(item)) !== docs(afterGroups.get(item))).map(item => afterGroups.get(item)[0])
  const newlyDeprecated = changed.filter(item => item.deprecated && !beforeGroups.get(item.path).some(previous => previous.deprecated))
  const count = (items, kind) => items.filter(item => kind === 'export' ? item.kind !== 'member' && item.kind !== 'union-member' : item.kind === kind).length
  const out = []
  out.push('# `synajs` public API diff')
  out.push('')
  out.push(`Generated by \`node scripts/api-inventory.mjs --diff\` from \`${path.relative(root, beforePath)}\` (version ${before.version}, commit ${before.commit}) and \`${path.relative(root, afterPath)}\` (version ${after.version}, commit ${after.commit}).`)
  out.push('')
  out.push('| | before | after | added | removed | changed (signature) | doc-only (JSDoc) | newly deprecated |')
  out.push('|---|---|---|---|---|---|---|---|')
  for (const [label, kind] of [['exports', 'export'], ['members', 'member'], ['union members', 'union-member']]) {
    out.push(`| ${label} | ${count(before.items, kind)} | ${count(after.items, kind)} | ${count(added, kind)} | ${count(removed, kind)} | ${count(changed, kind)} | ${count(docOnly, kind)} | ${count(newlyDeprecated, kind)} |`)
  }
  out.push(`| total items | ${before.items.length} | ${after.items.length} | ${added.length} | ${removed.length} | ${changed.length} | ${docOnly.length} | ${newlyDeprecated.length} |`)
  out.push(`| \`@deprecated\` items | ${before.items.filter(item => item.deprecated).length} | ${after.items.filter(item => item.deprecated).length} | | | | | |`)
  out.push('')
  const list = (title, items, render) => {
    out.push(`## ${title} (${items.length})`)
    out.push('')
    if (items.length === 0) { out.push('_none_'); out.push(''); return }
    out.push('```')
    for (const item of items) out.push(render(item))
    out.push('```')
    out.push('')
  }
  const line = item => `${item.deprecated ? '@deprecated ' : ''}${item.path}  ::  ${item.signature.split('\n')[0]}${item.note ? `  // ${item.note}` : ''}`
  list('Added', added, line)
  list('Removed', removed, line)
  list('Changed (signature or deprecation)', changed, item => [...beforeGroups.get(item.path).map(previous => `- ${line(previous)}`), ...afterGroups.get(item.path).map(current => `+ ${line(current)}`)].join('\n'))
  list('Doc-only changes (JSDoc; the signature is identical)', docOnly, item => [item.path, ...beforeGroups.get(item.path).map(previous => `- ${previous.doc || '(no JSDoc)'}`), ...afterGroups.get(item.path).map(current => `+ ${current.doc || '(no JSDoc)'}`)].join('\n'))
  return out.join('\n')
}

const write = (file, content) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content.endsWith('\n') ? content : content + '\n')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (!isMain) {
  // imported as a module (scripts/tests/deprecations.test.mjs): no CLI side effects
} else if (args.includes('--diff')) {
  const index = args.indexOf('--diff')
  const beforePath = path.resolve(root, args[index + 1])
  const afterPath = path.resolve(root, args[index + 2])
  const markdown = renderDiff(beforePath, afterPath)
  const out = option('--out')
  if (out) { write(path.resolve(root, out), markdown); console.log(`wrote ${out}`) } else console.log(markdown)
} else {
  const entries = inventory()
  const version = JSON.parse(readFileSync(path.join(corePackage, 'package.json'), 'utf8')).version
  const markdown = renderMarkdown(entries)
  const json = JSON.stringify({ version, commit: gitHead(), generatedBy: 'scripts/api-inventory.mjs', items: flatten(entries) }, null, 2)
  const out = option('--out')
  const jsonOut = option('--json')
  if (out) { write(path.resolve(root, out), markdown); console.log(`wrote ${out}`) }
  if (jsonOut) { write(path.resolve(root, jsonOut), json); console.log(`wrote ${jsonOut}`) }
  if (!out && !jsonOut) console.log(markdown)
}
