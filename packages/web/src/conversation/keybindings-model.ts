/**
 * Pure keyboard-flow logic and panel shortcut event bridging for the Composer
 * / standby pane (single-key muscle memory, zero multi-key aliases).
 *
 * Strictly one function per shortcut:
 * - Ctrl+L: dispatched globally through the host HelmxStoreProvider as a
 *   helmx:shortcut (toggle-model-picker) event; matches data-helmx-panel and
 *   toggles the corresponding panel's ModelPicker;
 * - Shift+Tab: preventDefault() immediately and cycle the thinking level (no
 *   Ctrl+T alias);
 * - ↑: with an empty draft on the first line, prefer withdrawing the newest
 *   human queued input of this conversation; only fall back to history editing
 *   when the queue is empty (no Alt+Up alias);
 * - Enter / Mod+Enter / Shift+Enter: idle send / busy steer / busy followUp /
 *   newline (no Alt+Enter alias);
 * - Esc: close input-area popovers (stopPropagation prevents an outer double-Esc
 *   from aborting by accident) -> cancel history-edit mode -> let the outer
 *   double-Esc abort.
 *
 * This module exports only pure constants, pure functions and one host-event
 * hook (no components), honoring the .tsx Fast Refresh rule.
 */
import { useEffect, useRef } from 'react'
import type { QueuedConversationInput } from '@helmx/protocol/browser'

export type HelmxPanel = 'primary' | 'split'

export const HELMX_SHORTCUT_EVENT = 'helmx:shortcut' as const

export type HelmxShortcutAction = 'toggle-model-picker' | 'toggle-process-groups'

export interface HelmxShortcutEventDetail {
  action: HelmxShortcutAction | string
  panel: HelmxPanel
}

/** Display labels for the one-shortcut-per-function map (for desktop .kbd-hint
 * and tooltips; multi-key aliases are forbidden). */
export const COMPOSER_SHORTCUTS = {
  toggleModelPicker: 'Ctrl+L',
  cycleThinkingLevel: 'Shift+Tab',
  recallQueuedOrHistory: '↑',
  sendOrSteer: 'Enter',
  followUpWhenBusy: '⌘/Ctrl+Enter',
  newline: 'Shift+Enter',
  dismissOrCancelEdit: 'Esc',
} as const

