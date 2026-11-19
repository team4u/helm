import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationSummary } from '@helmx/protocol'
import { hangingEventStream, type SseFrameSender } from './helpers/sse-stream.js'
import { typeIntoControl } from './helpers/dom-harness.js'
import type { ResolvedTarget } from '../src/lib/types.js'

/**
 * 会话窗口保活（primary 槽位 Activity 缓存）聚焦测试：
 * - A→B→A 的时间线滚动容器 DOM 实例与阅读位置保留（含模拟真实浏览器 display:none
 *   丢弃 scrollTop 后的唤醒恢复）、Composer 草稿保留；
 * - 超过缓存上限后 LRU 淘汰最旧窗口（真实卸载），重新打开为全新实例；
 * - StrictMode 双挂载下同样成立；
 * - 切到非 conversation 目标再返回不丢窗口；
 * - split 面板与 primary 窗口池不串实例；
 * - Activity 隐藏期间 Composer 草稿脏状态经窗口帧桥接保持（版本自动刷新挂起判定不失真），
 *   窗口被淘汰后脏报告清空。
 */
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const { ConversationWindowStage } = await import('../src/conversation/ConversationWindowStage.js')
const { HelmxStoreProvider } = await import('../src/lib/HelmxStoreProvider.js')
const { useHelmxStore } = await import('../src/lib/store-context.js')
const { composerDirty } = await import('../src/conversation/composer-dirty.js')
const { App: HelmxApp } = await import('../src/App.js')
const e = React.createElement
const originalFetch = globalThis.fetch

let root: Root | undefined
let host: HTMLElement | undefined
let sendEvent: SseFrameSender | undefined
let navigateTo: ((target: ResolvedTarget, opts?: { split?: boolean }) => void) | undefined
const detailFetchLog: number[] = []
let detailEntriesOverride: Record<number, ConversationEntry[]> = {}

function summary(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `keepalive-c${id}`,
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

const conversations = [summary(1), summary(2), summary(3), summary(4)]

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
    const detailMatch = /^\/api\/conversations\/(\d+)/.exec(url)
    if (detailMatch && method === 'GET') {
      const conversationId = Number(detailMatch[1])
      detailFetchLog.push(conversationId)
      const found = conversations.find((item) => item.id === conversationId)
      return new Response(JSON.stringify({ ...(found ?? summary(conversationId)), entries: detailEntriesOverride[conversationId] ?? [] }), { status: 200 })
    }
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

function Harness({ limit }: { limit?: number }) {
  const store = useHelmxStore()
  navigateTo = (target, opts) => store.openTarget(target, opts)
  const activeConversationId = store.primaryTarget.kind === 'conversation' ? store.primaryTarget.conversationId : null
  return e(React.Fragment, null,
    e('div', { className: 'helmx-primary-pane' },
      e(ConversationWindowStage, { activeConversationId, ...(limit !== undefined ? { limit } : {}) })),
    store.splitTarget !== null && store.splitTarget.kind === 'conversation'
      ? e('div', { className: 'helmx-split-pane' },
          e(ConversationPane, {
            key: `split-conv-${store.splitTarget.conversationId}`,
            conversationId: store.splitTarget.conversationId,
            isSplit: true,
            onCloseSplit: store.closeSplit,
          }))
      : null,
  )
}

async function mount(hash: string, options: { strictMode?: boolean; limit?: number } = {}): Promise<void> {
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch()
  const tree = e(Harness, options.limit !== undefined ? { limit: options.limit } : {})
  const wrapped = e(HelmxStoreProvider, null, options.strictMode === true ? e(React.StrictMode, null, tree) : tree)
  await act(async () => {
    root = createRoot(host!)
    root.render(wrapped)
  })
  await settle()
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
}

function findPane(conversationId: number): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('.helmx-pane')].find(
    (pane) => pane.querySelector('.pane-title-btn')?.textContent?.includes(`keepalive-c${conversationId}`) === true,
  ) ?? null
}

function paneScroller(pane: HTMLElement): HTMLElement {
  const scroller = pane.querySelector<HTMLElement>('.timeline-scroll')
  assert.ok(scroller, '会话窗格应有 .timeline-scroll 滚动容器')
  return scroller
}

function paneTextarea(pane: HTMLElement): HTMLTextAreaElement {
  const textarea = pane.querySelector<HTMLTextAreaElement>('textarea')
  assert.ok(textarea, '会话窗格应有 Composer 输入框')
  return textarea
}

