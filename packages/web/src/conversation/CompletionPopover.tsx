/**
 * composerCompleter plugin-source popover ('@' '#': ':'):
 * - positioning reuses the existing .composer-box relative container plus the
 *   .composer-popover visual class (Radix Popover Anchor, honoring the
 *   WAI-ARIA combobox/listbox contract — not a bare div);
 * - keyboard: ↑↓ cycles only within the visible candidates (fixing the old
 *   12-visible/full-index mismatch), Enter picks, Escape closes; all events
 *   are consumed inside the popover while textarea keeps focus (IME composing
 *   never submits by accident);
 * - distinguishable states: loading (skeleton row) / empty / per-source
 *   errors; truncation states the candidate cap explicitly.
 * Component files export only components and TS types (Fast Refresh rule).
 */
import { useEffect, useRef, useState } from 'react'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { MergedCompletionItem } from './composer-completion-model.js'
import { COMPLETION_VISIBLE_LIMIT } from './composer-completion-model.js'
import type { CompletionSourceSnapshot } from './use-composer-completion.js'
import { Popover, PopoverAnchor, PopoverContent } from '@helmx/plugin-client'

export interface CompletionPopoverProps {
  open: boolean
  /** Trigger symbol (title display and aria-label). */
  trigger: '@' | '#' | ':'
  snapshot: CompletionSourceSnapshot
  /** Picked candidate (replaces only the pre-caret trigger token with insertText). */
  onPick: (item: MergedCompletionItem) => void
  onClose: () => void
  /** Host anchor (.composer-box; Anchor stays mounted, open toggles visibility). */
  anchorRef: { current: HTMLElement | null }
}

export function CompletionPopover({ open, trigger, snapshot, onPick, onClose, anchorRef }: CompletionPopoverProps) {
  const { t } = useWebLocale()
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const visible = snapshot.items.slice(0, COMPLETION_VISIBLE_LIMIT)
  const itemKeys = visible.map((entry) => entry.key).join('|')

  const triggerTitle = trigger === '@'
    ? t('composer.completion.triggerMentions')
    : t('composer.completion.triggerCompletion')

  // Reset the highlight to the first item whenever the candidate set changes
  // (query/source updates).
  useEffect(() => {
    setActiveIndex(0)
  }, [itemKeys])

  // Keyboard navigation: capture-phase global listener (same mechanism as the
  // existing slash popover); never intercept while composing.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      // Do not intercept any key during IME composition (syllables may contain
      // trigger symbols; Enter confirms the composition candidate).
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (visible.length === 0) {
        if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          event.stopPropagation()
          event.stopImmediatePropagation()
        }
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        setActiveIndex((i) => (i + 1) % visible.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        setActiveIndex((i) => (i - 1 + visible.length) % visible.length)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        const item = visible[activeIndex]
        if (item !== undefined) onPick(item)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, visible, activeIndex, onPick, onClose])

  if (!open) return null

  const anchor = anchorRef.current
  if (anchor === null) return null

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <PopoverAnchor virtualRef={{ current: anchor }} />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="composer-popover composer-completion-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.stopPropagation()}
        aria-label={t('composer.completion.candidatesAria', { title: triggerTitle })}
      >
        <div className="popover-header">
          {triggerTitle}
          <span className="kbd-hint popover-kbd-hint">{t('composer.kbd.navConfirmClose')}</span>
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label={t('composer.completion.listAria', { title: triggerTitle })}
          className="composer-completion-list"
        >
          {visible.map((entry, index) => (
            <button
              key={entry.key}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`popover-item${index === activeIndex ? ' popover-item-active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(entry)}
            >
              <span className="mono">{entry.item.label}</span>
              {entry.item.hint !== undefined ? <span className="popover-item-meta">{entry.item.hint}</span> : null}
            </button>
          ))}
          {visible.length === 0 ? (
            snapshot.loading ? (
              <div className="popover-item composer-completion-state" role="status">{t('composer.completion.querying')}</div>
            ) : snapshot.errors.length > 0 ? (
              <div className="popover-item composer-completion-state composer-completion-error" role="alert">
                {snapshot.errors.map((err) => (
                  <span
                    key={`${err.source}:${err.message}`}
                    title={`${err.source}: ${err.message}`}
                  >
                    {t('composer.completion.sourceError', { source: err.source, message: err.message })}
                  </span>
                ))}
              </div>
            ) : (
              <div className="popover-item composer-completion-state">{t('composer.completion.noMatches')}</div>
            )
          ) : null}
        </div>
        {snapshot.total > visible.length ? (
          <div
            className="popover-item composer-completion-state"
            role="status"
            title={t('composer.completion.tooManyTitle', { limit: COMPLETION_VISIBLE_LIMIT })}
          >
            {snapshot.truncated
              ? t('composer.completion.tooManyTotal', { limit: COMPLETION_VISIBLE_LIMIT, total: snapshot.total })
              : t('composer.completion.tooMany', { limit: COMPLETION_VISIBLE_LIMIT })}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
