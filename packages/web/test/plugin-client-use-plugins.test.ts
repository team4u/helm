/**
 * usePlugins 共享 Hook 测试（真实 React 渲染路径 + HelmStoreContext）：
 * - plugins 返回 store.plugins 同一引用（SSE 实时数据源，非拷贝非轮询）；
 * - screens 返回 store.groupedUi.screens 同一引用（已启用插件贡献，停用即时移除）；
 * - 无 PluginClientContext 时可用（应用中心类全屏视图无会话上下文）；
 * - store 更新（新 store 对象）后重渲染返回新快照（响应式语义）；
 * - 符号进入 @helm/plugin-client 共享 SDK 导出与 protocol PLUGIN_CLIENT_SHARED_EXPORTS 锁定清单。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { PLUGIN_CLIENT_SHARED_EXPORTS } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { usePlugins } from '../src/lib/plugin-client-context.js'
import * as HelmPluginClient from '../src/lib/plugin-client-sdk.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { makeTestStore } from './helpers/store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

interface UiContributionLike {
  pluginId: string
  surface: string
  spec: Record<string, unknown>
}

function storeWithScreens(plugins: HelmStoreValue['plugins'], ui: UiContributionLike[]): HelmStoreValue {
  return makeTestStore({
    plugins,
    uiContributions: ui as HelmStoreValue['uiContributions'],
    groupedUi: groupUiContributions(ui as HelmStoreValue['uiContributions']),
  })
}

test('usePlugins：plugins 返回 store.plugins 同一引用（实时数据源非拷贝）', { timeout: 60_000 }, () => {
  const plugins = [{ id: 'todo-app', name: '待办应用', locked: false, enabled: true, hooks: [], actions: [], tools: [] }]
  const store = storeWithScreens(plugins, [])
  let captured: ReturnType<typeof usePlugins> | undefined
  function Probe(): React.ReactNode {
    captured = usePlugins()
    return null
  }
  renderToString(e(HelmStoreContext.Provider, { value: store }, e(Probe)))
  assert.equal(captured!.plugins, plugins, '必须返回 store.plugins 的同一引用')
})

test('usePlugins：screens 返回 groupedUi.screens 同一引用（含 pluginId 限定）', { timeout: 60_000 }, () => {
  const ui: UiContributionLike[] = [
    {
      pluginId: 'todo-app',
      surface: 'screen',
      spec: { id: 'main', label: '待办台', client: { module: 'index.tsx', export: 'Main' } },
    },
    {
      pluginId: 'builtin:superagent',
      surface: 'screen',
      spec: { id: 'recall-graph', label: '图谱', client: { module: 'index.tsx', export: 'G' } },
    },
    {
      pluginId: 'todo-app',
      surface: 'settings.panel',
      spec: { id: 'cfg', label: '配置' },
    },
  ]
  const store = storeWithScreens([], ui)
  let captured: ReturnType<typeof usePlugins> | undefined
  function Probe(): React.ReactNode {
    captured = usePlugins()
    return null
  }
  renderToString(e(HelmStoreContext.Provider, { value: store }, e(Probe)))
  assert.equal(captured!.screens, store.groupedUi.screens, '必须返回 groupedUi.screens 的同一引用')
  assert.equal(captured!.screens.length, 2, '仅 screen surface 计入')
  assert.deepEqual(
    captured!.screens.map((s) => `${s.pluginId}/${s.spec.id}`),
    ['todo-app/main', 'builtin:superagent/recall-graph'],
  )
})

test('usePlugins：无 PluginClientContext（全屏视图无会话槽位）时同样可用', { timeout: 60_000 }, () => {
  const store = storeWithScreens(
    [{ id: 'a', name: 'A', locked: false, enabled: true, hooks: [], actions: [], tools: [] }],
    [],
  )
  let captured: ReturnType<typeof usePlugins> | undefined
  function Probe(): React.ReactNode {
    captured = usePlugins()
    return e('div', null, String(captured!.plugins.length))
  }
  const html = renderToString(e(HelmStoreContext.Provider, { value: store }, e(Probe)))
  assert.equal(captured!.plugins.length, 1)
  assert.match(html, /1/)
})

test('usePlugins：store 快照更新后响应式返回新值（无缓存旧引用）', { timeout: 60_000 }, () => {
  const firstPlugins = [{ id: 'a', name: 'A', locked: false, enabled: true, hooks: [], actions: [], tools: [] }]
  const secondPlugins = [...firstPlugins, { id: 'b', name: 'B', locked: false, enabled: true, hooks: [], actions: [], tools: [] }]
  let store = storeWithScreens(firstPlugins, [])
  const captured: Array<ReturnType<typeof usePlugins>> = []
  function Probe(): React.ReactNode {
    captured.push(usePlugins())
    return null
  }
  const host = document.createElement('div')
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(HelmStoreContext.Provider, { value: store }, e(Probe)))
  })
  assert.equal(captured[0]!.plugins.length, 1)

  store = storeWithScreens(secondPlugins, [])
  act(() => {
    root!.render(e(HelmStoreContext.Provider, { value: store }, e(Probe)))
  })
  assert.equal(captured[captured.length - 1]!.plugins.length, 2, 'store 更新后必须返回新快照')
  act(() => root?.unmount())
})

test('usePlugins 已加入 @helm/plugin-client 共享 SDK 与 protocol 导出锁定清单', { timeout: 60_000 }, async () => {
  assert.ok(
    (PLUGIN_CLIENT_SHARED_EXPORTS as readonly string[]).includes('usePlugins'),
    'PLUGIN_CLIENT_SHARED_EXPORTS 必须包含 usePlugins',
  )
  assert.equal(typeof HelmPluginClient.usePlugins, 'function', '共享 SDK 必须真实导出 usePlugins 函数')
})
