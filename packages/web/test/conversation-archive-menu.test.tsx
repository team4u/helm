/**
 * 会话明细顶栏「更多操作」菜单的归档/恢复交互测试（真实 DOM + 真实 Provider）：
 * - 人类自有根会话：菜单显示「归档会话」，点击发送 tags PATCH（保留原 tags、
 *   幂等追加 helm:archived），成功 toast 后不发生任何导航（归档不删除会话）；
 * - 已归档会话：菜单切换为「恢复会话」，PATCH 移除 helm:archived 且保留其他 tags；
 * - bot/helm 托管会话与子代理派生会话：菜单不渲染归档项（无归档资格）；
 * - SSE conversation.upsert 推送新 tags 后，菜单动作随最新归档态切换。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary } from '@helm/protocol'
import { hangingEventStream, type SseFrameSender } from './helpers/sse-stream.js'
import type { ResolvedTarget } from '../src/lib/types.js'
import { ARCHIVED_TAG } from '../src/conversation/archive-model.js'

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
let sendEvent: SseFrameSender | undefined
let observed: { primary: ResolvedTarget; notices: Array<{ title: string; level: string }> } | undefined
let patchRequests: Array<{ url: string; method: string; body: { tags?: string[] } }> = []

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

let conversations: ConversationSummary[] = []

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
          bootId: 'test-boot',
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
    if (/^\/api\/conversations\/\d+$/.test(url) && method === 'PATCH') {
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as { tags?: string[] })
      patchRequests.push({ url, method, body })
      const id = Number(/\/api\/conversations\/(\d+)$/.exec(url)![1])
      // 服务端语义：PATCH 后广播 conversation.upsert（带新 tags），前端列表随 SSE 更新。
      const updated = { ...conversations.find((c) => c.id === id)!, ...body } as ConversationSummary
      sendEvent?.(eventFrame(2, { type: 'conversation.upsert', conversation: updated }))
      return new Response(JSON.stringify(updated), { status: 200, headers: { 'content-type': 'application/json' } })
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
  observed = {
    primary: store.primaryTarget,
    notices: store.notices.map((n) => ({ title: n.title, level: n.level })),
  }
  return e(React.Fragment, null,
    store.primaryTarget.kind === 'conversation'
      ? e(ConversationPane, { key: `primary:${store.primaryTarget.conversationId}`, conversationId: store.primaryTarget.conversationId })
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

async function openMenu(): Promise<void> {
  const menuButton = document.querySelector<HTMLButtonElement>('.pane-more-menu button[aria-label="More conversation actions"]')
  assert.ok(menuButton, '会话窗格应有更多操作按钮')
  await act(async () => {
    menuButton.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
  })
}

async function clickMenuItem(label: string): Promise<void> {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((el) => el.textContent?.includes(label))
  assert.ok(item, `菜单中应显示「${label}」`)
  await act(async () => { item.click() })
  await settle()
}

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  sendEvent = undefined
  observed = undefined
  patchRequests = []
})

test('明细菜单归档：PATCH 保留原 tags 并追加 helm:archived，无导航回退，成功后可恢复', { timeout: 60_000 }, async () => {
  conversations = [summary(1, { tags: ['important'] })]
  await mount('#/c/1')
  await openMenu()
  await clickMenuItem('Archive conversation')
  assert.deepEqual(patchRequests, [
    { url: '/api/conversations/1', method: 'PATCH', body: { tags: ['important', ARCHIVED_TAG] } },
  ])
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 }, '归档不删除会话，主屏目标保持')
  assert.ok(observed?.notices.some((n) => n.title === 'Conversations archived'), '归档成功应有通知')
  // SSE upsert 到达后菜单动作切换为恢复
  await openMenu()
  await clickMenuItem('Restore conversation')
  assert.deepEqual(patchRequests[1], { url: '/api/conversations/1', method: 'PATCH', body: { tags: ['important'] } })
  assert.ok(observed?.notices.some((n) => n.title === 'Conversations restored'), '恢复成功应有通知')
})

test('明细菜单归档资格：bot 托管与子代理派生会话不渲染归档项', { timeout: 60_000 }, async () => {
  conversations = [
    summary(1, { ownedBy: 'bot' }),
    summary(2, { parentConversationId: 1 }),
  ]
  await mount('#/c/1')
  await openMenu()
  const archiveItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((el) => el.textContent?.includes('Archive conversation'))
  assert.ok(archiveItem === undefined, 'bot 托管会话不得提供归档入口')

  window.history.replaceState(null, '', '#/c/2')
  await act(async () => {
    root?.render(e(HelmStoreProvider, null, e(App)))
  })
  await settle()
  await openMenu()
  const derivedItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((el) => el.textContent?.includes('Archive conversation'))
  assert.ok(derivedItem === undefined, '子代理派生会话不得提供归档入口')
})

test('明细「更多操作」菜单为非模态：打开后点击外部会话按钮一次即关闭菜单并切换，且不抢回焦点', { timeout: 60_000 }, async () => {
  conversations = [summary(1), summary(2)]
  await mount('#/c/1')

  const outsideBtn = document.createElement('button')
  outsideBtn.type = 'button'
  outsideBtn.textContent = '切换到会话 2'
  let outsideClickCount = 0
  outsideBtn.addEventListener('click', () => {
    outsideClickCount += 1
    outsideBtn.focus()
  })
  document.body.appendChild(outsideBtn)

  await openMenu()
  assert.ok(document.querySelector('[role="menu"]'), '更多操作菜单已打开')
  assert.notEqual(document.body.style.pointerEvents, 'none', '不得禁用 body pointer-events 吞掉外部首次点击')

  const menuTrigger = document.querySelector<HTMLButtonElement>('.pane-more-menu button[aria-label="More conversation actions"]')!
  await act(async () => {
    outsideBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    outsideBtn.click()
  })
  await settle()

  assert.equal(outsideClickCount, 1, '外部按钮首次点击立即生效')
  assert.ok(document.querySelector('[role="menu"]') === null, '菜单已自动关闭')
  assert.ok(document.activeElement !== menuTrigger, '外部交互关闭菜单后不得把焦点抢回原触发按钮')
  outsideBtn.remove()
})
