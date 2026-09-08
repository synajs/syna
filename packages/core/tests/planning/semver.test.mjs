import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareVersions,
  isValidRange,
  normalizeVersion,
  parseVersion,
  satisfiesVersion,
} from '../../dist/semver.js'

// v0.5 (MIGRATION M-09): the npm `semver` package replaces the hand-written
// parser. Versions must be complete; partial forms are ranges, not versions.
test('semantic versions parse and normalize complete package versions only', () => {
  assert.equal(parseVersion('1.2.3').major, 1)
  const prerelease = parseVersion('1.2.3-beta.2')
  assert.deepEqual([prerelease.major, prerelease.minor, prerelease.patch], [1, 2, 3])
  assert.deepEqual(prerelease.prerelease, ['beta', 2])
  assert.equal(normalizeVersion(' 2.4.0 '), '2.4.0')
  assert.equal(normalizeVersion('1.0.0+build.7'), '1.0.0')
  assert.throws(() => parseVersion('1'), /Invalid semantic version/)
  assert.throws(() => parseVersion('2.4'), /Invalid semantic version/)
  assert.throws(() => parseVersion('not-a-version'), /Invalid semantic version/)
})

test('semantic version comparison follows semver precedence', () => {
  assert.equal(Math.sign(compareVersions('2.0.0', '1.9.9')), 1)
  assert.equal(Math.sign(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')), -1)
  assert.equal(Math.sign(compareVersions('1.0.0-beta', '1.0.0-beta.1')), -1)
  assert.equal(Math.sign(compareVersions('1.0.0-beta.1', '1.0.0-beta.x')), -1)
  assert.equal(Math.sign(compareVersions('1.0.0', '1.0.0-rc.1')), 1)
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0)
})

test('ranges cover exact, caret, tilde, wildcard, comparator sets, unions and prereleases', () => {
  assert.equal(satisfiesVersion('2.4.1', '2.4.1'), true)
  assert.equal(satisfiesVersion('2.4.1', '*'), true)
  assert.equal(satisfiesVersion('2.4.1', 'latest'), true)
  assert.equal(satisfiesVersion('2.4.1', '^2.3.0'), true)
  assert.equal(satisfiesVersion('3.0.0', '^2.3.0'), false)
  // 0.x caret ranges never widen to lower minors; 0.0.x never widens at all.
  assert.equal(satisfiesVersion('0.4.8', '^0.4.2'), true)
  assert.equal(satisfiesVersion('0.5.0', '^0.4.2'), false)
  assert.equal(satisfiesVersion('0.3.9', '^0.4.2'), false)
  assert.equal(satisfiesVersion('0.0.4', '^0.0.4'), true)
  assert.equal(satisfiesVersion('0.0.5', '^0.0.4'), false)
  assert.equal(satisfiesVersion('0.0.3', '^0.0.4'), false)
  assert.equal(satisfiesVersion('2.4.9', '~2.4.1'), true)
  assert.equal(satisfiesVersion('2.5.0', '~2.4.1'), false)
  assert.equal(satisfiesVersion('2.4.9', '2.x'), true)
  assert.equal(satisfiesVersion('2.4.9', '2.4.*'), true)
  assert.equal(satisfiesVersion('2.4.9', '>=2.2 <3'), true)
  assert.equal(satisfiesVersion('3.0.0', '>=2.2 <3'), false)
  assert.equal(satisfiesVersion('1.2.3', '1.x || 2.x'), true)
  assert.equal(satisfiesVersion('3.0.0', '1.x || 2.x'), false)
  assert.equal(satisfiesVersion('1.5.0', '>=1.2.0 <2.0.0 || >=3.0.0'), true)
  assert.equal(satisfiesVersion('2.0.0', '>=1.2.0 <2.0.0 || >=3.0.0'), false)
  // Admitted prereleases participate in Syna ranges (includePrerelease).
  assert.equal(satisfiesVersion('1.0.0-beta.2', '^1.0.0-beta.1'), true)
  assert.equal(satisfiesVersion('1.0.0', '^1.0.0-beta.1'), true)
  assert.equal(satisfiesVersion('1.1.0-rc.1', '^1.0.0'), true)
  assert.equal(satisfiesVersion('1.0.0-beta.1', '*'), true)
  assert.equal(isValidRange('definitely-not-a-range'), false)
  assert.throws(
    () => satisfiesVersion('2.4.9', 'definitely-not-a-range'),
    /not a valid semver range/,
  )
})
