import { useEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { assetsApi, conversationsApi } from '../lib/api.js'
import { HelmxIcon, Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@helmx/plugin-client'
import { useModels, useOptionalModels, useOptionalStoreActions, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { Tooltip } from '../ui/Tooltip.js'
import {
  COMPOSER_SHORTCUTS,
  initialModelActiveIndex,
  resolveEffectiveThinkingLevel,
  stepActiveIndex,
  usePanelShortcut,
  type HelmxPanel,
} from './keybindings-model.js'
import { formatModelRowDisplay, formatModelShortName } from './model-picker-model.js'

// ---------------------------------------------------------------------------
// ModelPicker (extracted from Composer.tsx): model and thinking level picking
// in a Radix Popover. Conversation mode and the standby pane share
// ModelPickerControl with unified keyboard navigation, Ctrl+L focus and
// catalog refresh. Each model row carries its thinking levels inline on the
// right: one click on a level chip applies model + level together in a single
// commit; clicking the row body (or Enter in the search) applies the model
// alone so the level follows the default chain. Only the effective model's
// row shows an active level chip (the default chain for other models resolves
// server-side, so pre-highlighting one would be dishonest).
// ---------------------------------------------------------------------------

export interface ModelPickerControlProps {
  /** Currently effective model id (button label, capability lookup, initial highlight). */
  effectiveModel: string | undefined
  /** Current thinking level (converged against the model's supported list). */
  activeThinkingLevel: string
  /** Panel fallback when no `[data-helmx-panel]` ancestor exists. */
  fallbackPanel?: HelmxPanel
  /** Copy for the clear-override button (label and title). */
  resetLabel: string
  resetTitle: string
  /** Trigger button title and disabled state. */
  buttonTitle: string
  /** Optional trigger button id / aria-label / unset placeholder (defaults to composer label). */
  buttonId?: string
  buttonAriaLabel?: string
  placeholderLabel?: string
  /** Popover placement side. */
  popoverSide?: 'top' | 'bottom'
  /** Enable Ctrl+L in the composer. */
  enableShortcut?: boolean
  disabled?: boolean
  pending?: boolean
  /** Owning conversation id (refresh notices; omitted on the standby pane). */
  conversationId?: number
  /** Apply the candidate model; thinkingLevel null = follow the default chain. */
  onApply: (model: string, thinkingLevel: string | null) => void | Promise<void>
  onResetDefault: () => void | Promise<void>
  onCatalogRefreshed?: () => void | Promise<void>
}

export function ModelPickerControl({
  effectiveModel,
  activeThinkingLevel,
  fallbackPanel = 'primary',
  resetLabel,
  resetTitle,
  buttonTitle,
  buttonId,
  buttonAriaLabel,
  placeholderLabel,
  popoverSide = 'top',
  enableShortcut = true,
  disabled = false,
  pending = false,
  conversationId,
  onApply,
  onResetDefault,
  onCatalogRefreshed,
}: ModelPickerControlProps) {
  const models = useOptionalModels() ?? []
  const actions = useOptionalStoreActions()
  const { t } = useWebLocale()
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const itemRefs = useRef<Array<HTMLElement | null>>([])
  const interactedOutsideRef = useRef(false)

  usePanelShortcut(
    rootRef,
    'toggle-model-picker',
    () => {
      if (!enableShortcut) return
      if (disabled) {
        setOpen(false)
        return
      }
      setOpen((prev) => !prev)
    },
    fallbackPanel,
  )

  const filteredModels = models.filter((model) => model.available && model.disabled !== true && model.id.toLowerCase().includes(query.toLowerCase()))
  const filteredKeys = filteredModels.map((model) => model.id).join('|')
  const [activeIndex, setActiveIndex] = useState(-1)

  useEffect(() => {
    setQuery('')
    interactedOutsideRef.current = false
  }, [open])

  useEffect(() => {
    if (!open) {
      setActiveIndex(-1)
      return
    }
    setActiveIndex(initialModelActiveIndex(filteredModels, query))
    // filteredKeys precisely expresses changes of the filtered result set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, filteredKeys])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    itemRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex])

  const refreshCatalog = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const res = await assetsApi.refreshModels()
      await actions?.refreshAssets()
      await onCatalogRefreshed?.()
      const errors = Object.entries(res.errors ?? {})
      if (errors.length > 0) {
        actions?.pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.model.catalogPartialFailure'),
          body: errors.map(([p, err]) => `${p}: ${err}`).join('; '),
          ...(conversationId !== undefined ? { conversationId } : {}),
        })
      } else {
        actions?.pushNotice({
          type: 'notification',
          level: 'info',
          title: t('composer.model.catalogRefreshed'),
          body: t('composer.model.catalogCount', { count: models.length }),
          ...(conversationId !== undefined ? { conversationId } : {}),
        })
      }
    } catch (err) {
      actions?.pushNotice({
        type: 'notification',
        level: 'error',
        title: t('composer.model.catalogRefreshFailed'),
        body: err instanceof Error ? err.message : String(err),
        ...(conversationId !== undefined ? { conversationId } : {}),
      })
    } finally {
      setRefreshing(false)
    }
  }

  const applySelection = (model: string | undefined, level: string | null): void => {
    if (model === undefined || model === '') return
    setOpen(false)
    void onApply(model, level)
  }

  const resetDefault = (): void => {
    setOpen(false)
    void onResetDefault()
  }

  const rawShortName = formatModelShortName(effectiveModel)
  const shortName = rawShortName !== '' ? rawShortName : (placeholderLabel ?? t('composer.model.defaultLabel'))
  const currentModel = effectiveModel !== undefined && effectiveModel !== ''
    ? models.find((model) => model.id === effectiveModel)
    : undefined
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const supportsThinking = currentLevels.some((level) => level !== 'off')
  // Effective level display: prefer the actually effective level; when it is
  // not in the model's supported list, fall back to off or the first supported.
  const effectiveLevel = resolveEffectiveThinkingLevel(currentLevels, activeThinkingLevel)
  const showLevel = supportsThinking && effectiveLevel !== '' && effectiveLevel !== 'off'
  const allUnavailable = models.every((model) => !model.available || model.disabled === true)

  return (
    <span className="composer-picker-root" ref={rootRef}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={buttonId}
            type="button"
            className="btn btn-ghost btn-sm composer-model-button"
            disabled={disabled || pending}
            aria-expanded={open}
            aria-label={
              buttonAriaLabel ??
              t('composer.model.buttonAria', {
                model: shortName,
                level: showLevel ? t('composer.model.levelSuffix', { level: effectiveLevel }) : '',
              })
            }
            title={buttonTitle}
          >
            {pending ? <HelmxIcon name="loader" size={12} className="spin-slow" /> : null}
            <span className="composer-model-label">{shortName}</span>
            {showLevel ? <span className="composer-model-level">· {effectiveLevel}</span> : null}
            <HelmxIcon name="chevron-down" size={12} />
          </button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            side={popoverSide}
            align="start"
            sideOffset={8}
            className="composer-popover composer-model-popover"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              searchInputRef.current?.focus()
            }}
            onCloseAutoFocus={(event) => {
              if (interactedOutsideRef.current) {
                interactedOutsideRef.current = false
                return
              }
              const textarea = rootRef.current
                ?.closest('.composer-box')
                ?.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')
              if (textarea !== null && textarea !== undefined) {
                event.preventDefault()
                textarea.focus()
              }
            }}
            onInteractOutside={() => {
              interactedOutsideRef.current = true
            }}
            onEscapeKeyDown={(event) => {
              // Stop Esc from bubbling to the global double-Esc abort handler
              event.stopPropagation()
            }}
          >
            <button
              type="button"
              className="popover-item"
              disabled={disabled}
              onClick={resetDefault}
              title={resetTitle}
            >
              {resetLabel}
            </button>
            <div className="composer-model-search-bar">
              <div className="search-box composer-model-search-input">
                <HelmxIcon name="search" size={13} />
                <input
                  ref={searchInputRef}
                  aria-label={t('composer.model.searchAria')}
                  placeholder={t('composer.model.searchPlaceholder')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setActiveIndex((prev) => stepActiveIndex(prev, filteredModels.length, 1))
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setActiveIndex((prev) => stepActiveIndex(prev, filteredModels.length, -1))
                    } else if (event.key === 'Enter') {
                      const chosen = filteredModels[activeIndex]
                      if (chosen !== undefined) {
                        event.preventDefault()
                        event.stopPropagation()
                        applySelection(chosen.id, null)
                      }
                    }
                  }}
                />
              </div>
              <Tooltip content={t('composer.model.refreshCatalog')} side="top">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon-sm composer-model-refresh-btn"
                  disabled={refreshing}
                  title={t('composer.model.refreshCatalog')}
                  aria-label={t('composer.model.refreshCatalog')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void refreshCatalog()
                  }}
                >
                  <HelmxIcon name="rotate-cw" size={13} className={refreshing ? 'spin-slow' : undefined} />
                </button>
              </Tooltip>
            </div>
            <div className="composer-model-scroll" onMouseLeave={() => setActiveIndex(-1)}>
            <div className="popover-header">
              <span>{t('composer.model.listHeader')}</span>
              <span className="kbd-hint popover-kbd-hint">{t('composer.kbd.navConfirm')}</span>
            </div>
            {filteredModels.map((m, idx) => {
              const levels = m.thinkingLevels ?? ['off']
              const supportsThinking = levels.some((level) => level !== 'off')
              const isCurrent = m.id === effectiveModel
              // Level highlight only for the effective model's row: for other
              // models the default chain resolves server-side.
              const activeRowLevel = isCurrent
                ? resolveEffectiveThinkingLevel(levels, activeThinkingLevel)
                : ''
              const display = formatModelRowDisplay(m)
              return (
                <div
                  key={m.id}
                  ref={(node) => {
                    itemRefs.current[idx] = node
                  }}
                  className={`popover-item composer-model-row${idx === activeIndex ? ' popover-item-active' : ''}`}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  <button
                    type="button"
                    className="composer-model-row-main"
                    title={t('composer.model.rowDefaultTitle', { model: m.id })}
                    disabled={disabled}
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => applySelection(m.id, null)}
                  >
                    <span className="composer-model-row-name-line">
                      <span className="mono composer-model-row-name">{display.name}</span>
                      {isCurrent ? <HelmxIcon name="check" size={12} className="composer-model-row-check" /> : null}
                    </span>
                    <span className="popover-item-meta composer-model-row-source">{display.source}</span>
                  </button>
                  {supportsThinking ? (
                    <span className="segmented-control composer-model-row-levels" role="group" aria-label={t('composer.model.thinkingHeader')}>
                      {levels.map((level) => (
                        <button
                          key={level}
                          type="button"
                          className="segmented-control-btn composer-model-level-chip"
                          disabled={disabled}
                          aria-pressed={m.id === effectiveModel && level === activeRowLevel ? 'true' : undefined}
                          title={t('composer.model.levelChipTitle', { model: m.id, level })}
                          onClick={() => applySelection(m.id, level)}
                        >
                          {level}
                        </button>
                      ))}
                    </span>
                  ) : null}
                </div>
              )
            })}
            {allUnavailable ? (
              <div className="popover-item composer-model-empty">{t('composer.model.emptyCatalog')}</div>
            ) : filteredModels.length === 0 ? (
              <div className="popover-item composer-model-empty">{t('composer.model.noMatches')}</div>
            ) : null}
            </div>
          </PopoverContent>
        </PopoverPortal>
      </Popover>
    </span>
  )
}

