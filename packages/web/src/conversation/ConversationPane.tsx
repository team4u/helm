import { useEffect, useMemo, useRef, useState } from 'react'
import { conversationsApi } from '../lib/api.js'
import type { ConversationAttachmentRef, ConversationEntry } from '@helmx/protocol/browser'
import { HelmxIcon, Popover, PopoverContent, PopoverTrigger } from '@helmx/plugin-client'
import {
  isConversationArchivable,
  isConversationArchived,
  isConversationDeletable,
  isHumanSelectableProfile,
  partitionSidebarUi,
} from '../shell/sidebar-model.js'
import { patchConversationArchived } from '../shell/archive-ops.js'
import {
  useConversationArtifacts,
  useConversationDetail,
  useConversationLive,
  useConversationSummary,
  useConversations,
  useGroupedUi,
  useLoadError,
  useLocationTargets,
  usePlugins,
  useProfilesSlice,
  useStoreActions,
  useWorkbenchState,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/DropdownMenu.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import { Composer } from './Composer.js'
import { formatEnvSubtitle, sendingPendingVisible } from './composer-model.js'
import { ConversationOutlinePopover, type OutlineJumpTarget } from './ConversationOutlinePopover.js'
import { ConversationTimeline, type OutlineScrollRequest } from './ConversationTimeline.js'
import { buildConversationOutline } from './outline-model.js'
import { resolveActiveWorkbenchTab, summarizeWorkbenchBadge } from './workbench-model.js'
import { useWorkbenchTabs } from './workbench-hooks.js'
import { matchConversationActions, splitConversationHeaderActions } from './action-model.js'
import { PluginMicroAction } from '../ui/PluginMicroAction.js'
import { buildTimelineItems, type EditRequestTarget } from './timeline-model.js'

const EMPTY_ENTRIES: ReadonlyArray<ConversationEntry> = []

export interface ConversationPaneProps {
  conversationId: number
  isSplit?: boolean
  onCloseSplit?: () => void
  isDrawer?: boolean
  onCloseDrawer?: () => void
  /**
   * Keep-alive staging flag (window pool): false while the pane lives inside a hidden
   * <Activity>. Hidden panes close ephemeral overlays (menus, confirm dialogs, rename input)
   * so waking never resurrects stale chrome; default true for split/drawer panes.
   */
  staged?: boolean
}

/** 会话顶栏 + 时间线 + AskDock(Composer 内) + Composer 微操舱。 */
export function ConversationPane({ conversationId, isSplit, onCloseSplit, isDrawer, onCloseDrawer, staged = true }: ConversationPaneProps) {
  const detail = useConversationDetail(conversationId)
  const summary = useConversationSummary(conversationId)
  const conversations = useConversations()
  const live = useConversationLive(conversationId)
  const groupedUi = useGroupedUi()
  const convArtifacts = useConversationArtifacts(conversationId)
  const detailError = useLoadError(`conversation:${conversationId}`)
  const { profiles } = useProfilesSlice()
  const plugins = usePlugins()
  const { splitTarget } = useLocationTargets()
  const { workbenchOpen, workbenchTab } = useWorkbenchState()
  const {
    loadConversationDetail,
    loadEarlierEntries,
    pushNotice,
    closeSplit,
    openTarget,
    setWorkbenchTab,
    setWorkbenchOpen,
  } = useStoreActions()
  const { t } = useWebLocale()
  const conversation = summary ?? detail
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [actionPending, setActionPending] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [prefill, setPrefill] = useState<{ text: string; entryId?: number; attachments?: ConversationAttachmentRef[]; tick: number; onlyIfEmpty?: boolean } | null>(null)
  const [sendingInFlight, setSendingInFlight] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'reset' | 'delete' | null>(null)
  const [outlineScrollReq, setOutlineScrollReq] = useState<OutlineScrollRequest | null>(null)
  const [activeOutlineEntryId, setActiveOutlineEntryId] = useState<string | undefined>(undefined)
  const [loadingOlderOutline, setLoadingOlderOutline] = useState(false)
  const outlineTickRef = useRef(0)
  const prefillTickRef = useRef(0)
  const prevConversationIdRef = useRef(conversationId)
  const moreMenuRef = useRef<HTMLSpanElement | null>(null)
  const moreButtonRef = useRef<HTMLButtonElement | null>(null)
  const moreInteractedOutsideRef = useRef(false)

  const isWorking = conversation?.status === 'working'
  const isCompacting = conversation?.contextUsage?.compacting === true
  const compactPending = actionPending === 'compact' || isCompacting
  const detailEntries = detail?.entries ?? EMPTY_ENTRIES
  const timelineItems = useMemo(
    () =>
      buildTimelineItems(detailEntries, {
        ...(live !== undefined ? { live } : {}),
        working: isWorking,
        compacting: isCompacting,
        timelineRenderers: groupedUi.timelineRenderers,
        toolViews: groupedUi.toolViews,
      }),
    [detailEntries, live, isWorking, isCompacting, groupedUi.timelineRenderers, groupedUi.toolViews],
  )
  const outlineNodes = useMemo(
    () => buildConversationOutline(timelineItems, { latestAssistantTurnFailed: conversation?.status === 'error' }),
    [timelineItems, conversation?.status],
  )

  useEffect(() => {
    if (detail === undefined) {
      void loadConversationDetail(conversationId, true)
    }
  }, [conversationId, detail, loadConversationDetail])

  // 切换会话时关闭更多菜单、重置大纲滚动状态与清空未消费的 prefill（组件复用时也保持确定语义）
  useEffect(() => {
    if (prevConversationIdRef.current === conversationId) return
    prevConversationIdRef.current = conversationId
    setMoreOpen(false)
    setOutlineScrollReq(null)
    setActiveOutlineEntryId(undefined)
    setPrefill(null)
  }, [conversationId])

  // 失去舞台（窗口被 <Activity> 隐藏）：关闭瞬态浮层（更多菜单、确认弹窗、重命名），
  // 避免唤醒时复活过期 chrome；锚定 Popover/Dropdown 由 Radix 的 dismiss 层自行关闭。
  useEffect(() => {
    if (staged) return
    setMoreOpen(false)
    setConfirmAction(null)
    setRenaming(false)
  }, [staged])

  const jumpToOutlineTarget = (target: OutlineJumpTarget): void => {
    outlineTickRef.current += 1
    setOutlineScrollReq({
      entryId: target.entryId,
      ...(target.headingIndex !== undefined ? { headingIndex: target.headingIndex } : {}),
      ...(target.cardId !== undefined ? { cardId: target.cardId } : {}),
      tick: outlineTickRef.current,
    })
  }

  const loadEarlierForOutline = (): void => {
    if (loadingOlderOutline || !detail?.nextCursor) return
    setLoadingOlderOutline(true)
    void loadEarlierEntries(conversationId).finally(() => setLoadingOlderOutline(false))
  }

  // 工作台汇总角标：内置产物计数 + 各插件面板 badge（从 public doc 动态提取）。
  const workbenchTabs = useWorkbenchTabs(conversationId, conversation)
  const workbenchBadge = summarizeWorkbenchBadge(workbenchTabs)
  const hasWorkbenchPanel = workbenchTabs.some((tab) => tab.id !== 'artifacts')
  const hasAnyArtifacts = Array.isArray(convArtifacts) && convArtifacts.length > 0
  if (detailError) {
    return (
      <div className={`${isSplit ? 'helmx-split-pane' : 'helmx-pane'} pane-error`} role="alert">
        <div className="pane-error-row">
          <p>{t('conv.pane.loadFailed', { id: conversationId, error: detailError })}</p>
          <span className="pane-error-actions">
            <button className="btn" onClick={() => void loadConversationDetail(conversationId, true)}>{t('common.retry')}</button>
            {isDrawer && onCloseDrawer !== undefined ? (
              <button type="button" className="btn btn-sm btn-ghost conversation-drawer-close-btn" aria-label={t('conv.pane.closeDrawerAria')} onClick={onCloseDrawer}>{t('common.close')}</button>
            ) : isSplit && onCloseSplit !== undefined ? <CloseSplitButton onCloseSplit={onCloseSplit} /> : null}
          </span>
        </div>
      </div>
    )
  }

  if (conversation === undefined) {
    return (
      <div className={isSplit ? 'helmx-split-pane' : 'helmx-pane'} style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)', fontSize: 12 }}>
        {t('conv.pane.loading', { id: conversationId })}
        {isDrawer && onCloseDrawer !== undefined ? (
          <span className="pane-loading-split-close">
            <button type="button" className="btn btn-sm btn-ghost conversation-drawer-close-btn" aria-label={t('conv.pane.closeDrawerAria')} onClick={onCloseDrawer}>
              <HelmxIcon name="x" size={14} />
            </button>
          </span>
        ) : isSplit && onCloseSplit !== undefined ? (
          <span className="pane-loading-split-close">
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          </span>
        ) : null}
      </div>
    )
  }

  const sendingPending = sendingPendingVisible(sendingInFlight, conversation.status)
  // 计数与色调由插件 public-doc badge 与内置产物共同决定。
  const workbenchCount = workbenchBadge.totalCount
  const workbenchBadgeClass = workbenchBadge.tone === 'warn' ? 'badge-warn' : workbenchBadge.tone === 'accent' ? 'badge-accent' : 'badge-neutral'
  const currentNodeId = conversation.nodeId || 'local'
  const envSubtitle = formatEnvSubtitle({
    profileId: conversation.profileId,
    nodeId: currentNodeId,
    cwd: conversation.cwd,
  })
  const envSubtitleCompact = formatEnvSubtitle({
    profileId: conversation.profileId,
    nodeId: currentNodeId,
    cwd: conversation.cwd,
    compact: true,
  })
  const remoteNodeTag = envSubtitleCompact.text !== '' ? envSubtitleCompact.text : null

  const runAction = async (name: string, fn: () => Promise<unknown>, successTitle: string): Promise<void> => {
    setActionPending(name)
    try {
      await fn()
      pushNotice({
        type: 'notification',
        level: 'info',
        title: successTitle,
        conversationId,
      })
    } catch (err) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('conv.pane.actionFailedTitle', { title: successTitle }),
        body: err instanceof Error ? err.message : String(err),
        conversationId,
      })
    } finally {
      setActionPending(null)
    }
  }

  const profile = profiles.find((p) => p.id === conversation.profileId)
  const profileStarters = profile !== undefined && profile.starters !== undefined && profile.starters.length > 0 ? profile.starters : undefined
  const enabledPluginIds = new Set(plugins.filter((p) => p.enabled).map((p) => p.id))
  const canCreateThread = profile !== undefined &&
    isHumanSelectableProfile(profile, enabledPluginIds) &&
    (conversation.ownedBy ?? 'human') === 'human'

  // 插件微插槽 conversation.header.action：placement='toolbar' 直出顶栏按钮组，
  // 其余（缺省 'menu'）收纳进「更多操作」下拉菜单；均按 scope 过滤当前会话。
  const headerActions = matchConversationActions(groupedUi.uiActions, 'conversation:header', conversation)
  const { toolbar: toolbarActions, menu: menuActions } = splitConversationHeaderActions(headerActions)
  const archived = isConversationArchived(conversation)
  const sidebarPartition = partitionSidebarUi([], groupedUi.sidebarSections)
  const canManageArchive = isConversationArchivable(conversation, sidebarPartition.sectionTags)

  const saveTitle = async (): Promise<void> => {
    const next = titleDraft.trim()
    setRenaming(false)
    if (next === '' || next === conversation.title) return
    await runAction('rename', () => conversationsApi.patch(conversationId, { title: next }), t('conv.pane.conversationRenamed'))
  }

  const requestEdit = (target: EditRequestTarget): void => {
    // prefill 绑定会话 id：即使未来 Pane 复用不重挂载，旧会话的编辑目标也不会注入新会话 Composer
    if (target.text.trim() === '' && target.entryId === undefined) {
      setPrefill(null)
      return
    }
    prefillTickRef.current += 1
    setPrefill({ ...target, tick: prefillTickRef.current })
  }

  // 空白会话引导词：仅回填草稿（onlyIfEmpty 交 Composer 原子保护，非空草稿不覆盖）
  const requestStarter = (text: string): void => {
    prefillTickRef.current += 1
    setPrefill({ text, tick: prefillTickRef.current, onlyIfEmpty: true })
  }

  const toggleSplit = (): void => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (splitTarget !== null) {
      closeSplit()
      return
    }
    openTarget({ kind: 'conversation', conversationId }, { split: true })
  }

  // 新话题：进入该智能体待命页并继承当前会话环境（远端节点/目录不回落本机）；
  // 首次发送才创建会话，不再预建空会话。
  const startNewThread = (): void => {
    openTarget(
      {
        kind: 'agent',
        profileId: conversation.profileId,
        ...(currentNodeId !== 'local' ? { nodeId: currentNodeId } : {}),
        ...(conversation.cwd !== '' ? { cwd: conversation.cwd } : {}),
      },
      isSplit ? { split: true } : undefined,
    )
  }

  return (
    <div className="helmx-pane">
      <header className="pane-topbar conversation-topbar">
        <div className="pane-title-group">
          {renaming ? (
            <input
              className="input"
              style={{ maxWidth: 320, height: 26 }}
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveTitle()
                else if (e.key === 'Escape') setRenaming(false)
              }}
              onBlur={() => void saveTitle()}
            />
          ) : (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="pane-title pane-title-btn"
                  title={conversation.title === '' ? t('conv.pane.titleFallback', { id: conversationId }) : conversation.title}
                >
                  {conversation.title === '' ? t('conv.pane.titleFallback', { id: conversationId }) : conversation.title}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} portalled className="pane-title-popover">
                <div className="pane-title-popover-heading">
                  {conversation.title === '' ? t('conv.pane.titleFallback', { id: conversationId }) : conversation.title}
                </div>
                <div className="kv-grid pane-title-popover-meta">
                  <span className="kv-key">{t('conv.pane.metaConversationId')}</span>
                  <span className="kv-val mono">#{conversationId}</span>
                  <span className="kv-key">{t('conv.pane.metaAgents')}</span>
                  <span className="kv-val">{conversation.profileId}</span>
                  <span className="kv-key">{t('conv.pane.metaNode')}</span>
                  <span className="kv-val mono">{currentNodeId}</span>
                  <span className="kv-key">{t('conv.pane.metaCwd')}</span>
                  <span className="kv-val mono">{conversation.cwd || t('conv.pane.cwdNotSet')}</span>
                  {conversation.ownedBy !== undefined ? (
                    <>
                      <span className="kv-key">{t('conv.pane.metaOwnership')}</span>
                      <span className="kv-val mono">{conversation.ownedBy}</span>
                    </>
                  ) : null}
                  {conversation.model !== '' ? (
                    <>
                      <span className="kv-key">{t('conv.pane.metaModel')}</span>
                      <span className="kv-val mono">{conversation.model}</span>
                    </>
                  ) : null}
                </div>
              </PopoverContent>
            </Popover>
          )}
          <span className="pane-cwd-subtitle" title={envSubtitle.tooltip}>
            <span className="env-subtitle-full">{envSubtitle.text}</span>
            {remoteNodeTag !== null ? <span className="env-subtitle-compact">{remoteNodeTag}</span> : null}
          </span>
        </div>
        <div className="pane-actions">
          <ConversationOutlinePopover
            nodes={outlineNodes}
            activeEntryId={activeOutlineEntryId}
            hasEarlierHistory={Boolean(detail?.nextCursor)}
            loadingEarlierHistory={loadingOlderOutline}
            onLoadEarlierHistory={loadEarlierForOutline}
            onSelectTarget={jumpToOutlineTarget}
          />
          {/* 抽屉是叠加在主语境之上的检视面（任务会话 / 子代理轨迹 / 总览直达共用），
              「新话题」属于主屏导航动作，在抽屉里只会把底下主屏带走——一律不渲染。 */}
          {canCreateThread && !isDrawer ? (
            <button
              type="button"
              className="btn btn-sm"
              aria-label={t('conv.pane.newTopic')}
              title={t('conv.pane.newTopicTitle')}
              disabled={actionPending !== null}
              onClick={startNewThread}
            >
              <HelmxIcon name={actionPending === 'new-thread' ? 'loader' : 'plus'} size={12} />
              <span className="pane-action-label">{t('conv.pane.newTopic')}</span>
            </button>
          ) : null}
          {toolbarActions.map((action) => (
            <PluginMicroAction
              key={`header:${action.pluginId}/${action.spec.id}`}
              action={action}
              variant="toolbar"
              conversationId={conversation.id}
              slotProps={{ conversation }}
            />
          ))}
          {(workbenchCount > 0 || hasWorkbenchPanel || hasAnyArtifacts) ? (
            <button
              type="button"
              className={`btn btn-sm${workbenchOpen ? ' btn-primary' : ''}`}
              aria-label={workbenchCount > 0 ? t('conv.pane.workbenchWithCount', { count: workbenchCount }) : t('conv.pane.workbench')}
              title={t('conv.pane.workbenchTitle')}
              onClick={() => {
                // 打开首个可用页签；已打开时保持当前有效页签。
                const target = resolveActiveWorkbenchTab(
                  workbenchOpen ? workbenchTab : undefined,
                  workbenchTabs,
                )
                if (!workbenchOpen || target !== workbenchTab) setWorkbenchTab(target)
                setWorkbenchOpen(true)
              }}
            >
              <HelmxIcon name="panel-right" size={12} />
              <span className="pane-action-label">{t('conv.pane.workbench')}</span>
              {workbenchCount > 0 && <span className={`badge ${workbenchBadgeClass} tabular-nums`}>{workbenchCount}</span>}
            </button>
          ) : null}
          {isDrawer && onCloseDrawer !== undefined ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost conversation-drawer-primary-btn"
              aria-label={t('conv.pane.openFullscreen')}
              title={t('conv.pane.openFullscreenTitle')}
              onClick={() => {
                onCloseDrawer()
                openTarget({ kind: 'conversation', conversationId })
              }}
            >
              <HelmxIcon name="external-link" size={12} />
              <span className="pane-action-label">{t('conv.pane.fullscreen')}</span>
            </button>
          ) : isSplit && onCloseSplit !== undefined ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <span className={splitTarget === null ? 'pane-split-btn' : undefined}>
              <SplitToggleButton
                isSplitActive={splitTarget !== null}
                onToggleSplit={toggleSplit}
              />
            </span>
          )}
          <span className="pane-more-menu" ref={moreMenuRef}>
            <DropdownMenu
              open={moreOpen}
              onOpenChange={(next) => {
                if (next) moreInteractedOutsideRef.current = false
                setMoreOpen(next)
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('conv.pane.moreActions')}
                  title={t('conv.pane.moreActions')}
                  aria-expanded={moreOpen}
                  ref={moreButtonRef}
                >
                  <HelmxIcon name="more" size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent
                  className="pane-more-popover"
                  align="end"
                  sideOffset={6}
                  onInteractOutside={() => {
                    moreInteractedOutsideRef.current = true
                  }}
                  onCloseAutoFocus={(e) => {
                    if (moreInteractedOutsideRef.current) {
                      moreInteractedOutsideRef.current = false
                      return
                    }
                    e.preventDefault()
                    moreButtonRef.current?.focus()
                  }}
                >
                  <DropdownMenuItem
                    className="popover-item"
                    onSelect={() => {
                      setTitleDraft(conversation.title)
                      setRenaming(true)
                    }}
                  >
                    <span className="pane-more-item-label">
                      <HelmxIcon name="edit" size={13} />
                      {t('conv.pane.renameConversation')}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="popover-item"
                    disabled={actionPending !== null || isCompacting}
                    onSelect={() => {
                      void runAction('compact', () => conversationsApi.compact(conversationId), t('conv.pane.compactionSubmitted'))
                    }}
                  >
                    <span className="pane-more-item-label">
                      <HelmxIcon
                        name={compactPending ? 'loader' : 'archive'}
                        size={13}
                        className={compactPending ? 'spin-slow' : undefined}
                      />
                      {isCompacting ? t('conv.divider.compacting') : t('conv.pane.compactContext')}
                    </span>
                  </DropdownMenuItem>
                  {canManageArchive && (
                    <DropdownMenuItem
                      className="popover-item"
                      disabled={actionPending !== null}
                      onSelect={() => {
                        void runAction(
                          archived ? 'restore-archive' : 'archive',
                          () => patchConversationArchived(conversation, !archived),
                          archived ? t('conv.pane.restored') : t('conv.pane.archived'),
                        )
                      }}
                    >
                      <span className="pane-more-item-label">
                        <HelmxIcon
                          name={actionPending === 'archive' || actionPending === 'restore-archive'
                            ? 'loader'
                            : archived ? 'rotate-ccw' : 'archive'}
                          size={13}
                          className={actionPending === 'archive' || actionPending === 'restore-archive' ? 'spin-slow' : undefined}
                        />
                        {archived ? t('conv.pane.restoreConversation') : t('conv.pane.archiveConversation')}
                      </span>
                    </DropdownMenuItem>
                  )}
                  {menuActions.length > 0 && (
                    <>
                      <DropdownMenuSeparator className="popover-separator" />
                      {menuActions.map((action) => (
                        <PluginMicroAction
                          key={`header-menu:${action.pluginId}/${action.spec.id}`}
                          action={action}
                          variant="menu"
                          inDropdown
                          conversationId={conversation.id}
                          slotProps={{ conversation }}
                          onInvoked={() => setMoreOpen(false)}
                        />
                      ))}
                    </>
                  )}
                  <DropdownMenuSeparator className="popover-separator" />
                  <DropdownMenuItem
                    className="popover-item popover-item-danger"
                    danger
                    disabled={actionPending !== null}
                    onSelect={() => {
                      setConfirmAction('reset')
                    }}
                  >
                    <span className="pane-more-item-label">
                      <HelmxIcon name={actionPending === 'reset' ? 'loader' : 'rotate-ccw'} size={13} />
                      {t('conv.pane.resetContextCmd')}
                    </span>
                  </DropdownMenuItem>
                  {isConversationDeletable(conversation) && (
                    <DropdownMenuItem
                      className="popover-item popover-item-danger"
                      danger
                      onSelect={() => {
                        setConfirmAction('delete')
                      }}
                    >
                      <span className="pane-more-item-label">
                        <HelmxIcon name="trash-2" size={13} />
                        {t('conv.pane.deleteConversation')}
                      </span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
          </span>
          {isDrawer && onCloseDrawer !== undefined ? (
            <Tooltip content={t('conv.pane.closeChildDrawer')} side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-ghost conversation-drawer-close-btn"
                aria-label={t('conv.pane.closeDrawerAria')}
                title={t('conv.pane.closeChildDrawer')}
                onClick={onCloseDrawer}
              >
                <HelmxIcon name="x" size={13} />
                <span className="pane-action-label">{t('common.close')}</span>
              </button>
            </Tooltip>
          ) : null}
        </div>
      </header>
      {isDrawer ? (
        <div className="pane-drawer-env-bar" aria-label={t('conv.pane.childEnv')}>
          <span className="pane-drawer-env-item mono">#{conversationId}</span>
          <span className="pane-drawer-env-sep" aria-hidden="true">·</span>
          <span className="pane-drawer-env-item">
            <HelmxIcon name="bot" size={11} />
            <span>{conversation.profileId}</span>
          </span>
          <span className="pane-drawer-env-sep" aria-hidden="true">·</span>
          <span className="pane-drawer-env-item mono" title={`${currentNodeId}:${conversation.cwd || t('conv.pane.cwdNotSet')}`}>
            <HelmxIcon name={currentNodeId === 'local' ? 'laptop' : 'server'} size={11} />
            <span>{`${currentNodeId}:${conversation.cwd || t('conv.pane.cwdNotSet')}`}</span>
          </span>
          {conversation.ownedBy !== undefined ? (
            <>
              <span className="pane-drawer-env-sep" aria-hidden="true">·</span>
              <span className="badge badge-neutral">{t('conv.pane.ownerBadge', { owner: conversation.ownedBy })}</span>
            </>
          ) : null}
        </div>
      ) : null}

      <ConversationTimeline
        conversation={conversation}
        detailEntries={detailEntries}
        timelineItems={timelineItems}
        sendingPending={sendingPending}
        outlineScrollRequest={outlineScrollReq}
        onActiveEntryChange={setActiveOutlineEntryId}
        {...(live !== undefined ? { live } : {})}
        starters={profileStarters}
        onRequestEdit={requestEdit}
        onRequestStarter={requestStarter}
      />

      <Composer key={`composer-${conversation.id}`} conversation={conversation} prefill={prefill} onSendingChange={setSendingInFlight} onNewThread={startNewThread} />

      <ConfirmDialog
        open={confirmAction === 'reset'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
        title={t('conv.pane.resetConfirmTitle', { id: conversationId })}
        description={t('conv.pane.resetConfirmDesc')}
        confirmText={t('conv.pane.resetConfirmAction')}
        danger
        onConfirm={() => {
          setConfirmAction(null)
          void runAction('reset', () => conversationsApi.reset(conversationId), t('conv.pane.contextReset'))
        }}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmDialog
        open={confirmAction === 'delete'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
        title={t('conv.pane.deleteConfirmTitle', { id: conversationId })}
        description={t('conv.pane.deleteConfirmDesc')}
        confirmText={t('conv.pane.deleteConversation')}
        danger
        onConfirm={() => {
          setConfirmAction(null)
          void (async () => {
            try {
              await conversationsApi.remove(conversationId)
              // 导航由 conversation.deleted 事件按当前目标做条件更新；这里不使用
              // await 前捕获的主屏/分屏快照，避免删除完成时打断用户的新导航。
              pushNotice({
                type: 'notification',
                level: 'info',
                title: t('conv.pane.conversationDeleted'),
                body: t('conv.pane.conversationDeletedBody', { id: conversationId }),
              })
            } catch (err) {
              pushNotice({
                type: 'notification',
                level: 'error',
                title: t('conv.pane.deleteFailed'),
                body: err instanceof Error ? err.message : String(err),
              })
            }
          })()
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  )
}
