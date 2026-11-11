/**
 * 插件中心纯函数模型与检索过滤测试
 *
 * 验证：
 * 1. 关键字检索匹配：按名称、ID、暴露工具名、暴露动作名不区分大小写匹配；
 * 2. 状态筛选：全部、仅启用、仅停用；
 * 3. 统计汇总：计算总数、启用数、停用数、异常数、工具总数、动作总数；
 * 4. 故障态判定：status === failed 或 error 标记。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PluginSummary } from '@helm/protocol'
import {
  filterPlugins,
  isPluginFailed,
  summarizePlugins,
  type PluginFilterState,
  type PluginStatusFilter,
  type PluginSummaryStats,
} from '../src/plugins/plugin-center-model.js'

function makePlugin(overrides: Partial<PluginSummary> & { id: string }): PluginSummary {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    version: overrides.version ?? '0.1.0',
    locked: overrides.locked ?? false,
    enabled: overrides.enabled ?? true,
    hooks: overrides.hooks ?? [],
    actions: overrides.actions ?? [],
    tools: overrides.tools ?? [],
    status: overrides.status,
    error: overrides.error,
  }
}

test('filterPlugins: 空 query 返回全量克隆列表', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:profile', name: '个人助理' }),
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎' }),
  ]
  const result = filterPlugins(plugins, { query: '', status: 'all' })
  assert.equal(result.length, 2)
  assert.notEqual(result, plugins)
})

test('filterPlugins: 按名称检索匹配且不区分大小写', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:profile', name: '个人助理' }),
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎' }),
    makePlugin({ id: 'community:slack', name: 'Slack Bot' }),
  ]
  const result = filterPlugins(plugins, { query: '工作流' })
  assert.equal(result.length, 1)
  assert.equal(result[0]?.id, 'builtin:workflow')

  const upperResult = filterPlugins(plugins, { query: 'SLACK' })
  assert.equal(upperResult.length, 1)
  assert.equal(upperResult[0]?.id, 'community:slack')
})

test('filterPlugins: 按插件 ID 模糊匹配', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:profile', name: '个人助理' }),
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎' }),
    makePlugin({ id: 'community:slack', name: 'Slack Bot' }),
  ]
  const result = filterPlugins(plugins, { query: 'workflow' })
  assert.equal(result.length, 1)
  assert.equal(result[0]?.id, 'builtin:workflow')
})

test('filterPlugins: 按暴露的 tools 列表项匹配', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:profile', name: '个人助理', tools: ['update_memory', 'load_skill'] }),
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎', tools: ['subagent', 'cleanup_worktree'] }),
  ]
  const result = filterPlugins(plugins, { query: 'subagent' })
  assert.equal(result.length, 1)
  assert.equal(result[0]?.id, 'builtin:workflow')

  const partialResult = filterPlugins(plugins, { query: 'MEMORY' })
  assert.equal(partialResult.length, 1)
  assert.equal(partialResult[0]?.id, 'builtin:profile')
})

test('filterPlugins: 按暴露的 actions 列表项匹配', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎', actions: ['run', 'runs', 'inspect', 'abort'] }),
    makePlugin({ id: 'builtin:herdr', name: 'Herdr 控制台', actions: ['bridge_status', 'resume'] }),
  ]
  const result = filterPlugins(plugins, { query: 'inspect' })
  assert.equal(result.length, 1)
  assert.equal(result[0]?.id, 'builtin:workflow')
})

test('filterPlugins: 状态筛选 enabled 与 disabled', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:profile', enabled: true }),
    makePlugin({ id: 'builtin:workflow', enabled: true }),
    makePlugin({ id: 'builtin:herdr', enabled: false }),
  ]
  const enabledOnly = filterPlugins(plugins, { status: 'enabled' })
  assert.equal(enabledOnly.length, 2)
  assert.equal(enabledOnly.every((p) => p.enabled), true)

  const disabledOnly = filterPlugins(plugins, { status: 'disabled' })
  assert.equal(disabledOnly.length, 1)
  assert.equal(disabledOnly[0]?.id, 'builtin:herdr')
})

test('filterPlugins: 多条件组合筛选及无匹配回退', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:profile', name: '个人助理', enabled: true, tools: ['update_memory'] }),
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎', enabled: false, tools: ['subagent'] }),
    makePlugin({ id: 'builtin:superagent', name: 'SuperAgent', enabled: true, tools: ['subagent'] }),
  ]
  // 查找：enabled + 'subagent'
  const match = filterPlugins(plugins, { query: 'subagent', status: 'enabled' })
  assert.equal(match.length, 1)
  assert.equal(match[0]?.id, 'builtin:superagent')

  // 条件冲突无匹配
  const empty = filterPlugins(plugins, { query: 'not-found', status: 'enabled' })
  assert.equal(empty.length, 0)
})

test('summarizePlugins: 空数组统计全零', { timeout: 60_000 }, () => {
  const stats = summarizePlugins([])
  assert.deepEqual(stats, {
    total: 0,
    enabled: 0,
    disabled: 0,
    failed: 0,
    totalTools: 0,
    totalActions: 0,
  })
})

test('summarizePlugins: 正确统计总数、启停数、工具数与动作数', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({
      id: 'builtin:profile',
      enabled: true,
      tools: ['update_memory', 'load_skill'],
      actions: [],
    }),
    makePlugin({
      id: 'builtin:workflow',
      enabled: false,
      tools: ['subagent', 'cleanup_worktree'],
      actions: ['run', 'runs', 'inspect'],
    }),
    makePlugin({
      id: 'builtin:herdr',
      enabled: true,
      tools: [],
      actions: ['resume'],
    }),
  ]
  const stats = summarizePlugins(plugins)
  assert.deepEqual(stats, {
    total: 3,
    enabled: 2,
    disabled: 1,
    failed: 0,
    totalTools: 4,
    totalActions: 4,
  })
})

test('isPluginFailed: status === failed 或携带 error 即故障态', { timeout: 60_000 }, () => {
  assert.equal(isPluginFailed(makePlugin({ id: 'a', status: 'active' })), false)
  assert.equal(isPluginFailed(makePlugin({ id: 'b', status: 'disabled' })), false)
  assert.equal(isPluginFailed(makePlugin({ id: 'c', status: 'failed' })), true)
  // 兼容旧内核未填 status 但携带诊断错误的降级情形
  assert.equal(
    isPluginFailed(
      makePlugin({ id: 'd', error: { code: 'plugin_load_failed', message: '入口缺失', stage: 'scan' } }),
    ),
    true,
  )
})

test('summarizePlugins: 正确统计 failed 数量（status 与 error 双入口去重）', { timeout: 60_000 }, () => {
  const stats = summarizePlugins([
    makePlugin({ id: 'ok-1', enabled: true }),
    makePlugin({ id: 'ok-2', enabled: false }),
    makePlugin({
      id: 'bad-1',
      enabled: false,
      status: 'failed',
      error: { code: 'plugin_load_failed', message: '模块导入失败', stage: 'load' },
    }),
    makePlugin({
      id: 'bad-2',
      enabled: false,
      error: { code: 'plugin_enable_failed', message: '服务启动失败', stage: 'enable' },
    }),
  ])
  assert.equal(stats.total, 4)
  assert.equal(stats.enabled, 1)
  assert.equal(stats.disabled, 3)
  assert.equal(stats.failed, 2)
})
