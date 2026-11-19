/**
 * DOM regression for the Composer context-usage read-only status text (real mount).
 *
 * Contract (mirroring the pi footer display rules):
 * - a read-only span: no button / no Popover / no gauge icon; clicks open nothing;
 * - known window shows `${percent.toFixed(1)}%/${formatTokens(window)}` (e.g. 37.5%/200k);
 *   >90 red (composer-context-status-high), >70 yellow (-warn), else default gray;
 * - tokens=null (no valid usage yet after compaction) shows `?/window`; unknown window
 *   shows the compact estimate;
 * - tokens=0（空会话/刚 reset）不渲染；压缩中显示「精简中…」；
 * - 无 contextUsage（内核尚未刷新）不渲染；
 * - rate metrics are not rendered built-in by the host (policy belongs to the optional
 *   builtin:token-speed plugin, contributed via the COMPOSER_STATUS_SLOT).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { ComposerScopeProps, ConversationSummary } from '@helmx/protocol'
import { COMPOSER_STATUS_SLOT } from '@helmx/protocol'
import { applySnapshot, emptyLiveState, mergeConversationDetail } from '../src/lib/live-state.js'
import { makeTestStore } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import { seedPluginClientModule } from '../src/lib/plugin-client.js'
import { groupUiContributions } from '../src/lib/types.js'
import type { HelmxStoreValue } from '../src/lib/types.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
const { Composer } = await import('../src/conversation/Composer.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')

const e = React.createElement

function conv(contextUsage: ConversationSummary['contextUsage']): ConversationSummary {
  return {
    id: 1, title: '会话 1', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux/faux-1', thinkingLevel: '', status: 'idle',
    stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 0, updatedAt: 0, contextUsage,
  }
}

function storeOf(conversation: ConversationSummary): HelmxExternalStore {
  return makeTestStore({ conversations: [conversation] })
}

async function mountComposer(conversation: ConversationSummary): Promise<{ host: HTMLElement; unmount: () => void }> {
  const store = storeOf(conversation)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(Composer, { conversation, prefill: null })))
  })
  return { host, unmount: () => { act(() => root.unmount()); host.remove() } }
}

function statusSpan(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('.composer-context-status')
}

/** Assert read-only: no button, no gauge icon, no popover on click. */
function assertReadOnly(host: HTMLElement): void {
  const span = statusSpan(host)
  assert.ok(span, 'the status text must render')
  assert.ok(span.querySelector('button') === null, 'no nested button')
  assert.ok(span.querySelector('svg') === null, 'no gauge or other icons')
  assert.ok(host.querySelector('button.composer-context-status') === null, 'the status text must not be a button')
  act(() => { span.click() })
  assert.ok(document.body.querySelector('.composer-context-popover') === null, 'clicks must not open any popover')
  assert.ok(document.body.querySelector('[data-radix-popper-content-wrapper]') === null)
}

test('no status text renders without contextUsage or with tokens=0', { timeout: 60_000 }, async () => {
  const none = await mountComposer(conv(undefined))
  try {
    assert.ok(statusSpan(none.host) === null)
  } finally {
    none.unmount()
  }
  const zero = await mountComposer(conv({ tokens: 0 }))
  try {
    assert.ok(statusSpan(zero.host) === null, 'an empty conversation or fresh reset (tokens=0) shows no status text')
  } finally {
    zero.unmount()
  }
})

test('known window: pi-style 37.5%/200k, default gray, read-only', { timeout: 60_000 }, async () => {
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

test('ratio >70 yellow, >90 red (strictly greater than the thresholds)', { timeout: 60_000 }, async () => {
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

test('tokens=null (no valid usage yet after compaction): shows ?/window, uncolored', { timeout: 60_000 }, async () => {
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

test('unknown window: shows only the compact estimate (no fake percentage/denominator), uncolored', { timeout: 60_000 }, async () => {
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

test('while compacting: the read-only compacting text', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: null, contextWindow: 100_000, compacting: true }))
  try {
    const span = statusSpan(host)
    assert.equal(span?.textContent, 'Compacting…')
    assertReadOnly(host)
  } finally {
    unmount()
  }
})

test('first open of an idle conversation after restart: the merged list summary carries contextUsage and the status text renders', { timeout: 60_000 }, async () => {
  // The kernel fills the usage cache silently without an SSE frame: the snapshot summary
  // has no usage; only the HTTP detail carries it
  const base = conv(undefined)
  let state = applySnapshot(emptyLiveState(), { bootId: 'test-boot', seq: 3, conversations: [base], pendingAsks: [], plugins: [], ui: [] })
  state = mergeConversationDetail(state, { ...base, entries: [], contextUsage: { tokens: 25_000, contextWindow: 100_000 } })
  // ConversationPane passes summary ?? detail to the Composer: the status text data source is the merged list summary
  const merged = state.conversations.find((c) => c.id === 1)
  assert.ok(merged?.contextUsage, 'the merged list summary must carry contextUsage')
  const { host, unmount } = await mountComposer(merged)
  try {
    assert.equal(statusSpan(host)?.textContent, '25.0%/100k')
  } finally {
    unmount()
  }
})

test('CSS specificity regression: load the real forms.css and verify tone classes truly override the default gray', { timeout: 60_000 }, () => {
  // Regression background: the base rule `.composer-toolbar .composer-context-status` (0,2,0)
  // once outranked the bare `.composer-context-status-warn/-high` (0,1,0), so yellow/red never
  // applied. DOM class assertions cannot catch that bug: verify with computedStyle from the real stylesheet.
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
    assert.equal(getComputedStyle(warn).color, 'rgb(21, 22, 23)', 'the warn tone must override the default gray (specificity must not fall below the base rule)')
    assert.equal(getComputedStyle(high).color, 'rgb(31, 32, 33)', 'the high tone must override the default gray')
  } finally {
    toolbar.remove()
    style.remove()
  }
})

test('rate metrics are not rendered built-in: contextUsage has no response field (policy belongs to optional plugins)', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: 75_000, contextWindow: 200_000 }))
  try {
    // @ts-expect-error response is removed: rate display belongs entirely to the builtin:token-speed plugin via COMPOSER_STATUS_SLOT
    conv({ tokens: 1, response: { responseTps: 52.4 } })
    assert.ok(host.querySelector('.composer-context-tps') === null, 'the host renders no built-in rate text')
    assert.equal(statusSpan(host)?.textContent, '37.5%/200k', 'the context status is unaffected')
  } finally {
    unmount()
  }
})

