/**
 * Composer 上下文用量只读状态文本 DOM 回归（真实挂载）。
 *
 * 契约（照抄 pi footer 展示规则）：
 * - 只读 span：无 button / 无 Popover / 无 gauge 图标，点击不弹任何浮层；
 * - 窗口已知显示 `${percent.toFixed(1)}%/${formatTokens(window)}`（如 37.5%/200k）；
 *   >90 红（composer-context-status-high）、>70 黄（-warn）、其余默认灰；
 * - tokens=null（压缩后尚无有效 usage）显示 `?/窗口`；窗口未知显示紧凑估算量；
 * - tokens=0（空会话/刚 reset）不渲染；压缩中显示「精简中…」；
 * - 无 contextUsage（内核尚未刷新）不渲染。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { applySnapshot, emptyLiveState, mergeConversationDetail } from '../src/lib/live-state.js'
import { makeTestStore, TestStoreProvider } from './helpers/store.js'
import type { HelmStoreValue } from '../src/lib/types.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { Composer } = await import('../src/conversation/Composer.js')

const e = React.createElement

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

function statusSpan(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('.composer-context-status')
}

/** 断言只读：无按钮、无 gauge 图标、点击不弹浮层。 */
function assertReadOnly(host: HTMLElement): void {
  const span = statusSpan(host)
  assert.ok(span, '状态文本必须渲染')
  assert.equal(span.querySelector('button'), null, '不得内嵌按钮')
  assert.equal(span.querySelector('svg'), null, '不得显示 gauge 等图标')
  assert.equal(host.querySelector('button.composer-context-status'), null, '状态文本不得是按钮')
  act(() => { span.click() })
  assert.equal(document.body.querySelector('.composer-context-popover'), null, '点击不得弹出任何浮层')
  assert.equal(document.body.querySelector('[data-radix-popper-content-wrapper]'), null)
}

test('无 contextUsage 或 tokens=0 时不渲染状态文本', { timeout: 60_000 }, async () => {
  const none = await mountComposer(conv(undefined))
  try {
    assert.equal(statusSpan(none.host), null)
  } finally {
    none.unmount()
  }
  const zero = await mountComposer(conv({ tokens: 0 }))
  try {
    assert.equal(statusSpan(zero.host), null, '空会话/刚 reset（tokens=0）不显示状态文本')
  } finally {
    zero.unmount()
  }
})

test('窗口已知：pi 同款 37.5%/200k，默认灰色，只读不可点', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: 75_000, contextWindow: 200_000 }))
  try {
    const span = statusSpan(host)
    assert.ok(span)
    assert.equal(span.textContent, '37.5%/200k')
    assert.equal(span.classList.contains('composer-context-status-high'), false)
    assert.equal(span.classList.contains('composer-context-status-warn'), false)
    assertReadOnly(host)
  } finally {
    unmount()
  }
})

test('占比 >70 黄色、>90 红色（严格大于阈值）', { timeout: 60_000 }, async () => {
  const warn = await mountComposer(conv({ tokens: 75_100, contextWindow: 100_000 }))
  try {
    const span = statusSpan(warn.host)
    assert.equal(span?.textContent, '75.1%/100k')
    assert.equal(span?.classList.contains('composer-context-status-warn'), true)
    assert.equal(span?.classList.contains('composer-context-status-high'), false)
  } finally {
    warn.unmount()
  }
  const high = await mountComposer(conv({ tokens: 92_000, contextWindow: 100_000 }))
  try {
    const span = statusSpan(high.host)
    assert.equal(span?.textContent, '92.0%/100k')
    assert.equal(span?.classList.contains('composer-context-status-high'), true)
  } finally {
    high.unmount()
  }
})

test('tokens=null（压缩后尚无有效 usage）：显示 ?/窗口，不着色', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: null, contextWindow: 200_000 }))
  try {
    const span = statusSpan(host)
    assert.equal(span?.textContent, '?/200k')
    assert.equal(span?.classList.contains('composer-context-status-warn'), false)
    assert.equal(span?.classList.contains('composer-context-status-high'), false)
  } finally {
    unmount()
  }
})

test('窗口未知：只显示紧凑估算量（无伪百分比/伪分母）且不着色', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: 12_345 }))
  try {
    const span = statusSpan(host)
    assert.equal(span?.textContent, '12k')
    assert.ok(!span!.textContent.includes('%'))
    assert.equal(span?.classList.contains('composer-context-status-warn'), false)
    assert.equal(span?.classList.contains('composer-context-status-high'), false)
  } finally {
    unmount()
  }
})

test('压缩中：只读文本「精简中…」', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: null, contextWindow: 100_000, compacting: true }))
  try {
    const span = statusSpan(host)
    assert.equal(span?.textContent, '精简中…')
    assertReadOnly(host)
  } finally {
    unmount()
  }
})

test('重启后首次打开 idle 会话：详情首读合并后列表摘要带 contextUsage，状态文本随之渲染', { timeout: 60_000 }, async () => {
  // 内核首次填充用量缓存静默不发 SSE 帧：快照摘要无用量，只有 HTTP 详情携带
  const base = conv(undefined)
  let state = applySnapshot(emptyLiveState(), { bootId: 'test-boot', seq: 3, conversations: [base], pendingAsks: [], plugins: [], ui: [] })
  state = mergeConversationDetail(state, { ...base, entries: [], contextUsage: { tokens: 25_000, contextWindow: 100_000 } })
  // ConversationPane 向 Composer 传 summary ?? detail：状态文本数据源是合并后的列表摘要
  const merged = state.conversations.find((c) => c.id === 1)
  assert.ok(merged?.contextUsage, '合并后列表摘要必须带 contextUsage')
  const { host, unmount } = await mountComposer(merged)
  try {
    assert.equal(statusSpan(host)?.textContent, '25.0%/100k')
  } finally {
    unmount()
  }
})

test('CSS 优先级回归：加载真实 forms.css，色调类必须真正覆盖默认灰', { timeout: 60_000 }, () => {
  // 回归背景：基础规则 `.composer-toolbar .composer-context-status`（0,2,0）
  // 一度高于裸 `.composer-context-status-warn/-high`（0,1,0），黄红永远不生效。
  // DOM class 断言无法发现该 bug：用真实样式表的 computedStyle 验证。
  const css = readFileSync(new URL('../src/styles/forms.css', import.meta.url), 'utf8')
  const style = document.createElement('style')
  style.textContent = `:root { --fg-muted: rgb(11, 12, 13); --warn: rgb(21, 22, 23); --err: rgb(31, 32, 33); }\n${css}`
  document.head.appendChild(style)
  const toolbar = document.createElement('div')
  toolbar.className = 'composer-toolbar'
  const base = document.createElement('span')
  base.className = 'composer-context-status'
  const warn = document.createElement('span')
  warn.className = 'composer-context-status composer-context-status-warn'
  const high = document.createElement('span')
  high.className = 'composer-context-status composer-context-status-high'
  toolbar.append(base, warn, high)
  document.body.appendChild(toolbar)
  try {
    assert.equal(getComputedStyle(base).color, 'rgb(11, 12, 13)')
    assert.equal(getComputedStyle(warn).color, 'rgb(21, 22, 23)', 'warn 色调必须覆盖默认灰（specificity 不得低于基础规则）')
    assert.equal(getComputedStyle(high).color, 'rgb(31, 32, 33)', 'high 色调必须覆盖默认灰')
  } finally {
    toolbar.remove()
    style.remove()
  }
})
