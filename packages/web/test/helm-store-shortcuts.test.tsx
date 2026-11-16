import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary } from '@helm/protocol'
import { hangingEventStream, type SseFrameSender } from './helpers/sse-stream.js'
import {
  ESC_ABORT_WINDOW_MS,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  activeTargetForPanel,
  formatModShortcut,
  getStoredSidebarCollapsed,
  hasAnyOpenOverlay,
  hasBlockingAlertDialog,
  hasDialogOpen,
  hasNonModelPickerDialogOpen,
  isApplePlatform,
  isConversationAbortable,
  isInlineInputEscapeTarget,
  persistSidebarCollapsed,
  resolveFocusedPanel,
  type HelmShortcutDetail,
} from '../src/shell/shortcuts-model.js'
import type { HelmStoreValue, ResolvedTarget } from '../src/lib/types.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { createRoot } = await import('react-dom/client')
const { HelmStoreProvider } = await import('../src/lib/HelmStoreProvider.js')
const { useHelmStore } = await import('../src/lib/store-context.js')
const { App } = await import('../src/App.js')

const originalFetch = globalThis.fetch

let root: Root | undefined
let host: HTMLElement | undefined
let sendEvent: SseFrameSender | undefined
let capturedStore: HelmStoreValue | undefined
let abortCalls: number[] = []
let artifactRequests: number[] = []

function makeConversation(
  id: number,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    title: `测试会话 ${id}`,
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
    createdAt: id,
    updatedAt: id,
    ...overrides,
  }
}

interface FetchHarnessOptions {
  authenticated?: boolean
  conversations?: ConversationSummary[]
}

