import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary } from '@helm/protocol'
import { hangingEventStream, type SseFrameSender } from './helpers/sse-stream.js'
import type { ResolvedTarget, ActiveModal } from '../src/lib/types.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const { HelmStoreProvider } = await import('../src/lib/HelmStoreProvider.js')
const { useHelmStore } = await import('../src/lib/store-context.js')
const e = React.createElement
const originalFetch = globalThis.fetch
let root: Root | undefined
let host: HTMLElement | undefined
let deleteRequest: { conversationId: number; complete(): void } | undefined
/** 当前挂起的 /api/events 流发送器：流终结（abort/cancel）后自动失效。 */
let sendEvent: SseFrameSender | undefined
let observed: { primary: ResolvedTarget; split: ResolvedTarget | null; modal: ActiveModal } | undefined
let navigateTo: ((target: ResolvedTarget) => void) | undefined
let historyLog: Array<{ method: 'push' | 'replace'; hash: string }> = []

function summary(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
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
    ...overrides,
  }
}

const conversations = [
  summary(1),
  summary(2),
  summary(3, { nodeId: 'remote-node', cwd: '/remote/work' }),
]

function eventFrame(seq: number, event: unknown): Uint8Array {
  return new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ seq, event })}\n\n`)
}

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200 })
    }
    if (url === '/api/events') {
      return new Response(hangingEventStream((send) => {
        sendEvent = send
        send(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({
          seq: 1,
          conversations,
          pendingAsks: [],
          plugins: [],
          ui: [],
        })}\n\n`))
      }, { signal: init?.signal, onTeardown: () => { sendEvent = undefined } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const artifactMatch = /^\/api\/conversations\/(\d+)\/artifacts$/.exec(url)
    if (artifactMatch && method === 'GET') {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    const deleteMatch = /^\/api\/conversations\/(\d+)$/.exec(url)
    if (deleteMatch && method === 'DELETE') {
      const conversationId = Number(deleteMatch[1])
      return await new Promise<Response>((resolve) => {
        deleteRequest = {
          conversationId,
          complete() {
            sendEvent?.(eventFrame(2, { type: 'conversation.deleted', conversationId }))
            resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
          },
        }
      })
    }
    const detailMatch = /^\/api\/conversations\/(\d+)/.exec(url)
    if (detailMatch && method === 'GET') {
      const conversationId = Number(detailMatch[1])
      const found = conversations.find((item) => item.id === conversationId)
      return new Response(JSON.stringify({ ...(found ?? summary(conversationId)), entries: [] }), { status: 200 })
    }
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

function App(): React.ReactNode {
  const store = useHelmStore()
  observed = { primary: store.primaryTarget, split: store.splitTarget, modal: store.activeModal }
  navigateTo = (target) => store.openTarget(target)
  const pane = (target: ResolvedTarget | null, key: string, props: { isSplit?: boolean; isDrawer?: boolean } = {}) =>
    target?.kind === 'conversation'
      ? e(ConversationPane, {
          key,
          conversationId: target.conversationId,
          ...props,
          ...(props.isSplit ? { onCloseSplit: store.closeSplit } : {}),
          ...(props.isDrawer ? { onCloseDrawer: () => store.setActiveModal(null) } : {}),
        })
      : null
  return e(React.Fragment, null,
    pane(store.primaryTarget, `primary:${store.primaryTarget.kind === 'conversation' ? store.primaryTarget.conversationId : 'other'}`),
    pane(store.splitTarget, `split:${store.splitTarget?.kind === 'conversation' ? store.splitTarget.conversationId : 'other'}`, { isSplit: true }),
    store.activeModal?.kind === 'conversation-drawer'
      ? pane({ kind: 'conversation', conversationId: store.activeModal.conversationId }, `drawer:${store.activeModal.conversationId}`, { isDrawer: true })
      : null,
  )
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

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
}

async function clickDelete(paneIndex: number): Promise<void> {
  const menuButtons = [...document.querySelectorAll<HTMLButtonElement>('.pane-more-menu button[aria-label="更多会话操作"]')]
  assert.ok(menuButtons[paneIndex], `第 ${paneIndex} 个会话窗格应有更多操作按钮`)
  await act(async () => {
    menuButtons[paneIndex]!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
  })
  const deleteItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => item.textContent?.includes('删除会话'))
  assert.ok(deleteItem, '菜单中应显示删除会话操作')
  await act(async () => { deleteItem!.click() })
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
    .find((button) => button.textContent?.trim() === '删除会话')
  assert.ok(confirm, '确认对话框应显示删除会话按钮')
  await act(async () => { confirm!.click() })
  await settle()
  assert.ok(deleteRequest, '真实 ConversationPane 应调用删除 API')
}

async function finishDelete(): Promise<void> {
  const request = deleteRequest
  assert.ok(request)
  await act(async () => {
    request!.complete()
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
  await settle()
}

function reset(): void {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  sendEvent = undefined
  deleteRequest = undefined
  observed = undefined
  navigateTo = undefined
  historyLog = []
}

afterEach(() => {
  restoreHistorySpies()
  reset()
})

let originalPushState: typeof history.pushState | undefined
let originalReplaceState: typeof history.replaceState | undefined

function spyHistory(): void {
  originalPushState = history.pushState.bind(history)
  originalReplaceState = history.replaceState.bind(history)
  history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
    historyLog.push({ method: 'push', hash: url === undefined ? window.location.hash : String(url) })
    return originalPushState!(data, unused, url)
  }) as typeof history.pushState
  history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
    historyLog.push({ method: 'replace', hash: url === undefined ? window.location.hash : String(url) })
    return originalReplaceState!(data, unused, url)
  }) as typeof history.replaceState
}

