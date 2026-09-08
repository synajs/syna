#!/usr/bin/env node
// The one entry of the core suite. It walks `packages/core/tests` (the cases live in
// behaviour-domain directories since 1.0.0-rc.5, so discovery has to recurse) and hands what it
// finds to `node --test`. A run that discovers nothing exits non-zero: `node --test <glob>` reports
// success with zero tests, which is how `packages/core`'s own `npm test` kept passing after the
// suites moved into subdirectories and stopped matching `tests/*.test.mjs`.
//
// Both `npm test` at the root and `npm --prefix packages/core test` go through this file, so the two
// entries cannot come to cover different sets of files (`scripts/tests/core-tests-entry.test.mjs`).
// Arguments are passed on to `node --test` (`--test-reporter=tap`, `--expose-gc`, …), except
// `--list`, which prints the discovered files and runs nothing, and `--dir <path>`, which points the
// discovery elsewhere.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUFFIX = '.test.mjs'

const argv = process.argv.slice(2)
const list = argv.includes('--list')
const dirFlag = argv.indexOf('--dir')
const dir = dirFlag === -1 ? 'packages/core/tests' : argv[dirFlag + 1]
// `--dir` at the very end leaves nothing to walk. Said here, before discovery and before `--list`,
// because the alternative is `path.resolve` reporting it: an ERR_INVALID_ARG_TYPE about `paths[1]`,
// which names an argument of a function this script called rather than the one the caller left out.
if (dir === undefined) {
  console.error('--dir requires a path')
  process.exit(1)
}
// `--dir` and the path behind it are consumed here rather than passed on — but only when `--dir` is
// there at all. Without it `indexOf` answers -1, and an index test written against `dirFlag + 1`
// reads as `index !== 0`: it drops argv[0], the first argument meant for `node --test`. Silently, so
// `--test-name-pattern` as the first argument stopped filtering and an invalid first option stopped
// failing the run (`scripts/tests/core-tests-entry.test.mjs`).
const consumed = dirFlag === -1 ? new Set() : new Set([dirFlag, dirFlag + 1])
const passthrough = argv.filter((argument, index) => argument !== '--list' && !consumed.has(index))

const walk = (current) => readdirSync(path.resolve(root, current), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(current, entry.name)) : entry.name.endsWith(SUFFIX) ? [path.join(current, entry.name)] : [])
const files = walk(dir).sort()

if (files.length === 0) {
  console.error(`no test file under ${dir}/ matches *${SUFFIX}: a run that discovers nothing is a failure, not a pass`)
  process.exit(1)
}
if (list) {
  console.log(files.join('\n'))
  process.exit(0)
}
const result = spawnSync(process.execPath, ['--test', ...passthrough, ...files], { cwd: root, stdio: 'inherit' })
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
