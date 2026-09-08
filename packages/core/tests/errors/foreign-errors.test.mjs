// v0.7 (Phase C, S10): `asSynaError()` — a core-internal helper (`dist/errors.js`, not exported from the package) —
// wraps every value that is not a SynaError: `details` is the wrapping site's details plus a fixed
// `cause: { name, message }` record, and the original value is `cause` whatever its type. Nothing else is read
// from the foreign value; a SynaError passes through unchanged.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { asSynaError, diagnosticFromError, isSynaError, SynaError } from '../../dist/errors.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '../../dist')

const expectWrapped = (wrapped, original, code, message, details) => {
  assert.ok(isSynaError(wrapped, code))
  assert.ok(wrapped instanceof SynaError)
  assert.equal(wrapped.message, message)
  assert.deepEqual(wrapped.details, details)
  assert.ok(Object.isFrozen(wrapped.details))
  assert.equal(wrapped.cause, original, 'the original value is the cause')
  assert.deepEqual(Object.keys(wrapped.details.cause).sort(), ['message', 'name'])
  assert.equal(typeof wrapped.details.cause.name, 'string')
  assert.equal(typeof wrapped.details.cause.message, 'string')
}

test('an Error is wrapped with the site details plus cause: { name, message }, and is the cause itself', () => {
  const original = new TypeError('bad input')
  const wrapped = asSynaError(original, 'ENTRY_ACTIVATION_FAILED', 'wrapped', { entry: 'e', env: 'env-1' })
  expectWrapped(wrapped, original, 'ENTRY_ACTIVATION_FAILED', 'wrapped', {
    entry: 'e', env: 'env-1', cause: { name: 'TypeError', message: 'bad input' },
  })
  class Custom extends Error { constructor(message) { super(message); this.name = 'CustomFailure' } }
  const custom = new Custom('custom')
  expectWrapped(asSynaError(custom, 'RUNTIME_MISMATCH', 'm'), custom, 'RUNTIME_MISMATCH', 'm', { cause: { name: 'CustomFailure', message: 'custom' } })
})

test('nothing is read from the foreign value beyond name and message: its own code, details and cause are ignored', () => {
  const original = Object.assign(new Error('outer'), {
    code: 'MISSING_INPUT',
    details: { secret: 'never copied', input: 'x' },
    cause: new Error('inner'),
  })
  const wrapped = asSynaError(original, 'RUNTIME_MISMATCH', 'wrapped')
  expectWrapped(wrapped, original, 'RUNTIME_MISMATCH', 'wrapped', { cause: { name: 'Error', message: 'outer' } })
  assert.equal(wrapped.code, 'RUNTIME_MISMATCH')
  assert.equal('secret' in wrapped.details, false)
  // A plain object shaped like an Error is not an Error: typeof and String() describe it.
  const fake = { name: 'Fake', message: 'nope', details: { secret: 1 } }
  expectWrapped(asSynaError(fake, 'RUNTIME_MISMATCH', 'm'), fake, 'RUNTIME_MISMATCH', 'm', { cause: { name: 'object', message: '[object Object]' } })
})

test('a non-Error value is wrapped with typeof and String() and kept as the cause whatever its type', () => {
  const symbol = Symbol('token')
  const throwing = { toString() { throw new Error('no string for you') } }
  const cases = [
    ['boom', { name: 'string', message: 'boom' }],
    [42, { name: 'number', message: '42' }],
    [null, { name: 'object', message: 'null' }],
    [undefined, { name: 'undefined', message: 'undefined' }],
    [symbol, { name: 'symbol', message: 'Symbol(token)' }],
    [throwing, { name: 'object', message: '[object Object]' }],
    [() => 1, { name: 'function', message: '() => 1' }],
  ]
  for (const [value, cause] of cases) {
    const wrapped = asSynaError(value, 'LOAD_CANCELLED', 'm', { slot: 'slot-1', revision: 'r@1.0.0' })
    expectWrapped(wrapped, value, 'LOAD_CANCELLED', 'm', { slot: 'slot-1', revision: 'r@1.0.0', cause })
    assert.ok('cause' in wrapped, 'the cause property exists even for undefined')
  }
})

test('the caller\'s own options.cause is replaced by the wrapped value; other options are kept', () => {
  const original = new Error('real')
  const wrapped = asSynaError(original, 'RUNTIME_MISMATCH', 'm', {}, { cause: new Error('not this one') })
  assert.equal(wrapped.cause, original)
  assert.deepEqual(wrapped.details, { cause: { name: 'Error', message: 'real' } })
})

test('a SynaError passes through unchanged, whatever its code, and the wrapped error is an ordinary diagnostic', () => {
  const own = new SynaError('MISSING_INPUT', 'missing', { input: 'flag', site: 's', missing: ['flag'] })
  assert.equal(asSynaError(own, 'RUNTIME_MISMATCH', 'ignored'), own)
  assert.equal(own.code, 'MISSING_INPUT')
  assert.equal('cause' in own.details, false)
  const wrapped = asSynaError(new RangeError('out of range'), 'ROLLBACK_FAILED', 'm', { slot: 's', revision: 'r@1.0.0', state: 'failed' })
  assert.deepEqual(diagnosticFromError(wrapped), {
    code: 'ROLLBACK_FAILED',
    message: 'm',
    details: { slot: 's', revision: 'r@1.0.0', state: 'failed', cause: { name: 'RangeError', message: 'out of range' } },
  })
})

test('asSynaError is not part of the public API and its declaration promises the cause record', () => {
  const index = readFileSync(path.join(dist, 'index.d.ts'), 'utf8')
  assert.equal(index.includes('asSynaError'), false)
  assert.equal(readFileSync(path.join(dist, 'index.js'), 'utf8').includes('asSynaError'), false)
  const errors = readFileSync(path.join(dist, 'errors.d.ts'), 'utf8')
  assert.match(errors, /export declare function asSynaError<Code extends SynaErrorCode>\(error: unknown, code: Code, message: string, \.\.\.rest: DetailsArguments<Code>\): SynaError \| WrappedSynaError<Code>;/)
  assert.match(errors, /type ForeignCause = \{\s*readonly name: string;\s*readonly message: string;\s*\};/)
  assert.match(errors, /type WrappedSynaError<Code extends SynaErrorCode> = SynaErrorOf<Code> & \{\s*readonly details: \{\s*readonly cause: ForeignCause;\s*\};\s*\};/)
})
