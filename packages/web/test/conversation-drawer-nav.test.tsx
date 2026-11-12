import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary } from '@helm/protocol'
import type { ResolvedTarget, ActiveModal } from '../src/lib/types.js'

/**
 * 子会话抽屉（conversation-drawer）导航闭环回归：
 * 从工作台打开子代理会话抽屉后，必须能一步「返回父会话」，
 * 且返回后工作台与抽屉关闭互不联动（各归各的导航位置）。
 */
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const { ConversationDrawer } = await import('../src/conversation/ConversationDrawer.js')
const { HelmStoreProvider } = await import('../src/lib/HelmStoreProvider.js')
const { useHelmStore } = await import('../src/lib/store-context.js')
const e = React.createElement
const originalFetch = globalThis.fetch
let root: Root | undefined
let host: HTMLElement | undefined
let observed: {
  primary: ResolvedTarget
  split: ResolvedTarget | null
  workbenchOpen: boolean
  workbenchTab: string
  modal: ActiveModal
} | undefined

function summary(id: number, parentConversationId?: number): ConversationSummary {
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
    createdAt: id,
    updatedAt: id,
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
  }
}

const conversations = [summary(1), summary(11, 1)]

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200 })
    }
    if (url === '/api/events') {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({
            seq: 1,
            conversations,
            pendingAsks: [],
            plugins: [],
            ui: [],
          })}\n\n`))
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const artifactMatch = /^\/api\/conversations\/(\d+)\/artifacts$/.exec(url)
    if (artifactMatch) return new Response(JSON.stringify([]), { status: 200 })
    const detailMatch = /^\/api\/conversations\/(\d+)/.exec(url)
    if (detailMatch && (init?.method ?? 'GET') === 'GET') {
      const id = Number(detailMatch[1])
      const found = conversations.find((item) => item.id === id)
      return new Response(JSON.stringify({ ...(found ?? summary(id)), entries: [] }), { status: 200 })
    }
    if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

function App(): React.ReactNode {
  const store = useHelmStore()
  observed = {
    primary: store.primaryTarget,
    split: store.splitTarget,
    workbenchOpen: store.workbenchOpen,
    workbenchTab: store.workbenchTab,
    modal: store.activeModal,
  }
  const primary = store.primaryTarget.kind === 'conversation' ? store.primaryTarget : null
  return e(React.Fragment, null,
    primary !== null
      ? e(ConversationPane, { key: `primary:${primary.conversationId}`, conversationId: primary.conversationId })
      : null,
    store.activeModal?.kind === 'conversation-drawer'
      ? e(ConversationDrawer, {
          key: `drawer:${store.activeModal.conversationId}`,
          conversationId: store.activeModal.conversationId,
          onClose: () => store.setActiveModal(null),
        })
      : null,
  )
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
}

async function mount(hash: string): Promise<void> {
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch()
  await act(async () => {
    root = createRoot(host!)
    root.render(e(HelmStoreProvider, null, e(App)))
  })
  await settle()
}

async function clickDrawerBack(): Promise<void> {
  const btn = [...document.querySelectorAll<HTMLButtonElement>('.conversation-drawer .pane-parent-nav-btn')]
    .find((b) => (b.getAttribute('aria-label') ?? '').includes('返回父会话'))
  assert.ok(btn, '子会话抽屉顶栏应渲染「返回父会话」按钮')
  await act(async () => { btn!.click() })
  await settle()
}

function reset(): void {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  observed = undefined
}

afterEach(reset)

test('子会话抽屉返回父会话：主屏切到父会话，抽屉与工作台同拍关闭', { timeout: 60_000 }, async () => {
  await mount('#/c/1?wb=artifacts&modal=drawer&id=11')
  assert.equal(observed?.primary.kind === 'conversation' ? observed.primary.conversationId : undefined, 1)
  assert.equal(observed?.modal?.kind, 'conversation-drawer')
  assert.ok(observed?.workbenchOpen)
  await clickDrawerBack()
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 }, '应导航到父会话 #1')
  assert.equal(observed?.modal, null, '抽屉应关闭')
  assert.equal(observed?.workbenchOpen, false, '工作台应一并关闭（导航收口）')
})

test('子会话抽屉普通关闭只关抽屉，不影响工作台', { timeout: 60_000 }, async () => {
  // 直接以「工作台 + 抽屉」深链模拟用户从工作台点开子代理卡后的位置，
  // 验证「关闭」仅关抽屉、不动工作台（收口只发生在导航主屏时）。
  await mount('#/c/1?wb=artifacts&modal=drawer&id=11')
  assert.ok(observed?.workbenchOpen)
  await act(async () => {
    const closeBtn = [...document.querySelectorAll<HTMLButtonElement>('.conversation-drawer-close-btn')]
      .find((b) => (b.getAttribute('aria-label') ?? '') !== '')
    assert.ok(closeBtn, '抽屉应有关闭按钮')
    closeBtn!.click()
  })
  await settle()
  assert.equal(observed?.modal, null, '抽屉关闭')
  assert.equal(observed?.workbenchOpen, true, '普通关闭不动工作台（仍保留）')
})

test('浏览器后退可单独关闭抽屉并保留工作台', { timeout: 60_000 }, async () => {
  // 工作台打开 → push 打开抽屉 → 后退：回到工作台态（浏览器语义不经过 openTarget）。
  await mount('#/c/1?wb=artifacts')
  assert.ok(observed?.workbenchOpen)
  await act(async () => {
    window.history.pushState(null, '', '#/c/1?wb=artifacts&modal=drawer&id=11')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  await settle()
  assert.equal(observed?.modal?.kind, 'conversation-drawer')
  await act(async () => { window.history.back() })
  await settle()
  assert.equal(observed?.modal, null, '后退应关闭抽屉')
  assert.ok(observed?.workbenchOpen, '后退应保留工作台')
})
