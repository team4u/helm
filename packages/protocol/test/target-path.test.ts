/**
 * Alignment tests for the target-path lexical rules (pathRulesForShape): using
 * node:path's posix / win32 implementations as the oracle, case by case, verify
 * that the protocol pure implementation (browser-safe, no Node builtins) matches
 * Node semantics exactly on the four lexical functions normalize / join /
 * dirname / basename (including trailing-separator preservation, dirname not
 * resolving '..', win32 device roots (drive / UNC), double separators and the
 * '.\' disambiguation prefix).
 */
import { posix, win32 } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsoluteTargetPath, pathRulesForShape, targetPathShape } from '@helm/protocol'

const posixRules = pathRulesForShape('posix')
const win32Rules = pathRulesForShape('win32')

/** Corpus generation: separator/dot-segment/device-root token combinations + targeted key cases (node behaviors confirmed by probing). */
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

describe('pathRulesForShape lexical rules aligned with node:path case by case', () => {
  it('normalize / dirname / basename agree on the full corpus', { timeout: 60_000 }, () => {
    for (const p of corpus()) {
      assert.equal(posixRules.normalize(p), posix.normalize(p), `posix.normalize(${JSON.stringify(p)})`)
      assert.equal(posixRules.dirname(p), posix.dirname(p), `posix.dirname(${JSON.stringify(p)})`)
      assert.equal(posixRules.basename(p), posix.basename(p), `posix.basename(${JSON.stringify(p)})`)
      assert.equal(win32Rules.normalize(p), win32.normalize(p), `win32.normalize(${JSON.stringify(p)})`)
      assert.equal(win32Rules.dirname(p), win32.dirname(p), `win32.dirname(${JSON.stringify(p)})`)
      assert.equal(win32Rules.basename(p), win32.basename(p), `win32.basename(${JSON.stringify(p)})`)
    }
  })

  it('join agrees on all triples of the full combination', { timeout: 60_000 }, () => {
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

  it('unknown shape falls back to POSIX (consistent with the kernel\'s original behavior)', { timeout: 60_000 }, () => {
    assert.equal(pathRulesForShape(undefined), posixRules)
    assert.equal(pathRulesForShape('win32'), win32Rules)
  })

  it('targeted spot checks of key behaviors (win32 device root / posix double-slash root / trailing-separator preservation)', { timeout: 60_000 }, () => {
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
