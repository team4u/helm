/**
 * 目标路径词法规则（pathRulesForShape）对齐测试：以 node:path 的
 * posix / win32 实现为 oracle，逐用例校验 protocol 纯实现（浏览器安全、
 * 无 Node 内置依赖）在 normalize / join / dirname / basename 四个词法
 * 函数上与 Node 语义完全一致（含结尾分隔符保留、dirname 不消解 '..'、
 * win32 设备根（盘符 / UNC）、双分隔符与 '.\' 消歧前缀等行为）。
 */
import { posix, win32 } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsoluteTargetPath, pathRulesForShape, targetPathShape } from '@helm/protocol'

const posixRules = pathRulesForShape('posix')
const win32Rules = pathRulesForShape('win32')

/** 语料生成：分隔符/点段/设备根 token 组合 + 定向关键用例（探针确认过的 node 行为）。 */
function corpus(): string[] {
  const seps = ['/', '\\', '//', '\\\\', '/\\']
  const names = ['', '.', '..', 'a', 'ab', 'a.b', '.h', 'C:', 'C:a', 'AB:', 'z:', 'C:..']
  const out = new Set<string>()
  for (const a of [...seps, ...names]) {
    out.add(a)
    for (const s of seps) {
      for (const b of names) out.add(`${a}${s}${b}`)
    }
  }
  for (const c of [
    '', '.', '..', '/', '//', '///', '////', 'C:', 'C:/', 'C:\\', 'C:a', 'C:\\a',
    '\\\\srv\\share', '\\\\srv\\share\\', '\\\\srv\\share\\a', '\\\\srv\\share\\a\\b\\',
    '\\\\srv\\share\\..\\a', 'C:\\a\\..\\..\\b', 'a\\..\\', 'a/..', 'a/../', '.\\a',
    '//a', '//a/b', '///a', '/a/b//c', 'a/b//c', '/ab//', '//ab',
    'x\\C:\\..', 'x\\C:b\\..', 'x\\C:\\..\\y', 'C:x\\..', 'C:x\\..\\..', 'x\\..\\C:a\\..',
    'AB:/..', 'AB:\\..', 'AB:\\..\\', 'a\\AB:', 'a\\z:', 'a\\C:b', 'a\\C:..\\b', '.\\C:a',
    'C:b\\a', 'a\\b\\C:x', 'a\\C:\\b', 'b\\a\\C:', '.\\C:\\a', '\\a\\b', '\\a', '\\',
  ]) {
    out.add(c)
  }
  return [...out]
}

describe('pathRulesForShape 词法规则与 node:path 逐用例对齐', () => {
  it('normalize / dirname / basename 全语料一致', { timeout: 60_000 }, () => {
    for (const p of corpus()) {
      assert.equal(posixRules.normalize(p), posix.normalize(p), `posix.normalize(${JSON.stringify(p)})`)
      assert.equal(posixRules.dirname(p), posix.dirname(p), `posix.dirname(${JSON.stringify(p)})`)
      assert.equal(posixRules.basename(p), posix.basename(p), `posix.basename(${JSON.stringify(p)})`)
      assert.equal(win32Rules.normalize(p), win32.normalize(p), `win32.normalize(${JSON.stringify(p)})`)
      assert.equal(win32Rules.dirname(p), win32.dirname(p), `win32.dirname(${JSON.stringify(p)})`)
      assert.equal(win32Rules.basename(p), win32.basename(p), `win32.basename(${JSON.stringify(p)})`)
    }
  })

  it('join 三元组全组合一致', { timeout: 60_000 }, () => {
    const tokens = ['', 'a', '/a', 'C:\\a', 'C:', '\\\\srv\\share', '..', '.', 'b', '\\b', 'C:/a', 'a/', 'D:\\x', 'AB:']
    for (const a of tokens) {
      for (const b of tokens) {
        for (const c of ['', 'c']) {
          assert.equal(posixRules.join(a, b, c), posix.join(a, b, c), `posix.join(${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(c)})`)
          assert.equal(win32Rules.join(a, b, c), win32.join(a, b, c), `win32.join(${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(c)})`)
        }
      }
    }
  })

  it('形状未知回退 POSIX（与内核原行为一致）', { timeout: 60_000 }, () => {
    assert.equal(pathRulesForShape(undefined), posixRules)
    assert.equal(pathRulesForShape('win32'), win32Rules)
  })

  it('关键行为定点抽查（win32 设备根 / posix 双斜杠根 / 结尾分隔符保留）', { timeout: 60_000 }, () => {
    assert.equal(win32Rules.normalize('C:/a/b'), 'C:\\a\\b')
    assert.equal(win32Rules.normalize('C:'), 'C:.')
    assert.equal(win32Rules.normalize('\\\\srv\\share'), '\\\\srv\\share\\')
    assert.equal(win32Rules.dirname('\\\\srv\\share\\a'), '\\\\srv\\share\\')
    assert.equal(win32Rules.basename('C:'), '')
    assert.equal(posixRules.dirname('//a'), '//')
    assert.equal(posixRules.normalize('a//b'), 'a/b')
    assert.equal(posixRules.normalize('a/../'), './')
    assert.equal(posixRules.basename('/a/b/'), 'b')
    assert.equal(posixRules.join('a', '/b'), 'a/b')
    assert.equal(targetPathShape('C:/x'), 'win32')
    assert.equal(targetPathShape('/x'), 'posix')
    assert.equal(isAbsoluteTargetPath('C:relative'), false)
  })
})