function restoreHistorySpies(): void {
  if (originalPushState !== undefined) history.pushState = originalPushState
  if (originalReplaceState !== undefined) history.replaceState = originalReplaceState
  originalPushState = undefined
  originalReplaceState = undefined
}

test('删除分屏会话只关闭分屏，主屏会话保持不变', { timeout: 60_000 }, async () => {
  await mount('#/c/1?split=c/2')
  assert.equal(observed?.primary.kind, 'conversation')
  assert.equal(observed?.split?.kind, 'conversation')
  await clickDelete(1)
  assert.equal(deleteRequest?.conversationId, 2)
  await finishDelete()
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 })
  assert.equal(observed?.split, null)
})

test('删除抽屉会话只关闭对应抽屉', { timeout: 60_000 }, async () => {
  await mount('#/c/1?modal=drawer&id=2')
  assert.equal(observed?.modal?.kind, 'conversation-drawer')
  await clickDelete(1)
  assert.equal(deleteRequest?.conversationId, 2)
  await finishDelete()
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 })
  assert.equal(observed?.modal, null)
})

test('删除本机主屏会话 replace 回该智能体待命态（不选其他会话）', { timeout: 60_000 }, async () => {
  spyHistory()
  await mount('#/c/1')
  await clickDelete(0)
  assert.equal(deleteRequest?.conversationId, 1)
  await finishDelete()
  // 本机节点不显式携带（local 是缺省），但工作目录照常继承
  assert.deepEqual(observed?.primary, { kind: 'agent', profileId: 'assistant', cwd: '/tmp' })
  // 删除导航强制 replace：不污染前进/后退栈，也不会闪跳到别的历史会话。
  const last = historyLog[historyLog.length - 1]
  assert.ok(last, '删除后应有地址栏写回')
  assert.equal(last.method, 'replace')
  assert.equal(last.hash, `#/a/assistant?cwd=${encodeURIComponent('/tmp')}`)
  assert.equal(window.location.hash, `#/a/assistant?cwd=${encodeURIComponent('/tmp')}`)
})

test('删除远端主屏会话：待命目标继承节点与目录，不悄悄切回本机', { timeout: 60_000 }, async () => {
  spyHistory()
  await mount('#/c/3')
  await clickDelete(0)
  assert.equal(deleteRequest?.conversationId, 3)
  await finishDelete()
  assert.deepEqual(observed?.primary, {
    kind: 'agent',
    profileId: 'assistant',
    nodeId: 'remote-node',
    cwd: '/remote/work',
  })
  assert.equal(window.location.hash, `#/a/assistant?node=remote-node&cwd=${encodeURIComponent('/remote/work')}`)
})

test('删除请求等待期间用户切换会话，迟到的删除事件不覆盖新导航', { timeout: 60_000 }, async () => {
  await mount('#/c/1')
  await clickDelete(0)
  await act(async () => {
    navigateTo?.({ kind: 'conversation', conversationId: 2 })
  })
  await settle()
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 2 })
  await finishDelete()
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 2 })
})
