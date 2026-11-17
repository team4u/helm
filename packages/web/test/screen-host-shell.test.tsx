import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationSummary } from '@helm/protocol'
import { ensureHappyDom, flushMacrotask } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
const { Screen } = await import('@helm/plugin-client')
const { resetPluginClientCache, seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { mountSharedPluginNamespaces } = await import('./helpers/builtin-clients.js')
mountSharedPluginNamespaces({ realHooks: true })

const { createRoot } = await import('react-dom/client')
const { ScreenHost } = await import('../src/screens/ScreenHost.js')
const { CommandPaletteModal } = await import('../src/modals/CommandPaletteModal.js')
const { AuthGate } = await import('../src/shell/AuthGate.js')
const { ToastOverlay } = await import('../src/shell/ToastOverlay.js')
const { Sidebar } = await import('../src/shell/Sidebar.js')

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

async function settle(): Promise<void> {
  await flushMacrotask(0)
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

test('ScreenHost 双重头部去重容器、ScreenProps 注入与缺失视图 warn 原语', { timeout: 60_000 }, async () => {
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

  // 2) 已注册 client screen 渲染时，内层 Screen 包裹于 .screen-host-stage[data-screen-host="true"]，
  // 且主/分屏分别从 primaryTarget / splitTarget 注入标准 ScreenProps 并把 setParams 路由到对应面板。
  const receivedProps: Array<Record<string, unknown>> = []
  seedPluginClientModule(
    'ext-demo',
    'index.tsx',
    {
      Board: (props: Record<string, unknown>) => {
        receivedProps.push(props)
        return (
          <Screen title="插件看板" subtitle="副标题说明" actions={<button type="button">刷新</button>}>
            <div>正文内容</div>
          </Screen>
        )
      },
    },
    'demo-hash-1',
  )
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/plugins/ext-demo/client.mjs')) {
      return new Response('', { status: 200, headers: { 'x-helm-client-hash': 'demo-hash-1' } })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  const paramCalls: Array<{ patch: Record<string, string | undefined>; options?: { split?: boolean; push?: boolean } }> = []
  const activeStore = makeTestStore({
    primaryTarget: { kind: 'screen', pluginId: 'ext-demo', screenId: 'board', params: { view: 'main' } },
    splitTarget: { kind: 'screen', pluginId: 'ext-demo', screenId: 'board', params: { view: 'right' } },
    uiContributions: [
      {
        pluginId: 'ext-demo',
        surface: 'screen',
        spec: { id: 'board', label: '插件看板', client: { module: 'index.tsx', export: 'Board' } },
      },
    ],
  })
  const realSetScreenParams = activeStore.actions.setScreenParams
  ;(activeStore.actions as unknown as { setScreenParams: (patch: Record<string, string | undefined>, options?: { split?: boolean; push?: boolean }) => void }).setScreenParams = (patch, options) => {
    paramCalls.push({ patch, options })
    realSetScreenParams(patch, options)
  }

  mount(
    <HostStoreProviders value={activeStore}>
      <ScreenHost pluginId="ext-demo" screenId="board" />
    </HostStoreProviders>,
  )
  await flushMacrotask(0)

  const topbar = host?.querySelector('.pane-topbar')
  const stage = host?.querySelector<HTMLElement>('.screen-host-stage[data-screen-host="true"]')
  assert.ok(topbar, 'ScreenHost 应保留唯一宿主顶栏 .pane-topbar')
  assert.ok(stage, 'ScreenHost 应标注 .screen-host-stage[data-screen-host="true"]')
  assert.ok(stage.querySelector('.screen-header .screen-heading .screen-title'), '内层 Screen 存在标准 .screen-header > .screen-heading > .screen-title 供 CSS 去重')
  assert.ok(stage.querySelector('.screen-subtitle'), '副标题应保留')
  assert.ok(stage.querySelector('button'), '右侧动作按钮应保留')

  assert.ok(receivedProps.length >= 1)
  const primaryProps = receivedProps[receivedProps.length - 1]!
  assert.equal(primaryProps.pluginId, 'ext-demo')
  assert.equal(primaryProps.screenId, 'board')
  assert.equal(primaryProps.isSplit, false)
  assert.deepEqual(primaryProps.params, { view: 'main' })
  ;(primaryProps.setParams as (patch: Record<string, string | undefined>, options?: { push?: boolean }) => void)(
    { tab: 'overview' },
    { push: true },
  )

  mount(
    <HostStoreProviders value={activeStore}>
      <ScreenHost pluginId="ext-demo" screenId="board" isSplit />
    </HostStoreProviders>,
  )
  await flushMacrotask(0)
  const splitProps = receivedProps[receivedProps.length - 1]!
  assert.equal(splitProps.isSplit, true)
  assert.deepEqual(splitProps.params, { view: 'right' })
  ;(splitProps.setParams as (patch: Record<string, string | undefined>, options?: { push?: boolean }) => void)(
    { tab: 'logs' },
    { push: false },
  )

  assert.deepEqual(paramCalls, [
    { patch: { tab: 'overview' }, options: { split: false, push: true } },
    { patch: { tab: 'logs' }, options: { split: true, push: false } },
  ])
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
    await settle()

    const modal = document.querySelector<HTMLElement>('.modal[aria-label="Command palette and global search"]')
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
    const modelIdx = allRows.findIndex((el) => (el.textContent ?? '').includes('Switch current model'))
    const firstRecentIdx = allRows.findIndex((el) => (el.textContent ?? '').includes('最近话题'))
    const navIdx = allRows.findIndex((el) => (el.textContent ?? '').includes('Open agent profile center'))
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
  })
  ;(expandedStore.actions as unknown as { toggleSidebarCollapsed: () => void }).toggleSidebarCollapsed = () => {
    toggleCount += 1
    expandedStore.setSidebarCollapsed(true)
  }
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
  })
  ;(collapsedStore.actions as unknown as { toggleSidebarCollapsed: () => void }).toggleSidebarCollapsed = () => {
    toggleCount += 1
    collapsedStore.setSidebarCollapsed(false)
  }
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
})