/** happy-dom 不做布局：给定固定滚动几何，并模拟真实浏览器隐藏后 scrollTop 被丢弃。 */
function defineScrollerMetrics(scroller: HTMLElement, scrollHeight = 1000, clientHeight = 400): void {
  Object.defineProperty(scroller, 'scrollHeight', { get: () => scrollHeight, configurable: true })
  Object.defineProperty(scroller, 'clientHeight', { get: () => clientHeight, configurable: true })
}

/** 模拟用户上滑离开底部：方向键释放贴底（含初始贴底窗口），再写入滚动位置并派发 scroll。 */
function scrollUpTo(scroller: HTMLElement, top: number): void {
  act(() => {
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
  })
}

function stageElement(): HTMLElement {
  const stage = document.querySelector<HTMLElement>('.conversation-window-stage')
  assert.ok(stage, '应渲染会话窗口保活舞台')
  return stage
}

function windowCount(): number {
  return Number(stageElement().getAttribute('data-conversation-windows'))
}

async function openConversation(conversationId: number): Promise<void> {
  assert.ok(navigateTo)
  await act(async () => {
    navigateTo!({ kind: 'conversation', conversationId })
  })
  await settle()
}

async function mountRealApp(hash: string): Promise<void> {
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch()
  await act(async () => {
    root = createRoot(host!)
    root.render(e(HelmxApp))
  })
  await settle()
}

/** 经真实 App 的 hash 导航（hashchange -> applyExternalLocation 单一写回边界）驱动主屏切换。 */
async function navigateHash(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash
    window.dispatchEvent(new Event('hashchange'))
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
  navigateTo = undefined
  detailEntriesOverride = {}
}

