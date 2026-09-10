// What the README prints as code, read out of the README itself: the tests compile and run exactly the text a reader
// copies, so the document cannot drift from the program it documents (1.0.0-rc.1, the first public candidate).
//
// The grammar is what the document already looks like:
//   - a *file* is a line holding one backticked path (`package.json`, `src/main.ts`) followed by a fenced block;
//   - the *output* of a program is the unlabelled fence that follows a line ending in `prints:` (`打印：` in the
//     Chinese README), and belongs to the file block above it;
//   - every other ```ts fence is a *snippet*: illustrative, not a whole program, checked for invented names only.
// README.zh-CN.md carries the same blocks — code and output are not translated — so one extractor reads both.

/** The path of a file block: the languages the README writes files in. */
const FILE_LINE = /^`([\w./-]+\.(?:json|ts))`$/
const FENCE = /^```(\w*)$/
/** The line that introduces what a program prints, in either README. */
const OUTPUT_LINE = /(?:prints:|打印：)$/

/**
 * @param {string} markdown
 * @returns {{ files: { file: string, code: string }[], outputs: Map<string, string>, snippets: string[] }}
 */
export function readmePrograms(markdown) {
  const lines = markdown.split('\n')
  const files = []
  const outputs = new Map()
  const snippets = []
  let lastFile = null
  let announced = null
  let awaitingOutput = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = FENCE.exec(line)
    if (!fence) {
      const trimmed = line.trim()
      const match = FILE_LINE.exec(trimmed)
      if (match) {
        announced = match[1]
        awaitingOutput = false
      }
      else if (OUTPUT_LINE.test(trimmed)) {
        announced = null
        awaitingOutput = true
      }
      else if (trimmed !== '') {
        announced = null
        awaitingOutput = false
      }
      continue
    }
    let end = index + 1
    while (end < lines.length && lines[end] !== '```') end += 1
    const code = `${lines.slice(index + 1, end).join('\n')}\n`
    if (announced) {
      files.push({ file: announced, code })
      lastFile = announced
    }
    else if (awaitingOutput && fence[1] === '') {
      if (lastFile) outputs.set(lastFile, code)
    }
    else if (fence[1] === 'ts') snippets.push(code)
    index = end
    announced = null
    awaitingOutput = false
  }
  return { files, outputs, snippets }
}

/** Every name imported from the runtime package anywhere in the document (`import { a, type B } from 'syna'`). */
export function importedNames(markdown, specifier = 'syna') {
  const names = new Set()
  const pattern = new RegExp(String.raw`import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'${specifier}'`, 'g')
  for (const match of markdown.matchAll(pattern)) {
    for (const item of match[1].split(',')) {
      const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]
      if (name) names.add(name)
    }
  }
  return names
}

/** Every `<receiver>.<member>(` or `<receiver>.<member><T>(` call of the receivers given, as `receiver.member`. */
export function memberCalls(markdown, receivers) {
  const calls = new Set()
  for (const receiver of receivers) {
    const pattern = new RegExp(String.raw`\b${receiver}\.(\w+)\s*[(<]`, 'g')
    for (const match of markdown.matchAll(pattern)) calls.add(`${receiver}.${match[1]}`)
  }
  return calls
}

/** The names a built declaration file exports: `export { … } from` and `export type { … } from`. */
export function declaredExports(declarationText) {
  const names = new Set()
  for (const match of declarationText.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const item of match[1].split(',')) {
      const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).at(-1)
      if (name) names.add(name)
    }
  }
  return names
}

/** The member names of one declared interface of a built declaration file. */
export function interfaceMembers(declarationText, name) {
  const start = declarationText.search(new RegExp(String.raw`^export interface ${name}(?:<[^>]*>)?\s*(?:extends [^{]*)?\{`, 'm'))
  if (start < 0) throw new Error(`interface ${name} is not declared in the built package`)
  const body = declarationText.slice(start)
  const end = body.indexOf('\n}')
  const members = new Set()
  for (const line of body.slice(0, end).split('\n').slice(1)) {
    const match = /^\s*(?:readonly\s+)?(\w+)[<(?:]/.exec(line)
    if (match) members.add(match[1])
  }
  return members
}
