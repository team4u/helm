import { useEffect, useMemo, useState } from 'react'
import { useWebLocale } from '../i18n/use-web-locale.js'

// ---------------------------------------------------------------------------
// Slash / artifact-reference popover (extracted from Composer.tsx)
// ---------------------------------------------------------------------------

export interface PopoverItem {
  id: string
  label: string
  hint?: string
  /** Trigger word written back into the draft (plugin commands run instead). */
  apply?: string
  /** Plugin command: picked items execute immediately (no draft write-back). */
  run?: () => void
}
/** Keyboard-visible candidate cap: ↑↓ cycling stays inside this list. */
const SLASH_VISIBLE_LIMIT = 12

export function CommandPopover({
  query,
  slashItems,
  onPick,
  onClose,
}: {
  query: string
  /** Pre-merged slash menu items (incl. plugin commands); omitted falls back to host builtin items. */
  slashItems?: ReadonlyArray<PopoverItem>
  onPick: (apply: string, caretSuffix?: string) => void
  onClose: () => void
}) {
  const { t } = useWebLocale()
  const [active, setActive] = useState(0)

  const items = useMemo<PopoverItem[]>(() => {
    const q = query.toLowerCase()
    if (slashItems !== undefined) {
      return slashItems.filter((i) => i.id.toLowerCase().includes(q) || i.label.toLowerCase().includes(q))
    }
    const builtin: PopoverItem[] = [
      { id: '/new', label: '/new', hint: t('composer.command.newHint'), apply: '/new' },
      { id: '/clear', label: '/clear', hint: t('composer.command.clearHint'), apply: '/clear' },
      { id: '/compact', label: '/compact', hint: t('composer.command.compactHint'), apply: '/compact' },
    ]
    return builtin.filter((i) => i.id.toLowerCase().includes(q))
  }, [query, slashItems, t])

  // Keyboard cycling is limited to the visible candidates, fixing the old bug
  // where the index could reach past the truncated list. Memoization keeps the
  // array identity stable so the keyboard effect does not re-bind listeners
  // while the item set is unchanged.
  const visible = useMemo(() => items.slice(0, SLASH_VISIBLE_LIMIT), [items])
  const visibleKeys = visible.map((item) => item.id).join('|')

  useEffect(() => {
    setActive(0)
  }, [query, visibleKeys])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Never intercept while IME is composing (syllables may contain triggers;
      // Enter belongs to candidate confirmation).
      if (e.isComposing || e.keyCode === 229) return
      if (visible.length === 0) {
        if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          onClose()
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        setActive((i) => (i + 1) % visible.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        setActive((i) => (i - 1 + visible.length) % visible.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        const item = visible[active]
        if (item !== undefined) {
          if (item.run !== undefined) {
            item.run()
            onClose()
          } else if (item.apply !== undefined) {
            onPick(item.apply)
          }
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, active, onPick, onClose])

  if (visible.length === 0) {
    return (
      <div className="composer-popover">
        <div className="popover-item" style={{ color: 'var(--fg-muted)' }}>
          {t('composer.command.noMatches')}
        </div>
      </div>
    )
  }

  return (
    <div className="composer-popover">
      <div className="popover-header">
        {t('composer.command.header')}
        <span className="kbd-hint popover-kbd-hint">{t('composer.kbd.navConfirmClose')}</span>
      </div>
      {visible.map((item, idx) => (
        <button
          key={item.id}
          type="button"
          className={`popover-item${idx === active ? ' popover-item-active' : ''}`}
          onMouseEnter={() => setActive(idx)}
          onClick={() => {
            if (item.run !== undefined) {
              item.run()
              onClose()
            } else if (item.apply !== undefined) {
              onPick(item.apply)
            }
          }}
        >
          <span className="mono">{item.label}</span>
          {item.hint !== undefined ? <span className="popover-item-meta">{item.hint}</span> : null}
        </button>
      ))}
      {items.length > visible.length ? (
        <div className="popover-item" style={{ color: 'var(--fg-subtle)', cursor: 'default' }}>
          {t('composer.completion.tooManyTitle', { limit: SLASH_VISIBLE_LIMIT })}
        </div>
      ) : null}
    </div>
  )
}
