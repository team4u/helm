import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComposerScopeProps, ConversationSummary } from '@helm/protocol'
import { COMPOSER_DOCK_SLOT, COMPOSER_STATUS_SLOT } from '@helm/protocol'
import { conversationsApi } from '../lib/api.js'
import { buildSlashMenuItems, pluginSlashCommandsFor } from '../lib/commands-model.js'
import { HelmIcon, PluginSlot } from '@helm/plugin-client'
import { matchesUiScope } from '../lib/types.js'
import { useHelmStore } from '../lib/store-context.js'
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
  const usage = conversation.contextUsage
  if (usage === undefined) return null
  const label = contextUsageLabel(usage)
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
  const store = useHelmStore()
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
  const detail = store.conversationDetails[conversation.id]
  // 历史尚未完整加载且当前页没有 reset 时，不能把缺少消息的分页窗口当作空会话。
  const detailEntries = detail?.nextCursor && !detail.entries.some((entry) => entry.kind === 'pi.reset')
    ? undefined
    : detail?.entries
  const envConfigurable = canConfigureSessionEnv(detailEntries, conversation.status)

  const slashPluginCommands = useMemo(
    () => pluginSlashCommandsFor(store.groupedUi.commands, conversation),
    [store.groupedUi.commands, conversation],
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

  const widgets = store.groupedUi.composerWidgets.filter((w) => matchesUiScope(conversation, w.spec.scope))
  const pills = store.groupedUi.composerPills.filter((p) => matchesUiScope(conversation, p.spec.scope))

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
    completers: store.groupedUi.composerCompleters,
    conversation,
    resetKey: conversation.id,
  })

  // 斜杠菜单三源合并：宿主内置命令 + 当前会话可用技能（profile.skills 白名单 +
  // 插件启用双过滤，缺 Profile 时先不展示技能）+ 满足作用域的插件命令。
  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(store.plugins), [store.plugins])
  const conversationProfile = useMemo(
    () => store.profiles.find((p) => p.id === conversation.profileId),
    [store.profiles, conversation.profileId],
  )
  const availableSkills = useMemo(
    () => slashMenuSkills(conversationProfile, store.skills, enabledPluginIds),
    [conversationProfile, store.skills, enabledPluginIds],
  )
  useEffect(() => {
    setSlashMenuItems(
      buildSlashMenuItems(availableSkills, slashPluginCommands, runPluginCommand),
    )
  }, [availableSkills, slashPluginCommands, runPluginCommand])

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
      notifyError('中止回合失败', err)
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
    const currentModel = store.models.find((m) => m.id === conversation.model)
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
      notifyError('切换思考等级失败', err)
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
      return // 由浮层全局捕获处理（IME composing 时不拦截，交给输入法）
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
      const queued = latestHumanQueuedInput(store.conversationLives[conversation.id]?.queuedInputs)
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
                  label={`挂件 ${w.spec.id}`}
                  slotProps={{ conversation, composer }}
                  composer={composer}
                />
              </div>
            ))}
          </div>
        ) : null}
        {/* 宿主输入区顶部保留插槽：在途编排活动条直出在 AskDock 上方（桌面与移动端均不收入 more 菜单）；无在途内容时归零高度。 */}
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
                  ? '正在编辑历史消息 · 重新发送将覆盖此条及后续对话，并停止当前执行'
                  : '正在编辑历史消息 · 重新发送将覆盖此条及后续对话（含之后的人类消息）'}</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm composer-edit-cancel"
                onClick={cancelEdit}
                title="取消编辑 (Esc)"
              >
                <HelmIcon name="x" size={12} />
                <span>取消</span>
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
                  <Tooltip content={`移除附件 ${att.name}`} side="top">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon-xs"
                      title="移除附件"
                      aria-label={`移除附件 ${att.name}`}
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
            aria-label="输入消息"
            ref={textareaRef}
            className="composer-textarea selectable"
            value={text}
            rows={1}
            placeholder={getComposerPlaceholder(working, isMobile)}
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
              <Tooltip content="上传附件" side="top">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm composer-icon-button"
                  title="上传附件"
                  aria-label="上传附件"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <HelmIcon name="plus" size={19} />
                </button>
              </Tooltip>
              <ModelPicker conversation={conversation} />
              <ContextUsageStatus conversation={conversation} />
              {/* 宿主状态行保留插槽：插件向上下文用量同一状态区贡献只读内容
                  （如 builtin:token-speed 的实时/终态解码速率）；移动端同样
                  保留在工具栏（不收入 more 菜单）。 */}
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
                        label={`胶囊 ${p.spec.id}`}
                        slotProps={{ conversation, composer }}
                        composer={composer}
                      />
                    </span>
                  ))}
                </span>
              ) : pills.length > 0 || widgets.length > 0 ? (
                <details className="composer-extras" ref={extrasRef}>
                  <summary className="btn btn-ghost btn-sm composer-icon-button" aria-label="会话工具" title="会话工具">
                    <HelmIcon name="more" size={18} />
                  </summary>
                  <div className="composer-popover composer-extras-popover">
                    {pills.map((p) => (
                      <div key={`${p.pluginId}/${p.spec.id}`} className="composer-pill-item">
                        <PluginUiView
                          pluginId={p.pluginId}
                          spec={p.spec}
                          conversationId={conversation.id}
                          label={`胶囊 ${p.spec.id}`}
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
                        {widgetsExpanded ? '收起' : '查看'}{widgets.length === 1 ? widgets[0]?.spec.title ?? '会话面板' : `会话面板 (${widgets.length})`}
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
