/**
 * DOM regression for the Composer model badge and thinking-level control
 * selection state (real mount + Radix Popover interaction).
 *
 * Contract (pure entity levels, what you see is what you get):
 * - the badge and control authoritatively show the effective level;
 * - the fake "default" pseudo-level is removed; the selection is what you see;
 * - when the effective level is outside the catalog's supported list, it
 *   safely falls back to a valid level (off or the first).
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
    locale: 'en' as const,
    conversations: [conversation], conversationDetails: {}, conversationLives: {}, conversationArtifacts: {},
    pendingAsks: [], resolvedAsksByConv: {}, plugins: [], uiContributions: [],
    groupedUi: groupUiContributions([]), pluginDocs: {}, nodes: [], profiles: [], profilesLoaded: true, assetsLoaded: true,
    models: [
      // The catalog explicitly caps B at high (aligned with the kernel's convergence).
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

/** Open the model popover (a real Radix PopoverTrigger click); returns the popover content root. */
function openModelPopover(host: HTMLElement): HTMLElement {
  const btn = host.querySelector<HTMLButtonElement>('button.composer-model-button')
  assert.ok(btn, 'the model button must render')
  act(() => { btn.click() })
  const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
  assert.ok(popover, 'the model popover must open on click (portaled to body)')
  return popover
}

/** Selected item text of the control (a concrete level; empty string when none). */
function selectedLevel(popover: HTMLElement): string {
  const active = popover.querySelector('.composer-thinking-row .segmented-control-btn.is-active')
  return active?.textContent?.trim() ?? ''
}

/** Badge text (e.g. '· high'); null when not rendered. */
function badgeOf(host: HTMLElement): string | null {
  return host.querySelector('.composer-model-level')?.textContent ?? null
}

test('DOM: B=high, override=max, effective=high -> badge and control selection both high', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ thinkingLevel: 'high', thinkingLevelOverride: 'max' }))
  try {
    // The badge is authoritative on the effective level; the override's max never shows.
    assert.equal(badgeOf(host), '· high')
    const popover = openModelPopover(host)
    // The control highlights the effective level high directly.
    assert.equal(selectedLevel(popover), 'high')
    const triggers = Array.from(popover.querySelectorAll('.composer-thinking-row .segmented-control-btn'))
    assert.equal(triggers.length, 4, 'four levels minimal/low/medium/high (fake default removed)')
    assert.equal(triggers.filter((b) => b.classList.contains('is-active')).length, 1, 'exactly one selected')
  } finally {
    unmount()
  }
})

test('DOM: without an override the control highlights the effective high and the badge shows high', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ thinkingLevel: 'high' }))
  try {
    assert.equal(badgeOf(host), '· high')
    const popover = openModelPopover(host)
    assert.equal(selectedLevel(popover), 'high')
  } finally {
    unmount()
  }
})

test('DOM: when the catalog rejects the effective level (max), fall back to the first supported (minimal)', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ thinkingLevel: 'max' }))
  try {
    assert.equal(badgeOf(host), '· minimal', 'falls back to the first valid level for display')
    const popover = openModelPopover(host)
    assert.equal(selectedLevel(popover), 'minimal')
  } finally {
    unmount()
  }
})
