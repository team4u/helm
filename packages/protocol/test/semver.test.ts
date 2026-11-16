/**
 * Strict SemVer contract (@helm/protocol/semver, the repo's single implementation):
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
} from '@helm/protocol'
// Cross-package isomorphism lock exception: desktop has zero workspace runtime
// dependencies (a standalone Electron shell) and keeps a local implementation of
// the same contract in packages/desktop/src/runners.ts; this test relatively
// imports the source to lock both implementations to identical behavior
// (cross-package relative imports remain forbidden in production source).
import {
  SemverFormatError as DesktopSemverFormatError,
  compareStrictSemver as desktopCompareStrictSemver,
  isStrictSemver as desktopIsStrictSemver,
} from '../../desktop/src/runners.js'

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

// ---------------------------------------------------------------------------
// Cross-package isomorphism lock: @helm/protocol/semver vs the desktop local implementation (runners.ts)
// ---------------------------------------------------------------------------

describe('desktop isomorphism lock (packages/desktop/src/runners.ts must not drift)', () => {
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

  it('isStrictSemver agrees on every valid / invalid input', { timeout: 60_000 }, () => {
    for (const text of [...valid, ...invalid]) {
      assert.equal(
        desktopIsStrictSemver(text),
        isStrictSemver(text),
        `desktop isStrictSemver(${JSON.stringify(text)}) disagrees with @helm/protocol`,
      )
    }
  })

  it('compareStrictSemver agrees on every ordered pair (including build metadata)', { timeout: 60_000 }, () => {
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
    // Add build metadata and numeric / alphanumeric identifier variants to cover every comparison branch of both implementations.
    const pool: readonly string[] = [
      ...ordered,
      '1.0.0+build.123',
      '1.0.0+sha.a1b2c3',
      '1.0.0-rc.1+b1',
      '1.0.0-rc.2+b2',
      '1.0.0-alpha.2',
      '1.0.0-alpha.11',
      '1.0.1+a',
      '1.0.0+b',
    ]
    for (const a of pool) {
      for (const b of pool) {
        assert.equal(
          desktopCompareStrictSemver(a, b),
          compareStrictSemver(a, b),
          `desktop compareStrictSemver(${JSON.stringify(a)}, ${JSON.stringify(b)}) disagrees with @helm/protocol`,
        )
      }
    }
  })

  it('SemverFormatError throw conditions, name, and message shape fully aligned', { timeout: 60_000 }, () => {
    const capture = (fn: () => unknown): Error => {
      try {
        fn()
      } catch (error) {
        assert.ok(error instanceof Error, 'expected an Error instance to be thrown')
        return error
      }
      assert.fail('expected a SemverFormatError to be thrown, but nothing was thrown')
    }
    for (const bad of invalid) {
      // Both sides explicitly reject (the invalid side on the left / right each throws its own SemverFormatError).
      assert.throws(() => compareStrictSemver(bad, '1.0.0'), SemverFormatError)
      assert.throws(() => compareStrictSemver('1.0.0', bad), SemverFormatError)
      assert.throws(() => desktopCompareStrictSemver(bad, '1.0.0'), DesktopSemverFormatError)
      assert.throws(() => desktopCompareStrictSemver('1.0.0', bad), DesktopSemverFormatError)
      // Error envelope isomorphism: name must match verbatim and both messages must
      // quote the rejected input. Verbatim message parity was intentionally dropped
      // when @helm/protocol switched to English messages (desktop keeps its own
      // localized copy; message text is presentation, not contract).
      const protocolError = capture(() => compareStrictSemver(bad, '1.0.0'))
      const desktopError = capture(() => desktopCompareStrictSemver(bad, '1.0.0'))
      assert.equal(protocolError.name, 'SemverFormatError')
      assert.equal(desktopError.name, 'SemverFormatError')
      assert.ok(
        protocolError.message.includes(bad),
        `protocol SemverFormatError message should contain the rejected input (input ${JSON.stringify(bad)})`,
      )
      assert.ok(
        desktopError.message.includes(bad),
        `desktop SemverFormatError message should contain the rejected input (input ${JSON.stringify(bad)})`,
      )
    }
  })
})
