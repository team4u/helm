/**
 * 会话明细顶栏「更多操作」菜单的归档/恢复交互测试（真实 DOM + 真实 Provider）：
 * - 人类自有根会话：菜单显示「归档会话」，点击发送 tags PATCH（保留原 tags、
 *   幂等追加 helm:archived）；被归档的正是当前主屏目标时，SSE conversation.upsert
 *   迁移以 replace 跳到该智能体待命页（新建会话页，继承节点/目录）；
 * - 分屏目标被归档：分屏原地替换为待命页（与「新话题」分屏语义一致），主屏不动；
 * - 抽屉会话被归档：归档不删除会话，抽屉与主屏均不动；
 * - 归档非当前打开会话、恢复会话、迟到迁移事件（用户已切走）：一律不导航；
 * - 已归档会话：菜单切换为「恢复会话」，PATCH 移除 helm:archived 且保留其他 tags；
 * - bot/helm 托管会话与子代理派生会话：菜单不渲染归档项（无归档资格）；
 * - SSE conversation.upsert 推送新 tags 后，菜单动作随最新归档态切换。
 *
 * 侧栏「已归档」折叠组不自动展开的断言位于 background-activity.test.ts（侧栏域
 * renderSidebar 基座）：happy-dom 下本文件若同时引用侧栏组件模块，Radix 菜单
 * 内容的挂载会失效，故按域分置。
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
let observed: { primary: ResolvedTarget; split: ResolvedTarget | null; notices: Array<{ title: string; level: string }> } | undefined
let navigateTo: ((target: ResolvedTarget) => void) | undefined
let patchRequests: Array<{ url: string; method: string; body: { tags?: string[] } }> = []
/** holdPatch=true 时 PATCH 挂起不回包也不广播，供「迟到迁移」测试手动放行。 */
let holdPatch = false
let pendingPatches: Array<{ complete(): void }> = []
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

let conversations: ConversationSummary[] = []
let eventSeq = 2

