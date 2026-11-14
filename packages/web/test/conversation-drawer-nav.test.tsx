import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary } from '@helm/protocol'
import { hangingEventStream } from './helpers/sse-stream.js'
import type { ResolvedTarget, ActiveModal } from '../src/lib/types.js'

/**
 * 子会话抽屉（conversation-drawer）与祖先面包屑导航闭环回归：
 * - 任意深度祖先链渲染（根在前）；
 * - 抽屉内点祖先：祖先在主屏/分屏时只收抽屉、不动主屏；否则抽屉原位切换祖先、不顶掉主屏；
 * - 主屏/分屏内点祖先：仅切换所在面板目标；
 * - 普通关闭与浏览器后退只关抽屉，工作台保留。
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

// 祖谱：1 ← 11 ← 111（两层派生）；999 为无关根会话。
const conversations = [summary(1), summary(11, 1), summary(111, 11), summary(999)]

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200 })
    }
    if (url === '/api/events') {
      return new Response(hangingEventStream((send) => {
        send(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({
          bootId: 'test-boot',
          seq: 1,
          conversations,
          pendingAsks: [],
          plugins: [],
          ui: [],
        })}\n\n`))
      }, { signal: init?.signal }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
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
  const split = store.splitTarget?.kind === 'conversation' ? store.splitTarget : null
  return e(React.Fragment, null,
    e('div', { className: 'helm-panes' },
      primary !== null
        ? e(ConversationPane, { key: `primary:${primary.conversationId}`, conversationId: primary.conversationId })
        : null,
      split !== null
        ? e('div', { className: 'helm-split-pane' },
            e(ConversationPane, {
              key: `split:${split.conversationId}`,
              conversationId: split.conversationId,
              isSplit: true,
              onCloseSplit: () => store.closeSplit(),
            }))
        : null,
    ),
    store.activeModal?.kind === 'conversation-drawer'
      ? e(ConversationDrawer, {
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

function ancestorButtons(scope: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`${scope} .pane-parent-nav-btn`)]
    .filter((b) => (b.getAttribute('aria-label') ?? '').includes('前往祖先会话'))
}

async function clickAncestor(scope: string, ancestorId: number): Promise<void> {
  const btn = ancestorButtons(scope).find((b) => b.getAttribute('aria-label') === `前往祖先会话 #${ancestorId}`)
  assert.ok(btn, `${scope} 应渲染祖先 #${ancestorId} 面包屑按钮`)
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

test('抽屉内点击在主屏的祖先：仅收起抽屉，主屏与工作台不动', { timeout: 60_000 }, async () => {
  await mount('#/c/1?wb=artifacts&modal=drawer&id=111')
  assert.equal(observed?.primary.kind === 'conversation' ? observed.primary.conversationId : undefined, 1)
  assert.equal(observed?.modal?.kind, 'conversation-drawer')
  assert.ok(observed?.workbenchOpen)
  // 任意深度面包屑：#111 的祖先链应为 [#1, #11]（根在前）
  const labels = ancestorButtons('.conversation-drawer').map((b) => b.getAttribute('aria-label'))
  assert.deepEqual(labels, ['前往祖先会话 #1', '前往祖先会话 #11'], '抽屉应渲染完整祖先链（根在前）')
  await clickAncestor('.conversation-drawer', 1)
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 }, '主屏保持原会话 #1')
  assert.equal(observed?.modal, null, '祖先已在主屏：只收起抽屉')
  assert.equal(observed?.workbenchOpen, true, '工作台保留（有自己的关闭按钮，导航不动它）')
})

test('抽屉内点击不在屏祖先：抽屉原位切换到祖先，不顶掉主屏', { timeout: 60_000 }, async () => {
  await mount('#/c/999?modal=drawer&id=111')
  assert.equal(observed?.primary.kind === 'conversation' ? observed.primary.conversationId : undefined, 999)
  assert.equal(observed?.modal?.kind, 'conversation-drawer')
  await clickAncestor('.conversation-drawer', 1)
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 999 }, '主屏不被顶掉')
  assert.deepEqual(observed?.modal, { kind: 'conversation-drawer', conversationId: 1 }, '抽屉应原位切换到祖先 #1')
  // 抽屉内容确实切到根会话 #1：无祖先面包屑可再点
  assert.deepEqual(ancestorButtons('.conversation-drawer'), [], '根会话抽屉不再渲染祖先链')
})

test('抽屉内点击直接父级（不在屏）：同样原位切换抽屉', { timeout: 60_000 }, async () => {
  await mount('#/c/999?modal=drawer&id=111')
  await clickAncestor('.conversation-drawer', 11)
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 999 }, '主屏不动')
  assert.deepEqual(observed?.modal, { kind: 'conversation-drawer', conversationId: 11 }, '抽屉原位切换到父会话 #11')
  const labels = ancestorButtons('.conversation-drawer').map((b) => b.getAttribute('aria-label'))
  assert.deepEqual(labels, ['前往祖先会话 #1'], '切换后面包屑随新会话更新')
})

test('主屏会话点击祖先面包屑：主屏切换到祖先', { timeout: 60_000 }, async () => {
  await mount('#/c/111')
  assert.equal(observed?.modal, null)
  const labels = ancestorButtons('.helm-panes > .helm-pane').map((b) => b.getAttribute('aria-label'))
  assert.deepEqual(labels, ['前往祖先会话 #1', '前往祖先会话 #11'])
  await clickAncestor('.helm-panes > .helm-pane', 11)
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 11 }, '主屏应导航到祖先 #11')
})

test('分屏会话点击祖先面包屑：仅分屏切换，主屏不动', { timeout: 60_000 }, async () => {
  await mount('#/c/999?split=c/111')
  assert.deepEqual(observed?.split, { kind: 'conversation', conversationId: 111 })
  await clickAncestor('.helm-split-pane', 1)
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 999 }, '主屏不动')
  assert.deepEqual(observed?.split, { kind: 'conversation', conversationId: 1 }, '分屏应导航到祖先 #1')
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
