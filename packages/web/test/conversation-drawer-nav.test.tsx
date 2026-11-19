import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary } from '@helmx/protocol'
import { hangingEventStream } from './helpers/sse-stream.js'
import type { ResolvedTarget, ActiveModal } from '../src/lib/types.js'

/**
 * 子会话抽屉（conversation-drawer）导航闭环回归：
 * - 全站不再渲染祖先回退按钮（抽屉/主屏/分屏顶栏均无面包屑）；
 * - 普通关闭与浏览器后退只关抽屉，工作台保留。
 */
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const { ConversationDrawer } = await import('../src/conversation/ConversationDrawer.js')
const { HelmxStoreProvider } = await import('../src/lib/HelmxStoreProvider.js')
const { useHelmxStore } = await import('../src/lib/store-context.js')
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

function summary(id: number, parentConversationId?: number, title = `会话 ${id}`): ConversationSummary {
  return {
    id,
    title,
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

interface FetchFixture {
  list?: ConversationSummary[]
  detailMap?: Record<number, ConversationSummary>
}

function installFetch(fixture: FetchFixture = {}): void {
  const list = fixture.list ?? conversations
  const detailMap = fixture.detailMap ?? {}
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
          conversations: list,
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
      const found = detailMap[id] ?? list.find((item) => item.id === id)
      return new Response(JSON.stringify({ ...(found ?? summary(id)), entries: [] }), { status: 200 })
    }
    if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

function App(): React.ReactNode {
  const store = useHelmxStore()
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
    e('div', { className: 'helmx-panes' },
      primary !== null
        ? e(ConversationPane, { key: `primary:${primary.conversationId}`, conversationId: primary.conversationId })
        : null,
      split !== null
        ? e('div', { className: 'helmx-split-pane' },
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

async function mount(hash: string, fixture?: FetchFixture): Promise<void> {
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch(fixture)
  await act(async () => {
    root = createRoot(host!)
    root.render(e(HelmxStoreProvider, null, e(App)))
  })
  await settle()
}

function ancestorButtons(scope: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`${scope} .pane-parent-nav-btn`)]
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

test('全站不再渲染祖先回退按钮：抽屉/主屏/分屏顶栏均无面包屑', { timeout: 60_000 }, async () => {
  await mount('#/c/999?split=c/111&wb=artifacts&modal=drawer&id=111')
  assert.equal(observed?.primary.kind === 'conversation' ? observed.primary.conversationId : undefined, 999)
  assert.deepEqual(observed?.split, { kind: 'conversation', conversationId: 111 })
  assert.equal(observed?.modal?.kind, 'conversation-drawer')
  assert.ok(observed?.workbenchOpen)
  // 抽屉（子会话 #111）、主屏（根 #999）、分屏（子会话 #111）均不渲染祖先回退按钮
  assert.equal(ancestorButtons('.conversation-drawer').length, 0, '抽屉不应渲染祖先回退按钮')
  assert.equal(ancestorButtons('.helmx-panes > .helmx-pane').length, 0, '主屏不应渲染祖先回退按钮')
  assert.equal(ancestorButtons('.helmx-split-pane').length, 0, '分屏不应渲染祖先回退按钮')
  assert.ok(document.querySelector('.conversation-drawer .conversation-drawer-close-btn'), '抽屉仍有关闭按钮')
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

test('抽屉标题与 aria-label 展示有意义的会话标题，占位标题与空白回退默认文案', { timeout: 60_000 }, async () => {
  await mount('#/c/1?modal=drawer&id=11', {
    list: [summary(1), summary(11, 1, '排查构建失败')],
  })
  const drawerDialog = document.querySelector('.conversation-drawer')
  assert.ok(drawerDialog, '应渲染抽屉 dialog')
  assert.equal(
    drawerDialog!.getAttribute('aria-label'),
    'Child conversation #11 · 排查构建失败 drawer',
    '有意义标题应带入抽屉 aria-label',
  )
  assert.equal(
    drawerDialog!.querySelector('h2')?.textContent,
    'Child conversation #11 · 排查构建失败 drawer',
    'DialogTitle 应包含会话标题',
  )

  reset()
  for (const [id, placeholder] of [
    [12, 'subagent 12'],
    [13, '子代理 13'],
    [14, '子会话 14'],
    [15, '   '],
  ] as const) {
    await mount(`#/c/1?modal=drawer&id=${id}`, {
      list: [summary(1), summary(id, 1, placeholder)],
    })
    const dlg = document.querySelector('.conversation-drawer')
    assert.ok(dlg, `应渲染占位测试 #${id} 抽屉`)
    assert.equal(
      dlg!.getAttribute('aria-label'),
      `Child conversation #${id} drawer`,
      `占位标题 "${placeholder}" 应回退默认抽屉标题`,
    )
    assert.equal(
      dlg!.querySelector('h2')?.textContent,
      `Child conversation #${id} drawer`,
      `DialogTitle 对占位标题 "${placeholder}" 应回退默认文案`,
    )
    reset()
  }

  // 不在摘要列表时回退 detail 标题
  await mount('#/c/1?modal=drawer&id=20', {
    list: [summary(1)],
    detailMap: { 20: summary(20, 1, '详情兜底标题') },
  })
  const fallbackDlg = document.querySelector('.conversation-drawer')
  assert.ok(fallbackDlg, '应渲染 detail 回退抽屉')
  assert.equal(
    fallbackDlg!.getAttribute('aria-label'),
    'Child conversation #20 · 详情兜底标题 drawer',
    '摘要缺失时应使用 detail 标题',
  )
})
