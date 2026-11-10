/**
 * 插件中心纯函数模型与分类过滤测试
 *
 * 验证：
 * 1. 分类推导：核心系统、协同编排、工具扩展、外部三方；
 * 2. 多维检索过滤：按名称、ID、暴露工具名、暴露动作名不区分大小写匹配；
 * 3. 状态筛选：全部、仅启用、仅停用；
 * 4. 分类标签筛选：全部与指定具体类别；
 * 5. 多条件组合筛选与不可变性；
 * 6. 统计汇总：计算总数、启用数、停用数、工具总数、动作总数。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PluginSummary } from '@helm/protocol'
import {
  derivePluginCategory,
  filterPlugins,
  summarizePlugins,
  type PluginCategory,
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
  }
}

test('derivePluginCategory: 核心内置插件推导为 builtin', { timeout: 60_000 }, () => {
  assert.equal(derivePluginCategory('builtin:assistant'), 'builtin')
  assert.equal(derivePluginCategory('builtin:triggers'), 'builtin')
  assert.equal(derivePluginCategory('builtin:system'), 'builtin')
  assert.equal(derivePluginCategory('BUILTIN:ASSISTANT'), 'builtin')
})

test('derivePluginCategory: 编排类插件推导为 orchestration', { timeout: 60_000 }, () => {
  assert.equal(derivePluginCategory('builtin:workflow'), 'orchestration')
  assert.equal(derivePluginCategory('builtin:herdr'), 'orchestration')
  assert.equal(derivePluginCategory('builtin:superagent'), 'orchestration')
  assert.equal(derivePluginCategory('workflow'), 'orchestration')
  assert.equal(derivePluginCategory('herdr'), 'orchestration')
  assert.equal(derivePluginCategory('superagent'), 'orchestration')
})

test('derivePluginCategory: 工具类插件推导为 tools', { timeout: 60_000 }, () => {
  assert.equal(derivePluginCategory('builtin:tools'), 'tools')
  assert.equal(derivePluginCategory('tools'), 'tools')
  assert.equal(derivePluginCategory('tools:calculator'), 'tools')
  assert.equal(derivePluginCategory('tool:search'), 'tools')
})

test('derivePluginCategory: 外部与社区插件推导为 external', { timeout: 60_000 }, () => {
  assert.equal(derivePluginCategory('community:github'), 'external')
  assert.equal(derivePluginCategory('slack-notifier'), 'external')
  assert.equal(derivePluginCategory('custom_bot'), 'external')
  assert.equal(derivePluginCategory(''), 'external')
})

test('filterPlugins: 空 query 与 all 过滤返回全量克隆列表', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:assistant', name: '个人助理' }),
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎' }),
  ]
  const result = filterPlugins(plugins, { query: '', status: 'all', category: 'all' })
  assert.equal(result.length, 2)
  assert.notEqual(result, plugins)
})

test('filterPlugins: 按名称检索匹配且不区分大小写', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:assistant', name: '个人助理' }),
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎' }),
    makePlugin({ id: 'community:slack', name: 'Slack Bot' }),
  ]
  const result = filterPlugins(plugins, { query: '工作流', status: 'all', category: 'all' })
  assert.equal(result.length, 1)
  assert.equal(result[0]?.id, 'builtin:workflow')

  const upperResult = filterPlugins(plugins, { query: 'SLACK', status: 'all', category: 'all' })
  assert.equal(upperResult.length, 1)
  assert.equal(upperResult[0]?.id, 'community:slack')
})

test('filterPlugins: 按插件 ID 模糊匹配', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:assistant', name: '个人助理' }),
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎' }),
    makePlugin({ id: 'community:slack', name: 'Slack Bot' }),
  ]
  const result = filterPlugins(plugins, { query: 'workflow', status: 'all', category: 'all' })
  assert.equal(result.length, 1)
  assert.equal(result[0]?.id, 'builtin:workflow')
})

test('filterPlugins: 按暴露的 tools 列表项匹配', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:assistant', name: '个人助理', tools: ['update_memory', 'load_skill'] }),
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎', tools: ['subagent', 'cleanup_worktree'] }),
  ]
  const result = filterPlugins(plugins, { query: 'subagent', status: 'all', category: 'all' })
  assert.equal(result.length, 1)
  assert.equal(result[0]?.id, 'builtin:workflow')

  const partialResult = filterPlugins(plugins, { query: 'MEMORY', status: 'all', category: 'all' })
  assert.equal(partialResult.length, 1)
  assert.equal(partialResult[0]?.id, 'builtin:assistant')
})

test('filterPlugins: 按暴露的 actions 列表项匹配', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎', actions: ['run', 'runs', 'inspect', 'abort'] }),
    makePlugin({ id: 'builtin:herdr', name: 'Herdr 控制台', actions: ['bridge_status', 'resume'] }),
  ]
  const result = filterPlugins(plugins, { query: 'inspect', status: 'all', category: 'all' })
  assert.equal(result.length, 1)
  assert.equal(result[0]?.id, 'builtin:workflow')
})

test('filterPlugins: 状态筛选 enabled 与 disabled', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:assistant', enabled: true }),
    makePlugin({ id: 'builtin:workflow', enabled: true }),
    makePlugin({ id: 'builtin:herdr', enabled: false }),
  ]
  const enabledOnly = filterPlugins(plugins, { query: '', status: 'enabled', category: 'all' })
  assert.equal(enabledOnly.length, 2)
  assert.equal(enabledOnly.every((p) => p.enabled), true)

  const disabledOnly = filterPlugins(plugins, { query: '', status: 'disabled', category: 'all' })
  assert.equal(disabledOnly.length, 1)
  assert.equal(disabledOnly[0]?.id, 'builtin:herdr')
})

test('filterPlugins: 分类筛选 category', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:assistant' }),
    makePlugin({ id: 'builtin:workflow' }),
    makePlugin({ id: 'builtin:herdr' }),
    makePlugin({ id: 'tools:calculator' }),
    makePlugin({ id: 'community:github' }),
  ]
  const orchOnly = filterPlugins(plugins, { query: '', status: 'all', category: 'orchestration' })
  assert.equal(orchOnly.length, 2)
  assert.deepEqual(orchOnly.map((p) => p.id), ['builtin:workflow', 'builtin:herdr'])

  const builtinOnly = filterPlugins(plugins, { query: '', status: 'all', category: 'builtin' })
  assert.equal(builtinOnly.length, 1)
  assert.equal(builtinOnly[0]?.id, 'builtin:assistant')

  const toolsOnly = filterPlugins(plugins, { query: '', status: 'all', category: 'tools' })
  assert.equal(toolsOnly.length, 1)
  assert.equal(toolsOnly[0]?.id, 'tools:calculator')

  const extOnly = filterPlugins(plugins, { query: '', status: 'all', category: 'external' })
  assert.equal(extOnly.length, 1)
  assert.equal(extOnly[0]?.id, 'community:github')
})

test('filterPlugins: 多条件组合筛选及无匹配回退', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({ id: 'builtin:assistant', name: '个人助理', enabled: true, tools: ['update_memory'] }),
    makePlugin({ id: 'builtin:workflow', name: '工作流引擎', enabled: false, tools: ['subagent'] }),
    makePlugin({ id: 'builtin:superagent', name: 'SuperAgent', enabled: true, tools: ['subagent'] }),
  ]
  // 查找：enabled + orchestration + 'subagent'
  const match = filterPlugins(plugins, { query: 'subagent', status: 'enabled', category: 'orchestration' })
  assert.equal(match.length, 1)
  assert.equal(match[0]?.id, 'builtin:superagent')

  // 条件冲突无匹配
  const empty = filterPlugins(plugins, { query: 'not-found', status: 'enabled', category: 'all' })
  assert.equal(empty.length, 0)
})

test('summarizePlugins: 空数组统计全零', { timeout: 60_000 }, () => {
  const stats = summarizePlugins([])
  assert.deepEqual(stats, {
    total: 0,
    enabled: 0,
    disabled: 0,
    totalTools: 0,
    totalActions: 0,
  })
})

test('summarizePlugins: 正确统计总数、启停数、工具数与动作数', { timeout: 60_000 }, () => {
  const plugins: PluginSummary[] = [
    makePlugin({
      id: 'builtin:assistant',
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
    totalTools: 4,
    totalActions: 4,
  })
})
