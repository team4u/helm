/**
 * Composer 模型徽章与思考档位控件选中态 DOM 回归（真实挂载 + Radix Popover 交互）。
 *
 * 契约（内核收敛后的前端展示）：
 * - 徽章以 conversation.thinkingLevel（内核生效档位）为唯一权威：目标目录明确
 *   不支持该值时隐藏徽章，不用 override 抢优先；
 * - 控件选中优先级：受支持的 override > 受支持的生效档（旧 override 不被目录
 *   支持但内核已收敛时展示生效档）>「默认」（跟随继承链）；
 * - B=high、override=max、effective=high 时徽章与控件均 high；无 override 仍选「默认」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { Composer } = await import('../src/conversation/Composer.js')

const e = React.createElement

function conv(partial: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: 1, title: '会话 1', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux-cap-b/model-b', thinkingLevel: 'high', status: 'idle',
    stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 0, updatedAt: 0, ...partial,
  }
}

function makeStore(conversation: ConversationSummary): HelmStoreValue {
  const noop = () => {}
  const asyncNoop = async () => undefined
  return {
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark' as const, themePreference: 'system' as const,
    conversations: [conversation], conversationDetails: {}, conversationLives: {}, conversationArtifacts: {},
    pendingAsks: [], resolvedAsksByConv: {}, plugins: [], uiContributions: [],
    groupedUi: groupUiContributions([]), pluginDocs: {}, nodes: [], profiles: [],
    models: [
      // 目录明确 B 仅支持到 high（与内核收敛结果一致）。
      { id: 'faux-cap-b/model-b', provider: 'faux-cap-b', modelId: 'model-b', available: true, thinkingLevels: ['minimal', 'low', 'medium', 'high'] },
    ],
    providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: conversation.id }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null,
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, refreshNodes: asyncNoop,
    loadConversationDetail: asyncNoop, loadEarlierEntries: asyncNoop, loadConversationArtifacts: asyncNoop,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setScreenParams: noop,
    setWorkbenchOpen: noop, setWorkbenchTab: noop, setActiveModal: noop, dismissNotice: noop,
    pushNotice: noop, invokePluginAction: asyncNoop,
    subscribeSessionDoc: () => () => {},
    getSessionDocState: () => ({ hasValue: false, deleted: false, connected: false }),
    getPluginSessionDoc: asyncNoop, retrySessionDoc: noop,
  } as unknown as HelmStoreValue
}

async function mountComposer(conversation: ConversationSummary): Promise<{ host: HTMLElement; unmount: () => void }> {
  const store = makeStore(conversation)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(HelmStoreContext.Provider, { value: store }, e(Composer, { conversation, prefill: null })))
  })
  return { host, unmount: () => { act(() => root.unmount()); host.remove() } }
}

/** 打开模型浮层（真实点击 Radix PopoverTrigger），返回浮层内容根。 */
function openModelPopover(host: HTMLElement): HTMLElement {
  const btn = host.querySelector<HTMLButtonElement>('button.composer-model-button')
  assert.ok(btn, '模型按钮必须渲染')
  act(() => { btn.click() })
  const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
  assert.ok(popover, '点击后模型浮层必须打开（Portal 挂 body）')
  return popover
}

/** 控件当前选中项文本（「默认」或具体档位；无选中返回空串）。 */
function selectedLevel(popover: HTMLElement): string {
  const active = popover.querySelector('.composer-thinking-row .segmented-control-btn.is-active')
  return active?.textContent?.trim() ?? ''
}

/** 徽章文本（如 '· high'）；未渲染返回 null。 */
function badgeOf(host: HTMLElement): string | null {
  return host.querySelector('.composer-model-level')?.textContent ?? null
}

test('DOM：B=high、override=max、effective=high 时徽章与控件选中均为 high', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ thinkingLevel: 'high', thinkingLevelOverride: 'max' }))
  try {
    // 徽章以生效档位为权威，不展示 override 的 max。
    assert.equal(badgeOf(host), '· high')
    const popover = openModelPopover(host)
    // 旧 override=max 不被目录支持，但生效 high 受支持 → 控件选中 high 而非「默认」。
    assert.equal(selectedLevel(popover), 'high')
    const triggers = Array.from(popover.querySelectorAll('.composer-thinking-row .segmented-control-btn'))
    assert.equal(triggers.length, 5, '默认 + minimal/low/medium/high 四档')
    assert.equal(triggers.filter((b) => b.classList.contains('is-active')).length, 1, '恰好一项选中')
  } finally {
    unmount()
  }
})

test('DOM：无 override 时控件仍选「默认」，徽章展示生效档 high', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ thinkingLevel: 'high' }))
  try {
    assert.equal(badgeOf(host), '· high')
    const popover = openModelPopover(host)
    assert.equal(selectedLevel(popover), '默认')
  } finally {
    unmount()
  }
})

test('DOM：目录明确不支持生效档（max）时徽章隐藏，控件退回「默认」', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ thinkingLevel: 'max' }))
  try {
    assert.equal(badgeOf(host), null, '目标目录仅到 high，生效 max 不展示徽章')
    const popover = openModelPopover(host)
    assert.equal(selectedLevel(popover), '默认')
  } finally {
    unmount()
  }
})
