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
import { PluginDetailDrawer } from '../src/plugins/PluginDetailDrawer.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'
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
        e(HostStoreProviders, { value: store },
          e(PluginCard, { plugin, selected: false, onSelect: () => {}, onToggle: () => {} })),
      )
    })
    assert.ok(host.querySelector('.plugin-card-open-btn') === null)
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
  assert.ok(host.querySelector('.plugin-card-open-btn') === null)
  act(() => root.unmount())
  host.remove()
})

// ---------------------------------------------------------------------------
// PluginDetailDrawer DOM 行为契约：enabled 插件经 openTarget 打开主视图并支持 split（零 history 直操作）
// ---------------------------------------------------------------------------

test('PluginDetailDrawer 契约：enabled 插件经 store.openTarget 打开主视图并支持 split（零 history 直操作）', { timeout: 60_000 }, async () => {
  const calls: OpenCall[] = []
  const store = screenStore([APP_PLUGIN], SCREEN_UI, (target, opts) => {
    calls.push({ target: target as ResolvedTarget, split: opts?.split === true })
  })
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
      calls,
      [
        { target: { kind: 'screen', pluginId: 'todo-app', screenId: 'main' }, split: false },
        { target: { kind: 'screen', pluginId: 'todo-app', screenId: 'main' }, split: true },
      ],
      '主屏与分屏按钮应通过 store.openTarget 触发导航',
    )

    const src = readFileSync(new URL('src/plugins/PluginDetailDrawer.tsx', PKG_ROOT), 'utf-8')
    assert.doesNotMatch(src, /history\.(push|replace)State/, '不得直接操作浏览器历史')
  } finally {
    act(() => root.unmount())
    host.remove()
    globalThis.fetch = originalFetch
  }
})

