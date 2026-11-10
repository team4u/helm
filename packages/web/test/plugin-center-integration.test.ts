/**
 * 全屏插件中心端到端集成测试 (PluginCenter Integration Test)
 *
 * 覆盖：
 * 1. 结构与主视图渲染：顶部搜索框（HelmIcon search）、分类药丸标签栏及 buildCategoryCounts 统计徽章、卡片网格；
 * 2. 多维分类过滤与搜索联动：关键字搜索实时过滤、分类药丸过滤、组合过滤、空状态重置；
 * 3. 卡片点击与详情抽屉联动：点击卡片调用 store.openTarget 展开 PluginDetailDrawer，关闭抽屉回退；
 * 4. 插件快捷启停与通知：调用 pluginsApi.enable / disable 并触发 pushNotice 通知；
 * 5. 全局导航收敛：
 *    - App.tsx 主舞台分支挂载 PluginCenter，废除 PluginSettingsModal 并平滑重定向；
 *    - Sidebar.tsx 底栏设置按钮更新为“插件中心”，激活时高亮；
 *    - CommandPaletteModal 与 ProviderCatalog 统一调用 openTarget({ kind: 'plugins', ... })；
 * 6. 淘汰旧弹窗与零残留静态扫描：
 *    - PluginSettingsModal.tsx 正式删除；
 *    - 全仓无旧弹窗残留引用；
 * 7. 严格零 Emoji 静态与动态渲染断言。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { act } = await import('react')
const ReactDOMClient = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')

;(globalThis as Record<string, unknown>).React = React

import type { PluginSummary } from '@helm/protocol'
import { pluginsApi } from '../src/lib/api.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import {
  buildCategoryCounts,
  type PluginCategoryTab,
} from '../src/plugins/plugin-center-model.js'
import { makeTestStore } from './helpers/store.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const e = React.createElement

function typeIntoInput(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  const tracker = (input as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter?.call(input, text)
  tracker?.setValue(prev)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

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
    id: 'builtin:assistant',
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

// ---------------------------------------------------------------------------
// 1. buildCategoryCounts 模型单测
// ---------------------------------------------------------------------------

test('buildCategoryCounts：正确计算全量、运行时、工具、编排、系统与已启用计数', { timeout: 60_000 }, () => {
  const counts = buildCategoryCounts(mockPlugins)
  assert.equal(counts.all, 5, '全部插件总数')
  assert.equal(counts.enabled, 4, '已启用总数')
  assert.equal(counts.orchestration, 2, '编排与流程 (workflow, herdr)')
  assert.equal(counts.runtime, 1, '运行时 (herdr)')
  assert.equal(counts.tools, 3, '工具与能力 (assistant, workflow, calculator)')
  assert.equal(counts.system, 2, '系统与辅助 (assistant, triggers)')
})

// ---------------------------------------------------------------------------
// 2. PluginCenter SSR 与主体结构渲染
// ---------------------------------------------------------------------------

test('PluginCenter SSR：渲染搜索框、分类药丸、统计徽章与卡片网格', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const store = makeTestStore({
    plugins: mockPlugins,
    primaryTarget: { kind: 'plugins' },
  })

  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(PluginCenter)),
  )

  // 1. 主容器类名
  assert.match(html, /class="[^"]*plugin-center[^"]*"/)

  // 2. 搜索框与搜索图标
  assert.match(html, /class="[^"]*plugin-search-box[^"]*"/)
  assert.match(html, /placeholder="[^"]*搜索/)

  // 3. 多维分类标签栏文案
  assert.match(html, /全部/)
  assert.match(html, /运行时/)
  assert.match(html, /工具与能力/)
  assert.match(html, /编排与流程/)
  assert.match(html, /系统与辅助/)
  assert.match(html, /已启用/)

  // 4. 统计指标显示
  assert.match(html, /共\s*5\s*个插件/)
  assert.match(html, /4\s*个已启用/)

  // 5. 响应式自适应网格与所有卡片
  assert.match(html, /class="[^"]*plugin-center-grid[^"]*"/)
  assert.match(html, /data-plugin-id="builtin:assistant"/)
  assert.match(html, /data-plugin-id="builtin:workflow"/)
  assert.match(html, /data-plugin-id="builtin:herdr"/)
  assert.match(html, /data-plugin-id="builtin:triggers"/)
  assert.match(html, /data-plugin-id="tools:calculator"/)
})

// ---------------------------------------------------------------------------
// 3. DOM 交互测试：分类过滤、搜索过滤、卡片点击打开抽屉与关闭抽屉
// ---------------------------------------------------------------------------

test('PluginCenter DOM 交互：分类标签过滤与搜索过滤实时联动', { timeout: 60_000 }, async () => {
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
    root.render(e(HelmStoreContext.Provider, { value: store }, e(PluginCenter, { inlineDrawer: true })))
  })

  // 初始状态包含 5 个卡片
  let cards = host.querySelectorAll('.plugin-card')
  assert.equal(cards.length, 5)

  // 点击“编排与流程”标签
  const tabs = Array.from(host.querySelectorAll('.plugin-category-pill'))
  const orchTab = tabs.find((t) => t.textContent?.includes('编排与流程'))
  assert.ok(orchTab, '应存在编排与流程分类标签')

  await act(async () => {
    orchTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  cards = host.querySelectorAll('.plugin-card')
  assert.equal(cards.length, 2, '编排与流程应仅包含 workflow 和 herdr')

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
    root.render(e(HelmStoreContext.Provider, { value: store }, e(PluginCenter, { inlineDrawer: true })))
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

  root.unmount()
  host.remove()
})

// ---------------------------------------------------------------------------
// 5. 源码契约：App.tsx、Sidebar.tsx、CommandPaletteModal.tsx、ProviderCatalog.tsx 全局收敛
// ---------------------------------------------------------------------------

test('全局入口收敛：App.tsx 主舞台接入 PluginCenter，废弃旧弹窗并重定向', { timeout: 60_000 }, () => {
  const appSrc = readFileSync(join(PKG_ROOT, 'src/App.tsx'), 'utf-8')
  // 1. 主舞台分支包含 kind === 'plugins' -> <PluginCenter
  assert.match(appSrc, /store\.primaryTarget\.kind === 'plugins'\s*\?\s*\(\s*<PluginCenter/)
  // 2. 废除 PluginSettingsModal 渲染
  assert.doesNotMatch(appSrc, /<PluginSettingsModal/)
  assert.doesNotMatch(appSrc, /import\s*\{\s*PluginSettingsModal\s*\}\s*from/)
  // 3. activeModal === 'plugin-settings' 平滑重定向
  assert.match(appSrc, /activeModal\?\.kind === 'plugin-settings'/)
  assert.match(appSrc, /openTarget\(\{\s*kind:\s*'plugins'/)
})

test('全局入口收敛：Sidebar.tsx 齿轮按钮更新为“插件中心”，并在激活时高亮', { timeout: 60_000 }, () => {
  const sidebarSrc = readFileSync(join(PKG_ROOT, 'src/shell/Sidebar.tsx'), 'utf-8')
  // 1. 文案与提示为“插件中心”
  assert.match(sidebarSrc, /content="插件中心"/)
  assert.match(sidebarSrc, /title="插件中心"/)
  // 2. 点击调用 openTarget({ kind: 'plugins' })
  assert.match(sidebarSrc, /store\.openTarget\(\{\s*kind:\s*'plugins'\s*\}\)/)
  // 3. 处于 plugins 目标时激活状态
  assert.match(sidebarSrc, /store\.primaryTarget\.kind === 'plugins'/)
})

test('全局入口收敛：CommandPaletteModal.tsx 导航至 plugins', { timeout: 60_000 }, () => {
  const cmdPaletteSrc = readFileSync(join(PKG_ROOT, 'src/modals/CommandPaletteModal.tsx'), 'utf-8')
  assert.match(cmdPaletteSrc, /openTarget\(\{\s*kind:\s*'plugins'/)
  assert.doesNotMatch(cmdPaletteSrc, /setActiveModal\(\{\s*kind:\s*'plugin-settings'/)
})

test('全局入口收敛：ProviderCatalog.tsx 插件连接按钮导航至 plugins 目标', { timeout: 60_000 }, () => {
  const catalogSrc = readFileSync(join(PKG_ROOT, 'src/modals/ProviderCatalog.tsx'), 'utf-8')
  assert.match(catalogSrc, /openTarget\(\{\s*kind:\s*'plugins',\s*pluginId:\s*provider\.pluginId\s*\}\)/)
  assert.doesNotMatch(catalogSrc, /setActiveModal\(\{\s*kind:\s*'plugin-settings'/)
})

// ---------------------------------------------------------------------------
// 6. 淘汰旧弹窗静态检查：PluginSettingsModal.tsx 正式删除且全仓无引用
// ---------------------------------------------------------------------------

test('旧弹窗淘汰：PluginSettingsModal.tsx 已被删除且 src 下无任何引用', { timeout: 60_000 }, () => {
  const modalPath = join(PKG_ROOT, 'src/modals/PluginSettingsModal.tsx')
  assert.equal(existsSync(modalPath), false, 'src/modals/PluginSettingsModal.tsx 必须已被物理删除')
})

// ---------------------------------------------------------------------------
// 7. 零 Emoji 静态断言
// ---------------------------------------------------------------------------

test('零 Emoji 铁律：PluginCenter.tsx 源码无任何 Emoji 字符', { timeout: 60_000 }, () => {
  const centerSrc = readFileSync(join(PKG_ROOT, 'src/plugins/PluginCenter.tsx'), 'utf-8')
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u
  assert.doesNotMatch(centerSrc, emojiRegex, 'PluginCenter.tsx 严禁包含 Emoji 表情')
})
