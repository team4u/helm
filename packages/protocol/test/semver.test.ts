/**
 * Strict SemVer contract (@helmx/protocol/semver, the repo's single implementation):
 * grammar checks, precedence comparison (release > prerelease / numeric <
 * alphanumeric / ASCII lexicographic / build metadata excluded), v-prefix
 * stripping, and explicit rejection of invalid input.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SemverFormatError,
  compareStrictSemver,
  isStrictSemver,
  parseStrictSemver,
  stripSemverVPrefix,
} from '@helmx/protocol'

describe('isStrictSemver / parseStrictSemver', () => {
  const valid: readonly string[] = [
    '0.0.0',
    '1.2.3',
    '24.12.0',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-0.3.7',
    '1.0.0-x.7.z.92',
    '1.0.0-alpha+build.123',
    '1.0.0+build.001',
  ]
  const invalid: readonly string[] = [
    '',
    '1',
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    'V1.2.3',
    ' 1.2.3',
    '1.2.3 ',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-+bad_build',
    '1.2.3+bad_build',
    'latest',
    '1.2.3-beta..1',
  ]
  for (const text of valid) {
    it(`valid: "${text}"`, { timeout: 60_000 }, () => {
      assert.equal(isStrictSemver(text), true)
      const parsed = parseStrictSemver(text)
      assert.ok(parsed !== null)
      assert.ok(parsed.core.length === 3 && parsed.core.every((n) => Number.isInteger(n) && n >= 0))
    })
  }
  for (const text of invalid) {
    it(`invalid: "${text}"`, { timeout: 60_000 }, () => {
      assert.equal(isStrictSemver(text), false)
      assert.equal(parseStrictSemver(text), null)
    })
  }
})

describe('compareStrictSemver precedence', () => {
  const ordered: readonly string[] = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.2.0',
    '1.10.0',
    '2.0.0',
    '24.12.0',
  ]
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      const expected = i < j ? -1 : i > j ? 1 : 0
      it(`compare("${ordered[i]}", "${ordered[j]}") = ${expected}`, { timeout: 60_000 }, () => {
        assert.equal(compareStrictSemver(ordered[i]!, ordered[j]!), expected)
      })
    }
  }

  it('numeric segments compare numerically: 2 < 11', { timeout: 60_000 }, () => {
    assert.equal(compareStrictSemver('1.0.0-alpha.2', '1.0.0-alpha.11'), -1)
  })

  it('build metadata excluded from comparison; core numbers take precedence', { timeout: 60_000 }, () => {
    assert.equal(compareStrictSemver('1.0.0+build.123', '1.0.0+build.456'), 0)
    assert.equal(compareStrictSemver('1.0.0+sha.a1b2c3', '1.0.0'), 0)
    assert.equal(compareStrictSemver('1.0.0-rc.1+b1', '1.0.0-rc.2+b2'), -1)
    assert.equal(compareStrictSemver('1.0.1+a', '1.0.0+b'), 1)
  })

  it('fewer prerelease segments sort lower', { timeout: 60_000 }, () => {
    assert.equal(compareStrictSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  })

  it('invalid input explicitly rejected: throws SemverFormatError naming the invalid side', { timeout: 60_000 }, () => {
    for (const bad of ['1.2', 'v1.2.3', 'latest', '']) {
      assert.throws(() => compareStrictSemver(bad, '1.0.0'), SemverFormatError)
      assert.throws(() => compareStrictSemver('1.0.0', bad), SemverFormatError)
      assert.throws(() => compareStrictSemver(bad, bad), (error: unknown) => {
        assert.ok(error instanceof SemverFormatError)
        assert.match(error.message, /"[\s\S]*"/)
        return true
      })
    }
  })
})

describe('stripSemverVPrefix', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['1.2.3', '1.2.3'],
    ['  1.2.3  ', '1.2.3'],
    ['v1.2.3', '1.2.3'],
    ['V1.2.3', '1.2.3'],
    [' v1.2.3-rc.1 ', '1.2.3-rc.1'],
    ['vv1.2.3', 'v1.2.3'],
    ['', ''],
  ]
  for (const [raw, expected] of cases) {
    it(`"${raw}" -> "${expected}"`, { timeout: 60_000 }, () => {
      assert.equal(stripSemverVPrefix(raw), expected)
    })
  }
})
