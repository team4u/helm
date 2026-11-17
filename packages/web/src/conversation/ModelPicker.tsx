import { useEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '@helm/protocol/browser'
import { assetsApi, conversationsApi } from '../lib/api.js'
import { HelmIcon, Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { ThinkingLevelControl } from '../ui/ThinkingLevelControl.js'
import { Tooltip } from '../ui/Tooltip.js'
import {
  COMPOSER_SHORTCUTS,
  initialModelActiveIndex,
  resolveEffectiveThinkingLevel,
  stepActiveIndex,
  usePanelShortcut,
  type HelmPanel,
} from './keybindings-model.js'

// ---------------------------------------------------------------------------
// ModelPicker (extracted from Composer.tsx): model and thinking level picking
// in a Radix Popover. Conversation mode and the standby pane share
// ModelPickerControl with unified keyboard navigation, Ctrl+L focus and
// catalog refresh.
// ---------------------------------------------------------------------------

export interface ModelPickerControlProps {
  /** Currently effective model id (button label, capability lookup, initial highlight). */
  effectiveModel: string | undefined
  /** Explicitly selected model id (undefined while following defaults). */
  selectedModel: string | undefined
  /** Current thinking level (converged against the model's supported list). */
  activeThinkingLevel: string
  /** Panel fallback when no `[data-helm-panel]` ancestor exists. */
  fallbackPanel?: HelmPanel
  /** Copy for the clear-override button (label and title). */
  resetLabel: string
  resetTitle: string
  /** Trigger button title and disabled state. */
  buttonTitle: string
  disabled?: boolean
  pending?: boolean
  /** Owning conversation id (refresh notices; omitted on the standby pane). */
  conversationId?: number
  onPickModel: (modelId: string) => void | Promise<void>
  onResetDefault: () => void | Promise<void>
  onPickThinking: (level: string) => void | Promise<void>
  onCatalogRefreshed?: () => void | Promise<void>
}

export function ModelPickerControl({
  effectiveModel,
  selectedModel,
  activeThinkingLevel,
  fallbackPanel = 'primary',
  resetLabel,
  resetTitle,
  buttonTitle,
  disabled = false,
  pending = false,
  conversationId,
  onPickModel,
  onResetDefault,
  onPickThinking,
  onCatalogRefreshed,
}: ModelPickerControlProps) {
  const store = useHelmStore()
  const { t } = useWebLocale()
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const interactedOutsideRef = useRef(false)

  usePanelShortcut(
    rootRef,
    'toggle-model-picker',
    () => {
      if (disabled) {
        setOpen(false)
        return
      }
      setOpen((prev) => !prev)
    },
    fallbackPanel,
  )

  const filteredModels = store.models.filter((model) => model.available && model.disabled !== true && model.id.toLowerCase().includes(query.toLowerCase()))
  const filteredKeys = filteredModels.map((model) => model.id).join('|')
  const [activeIndex, setActiveIndex] = useState(() => initialModelActiveIndex(filteredModels, effectiveModel))

  useEffect(() => {
    if (!open) return
    setQuery('')
    interactedOutsideRef.current = false
  }, [open])

  useEffect(() => {
    if (!open) return
    setActiveIndex(initialModelActiveIndex(filteredModels, effectiveModel))
    // filteredKeys precisely expresses changes of the filtered result set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, filteredKeys, effectiveModel])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    itemRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex])

  const refreshCatalog = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const res = await assetsApi.refreshModels()
      await store.refreshAssets()
      await onCatalogRefreshed?.()
      const errors = Object.entries(res.errors ?? {})
      if (errors.length > 0) {
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.model.catalogPartialFailure'),
          body: errors.map(([p, err]) => `${p}: ${err}`).join('; '),
          ...(conversationId !== undefined ? { conversationId } : {}),
        })
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: t('composer.model.catalogRefreshed'),
          body: t('composer.model.catalogCount', { count: store.models.length }),
          ...(conversationId !== undefined ? { conversationId } : {}),
        })
      }
    } catch (err) {
      store.pushNotice({
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

  const pickThinking = (level: string): Promise<void> => Promise.resolve(onPickThinking(level))

  const chooseModel = (modelId: string): void => {
    setOpen(false)
    void onPickModel(modelId)
  }

  const resetDefault = (): void => {
    setOpen(false)
    void onResetDefault()
  }

  const rawShortName =
    effectiveModel !== undefined && effectiveModel !== ''
      ? effectiveModel.split('/').pop() ?? effectiveModel
      : ''
  const shortName = rawShortName.trim() !== '' ? rawShortName : t('composer.model.defaultLabel')
  const currentModel = effectiveModel !== undefined && effectiveModel !== ''
    ? store.models.find((model) => model.id === effectiveModel)
    : undefined
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const supportsThinking = currentLevels.some((level) => level !== 'off')
  // Effective level display: prefer the actually effective level; when it is
  // not in the model's supported list, fall back to off or the first supported.
  const effectiveLevel = resolveEffectiveThinkingLevel(currentLevels, activeThinkingLevel)
  const showLevel = supportsThinking && effectiveLevel !== '' && effectiveLevel !== 'off'
  const allUnavailable = store.models.every((model) => !model.available || model.disabled === true)

  return (
    <span className="composer-picker-root" ref={rootRef}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="btn btn-ghost btn-sm composer-model-button"
            disabled={disabled || pending}
            aria-expanded={open}
            aria-label={t('composer.model.buttonAria', {
              model: shortName,
              level: showLevel ? t('composer.model.levelSuffix', { level: effectiveLevel }) : '',
            })}
            title={buttonTitle}
          >
            {pending ? <HelmIcon name="loader" size={12} className="spin-slow" /> : null}
            <span className="composer-model-label">{shortName}</span>
            {showLevel ? <span className="composer-model-level">· {effectiveLevel}</span> : null}
            <HelmIcon name="chevron-down" size={12} />
          </button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            side="top"
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
                <HelmIcon name="search" size={13} />
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
                        chooseModel(chosen.id)
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
                  <HelmIcon name="rotate-cw" size={13} className={refreshing ? 'spin-slow' : undefined} />
                </button>
              </Tooltip>
            </div>
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
                aria-current={m.id === (selectedModel ?? effectiveModel) ? 'true' : undefined}
                className={`popover-item${idx === activeIndex ? ' popover-item-active' : ''}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => chooseModel(m.id)}
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
            {supportsThinking ? (
              <>
                <div className="popover-header">
                  <span>
                    {t('composer.model.thinkingHeader')}
                    <span className="composer-model-thinking-name"> · {shortName}</span>
                  </span>
                  <span className="kbd-hint popover-kbd-hint">{COMPOSER_SHORTCUTS.cycleThinkingLevel}</span>
                </div>
                <ThinkingLevelControl
                  value={effectiveLevel}
                  levels={currentLevels}
                  disabled={disabled || pending}
                  onPick={(level) => void pickThinking(level)}
                />
              </>
            ) : null}
          </PopoverContent>
        </PopoverPortal>
      </Popover>
    </span>
  )
}

export function ModelPicker({ conversation }: { conversation: ConversationSummary }) {
  const store = useHelmStore()
  const { t } = useWebLocale()
  const [pending, setPending] = useState(false)

  const pick = async (model: string): Promise<void> => {
    if (model === conversation.model) return
    setPending(true)
    try {
      await conversationsApi.patch(conversation.id, { model })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: t('composer.model.switchFailed'),
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setPending(false)
    }
  }

  const pickThinking = async (level: string): Promise<void> => {
    setPending(true)
    try {
      await conversationsApi.patch(conversation.id, { thinkingLevel: level })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: t('composer.model.thinkingSwitchFailed'),
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
      store.pushNotice({
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

  const currentModel = store.models.find((model) => model.id === conversation.model)
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const supportsThinking = currentLevels.some((level) => level !== 'off')
  const effectiveLevel = resolveEffectiveThinkingLevel(currentLevels, conversation.thinkingLevel)
  const showLevel = supportsThinking && effectiveLevel !== '' && effectiveLevel !== 'off'

  return (
    <ModelPickerControl
      effectiveModel={conversation.model}
      selectedModel={conversation.model}
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
      onPickModel={pick}
      onResetDefault={resetToProfileDefault}
      onPickThinking={pickThinking}
    />
  )
}