function installFetch(options: FetchHarnessOptions = {}): void {
  const authenticated = options.authenticated ?? true
  const conversations = options.conversations ?? [
    makeConversation(1, { status: 'idle', title: '主屏会话' }),
    makeConversation(2, { status: 'working', title: '分屏会话' }),
  ]

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === '/api/events') {
      return new Response(
        hangingEventStream(
          (send) => {
            sendEvent = send
            send(
              new TextEncoder().encode(
                `event: snapshot\ndata: ${JSON.stringify({
                  bootId: 'shortcuts-test-boot',
                  seq: 1,
                  conversations,
                  pendingAsks: [],
                  plugins: [],
                  ui: [],
                })}\n\n`,
              ),
            )
          },
          {
            signal: init?.signal,
            onTeardown: () => {
              sendEvent = undefined
            },
          },
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
    const abortMatch = /^\/api\/conversations\/(\d+)\/abort$/.exec(url)
    if (abortMatch && method === 'POST') {
      const id = Number(abortMatch[1])
      abortCalls.push(id)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const artifactsMatch = /^\/api\/conversations\/(\d+)\/artifacts$/.exec(url)
    if (artifactsMatch && method === 'GET') {
      const id = Number(artifactsMatch[1])
      artifactRequests.push(id)
      return new Response(
        JSON.stringify([
          {
            id: `art-${id}`,
            conversationId: id,
            name: id === 2 ? 'split-artifact.md' : 'primary-artifact.md',
            mimeType: 'text/markdown',
            size: 128,
            createdAt: id,
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const detailMatch = /^\/api\/conversations\/(\d+)$/.exec(url)
    if (detailMatch && method === 'GET') {
      const id = Number(detailMatch[1])
      const found = conversations.find((c) => c.id === id) ?? makeConversation(id)
      return new Response(JSON.stringify({ ...found, entries: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'GET') {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

function ShortcutHarness(): React.ReactNode {
  const store = useHelmStore()
  capturedStore = store
  return (
    <div data-testid="shortcut-harness">
      <div
        data-helm-panel="primary"
        tabIndex={-1}
        onPointerDownCapture={() => store.setFocusedPanel?.('primary')}
        onFocusCapture={() => store.setFocusedPanel?.('primary')}
      >
        <input data-testid="primary-input" type="text" />
      </div>
      {store.splitTarget !== null && (
        <div
          data-helm-panel="split"
          tabIndex={-1}
          onPointerDownCapture={() => store.setFocusedPanel?.('split')}
          onFocusCapture={() => store.setFocusedPanel?.('split')}
        >
          <input data-testid="split-input" type="text" />
        </div>
      )}
      <div
        data-testid="esc-consumer"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
          }
        }}
      >
        <input data-testid="esc-consumer-input" type="text" />
      </div>
    </div>
  )
}

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function mountProvider(
  hash: string,
  options: FetchHarnessOptions = {},
): Promise<HelmStoreValue> {
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch(options)
  await act(async () => {
    root = createRoot(host!)
    root.render(
      <HelmStoreProvider>
        <ShortcutHarness />
      </HelmStoreProvider>,
    )
  })
  await settle()
  assert.ok(capturedStore, 'HelmStoreProvider 应向子组件提供 store')
  return capturedStore
}

function dispatchWindowKey(
  init: KeyboardEventInit & { key: string },
  target: EventTarget = window,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function modInit(key: string): KeyboardEventInit & { key: string } {
  return isApplePlatform() ? { key, metaKey: true } : { key, ctrlKey: true }
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
  sendEvent = undefined
  capturedStore = undefined
  abortCalls = []
  artifactRequests = []
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
})

test('shortcuts-model 纯函数：分屏焦点、状态检查与本地持久化契约', { timeout: 60_000 }, () => {
  assert.equal(SIDEBAR_COLLAPSED_STORAGE_KEY, 'helm:sidebar-collapsed')
  assert.equal(ESC_ABORT_WINDOW_MS, 1500)

  const primary: ResolvedTarget = { kind: 'conversation', conversationId: 1 }
  const split: ResolvedTarget = { kind: 'conversation', conversationId: 2 }

  assert.equal(resolveFocusedPanel('split', null), 'primary')
  assert.equal(resolveFocusedPanel('split', split), 'split')
  assert.equal(resolveFocusedPanel('primary', split), 'primary')

  assert.deepEqual(activeTargetForPanel(primary, null, 'split'), primary)
  assert.deepEqual(activeTargetForPanel(primary, split, 'split'), split)
  assert.deepEqual(activeTargetForPanel(primary, split, 'primary'), primary)

  assert.equal(isConversationAbortable(undefined), false)
  assert.equal(isConversationAbortable(makeConversation(1, { status: 'idle' })), false)
  assert.equal(isConversationAbortable(makeConversation(2, { status: 'working' })), true)

  persistSidebarCollapsed(true)
  assert.equal(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY), '1')
  assert.equal(getStoredSidebarCollapsed(), true)

  persistSidebarCollapsed(false)
  assert.equal(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY), '0')
  assert.equal(getStoredSidebarCollapsed(), false)

  window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'true')
  assert.equal(getStoredSidebarCollapsed(), true)

  // 平台修饰键格式化不含双键别名分隔符
  assert.equal(formatModShortcut('K').includes('/'), false)
  assert.equal(formatModShortcut('B').endsWith('B'), true)

  // 浮层与内联输入检测
  assert.equal(hasAnyOpenOverlay({ kind: 'command-palette' }, false), true)
  assert.equal(hasAnyOpenOverlay(null, true), true)
  assert.equal(hasAnyOpenOverlay(null, false), false)
  assert.equal(hasBlockingAlertDialog(), false)
  assert.equal(hasDialogOpen(), false)

  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  document.body.appendChild(dialog)
  assert.equal(hasDialogOpen(), true)
  assert.equal(hasNonModelPickerDialogOpen(), true)
  dialog.remove()

  const modelPopover = document.createElement('div')
  modelPopover.setAttribute('role', 'dialog')
  modelPopover.className = 'helm-popover-content composer-model-popover'
  document.body.appendChild(modelPopover)
  assert.equal(hasDialogOpen(), true)
  assert.equal(hasNonModelPickerDialogOpen(), false)
  modelPopover.remove()

  const alertDialog = document.createElement('div')
  alertDialog.setAttribute('role', 'alertdialog')
  document.body.appendChild(alertDialog)
  assert.equal(hasBlockingAlertDialog(), true)
  assert.equal(hasDialogOpen(), true)
  alertDialog.remove()

  const topbar = document.createElement('div')
  topbar.className = 'pane-topbar'
  const inlineInput = document.createElement('input')
  topbar.appendChild(inlineInput)
  document.body.appendChild(topbar)
  assert.equal(isInlineInputEscapeTarget(inlineInput), true)
  topbar.remove()

  const bareInput = document.createElement('input')
  assert.equal(isInlineInputEscapeTarget(bareInput), false)
})

test('HelmStoreProvider 未认证时不响应全局快捷键', { timeout: 60_000 }, async () => {
  await mountProvider('#/c/1', { authenticated: false })

  const fired: HelmShortcutDetail[] = []
  const listener = (ev: Event) => {
    fired.push((ev as CustomEvent<HelmShortcutDetail>).detail)
  }
  window.addEventListener('helm:shortcut', listener)

  try {
    dispatchWindowKey(modInit('k'))
    dispatchWindowKey(modInit('b'))
    dispatchWindowKey(modInit('j'))
    dispatchWindowKey({ key: 'l', ctrlKey: true })
    dispatchWindowKey({ key: 'o', ctrlKey: true })
    dispatchWindowKey({ key: 'Escape' })
    dispatchWindowKey({ key: 'Escape' })
    await settle(20)

    assert.equal(capturedStore?.activeModal, null)
    assert.equal(capturedStore?.sidebarCollapsed, false)
    assert.equal(capturedStore?.workbenchOpen, false)
    assert.equal(fired.length, 0)
    assert.equal(abortCalls.length, 0)
  } finally {
    window.removeEventListener('helm:shortcut', listener)
  }
})

test('HelmStoreProvider 分屏焦点路由与全局单键快捷键派发（Ctrl+L/O, Mod+K/B/J）', { timeout: 60_000 }, async () => {
  const store = await mountProvider('#/c/1')
  assert.equal(store.focusedPanel, 'primary')

  // 打开分屏并测试 Pointer/Focus 切入 split 与关闭 split 自动复位 primary
  await act(async () => {
    capturedStore?.openTarget({ kind: 'conversation', conversationId: 2 }, { split: true })
  })
  await settle(20)
  assert.deepEqual(capturedStore?.splitTarget, { kind: 'conversation', conversationId: 2 })

  const splitInput = document.querySelector<HTMLElement>('[data-testid="split-input"]')
  const primaryInput = document.querySelector<HTMLElement>('[data-testid="primary-input"]')
  assert.ok(splitInput && primaryInput)

  await act(async () => {
    splitInput.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  })
  assert.equal(capturedStore?.focusedPanel, 'split')

  const fired: HelmShortcutDetail[] = []
  const onShortcut = (ev: Event) => {
    fired.push((ev as CustomEvent<HelmShortcutDetail>).detail)
  }
  window.addEventListener('helm:shortcut', onShortcut)

  try {
    const evL1 = dispatchWindowKey({ key: 'l', ctrlKey: true })
    assert.equal(evL1.defaultPrevented, true, 'Ctrl+L 应调用 preventDefault')

    const evO1 = dispatchWindowKey({ key: 'o', ctrlKey: true })
    assert.equal(evO1.defaultPrevented, true, 'Ctrl+O 应调用 preventDefault')

    assert.deepEqual(fired, [
      { action: 'toggle-model-picker', panel: 'split' },
      { action: 'toggle-process-groups', panel: 'split' },
    ])

    // 切回 primary 再切 split，并验证关闭分屏自动复位 primary
    await act(async () => {
      primaryInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    assert.equal(capturedStore?.focusedPanel, 'primary')
    await act(async () => {
      splitInput.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    assert.equal(capturedStore?.focusedPanel, 'split')

    await act(async () => {
      capturedStore?.closeSplit()
    })
    assert.equal(capturedStore?.splitTarget, null)
    assert.equal(capturedStore?.focusedPanel, 'primary')

    const evL2 = dispatchWindowKey({ key: 'l', ctrlKey: true })
    assert.equal(evL2.defaultPrevented, true)
    assert.deepEqual(fired[2], { action: 'toggle-model-picker', panel: 'primary' })

    // ModelPicker Popover 打开（带 role="dialog" + .composer-model-popover）时：
    // 再次 Ctrl+L 仍正常派发 toggle-model-picker 关闭浮层；Ctrl+O 仍被阻止
    const modelPopover = document.createElement('div')
    modelPopover.setAttribute('role', 'dialog')
    modelPopover.className = 'helm-popover-content composer-model-popover'
    document.body.appendChild(modelPopover)
    const countBeforePopover = fired.length
    const evLToggleClose = dispatchWindowKey({ key: 'l', ctrlKey: true })
    assert.equal(evLToggleClose.defaultPrevented, true, 'ModelPicker 打开时再次 Ctrl+L 应可派发关闭事件')
    const evOBlockedByPopover = dispatchWindowKey({ key: 'o', ctrlKey: true })
    assert.equal(evOBlockedByPopover.defaultPrevented, false)
    assert.deepEqual(fired.slice(countBeforePopover), [{ action: 'toggle-model-picker', panel: 'primary' }])
    modelPopover.remove()

    // 普通模态/抽屉 [role="dialog"] 打开时：Ctrl+L 应被拦截，绝不派发
    const normalDialog = document.createElement('div')
    normalDialog.setAttribute('role', 'dialog')
    document.body.appendChild(normalDialog)
    const countBeforeNormalDialog = fired.length
    const evLBlocked = dispatchWindowKey({ key: 'l', ctrlKey: true })
    assert.equal(evLBlocked.defaultPrevented, false)
    assert.equal(fired.length, countBeforeNormalDialog)
    normalDialog.remove()
  } finally {
    window.removeEventListener('helm:shortcut', onShortcut)
  }

  // Mod+K：开关 CommandPaletteModal
  dispatchWindowKey(modInit('k'))
  assert.equal(capturedStore?.activeModal?.kind, 'command-palette')
  dispatchWindowKey(modInit('k'))
  assert.equal(capturedStore?.activeModal, null)

  // Mod+J：开关 WorkbenchDrawer
  assert.equal(capturedStore?.workbenchOpen, false)
  dispatchWindowKey(modInit('j'))
  assert.equal(capturedStore?.workbenchOpen, true)
  dispatchWindowKey(modInit('j'))
  assert.equal(capturedStore?.workbenchOpen, false)

  // Mod+B：切换桌面端侧栏折叠并持久化至 localStorage
  assert.equal(capturedStore?.sidebarCollapsed, false)
  dispatchWindowKey(modInit('b'))
  assert.equal(capturedStore?.sidebarCollapsed, true)
  assert.equal(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY), '1')

  // 重新挂载应从 localStorage 恢复折叠状态
  act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined

  const remountedStore = await mountProvider('#/c/1')
  assert.equal(remountedStore.sidebarCollapsed, true)

  dispatchWindowKey(modInit('b'))
  assert.equal(capturedStore?.sidebarCollapsed, false)
  assert.equal(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY), '0')
})

test('HelmStoreProvider 双击 Esc 防误触状态机（浮层拦截 / 非运行跳过 / 1.5s 超时复位 / 二连击中止）', { timeout: 60_000 }, async () => {
  await mountProvider('#/c/1')

  // 1) idle 会话（#1）按 Esc 绝不武装或中止
  dispatchWindowKey({ key: 'Escape' })
  dispatchWindowKey({ key: 'Escape' })
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)
  assert.equal(abortCalls.length, 0)

  // 打开分屏（#2 为 working 状态）并聚焦 split
  await act(async () => {
    capturedStore?.openTarget({ kind: 'conversation', conversationId: 2 }, { split: true })
  })
  await settle(20)
  await act(async () => {
    capturedStore?.setFocusedPanel?.('split')
  })

  // 2) 若内层元素调用 stopPropagation，或携带 Shift+Esc，绝不进入武装状态
  dispatchWindowKey({ key: 'Escape', shiftKey: true })
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

  const consumerInput = document.querySelector<HTMLElement>('[data-testid="esc-consumer-input"]')
  assert.ok(consumerInput)
  dispatchWindowKey({ key: 'Escape' }, consumerInput)
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

  // 3) 若全局有弹窗或 [role="dialog"] / workbench 打开，绝不触发 Esc 中断
  await act(async () => {
    capturedStore?.setActiveModal({ kind: 'command-palette' })
  })
  dispatchWindowKey({ key: 'Escape' })
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

  await act(async () => {
    capturedStore?.setActiveModal(null)
    capturedStore?.setWorkbenchOpen(true)
  })
  dispatchWindowKey({ key: 'Escape' })
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

  await act(async () => {
    capturedStore?.setWorkbenchOpen(false)
  })

  const popover = document.createElement('div')
  popover.setAttribute('role', 'dialog')
  document.body.appendChild(popover)
  dispatchWindowKey({ key: 'Escape' })
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)
  popover.remove()

  // 4) 首次 Esc 进入 1.5s 武装提示，不立即中止
  dispatchWindowKey({ key: 'Escape' })
  assert.equal(capturedStore?.pendingEscAbortConversationId, 2)
  assert.equal(abortCalls.length, 0)

  // 5) 超过 1.5s 自动复位
  await settle(ESC_ABORT_WINDOW_MS + 100)
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)
  assert.equal(abortCalls.length, 0)

  // 6) 1.5s 内连续两次 Esc 触发中止 focusedPanel 对应会话 #2
  dispatchWindowKey({ key: 'Escape' })
  assert.equal(capturedStore?.pendingEscAbortConversationId, 2)
  dispatchWindowKey({ key: 'Escape' })
  await settle(20)
  assert.deepEqual(abortCalls, [2])
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

  // 7) 武装状态卸载时妥善清理定时器（无报错/异常）
  dispatchWindowKey({ key: 'Escape' })
  assert.equal(capturedStore?.pendingEscAbortConversationId, 2)
})

test('App 分屏容器 data-helm-panel 捕获焦点并联动 WorkbenchDrawer 与 sidebar-collapsed', { timeout: 60_000 }, async () => {
  window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1')
  window.history.replaceState(null, '', '#/c/1?split=c/2&wb=artifacts')
  installFetch()

  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host!)
    root.render(<App />)
  })
  await settle(60)

  const shell = host.querySelector<HTMLElement>('.helm-shell')
  assert.ok(shell, 'App 应渲染 .helm-shell')
  assert.equal(shell.classList.contains('sidebar-collapsed'), true, 'localStorage 已保存折叠态时 App 应附加 .sidebar-collapsed')

  // 按 Mod+B 切换侧栏展开
  dispatchWindowKey(modInit('b'))
  assert.equal(shell.classList.contains('sidebar-collapsed'), false, 'Mod+B 应移除 .sidebar-collapsed')

  const primaryPane = host.querySelector<HTMLElement>('[data-helm-panel="primary"]')
  const splitPane = host.querySelector<HTMLElement>('[data-helm-panel="split"]')
  assert.ok(primaryPane, '主栏应带 data-helm-panel="primary"')
  assert.ok(splitPane, '分屏应带 data-helm-panel="split"')

  // WorkbenchDrawer 初始指向 primary (#1)
  const workbenchInitial = document.querySelector<HTMLElement>('.helm-workbench')
  assert.ok(workbenchInitial, 'wb=artifacts 时应打开 .helm-workbench')
  assert.equal(artifactRequests.includes(1), true)

  // Pointer/Focus 进入分屏容器 -> WorkbenchDrawer 切换读取 split 会话 #2 产物
  await act(async () => {
    splitPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  })
  await settle(40)
  assert.equal(artifactRequests.includes(2), true, '聚焦 split 后 WorkbenchDrawer 应切换到会话 #2')
  assert.match(document.querySelector('.helm-workbench')?.textContent ?? '', /split-artifact\.md/)

  // 切回 primary 焦点
  await act(async () => {
    primaryPane.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
  await settle(40)
  assert.match(document.querySelector('.helm-workbench')?.textContent ?? '', /primary-artifact\.md/)
})
