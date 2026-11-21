/**
 * Regression for in-progress context-compaction feedback, busy queueing controls and
 * `/compact <instructions>` (real DOM mount + pure functions):
 * - parseCompactSlashCommand and isSessionManageCommand parsing of `/compact` and its
 *   optional instructions;
 * - ConversationTimeline rendering the pending compaction divider (`正在精简上下文…` +
 *   the `.spin-slow` loader) and its ordering against queued messages;
 * - Composer switching to busy state under `status='idle' && contextUsage.compacting=true`
 *   (stop button, steer/queue controls, placeholder and the `精简中…` read-only status);
 * - `/compact <instructions>` forwards the `instructions` param; a repeated `/compact`
 *   while `compacting=true` notices in-progress and sends no request;
 * - the ConversationPane top-bar "more actions" menu disables during compaction showing
 *   `正在精简上下文…` + loader, and passes the pending divider through.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationLive, ConversationSummary } from '@helmx/protocol'
import { makeTestStore } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import type { ToastNotice } from '../src/lib/types.js'
import { hangingEventStream } from './helpers/sse-stream.js'
import type { HelmxStoreValue } from '../src/lib/types.js'
import {
  getComposerPlaceholder,
  isSessionManageCommand,
  parseCompactSlashCommand,
} from '../src/conversation/composer-model.js'

try {
  GlobalRegistrator.register()
} catch {
  // Registered
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { HelmxStoreProvider } = await import('../src/lib/HelmxStoreProvider.js')
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
  extra: Partial<HelmxStoreValue> = {},
): HelmxExternalStore {
  return makeTestStore({
    conversations: [conversation],
    conversationDetails: { [conversation.id]: { ...conversation, entries: [] } },
    ...extra,
  })
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
    // The Composer '/' menu now probes the merged node-skill catalog of the
    // conversation coordinates via a plugin action; answer it out-of-band so
    // the captured submit assertions stay about conversation input.
    if (path.startsWith('/api/actions/')) {
      return new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
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
// 1. Pure functions: parseCompactSlashCommand & isSessionManageCommand
// ---------------------------------------------------------------------------

test('parseCompactSlashCommand & isSessionManageCommand: exact /compact recognition with optional instructions', { timeout: 60_000 }, () => {
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
// 2. ConversationTimeline: pending compaction divider rendering and fingerprint
// ---------------------------------------------------------------------------

test('ConversationTimeline: compacting=true renders the in-progress divider with spinner ahead of queued messages', { timeout: 60_000 }, async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
  const conversation = makeConversation({
    status: 'idle',
    contextUsage: { tokens: 50_000, contextWindow: 100_000, compacting: true },
  })
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helmx.input', data: { text: '先查一下日志', origin: 'human' } },
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
  assert.ok(dividerLabel !== null, 'the context divider label must render')
  assert.match(dividerLabel.textContent ?? '', /Compacting context…/)
  assert.ok(dividerLabel.querySelector('svg.spin-slow') !== null, 'the pending divider must render the spin-slow loader icon')

  // DOM order: the divider must precede queued human messages
  const innerHtml = host.querySelector('.timeline-inner')?.innerHTML ?? ''
  const dividerPos = innerHtml.indexOf('Compacting context…')
  const queuedPos = innerHtml.indexOf('精简完继续修改')
  assert.ok(dividerPos >= 0 && queuedPos > dividerPos, 'the pending divider renders before queued messages')
})

test('ConversationTimeline: compacting changes keep the bottom anchor attached to the latest content', { timeout: 60_000 }, async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver

  const baseConv = makeConversation({
    status: 'idle',
    contextUsage: { tokens: 50_000, contextWindow: 100_000, compacting: false },
  })
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helmx.input', data: { text: '你好', origin: 'human' } },
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

  // compacting flips to true: after content grows, auto-stick to the new scrollHeight
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

  assert.equal(scroller.scrollTop, 260, 'after the compacting flip the bottom-stick scroll follows the new bottom')
})

// ---------------------------------------------------------------------------
// 3. Composer: compacting=true switches to busy controls, placeholder and the read-only compacting status
// ---------------------------------------------------------------------------

test('Composer: status=idle && compacting=true switches to busy/stop/queue controls while keeping the svg-free compacting status', { timeout: 60_000 }, async () => {
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

  // .composer-context-status stays free of <svg> with exact copy
  const statusEl = host.querySelector<HTMLElement>('.composer-context-status')
  assert.ok(statusEl !== null)
  assert.equal(statusEl.textContent, 'Compacting…')
  assert.ok(statusEl.querySelector('svg') === null)

  // Placeholder switches to the busy variant
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
  assert.equal(ta.placeholder, getComposerPlaceholder(true, false))

  // Empty draft shows the stop button
  const abortBtn = host.querySelector<HTMLButtonElement>('button.composer-abort-button[aria-label="Stop the current execution"]')
  assert.ok(abortBtn !== null, 'with an empty draft while compacting, the stop button must show')

  // With text typed, steer/queue split controls appear; Enter sends steer, ⌘+Enter sends followUp
  await act(async () => {
    typeInto(ta, '精简后跟进')
  })
  const steerBtn = host.querySelector<HTMLButtonElement>('button.composer-steer-action')
  assert.ok(steerBtn !== null, 'with a non-empty draft while compacting, the steer split button must show')

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
// 4. Composer: /compact <instructions> forwarding and the repeat-submit guard
// ---------------------------------------------------------------------------

test('Composer: /compact <instructions> forwards instructions; a repeat submit at compacting=true is blocked with a notice', { timeout: 60_000 }, async () => {
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
  assert.ok(store.getNotices().some((n: ToastNotice) => n.title === 'Compaction submitted'))

  // 2) /compact + whitespace only: no instructions carried
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

  // 3) Submitting /compact or /compact extra again at compacting=true: blocked, no request, in-progress notice
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
  assert.equal(captured.length, 2, 'no duplicate /compact or /input request may be sent at compacting=true')
  assert.equal(ta.value, '', 'the draft must be cleared')
  assert.ok(
    store.getNotices().some((n) => n.level === 'info' && n.title === 'Context compaction in progress' && n.conversationId === 1),
    'an info notice "Context compaction in progress" must be pushed',
  )
})

// ---------------------------------------------------------------------------
// 5. ConversationPane: more-menu disable with the in-progress copy, and the pending divider passthrough
// ---------------------------------------------------------------------------

test('ConversationPane: at compacting=true the menu item disables showing the in-progress copy with spinner; the timeline renders the pending divider', { timeout: 60_000 }, async () => {
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
    root.render(e(HelmxStoreProvider, null, e(ConversationPane, { conversationId: 1 })))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })

  // The timeline must also render the pending compaction divider
  assert.match(host.querySelector('.context-divider-label')?.textContent ?? '', /Compacting context…/)

  // Open the "more conversation actions" menu
  const menuBtn = document.querySelector<HTMLButtonElement>('.pane-more-menu button[aria-label="More conversation actions"]')
  assert.ok(menuBtn !== null)
  await act(async () => {
    menuBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
  })

  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  const compactItem = items.find((el) => el.textContent?.includes('Compacting context…'))
  assert.ok(compactItem !== undefined, 'at compacting=true the menu item shows the in-progress copy')
  assert.equal(compactItem.getAttribute('aria-disabled'), 'true', 'at compacting=true the menu item must be disabled')
  assert.ok(compactItem.querySelector('svg.spin-slow') !== null, 'the menu item must contain the spinner loader icon')

  await act(async () => {
    compactItem.click()
  })
  assert.equal(compactCalls.length, 0, 'a disabled click must not issue a /compact request')
})