function eventFrame(event: unknown): Uint8Array {
  const seq = eventSeq++
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
      const respond = (): Response =>
        new Response(JSON.stringify(updated), { status: 200, headers: { 'content-type': 'application/json' } })
      if (!holdPatch) {
        sendEvent?.(eventFrame({ type: 'conversation.upsert', conversation: updated }))
        return respond()
      }
      return await new Promise<Response>((resolve) => {
        pendingPatches.push({
          complete() {
            sendEvent?.(eventFrame({ type: 'conversation.upsert', conversation: updated }))
            resolve(respond())
          },
        })
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
  observed = {
    primary: store.primaryTarget,
    split: store.splitTarget,
    notices: store.notices.map((n) => ({ title: n.title, level: n.level })),
  }
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
  // 折叠组仅随专用用例挂载：它不参与菜单交互断言，归档迁移经 SSE 推送驱动。
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

async function openMenu(paneIndex = 0): Promise<void> {
  const menuButtons = [...document.querySelectorAll<HTMLButtonElement>('.pane-more-menu button[aria-label="More conversation actions"]')]
  assert.ok(menuButtons[paneIndex], `第 ${paneIndex} 个会话窗格应有更多操作按钮`)
  await act(async () => {
    menuButtons[paneIndex]!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
  })
}

async function clickMenuItem(label: string): Promise<void> {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((el) => el.textContent?.includes(label))
  assert.ok(item, `菜单中应显示「${label}」`)
  await act(async () => { item.click() })
  await settle()
}

/** 直接经 SSE 推送会话事件（归档迁移等），绕开 UI 交互层。 */
async function pushConversationEvent(conversation: ConversationSummary): Promise<void> {
  await act(async () => {
    sendEvent?.(eventFrame({ type: 'conversation.upsert', conversation }))
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
  await settle()
}

/** 放行挂起的 PATCH（含 SSE 迁移广播）。 */
async function completePendingPatches(): Promise<void> {
  const pending = [...pendingPatches]
  pendingPatches = []
  await act(async () => {
    for (const request of pending) request.complete()
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
  await settle()
}

afterEach(() => {
  restoreHistorySpies()
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  sendEvent = undefined
  observed = undefined
  navigateTo = undefined
  patchRequests = []
  holdPatch = false
  pendingPatches = []
  historyLog = []
  eventSeq = 2
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

test('明细菜单归档当前主屏会话：PATCH 追加 helm:archived，replace 跳到待命页', { timeout: 60_000 }, async () => {
  spyHistory()
  conversations = [summary(1, { tags: ['important'] })]
  await mount('#/c/1')
  await openMenu()
  await clickMenuItem('Archive conversation')
  assert.deepEqual(patchRequests, [
    { url: '/api/conversations/1', method: 'PATCH', body: { tags: ['important', ARCHIVED_TAG] } },
  ])
  // 本机节点不显式携带（local 是缺省），工作目录照常继承
  assert.deepEqual(observed?.primary, { kind: 'agent', profileId: 'assistant', cwd: '/tmp' }, '归档当前会话应跳到该智能体待命页（新建会话页）')
  assert.ok(observed?.notices.some((n) => n.title === 'Conversations archived'), '归档成功应有通知')
  // 归档导航强制 replace：不污染前进/后退栈
  const last = historyLog[historyLog.length - 1]
  assert.ok(last, '归档后应有地址栏写回')
  assert.equal(last.method, 'replace')
  assert.equal(last.hash, `#/a/assistant?cwd=${encodeURIComponent('/tmp')}`)
  assert.equal(window.location.hash, `#/a/assistant?cwd=${encodeURIComponent('/tmp')}`)
})

test('明细菜单归档远端主屏会话：待命目标继承节点与目录，不悄悄切回本机', { timeout: 60_000 }, async () => {
  spyHistory()
  conversations = [summary(3, { nodeId: 'remote-node', cwd: '/remote/work' })]
  await mount('#/c/3')
  await openMenu()
  await clickMenuItem('Archive conversation')
  assert.deepEqual(observed?.primary, {
    kind: 'agent',
    profileId: 'assistant',
    nodeId: 'remote-node',
    cwd: '/remote/work',
  })
  assert.equal(window.location.hash, `#/a/assistant?node=remote-node&cwd=${encodeURIComponent('/remote/work')}`)
})

test('归档分屏目标：分屏原地替换为待命页，主屏会话保持不变', { timeout: 60_000 }, async () => {
  conversations = [summary(1), summary(2)]
  await mount('#/c/1?split=c/2')
  await openMenu(1)
  await clickMenuItem('Archive conversation')
  assert.equal(patchRequests[0]?.url, '/api/conversations/2')
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 })
  assert.deepEqual(observed?.split, { kind: 'agent', profileId: 'assistant', cwd: '/tmp' }, '分屏应原地变为待命页而非收起')
})

test('归档抽屉会话：会话仍可查看，抽屉与主屏均不动', { timeout: 60_000 }, async () => {
  conversations = [summary(1), summary(2)]
  await mount('#/c/1?modal=drawer&id=2')
  await openMenu(1)
  await clickMenuItem('Archive conversation')
  assert.equal(patchRequests[0]?.url, '/api/conversations/2')
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 })
  // 抽屉保持打开（App 仍渲染 drawer pane 才有第二个菜单按钮可再开）
  await openMenu(1)
  const restoreItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((el) => el.textContent?.includes('Restore conversation'))
  assert.ok(restoreItem, '抽屉内菜单应随 SSE 迁移切换为恢复动作')
})

test('恢复已归档会话不导航：主屏目标保持当前会话', { timeout: 60_000 }, async () => {
  conversations = [summary(1, { tags: ['important', ARCHIVED_TAG] })]
  await mount('#/c/1')
  await openMenu()
  await clickMenuItem('Restore conversation')
  assert.deepEqual(patchRequests, [
    { url: '/api/conversations/1', method: 'PATCH', body: { tags: ['important'] } },
  ])
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 }, '恢复不触发任何导航')
  assert.ok(observed?.notices.some((n) => n.title === 'Conversations restored'), '恢复成功应有通知')
})

test('SSE 推送归档非当前打开会话：仅列表更新，不导航', { timeout: 60_000 }, async () => {
  conversations = [summary(1), summary(2)]
  await mount('#/c/1')
  await pushConversationEvent(summary(2, { tags: [ARCHIVED_TAG] }))
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 })
})

test('无 tags 迁移的常规 upsert（如改标题）不触发归档导航', { timeout: 60_000 }, async () => {
  conversations = [summary(1)]
  await mount('#/c/1')
  await pushConversationEvent(summary(1, { title: '改名后' }))
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 })
})

test('归档请求在途时用户切换会话，迟到的迁移事件不覆盖新导航', { timeout: 60_000 }, async () => {
  conversations = [summary(1), summary(2)]
  holdPatch = true
  await mount('#/c/1')
  await openMenu()
  await clickMenuItem('Archive conversation')
  await act(async () => {
    navigateTo?.({ kind: 'conversation', conversationId: 2 })
  })
  await settle()
  await completePendingPatches()
  assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 2 }, '迟到迁移不得覆盖用户的新导航')
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
