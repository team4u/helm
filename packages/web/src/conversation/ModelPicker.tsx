import { useEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { assetsApi, conversationsApi } from '../lib/api.js'
import { HelmxIcon, Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@helmx/plugin-client'
import { useModels, useOptionalModels, useOptionalStoreActions, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { ThinkingLevelControl } from '../ui/ThinkingLevelControl.js'
import { Tooltip } from '../ui/Tooltip.js'
import {
  COMPOSER_SHORTCUTS,
  initialModelActiveIndex,
  resolveEffectiveThinkingLevel,
  stepActiveIndex,
  usePanelShortcut,
  type HelmxPanel,
} from './keybindings-model.js'

// ---------------------------------------------------------------------------
// ModelPicker (extracted from Composer.tsx): model and thinking level picking
// in a Radix Popover. Conversation mode and the standby pane share
// ModelPickerControl with unified keyboard navigation, Ctrl+L focus and
// catalog refresh. Clicking a model row only STAGES the candidate; the pinned
// apply bar commits: a level chip applies model + level together, "use
// default level" / Enter applies the model alone. Esc and outside clicks
// discard the staged candidate.
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
  // Candidate staged inside this popover session (undefined = the effective
  // model). Nothing commits until an explicit apply action in the pinned bar.
  const [stagedModel, setStagedModel] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
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
  const candidateModel = stagedModel ?? effectiveModel
  const [activeIndex, setActiveIndex] = useState(() => initialModelActiveIndex(filteredModels, effectiveModel))

  // Closing (Esc / outside click / toggle) discards the staged candidate.
  useEffect(() => {
    setQuery('')
    setStagedModel(undefined)
    interactedOutsideRef.current = false
  }, [open])

  useEffect(() => {
    if (!open) return
    setActiveIndex(initialModelActiveIndex(filteredModels, candidateModel))
    // filteredKeys precisely expresses changes of the filtered result set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, filteredKeys, candidateModel])

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

  // Staging only moves the candidate; nothing commits here.
  const stageModel = (modelId: string): void => {
    setStagedModel(modelId)
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

  const rawShortName =
    effectiveModel !== undefined && effectiveModel !== ''
      ? effectiveModel.split('/').pop() ?? effectiveModel
      : ''
  const shortName = rawShortName.trim() !== '' ? rawShortName : (placeholderLabel ?? t('composer.model.defaultLabel'))
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

  // Apply-bar state targets the staged candidate. The level highlight is only
  // honest for the committed model (the default chain for a different model
  // resolves server-side), so staging another model shows no active chip.
  const candidateShortName =
    candidateModel !== undefined && candidateModel !== ''
      ? candidateModel.split('/').pop() ?? candidateModel
      : (placeholderLabel ?? t('composer.model.defaultLabel'))
  const candidateEntry = candidateModel !== undefined && candidateModel !== ''
    ? models.find((model) => model.id === candidateModel)
    : undefined
  const candidateLevels = candidateEntry?.thinkingLevels ?? ['off']
  const candidateSupportsThinking = candidateLevels.some((level) => level !== 'off')
  const candidateLevel = candidateModel === effectiveModel
    ? resolveEffectiveThinkingLevel(candidateLevels, activeThinkingLevel)
    : ''

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
            <div className="composer-model-scroll">
            <div className="popover-header">
              <span>{t('composer.model.listHeader')}</span>
              <span className="kbd-hint popover-kbd-hint">{t('composer.kbd.navConfirm')}</span>
            </div>
            {filteredModels.map((m, idx) => (
              <button
                key={m.id}
                ref={(node) => {
                  itemRefs.current[idx] = node
                }}
                title={m.id}
                type="button"
                disabled={disabled}
                aria-current={m.id === candidateModel ? 'true' : undefined}
                className={`popover-item${idx === activeIndex ? ' popover-item-active' : ''}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => stageModel(m.id)}
              >
                <span className="mono">{m.modelId}</span>
                <span className="popover-item-meta">{m.provider}</span>
              </button>
            ))}
            {allUnavailable ? (
              <div className="popover-item composer-model-empty">{t('composer.model.emptyCatalog')}</div>
            ) : filteredModels.length === 0 ? (
              <div className="popover-item composer-model-empty">{t('composer.model.noMatches')}</div>
            ) : null}
            </div>
            {allUnavailable ? null : (
              <div className="composer-model-apply">
                <div className="popover-header composer-model-apply-header">
                  {candidateSupportsThinking ? (
                    <span>
                      {t('composer.model.thinkingHeader')}
                      <span className="composer-model-thinking-name"> · {candidateShortName}</span>
                    </span>
                  ) : (
                    <span className="composer-model-thinking-name">{candidateShortName}</span>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm composer-model-default-btn"
                    disabled={disabled || pending || candidateModel === undefined || candidateModel === ''}
                    onClick={() => applySelection(candidateModel, null)}
                  >
                    {t('composer.model.applyDefault')}
                  </button>
                </div>
                {candidateSupportsThinking ? (
                  <ThinkingLevelControl
                    value={candidateLevel}
                    levels={candidateLevels}
                    allowEmpty
                    disabled={disabled || pending}
                    onPick={(level) => applySelection(candidateModel, level)}
                  />
                ) : null}
              </div>
            )}
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