export interface KeyModifiersShape {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/** Strictly match Shift+Tab (no Ctrl/Meta/Alt) so other chords never alias. */
export function isShiftTabEvent(e: KeyModifiersShape): boolean {
  return e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
}

/** Strictly match the plain ↑ key (no Shift/Ctrl/Meta/Alt); Alt+Up and other
 * multi-key aliases are forbidden. */
export function isPlainArrowUpEvent(e: KeyModifiersShape): boolean {
  return e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
}

/** Match the submitting Enter / Mod+Enter (excluding Shift+Enter newline and
 * the illegal Alt+Enter alias). */
export function isComposerSubmitEnterEvent(e: Pick<KeyModifiersShape, 'key' | 'shiftKey' | 'altKey'>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey
}

/** Whether the caret sits on the text's first line (no preceding newline). */
export function isCaretAtFirstLine(value: string, selectionStart: number | null): boolean {
  const pos = Math.max(0, Math.min(value.length, selectionStart ?? 0))
  return !value.slice(0, pos).includes('\n')
}

/** Allow ↑ to trigger queued recall / history-edit prefill only when the draft
 * is empty and the caret is on the first line. */
export function canRecallOnArrowUp(value: string, selectionStart: number | null): boolean {
  return value === '' && isCaretAtFirstLine(value, selectionStart)
}

/**
 * Pick the newest human (origin === 'human') queued input from the current
 * conversation's live.queuedInputs.
 * - Entries from non-human origins (agent / trigger) or without a valid
 *   submissionId are always skipped;
 * - The newest is selected by the greatest createdAt; ties take the queue tail
 *   (last occurrence).
 */
export function latestHumanQueuedInput(
  queuedInputs: ReadonlyArray<QueuedConversationInput> | undefined,
): QueuedConversationInput | undefined {
  if (!Array.isArray(queuedInputs) || queuedInputs.length === 0) return undefined
  let latest: QueuedConversationInput | undefined
  for (const item of queuedInputs) {
    if (
      item === null ||
      item === undefined ||
      item.origin !== 'human' ||
      typeof item.submissionId !== 'string' ||
      item.submissionId === '' ||
      typeof item.text !== 'string'
    ) {
      continue
    }
    if (latest === undefined) {
      latest = item
      continue
    }
    const itemTs = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0
    const latestTs = typeof latest.createdAt === 'number' && Number.isFinite(latest.createdAt) ? latest.createdAt : 0
    if (itemTs >= latestTs) {
      latest = item
    }
  }
  return latest
}

/** Resolve the effective thinking level against the model's capability list
 * (falling back to off or the first supported level by default). */
export function resolveEffectiveThinkingLevel(levels: ReadonlyArray<string>, activeLevel: string): string {
  const fallback = levels.includes('off') ? 'off' : (levels[0] ?? '')
  return levels.includes(activeLevel) ? activeLevel : fallback
}

/**
 * Cycle to the next thinking level on Shift+Tab:
 * - returns null when the model supports a single level or only off (no
 *   meaningless switch requests);
 * - steps in list order, wrapping back to the first item at the end.
 */
export function nextThinkingLevel(levels: ReadonlyArray<string>, currentLevel: string): string | null {
  if (levels.length <= 1) return null
  if (!levels.some((level) => level !== 'off')) return null
  const idx = levels.indexOf(currentLevel)
  if (idx < 0) return levels[0] ?? null
  return levels[(idx + 1) % levels.length] ?? null
}

/** When the ModelPicker opens or its filter changes, the highlight index
 * lands on the effective model first; on a miss, on the first item. */
export function initialModelActiveIndex(
  models: ReadonlyArray<{ id: string }>,
  currentModelId: string | undefined,
): number {
  if (models.length === 0) return -1
  if (currentModelId !== undefined && currentModelId !== '') {
    const idx = models.findIndex((model) => model.id === currentModelId)
    if (idx >= 0) return idx
  }
  return 0
}

/** Step the ModelPicker highlight index cyclically with up/down arrows. */
export function stepActiveIndex(current: number, length: number, delta: 1 | -1): number {
  if (length <= 0) return -1
  if (current < 0 || current >= length) return delta > 0 ? 0 : length - 1
  return (current + delta + length) % length
}

/** Read the owning panel from a DOM ancestor `[data-helmx-panel]`, falling back
 * to `fallback` (default `'primary'`). */
export function resolveElementPanel(
  el: Element | null | undefined,
  fallback: HelmxPanel = 'primary',
): HelmxPanel {
  const attr = el?.closest?.('[data-helmx-panel]')?.getAttribute('data-helmx-panel')
  if (attr === 'primary' || attr === 'split') return attr
  return fallback
}

/** Whether the current component should answer a `helmx:shortcut` event for the
 * target panel (a child-conversation drawer must not mis-answer main-panel
 * shortcuts). */
export function isShortcutPanelMatch(
  el: Element | null | undefined,
  targetPanel: unknown,
  fallback: HelmxPanel = 'primary',
): boolean {
  if (targetPanel !== 'primary' && targetPanel !== 'split') return false
  if (el?.closest?.('.conversation-drawer') && !el?.closest?.('[data-helmx-panel]')) {
    return false
  }
  return resolveElementPanel(el, fallback) === targetPanel
}

/**
 * Listen for window `helmx:shortcut` custom events; the callback fires only
 * when `detail.action` matches and the current DOM's `[data-helmx-panel]` panel
 * matches the event (split views never mis-trigger each other, and nothing is
 * intercepted twice).
 */
export function usePanelShortcut(
  rootRef: { current: Element | null },
  action: HelmxShortcutAction | string,
  handler: () => void,
  fallback: HelmxPanel = 'primary',
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onShortcut = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<HelmxShortcutEventDetail> | undefined>).detail
      if (detail === undefined || detail === null || detail.action !== action) return
      if (!isShortcutPanelMatch(rootRef.current, detail.panel, fallback)) return
      handlerRef.current()
    }
    window.addEventListener(HELMX_SHORTCUT_EVENT, onShortcut)
    return () => window.removeEventListener(HELMX_SHORTCUT_EVENT, onShortcut)
  }, [rootRef, action, fallback])
}
