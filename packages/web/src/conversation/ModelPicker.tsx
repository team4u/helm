import { useEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '@helm/protocol/browser'
import { assetsApi, conversationsApi } from '../lib/api.js'
import { HelmIcon, Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
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
// ModelPicker（自 Composer.tsx 拆出）：模型与思考档位选择，Radix Popover 浮层。
// 会话模式与待命页共用 ModelPickerControl，统一键盘导航、Ctrl+L 聚焦与目录刷新。
// ---------------------------------------------------------------------------

export interface ModelPickerControlProps {
  /** 当前生效模型 ID（用于按钮标签、思考能力查询与初始高亮定位）。 */
  effectiveModel: string | undefined
  /** 显式选中的模型 ID（未覆盖/跟随时为 undefined）。 */
  selectedModel: string | undefined
  /** 当前思考档位（由模型支持列表收敛后展示）。 */
  activeThinkingLevel: string
  /** DOM 无 `[data-helm-panel]` 祖先时的兜底面板归属。 */
  fallbackPanel?: HelmPanel
  /** 清除显式覆盖按钮文案与标题。 */
  resetLabel: string
  resetTitle: string
  /** 触发按钮标题与禁用态。 */
  buttonTitle: string
  disabled?: boolean
  pending?: boolean
  /** 关联会话 ID（刷新目录通知归属；待命页省略）。 */
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
    // filteredKeys 精确表达过滤结果集合变化
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
          title: '部分供应商目录刷新失败',
          body: errors.map(([p, err]) => `${p}: ${err}`).join('; '),
          ...(conversationId !== undefined ? { conversationId } : {}),
        })
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: '已刷新模型目录',
          body: `共 ${store.models.length} 个可用模型`,
          ...(conversationId !== undefined ? { conversationId } : {}),
        })
      }
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '刷新模型目录失败',
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
  const shortName = rawShortName.trim() !== '' ? rawShortName : '默认模型'
  const currentModel = effectiveModel !== undefined && effectiveModel !== ''
    ? store.models.find((model) => model.id === effectiveModel)
    : undefined
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const supportsThinking = currentLevels.some((level) => level !== 'off')
  // 生效档位与展示：优先取实际生效档位；若不在当前模型支持列表中，则回退至 off 或首项支持档位。
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
            aria-label={`模型与思考档位：${shortName}${showLevel ? ` · ${effectiveLevel}` : ''}`}
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
              // 阻止 Esc 冒泡至全局双 Esc 中断处理器
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
                  aria-label="搜索模型"
                  placeholder="搜索模型…"
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
              <Tooltip content="刷新动态模型目录" side="top">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon-sm composer-model-refresh-btn"
                  disabled={refreshing}
                  title="刷新动态模型目录"
                  aria-label="刷新动态模型目录"
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
              <span>模型列表</span>
              <span className="kbd-hint popover-kbd-hint">↑↓ 选择 · Enter 确认</span>
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
              <div className="popover-item composer-model-empty">暂无可用模型；请先在「模型与凭据」配置供应商密钥</div>
            ) : filteredModels.length === 0 ? (
              <div className="popover-item composer-model-empty">没有匹配的模型</div>
            ) : null}
            {supportsThinking ? (
              <>
                <div className="popover-header">
                  <span>
                    思考档位
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
        title: '切换模型失败',
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
        title: '切换思考等级失败',
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
        title: '恢复默认配置失败',
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
      resetLabel="跟随 Profile 默认（清除覆盖）"
      resetTitle="清除显式覆盖，重算 Profile/全局继承链"
      buttonTitle={`当前模型：${conversation.model}${showLevel ? ` · 思考 ${effectiveLevel}` : ''} (${COMPOSER_SHORTCUTS.toggleModelPicker})`}
      pending={pending}
      conversationId={conversation.id}
      onPickModel={pick}
      onResetDefault={resetToProfileDefault}
      onPickThinking={pickThinking}
    />
  )
}
