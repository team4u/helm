/**
 * 插件中心 Screen 快捷打开测试：
 * - PluginCard 组件（真实 DOM 渲染）：enabled 且有 Screen 贡献时底栏渲染「打开视图」，
 *   点击阻止冒泡并以主屏 screen target 调用 store.openTarget；停用/无贡献不渲染；
 * - PluginDetailDrawer 源码契约：操作栏经 store.openTarget 唯一导航（不直接操作 history）；
 * - PluginCenter 模型：「应用」分类只统计非 builtin 且有 Screen 的外部插件。
 *
 * 说明：PluginDetailDrawer 完整组件渲染依赖配置读取副作用（happy-dom 下相对路径
 * fetch 永不完成，曾在 act 内挂起 120s），此处以源码契约断言其导航行为，
 * 交互行为由 PluginCard 组件测试与插件中心集成测试共同覆盖。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import * as ReactDOMClient from 'react-dom/client'
import type { PluginSummary } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { PluginCard } from '../src/plugins/PluginCard.js'
import { buildCategoryCounts, filterPlugins } from '../src/plugins/plugin-center-model.js'
import { makeTestStore } from './helpers/store.js'
import type { HelmStoreValue, ResolvedTarget } from '../src/lib/types.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const PKG_ROOT = new URL('..', import.meta.url)

function makePlugin(partial: Partial<PluginSummary> & { id: string }): PluginSummary {
  return {
    name: partial.name ?? partial.id,
    version: '1.0.0',
    locked: false,
    enabled: true,
    hooks: [],
    actions: [],
    tools: [],
    ...partial,
  }
}

const APP_PLUGIN = makePlugin({ id: 'todo-app', name: '待办应用', enabled: true })
const SCREEN_UI = [
  {
    pluginId: 'todo-app',
    surface: 'screen',
    spec: { id: 'main', label: '待办台', client: { module: 'index.tsx', export: 'Main' } },
  },
  {
    pluginId: 'todo-app',
    surface: 'screen',
    spec: { id: 'stats', label: '统计', client: { module: 'index.tsx', export: 'Stats' } },
  },
]

function screenStore(
  plugins: PluginSummary[],
  ui: Array<{ pluginId: string; surface: string; spec: Record<string, unknown> }>,
  openTarget?: HelmStoreValue['openTarget'],
): HelmStoreValue {
  return makeTestStore({
    plugins,
    uiContributions: ui as HelmStoreValue['uiContributions'],
    groupedUi: {
      ...makeTestStore().groupedUi,
      screens: ui
        .filter((item) => item.surface === 'screen')
        .map((item) => ({ pluginId: item.pluginId, spec: item.spec as never })),
    },
    ...(openTarget !== undefined ? { openTarget } : {}),
  })
}

interface OpenCall {
  target: ResolvedTarget
  split: boolean
}

// ---------------------------------------------------------------------------
// PluginCard 组件：打开视图按钮渲染与导航回调
// ---------------------------------------------------------------------------

test('PluginCard：enabled 且有 Screen 时底栏渲染打开视图，点击阻止冒泡并以主屏 target 导航', { timeout: 60_000 }, async () => {
  const calls: OpenCall[] = []
  const selections: string[] = []
  const store = screenStore([APP_PLUGIN], SCREEN_UI, (target, opts) => {
    calls.push({ target: target as ResolvedTarget, split: opts?.split === true })
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  await act(async () => {
    root.render(
      e(HelmStoreContext.Provider, { value: store },
        e(PluginCard, {
          plugin: APP_PLUGIN,
          selected: false,
          onSelect: () => selections.push('card'),
          onToggle: () => {},
        })),
    )
  })

  const openBtn = host.querySelector<HTMLButtonElement>('.plugin-card-open-btn')
  assert.ok(openBtn, '应渲染「打开视图」按钮')

  await act(async () => {
    openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(
    calls,
    [{ target: { kind: 'screen', pluginId: 'todo-app', screenId: 'main' }, split: false }],
    '点击打开视图以主屏 screen target 调用 openTarget（首个 Screen 为主视图）',
  )
  assert.deepEqual(selections, [], '点击打开按钮不得触发卡片 onSelect 冒泡')

  act(() => root.unmount())
  host.remove()
})

test('PluginCard：停用或无 Screen 时不渲染打开按钮（无 Provider 也可渲染）', { timeout: 60_000 }, async () => {
  for (const plugin of [makePlugin({ id: 'todo-app', enabled: false }), APP_PLUGIN]) {
    const store = screenStore([plugin], plugin.enabled ? [] : SCREEN_UI)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = ReactDOMClient.createRoot(host)
    await act(async () => {
      root.render(
        e(HelmStoreContext.Provider, { value: store },
          e(PluginCard, { plugin, selected: false, onSelect: () => {}, onToggle: () => {} })),
      )
    })
    assert.equal(host.querySelector('.plugin-card-open-btn'), null)
    act(() => root.unmount())
    host.remove()
  }

  // 无 Provider（HelmStoreContext 为 null）：卡片可渲染且不出现打开按钮
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  await act(async () => {
    root.render(e(PluginCard, { plugin: APP_PLUGIN, selected: false, onSelect: () => {}, onToggle: () => {} }))
  })
  assert.equal(host.querySelector('.plugin-card-open-btn'), null)
  act(() => root.unmount())
  host.remove()
})

// ---------------------------------------------------------------------------
// PluginDetailDrawer 源码契约：Screen 快捷打开经 store.openTarget 唯一导航
// ---------------------------------------------------------------------------

test('PluginDetailDrawer 契约：enabled 插件经 store.openTarget 打开主视图并支持 split（零 history 直操作）', { timeout: 60_000 }, () => {
  const src = readFileSync(new URL('src/plugins/PluginDetailDrawer.tsx', PKG_ROOT), 'utf-8')
  // 从 grouped UI 左连接 Screen（PluginSummary 不携带 screens，不虚构）
  assert.match(src, /listPluginScreens\(store\.groupedUi, plugin\.id\)/)
  // 主屏与右屏分别以 openTarget / split: true 调用（唯一导航机制，不直接操作 history）
  assert.match(src, /store\.openTarget\(\{\s*kind: 'screen',\s*pluginId: primaryScreen\.pluginId,\s*screenId: primaryScreen\.screenId,?\s*\}\)/)
  assert.match(src, /store\.openTarget\(\s*\{\s*kind: 'screen',\s*pluginId: primaryScreen\.pluginId,\s*screenId: primaryScreen\.screenId,?\s*\},\s*\{ split: true \},?\s*\)/)
  assert.doesNotMatch(src, /history\.(push|replace)State/, '不得直接操作浏览器历史')
})

// ---------------------------------------------------------------------------
// PluginCenter 模型：「应用」分类
// ---------------------------------------------------------------------------

test('PluginCenter 模型：「应用」分类只统计非 builtin 且有 Screen 贡献的外部插件', { timeout: 60_000 }, () => {
  const plugins = [
    makePlugin({ id: 'todo-app', name: '待办应用', enabled: true }),
    makePlugin({ id: 'tracker-app', name: '追踪应用', enabled: false }),
    makePlugin({ id: 'community:plain', name: '无视图插件', enabled: true }),
    makePlugin({ id: 'builtin:superagent', name: 'SuperAgent', enabled: true }),
  ]
  const screens = [
    { pluginId: 'todo-app' },
    { pluginId: 'tracker-app' },
    { pluginId: 'builtin:superagent' },
  ]

  const counts = buildCategoryCounts(plugins, screens)
  assert.equal(counts.apps, 2, '仅 todo-app 与 tracker-app（内置 superagent 视图不混入）')

  const apps = filterPlugins(plugins, { query: '', categoryTab: 'apps', screens })
  assert.deepEqual(apps.map((p) => p.id), ['todo-app', 'tracker-app'], '停用应用同样保留（可重新启用）')

  // screens 缺省：应用标签返回空集，其余分类不受影响
  const noScreens = filterPlugins(plugins, { query: '', categoryTab: 'apps' })
  assert.deepEqual(noScreens, [])
  assert.equal(buildCategoryCounts(plugins).apps, 0)

  // 既有分类计数不受 screens 参数影响（回归保护；superagent 属编排类不计 system）
  const countsNoScreens = buildCategoryCounts(plugins)
  assert.equal(countsNoScreens.all, 4)
  assert.equal(countsNoScreens.enabled, 3)
  assert.equal(countsNoScreens.orchestration, 1, 'superagent 属编排与流程')
  assert.equal(countsNoScreens.system, 0, '无其他 builtin 系统插件')
})