export function ModelPicker({ conversation }: { conversation: ConversationSummary }) {
  const models = useModels()
  const { pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const [pending, setPending] = useState(false)

  const apply = async (model: string, level: string | null): Promise<void> => {
    // Same model + null level only clears the thinking override (back to the
    // default chain); a model switch without an explicit level lets the kernel
    // drop the stale override automatically.
    const sameModel = model === conversation.model
    const body = sameModel
      ? { thinkingLevel: level ?? '' }
      : level === null
        ? { model }
        : { model, thinkingLevel: level }
    setPending(true)
    try {
      await conversationsApi.patch(conversation.id, body)
    } catch (err) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: sameModel ? t('composer.model.thinkingSwitchFailed') : t('composer.model.switchFailed'),
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setPending(false)
    }
  }

  const resetToProfileDefault = async (): Promise<void> => {
    setPending(true)
    try {
      await conversationsApi.patch(conversation.id, { model: '', thinkingLevel: '' })
    } catch (err) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('composer.model.restoreFailed'),
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setPending(false)
    }
  }

  const currentModel = models.find((model) => model.id === conversation.model)
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const supportsThinking = currentLevels.some((level) => level !== 'off')
  const effectiveLevel = resolveEffectiveThinkingLevel(currentLevels, conversation.thinkingLevel)
  const showLevel = supportsThinking && effectiveLevel !== '' && effectiveLevel !== 'off'

  return (
    <ModelPickerControl
      effectiveModel={conversation.model}
      activeThinkingLevel={conversation.thinkingLevel}
      resetLabel={t('composer.model.clearOverride')}
      resetTitle={t('composer.model.clearOverride')}
      buttonTitle={t('composer.model.currentTitle', {
        model: conversation.model,
        thinking: showLevel ? t('composer.model.thinkingSuffix', { level: effectiveLevel }) : '',
        shortcut: COMPOSER_SHORTCUTS.toggleModelPicker,
      })}
      pending={pending}
      conversationId={conversation.id}
      onApply={apply}
      onResetDefault={resetToProfileDefault}
    />
  )
}
