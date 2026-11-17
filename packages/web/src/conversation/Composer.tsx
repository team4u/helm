import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComposerScopeProps, ConversationSummary } from '@helm/protocol/browser'
import { COMPOSER_DOCK_SLOT, COMPOSER_STATUS_SLOT, resolveLocalizedText } from '@helm/protocol/browser'
import { conversationsApi } from '../lib/api.js'
import { buildSlashMenuItems, pluginSlashCommandsFor } from '../lib/commands-model.js'
import { HelmIcon, PluginSlot } from '@helm/plugin-client'
import { matchesUiScope } from '../lib/types.js'
import {
  HelmStoreContext,
  useConversationDetail,
  useGroupedUi,
  useHelmExternalStore,
  useModels,
  usePlugins,
  useProfilesSlice,
  useSkills,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { collectEnabledPluginIds } from '../shell/sidebar-model.js'
import { slashMenuSkills } from './slash-menu-skills.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { AskDock } from './AskDock.js'
import { CompletionPopover } from './CompletionPopover.js'
import { CommandPopover } from './CommandPopover.js'
import { ModelPicker } from './ModelPicker.js'
import { SessionEnvBar } from './SessionEnvBar.js'
import { ComposerSendControls } from './ComposerSendControls.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useComposerController } from './composer-controller.js'
import { autoGrowTextarea, useComposerPopovers, useElementWidthResize } from './use-composer-popovers.js'
import {
  canConfigureSessionEnv,
  busyEnterMode,
  getComposerPlaceholder,
  useIsMobile,
} from './composer-model.js'
import { useComposerSend, type ComposerPrefill } from './composer-send.js'
import {
  canRecallOnArrowUp,
  isComposerSubmitEnterEvent,
  isPlainArrowUpEvent,
  isShiftTabEvent,
  latestHumanQueuedInput,
  nextThinkingLevel,
  resolveEffectiveThinkingLevel,
} from './keybindings-model.js'
import { lastEditableHumanInput } from './timeline-model.js'
import { contextUsageLabel } from './context-usage-model.js'
import { formatBytes } from '../lib/format.js'

export interface ComposerProps {
  conversation: ConversationSummary
  /** 请求回填文本（时间线「编辑并重发」）；每次递增 tick 保证同文本也能再次触发。 */
  prefill: ComposerPrefill | null
  /** 真实发送请求开始/结束时通知父层（在途反馈；斜杠命令不触发）。 */
  onSendingChange?: (sending: boolean) => void
  /** /new 新话题入口：进入本智能体待命页（首次发送才落库）；宿主传入面板位置明确的导航回调。 */
  onNewThread?: () => void
}

// ---------------------------------------------------------------------------
// 上下文用量只读状态（ModelPicker 右侧；对齐 pi footer 展示，不可交互）。
// 速率类只读指标（如 builtin:token-speed）经下方 COMPOSER_STATUS_SLOT 插槽
// 由可选插件贡献，宿主不再内置任何响应速率计算与展示。
// ---------------------------------------------------------------------------

function ContextUsageStatus({ conversation }: { conversation: ConversationSummary }) {
  const { t } = useWebLocale()
  const usage = conversation.contextUsage
  if (usage === undefined) return null
  const label = contextUsageLabel(usage, t)
  if (label === null) return null
  return (
    <span
      className={`composer-context-status${label.tone === 'high' ? ' composer-context-status-high' : label.tone === 'warn' ? ' composer-context-status-warn' : ''}`}
      title={label.title}
    >
      {label !== null ? <span className="mono tabular-nums">{label.text}</span> : null}
    </span>
  )
}

export function Composer({ conversation, prefill, onSendingChange, onNewThread }: ComposerProps) {
  const externalStore = useHelmExternalStore()
  const legacyStore = useContext(HelmStoreContext)
  const detail = useConversationDetail(conversation.id)
  const groupedUi = useGroupedUi()
  const plugins = usePlugins()
  const { profiles } = useProfilesSlice()
  const skills = useSkills()
  const models = useModels()
  const { locale, t } = useWebLocale()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composerBoxRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const extrasRef = useRef<HTMLDetailsElement | null>(null)
  const dragDepthRef = useRef(0)
  const thinkingPendingRef = useRef(false)
  const optimisticThinkingRef = useRef<{ forModel: string; fromProp: string; value: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [widgetsExpanded, setWidgetsExpanded] = useState(false)
  const [slashMenuItems, setSlashMenuItems] = useState<Array<{ id: string; label: string; hint?: string; apply?: string; run?: () => void }>>([])

  const compacting = conversation.contextUsage?.compacting === true
  const working = conversation.status === 'working' || conversation.status === 'blocked' || compacting
  const isMobile = useIsMobile(680)
  // 历史尚未完整加载且当前页没有 reset 时，不能把缺少消息的分页窗口当作空会话。
  const detailEntries = detail?.nextCursor && !detail.entries.some((entry) => entry.kind === 'pi.reset')
    ? undefined
    : detail?.entries
  const envConfigurable = canConfigureSessionEnv(detailEntries, conversation.status)

  const slashPluginCommands = useMemo(
    () => pluginSlashCommandsFor(groupedUi.commands, conversation),
    [groupedUi.commands, conversation],
  )

  // 发送管线（草稿 / 编辑锚点 / 附件上传 / 提交与失败恢复 / 环境阻塞）。
  // 版本自动刷新挂起判定：实例级脏状态上报键（主屏/分屏/抽屉可同屏渲染同一会话）。
  const composerDirtyKey = useId()
  const {
    text,
    attachments,
    editingEntryId,
    sending,
    uploading,
    envBlocker,
    sendInFlight,
    setDraftState,
    insertTextState,
    readLiveDraft,
    cancelEdit,
    uploadFiles,
    removeAttachment,
    applyHistoryEdit,
    withdrawQueuedInput,
    send,
    sendExplicit,
    runPluginCommand,
    handleEnvBlocker,
    notifyError,
  } = useComposerSend({
    conversation,
    prefill,
    onSendingChange,
    onNewThread,
    textareaRef,
    slashPluginCommands,
    envConfigurable,
    working,
    dirtyKey: composerDirtyKey,
  })

  const widgets = groupedUi.composerWidgets.filter((w) => matchesUiScope(conversation, w.spec.scope))
  const pills = groupedUi.composerPills.filter((p) => matchesUiScope(conversation, p.spec.scope))

  useLayoutEffect(() => {
    autoGrowTextarea(textareaRef.current)
  }, [text, isMobile])
  useElementWidthResize(textareaRef, () => autoGrowTextarea(textareaRef.current))
  useEffect(() => {
    optimisticThinkingRef.current = null
  }, [conversation.id, conversation.model, conversation.thinkingLevel])

  useEffect(() => {
    const extras = extrasRef.current
    if (extras === null) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!extras.contains(event.target as Node)) extras.open = false
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && extras.open) {
        event.preventDefault()
        event.stopPropagation()
        extras.open = false
        extras.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isMobile, pills.length, widgets.length])

  const {
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
  } = useComposerPopovers({
    textareaRef,
    draftText: text,
    readLiveDraft,
    setDraftState,
    completers: groupedUi.composerCompleters,
    conversation,
    resetKey: conversation.id,
  })

  // 斜杠菜单三源合并：宿主内置命令 + 当前会话可用技能（profile.skills 白名单 +
  // 插件启用双过滤，缺 Profile 时先不展示技能）+ 满足作用域的插件命令。
  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(plugins), [plugins])
  const conversationProfile = useMemo(
    () => profiles.find((p) => p.id === conversation.profileId),
    [profiles, conversation.profileId],
  )
  const availableSkills = useMemo(
    () => slashMenuSkills(conversationProfile, skills, enabledPluginIds),
    [conversationProfile, skills, enabledPluginIds],
  )
  useEffect(() => {
    setSlashMenuItems(
      buildSlashMenuItems(availableSkills, slashPluginCommands, runPluginCommand, locale),
    )
  }, [availableSkills, slashPluginCommands, runPluginCommand, locale])

  const composer = useComposerController({
    text,
    readDraft: readLiveDraft,
    attachments,
    sending,
    textareaRef,
    setDraftState,
    insertTextState,
    submitDraft: (whenBusy) => send(whenBusy ?? 'steer', true),
    submitExplicitText: sendExplicit,
  })

  const abortTurn = async (): Promise<void> => {
    try {
      await conversationsApi.abort(conversation.id)
    } catch (err) {
      notifyError(t('conv.composer.abortFailed'), err)
    }
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length > 0) {
      e.preventDefault()
      void uploadFiles(files)
    }
  }

  const onDragEnter = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepthRef.current += 1
    if (e.dataTransfer.types.includes('Files')) setDragging(true)
  }

  const onDragLeave = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) void uploadFiles(files)
  }

  const cycleThinking = async (): Promise<void> => {
    if (thinkingPendingRef.current) return
    const currentModel = models.find((m) => m.id === conversation.model)
    const levels = currentModel?.thinkingLevels ?? ['off']
    const baseLevel =
      optimisticThinkingRef.current !== null &&
      optimisticThinkingRef.current.forModel === conversation.model &&
      optimisticThinkingRef.current.fromProp === conversation.thinkingLevel
        ? optimisticThinkingRef.current.value
        : conversation.thinkingLevel
    const effective = resolveEffectiveThinkingLevel(levels, baseLevel)
    const next = nextThinkingLevel(levels, effective)
    if (next === null) return
    thinkingPendingRef.current = true
    optimisticThinkingRef.current = {
      forModel: conversation.model,
      fromProp: conversation.thinkingLevel,
      value: next,
    }
    try {
      await conversationsApi.patch(conversation.id, { thinkingLevel: next })
    } catch (err) {
      optimisticThinkingRef.current = null
      notifyError(t('composer.model.thinkingSwitchFailed'), err)
    } finally {
      thinkingPendingRef.current = false
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // 浮层已消费或已被 defaultPrevented 的按键绝不再向下传递触发发送
    if (e.defaultPrevented || e.nativeEvent.defaultPrevented) {
      return
    }
    if (shouldDeferKeyToPopover(e)) {
      return // Handled by the global overlay capture (not intercepted during IME composing; left to the input method)
    }
    if (isShiftTabEvent(e) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void cycleThinking()
      return
    }
    if (e.key === 'Escape' && !slashOpen && !completionOpen && editingEntryId !== null) {
      e.preventDefault()
      e.stopPropagation()
      cancelEdit()
      return
    }
    if (isComposerSubmitEnterEvent(e) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (editingEntryId !== null) {
        void send('followUp')
        return
      }
      void send(working ? busyEnterMode(e.metaKey || e.ctrlKey) : 'followUp')
      return
    }
    if (
      isPlainArrowUpEvent(e) &&
      !e.nativeEvent.isComposing &&
      editingEntryId === null &&
      canRecallOnArrowUp(e.currentTarget.value, e.currentTarget.selectionStart)
    ) {
      const liveQueued =
        externalStore !== null
          ? externalStore.getConversationLive(conversation.id)?.queuedInputs
          : legacyStore?.conversationLives[conversation.id]?.queuedInputs
      const queued = latestHumanQueuedInput(liveQueued)
      if (queued !== undefined) {
        e.preventDefault()
        void withdrawQueuedInput(queued)
        return
      }
      const target = lastEditableHumanInput(detail?.entries ?? [])
      if (target !== undefined) {
        e.preventDefault()
        // ↑ 进入历史编辑：整体替换文本 / 锚点 / 附件（含空附件清空旧草稿）
        applyHistoryEdit(target)
      }
    }
  }

  return (
    <div className="composer-shell">
      <div className="composer-inner">
        {widgets.length > 0 && (!isMobile || widgetsExpanded) ? (
          <div className="composer-widgets">
            {widgets.map((w) => (
              <div key={`${w.pluginId}/${w.spec.id}`} className="composer-widget-item">
                <PluginUiView
                  pluginId={w.pluginId}
                  spec={w.spec}
                  conversationId={conversation.id}
                  label={t('conv.composer.widgetLabel', { id: w.spec.id })}
                  slotProps={{ conversation, composer }}
                  composer={composer}
                />
              </div>
            ))}
          </div>
        ) : null}
        {/* Reserved slot at the top of the host composer: in-flight orchestration activity renders directly above the AskDock (never tucked into the more menu on desktop or mobile); collapses to zero height when idle. */}
        <PluginSlot
          ownerPluginId="builtin:composer"
          name={COMPOSER_DOCK_SLOT}
          conversationId={conversation.id}
          composer={composer}
          className="composer-dock-slot"
          slotProps={{ conversation, composer } satisfies ComposerScopeProps}
        />
        <AskDock conversationId={conversation.id} />
        {envConfigurable ? (
          <SessionEnvBar
            key={`env-${conversation.id}`}
            conversation={conversation}
            sendBlocked={sendInFlight}
            onBlockerChange={handleEnvBlocker}
          />
        ) : null}
        <div
          className="composer-box"
          ref={composerBoxRef}
          data-dragging={dragging ? 'true' : undefined}
          onDragEnter={onDragEnter}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {editingEntryId !== null ? (
            <div className="composer-edit-banner" role="status">
              <span className="composer-edit-banner-text">
                <HelmIcon name="edit" size={12} />
                <span>{working
                  ? t('conv.composer.editingWorking')
                  : t('conv.composer.editingIdle')}</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm composer-edit-cancel"
                onClick={cancelEdit}
                title={t('conv.composer.cancelEditTitle')}
              >
                <HelmIcon name="x" size={12} />
                <span>{t('common.cancel')}</span>
                <span className="kbd-hint composer-inline-kbd">Esc</span>
              </button>
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div className="composer-attachments">
              {attachments.map((att) => (
                <span key={att.artifactId} className="attachment-chip">
                  <HelmIcon name="paperclip" size={11} />
                  <span>{att.name}</span>
                  <span className="mono tabular-nums">{formatBytes(att.size)}</span>
                  <Tooltip content={t('composer.standby.removeAttachmentTitle', { name: att.name })} side="top">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon-xs"
                      title={t('composer.standby.removeAttachment')}
                      aria-label={t('composer.standby.removeAttachmentTitle', { name: att.name })}
                      onClick={() => removeAttachment(att.artifactId)}
                    >
                      <HelmIcon name="x" size={10} />
                    </button>
                  </Tooltip>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            aria-label={t('conv.composer.inputAria')}
            ref={textareaRef}
            className="composer-textarea selectable"
            value={text}
            rows={1}
            placeholder={getComposerPlaceholder(working, isMobile, t)}
            onChange={(e) => {
              setDraftState(e.target.value)
              detectPopover(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onKeyUp={handleTextareaKeyUp}
            onClick={handleTextareaClick}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
          />
          {slashOpen ? (
            <CommandPopover
              query={popoverQuery}
              slashItems={slashMenuItems}
              onPick={applySlashPick}
              onClose={closeSlashPopover}
            />
          ) : null}
          <CompletionPopover
            open={completionOpen}
            trigger={completionTrigger}
            snapshot={completionSnapshot}
            onPick={applyCompletionPick}
            onClose={closeCompletionPopover}
            anchorRef={composerBoxRef}
          />
          <div className="composer-toolbar">
            <div className="composer-toolbar-left">
              <Tooltip content={t('conv.composer.uploadAttachment')} side="top">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm composer-icon-button"
                  title={t('conv.composer.uploadAttachment')}
                  aria-label={t('conv.composer.uploadAttachment')}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <HelmIcon name="plus" size={19} />
                </button>
              </Tooltip>
              <ModelPicker conversation={conversation} />
              <ContextUsageStatus conversation={conversation} />
              {/* Reserved host status row slot: plugins contribute read-only content to the context usage status area
                  (e.g. builtin:token-speed live/final decode rates); on mobile it also stays
                  in the toolbar (never tucked into the more menu). */}
              <PluginSlot
                ownerPluginId="builtin:composer"
                name={COMPOSER_STATUS_SLOT}
                conversationId={conversation.id}
                composer={composer}
                className="composer-status-slot"
                slotProps={{ conversation, composer } satisfies ComposerScopeProps}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  if (files.length > 0) void uploadFiles(files)
                }}
              />
              {!isMobile ? (
                <span className="composer-pills">
                  {pills.map((p) => (
                    <span key={`${p.pluginId}/${p.spec.id}`} className="composer-pill-item">
                      <PluginUiView
                        pluginId={p.pluginId}
                        spec={p.spec}
                        conversationId={conversation.id}
                        label={t('conv.composer.pillLabel', { id: p.spec.id })}
                        slotProps={{ conversation, composer }}
                        composer={composer}
                      />
                    </span>
                  ))}
                </span>
              ) : pills.length > 0 || widgets.length > 0 ? (
                <details className="composer-extras" ref={extrasRef}>
                  <summary className="btn btn-ghost btn-sm composer-icon-button" aria-label={t('conv.composer.toolsLabel')} title={t('conv.composer.toolsLabel')}>
                    <HelmIcon name="more" size={18} />
                  </summary>
                  <div className="composer-popover composer-extras-popover">
                    {pills.map((p) => (
                      <div key={`${p.pluginId}/${p.spec.id}`} className="composer-pill-item">
                        <PluginUiView
                          pluginId={p.pluginId}
                          spec={p.spec}
                          conversationId={conversation.id}
                          label={t('conv.composer.pillLabel', { id: p.spec.id })}
                          slotProps={{ conversation, composer }}
                          composer={composer}
                        />
                      </div>
                    ))}
                    {widgets.length > 0 ? (
                      <button
                        type="button"
                        className="popover-item"
                        aria-expanded={widgetsExpanded}
                        onClick={(event) => {
                          setWidgetsExpanded((v) => !v)
                          event.currentTarget.closest('details')?.removeAttribute('open')
                        }}
                      >
                        <HelmIcon name="layers" size={15} />
                        {(() => {
                          const target = widgets.length === 1
                            ? resolveLocalizedText(widgets[0]!.spec.title ?? '', locale) || t('conv.composer.panels')
                            : t('conv.composer.panelsCount', { count: widgets.length })
                          return widgetsExpanded
                            ? t('conv.composer.collapsePanels', { target })
                            : t('conv.composer.viewPanels', { target })
                        })()}
                      </button>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </div>
            <ComposerSendControls
              working={working}
              editingEntryId={editingEntryId}
              sending={sending}
              uploading={uploading}
              envBlocker={envBlocker}
              text={text}
              isMobile={isMobile}
              send={send}
              abortTurn={abortTurn}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
