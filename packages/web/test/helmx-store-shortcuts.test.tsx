import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary } from '@helmx/protocol'
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
  type HelmxShortcutDetail,
} from '../src/shell/shortcuts-model.js'
import type { HelmxStoreValue, ResolvedTarget } from '../src/lib/types.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { createRoot } = await import('react-dom/client')
const { HelmxStoreProvider } = await import('../src/lib/HelmxStoreProvider.js')
const { useHelmxStore } = await import('../src/lib/store-context.js')
const { App } = await import('../src/App.js')

const originalFetch = globalThis.fetch

let root: Root | undefined
let host: HTMLElement | undefined
let sendEvent: SseFrameSender | undefined
let capturedStore: HelmxStoreValue | undefined
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
  const store = useHelmxStore()
  capturedStore = store
  return (
    <div data-testid="shortcut-harness">
      <div
        data-helmx-panel="primary"
        tabIndex={-1}
        onPointerDownCapture={() => store.setFocusedPanel?.('primary')}
        onFocusCapture={() => store.setFocusedPanel?.('primary')}
      >
        <input data-testid="primary-input" type="text" />
      </div>
      {store.splitTarget !== null && (
        <div
          data-helmx-panel="split"
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
): Promise<HelmxStoreValue> {
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch(options)
  await act(async () => {
    root = createRoot(host!)
    root.render(
      <HelmxStoreProvider>
        <ShortcutHarness />
      </HelmxStoreProvider>,
    )
  })
  await settle()
  assert.ok(capturedStore, 'HelmxStoreProvider must supply the store to child components')
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

test('shortcuts-model pure functions: split focus, status checks and local persistence contracts', { timeout: 60_000 }, () => {
  assert.equal(SIDEBAR_COLLAPSED_STORAGE_KEY, 'helmx:sidebar-collapsed')
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

  // Platform modifier formatting carries no multi-key alias separators
  assert.equal(formatModShortcut('K').includes('/'), false)
  assert.equal(formatModShortcut('B').endsWith('B'), true)

  // Overlay and inline-input detection
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
  modelPopover.className = 'helmx-popover-content composer-model-popover'
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

test('HelmxStoreProvider ignores global shortcuts while unauthenticated', { timeout: 60_000 }, async () => {
  await mountProvider('#/c/1', { authenticated: false })

  const fired: HelmxShortcutDetail[] = []
  const listener = (ev: Event) => {
    fired.push((ev as CustomEvent<HelmxShortcutDetail>).detail)
  }
  window.addEventListener('helmx:shortcut', listener)

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
    window.removeEventListener('helmx:shortcut', listener)
  }
})

test('HelmxStoreProvider split-focus routing and global single-key shortcut dispatch (Ctrl+L/O, Mod+K/B/J)', { timeout: 60_000 }, async () => {
  const store = await mountProvider('#/c/1')
  assert.equal(store.focusedPanel, 'primary')

  // Open the split, test Pointer/Focus entering split, and closing the split auto-resets to primary
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

  const fired: HelmxShortcutDetail[] = []
  const onShortcut = (ev: Event) => {
    fired.push((ev as CustomEvent<HelmxShortcutDetail>).detail)
  }
  window.addEventListener('helmx:shortcut', onShortcut)

  try {
    const evL1 = dispatchWindowKey({ key: 'l', ctrlKey: true })
    assert.equal(evL1.defaultPrevented, true, 'Ctrl+L must call preventDefault')

    const evO1 = dispatchWindowKey({ key: 'o', ctrlKey: true })
    assert.equal(evO1.defaultPrevented, true, 'Ctrl+O must call preventDefault')

    assert.deepEqual(fired, [
      { action: 'toggle-model-picker', panel: 'split' },
      { action: 'toggle-process-groups', panel: 'split' },
    ])

    // Switch back to primary, then to split, and verify closing the split auto-resets to primary
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

    // With the ModelPicker popover open (carrying role="dialog" + .composer-model-popover):
    // a second Ctrl+L still dispatches toggle-model-picker to close the popover; Ctrl+O stays blocked
    const modelPopover = document.createElement('div')
    modelPopover.setAttribute('role', 'dialog')
    modelPopover.className = 'helmx-popover-content composer-model-popover'
    document.body.appendChild(modelPopover)
    const countBeforePopover = fired.length
    const evLToggleClose = dispatchWindowKey({ key: 'l', ctrlKey: true })
    assert.equal(evLToggleClose.defaultPrevented, true, 'with ModelPicker open, a second Ctrl+L must still dispatch the close event')
    const evOBlockedByPopover = dispatchWindowKey({ key: 'o', ctrlKey: true })
    assert.equal(evOBlockedByPopover.defaultPrevented, false)
    assert.deepEqual(fired.slice(countBeforePopover), [{ action: 'toggle-model-picker', panel: 'primary' }])
    modelPopover.remove()

    // With a plain modal/drawer [role="dialog"] open: Ctrl+L must be intercepted and never dispatched
    const normalDialog = document.createElement('div')
    normalDialog.setAttribute('role', 'dialog')
    document.body.appendChild(normalDialog)
    const countBeforeNormalDialog = fired.length
    const evLBlocked = dispatchWindowKey({ key: 'l', ctrlKey: true })
    assert.equal(evLBlocked.defaultPrevented, false)
    assert.equal(fired.length, countBeforeNormalDialog)
    normalDialog.remove()
  } finally {
    window.removeEventListener('helmx:shortcut', onShortcut)
  }

  // Mod+K: toggle the CommandPaletteModal
  dispatchWindowKey(modInit('k'))
  assert.equal(capturedStore?.activeModal?.kind, 'command-palette')
  dispatchWindowKey(modInit('k'))
  assert.equal(capturedStore?.activeModal, null)

  // Mod+J: toggle the WorkbenchDrawer
  assert.equal(capturedStore?.workbenchOpen, false)
  dispatchWindowKey(modInit('j'))
  assert.equal(capturedStore?.workbenchOpen, true)
  dispatchWindowKey(modInit('j'))
  assert.equal(capturedStore?.workbenchOpen, false)

  // Mod+B: toggle the desktop sidebar collapse and persist it to localStorage
  assert.equal(capturedStore?.sidebarCollapsed, false)
  dispatchWindowKey(modInit('b'))
  assert.equal(capturedStore?.sidebarCollapsed, true)
  assert.equal(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY), '1')

  // A remount restores the collapsed state from localStorage
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

test('HelmxStoreProvider double-Esc misfire-protection state machine (overlay interception / non-running skip / 1.5s timeout reset / double-tap abort)', { timeout: 60_000 }, async () => {
  await mountProvider('#/c/1')

  // 1) Pressing Esc on an idle conversation (#1) never arms or aborts
  dispatchWindowKey({ key: 'Escape' })
  dispatchWindowKey({ key: 'Escape' })
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)
  assert.equal(abortCalls.length, 0)

  // Open the split (#2 is working) and focus split
  await act(async () => {
    capturedStore?.openTarget({ kind: 'conversation', conversationId: 2 }, { split: true })
  })
  await settle(20)
  await act(async () => {
    capturedStore?.setFocusedPanel?.('split')
  })

  // 2) If an inner element calls stopPropagation, or the key carries Shift, the armed state is never entered
  dispatchWindowKey({ key: 'Escape', shiftKey: true })
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

  const consumerInput = document.querySelector<HTMLElement>('[data-testid="esc-consumer-input"]')
  assert.ok(consumerInput)
  dispatchWindowKey({ key: 'Escape' }, consumerInput)
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

  // 3) With a global modal or [role="dialog"] / workbench open, the Esc abort never triggers
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

  // 4) The first Esc enters the 1.5s armed notice without aborting immediately
  dispatchWindowKey({ key: 'Escape' })
  assert.equal(capturedStore?.pendingEscAbortConversationId, 2)
  assert.equal(abortCalls.length, 0)

  // 5) Past 1.5s it resets automatically
  await settle(ESC_ABORT_WINDOW_MS + 100)
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)
  assert.equal(abortCalls.length, 0)

  // 6) Two Esc presses within 1.5s abort the focusedPanel's conversation #2
  dispatchWindowKey({ key: 'Escape' })
  assert.equal(capturedStore?.pendingEscAbortConversationId, 2)
  dispatchWindowKey({ key: 'Escape' })
  await settle(20)
  assert.deepEqual(abortCalls, [2])
  assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

  // 7) Unmounting while armed cleans up the timer properly (no errors/exceptions)
  dispatchWindowKey({ key: 'Escape' })
  assert.equal(capturedStore?.pendingEscAbortConversationId, 2)
})

test('App split containers with data-helmx-panel capture focus and coordinate the WorkbenchDrawer and sidebar-collapsed', { timeout: 60_000 }, async () => {
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

  const shell = host.querySelector<HTMLElement>('.helmx-shell')
  assert.ok(shell, 'App must render .helmx-shell')
  assert.equal(shell.classList.contains('sidebar-collapsed'), true, 'with the collapsed state saved in localStorage, App must attach .sidebar-collapsed')

  // Press Mod+B to expand the sidebar
  dispatchWindowKey(modInit('b'))
  assert.equal(shell.classList.contains('sidebar-collapsed'), false, 'Mod+B must remove .sidebar-collapsed')

  const primaryPane = host.querySelector<HTMLElement>('[data-helmx-panel="primary"]')
  const splitPane = host.querySelector<HTMLElement>('[data-helmx-panel="split"]')
  assert.ok(primaryPane, 'the primary pane must carry data-helmx-panel="primary"')
  assert.ok(splitPane, 'the split pane must carry data-helmx-panel="split"')

  // The WorkbenchDrawer initially points at primary (#1)
  const workbenchInitial = document.querySelector<HTMLElement>('.helmx-workbench')
  assert.ok(workbenchInitial, 'with wb=artifacts the .helmx-workbench must be open')
  assert.equal(artifactRequests.includes(1), true)

  // Pointer/Focus entering the split container -> the WorkbenchDrawer switches to split conversation #2's artifacts
  await act(async () => {
    splitPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  })
  await settle(40)
  assert.equal(artifactRequests.includes(2), true, 'after focusing split, the WorkbenchDrawer must switch to conversation #2')
  assert.match(document.querySelector('.helmx-workbench')?.textContent ?? '', /split-artifact\.md/)

  // Switch focus back to primary
  await act(async () => {
    primaryPane.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
  await settle(40)
  assert.match(document.querySelector('.helmx-workbench')?.textContent ?? '', /primary-artifact\.md/)
})
