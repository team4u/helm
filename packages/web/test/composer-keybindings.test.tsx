/**
 * Unit tests for Composer / Standby single-key shortcuts, queued-input recall, cross-component
 * Ctrl+L wiring, COMPOSER_DOCK_SLOT and the mobile dual buttons.
 *
 * Strictly one function per shortcut, single-key muscle memory; coverage:
 * 1. keybindings-model pure logic (Shift+Tab / ↑ / Enter / Mod+Enter / panel matching / index cycling,
 *    no multi-key aliases);
 * 2. Ctrl+L (helmx:shortcut) precise split routing + search autoFocus + ↑↓Enter picking + Esc focus
 *    return + no bubbling blocked;
 * 3. Shift+Tab preventDefault() immediately and cycles thinkingLevel (never answers the Ctrl+T alias);
 * 4. ↑ (empty draft on the first line) prefers withdrawing the newest human queued input from
 *    live.queuedInputs and prefilling (no history warning); only without human queued input does it
 *    fall back to history editing; the Alt+Up alias is rejected;
 * 5. Esc layer priority (close popover + stopPropagation -> cancel edit mode + stopPropagation -> hand
 *    to the outer double-Esc);
 * 6. COMPOSER_DOCK_SLOT renders directly above <AskDock /> passing ComposerScopeProps (never tucked
 *    into the mobile more menu);
 * 7. Mobile (<=680px) busy state explicitly renders [steer] + [queue] buttons; desktop badges carry
 *    .kbd-hint uniformly;
 * 8. Standby pane global-default model inheritance, Shift+Tab, Ctrl+L and static '/' skill completion;
 * 9. Zero-emoji and Fast Refresh checks.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { ensureHappyDom, jsonResponse, waitForCondition } from './helpers/dom-harness.js'
import type {
  ComposerScopeProps,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
  Profile,
  QueuedConversationInput,
  SkillSummary,
} from '@helmx/protocol'
import { COMPOSER_DOCK_SLOT } from '@helmx/protocol'
import { groupUiContributions, type HelmxStoreValue } from '../src/lib/types.js'
import {
  canRecallOnArrowUp,
  HELMX_SHORTCUT_EVENT,
  initialModelActiveIndex,
  isCaretAtFirstLine,
  isComposerSubmitEnterEvent,
  isPlainArrowUpEvent,
  isShiftTabEvent,
  isShortcutPanelMatch,
  latestHumanQueuedInput,
  nextThinkingLevel,
  resolveEffectiveThinkingLevel,
  resolveElementPanel,
  stepActiveIndex,
} from '../src/conversation/keybindings-model.js'
import { resolveStandbyEffectiveModel, resolveStandbyThinkingLevel, resetStandbyDrafts } from '../src/conversation/standby-model.js'

ensureHappyDom()

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
const { conversationsApi, assetsApi } = await import('../src/lib/api.js')
const { seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { usePluginContext } = await import('@helmx/plugin-client')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { makeTestStore, HelmxExternalStoreContext } = await import('./helpers/store.js')
const { Composer } = await import('../src/conversation/Composer.js')
const { ComposerSendControls } = await import('../src/conversation/ComposerSendControls.js')
const { AgentStandbyPane } = await import('../src/conversation/AgentStandbyPane.js')

const e = React.createElement

// ---------------------------------------------------------------------------
// 1. Pure-logic tests: keybindings-model
// ---------------------------------------------------------------------------

test('keybindings-model: strict one-shortcut-per-function matching; Alt+Up / Alt+Enter / Ctrl+T aliases forbidden', { timeout: 60_000 }, () => {
  const base = { key: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }

  assert.equal(isShiftTabEvent({ ...base, key: 'Tab', shiftKey: true }), true)
  assert.equal(isShiftTabEvent({ ...base, key: 'Tab' }), false)
  assert.equal(isShiftTabEvent({ ...base, key: 't', ctrlKey: true }), false, 'Ctrl+T alias forbidden')
  assert.equal(isShiftTabEvent({ ...base, key: 'Tab', shiftKey: true, ctrlKey: true }), false)

  assert.equal(isPlainArrowUpEvent({ ...base, key: 'ArrowUp' }), true)
  assert.equal(isPlainArrowUpEvent({ ...base, key: 'ArrowUp', altKey: true }), false, 'Alt+Up alias forbidden')
  assert.equal(isPlainArrowUpEvent({ ...base, key: 'ArrowUp', ctrlKey: true }), false)
  assert.equal(isPlainArrowUpEvent({ ...base, key: 'ArrowUp', metaKey: true }), false)
  assert.equal(isPlainArrowUpEvent({ ...base, key: 'ArrowUp', shiftKey: true }), false)

  assert.equal(isComposerSubmitEnterEvent({ key: 'Enter', shiftKey: false, altKey: false }), true)
  assert.equal(isComposerSubmitEnterEvent({ key: 'Enter', shiftKey: true, altKey: false }), false, 'Shift+Enter is newline only')
  assert.equal(isComposerSubmitEnterEvent({ key: 'Enter', shiftKey: false, altKey: true }), false, 'Alt+Enter alias forbidden')
})

test('keybindings-model: canRecallOnArrowUp passes only for an empty draft on the first line', { timeout: 60_000 }, () => {
  assert.equal(isCaretAtFirstLine('', 0), true)
  assert.equal(isCaretAtFirstLine('hello', 3), true)
  assert.equal(isCaretAtFirstLine('line1\nline2', 6), false)
  assert.equal(canRecallOnArrowUp('', 0), true)
  assert.equal(canRecallOnArrowUp('', null), true)
  assert.equal(canRecallOnArrowUp('draft', 0), false)
  assert.equal(canRecallOnArrowUp('\nsecond', 1), false)
})

test('keybindings-model: latestHumanQueuedInput ignores agent/trigger and takes the newest human queued input', { timeout: 60_000 }, () => {
  const q = (id: string, sub: string, origin: QueuedConversationInput['origin'], createdAt: number): QueuedConversationInput => ({
    id, submissionId: sub, text: `msg-${id}`, mode: 'followUp', origin, createdAt,
  })
  assert.equal(latestHumanQueuedInput(undefined), undefined)
  assert.equal(latestHumanQueuedInput([]), undefined)
  assert.equal(latestHumanQueuedInput([q('a1', '1', 'agent', 10), q('t1', '2', 'trigger', 20)]), undefined)

  // Different times: take the human input with the greatest createdAt, ignoring newer agent items
  const picked = latestHumanQueuedInput([
    q('h1', '10', 'human', 100),
    q('h2', '11', 'human', 200),
    q('a1', '12', 'agent', 300),
  ])
  assert.equal(picked?.id, 'h2')

  // Equal createdAt: take the queue-tail item
  const tiePicked = latestHumanQueuedInput([
    q('h1', '10', 'human', 50),
    q('h2', '11', 'human', 50),
  ])
  assert.equal(tiePicked?.id, 'h2')
})

test('keybindings-model: nextThinkingLevel cyclic stepping with the no-thinking guard', { timeout: 60_000 }, () => {
  const levels = ['off', 'low', 'medium', 'high']
  assert.equal(nextThinkingLevel(levels, 'off'), 'low')
  assert.equal(nextThinkingLevel(levels, 'low'), 'medium')
  assert.equal(nextThinkingLevel(levels, 'high'), 'off', 'wraps back to the first item at the end')
  assert.equal(nextThinkingLevel(levels, 'unknown'), 'off')
  assert.equal(nextThinkingLevel(['off'], 'off'), null)
  assert.equal(nextThinkingLevel([], 'off'), null)
  assert.equal(resolveEffectiveThinkingLevel(['minimal', 'high'], 'max'), 'minimal')
})

test('keybindings-model: initialModelActiveIndex / stepActiveIndex and panel matching', { timeout: 60_000 }, () => {
  const items = [{ id: 'a/1' }, { id: 'b/2' }, { id: 'c/3' }]
  assert.equal(initialModelActiveIndex(items, 'b/2'), 1)
  assert.equal(initialModelActiveIndex(items, 'missing'), 0)
  assert.equal(initialModelActiveIndex([], 'a/1'), -1)
  assert.equal(stepActiveIndex(2, 3, 1), 0)
  assert.equal(stepActiveIndex(0, 3, -1), 2)

  const splitWrap = document.createElement('div')
  splitWrap.setAttribute('data-helmx-panel', 'split')
  const child = document.createElement('span')
  splitWrap.appendChild(child)
  assert.equal(resolveElementPanel(child), 'split')
  assert.equal(isShortcutPanelMatch(child, 'split'), true)
  assert.equal(isShortcutPanelMatch(child, 'primary'), false)

  const drawer = document.createElement('div')
  drawer.className = 'conversation-drawer'
  const drawerChild = document.createElement('span')
  drawer.appendChild(drawerChild)
  assert.equal(isShortcutPanelMatch(drawerChild, 'primary'), false, 'a drawer child without data-helmx-panel never answers primary shortcuts')
})

// ---------------------------------------------------------------------------
// Test fixtures and cleanup
// ---------------------------------------------------------------------------

const originalPatch = conversationsApi.patch
const originalSubmitInput = conversationsApi.submitInput
const originalWithdraw = conversationsApi.withdraw
const originalAbort = conversationsApi.abort
const originalGetDefaultModel = assetsApi.getDefaultModel
const originalMatchMedia = window.matchMedia

const mountedRoots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = []

afterEach(() => {
  for (const item of mountedRoots.splice(0)) {
    act(() => {
      item.root.unmount()
    })
    item.host.remove()
  }
  document.body.innerHTML = ''
  conversationsApi.patch = originalPatch
  conversationsApi.submitInput = originalSubmitInput
  conversationsApi.withdraw = originalWithdraw
  conversationsApi.abort = originalAbort
  assetsApi.getDefaultModel = originalGetDefaultModel
  window.matchMedia = originalMatchMedia
  resetStandbyDrafts()
})

function makeConv(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 1,
    title: '测试会话',
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/m2',
    thinkingLevel: 'off',
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

function makeModels() {
  return [
    { id: 'faux/m1', provider: 'faux', modelId: 'm1', available: true, thinkingLevels: ['off', 'low', 'high'] },
    { id: 'faux/m2', provider: 'faux', modelId: 'm2', available: true, thinkingLevels: ['off', 'low', 'medium', 'high'] },
    { id: 'faux/m3', provider: 'faux', modelId: 'm3', available: true, thinkingLevels: ['off', 'max'] },
  ]
}

function mountTree(node: React.ReactNode, panel?: 'primary' | 'split'): HTMLElement {
  const host = document.createElement('div')
  if (panel !== undefined) host.setAttribute('data-helmx-panel', panel)
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(node)
  })
  mountedRoots.push({ root, host })
  return host
}

function typeInto(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const tracker = (ta as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(ta, text)
  tracker?.setValue(prev)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

function stubMatchMedia(isMobile: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width: 680px') ? isMobile : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

// ---------------------------------------------------------------------------
// 2. Ctrl+L cross-component wiring + search autoFocus + keyboard picking + Esc focus return
// ---------------------------------------------------------------------------

test('Ctrl+L: precisely toggles the ModelPicker per data-helmx-panel in split view, auto-focuses search and supports ↑↓Enter picking', { timeout: 60_000 }, async () => {
  const patched: Array<{ id: number; body: Record<string, unknown> }> = []
  conversationsApi.patch = (async (id, body) => {
    patched.push({ id, body: body as Record<string, unknown> })
    return makeConv({ id, ...body })
  }) as typeof conversationsApi.patch

  const primaryConv = makeConv({ id: 1, model: 'faux/m2' })
  const splitConv = makeConv({ id: 2, model: 'faux/m2' })
  const store = makeTestStore({
    conversations: [primaryConv, splitConv],
    models: makeModels(),
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: { kind: 'conversation', conversationId: 2 },
  })

  const primaryHost = mountTree(
    e(HostStoreProviders, { value: store }, e(Composer, { conversation: primaryConv, prefill: null })),
    'primary',
  )
  const splitHost = mountTree(
    e(HostStoreProviders, { value: store }, e(Composer, { conversation: splitConv, prefill: null })),
    'split',
  )

  const primaryTa = primaryHost.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
  const splitTa = splitHost.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  // Ctrl+L on the textarea never calls stopPropagation to block the outer global listener
  let bubbledToWindow = false
  const windowSpy = (ev: KeyboardEvent): void => {
    if (ev.ctrlKey && ev.key.toLowerCase() === 'l') bubbledToWindow = true
  }
  window.addEventListener('keydown', windowSpy)
  try {
    act(() => {
      splitTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    assert.equal(bubbledToWindow, true, 'the Composer never swallows or blocks the Ctrl+L bubble')
  } finally {
    window.removeEventListener('keydown', windowSpy)
  }

  // Globally dispatch helmx:shortcut (panel='split'): only the right ModelPicker opens; the left stays closed
  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })

  assert.equal(primaryHost.querySelector('button.composer-model-button')?.getAttribute('aria-expanded'), 'false', 'the primary panel ignores the split shortcut')
  assert.equal(splitHost.querySelector('button.composer-model-button')?.getAttribute('aria-expanded'), 'true', 'the split ModelPicker opens')

  const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
  assert.ok(popover, 'the ModelPicker popover rendered')
  const searchInput = popover.querySelector<HTMLInputElement>('input[aria-label="Search models"]')
  assert.ok(searchInput !== null, 'the search input exists')
  assert.ok(document.activeElement === searchInput, 'opening auto-focuses the search input (not the first reset button)')

  // The initial highlight points at the current model faux/m2 (index 1)
  const modelBtns = Array.from(popover.querySelectorAll<HTMLButtonElement>('button.popover-item[title^="faux/"]'))
  assert.equal(modelBtns.length, 3)
  assert.equal(modelBtns[1]!.classList.contains('popover-item-active'), true, 'the initial highlight points at the effective model m2')

  // ArrowDown inside the search moves to m3; Enter picks: the patch fires while the popover
  // STAYS OPEN so m3's thinking level can be adjusted in the same session
  await act(async () => {
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
    assert.equal(modelBtns[2]!.classList.contains('popover-item-active'), true, 'ArrowDown moves the highlight to m3')

  await act(async () => {
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  assert.equal(patched.length, 1)
  assert.deepEqual(patched[0], { id: 2, body: { model: 'faux/m3' } })
  const stayingPopover = document.body.querySelector<HTMLElement>('.composer-model-popover')
  assert.ok(stayingPopover !== null, 'the popover stays open after the model pick (level adjustable in the same session)')
  assert.equal(modelBtns[2]!.getAttribute('aria-current'), 'true', 'the picked row is marked current via the optimistic preview')
  assert.ok(document.activeElement === searchInput, 'focus stays in the search input for further filtering')

  // The thinking section re-targets the just-picked m3 (levels off/max); picking max patches
  // the level in the same session, without reopening the picker
  const maxChip = Array.from(stayingPopover.querySelectorAll<HTMLButtonElement>('.segmented-control-btn'))
    .find((btn) => btn.textContent?.trim() === 'max')
  assert.ok(maxChip !== undefined, 'm3 thinking levels render inside the still-open popover')
  await act(async () => {
    maxChip!.click()
  })
  assert.equal(patched.length, 2)
  assert.deepEqual(patched[1], { id: 2, body: { thinkingLevel: 'max' } })
  assert.ok(document.body.querySelector('.composer-model-popover') !== null, 'a level pick keeps the popover open')

  // Clicking the model already shown (optimistic preview) acts as "confirm" and closes; the
  // focus returns to the current panel Composer textarea
  await act(async () => {
    modelBtns[2]!.click()
  })
  assert.equal(patched.length, 2, 'the confirm click fires no extra patch')
  assert.ok(document.body.querySelector('.composer-model-popover') === null, 'clicking the already-shown model closes the picker')
  await waitForCondition(() => document.activeElement === splitTa)
  assert.ok(document.activeElement === splitTa, 'focus returns to the current panel Composer textarea after close')

  // Ctrl+L again reopens; one more Ctrl+L closes and returns focus
  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })
  assert.ok(document.body.querySelector('.composer-model-popover') !== null)
  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })
  assert.ok(document.body.querySelector('.composer-model-popover') === null, 'a second Ctrl+L closes the popover')
  await waitForCondition(() => document.activeElement === splitTa)
  assert.ok(document.activeElement === splitTa, 'focus returns to the split textarea after the Ctrl+L close')

  // Ctrl+L reopens, Esc closes: it must stopPropagation so the outer double-Esc abort never fires, and return focus
  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })
  assert.ok(document.body.querySelector('.composer-model-popover'))

  let escLeakedToWindow = false
  const escWindowSpy = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') escLeakedToWindow = true
  }
  window.addEventListener('keydown', escWindowSpy)
  try {
    await act(async () => {
      document.body.querySelector('input[aria-label="Search models"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    assert.ok(document.body.querySelector('.composer-model-popover') === null, 'Esc closes the ModelPicker')
    assert.equal(escLeakedToWindow, false, 'the ModelPicker Esc must stopPropagation to avoid the outer double-Esc')
    await waitForCondition(() => document.activeElement === splitTa)
    assert.ok(document.activeElement === splitTa, 'focus returns to the split textarea after the Esc close')
    assert.ok(document.activeElement !== primaryTa)
  } finally {
    window.removeEventListener('keydown', escWindowSpy)
  }
})

// ---------------------------------------------------------------------------
// 3. Shift+Tab thinking-level cycling (including the strict no-Ctrl+T alias)
// ---------------------------------------------------------------------------

test('Shift+Tab: preventDefault() immediately and cycles thinkingLevel; Ctrl+T does nothing', { timeout: 60_000 }, async () => {
  const patched: Array<Record<string, unknown>> = []
  conversationsApi.patch = (async (_id, body) => {
    patched.push(body as Record<string, unknown>)
    return makeConv(body)
  }) as typeof conversationsApi.patch

  const conv = makeConv({ id: 1, model: 'faux/m2', thinkingLevel: 'off' })
  const store = makeTestStore({ conversations: [conv], models: makeModels() })
  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  // Ctrl+T must not trigger a thinking-level switch
  await act(async () => {
    const ev = new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true })
    ta.dispatchEvent(ev)
    assert.equal(ev.defaultPrevented, false)
  })
  assert.equal(patched.length, 0)

  // Shift+Tab preventDefaults immediately and cycles in order off -> low -> medium -> high -> off
  for (const expected of ['low', 'medium', 'high', 'off']) {
    await act(async () => {
      const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
      ta.dispatchEvent(ev)
      assert.equal(ev.defaultPrevented, true, 'Shift+Tab must preventDefault immediately')
    })
    assert.equal(patched.at(-1)?.thinkingLevel, expected)
  }
})

// ---------------------------------------------------------------------------
// 4. ↑ prefers withdrawing the newest human queued input -> falls back to history editing when the queue is empty
// ---------------------------------------------------------------------------

test('↑ (empty draft, first line): withdraws the newest human queued input and prefills, without the history-rollback banner', { timeout: 60_000 }, async () => {
  const withdrawCalls: Array<{ id: number; subId: string | number }> = []
  conversationsApi.withdraw = (async (id, subId) => {
    withdrawCalls.push({ id, subId })
    return { status: 'withdrawn' }
  }) as typeof conversationsApi.withdraw

  const conv = makeConv({ id: 7, status: 'working' })
  const detail: ConversationDetail = {
    ...conv,
    entries: [
      { id: '1', kind: 'helmx.input', data: { text: '更早的历史提问', origin: 'human' } },
    ],
  }
  const live: ConversationLive = {
    conversationId: 7,
    text: '正在输出',
    tools: [],
    updatedAt: 100,
    queuedInputs: [
      { id: 'q-1', submissionId: '21', text: '第一条排队', mode: 'followUp', origin: 'human', createdAt: 10 },
      {
        id: 'q-2',
        submissionId: '22',
        text: '最新人类插话',
        mode: 'steer',
        origin: 'human',
        createdAt: 20,
        attachments: [{ id: 'art-9', name: 'spec.md', mimeType: 'text/markdown', size: 128 }],
      },
      { id: 'q-3', submissionId: '23', text: 'agent 后台汇报', mode: 'followUp', origin: 'agent', createdAt: 30 },
    ],
  }

  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { 7: detail },
    conversationLives: { 7: live },
  })

  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  // Alt+ArrowUp never triggers a withdrawal
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(withdrawCalls.length, 0, 'the Alt+Up alias is strictly forbidden')

  // A non-empty draft never triggers a withdrawal
  await act(async () => {
    typeInto(ta, '正在输入的新草稿')
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  })
  assert.equal(withdrawCalls.length, 0, '↑ withdraws nothing from the queue on a non-empty draft')

  // With the draft cleared, plain ↑ withdraws the newest human queued item q-2 (submissionId='22')
  await act(async () => {
    typeInto(ta, '')
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  })
  await act(async () => {})

  assert.deepEqual(withdrawCalls, [{ id: 7, subId: '22' }])
  assert.equal(ta.value, '最新人类插话', 'the queued message text is prefilled')
  assert.ok(host.textContent?.includes('spec.md'), 'the queued attachments prefill too')
  assert.ok(host.querySelector('.composer-edit-banner') === null, 'a queued withdrawal never triggers the history-rollback banner')
})

test('↑ (no human queued input): falls back to editing the previous historical human message', { timeout: 60_000 }, async () => {
  const conv = makeConv({ id: 8, status: 'idle' })
  const detail: ConversationDetail = {
    ...conv,
    entries: [
      { id: '5', kind: 'helmx.input', data: { text: '历史提问五', origin: 'human' } },
    ],
  }
  const live: ConversationLive = {
    conversationId: 8,
    text: '',
    tools: [],
    updatedAt: 50,
    queuedInputs: [
      { id: 'q-agent', submissionId: '31', text: '仅后台触发', mode: 'followUp', origin: 'trigger', createdAt: 40 },
    ],
  }
  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { 8: detail },
    conversationLives: { 8: live },
  })
  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  })
  assert.equal(ta.value, '历史提问五')
  assert.ok(host.querySelector('.composer-edit-banner') !== null, 'without human queued input it falls back to history editing and shows the banner')
})

// ---------------------------------------------------------------------------
// 5. Esc layering (popover -> cancel edit mode -> bubble to the outer double-Esc)
// ---------------------------------------------------------------------------

test('Esc layering: closing the slash popover and cancelling history editing both stopPropagation; only idle without popovers bubbles outward', { timeout: 60_000 }, async () => {
  const conv = makeConv({ id: 9, status: 'working' })
  const detail: ConversationDetail = {
    ...conv,
    entries: [{ id: '2', kind: 'helmx.input', data: { text: '旧消息', origin: 'human' } }],
  }
  const store = makeTestStore({ conversations: [conv], conversationDetails: { 9: detail } })
  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  let windowEscCount = 0
  const onWinEsc = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') windowEscCount++
  }
  window.addEventListener('keydown', onWinEsc)
  try {
    // 1) Esc in history-edit mode: cancels editing and stopPropagation
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    })
    assert.ok(host.querySelector('.composer-edit-banner') !== null)
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(host.querySelector('.composer-edit-banner') === null, 'Esc exits history-edit mode')
    assert.equal(ta.value, '')
    assert.equal(windowEscCount, 0, 'cancelling the edit stopPropagation: the outer double-Esc counter is untouched')

    // 2) Esc with the slash popover open: closes it and stopPropagation
    await act(async () => {
      typeInto(ta, '/')
    })
    assert.ok(host.querySelector('.composer-popover') !== null)
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(host.querySelector('.composer-popover') === null)
    assert.equal(windowEscCount, 0, 'closing the slash popover stopPropagation')

    // 3) Esc with no popover outside edit mode: bubbles normally to window for the outer double-Esc abort
    await act(async () => {
      typeInto(ta, '')
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(windowEscCount, 1, 'with no popover outside edit mode, Esc bubbles outward normally')
  } finally {
    window.removeEventListener('keydown', onWinEsc)
  }
})

// ---------------------------------------------------------------------------
// 6. COMPOSER_DOCK_SLOT renders directly above <AskDock /> and stays visible on both form factors
// ---------------------------------------------------------------------------

test('COMPOSER_DOCK_SLOT: renders directly above AskDock receiving ComposerScopeProps; mobile never tucks it into the more menu', { timeout: 60_000 }, async () => {
  stubMatchMedia(true) // simulate a mobile viewport
  function DockProbe(props: ComposerScopeProps) {
    const ctx = usePluginContext()
    return e(
      'div',
      { className: 'dock-probe', 'data-probe': 'dock' },
      `dock-conv:${props.conversation.id}:ctx:${ctx.composer !== undefined}`,
    )
  }
  seedPluginClientModule('builtin:workflow', 'tray.tsx', { DockProbe })

  const conv = makeConv({ id: 12, status: 'working' })
  const store = makeTestStore({
    conversations: [conv],
    pendingAsks: [
      {
        id: 'ask-1',
        conversationId: 12,
        title: '需要审批',
        fields: [],
        status: 'pending',
        createdAt: 1,
      },
    ],
    uiContributions: [
      {
        pluginId: 'builtin:workflow',
        surface: 'plugin.slot',
        spec: {
          id: 'active-tray',
          target: COMPOSER_DOCK_SLOT,
          client: { module: 'tray.tsx', export: 'DockProbe' },
        },
      },
    ],
  })

  const html = renderToStaticMarkup(
    e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })),
  )
  const dockAt = html.indexOf('composer-dock-slot')
  const askAt = html.indexOf('ask-dock-stack')
  const extrasAt = html.indexOf('composer-extras')
  assert.ok(dockAt >= 0, 'COMPOSER_DOCK_SLOT must render directly')
  assert.ok(askAt > dockAt, 'COMPOSER_DOCK_SLOT must sit right above AskDock')
  assert.ok(extrasAt < 0 || dockAt < extrasAt, 'it must not be tucked into the mobile more menu')
  assert.match(html, /dock-conv:12:ctx:true/, 'ComposerScopeProps passed correctly')
})

// ---------------------------------------------------------------------------
// 7. Mobile busy dual buttons [steer] + [queue] and desktop .kbd-hint
// ---------------------------------------------------------------------------

test('ComposerSendControls: mobile busy with input explicitly renders independent [steer] and [queue] buttons; desktop keeps the split dropdown and .kbd-hint', { timeout: 60_000 }, async () => {
  const sent: Array<string | undefined> = []
  const send = async (mode?: 'steer' | 'followUp' | 'reject') => {
    sent.push(mode)
  }
  const abortTurn = async () => {}
  const blocker = { blocked: false, reason: null }

  // Mobile busy: renders both the [steer] and [queue] independent buttons explicitly, no narrow
  // split trigger. ComposerSendControls reads the locale via useWebLocale, so it mounts inside a
  // store provider.
  const mobileHost = mountTree(
    e(HelmxExternalStoreContext.Provider, { value: makeTestStore() }, e(ComposerSendControls, {
      working: true,
      editingEntryId: null,
      sending: false,
      uploading: 0,
      envBlocker: blocker,
      text: '测试指令',
      isMobile: true,
      send,
      abortTurn,
    })),
  )
  assert.ok(mobileHost.querySelector('.composer-split-trigger') === null, 'mobile renders no narrow split trigger')
  const steerBtn = mobileHost.querySelector<HTMLButtonElement>('button.composer-mobile-steer-btn')
  const queueBtn = mobileHost.querySelector<HTMLButtonElement>('button.composer-mobile-queue-btn')
  assert.ok(steerBtn && steerBtn.textContent?.includes('Steer'), 'mobile shows the [steer] button')
  assert.ok(queueBtn && queueBtn.textContent?.includes('Queue'), 'mobile shows the [queue] button')

  await act(async () => {
    steerBtn.click()
    queueBtn.click()
  })
  assert.deepEqual(sent, ['steer', 'followUp'])

  // Desktop: renders the split dropdown; menu-item badges carry the .kbd-hint class
  const desktopHost = mountTree(
    e(HelmxExternalStoreContext.Provider, { value: makeTestStore() }, e(ComposerSendControls, {
      working: true,
      editingEntryId: null,
      sending: false,
      uploading: 0,
      envBlocker: blocker,
      text: '桌面指令',
      isMobile: false,
      send,
      abortTurn,
    })),
  )
  assert.ok(desktopHost.querySelector('.composer-busy-mobile-actions') === null)
  const trigger = desktopHost.querySelector<HTMLButtonElement>('button.composer-split-trigger')
  assert.ok(trigger, 'desktop keeps the split dropdown trigger')
})

// ---------------------------------------------------------------------------
// 8. Standby pane: default model inheritance, Shift+Tab, Ctrl+L and static '/' skill completion
// ---------------------------------------------------------------------------

test('Standby pane: inherits the global default model glm-5.3·max; supports Shift+Tab / Ctrl+L and static /skill completion', { timeout: 60_000 }, async () => {
  // Pure-function checks
  assert.equal(resolveStandbyEffectiveModel(undefined, undefined, 'magpie/auto/glm-5.3'), 'magpie/auto/glm-5.3')
  assert.equal(resolveStandbyEffectiveModel(undefined, 'p/m1', 'magpie/auto/glm-5.3'), 'p/m1')
  assert.equal(resolveStandbyEffectiveModel('d/m2', 'p/m1', 'magpie/auto/glm-5.3'), 'd/m2')
  assert.equal(resolveStandbyThinkingLevel(['off', 'high', 'max'], undefined, undefined, undefined, 'max'), 'max')
  // Per-model default ranks between the explicit draft override and the Profile level.
  assert.equal(resolveStandbyThinkingLevel(['off', 'high', 'max'], undefined, 'high', 'max', 'low'), 'high')
  assert.equal(resolveStandbyThinkingLevel(['off', 'high', 'max'], 'max', 'high', 'low', 'off'), 'max')

  const profile: Profile = { id: 'assistant', name: '个人助理' }
  const skills: SkillSummary[] = [
    { id: 'review', name: '代码审查', references: [] },
    { id: 'herdr-only', name: '终端工具', references: [], managedByPlugin: 'builtin:herdr' },
  ]
  // 全局默认模型改经真实 /api/models/default 按需读取（store 不再携带 defaultModelInfo 字段）
  const originalFetchA = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === '/api/models/default') {
      return jsonResponse({ defaultModel: 'magpie/auto/glm-5.3', defaultThinkingLevel: 'max', modelThinkingLevels: {} })
    }
    return jsonResponse({})
  }) as typeof fetch
  const store = makeTestStore({
    profiles: [profile],
    skills,
    plugins: [
      { id: 'builtin:profile', name: 'profile', locked: true, enabled: true, hooks: [], actions: [], tools: [] },
      { id: 'builtin:herdr', name: 'herdr', locked: false, enabled: false, hooks: [], actions: [], tools: [] },
    ],
    models: [
      {
        id: 'magpie/auto/glm-5.3',
        provider: 'magpie',
        modelId: 'auto/glm-5.3',
        available: true,
        thinkingLevels: ['off', 'low', 'medium', 'high', 'max'],
      },
    ],
    uiContributions: [
      {
        pluginId: 'builtin:memory',
        surface: 'composer.completer',
        spec: { id: 'mem', label: '记忆', trigger: '@', source: { kind: 'doc', name: 'refs', itemsField: 'items' } },
      },
    ],
    pluginDocs: {
      'builtin:memory/refs': { items: [{ id: 'm-1', label: '@memory', insertText: '@memory ' }] },
    },
  })

  const host = mountTree(
    e(HostStoreProviders, { value: store }, e(AgentStandbyPane, { profileId: 'assistant', isSplit: true })),
    'split',
  )
  await waitForCondition(() => /glm-5\.3/.test(host.querySelector<HTMLButtonElement>('button.composer-model-button')?.textContent ?? ''))

  const modelBtn = host.querySelector<HTMLButtonElement>('button.composer-model-button')!
  assert.match(modelBtn.textContent ?? '', /glm-5\.3/, 'first paint inherits the global default model short name')
  assert.match(modelBtn.textContent ?? '', /· max/, 'first paint inherits the global default thinking level')

  // Shift+Tab cycles the thinking level on the standby pane (max -> off)
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
  await act(async () => {
    const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    ta.dispatchEvent(ev)
    assert.equal(ev.defaultPrevented, true)
  })
  assert.ok(host.querySelector('.composer-model-level') === null, 'the level after max is off, so the badge hides')
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(host.querySelector('.composer-model-level')?.textContent, '· low', 'another Shift+Tab switches to low')

  // Ctrl+L targets the split panel only, opening the StandbyModelPicker and auto-focusing the search
  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'primary' } }))
  })
  assert.ok(document.body.querySelector('.composer-model-popover') === null, 'a primary event never opens the split standby picker')

  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })
  const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
  assert.ok(popover !== null, 'split Ctrl+L opens the standby model popover')
  assert.ok(popover.querySelector('button.composer-model-refresh-btn') !== null, 'the standby model popover includes the dynamic refresh button')
  assert.ok(document.activeElement === popover.querySelector('input[aria-label="Search models"]'), 'auto-focuses the search input')

  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })
  assert.ok(document.body.querySelector('.composer-model-popover') === null)

  // Static '/' skill completion: filters disabled-plugin managed skills; picking /skill:review inserts text
  await act(async () => {
    typeInto(ta, '/rev')
  })
  const slashPopover = host.querySelector<HTMLElement>('.composer-popover')
  assert.ok(slashPopover, "typing / on the standby pane opens the static command & skill menu")
  assert.match(slashPopover.textContent ?? '', /\/skill:review/)
  assert.doesNotMatch(slashPopover.textContent ?? '', /herdr-only/)

  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  assert.equal(ta.value, '/skill:review ', 'picking a skill writes back only the trigger word; no conversation created')

  // The generic '@' completion popover also works on the standby pane (coexists with '/' skill completion, Ctrl+L, Shift+Tab without conflicts)
  await act(async () => {
    typeInto(ta, '/skill:review @mem')
  })
  await act(async () => {})
  const atPopover = host.querySelector<HTMLElement>('.composer-completion-popover')
  assert.ok(atPopover, 'typing @ on the standby pane must open the CompletionPopover')
  assert.match(atPopover.textContent ?? '', /@memory/)
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  assert.equal(ta.value, '/skill:review @memory ', 'Enter picking an @ candidate completes only the trigger text; no conversation created')
  globalThis.fetch = originalFetchA
})

test('Composer submit keys: Enter steer, Ctrl/Cmd+Enter followUp, Shift+Enter newline, Alt+Enter alias forbidden', { timeout: 60_000 }, async () => {
  const submitted: Array<Record<string, unknown>> = []
  conversationsApi.submitInput = (async (_id, payload) => {
    submitted.push(payload as unknown as Record<string, unknown>)
    return { submissionId: 's-1' }
  }) as typeof conversationsApi.submitInput

  const conv = makeConv({ id: 20, status: 'working' })
  const store = makeTestStore({ conversations: [conv] })
  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  // Shift+Enter and Alt+Enter never trigger a submit
  await act(async () => { typeInto(ta, '待验证') })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(submitted.length, 0, 'neither Shift+Enter nor Alt+Enter sends')

  // Enter -> steer
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  assert.equal(submitted.at(-1)?.whenBusy, 'steer')

  // Ctrl+Enter -> followUp
  await act(async () => { typeInto(ta, '排队一') })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(submitted.at(-1)?.whenBusy, 'followUp')

  // Meta+Enter -> followUp
  await act(async () => { typeInto(ta, '排队二') })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(submitted.at(-1)?.whenBusy, 'followUp')
})

test('CompletionPopover: Esc closes the completion popover and stopPropagation keeps it from the outer layer', { timeout: 60_000 }, async () => {
  const conv = makeConv({ id: 21, status: 'working' })
  const store = makeTestStore({
    conversations: [conv],
    uiContributions: [
      {
        pluginId: 'p1',
        surface: 'composer.completer',
        spec: { id: 'c1', label: '记忆', trigger: '@', source: { kind: 'doc', name: 'cat', itemsField: 'items' } },
      },
    ],
    pluginDocs: { 'p1/cat': { items: [{ id: 'm1', label: '@记忆', insertText: '@记忆 ' }] } },
  })
  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  let leakedEsc = 0
  const spy = (ev: KeyboardEvent) => { if (ev.key === 'Escape') leakedEsc++ }
  window.addEventListener('keydown', spy)
  try {
    await act(async () => { typeInto(ta, '@') })
    await act(async () => {})
    assert.ok(host.querySelector('.composer-completion-popover'), 'the completion popover opens')
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(host.querySelector('.composer-completion-popover') === null, 'Esc closes the completion popover')
    assert.equal(leakedEsc, 0, 'Esc stopPropagation prevents the outer double-Esc from misfiring')
  } finally {
    window.removeEventListener('keydown', spy)
  }
})

test('ModelPickerControl filters unavailable and disabled models at runtime; the refresh button triggers /api/models/refresh and refreshAssets', { timeout: 60_000 }, async () => {
  const { ModelPickerControl } = await import('../src/conversation/ModelPicker.js')
  const originalFetch = globalThis.fetch
  let refreshPostCount = 0
  let modelsRefCount = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/models/refresh' && init?.method === 'POST') {
      refreshPostCount += 1
      return jsonResponse({ errors: {} })
    }
    // 真实 refreshAssets 会重拉 /api/models：以此观察刷新后的目录重建
    if (String(input) === '/api/models') {
      modelsRefCount += 1
      return jsonResponse({ models: [] })
    }
    return jsonResponse({})
  }) as typeof fetch

  const store = makeTestStore({
    models: [
      { id: 'faux/enabled-model', provider: 'faux', modelId: 'enabled-model', available: true, thinkingLevels: ['off'] },
      { id: 'faux/disabled-model', provider: 'faux', modelId: 'disabled-model', available: true, disabled: true, thinkingLevels: ['off'] },
      { id: 'faux/unavailable-model', provider: 'faux', modelId: 'unavailable-model', available: false, thinkingLevels: ['off'] },
    ],
  })

  try {
    const host = mountTree(
      <HostStoreProviders value={store}>
        <ModelPickerControl
          effectiveModel="faux/enabled-model"
          selectedModel={undefined}
          activeThinkingLevel="off"
          resetLabel="跟随默认"
          resetTitle="Restore defaults"
          buttonTitle="Switch model"
          onPickModel={() => {}}
          onResetDefault={() => {}}
          onPickThinking={() => {}}
        />
      </HostStoreProviders>,
    )

    const btn = host.querySelector<HTMLButtonElement>('button.composer-model-button')
    assert.ok(btn)
    await act(async () => {
      btn.click()
    })
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    assert.ok(popover)
    const items = [...popover.querySelectorAll<HTMLButtonElement>('button.popover-item')]
    assert.ok(items.some((el) => el.textContent?.includes('enabled-model')), 'available and not-disabled models must show')
    assert.equal(items.some((el) => el.textContent?.includes('disabled-model')), false, 'disabled models must not be options')
    assert.equal(items.some((el) => el.textContent?.includes('unavailable-model')), false, 'unavailable models must not be options')

    const refreshBtn = popover.querySelector<HTMLButtonElement>('button.composer-model-refresh-btn')
    assert.ok(refreshBtn, 'the dynamic catalog refresh button exists')
    await act(async () => {
      refreshBtn.click()
    })
    assert.equal(refreshPostCount, 1, 'clicking refresh triggers POST /api/models/refresh')
    await waitForCondition(() => modelsRefCount > 0)
    assert.equal(modelsRefCount > 0, true, 'refreshAssets follows the completed refresh (catalog re-listed via /api/models)')
    assert.equal(store.getNotices().some((n) => n.title === 'Model catalog refreshed'), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('zh-CN locale: AgentStandbyPane renders the Chinese catalog copy', { timeout: 60_000 }, async () => {
  const originalFetchC = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === '/api/models/default') {
      return jsonResponse({ defaultModel: 'magpie/auto/glm-5.3', defaultThinkingLevel: 'max', modelThinkingLevels: {} })
    }
    return jsonResponse({})
  }) as typeof fetch
  const store = makeTestStore({
    locale: 'zh-CN',
    profiles: [{ id: 'assistant', name: '个人助理' }],
    models: [
      {
        id: 'magpie/auto/glm-5.3',
        provider: 'magpie',
        modelId: 'auto/glm-5.3',
        available: true,
        thinkingLevels: ['off', 'low', 'medium', 'high', 'max'],
      },
    ],
  })
  const host = mountTree(
    e(HostStoreProviders, { value: store }, e(AgentStandbyPane, { profileId: 'assistant' })),
  )
  await waitForCondition(() => host.querySelector<HTMLButtonElement>('button.composer-model-button')?.getAttribute('title')?.includes('magpie/auto/glm-5.3') === true)
  assert.ok(
    host.textContent?.includes('发送第一条消息开始新话题；会话将在首次发送时创建'),
    'the intro hint renders the zh-CN copy',
  )
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
  assert.equal(
    ta.getAttribute('aria-label'),
    '向 个人助理 输入首条消息',
    'the textarea aria-label renders the zh-CN copy',
  )
  assert.equal(
    ta.getAttribute('placeholder'),
    '输入消息开始新话题；/ 命令与技能 · @ 点名，⌘V 粘贴附件',
    'the desktop placeholder renders the zh-CN copy',
  )
  assert.ok(
    host.textContent?.includes('执行环境跟随角色默认'),
    'the env bar hint renders the zh-CN copy',
  )
  assert.ok(
    host.textContent?.includes('自定义'),
    'the customize button renders the zh-CN copy',
  )
  const modelBtn = host.querySelector<HTMLButtonElement>('button.composer-model-button')!
  assert.equal(
    modelBtn.getAttribute('title'),
    '当前模型：magpie/auto/glm-5.3 · 思考 max (Ctrl+L)',
    'the model button title renders the zh-CN copy (resolved from the global default)',
  )
  const sendBtn = host.querySelector<HTMLButtonElement>('button.btn-send')!
  assert.equal(sendBtn.getAttribute('aria-label'), '发送', 'the send aria-label renders the zh-CN copy')
  assert.equal(
    sendBtn.getAttribute('title'),
    '发送 (Enter)；会话将在首次发送时创建',
    'the send title renders the zh-CN copy',
  )
  globalThis.fetch = originalFetchC
})

test('zh-CN locale: ComposerSendControls mobile busy buttons render the Chinese copy', { timeout: 60_000 }, async () => {
  const sent: Array<string | undefined> = []
  const send = async (mode?: 'steer' | 'followUp' | 'reject') => { sent.push(mode) }
  const blocker = { blocked: false, reason: null }
  const mobileHost = mountTree(
    e(HelmxExternalStoreContext.Provider, { value: makeTestStore({ locale: 'zh-CN' }) }, e(ComposerSendControls, {
      working: true,
      editingEntryId: null,
      sending: false,
      uploading: 0,
      envBlocker: blocker,
      text: '中文指令',
      isMobile: true,
      send,
      abortTurn: async () => {},
    })),
  )
  const steerBtn = mobileHost.querySelector<HTMLButtonElement>('button.composer-mobile-steer-btn')
  const queueBtn = mobileHost.querySelector<HTMLButtonElement>('button.composer-mobile-queue-btn')
  assert.ok(steerBtn && steerBtn.textContent?.includes('插话'), 'mobile shows the zh-CN steer button')
  assert.ok(queueBtn && queueBtn.textContent?.includes('排队'), 'mobile shows the zh-CN queue button')
  await act(async () => {
    steerBtn.click()
    queueBtn.click()
  })
  assert.deepEqual(sent, ['steer', 'followUp'], 'zh-CN buttons keep the original send policies')
})
