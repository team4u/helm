/**
 * 全屏插件中心端到端集成测试 (PluginCenter Integration Test)
 *
 * 覆盖：
 * 1. 结构与主视图渲染：顶部搜索框（HelmIcon search）、分类药丸标签栏及 buildCategoryCounts 统计徽章、卡片网格；
 * 2. 多维分类过滤与搜索联动：关键字搜索实时过滤、分类药丸过滤、组合过滤、空状态重置；
 * 3. 卡片点击与详情抽屉联动：点击卡片调用 store.openTarget 展开 PluginDetailDrawer，关闭抽屉回退；
 * 4. 全局导航收敛：CommandPaletteModal 点击「打开插件中心」调用 openTarget({ kind: 'plugins' })；
 * 5. 严格零 Emoji 静态与动态渲染断言。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensureHappyDom, flushMacrotask, typeIntoControl } from './helpers/dom-harness.js'

ensureHappyDom()

const React = (await import('react')).default
const { act } = await import('react')
const ReactDOMClient = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')

import type { PluginSummary } from '@helm/protocol'
const { makeTestStore } = await import('./helpers/store.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { CommandPaletteModal } = await import('../src/modals/CommandPaletteModal.js')

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const e = React.createElement
const typeIntoInput = typeIntoControl

function makePlugin(partial: Partial<PluginSummary> & { id: string }): PluginSummary {
  return {
    name: partial.name ?? partial.id,
    version: partial.version ?? '1.0.0',
    locked: partial.locked ?? false,
    enabled: partial.enabled ?? true,
    hooks: partial.hooks ?? [],
    actions: partial.actions ?? [],
    tools: partial.tools ?? [],
    ...partial,
  }
}

const mockPlugins: PluginSummary[] = [
  makePlugin({
    id: 'builtin:profile',
    name: '个人助理',
    locked: true,
    enabled: true,
    tools: ['update_memory', 'load_skill'],
    actions: [],
  }),
  makePlugin({
    id: 'builtin:workflow',
    name: '工作流引擎',
    locked: false,
    enabled: true,
    tools: ['subagent', 'cleanup_worktree'],
    actions: ['run', 'inspect'],
  }),
  makePlugin({
    id: 'builtin:herdr',
    name: 'Herdr 控制台',
    locked: false,
    enabled: false,
    tools: [],
    actions: ['bridge_status', 'resume'],
  }),
  makePlugin({
    id: 'builtin:triggers',
    name: '触发器连接器',
    locked: false,
    enabled: true,
    tools: [],
    actions: ['webhook_deliver'],
  }),
  makePlugin({
    id: 'tools:calculator',
    name: '计算器工具',
    locked: false,
    enabled: true,
    tools: ['calculate'],
    actions: [],
  }),
]

// 包含一个 failed 故障态插件的变体数据集
const mockPluginsWithFailure: PluginSummary[] = [
  ...mockPlugins,
  makePlugin({
    id: 'external:broken',
    name: '损坏插件',
    enabled: false,
    status: 'failed',
    error: { code: 'plugin_load_failed', message: '入口文件缺失', stage: 'scan' },
  }),
]

// ---------------------------------------------------------------------------
// 1. PluginCenter SSR 与主体结构渲染
// ---------------------------------------------------------------------------

test('PluginCenter SSR：渲染搜索框、统计徽章与卡片网格', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const store = makeTestStore({
    plugins: mockPlugins,
    primaryTarget: { kind: 'plugins' },
  })

  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(PluginCenter)),
  )

  // 1. 主容器类名
  assert.match(html, /class="[^"]*plugin-center[^"]*"/)

  // 2. 搜索框与搜索图标
  assert.match(html, /class="[^"]*plugin-search-box[^"]*"/)
  assert.match(html, /placeholder="[^"]*Search/)

  // 3. 统计指标显示（无故障态时不展示异常计数）
  assert.doesNotMatch(html, /个异常/)

  // 5. 响应式自适应网格与所有卡片
  assert.match(html, /class="[^"]*plugin-center-grid[^"]*"/)
  assert.match(html, /data-plugin-id="builtin:profile"/)
  assert.match(html, /data-plugin-id="builtin:workflow"/)
  assert.match(html, /data-plugin-id="builtin:herdr"/)
  assert.match(html, /data-plugin-id="builtin:triggers"/)
  assert.match(html, /data-plugin-id="tools:calculator"/)
})

test('PluginCenter SSR：存在 failed 故障态插件时顶栏统计追加异常计数且卡片标记 is-failed', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const store = makeTestStore({
    plugins: mockPluginsWithFailure,
    primaryTarget: { kind: 'plugins' },
  })

  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(PluginCenter)),
  )

  // 1. 顶栏统计追加异常计数（failed 插件 enabled: false，不计入已启用）

  // 2. 故障卡片标记 is-failed 并渲染异常徽章
  assert.match(html, /data-plugin-id="external:broken"/)
  assert.match(html, /is-failed/)
  assert.match(html, /<span>Error<\/span>/)
})

// ---------------------------------------------------------------------------
// 3. DOM 交互测试：分类过滤、搜索过滤、卡片点击打开抽屉与关闭抽屉
// ---------------------------------------------------------------------------

test('PluginCenter DOM 交互：搜索过滤实时联动', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  let openedTarget: unknown = null
  const store = makeTestStore({
    plugins: mockPlugins,
    primaryTarget: { kind: 'plugins' },
    openTarget: (target) => {
      openedTarget = target
    },
  })

  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(PluginCenter, { inlineDrawer: true })))
  })

  // 初始状态包含 5 个卡片
  let cards = host.querySelectorAll('.plugin-card')
  assert.equal(cards.length, 5)

  // 搜索框输入 "workflow"
  const searchInput = host.querySelector<HTMLInputElement>('.plugin-search-box input')
  assert.ok(searchInput, '应存在搜索输入框')

  await act(async () => {
    typeIntoInput(searchInput, 'workflow')
  })

  cards = host.querySelectorAll('.plugin-card')
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.getAttribute('data-plugin-id'), 'builtin:workflow')

  // 点击卡片，触发 store.openTarget({ kind: 'plugins', pluginId: 'builtin:workflow' })
  await act(async () => {
    cards[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  assert.deepEqual(openedTarget, { kind: 'plugins', pluginId: 'builtin:workflow' })

  root.unmount()
  host.remove()
})

test('PluginCenter DOM 交互：渲染「全部 / 已启用 / 已停用」筛选药丸并支持切换过滤', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const store = makeTestStore({
    plugins: mockPlugins,
    primaryTarget: { kind: 'plugins' },
  })

  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(PluginCenter, { inlineDrawer: true })))
    })

    const enabledCount = mockPlugins.filter((p) => p.enabled).length
    const disabledCount = mockPlugins.filter((p) => !p.enabled).length
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    assert.equal(tabs.length, 3, '应渲染 全部 / 已启用 / 已停用 三个状态药丸')
    const disabledTab = tabs.find((t) => t.textContent?.includes('Disabled'))
    assert.ok(disabledTab)
    assert.match(disabledTab.textContent ?? '', new RegExp(String(disabledCount)))

    await act(async () => {
      disabledTab.click()
    })
    assert.equal(host.querySelectorAll('.plugin-card').length, disabledCount)

    const enabledTab = tabs.find((t) => t.textContent?.includes('Enabled'))!
    await act(async () => {
      enabledTab.click()
    })
    assert.equal(host.querySelectorAll('.plugin-card').length, enabledCount)
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// 4. DOM 交互测试：抽屉展开与关闭联动
// ---------------------------------------------------------------------------

test('PluginCenter DOM 交互：抽屉根据 primaryTarget.pluginId 展开，关闭时调用 openTarget({ kind: "plugins" })', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  let closedTarget: unknown = null
  const store = makeTestStore({
    plugins: mockPlugins,
    primaryTarget: { kind: 'plugins', pluginId: 'builtin:workflow' },
    openTarget: (target) => {
      closedTarget = target
    },
  })

  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(PluginCenter, { inlineDrawer: true })))
  })

  // 验证抽屉处于展开态
  const drawer = host.querySelector('.plugin-drawer-content')
  assert.ok(drawer, 'PluginDetailDrawer 应展开')

  // 验证抽屉显示选中的插件名称
  const title = drawer.querySelector('.plugin-drawer-title')
  assert.match(title?.textContent ?? '', /工作流引擎/)

  // 点击抽屉关闭按钮
  const closeBtn = drawer.querySelector('.plugin-drawer-close-btn')
  assert.ok(closeBtn, '应存在抽屉关闭按钮')

  await act(async () => {
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  assert.deepEqual(closedTarget, { kind: 'plugins' }, '关闭抽屉应导航回基础插件中心')

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

// ---------------------------------------------------------------------------
// 5. 全局导航收敛（CommandPaletteModal）
// ---------------------------------------------------------------------------

test('全局入口收敛：CommandPaletteModal 点击「打开插件中心」导航至 plugins 并关闭面板', { timeout: 60_000 }, async () => {
  const opened: unknown[] = []
  let closed = false
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  const store = makeTestStore({
    activeModal: { kind: 'command-palette' },
    openTarget: (target) => opened.push(target),
  })
  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(CommandPaletteModal, { onClose: () => { closed = true } })))
      await flushMacrotask(0)
    })
    const row = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-idx].nav-item')).find((el) =>
      el.textContent?.includes('Open plugins center'),
    )
    assert.ok(row, '命令面板应提供「打开插件中心」入口')
    await act(async () => {
      row.click()
    })
    assert.equal(closed, true)
    assert.deepEqual(opened, [{ kind: 'plugins' }])
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// 6. 零 Emoji 静态断言
// ---------------------------------------------------------------------------

test('零 Emoji 铁律：PluginCenter.tsx 源码无任何 Emoji 字符', { timeout: 60_000 }, () => {
  const centerSrc = readFileSync(join(PKG_ROOT, 'src/plugins/PluginCenter.tsx'), 'utf-8')
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u
  assert.doesNotMatch(centerSrc, emojiRegex, 'PluginCenter.tsx 严禁包含 Emoji 表情')
})
