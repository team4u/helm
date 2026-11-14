/**
 * Composer 上下文用量胶囊 DOM 回归（真实挂载 + Radix Popover 交互）。
 *
 * 契约：
 * - 无 contextUsage 时不渲染胶囊（内核尚未刷新时不占位）；
 * - 窗口已知显示百分比，未知只显示估算量（不显示伪百分比）；
 * - 浮层如实展示计量方式/窗口/阈值/压缩状态/失败摘要（danger 行）；
 * - 压缩中（内核透传 compacting）禁用重复操作；
 * - 「精简上下文」复用现有 compact API（POST /api/conversations/:id/compact）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { makeTestStore, TestStoreProvider } from './helpers/store.js'
import type { HelmStoreValue } from '../src/lib/types.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { Composer } = await import('../src/conversation/Composer.js')

const e = React.createElement

const originalFetch = globalThis.fetch
let posts: Array<{ url: string; body: Record<string, unknown> }> = []

function installFetch(): void {
  posts = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if ((init?.method ?? 'GET') === 'POST') {
      posts.push({ url, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown> })
      return new Response(JSON.stringify({ taskId: 7, conversation: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

function conv(contextUsage: ConversationSummary['contextUsage']): ConversationSummary {
  return {
    id: 1, title: '会话 1', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux/faux-1', thinkingLevel: '', status: 'idle',
    stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 0, updatedAt: 0, contextUsage,
  }
}

function storeOf(conversation: ConversationSummary): HelmStoreValue {
  return makeTestStore({ conversations: [conversation] })
}

async function mountComposer(conversation: ConversationSummary): Promise<{ host: HTMLElement; unmount: () => void }> {
  const store = storeOf(conversation)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(TestStoreProvider, { value: store }, e(Composer, { conversation, prefill: null })))
  })
  return { host, unmount: () => { act(() => root.unmount()); host.remove() } }
}

function pillButton(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('button.composer-context-pill')
}

function openPopover(host: HTMLElement): HTMLElement {
  const btn = pillButton(host)
  assert.ok(btn, '胶囊按钮必须渲染')
  act(() => { btn.click() })
  const popover = document.body.querySelector<HTMLElement>('.composer-context-popover')
  assert.ok(popover, '点击后上下文浮层必须打开（Portal 挂 body）')
  return popover
}

test('无 contextUsage 时不渲染胶囊', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv(undefined))
  try {
    assert.equal(pillButton(host), null)
  } finally {
    unmount()
  }
})

test('窗口已知：胶囊显示百分比；浮层含实测拆分与阈值', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(
    conv({
      tokens: 25_000,
      measuredTokens: 20_000,
      contextWindow: 100_000,
      thresholds: { blockingTokens: 90_000, backgroundTokens: 60_000 },
    }),
  )
  try {
    assert.equal(pillButton(host)?.textContent, '25%')
    const popover = openPopover(host)
    const text = popover.textContent ?? ''
    assert.match(text, /25\.0k tokens/)
    assert.match(text, /实测 20\.0k · 估算 5\.0k/)
    assert.match(text, /100k tokens/)
    assert.match(text, /90\.0k tokens/)
    assert.match(text, /60\.0k tokens/)
    assert.ok(popover.querySelector('button:not([disabled])'), '精简按钮可用')
  } finally {
    unmount()
  }
})

test('窗口未知：只显示估算量，无百分比与阈值行', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: 12_345 }))
  try {
    const label = pillButton(host)?.textContent ?? ''
    assert.equal(label, '12.3k')
    assert.ok(!label.includes('%'), '窗口未知不得显示伪百分比')
    const popover = openPopover(host)
    const text = popover.textContent ?? ''
    assert.match(text, /未知/)
    assert.match(text, /全部估算/)
    assert.ok(!text.includes('阈值'), '无窗口时无阈值行')
  } finally {
    unmount()
  }
})

test('压缩中：胶囊进入压缩态且精简按钮禁用（防重复提交）', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(
    conv({
      tokens: 95_000,
      contextWindow: 100_000,
      thresholds: { blockingTokens: 90_000 },
      compacting: { trigger: 'threshold', blocking: true },
    }),
  )
  try {
    const pill = pillButton(host)
    assert.ok(pill?.classList.contains('composer-context-pill-compacting'), '压缩中色调')
    const popover = openPopover(host)
    assert.match(popover.textContent ?? '', /阈值触发 · 阻塞生成/)
    const compactBtn = Array.from(popover.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('压缩进行中'))
    assert.ok(compactBtn, '压缩中按钮文案切换为进行中')
    assert.ok(compactBtn.disabled, '压缩进行中必须禁用重复操作')
  } finally {
    unmount()
  }
})

test('压缩失败如实展示（danger 行）且不影响操作；精简走现有 compact API', { timeout: 60_000 }, async () => {
  installFetch()
  try {
    const { host, unmount } = await mountComposer(
      conv({
        tokens: 91_000,
        contextWindow: 100_000,
        thresholds: { blockingTokens: 90_000 },
        compactionError: 'provider_error: 上游 429',
      }),
    )
    try {
      const popover = openPopover(host)
      const dangerRow = popover.querySelector('.composer-context-row-danger')
      assert.match(dangerRow?.textContent ?? '', /provider_error: 上游 429/)
      const compactBtn = Array.from(popover.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('精简上下文'))
      assert.ok(compactBtn && !compactBtn.disabled)
      await act(async () => { compactBtn!.click() })
      const compactPost = posts.find((p) => p.url.includes('/api/conversations/1/compact'))
      assert.ok(compactPost, '必须调用现有 compact HTTP 接口')
      assert.deepEqual(compactPost.body, {})
    } finally {
      unmount()
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