test('composer/status host slot: PluginSlot mounts in the status area; contributed components receive ComposerScopeProps', { timeout: 60_000 }, async () => {
  const { usePluginContext } = await import('@helmx/plugin-client')
  // SSR render (same convention as the profile-center slot tests): client components are
  // ready synchronously from the seeded cache, no real fetch from the dynamic-load effect.
  function ComposerStatusProbe(props: ComposerScopeProps) {
    const ctx = usePluginContext()
    return e(
      'span',
      { className: 'probe-composer-status', 'data-probe': 'composer-status' },
      `conv:${props.conversation.id} draft:${props.composer.draft.length} ctx-composer:${ctx.composer !== undefined}`,
    )
  }
  seedPluginClientModule('builtin:demo', 'index.tsx', { ComposerStatusProbe })
  const conversation = conv({
    tokens: 75_000,
    contextWindow: 200_000,
  })
  const store = makeTestStore({
    conversations: [conversation],
    uiContributions: [
      {
        pluginId: 'builtin:demo',
        surface: 'plugin.slot',
        spec: {
          id: 'demo-status',
          target: COMPOSER_STATUS_SLOT,
          client: { module: 'index.tsx', export: 'ComposerStatusProbe' },
        },
      },
    ],
  })
  const html = renderToStaticMarkup(
    e(HostStoreProviders, { value: store }, e(Composer, { conversation, prefill: null })),
  )
  const probeAt = html.indexOf('data-probe="composer-status"')
  assert.ok(probeAt >= 0, 'slot contributions must render through PluginSlot')
  assert.match(html, /conv:1 draft:0 ctx-composer:true/, 'contributed components receive the standard conversation + composer Props; usePluginContext().composer also gets the host input controller')
  // Mount position: the toolbar-left status area right after the context status; never inside the more menu (composer-extras).
  const leftAt = html.indexOf('composer-toolbar-left')
  const statusAt = html.indexOf('composer-context-status')
  const slotAt = html.indexOf('composer-status-slot')
  const extrasAt = html.indexOf('composer-extras')
    assert.ok(leftAt >= 0 && leftAt < slotAt, 'status contributions sit in the toolbar status area (mobile likewise keeps them out of the more menu)')
  assert.ok(statusAt >= 0 && statusAt < slotAt, 'the slot sits right after ContextUsageStatus')
  assert.ok(extrasAt < 0 || slotAt < extrasAt, 'the slot is not inside the more-menu container')
  assert.ok(html.includes('probe-composer-status'), 'slot contributions render in the same area as the context status')
})

test('composer/status renders no container without contributions (zero noise in the host status area)', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: 75_000, contextWindow: 200_000 }))
  try {
    assert.ok(host.querySelector('.composer-status-slot') === null, 'PluginSlot renders null without contributions')
    assert.ok(host.querySelector('[data-probe]') === null)
  } finally {
    unmount()
  }
})

test('Composer localizes input aria, upload button, placeholder and compacting status in zh-CN', { timeout: 60_000 }, async () => {
  const conversation = conv({ tokens: null, contextWindow: 100_000, compacting: true })
  const storeZh = makeTestStore({ locale: 'zh-CN', conversations: [conversation] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: storeZh }, e(Composer, { conversation, prefill: null })))
    })
    assert.ok(host.querySelector('textarea[aria-label="输入消息"]') !== null)
    assert.ok(host.querySelector('button[aria-label="上传附件"]') !== null)
    assert.equal(statusSpan(host)?.textContent, '精简中…')

    await act(async () => {
      storeZh.setLocale('en')
      root.render(e(HostStoreProviders, { value: storeZh }, e(Composer, { conversation, prefill: null })))
    })
    assert.ok(host.querySelector('textarea[aria-label="Type a message"]') !== null)
    assert.ok(host.querySelector('button[aria-label="Uploaded attachment"]') !== null)
    assert.equal(statusSpan(host)?.textContent, 'Compacting…')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
