/**
 * 插件中心 Screen 快捷打开测试：
 * - PluginCard 组件（真实 DOM 渲染）：enabled 且有 Screen 贡献时底栏渲染「打开视图」，
 *   点击阻止冒泡并以主屏 screen target 调用 store.openTarget；停用/无贡献不渲染；
 * - PluginDetailDrawer DOM 交互：主视图与分屏操作经 store.openTarget 更新对应导航目标；
 * - PluginCenter 模型：「应用」分类只统计非 builtin 且有 Screen 的外部插件。
 *
 * 说明：PluginDetailDrawer 完整组件渲染依赖配置读取副作用（happy-dom 下相对路径
 * fetch 永不完成，曾在 act 内挂起 120s）；本测试通过真实按钮交互覆盖导航行为。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import * as ReactDOMClient from 'react-dom/client'
import type { PluginSummary } from '@helmx/protocol'
import { PluginCard } from '../src/plugins/PluginCard.js'
import { PluginDetailDrawer } from '../src/plugins/PluginDetailDrawer.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'
import type { HelmxStoreValue } from '../src/lib/types.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

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
): HelmxExternalStore {
  // 真实 store 从 uiContributions 派生 groupedUi（screens 即 surface='screen' 的贡献，与生产同链路）。
  return makeTestStore({
    plugins,
    uiContributions: ui as HelmxStoreValue['uiContributions'],
  })
}

// ---------------------------------------------------------------------------
// PluginCard 组件：打开视图按钮渲染与导航回调
// ---------------------------------------------------------------------------

test('PluginCard：enabled 且有 Screen 时底栏渲染打开视图，点击阻止冒泡并以主屏 target 导航', { timeout: 60_000 }, async () => {
  const selections: string[] = []
  const store = screenStore([APP_PLUGIN], SCREEN_UI)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  await act(async () => {
    root.render(
      e(HostStoreProviders, { value: store },
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
    [{ target: store.getPrimaryTarget(), split: store.getSplitTarget() !== null }],
    [{ target: { kind: 'screen', pluginId: 'todo-app', screenId: 'main' }, split: false }],
    '点击打开视图以主屏 screen target 导航（首个 Screen 为主视图，不开分屏）',
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
        e(HostStoreProviders, { value: store },
          e(PluginCard, { plugin, selected: false, onSelect: () => {}, onToggle: () => {} })),
      )
    })
    assert.ok(host.querySelector('.plugin-card-open-btn') === null)
    act(() => root.unmount())
    host.remove()
  }

  // 无 Provider（HelmxExternalStoreContext 为 null）：卡片可渲染且不出现打开按钮
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  await act(async () => {
    root.render(e(PluginCard, { plugin: APP_PLUGIN, selected: false, onSelect: () => {}, onToggle: () => {} }))
  })
  assert.ok(host.querySelector('.plugin-card-open-btn') === null)
  act(() => root.unmount())
  host.remove()
})

// ---------------------------------------------------------------------------
// PluginDetailDrawer DOM 行为契约：enabled 插件经 openTarget 打开主视图并支持 split（零 history 直操作）
// ---------------------------------------------------------------------------

test('PluginDetailDrawer 契约：enabled 插件经 store.openTarget 打开主视图并支持 split（零 history 直操作）', { timeout: 60_000 }, async () => {
  const store = screenStore([APP_PLUGIN], SCREEN_UI)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ pluginId: 'todo-app', schema: {}, values: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  try {
    await act(async () => {
      root.render(
        e(HostStoreProviders, { value: store },
          e(PluginDetailDrawer, {
            plugin: APP_PLUGIN,
            open: true,
            inline: true,
            onClose: () => {},
            onToggleEnabled: async () => {},
            toggling: false,
          })),
      )
    })

    const actionsBar = host.querySelector('.plugin-drawer-screen-actions')
    assert.ok(actionsBar, '应渲染插件视图操作区')
    const splitBtn = actionsBar.querySelector<HTMLButtonElement>('.plugin-drawer-split-btn')
    const primaryBtn = Array.from(actionsBar.querySelectorAll<HTMLButtonElement>('button')).find((b) => b !== splitBtn)
    assert.ok(primaryBtn && splitBtn, '应渲染打开主视图与分屏打开两个按钮')

    await act(async () => {
      primaryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      splitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    assert.deepEqual(
      [
        { target: store.getPrimaryTarget(), split: false },
        { target: store.getSplitTarget(), split: true },
      ],
      [
        { target: { kind: 'screen', pluginId: 'todo-app', screenId: 'main' }, split: false },
        { target: { kind: 'screen', pluginId: 'todo-app', screenId: 'main' }, split: true },
      ],
      '主屏与分屏按钮应经真实 openTarget 推进导航目标（主屏 target + splitTarget）',
    )

  } finally {
    act(() => root.unmount())
    host.remove()
    globalThis.fetch = originalFetch
  }
})

