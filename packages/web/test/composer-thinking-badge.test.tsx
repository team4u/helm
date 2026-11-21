/**
 * DOM regression for the Composer model badge and thinking-level control
 * selection state (real mount + Radix Popover interaction).
 *
 * Contract (pure entity levels, what you see is what you get):
 * - the badge and the effective model row's inline level chips authoritatively
 *   show the effective level;
 * - the fake "default" pseudo-level is removed; the selection is what you see;
 * - when the effective level is outside the catalog's supported list, it
 *   safely falls back to a valid level (off or the first).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { ConversationSummary } from '@helmx/protocol'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'

GlobalRegistrator.register()
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { makeTestStore } = await import('./helpers/store.js')
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { Composer } = await import('../src/conversation/Composer.js')
const { formatModelRowDisplay, formatModelShortName } = await import('../src/conversation/model-picker-model.js')

const e = React.createElement

function conv(partial: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: 1, title: '会话 1', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux-cap-b/model-b', thinkingLevel: 'high', status: 'idle',
    stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 0, updatedAt: 0, ...partial,
  }
}

type TestModelList = NonNullable<NonNullable<Parameters<typeof makeTestStore>[0]>['models']>

function makeStore(conversation: ConversationSummary, extraModels: TestModelList = []): HelmxExternalStore {
  return makeTestStore({
    conversations: [conversation],
    models: [
      // The catalog explicitly caps B at high (aligned with the kernel's convergence).
      { id: 'faux-cap-b/model-b', provider: 'faux-cap-b', modelId: 'model-b', available: true, thinkingLevels: ['minimal', 'low', 'medium', 'high'] },
      ...extraModels,
    ],
    primaryTarget: { kind: 'conversation', conversationId: conversation.id },
  })
}

async function mountComposer(
  conversation: ConversationSummary,
  extraModels: TestModelList = [],
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const store = makeStore(conversation, extraModels)
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

/** The effective model's row (marked aria-current on its main button). */
function activeRowOf(popover: HTMLElement): HTMLElement | null {
  return Array.from(popover.querySelectorAll<HTMLElement>('.composer-model-row'))
    .find((row) => row.querySelector('.composer-model-row-main')?.getAttribute('aria-current') === 'true') ?? null
}

/** Selected level chip text on the effective model's row (a concrete level; empty string when none). */
function selectedLevel(popover: HTMLElement): string {
  const active = activeRowOf(popover)?.querySelector('.composer-model-level-chip[aria-pressed="true"]') ?? null
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
    // The effective model's inline chips highlight the effective level high directly.
    assert.equal(selectedLevel(popover), 'high')
    const chips = Array.from(activeRowOf(popover)!.querySelectorAll('.composer-model-level-chip'))
    assert.equal(chips.length, 4, 'four inline level chips minimal/low/medium/high (fake default removed)')
    assert.equal(chips.filter((b) => b.getAttribute('aria-pressed') === 'true').length, 1, 'exactly one selected chip')
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

test('model picker display helpers: split nested route prefixes into source so row name matches short name', { timeout: 60_000 }, () => {
  assert.equal(formatModelShortName('magpie/auto/deepseek-v4.1-flash'), 'deepseek-v4.1-flash')
  assert.equal(formatModelShortName('anthropic/claude-3-7-sonnet'), 'claude-3-7-sonnet')
  assert.equal(formatModelShortName(''), '')
  assert.equal(formatModelShortName(undefined), '')

  assert.deepEqual(
    formatModelRowDisplay({ provider: 'magpie', modelId: 'auto/deepseek-v4.1-flash' }),
    { name: 'deepseek-v4.1-flash', source: 'magpie/auto' },
  )
  assert.deepEqual(
    formatModelRowDisplay({ provider: 'magpie', modelId: 'antigravity-bridge/gemini-4-neon' }),
    { name: 'gemini-4-neon', source: 'magpie/antigravity-bridge' },
  )
  assert.deepEqual(
    formatModelRowDisplay({ provider: 'anthropic', modelId: 'claude-3-7-sonnet' }),
    { name: 'claude-3-7-sonnet', source: 'anthropic' },
  )
  assert.deepEqual(
    formatModelRowDisplay({ provider: 'faux', modelId: 'trailing/' }),
    { name: 'trailing/', source: 'faux' },
  )
})

test('DOM: popover rows display the short model name consistent with the trigger button and keep provider/route in source', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(
    conv({ model: 'magpie/auto/deepseek-v4.1-flash', thinkingLevel: 'high' }),
    [
      { id: 'magpie/auto/deepseek-v4.1-flash', provider: 'magpie', modelId: 'auto/deepseek-v4.1-flash', available: true, thinkingLevels: ['off', 'low', 'high', 'max'] },
      { id: 'magpie/antigravity-bridge/gemini-4-neon', provider: 'magpie', modelId: 'antigravity-bridge/gemini-4-neon', available: true, thinkingLevels: ['xhigh'] },
    ],
  )
  try {
    assert.equal(host.querySelector('.composer-model-label')?.textContent, 'deepseek-v4.1-flash')
    const popover = openModelPopover(host)
    const rows = Array.from(popover.querySelectorAll<HTMLElement>('.composer-model-row')).map((row) => ({
      name: row.querySelector('.composer-model-row-name')?.textContent ?? '',
      source: row.querySelector('.composer-model-row-source')?.textContent ?? '',
      title: row.querySelector<HTMLButtonElement>('.composer-model-row-main')?.title ?? '',
      isCurrent: row.querySelector<HTMLButtonElement>('.composer-model-row-main')?.getAttribute('aria-current') === 'true',
      hasCheck: row.querySelector('.composer-model-row-check') !== null,
      hasActiveBg: row.classList.contains('popover-item-active'),
    }))
    const deepseek = rows.find((r) => r.title.includes('magpie/auto/deepseek-v4.1-flash'))
    const gemini = rows.find((r) => r.title.includes('magpie/antigravity-bridge/gemini-4-neon'))
    assert.ok(deepseek, 'deepseek row must render with full canonical id in title')
    assert.equal(deepseek.name, 'deepseek-v4.1-flash')
    assert.equal(deepseek.source, 'magpie/auto')
    assert.equal(deepseek.isCurrent, true)
    assert.equal(deepseek.hasCheck, true)
    assert.equal(deepseek.hasActiveBg, false, 'current model row must not get a default popover-item-active highlight')
    assert.ok(gemini, 'gemini row must render with full canonical id in title')
    assert.equal(gemini.name, 'gemini-4-neon')
    assert.equal(gemini.source, 'magpie/antigravity-bridge')
    assert.equal(gemini.isCurrent, false)
    assert.equal(gemini.hasCheck, false)
    assert.equal(gemini.hasActiveBg, false)
  } finally {
    unmount()
  }
})
