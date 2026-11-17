/**
 * Unit tests for plugin data directory name mapping (Windows compatibility hard rule).
 *
 * Background: built-in plugin IDs carry a `builtin:` prefix; using the raw ID as a directory name
 * causes Windows to interpret `builtin:profile` as an NTFS alternate data stream (mkdir ENOENT),
 * crashing plugin registration immediately. This mapper is the single authoritative conversion
 * point, locking two invariants: safe directory names free of illegal characters, and verbatim
 * preservation of external plugin IDs.
 *
 * Runner: tsx --test; every test specifies timeout: 60_000 against deadlocks.
 */
import test from 'node:test'
import { strict as assert } from 'node:assert'

import { isBuiltinPluginDataDirName, pluginDataDirName } from '../src/plugins/plugin-dir-name.js'

test('built-in plugin id directory name excludes Windows reserved characters', { timeout: 60_000 }, () => {
  assert.equal(pluginDataDirName('builtin:profile'), 'builtin%3Aprofile')
  assert.equal(pluginDataDirName('builtin:workflow'), 'builtin%3Aworkflow')
  // Directory names must never contain : / \ etc. invalid characters (Windows filename hard rule).
  for (const id of ['builtin:profile', 'builtin:herdr', 'builtin:json-render']) {
    assert.doesNotMatch(pluginDataDirName(id), /[:/\\*?"<>|]/, `${id} directory name contains invalid character`)
  }
  // Mapping must be injective: distinct IDs must not map to the same directory.
  const names = new Set(['builtin:profile', 'builtin:workflow', 'builtin:memory'].map(pluginDataDirName))
  assert.equal(names.size, 3)
})

test('external plugin IDs without colons return verbatim (preserving ctx.dataDir directory convention)', { timeout: 60_000 }, () => {
  for (const id of ['demo-external', 'my.plugin-1', 'Some_Plugin']) {
    assert.equal(pluginDataDirName(id), id)
  }
})

test('any ID containing a colon must never pass through unescaped (general Windows rule)', { timeout: 60_000 }, () => {
  for (const id of ['test:probe', 'remote:stub-node', 'builtin:herdr']) {
    assert.doesNotMatch(pluginDataDirName(id), /:/, `${id} directory name still contains a colon`)
  }
})

test('built-in data dir detection matches both raw and percent-encoded forms', { timeout: 60_000 }, () => {
  assert.equal(isBuiltinPluginDataDirName('builtin:memory'), true)
  assert.equal(isBuiltinPluginDataDirName('builtin%3Amemory'), true)
  assert.equal(isBuiltinPluginDataDirName('demo-external'), false)
  assert.equal(isBuiltinPluginDataDirName('.hidden'), false)
})
