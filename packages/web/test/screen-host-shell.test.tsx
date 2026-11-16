import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary } from '@helm/protocol'
import { readHostStyles } from './helpers/host-styles.js'
import { makeTestStore } from './helpers/store.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { Screen } = await import('@helm/plugin-client')
const { resetPluginClientCache, seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { mountSharedPluginNamespaces } = await import('./helpers/workflow-client.js')
mountSharedPluginNamespaces({ realHooks: true })

const { createRoot } = await import('react-dom/client')
const { ScreenHost } = await import('../src/screens/ScreenHost.js')
const { CommandPaletteModal } = await import('../src/modals/CommandPaletteModal.js')
const { AuthGate } = await import('../src/shell/AuthGate.js')
const { ToastOverlay } = await import('../src/shell/ToastOverlay.js')
const { Sidebar } = await import('../src/shell/Sidebar.js')

const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u
const originalFetch = globalThis.fetch

let root: Root | undefined
let host: HTMLElement | undefined

function mount(element: React.ReactElement): void {
  if (root !== undefined) {
    act(() => root?.unmount())
  }
  host?.remove()
  host = document.createElement('div')
  document.body.appendChild(host)
  act(() => {
    root = createRoot(host!)
    root.render(element)
  })
}

async function settle(ms = 25): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

function makeConversation(
  id: number,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    title: `会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: id * 1000,
    updatedAt: id * 1000,
    ...overrides,
  }
}

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount())
  }
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  resetPluginClientCache()
})

test('ScreenHost 双重头部去重容器与缺失视图 warn 原语', { timeout: 60_000 }, async () => {
  const screenSource = readFileSync(new URL('../src/screens/ScreenHost.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(screenSource, /builtin:[a-z-]+/, 'ScreenHost 绝不能硬编码特定插件 ID')

  // 1) 未注册视图渲染统一 .callout.callout-warn
  const emptyStore = makeTestStore({
    primaryTarget: { kind: 'screen', pluginId: 'ext:missing', screenId: 'overview' },
  })
  mount(
    <HostStoreProviders value={emptyStore}>
      <ScreenHost pluginId="ext:missing" screenId="overview" />
    </HostStoreProviders>,
  )
  const warnBox = host?.querySelector('.callout.callout-warn')
  assert.ok(warnBox, '缺失插件视图时应渲染 .callout.callout-warn')

  // 2) 已注册 client screen 渲染时，内层 Screen 包裹于 .screen-host-stage[data-screen-host="true"]
  seedPluginClientModule(
    'ext-demo',
    'index.tsx',
    {
      Board: () => (
        <Screen title="插件看板" subtitle="副标题说明" actions={<button type="button">刷新</button>}>
          <div>正文内容</div>
        </Screen>
      ),
    },
    'demo-hash-1',
  )
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/plugins/ext-demo/client.mjs')) {
      return new Response('', { status: 200, headers: { 'x-helm-client-hash': 'demo-hash-1' } })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  const baseStore = makeTestStore({
    primaryTarget: { kind: 'screen', pluginId: 'ext-demo', screenId: 'board' },
  })
  const activeStore = makeTestStore({
    primaryTarget: { kind: 'screen', pluginId: 'ext-demo', screenId: 'board' },
    groupedUi: {
      ...baseStore.groupedUi,
      screens: [
        {
          pluginId: 'ext-demo',
          spec: { id: 'board', label: '插件看板', client: { module: 'index.tsx', export: 'Board' } },
        },
      ],
    },
  })

  mount(
    <HostStoreProviders value={activeStore}>
      <ScreenHost pluginId="ext-demo" screenId="board" />
    </HostStoreProviders>,
  )
  await settle()

  const topbar = host?.querySelector('.pane-topbar')
  const stage = host?.querySelector<HTMLElement>('.screen-host-stage[data-screen-host="true"]')
  assert.ok(topbar, 'ScreenHost 应保留唯一宿主顶栏 .pane-topbar')
  assert.ok(stage, 'ScreenHost 应标注 .screen-host-stage[data-screen-host="true"]')
  assert.ok(stage.querySelector('.screen-header .screen-heading .screen-title'), '内层 Screen 存在标准 .screen-header > .screen-heading > .screen-title 供 CSS 去重')
  assert.ok(stage.querySelector('.screen-subtitle'), '副标题应保留')
  assert.ok(stage.querySelector('button'), '右侧动作按钮应保留')
})

test('CommandPaletteModal 单键快捷键徽章、聚焦分屏上下文与空查询排序', { timeout: 60_000 }, async () => {
  const dispatched: Array<CustomEvent> = []
  const onShortcut = (ev: Event) => {
    dispatched.push(ev as CustomEvent)
  }
  window.addEventListener('helm:shortcut', onShortcut)

  try {
    const conversations = [1, 2, 3, 4, 5, 6, 7].map((id) =>
      makeConversation(id, { title: `最近话题 ${id}`, updatedAt: id * 100 }),
    )
    const store = makeTestStore({
      activeModal: { kind: 'command-palette' },
      conversations,
      primaryTarget: { kind: 'conversation', conversationId: 1 },
      splitTarget: { kind: 'conversation', conversationId: 6 },
      focusedPanel: 'split',
    })

    let closed = false
    mount(
      <HostStoreProviders value={store}>
        <CommandPaletteModal onClose={() => { closed = true }} />
      </HostStoreProviders>,
    )
    await settle(20)

    const modal = document.querySelector<HTMLElement>('.modal[aria-label="命令面板与全局搜索"]')
    assert.ok(modal, '应渲染命令面板对话框')

    // 所有快捷键提示均带 .kbd-hint 且绝不含双键别名分隔符 "/"
    const hints = [...modal.querySelectorAll<HTMLElement>('.kbd-hint')]
    assert.ok(hints.length >= 4, '应显示单键快捷键 .kbd-hint 徽章')
    for (const hint of hints) {
      const label = hint.textContent?.trim() ?? ''
      assert.ok(label.length > 0)
      assert.equal(label.includes('/'), false, `快捷键徽章 "${label}" 不应包含多键别名 "/"`)
    }

    // 最近会话在空查询下最多展示 5 条，且排在上下文动作之后、全局导航之前
    const allRows = [...modal.querySelectorAll<HTMLElement>('[data-idx].nav-item')]
    const recentItems = allRows.filter((el) => (el.textContent ?? '').includes('最近话题'))
    assert.equal(recentItems.length, 5, '有足够非当前焦点会话时应展示 5 条最近会话')
    assert.equal(
      recentItems.some((el) => (el.textContent ?? '').includes('最近话题 6')),
      false,
      '当前聚焦分屏会话 #6 不应重复出现在最近会话列表',
    )

    // 点击「切换当前模型」应派发指向 focusedPanel ('split') 的 helm:shortcut 并关闭面板
    const modelIdx = allRows.findIndex((el) => (el.textContent ?? '').includes('切换当前模型'))
    const firstRecentIdx = allRows.findIndex((el) => (el.textContent ?? '').includes('最近话题'))
    const navIdx = allRows.findIndex((el) => (el.textContent ?? '').includes('打开智能体角色中心'))
    assert.ok(modelIdx >= 0 && firstRecentIdx > modelIdx && navIdx > firstRecentIdx, '空查询排序应为：上下文动作 -> 最近会话 -> 全局导航')

    await act(async () => {
      allRows[modelIdx]!.click()
    })
    assert.equal(closed, true)
    assert.equal(dispatched.length, 1)
    assert.deepEqual(dispatched[0]?.detail, { action: 'toggle-model-picker', panel: 'split' })
  } finally {
    window.removeEventListener('helm:shortcut', onShortcut)
  }
})

test('AuthGate / ToastOverlay / Sidebar 原语与折叠按钮及零 Emoji / 零原生 select', { timeout: 60_000 }, async () => {
  // 1) AuthGate 表单短密码触发 .callout.callout-error
  const authStore = makeTestStore({ authConfigured: false, authenticated: false })
  mount(
    <HostStoreProviders value={authStore}>
      <AuthGate />
    </HostStoreProviders>,
  )
  const form = host?.querySelector('form')
  assert.ok(form)
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  const authErr = host?.querySelector('.callout.callout-error')
  assert.ok(authErr, 'AuthGate 错误提示应使用 .callout.callout-error')
  assert.equal(document.querySelectorAll('select').length, 0)

  // 2) ToastOverlay 区分 error/warning 统一原语类
  const toastStore = makeTestStore({
    notices: [
      { id: 'n-err', type: 'notification', level: 'error', title: '连接失败', createdAt: 1000 },
      { id: 'n-warn', type: 'notification', level: 'warning', title: '操作提示', createdAt: 2000 },
    ],
  })
  mount(
    <HostStoreProviders value={toastStore}>
      <ToastOverlay />
    </HostStoreProviders>,
  )
  assert.ok(host?.querySelector('[data-notice-id="n-err"].callout-error[role="alert"]'))
  assert.ok(host?.querySelector('[data-notice-id="n-warn"].callout-warn[role="status"]'))

  // 3) Sidebar 折叠 / 展开按钮联动 toggleSidebarCollapsed
  let toggleCount = 0
  const expandedStore = makeTestStore({
    sidebarCollapsed: false,
    toggleSidebarCollapsed: () => {
      toggleCount += 1
    },
  })
  mount(
    <HostStoreProviders value={expandedStore}>
      <Sidebar />
    </HostStoreProviders>,
  )
  const collapseBtn = host?.querySelector<HTMLButtonElement>('.desktop-sidebar-collapse-btn')
  assert.ok(collapseBtn, '侧栏展开态应存在桌面折叠按钮')
  await act(async () => {
    collapseBtn.click()
  })
  assert.equal(toggleCount, 1)

  const collapsedStore = makeTestStore({
    sidebarCollapsed: true,
    toggleSidebarCollapsed: () => {
      toggleCount += 1
    },
  })
  mount(
    <HostStoreProviders value={collapsedStore}>
      <Sidebar />
    </HostStoreProviders>,
  )
  const expandBtn = host?.querySelector<HTMLButtonElement>('.desktop-sidebar-expand-btn')
  assert.ok(expandBtn, '侧栏折叠态在 Rail 顶部应存在桌面展开按钮')
  await act(async () => {
    expandBtn.click()
  })
  assert.equal(toggleCount, 2)

  // 4) 所有本任务修改的源码不含 Emoji、不含原生 <select>
  for (const rel of [
    '../src/App.tsx',
    '../src/modals/CommandPaletteModal.tsx',
    '../src/screens/ScreenHost.tsx',
    '../src/shell/AuthGate.tsx',
    '../src/shell/ToastOverlay.tsx',
    '../src/shell/Sidebar.tsx',
    '../src/shell/shortcuts-model.ts',
  ]) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    assert.equal(EMOJI_RE.test(src), false, `${rel} 不得包含 Emoji`)
    assert.equal(/<select[\s>]/i.test(src), false, `${rel} 不得包含原生 <select>`)
  }
})

test('CSS 契约：Primitives (.screen-heading/.callout-*/.kbd-hint)、双重头部隐藏、抽屉关闭靠右与双端响应式', { timeout: 60_000 }, () => {
  const css = readHostStyles()
  const responsiveCss = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')

  // 1) Primitives CSS
  assert.match(css, /\.screen-heading\s*\{/, '应定义 .screen-heading 统一样式')
  assert.match(css, /\.screen-host-stage\s+\.screen-header\s+\.screen-title[\s\S]*?display:\s*none/, 'ScreenHost 内层应隐藏重复标题 .screen-title')
  assert.match(css, /\.screen-host-stage\s+\.screen-header:not\(:has\([^)]+\)\)[\s\S]*?display:\s*none/, '仅有重复标题且无副标题/操作时隐藏整行内层 .screen-header')
  assert.match(css, /\.screen-host-stage\s+\.apps-center-topbar\s+\.apps-center-title[\s\S]*?display:\s*none/, 'ScreenHost 内层应去重 .apps-center-title')

  assert.match(css, /\.callout-error\s*\{/, '应统一定义 .callout-error 原语样式')
  assert.match(css, /\.callout-warn\s*\{/, '应统一定义 .callout-warn 原语样式')
  assert.match(css, /\.callout-ok\s*\{/, '应统一定义 .callout-ok 原语样式')
  assert.match(css, /\.kbd-hint\s*\{/, '应定义 .kbd-hint 单键快捷键样式')

  // 2) 抽屉 [x] 靠右与桌面折叠 Rail
  assert.match(css, /\.drawer-header,\s*\n?\.primary-drawer-header\s*\{[\s\S]*?justify-content:\s*space-between/, 'drawer-header 保持两端对齐')
  assert.match(css, /\.workbench-close-btn\s*\{[\s\S]*?margin-left:\s*auto/, 'workbench 关闭按钮始终靠最右')
  assert.match(css, /\.helm-shell\.sidebar-collapsed\s+\.helm-sidebar[\s\S]*?width:\s*48px/, '桌面端折叠态将侧栏收窄至 48px Rail 宽度')

  // 3) 860px 响应式：隐藏分屏与桌面侧栏折叠按钮
  const tabletBlock = /@media\s*\(max-width:\s*860px\)\s*\{([\s\S]*?)@media\s*\(max-width:\s*680px\)/.exec(responsiveCss)
  const tabletCss = tabletBlock?.[1]
  assert.ok(tabletCss !== undefined, '应存在 @media (max-width: 860px) 规则块')
  assert.match(tabletCss, /\.pane-split-btn/, '<=860px 应隐藏 .pane-split-btn')
  assert.match(tabletCss, /\.desktop-sidebar-collapse-btn/, '<=860px 应隐藏桌面折叠按钮')

  // 4) 680px 响应式：隐藏标题按钮文字、快捷键徽章、全宽抽屉且 [x] 靠右
  const mobileBlock = /@media\s*\(max-width:\s*680px\)\s*\{([\s\S]*)$/.exec(responsiveCss)
  const mobileCss = mobileBlock?.[1]
  assert.ok(mobileCss !== undefined, '应存在 @media (max-width: 680px) 规则块')
  assert.match(mobileCss, /\.pane-action-label[\s\S]*?display:\s*none/, '<=680px 应隐藏 .pane-action-label')
  assert.match(mobileCss, /\.kbd-hint[\s\S]*?display:\s*none/, '<=680px 应隐藏 .kbd-hint')
  assert.match(mobileCss, /\.helm-workbench[\s\S]*?width:\s*100vw/, '<=680px 工作台抽屉全宽')
  assert.match(mobileCss, /\.drawer-header[\s\S]*?justify-content:\s*space-between/, '<=680px drawer-header 保证 [x] 固定最右')

  // 5) 粗指针触屏设备隐藏 .kbd-hint
  assert.match(responsiveCss, /@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.kbd-hint[\s\S]*?display:\s*none/, '触屏粗指针环境应隐藏 .kbd-hint')
})
