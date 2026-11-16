/**
 * plugin data directory name mapping dedicated items test (Windows compatibility hard rule).
 *
 * background: built-in plugin id carries `builtin:` prefix, directly id when directory name will let Windows 
 * `builtin:profile` explain into NTFS hand over replace data stream (mkdir must ENOENT), plugin register i.e. crash.
 * the mapping is unique right threat point, must lock die directory name excludes illegal character and external plugin id original two invariant.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import test from 'node:test'
import { strict as assert } from 'node:assert'

import { isBuiltinPluginDataDirName, pluginDataDirName } from '../src/plugins/plugin-dir-name.js'

test('built-in plugin id data directory name excludes Windows keep character', { timeout: 60_000 }, () => {
  assert.equal(pluginDataDirName('builtin:profile'), 'builtin%3Aprofile')
  assert.equal(pluginDataDirName('builtin:workflow'), 'builtin%3Aworkflow')
  // directory name must not contains : / \ etc. illegal character (Windows filename hard rule)
  for (const id of ['builtin:profile', 'builtin:herdr', 'builtin:json-render']) {
    assert.doesNotMatch(pluginDataDirName(id), /[:/\\*?"<>|]/, `${id} directory name contains illegal character`)
  }
  // mapping must single shoot: different id must not to the same directory
  const names = new Set(['builtin:profile', 'builtin:workflow', 'builtin:memory'].map(pluginDataDirName))
  assert.equal(names.size, 3)
})

test('external plugin id without smoke number when original return (source directory i.e. ctx.dataDir since has convention)', { timeout: 60_000 }, () => {
  for (const id of ['demo-external', 'my.plugin-1', 'Some_Plugin']) {
    assert.equal(pluginDataDirName(id), id)
  }
})

test('any contains smoke number id all must not directly (Windows hard rule general iterate case)', { timeout: 60_000 }, () => {
  for (const id of ['test:probe', 'remote:stub-node', 'builtin:herdr']) {
    assert.doesNotMatch(pluginDataDirName(id), /:/, `${id} directory name still contains smoke number`)
  }
})

test('inside placement data directory decide override directly and escaping two kinds of form', { timeout: 60_000 }, () => {
  assert.equal(isBuiltinPluginDataDirName('builtin:memory'), true)
  assert.equal(isBuiltinPluginDataDirName('builtin%3Amemory'), true)
  assert.equal(isBuiltinPluginDataDirName('demo-external'), false)
  assert.equal(isBuiltinPluginDataDirName('.hidden'), false)
})
