/**
 * 严格 SemVer 契约（@helm/protocol/semver，全仓唯一实现）：
 * 语法判定、优先级比较（正式 > 预发布 / 数字 < 字母数字 / ASCII 字典序 /
 * build metadata 不参与）、v 前缀剥离与非法输入显式拒绝。
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
    it(`合法："${text}"`, { timeout: 60_000 }, () => {
      assert.equal(isStrictSemver(text), true)
      const parsed = parseStrictSemver(text)
      assert.ok(parsed !== null)
      assert.ok(parsed.core.length === 3 && parsed.core.every((n) => Number.isInteger(n) && n >= 0))
    })
  }
  for (const text of invalid) {
    it(`非法："${text}"`, { timeout: 60_000 }, () => {
      assert.equal(isStrictSemver(text), false)
      assert.equal(parseStrictSemver(text), null)
    })
  }
})

describe('compareStrictSemver 优先级', () => {
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

  it('数字段按数值：2 < 11', { timeout: 60_000 }, () => {
    assert.equal(compareStrictSemver('1.0.0-alpha.2', '1.0.0-alpha.11'), -1)
  })

  it('build metadata 不参与比较，核心号优先', { timeout: 60_000 }, () => {
    assert.equal(compareStrictSemver('1.0.0+build.123', '1.0.0+build.456'), 0)
    assert.equal(compareStrictSemver('1.0.0+sha.a1b2c3', '1.0.0'), 0)
    assert.equal(compareStrictSemver('1.0.0-rc.1+b1', '1.0.0-rc.2+b2'), -1)
    assert.equal(compareStrictSemver('1.0.1+a', '1.0.0+b'), 1)
  })

  it('预发布段少者更小', { timeout: 60_000 }, () => {
    assert.equal(compareStrictSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  })

  it('非法输入显式拒绝：抛 SemverFormatError 且指明非法一侧', { timeout: 60_000 }, () => {
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
