/**
 * Shared trigger-popover and auto-grow hooks for the input area (used by both
 * the conversation Composer and the standby draft StandbyComposer):
 * - '/' opens the CommandPopover (commands and skills); '@' '#' ':' open the
 *   CompletionPopover (composerCompleter plugin sources);
 * - unified handling of input and caret movement (arrows / click) trigger
 *   detection, token replacement, caret restoration, switch/clear/disable
 *   resets and keyboard interception;
 * - unified ResizeObserver auto-growing so the two input areas never maintain
 *   forked logic.
 * This module exports only hooks / pure functions / TS types (no components),
 * honoring the .ts Fast Refresh rule.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ComposerCompleterSpec, ConversationSummary } from '@helm/protocol/browser'
import type { QualifiedUiSpec } from '../lib/types.js'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { replaceSlashToken } from '../lib/commands-model.js'
import {
  detectCompletionToken,
  replaceTriggerToken,
  type CompletionToken,
  type MergedCompletionItem,
} from './composer-completion-model.js'
import { focusWithCaret } from './composer-controller.js'
import { useComposerCompletionSources, type CompletionSourceSnapshot } from './use-composer-completion.js'

/** Auto-adjust the textarea height to its content and container width. */
export function autoGrowTextarea(el: HTMLTextAreaElement | null): void {
  if (el === null) return
  el.style.height = '0px'
  el.style.height = `${el.scrollHeight}px`
}

/** Invoke the callback when the element's width changes (ResizeObserver), so
 * the textarea height never lags in split views or on window resizes. */
export function useElementWidthResize(
  ref: { current: HTMLElement | null },
  onResize: () => void,
): void {
  const onResizeStable = useStableCallback(onResize)
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      onResizeStable()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, onResizeStable])
}

export interface UseComposerPopoversInput {
  textareaRef: { current: HTMLTextAreaElement | null }
  draftText: string
  readLiveDraft: () => string
  setDraftState: (next: string) => void
  completers: ReadonlyArray<QualifiedUiSpec<ComposerCompleterSpec>>
  /** A real conversation (or an anchored standby conversation); undefined for
   * the pure draft state. */
  conversation: ConversationSummary | undefined
  /** Standby draft profile id (for action completion sources supporting
   * profileId when no conversation exists). */
  profileId?: string
  /** Switch key for the conversation or standby coordinate: any change closes
   * all popovers immediately and cancels in-flight queries. */
  resetKey: string | number
  /** States that forbid popover opening (read-only / sending). */
  disabled?: boolean
}

export interface UseComposerPopoversResult {
  slashOpen: boolean
  popoverQuery: string
  completionOpen: boolean
  completionTrigger: '@' | '#' | ':'
  completionSnapshot: CompletionSourceSnapshot
  detectPopover: (value: string, caret: number) => void
  handleTextareaKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  handleTextareaClick: (e: React.MouseEvent<HTMLTextAreaElement>) => void
  shouldDeferKeyToPopover: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  applySlashPick: (apply: string) => void
  closeSlashPopover: () => void
  applyCompletionPick: (entry: MergedCompletionItem) => void
  closeCompletionPopover: () => void
  resetPopovers: () => void
}

export function useComposerPopovers(input: UseComposerPopoversInput): UseComposerPopoversResult {
  const {
    textareaRef,
    draftText,
    readLiveDraft,
    setDraftState,
    completers,
    conversation,
    profileId,
    resetKey,
    disabled = false,
  } = input
  const [popover, setPopover] = useState<'slash' | null>(null)
  const [popoverQuery, setPopoverQuery] = useState('')
  const [completionToken, setCompletionToken] = useState<CompletionToken | null>(null)

  const resetPopovers = useCallback((): void => {
    setPopover(null)
    setPopoverQuery('')
    setCompletionToken(null)
  }, [])

  useEffect(() => {
    resetPopovers()
  }, [resetKey, resetPopovers])

  useEffect(() => {
    if (disabled || draftText === '') resetPopovers()
  }, [disabled, draftText, resetPopovers])

  // Trigger detection: '/' opens the slash-command popover; '@' '#' ':' open
  // the unified plugin completion popover.
  const detectPopover = useCallback((value: string, caret: number): void => {
    if (disabled) return
    const token = detectCompletionToken(value.slice(0, caret))
    if (token === null) {
      resetPopovers()
      return
    }
    if (token.trigger === '/') {
      setPopover('slash')
      setPopoverQuery(token.query)
      setCompletionToken(null)
      return
    }
    setPopover(null)
    setPopoverQuery('')
    setCompletionToken(token)
  }, [disabled, resetPopovers])

  const applySlash = (apply: string): void => {
    const el = textareaRef.current
    if (el === null) {
      setPopover(null)
      setPopoverQuery('')
      return
    }
    const currentText = readLiveDraft()
    const caret = el.selectionStart ?? currentText.length
    const { next, nextCaret } = replaceSlashToken(currentText, caret, apply)
    setDraftState(next)
    setPopover(null)
    setPopoverQuery('')
    focusWithCaret(el, nextCaret)
  }

  const applyCompletion = (insertText: string): void => {
    const el = textareaRef.current
    if (el === null) {
      setCompletionToken(null)
      return
    }
    const currentText = readLiveDraft()
    const caret = el.selectionStart ?? currentText.length
    const { next, nextCaret } = replaceTriggerToken(currentText, caret, insertText)
    setDraftState(next)
    setCompletionToken(null)
    focusWithCaret(el, nextCaret)
  }

  // The popover's onPick/onClose feed its global keyboard effect deps: stable
  // outlets that read the latest implementation when invoked.
  const applySlashPick = useStableCallback(applySlash)
  const closeSlashPopover = useStableCallback((): void => {
    setPopover(null)
    setPopoverQuery('')
  })
  const applyCompletionPick = useStableCallback((entry: MergedCompletionItem): void => {
    applyCompletion(entry.item.insertText)
  })
  const closeCompletionPopover = useStableCallback((): void => {
    setCompletionToken(null)
  })

  const completionSnapshot = useComposerCompletionSources({
    token: completionToken,
    completers,
    conversation,
    profileId,
  })
  const slashOpen = popover !== null
  // A popover is truly open = trigger active AND registered sources exist in
  // the current scope; without sources nothing pops up and input is never
  // intercepted.
  const completionOpen = completionSnapshot.hasSources
  const completionTrigger = completionToken !== null && completionToken.trigger !== '/' ? completionToken.trigger : '@'

  const handleTextareaKeyUp = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      detectPopover(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)
    }
  }, [detectPopover])

  const handleTextareaClick = useCallback((e: React.MouseEvent<HTMLTextAreaElement>): void => {
    detectPopover(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)
  }, [detectPopover])

  const shouldDeferKeyToPopover = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean =>
    (slashOpen || completionOpen) &&
    !e.nativeEvent.isComposing &&
    (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape'),
  [slashOpen, completionOpen])

  return {
    slashOpen,
    popoverQuery,
    completionOpen,
    completionTrigger,
    completionSnapshot,
    detectPopover,
    handleTextareaKeyUp,
    handleTextareaClick,
    shouldDeferKeyToPopover,
    applySlashPick,
    closeSlashPopover,
    applyCompletionPick,
    closeCompletionPopover,
    resetPopovers,
  }
}
