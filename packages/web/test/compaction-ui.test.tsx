/**
 * 上下文精简进行中反馈、Busy 排队控件与 `/compact <instructions>` 回归测试（真实 DOM 挂载 + 纯函数）：
 * - parseCompactSlashCommand 与 isSessionManageCommand 对 `/compact` 及附带指令的解析；
 * - ConversationTimeline 渲染 pending compaction 分割线（`正在精简上下文…` + `.spin-slow` loader）及与排队消息的顺序；
 * - Composer 在 `status='idle' && contextUsage.compacting=true` 下切入 busy 态（停止按钮、插话/排队控件、占位符与 `精简中…` 只读状态）；
 * - `/compact <instructions>` 透传 `instructions` 参数；`compacting=true` 时重复 `/compact` 提示进行中且不发请求；
 * - ConversationPane 顶栏「更多操作」菜单在精简中禁用并显示 `正在精简上下文…` + loader，且透传 pending 分割线。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationLive, ConversationSummary } from '@helm/protocol'
import { makeTestStore } from './helpers/store.js'
import { hangingEventStream } from './helpers/sse-stream.js'
import type { HelmStoreValue } from '../src/lib/types.js'
import {
  getComposerPlaceholder,
  isSessionManageCommand,
  parseCompactSlashCommand,
} from '../src/conversation/composer-model.js'

try {
  GlobalRegistrator.register()
} catch {
  // 已注册
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { HelmStoreProvider } = await import('../src/lib/HelmStoreProvider.js')
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')
const { Composer } = await import('../src/conversation/Composer.js')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')

const e = React.createElement
const originalFetch = globalThis.fetch
const savedResizeObserver = globalThis.ResizeObserver

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let activeRoots: Root[] = []
let activeHosts: HTMLElement[] = []

afterEach(() => {
  for (const r of activeRoots) {
    act(() => r.unmount())
  }
  activeRoots = []
  for (const h of activeHosts) {
    h.remove()
  }
  activeHosts = []
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = savedResizeObserver
})

function makeConversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 1,
    title: '会话 1',
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    cwd: '/tmp',
    model: 'faux/faux-1',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeNoticeStore(
  conversation: ConversationSummary,
  extra: Partial<HelmStoreValue> = {},
): HelmStoreValue & { notices: Array<{ type: string; level: string; title: string; body?: string; conversationId?: number }> } {
  const notices: Array<{ type: string; level: string; title: string; body?: string; conversationId?: number }> = []
  const store = makeTestStore({
    conversations: [conversation],
    conversationDetails: { [conversation.id]: { ...conversation, entries: [] } },
    pushNotice: (n) => {
      notices.push(n)
    },
    ...extra,
  })
  return Object.assign(store, { notices })
}

function typeInto(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const tracker = (ta as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(ta, text)
  tracker?.setValue(prev)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

interface CapturedRequest {
  method: string
  path: string
  body: Record<string, unknown>
}

function installApiStub(captured: CapturedRequest[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const method = String(init?.method ?? 'GET')
    const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    captured.push({ method, path, body })
    if (path.endsWith('/compact')) {
      return new Response(JSON.stringify({ ok: true, compacted: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ submissionId: 'sub-1' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

// ---------------------------------------------------------------------------
// 1. 纯函数：parseCompactSlashCommand & isSessionManageCommand
// ---------------------------------------------------------------------------

test('parseCompactSlashCommand 与 isSessionManageCommand：精确识别 /compact 与可选 instructions', { timeout: 60_000 }, () => {
  assert.deepEqual(parseCompactSlashCommand('/compact'), {})
  assert.deepEqual(parseCompactSlashCommand('/compact   '), {})
  assert.deepEqual(parseCompactSlashCommand('  /compact  '), {})
  assert.deepEqual(parseCompactSlashCommand('/compact 保留 API 契约'), { instructions: '保留 API 契约' })
  assert.deepEqual(parseCompactSlashCommand('/compact   focus on errors  '), { instructions: 'focus on errors' })
  assert.equal(parseCompactSlashCommand('/compactfoo'), null)
  assert.equal(parseCompactSlashCommand('/compaction'), null)
  assert.equal(parseCompactSlashCommand('please /compact'), null)
  assert.equal(parseCompactSlashCommand('/new'), null)

  assert.equal(isSessionManageCommand('/new'), true)
  assert.equal(isSessionManageCommand('/clear'), true)
  assert.equal(isSessionManageCommand('/compact'), true)
  assert.equal(isSessionManageCommand('/compact 保留关键决定'), true)
  assert.equal(isSessionManageCommand('/compactfoo'), false)
})

// ---------------------------------------------------------------------------
// 2. ConversationTimeline：pending compaction divider 渲染与指纹
// ---------------------------------------------------------------------------

test('ConversationTimeline：compacting=true 时渲染「正在精简上下文…」与旋转 loader，并排在排队消息前', { timeout: 60_000 }, async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
  const conversation = makeConversation({
    status: 'idle',
    contextUsage: { tokens: 50_000, contextWindow: 100_000, compacting: true },
  })
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { text: '先查一下日志', origin: 'human' } },
    { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '已查看' }] }] },
  ]
  const live: ConversationLive = {
    conversationId: conversation.id,
    text: '',
    tools: [],
    updatedAt: 10,
    queuedInputs: [
      { submissionId: '12', id: 'q-1', text: '精简完继续修改', mode: 'followUp', origin: 'human', createdAt: 11 },
    ],
  }
  const store = makeNoticeStore(conversation, {
    conversationDetails: { [conversation.id]: { ...conversation, entries } },
    conversationLives: { [conversation.id]: live },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  activeHosts.push(host)
  const root = createRoot(host)
  activeRoots.push(root)

  await act(async () => {
    root.render(
      e(
        HostStoreProviders,
        { value: store },
        e(ConversationTimeline, {
          conversation,
          detailEntries: entries,
          live,
          onRequestEdit: () => {},
        }),
      ),
    )
  })

  const dividerLabel = host.querySelector('.context-divider-label')
  assert.ok(dividerLabel !== null, '必须渲染上下文分割线标签')
  assert.match(dividerLabel.textContent ?? '', /Compacting context…/)
  assert.ok(dividerLabel.querySelector('svg.spin-slow') !== null, 'pending 分割线须渲染 spin-slow loader 图标')

  // DOM 顺序：分割线必须在排队中的人类消息之前
  const innerHtml = host.querySelector('.timeline-inner')?.innerHTML ?? ''
  const dividerPos = innerHtml.indexOf('Compacting context…')
  const queuedPos = innerHtml.indexOf('精简完继续修改')
  assert.ok(dividerPos >= 0 && queuedPos > dividerPos, 'pending 分割线应在排队消息之前渲染')
})

test('ConversationTimeline：contentFingerprint 包含 compacting 状态以维持贴底锚定', { timeout: 60_000 }, async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
  const timelineSrc = readFileSync(new URL('../src/conversation/ConversationTimeline.tsx', import.meta.url), 'utf8')
  assert.match(timelineSrc, /contextUsage\?\.compacting === true \? 1 : 0/)

  const baseConv = makeConversation({
    status: 'idle',
    contextUsage: { tokens: 50_000, contextWindow: 100_000, compacting: false },
  })
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { text: '你好', origin: 'human' } },
  ]
  const store = makeNoticeStore(baseConv, {
    conversationDetails: { [baseConv.id]: { ...baseConv, entries } },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  activeHosts.push(host)
  const root = createRoot(host)
  activeRoots.push(root)

  await act(async () => {
    root.render(
      e(HostStoreProviders, { value: store }, e(ConversationTimeline, { conversation: baseConv, detailEntries: entries, onRequestEdit: () => {} })),
    )
  })

  const scroller = host.querySelector<HTMLElement>('.timeline-scroll')!
  let scrollHeight = 200
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })

  // compacting 变为 true：内容增加后自动贴底到新 scrollHeight
  scrollHeight = 260
  const compactingConv = makeConversation({
    status: 'idle',
    contextUsage: { tokens: 50_000, contextWindow: 100_000, compacting: true },
  })
  await act(async () => {
    root.render(
      e(HostStoreProviders, { value: store }, e(ConversationTimeline, { conversation: compactingConv, detailEntries: entries, onRequestEdit: () => {} })),
    )
  })

  assert.equal(scroller.scrollTop, 260, 'compacting 状态切换后贴底滚动应跟随到新底部')
})

// ---------------------------------------------------------------------------
// 3. Composer：compacting=true 时切换 busy 控件、占位符与只读「精简中…」
// ---------------------------------------------------------------------------

test('Composer：status=idle 且 compacting=true 时切换为 busy/stop/queue 控件，且保持「精简中…」无 svg', { timeout: 60_000 }, async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
  const captured: CapturedRequest[] = []
  installApiStub(captured)

  const conversation = makeConversation({
    status: 'idle',
    contextUsage: { tokens: null, contextWindow: 100_000, compacting: true },
  })
  const store = makeNoticeStore(conversation)
  const host = document.createElement('div')
  document.body.appendChild(host)
  activeHosts.push(host)
  const root = createRoot(host)
  activeRoots.push(root)

  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(Composer, { conversation, prefill: null })))
  })

  // .composer-context-status 保持无 <svg> 与精确文案
  const statusEl = host.querySelector<HTMLElement>('.composer-context-status')
  assert.ok(statusEl !== null)
  assert.equal(statusEl.textContent, 'Compacting…')
  assert.ok(statusEl.querySelector('svg') === null)

  // 占位符切到 busy 态
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
  assert.equal(ta.placeholder, getComposerPlaceholder(true, false))

  // 空草稿显示停止按钮
  const abortBtn = host.querySelector<HTMLButtonElement>('button.composer-abort-button[aria-label="Stop the current execution"]')
  assert.ok(abortBtn !== null, 'compacting 时空草稿应显示停止当前执行按钮')

  // 输入文本后出现插话/排队分流控件，Enter 发送 steer，⌘+Enter 发送 followUp
  await act(async () => {
    typeInto(ta, '精简后跟进')
  })
  const steerBtn = host.querySelector<HTMLButtonElement>('button.composer-steer-action')
  assert.ok(steerBtn !== null, 'compacting 时非空草稿应显示插话引导分流按钮')

  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  assert.equal(captured.length, 1)
  assert.equal(captured[0]!.path, '/api/conversations/1/input')
  assert.equal(captured[0]!.body.whenBusy, 'steer')

  await act(async () => {
    typeInto(ta, '排队指令')
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(captured.length, 2)
  assert.equal(captured[1]!.body.whenBusy, 'followUp')
})

// ---------------------------------------------------------------------------
// 4. Composer：/compact <instructions> 转发与重复提交守卫
// ---------------------------------------------------------------------------

test('Composer：/compact <instructions> 转发 instructions，/compact 重复提交在 compacting=true 时拦截并提示', { timeout: 60_000 }, async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
  const captured: CapturedRequest[] = []
  installApiStub(captured)

  const idleConv = makeConversation({ status: 'idle', contextUsage: { tokens: 30_000, contextWindow: 100_000, compacting: false } })
  const store = makeNoticeStore(idleConv)
  const host = document.createElement('div')
  document.body.appendChild(host)
  activeHosts.push(host)
  const root = createRoot(host)
  activeRoots.push(root)

  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(Composer, { conversation: idleConv, prefill: null })))
  })

  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  // 1) /compact <instructions>
  await act(async () => {
    typeInto(ta, '/compact 保留测试与错误日志')
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await act(async () => {})
  assert.equal(captured.length, 1)
  assert.equal(captured[0]!.path, '/api/conversations/1/compact')
  assert.deepEqual(captured[0]!.body, { instructions: '保留测试与错误日志' })
  assert.equal(ta.value, '')
  assert.ok(store.notices.some((n) => n.title === 'Compaction submitted'))

  // 2) /compact + 仅空白：不带 instructions
  await act(async () => {
    typeInto(ta, '/compact   ')
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await act(async () => {})
  assert.equal(captured.length, 2)
  assert.equal(captured[1]!.path, '/api/conversations/1/compact')
  assert.deepEqual(captured[1]!.body, {})

  // 3) compacting=true 时再次提交 /compact 或 /compact extra：拦截不发请求并提示「上下文精简正在进行中」
  const compactingConv = makeConversation({ status: 'idle', contextUsage: { tokens: null, contextWindow: 100_000, compacting: true } })
  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(Composer, { conversation: compactingConv, prefill: null })))
  })

  await act(async () => {
    typeInto(ta, '/compact 再精简一次')
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await act(async () => {})
  assert.equal(captured.length, 2, 'compacting=true 时不得发送重复 /compact 或 /input 请求')
  assert.equal(ta.value, '', '草稿应被清空')
  assert.ok(
    store.notices.some((n) => n.level === 'info' && n.title === 'Context compaction in progress' && n.conversationId === 1),
    '应推送「Context compaction in progress」info 通知',
  )
})

// ---------------------------------------------------------------------------
// 5. ConversationPane：更多菜单禁用与「正在精简上下文…」，并透传 pending 分割线
// ---------------------------------------------------------------------------

test('ConversationPane：compacting=true 时菜单项禁用显示「正在精简上下文…」与旋转 loader，时间线渲染 pending 分割线', { timeout: 60_000 }, async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
  const compactCalls: string[] = []
  let activeConversations: ConversationSummary[] = [
    makeConversation({
      id: 1,
      status: 'idle',
      contextUsage: { tokens: null, contextWindow: 100_000, compacting: true },
    }),
  ]

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200 })
    }
    if (url === '/api/events') {
      return new Response(hangingEventStream((send) => {
        send(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({
          bootId: 'test-boot',
          seq: 1,
          conversations: activeConversations,
          pendingAsks: [],
          plugins: [],
          ui: [],
        })}\n\n`))
      }, { signal: init?.signal }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url === '/api/conversations/1/compact' && method === 'POST') {
      compactCalls.push(url)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url === '/api/conversations/1/artifacts' && method === 'GET') {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (/^\/api\/conversations\/1(\?|$)/.test(url) && method === 'GET') {
      return new Response(JSON.stringify({ ...activeConversations[0], entries: [] }), { status: 200 })
    }
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  window.history.replaceState(null, '', '#/c/1')
  const host = document.createElement('div')
  document.body.appendChild(host)
  activeHosts.push(host)
  const root = createRoot(host)
  activeRoots.push(root)

  await act(async () => {
    root.render(e(HelmStoreProvider, null, e(ConversationPane, { conversationId: 1 })))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })

  // 时间线也应渲染 pending compaction divider
  assert.match(host.querySelector('.context-divider-label')?.textContent ?? '', /Compacting context…/)

  // 打开「更多会话操作」菜单
  const menuBtn = document.querySelector<HTMLButtonElement>('.pane-more-menu button[aria-label="More conversation actions"]')
  assert.ok(menuBtn !== null)
  await act(async () => {
    menuBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
  })

  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  const compactItem = items.find((el) => el.textContent?.includes('Compacting context…'))
  assert.ok(compactItem !== undefined, '菜单项在 compacting=true 时应显示「正在精简上下文…」')
  assert.equal(compactItem.getAttribute('aria-disabled'), 'true', '菜单项在 compacting=true 时应禁用')
  assert.ok(compactItem.querySelector('svg.spin-slow') !== null, '菜单项应包含旋转 loader 图标')

  await act(async () => {
    compactItem.click()
  })
  assert.equal(compactCalls.length, 0, '禁用态点击不得发出 /compact 请求')
})