function eventFrame(seq: number, event: unknown): Uint8Array {
  return new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ seq, event })}\n\n`)
}

afterEach(() => {
  reset()
})

test('keeps timeline scroller instance, reading offset and composer draft across A -> B -> A', { timeout: 60_000 }, async () => {
  await mount('#/c/1')
  const paneA = findPane(1)
  assert.ok(paneA)
  const scrollerA = paneScroller(paneA)
  defineScrollerMetrics(scrollerA)
  scrollUpTo(scrollerA, 300)
  assert.ok(scrollerA.scrollTop === 300, '上滑后应停在 300')

  const textareaA = paneTextarea(paneA)
  await act(async () => { typeIntoControl(textareaA, 'keep-alive draft') })
  assert.ok(textareaA.value === 'keep-alive draft')
  assert.ok(composerDirty() === true, '草稿存在时版本刷新挂起判定应为脏')
  const detailFetchesForABefore = detailFetchLog.filter((id) => id === 1).length

  await openConversation(2)
  assert.ok(paneA.style.display === 'none', '切走后 A 窗口应被 Activity 隐藏（display:none）')
  assert.ok(windowCount() === 2, '舞台应缓存 A 与 B 两个窗口')
  assert.ok(findPane(2) !== null && findPane(2)!.style.display !== 'none', 'B 窗口应可见')
  assert.ok(composerDirty() === true, '隐藏期间脏草稿应经窗口帧桥接保持')

  // 模拟真实浏览器行为：display:none 子树的 scrollTop 被丢弃为 0。
  scrollerA.scrollTop = 0

  await openConversation(1)
  const paneAAgain = findPane(1)
  assert.ok(paneAAgain === paneA, 'A 窗口 DOM 实例应保留（Activity 未卸载）')
  const scrollerAAgain = paneScroller(paneA)
  assert.ok(scrollerAAgain === scrollerA, '时间线滚动容器 DOM 实例应保留')
  assert.ok(scrollerA.scrollTop === 300, '唤醒应在 paint 前恢复阅读位置 300，而不是重置贴底')
  assert.ok(paneA.style.display !== 'none', '唤醒后 A 窗口应可见')
  const textareaAAgain = paneTextarea(paneA)
  assert.ok(textareaAAgain === textareaA, 'Composer 输入框 DOM 实例应保留')
  assert.ok(textareaA.value === 'keep-alive draft', 'Composer 草稿应保留')

  const detailFetchesForAAfter = detailFetchLog.filter((id) => id === 1).length
  assert.ok(detailFetchesForAAfter > detailFetchesForABefore, '唤醒应静默刷新会话详情（隐藏窗口不在可见集内）')

  await act(async () => { typeIntoControl(textareaA, '') })
  assert.ok(composerDirty() === false, '清空草稿后脏判定应恢复干净')
})

test('evicts the least-recently-used window beyond the limit and reopens fresh', { timeout: 60_000 }, async () => {
  await mount('#/c/1', { limit: 2 })
  const paneA = findPane(1)
  assert.ok(paneA)
  const scrollerA = paneScroller(paneA)
  defineScrollerMetrics(scrollerA)
  scrollUpTo(scrollerA, 300)
  const textareaA = paneTextarea(paneA)
  await act(async () => { typeIntoControl(textareaA, 'doomed draft') })
  assert.ok(composerDirty() === true)

  await openConversation(2)
  await openConversation(3)
  assert.ok(windowCount() === 2, '上限 2 时舞台只保留 B 与 C')
  assert.ok(paneA.isConnected === false, '最旧的 A 窗口应被真实卸载')
  assert.ok(composerDirty() === false, '淘汰卸载后脏报告应清空')
  assert.ok(findPane(2) !== null && findPane(3) !== null, 'B 与 C 窗口仍在舞台上')

  await openConversation(1)
  const paneANew = findPane(1)
  assert.ok(paneANew !== null && paneANew !== paneA, '重新打开的 A 应是全新实例')
  const textareaANew = paneTextarea(paneANew!)
  assert.ok(textareaANew.value === '', '重新打开的 A 不应保留被淘汰实例的草稿')
  assert.ok(windowCount() === 2, '重开 A 后 LRU 淘汰 B，窗口数仍为 2')
})

test('StrictMode double-mount keeps window retention working', { timeout: 60_000 }, async () => {
  await mount('#/c/1', { strictMode: true })
  const paneA = findPane(1)
  assert.ok(paneA)
  const scrollerA = paneScroller(paneA)
  defineScrollerMetrics(scrollerA)
  scrollUpTo(scrollerA, 260)
  const textareaA = paneTextarea(paneA)
  await act(async () => { typeIntoControl(textareaA, 'strict draft') })

  await openConversation(2)
  scrollerA.scrollTop = 0
  await openConversation(1)
  assert.ok(findPane(1) === paneA, 'StrictMode 下 A 窗口实例仍应保留')
  assert.ok(scrollerA.scrollTop === 260, 'StrictMode 下唤醒仍应恢复阅读位置')
  assert.ok(textareaA.value === 'strict draft', 'StrictMode 下草稿仍应保留')
})

test('survives switching to a non-conversation target and back', { timeout: 60_000 }, async () => {
  await mount('#/c/1')
  const paneA = findPane(1)
  assert.ok(paneA)
  const scrollerA = paneScroller(paneA)
  defineScrollerMetrics(scrollerA)
  scrollUpTo(scrollerA, 320)
  const textareaA = paneTextarea(paneA)
  await act(async () => { typeIntoControl(textareaA, 'screen round-trip') })

  assert.ok(navigateTo)
  await act(async () => { navigateTo!({ kind: 'plugins' }) })
  await settle()
  const stage = stageElement()
  assert.ok(stage.classList.contains('is-idle'), '非会话主屏目标下舞台应折叠')
  assert.ok(windowCount() === 1, '窗口缓存应保留（不卸载）')
  assert.ok(stage.querySelector('.helmx-pane') !== null, '隐藏窗口仍在舞台内')
  assert.ok(findPane(1) === paneA, '非会话目标往返不应卸载 A 窗口')

  await openConversation(1)
  assert.ok(stageElement().classList.contains('is-idle') === false, '返回会话后舞台应恢复')
  assert.ok(scrollerA.scrollTop === 320, '返回后阅读位置应恢复')
  assert.ok(textareaA.value === 'screen round-trip', '返回后草稿应保留')
})

test('split pane instances stay separate from the primary window pool', { timeout: 60_000 }, async () => {
  await mount('#/c/1')
  const paneA = findPane(1)
  assert.ok(paneA)
  const scrollerA = paneScroller(paneA)
  defineScrollerMetrics(scrollerA)
  scrollUpTo(scrollerA, 280)

  assert.ok(navigateTo)
  await act(async () => { navigateTo!({ kind: 'conversation', conversationId: 2 }, { split: true }) })
  await settle()

  const splitHost = document.querySelector<HTMLElement>('.helmx-split-pane')
  assert.ok(splitHost, '分屏容器应渲染')
  const paneSplit = splitHost!.querySelector<HTMLElement>('.helmx-pane')
  assert.ok(paneSplit, '分屏会话窗格应渲染')
  assert.ok(paneSplit!.closest('.conversation-window-stage') === null, '分屏窗格不属于 primary 窗口池')
  assert.ok(windowCount() === 1, '分屏会话不进入 primary 窗口池')
  assert.ok(paneA.style.display !== 'none', 'primary A 窗口仍可见')
  assert.ok(scrollerA.scrollTop === 280, '分屏打开不影响 primary 阅读位置')
  assert.ok(paneSplit!.querySelector('.timeline-scroll') !== scrollerA, '分屏与 primary 不共享滚动容器实例')

  await openConversation(3)
  assert.ok(splitHost!.querySelector('.helmx-pane') === paneSplit, 'primary 切换不影响分屏窗格实例')
  assert.ok(scrollerA.scrollTop === 280, 'primary 切换后 A 缓存窗口阅读位置不变')
  assert.ok(findPane(3) !== null, 'primary 已切换到 C 窗口')
})

test('deleting a hidden conversation prunes its kept-alive window and dirty report', { timeout: 60_000 }, async () => {
  await mount('#/c/1')
  const paneA = findPane(1)
  assert.ok(paneA)
  const textareaA = paneTextarea(paneA)
  await act(async () => { typeIntoControl(textareaA, 'hidden doomed draft') })

  await openConversation(2)
  assert.ok(paneA.isConnected === true, '隐藏窗口在删除前仍在缓存中')
  assert.ok(composerDirty() === true)

  assert.ok(sendEvent)
  await act(async () => {
    sendEvent!(eventFrame(2, { type: 'conversation.deleted', conversationId: 1 }))
  })
  await settle()
  assert.ok(!paneA.isConnected, '会话删除后其隐藏窗口应被卸载')
  const dirtyAfterDelete = composerDirty()
  assert.ok(dirtyAfterDelete === false, '删除清理后脏报告应清空')
  assert.ok(windowCount() === 1, '窗口池只剩 B')
})

test('logout live-state reset clears the whole window pool and dirty reports', { timeout: 60_000 }, async () => {
  await mount('#/c/1')
  const paneA = findPane(1)
  assert.ok(paneA)
  const textareaA = paneTextarea(paneA)
  await act(async () => { typeIntoControl(textareaA, 'logout draft') })
  await openConversation(2)
  assert.ok(windowCount() === 2)
  assert.ok(composerDirty() === true)

  // 登出走 store 的单一重置管道（helmx:unauthorized / 用户登出共用），live 被清空为空列表。
  await act(async () => {
    window.dispatchEvent(new Event('helmx:unauthorized'))
  })
  await settle()
  assert.ok(windowCount() === 0, '登出清空 live 后窗口池应整体卸载')
  assert.ok(paneA.isConnected === false, '隐藏窗口不应残留内存')
  assert.ok(composerDirty() === false, '登出后脏报告应清空')
})

test('typing then switching in the same tick keeps the dirty guard (render-phase sink mirror)', { timeout: 60_000 }, async () => {
  await mount('#/c/1')
  const paneA = findPane(1)
  assert.ok(paneA)
  const textareaA = paneTextarea(paneA)

  assert.ok(navigateTo)
  await act(async () => {
    typeIntoControl(textareaA, 'instant switch')
    navigateTo!({ kind: 'conversation', conversationId: 2 })
  })
  await settle()
  assert.ok(composerDirty() === true, '同拍切换也应经渲染期镜像保住脏判定')

  await openConversation(1)
  assert.ok(textareaA.value === 'instant switch', '同拍切换不丢草稿')
})

test('real App shell keeps conversation windows alive across hash navigation', { timeout: 60_000 }, async () => {
  await mountRealApp('#/c/1')
  const paneA = findPane(1)
  assert.ok(paneA)
  const scrollerA = paneScroller(paneA)
  defineScrollerMetrics(scrollerA)
  scrollUpTo(scrollerA, 240)

  await navigateHash('#/c/2')
  assert.ok(paneA.style.display === 'none', '真实 App 中切走后 A 窗口应隐藏')
  scrollerA.scrollTop = 0
  await navigateHash('#/c/1')
  assert.ok(findPane(1) === paneA, '真实 App 中 A 窗口实例应保留')
  assert.ok(scrollerA.scrollTop === 240, '真实 App hash 往返后阅读位置应恢复')

  await navigateHash('#/settings/plugins')
  assert.ok(stageElement().classList.contains('is-idle'), '设置中心下舞台应折叠')
  await navigateHash('#/c/1')
  assert.ok(stageElement().classList.contains('is-idle') === false, '返回会话后舞台应恢复')
  assert.ok(scrollerA.scrollTop === 240, '设置中心往返后阅读位置应恢复')
})

test('consumed edit prefill does not resurrect in composer after sending or clearing across A -> B -> A', { timeout: 60_000 }, async () => {
  detailEntriesOverride = {
    1: [{ id: '42', kind: 'helmx.input', data: { text: 'steer message', origin: 'human' } }],
  }
  await mount('#/c/1')
  const paneA = findPane(1)
  assert.ok(paneA)
  const textareaA = paneTextarea(paneA)
  const editButton = (): HTMLButtonElement => {
    const btn = paneA.querySelector<HTMLButtonElement>('button[title="Edit and resend"]')
    assert.ok(btn, '应渲染 Edit and resend 按钮')
    return btn
  }

  // 1. Trigger prefill -> send -> switch A -> B -> A -> textarea must stay empty.
  await act(async () => { editButton().click() })
  await settle()
  assert.equal(textareaA.value, 'steer message', '点击编辑后应回填内容')
  assert.ok(paneA.querySelector('.composer-edit-banner') !== null, '应进入历史编辑态')

  const sendButton = paneA.querySelector<HTMLButtonElement>('.btn-send')
  assert.ok(sendButton)
  await act(async () => { sendButton.click() })
  await settle()
  assert.equal(textareaA.value, '', '发送后输入框应清空')

  await openConversation(2)
  await openConversation(1)
  assert.equal(textareaA.value, '', '切走再切回后，已发送的 prefill 不得复活到输入框')
  assert.ok(paneA.querySelector('.composer-edit-banner') === null, '切走再切回后不应复活编辑横幅')

  // 2. Trigger prefill again -> manually clear -> switch A -> B -> A -> textarea must stay empty.
  await act(async () => { editButton().click() })
  await settle()
  assert.equal(textareaA.value, 'steer message', '再次点击编辑仍可正常回填')
  await act(async () => { typeIntoControl(textareaA, '') })
  assert.equal(textareaA.value, '', '手工清空输入框')

  await openConversation(2)
  await openConversation(1)
  assert.equal(textareaA.value, '', '手工清空后切走再切回，旧 prefill 仍不得重复出现')
})

test('in-progress history edit mode survives A -> B -> A Activity wake', { timeout: 60_000 }, async () => {
  detailEntriesOverride = {
    1: [{ id: '42', kind: 'helmx.input', data: { text: 'pending edit', origin: 'human' } }],
  }
  await mount('#/c/1')
  const paneA = findPane(1)
  assert.ok(paneA)
  const textareaA = paneTextarea(paneA)
  const editButton = paneA.querySelector<HTMLButtonElement>('button[title="Edit and resend"]')
  assert.ok(editButton)

  await act(async () => { editButton.click() })
  await settle()
  assert.equal(textareaA.value, 'pending edit')
  assert.ok(paneA.querySelector('.composer-edit-banner') !== null, '进入历史编辑态')

  await openConversation(2)
  await openConversation(1)
  assert.equal(textareaA.value, 'pending edit', '唤醒后编辑草稿应保留')
  assert.ok(paneA.querySelector('.composer-edit-banner') !== null, '唤醒后历史编辑态横幅应保留')
})

test('hidden window clears busy dirty state immediately when in-flight send finishes in the background', { timeout: 60_000 }, async () => {
  let resolveSubmit!: () => void
  let rejectSubmit!: (err: Error) => void
  let submitAttempt = 0
  await mount('#/c/1')
  const baseFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/conversations/1/input' && init?.method === 'POST') {
      submitAttempt += 1
      if (submitAttempt === 1) {
        await new Promise<void>((resolve) => {
          resolveSubmit = resolve
        })
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      await new Promise<void>((_, reject) => {
        rejectSubmit = reject
      })
    }
    return baseFetch(input, init)
  }) as typeof fetch

  const paneA = findPane(1)
  assert.ok(paneA)
  const textareaA = paneTextarea(paneA)
  const sendBtnA = paneA.querySelector<HTMLButtonElement>('.btn-send')
  assert.ok(sendBtnA)

  // 1. Send succeeds while conversation 1 is hidden -> busy guard must clear without revisiting conv 1.
  await act(async () => { typeIntoControl(textareaA, 'in-flight ok') })
  await act(async () => { sendBtnA.click() })
  await openConversation(2)
  assert.equal(composerDirty(), true, '发送在途切走期间应保持挂起保护')

  await act(async () => {
    resolveSubmit()
    await Promise.resolve()
  })
  await settle()
  assert.equal(composerDirty(), false, '后台发送完成后无需切回原会话，脏判定应自动解除')

  // 2. Send fails while conversation 1 is hidden -> restored draft must keep dirty guard active.
  await openConversation(1)
  await act(async () => { typeIntoControl(textareaA, 'in-flight fail') })
  await act(async () => { sendBtnA.click() })
  await openConversation(2)
  assert.equal(composerDirty(), true)

  await act(async () => {
    rejectSubmit(new Error('network timeout'))
    await Promise.resolve()
  })
  await settle()
  assert.equal(composerDirty(), true, '后台发送失败回滚草稿后，仍应保持脏保护不丢失草稿')
})
