/**
 * 插件数据目录名映射专项测试（Windows 兼容的红线）。
 *
 * 背景：内置插件 id 带 `builtin:` 前缀，直接把 id 当目录名会让 Windows 把
 * `builtin:profile` 解释成 NTFS 交替数据流（mkdir 必 ENOENT），插件注册即崩。
 * 该映射是唯一权威点，务必锁死「目录名不含非法字符」与「外部插件 id 原样」两条不变量。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test from 'node:test'
import { strict as assert } from 'node:assert'

import { isBuiltinPluginDataDirName, pluginDataDirName } from '../src/plugins/plugin-dir-name.js'

test('内置插件 id 的数据目录名不含 Windows 保留字符', { timeout: 60_000 }, () => {
  assert.equal(pluginDataDirName('builtin:profile'), 'builtin%3Aprofile')
  assert.equal(pluginDataDirName('builtin:workflow'), 'builtin%3Aworkflow')
  // 目录名不得含 : / \ 等非法字符（Windows 文件名红线）
  for (const id of ['builtin:profile', 'builtin:herdr', 'builtin:json-render']) {
    assert.doesNotMatch(pluginDataDirName(id), /[:/\\*?"<>|]/, `${id} 的目录名含非法字符`)
  }
  // 映射必须单射：不同 id 不得落到同一目录
  const names = new Set(['builtin:profile', 'builtin:workflow', 'builtin:memory'].map(pluginDataDirName))
  assert.equal(names.size, 3)
})

test('外部插件 id 无冒号时原样返回（源目录即 ctx.dataDir 的既有约定）', { timeout: 60_000 }, () => {
  for (const id of ['demo-external', 'my.plugin-1', 'Some_Plugin']) {
    assert.equal(pluginDataDirName(id), id)
  }
})

test('任何含冒号的 id 都不得直接落盘（Windows 红线的普遍情形）', { timeout: 60_000 }, () => {
  for (const id of ['test:probe', 'remote:stub-node', 'builtin:herdr']) {
    assert.doesNotMatch(pluginDataDirName(id), /:/, `${id} 的目录名仍含冒号`)
  }
})

test('内置数据目录判定覆盖直接与转义两种形态', { timeout: 60_000 }, () => {
  assert.equal(isBuiltinPluginDataDirName('builtin:memory'), true)
  assert.equal(isBuiltinPluginDataDirName('builtin%3Amemory'), true)
  assert.equal(isBuiltinPluginDataDirName('demo-external'), false)
  assert.equal(isBuiltinPluginDataDirName('.hidden'), false)
})
