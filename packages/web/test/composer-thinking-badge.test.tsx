/**
 * Composer 模型徽章与思考档位控件选中态 DOM 回归（真实挂载 + Radix Popover 交互）。
 *
 * 契约（纯实体档位，所见即所得）：
 * - 徽章与控件以实际生效档位为权威展示；
 * - 移除「默认」伪档位，所选即所见；
 * - 生效档不在目录支持列表时，安全回退至有效档位（off 或首项）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'

GlobalRegistrator.register()
const { HostStoreProviders } = await import('./helpers/host-store.js')
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
    root.render(e(HostStoreProviders, { value: store }, e(Composer, { conversation, prefill: null })))
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

/** 控件当前选中项文本（具体档位；无选中返回空串）。 */
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
    // 控件直接高亮生效档 high。
    assert.equal(selectedLevel(popover), 'high')
    const triggers = Array.from(popover.querySelectorAll('.composer-thinking-row .segmented-control-btn'))
    assert.equal(triggers.length, 4, 'minimal/low/medium/high 四档（移除默认伪档位）')
    assert.equal(triggers.filter((b) => b.classList.contains('is-active')).length, 1, '恰好一项选中')
  } finally {
    unmount()
  }
})

test('DOM：无 override 时控件直接高亮生效档 high，徽章展示生效档 high', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ thinkingLevel: 'high' }))
  try {
    assert.equal(badgeOf(host), '· high')
    const popover = openModelPopover(host)
    assert.equal(selectedLevel(popover), 'high')
  } finally {
    unmount()
  }
})

test('DOM：目录明确不支持生效档（max）时回退至首项支持档位（minimal）', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ thinkingLevel: 'max' }))
  try {
    assert.equal(badgeOf(host), '· minimal', '回退至首项有效档位展示')
    const popover = openModelPopover(host)
    assert.equal(selectedLevel(popover), 'minimal')
  } finally {
    unmount()
  }
})
