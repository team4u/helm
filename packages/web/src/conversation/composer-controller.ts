/**
 * ComposerController live binding hook (the host-side constructor of the
 * protocol's ComposerScopeProps.composer).
 *
 * Design constraints:
 * - the single source of truth is the Composer's React state
 *   (text/attachments/sending) plus textareaRef; the controller is rebuilt
 *   every render (all reads forwarded through refs to the latest values, no
 *   stale closures);
 * - setDraft / insertText follow the same path as user typing: they advance
 *   liveDraftRef, focus and restore the caret when necessary, and preserve
 *   edit-target (historical edit anchor) and attachment semantics as-is;
 * - submit() reuses the host's real send flow (optimistic clear + rollback by
 *   live draft version on failure + whenBusy policy); submit(text) submits
 *   explicit text, consuming no draft / edit anchor / attachments;
 * - this module exports only the hook and pure types (no components), keeping
 *   the .tsx Fast Refresh rule.
 */
import { useCallback, useMemo, useRef } from 'react'
import type { ComposerController, WhenBusy } from '@helmx/protocol/browser'

export interface ComposerControllerBindings {
  /** Current draft text (React state, read during render). */
  text: string
  /** Draft mutation can rewrite synchronously within the same event; reads
   * take the host's latest mirror. */
  readDraft?: () => string
  /** Current pending attachments (React state). */
  attachments: ReadonlyArray<{ artifactId: string; name: string; size: number; mimeType: string }>
  /** Whether a submission is in flight (React state). */
  sending: boolean
  /** textarea element ref. */
  textareaRef: { current: HTMLTextAreaElement | null }
  /** Replace the whole draft (same path as user typing: advances
   * liveDraftRef; never touches the edit anchor or attachments). */
  setDraftState: (text: string) => void
  /**
   * Insert text at the caret (same path as applyPopover): inserts at the
   * current caret and moves it after the fragment by default; focus=false
   * skips stealing focus (e.g. when the host itself moves the caret within an
   * animation frame).
   */
  insertTextState: (fragment: string) => void
  /** Host's real submission flow (reuses send validation / whenBusy /
   * attachments / failure recovery). */
  submitDraft: (whenBusy?: WhenBusy) => Promise<void>
  /** Submit explicit text to the current conversation (consumes no draft /
   * edit anchor / attachments; same sending concurrency guard). */
  submitExplicitText: (text: string, whenBusy?: WhenBusy) => Promise<void>
}

/** Focus the input and place the caret at the given position (focus
 * immediately and position the caret on the next animation frame, once the DOM
 * text update has landed). */
export function focusWithCaret(el: HTMLTextAreaElement, caret: number): void {
  try {
    el.focus()
  } catch {
    /* ignore focus failures when offline or unmounted */
  }
  requestAnimationFrame(() => {
    el.focus()
    el.setSelectionRange(caret, caret)
  })
}

export function useComposerController(bindings: ComposerControllerBindings): ComposerController {
  // Submission in-flight guard: a set synchronized with the host's sendingRef,
  // preventing duplicate submissions in the gap before setState lands.
  const explicitInFlightRef = useRef(false)
  const latest = useRef(bindings)
  latest.current = bindings

  const setDraft = useCallback((text: string) => {
    const b = latest.current
    b.setDraftState(text)
    const el = b.textareaRef.current
    if (el !== null) focusWithCaret(el, text.length)
  }, [])

  const insertText = useCallback((fragment: string) => {
    const b = latest.current
    b.insertTextState(fragment)
  }, [])

  const submit = useCallback((text?: string, options?: { whenBusy?: WhenBusy }) => {
    const b = latest.current
    const whenBusy = options?.whenBusy
    if (text === undefined) return b.submitDraft(whenBusy)
    if (explicitInFlightRef.current) {
      // Same concurrency guard as sending: reject duplicate explicit
      // submissions while in flight; never fake success.
      return Promise.reject(new Error('composer_busy'))
    }
    explicitInFlightRef.current = true
    return b.submitExplicitText(text, whenBusy).finally(() => {
      explicitInFlightRef.current = false
    })
  }, [])

  return useMemo<ComposerController>(() => {
    return {
      get draft() {
        return latest.current.readDraft?.() ?? latest.current.text
      },
      get attachments() {
        return latest.current.attachments.map((a) => ({
          id: a.artifactId,
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
        }))
      },
      get sending() {
        return latest.current.sending
      },
      setDraft,
      insertText,
      submit,
    }
    // Controller reads go through getters forwarding the latest ref, not the
    // bindings identity; the three methods are reference-stable (useCallback
    // with empty deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setDraft, insertText, submit])
}
