import { useEffect, useMemo, useRef, useState } from 'react'
import { conversationsApi } from '../lib/api.js'
import type { ConversationAttachmentRef, ConversationEntry } from '@helm/protocol/browser'
import { HelmIcon, Popover, PopoverContent, PopoverTrigger } from '@helm/plugin-client'
import {
  isConversationArchivable,
  isConversationArchived,
  isConversationDeletable,
  isHumanSelectableProfile,
  partitionSidebarUi,
} from '../shell/sidebar-model.js'
import { patchConversationArchived } from '../shell/archive-ops.js'
import { useHelmStore } from '../lib/store-context.js'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/DropdownMenu.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import { Composer } from './Composer.js'
import { formatEnvSubtitle, sendingPendingVisible } from './composer-model.js'
import { buildAncestorChain } from './ancestry-model.js'
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
}

/** 会话顶栏 + 时间线 + AskDock(Composer 内) + Composer 微操舱。 */
export function ConversationPane({ conversationId, isSplit, onCloseSplit, isDrawer, onCloseDrawer }: ConversationPaneProps) {
  const store = useHelmStore()
  const detail = store.conversationDetails[conversationId]
  const summary = useMemo(() => store.conversations.find((c) => c.id === conversationId), [store.conversations, conversationId])
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
  const moreMenuRef = useRef<HTMLSpanElement | null>(null)
  const moreButtonRef = useRef<HTMLButtonElement | null>(null)

  const live = store.conversationLives[conversationId]
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
        timelineRenderers: store.groupedUi.timelineRenderers,
        toolViews: store.groupedUi.toolViews,
      }),
    [detailEntries, live, isWorking, isCompacting, store.groupedUi.timelineRenderers, store.groupedUi.toolViews],
  )
  const outlineNodes = useMemo(
    () => buildConversationOutline(timelineItems, { latestAssistantTurnFailed: conversation?.status === 'error' }),
    [timelineItems, conversation?.status],
  )

  const loadDetail = store.loadConversationDetail
  useEffect(() => {
    if (detail === undefined) {
      void loadDetail(conversationId, true)
    }
  }, [conversationId, detail, loadDetail])

  // 祖先面包屑链（根在前）：仅由 store.conversations 摘要推导，不引入平行路由状态。
  const ancestors = useMemo(
    () => buildAncestorChain(store.conversations, conversationId, conversation),
    [store.conversations, conversationId, conversation],
  )
  const ancestorTitle = (id: number): string =>
    store.conversations.find((conv) => conv.id === id)?.title ?? ''

  // 切换会话时关闭更多菜单与重置大纲滚动状态（组件复用时也保持确定语义）
  useEffect(() => {
    setMoreOpen(false)
    setOutlineScrollReq(null)
    setActiveOutlineEntryId(undefined)
  }, [conversationId])

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
    void store.loadEarlierEntries(conversationId).finally(() => setLoadingOlderOutline(false))
  }

  // 工作台汇总角标：内置产物计数 + 各插件面板 badge（从 public doc 动态提取）。
  const workbenchTabs = useWorkbenchTabs(conversationId, conversation)
  const workbenchBadge = summarizeWorkbenchBadge(workbenchTabs)
  const hasWorkbenchPanel = workbenchTabs.some((tab) => tab.id !== 'artifacts')
  const convArtifacts = store.conversationArtifacts[conversationId]
  const hasAnyArtifacts = Array.isArray(convArtifacts) && convArtifacts.length > 0
  const detailError = store.loadErrors[`conversation:${conversationId}`]
  if (detailError) {
    return (
      <div className={`${isSplit ? 'helm-split-pane' : 'helm-pane'} pane-error`} role="alert">
        <div className="pane-error-row">
          <p>Conversation #{conversationId} failed to load: {detailError}</p>
          <span className="pane-error-actions">
            <button className="btn" onClick={() => void store.loadConversationDetail(conversationId, true)}>Retry</button>
            {isDrawer && onCloseDrawer !== undefined ? (
              <button type="button" className="btn btn-sm btn-ghost conversation-drawer-close-btn" aria-label="Close drawer" onClick={onCloseDrawer}>Close</button>
            ) : isSplit && onCloseSplit !== undefined ? <CloseSplitButton onCloseSplit={onCloseSplit} /> : null}
          </span>
        </div>
      </div>
    )
  }

  if (conversation === undefined) {
    return (
      <div className={isSplit ? 'helm-split-pane' : 'helm-pane'} style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)', fontSize: 12 }}>
        Loading conversation #{conversationId}…
        {isDrawer && onCloseDrawer !== undefined ? (
          <span className="pane-loading-split-close">
            <button type="button" className="btn btn-sm btn-ghost conversation-drawer-close-btn" aria-label="Close drawer" onClick={onCloseDrawer}>
              <HelmIcon name="x" size={14} />
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
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: successTitle,
        conversationId,
      })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: `${successTitle} failed`,
        body: err instanceof Error ? err.message : String(err),
        conversationId,
      })
    } finally {
      setActionPending(null)
    }
  }

  const profile = store.profiles.find((p) => p.id === conversation.profileId)
  const profileStarters = profile !== undefined && profile.starters !== undefined && profile.starters.length > 0 ? profile.starters : undefined
  const enabledPluginIds = new Set(store.plugins.filter((p) => p.enabled).map((p) => p.id))
  const canCreateThread = profile !== undefined &&
    isHumanSelectableProfile(profile, enabledPluginIds) &&
    (conversation.ownedBy ?? 'human') === 'human'

  // 插件微插槽 conversation.header.action：placement='toolbar' 直出顶栏按钮组，
  // 其余（缺省 'menu'）收纳进「更多操作」下拉菜单；均按 scope 过滤当前会话。
  const headerActions = matchConversationActions(store.groupedUi.uiActions, 'conversation:header', conversation)
  const { toolbar: toolbarActions, menu: menuActions } = splitConversationHeaderActions(headerActions)
  const archived = isConversationArchived(conversation)
  const canManageArchive = isConversationArchivable(
    conversation,
    partitionSidebarUi([], store.groupedUi.sidebarSections).sectionTags,
  )

  const saveTitle = async (): Promise<void> => {
    const next = titleDraft.trim()
    setRenaming(false)
    if (next === '' || next === conversation.title) return
    await runAction('rename', () => conversationsApi.patch(conversationId, { title: next }), 'Conversation renamed')
  }

  const requestEdit = (target: EditRequestTarget): void => {
    // prefill 绑定会话 id：即使未来 Pane 复用不重挂载，旧会话的编辑目标也不会注入新会话 Composer
    setPrefill(target.text.trim() === '' && target.entryId === undefined ? null : { ...target, tick: Date.now() })
  }

  // 空白会话引导词：仅回填草稿（onlyIfEmpty 交 Composer 原子保护，非空草稿不覆盖）
  const requestStarter = (text: string): void => {
    setPrefill({ text, tick: Date.now(), onlyIfEmpty: true })
  }

  const toggleSplit = (): void => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (store.splitTarget !== null) {
      store.closeSplit()
      return
    }
    store.openTarget({ kind: 'conversation', conversationId }, { split: true })
  }

  // 祖先导航：主屏/分屏内直接切换该面板目标；抽屉内不顶掉主屏——
  // 祖先已在主屏/分屏时仅需收起抽屉，否则抽屉原位切换到祖先会话。
  const navigateToAncestor = (ancestorId: number): void => {
    if (isDrawer) {
      const onStage = [store.primaryTarget, store.splitTarget].some(
        (target) => target?.kind === 'conversation' && target.conversationId === ancestorId,
      )
      if (onStage) {
        onCloseDrawer?.()
        return
      }
      store.setActiveModal({ kind: 'conversation-drawer', conversationId: ancestorId })
      return
    }
    store.openTarget(
      { kind: 'conversation', conversationId: ancestorId },
      isSplit ? { split: true } : undefined,
    )
  }

  // 新话题：进入该智能体待命页并继承当前会话环境（远端节点/目录不回落本机）；
  // 首次发送才创建会话，不再预建空会话。
  const startNewThread = (): void => {
    store.openTarget(
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
    <div className="helm-pane">
      <header className="pane-topbar conversation-topbar">
        <div className="pane-title-group">
          {ancestors.length > 0 ? (
            <nav className="pane-breadcrumb" aria-label="Ancestor conversation navigation">
              {ancestors.map((ancestorId, index) => {
                const label = `#${ancestorId}`
                const tooltip = ancestorTitle(ancestorId) !== '' ? `${label} ${ancestorTitle(ancestorId)}` : `Conversation ${label}`
                return (
                  <span className="pane-breadcrumb-item" key={ancestorId}>
                    {index > 0 ? (
                      <span className="pane-breadcrumb-sep" aria-hidden="true">
                        <HelmIcon name="chevron-right" size={10} />
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-sm pane-parent-nav-btn"
                      title={tooltip}
                      aria-label={`Go to ancestor conversation #${ancestorId}`}
                      onClick={() => navigateToAncestor(ancestorId)}
                    >
                      {index === 0 ? <HelmIcon name="arrow-left" size={12} /> : null}
                      <span className="pane-parent-nav-label">{label}</span>
                    </button>
                  </span>
                )
              })}
            </nav>
          ) : null}
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
                  title={conversation.title === '' ? `Conversation #${conversationId}` : conversation.title}
                >
                  {conversation.title === '' ? `Conversation #${conversationId}` : conversation.title}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} portalled className="pane-title-popover">
                <div className="pane-title-popover-heading">
                  {conversation.title === '' ? `Conversation #${conversationId}` : conversation.title}
                </div>
                <div className="kv-grid pane-title-popover-meta">
                  <span className="kv-key">Conversation ID</span>
                  <span className="kv-val mono">#{conversationId}</span>
                  <span className="kv-key">Agents</span>
                  <span className="kv-val">{conversation.profileId}</span>
                  <span className="kv-key">Node</span>
                  <span className="kv-val mono">{currentNodeId}</span>
                  <span className="kv-key">Working directory</span>
                  <span className="kv-val mono">{conversation.cwd || '(not set)'}</span>
                  {conversation.ownedBy !== undefined ? (
                    <>
                      <span className="kv-key">Ownership</span>
                      <span className="kv-val mono">{conversation.ownedBy}</span>
                    </>
                  ) : null}
                  {conversation.model !== '' ? (
                    <>
                      <span className="kv-key">Model</span>
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
          {canCreateThread ? (
            <button
              type="button"
              className="btn btn-sm"
              aria-label="New topic"
              title="Start a new topic under the current agent"
              disabled={actionPending !== null}
              onClick={startNewThread}
            >
              <HelmIcon name={actionPending === 'new-thread' ? 'loader' : 'plus'} size={12} />
              <span className="pane-action-label">New topic</span>
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
          {!isDrawer && (workbenchCount > 0 || hasWorkbenchPanel || hasAnyArtifacts) ? (
            <button
              type="button"
              className={`btn btn-sm${store.workbenchOpen ? ' btn-primary' : ''}`}
              aria-label={workbenchCount > 0 ? `Workbench (${workbenchCount})` : 'Workbench'}
              title="Expand the right workbench (plugin panels and artifacts)"
              onClick={() => {
                // 打开首个可用页签；已打开时保持当前有效页签。
                const target = resolveActiveWorkbenchTab(
                  store.workbenchOpen ? store.workbenchTab : undefined,
                  workbenchTabs,
                )
                if (!store.workbenchOpen || target !== store.workbenchTab) store.setWorkbenchTab(target)
                store.setWorkbenchOpen(true)
              }}
            >
              <HelmIcon name="panel-right" size={12} />
              <span className="pane-action-label">Workbench</span>
              {workbenchCount > 0 && <span className={`badge ${workbenchBadgeClass} tabular-nums`}>{workbenchCount}</span>}
            </button>
          ) : null}
          {isDrawer && onCloseDrawer !== undefined ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost conversation-drawer-primary-btn"
              aria-label="Open this conversation fullscreen"
              title="Open this conversation fullscreen in the main view"
              onClick={() => {
                onCloseDrawer()
                store.openTarget({ kind: 'conversation', conversationId })
              }}
            >
              <HelmIcon name="external-link" size={12} />
              <span className="pane-action-label">Fullscreen</span>
            </button>
          ) : isSplit && onCloseSplit !== undefined ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <span className={store.splitTarget === null ? 'pane-split-btn' : undefined}>
              <SplitToggleButton
                isSplitActive={store.splitTarget !== null}
                onToggleSplit={toggleSplit}
              />
            </span>
          )}
          <span className="pane-more-menu" ref={moreMenuRef}>
            <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="More conversation actions"
                  title="More conversation actions"
                  aria-expanded={moreOpen}
                  ref={moreButtonRef}
                >
                  <HelmIcon name="more" size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent
                  className="pane-more-popover"
                  align="end"
                  sideOffset={6}
                  onCloseAutoFocus={(e) => {
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
                      <HelmIcon name="edit" size={13} />
                      Rename conversation
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="popover-item"
                    disabled={actionPending !== null || isCompacting}
                    onSelect={() => {
                      void runAction('compact', () => conversationsApi.compact(conversationId), 'Compaction submitted')
                    }}
                  >
                    <span className="pane-more-item-label">
                      <HelmIcon
                        name={compactPending ? 'loader' : 'archive'}
                        size={13}
                        className={compactPending ? 'spin-slow' : undefined}
                      />
                      {isCompacting ? 'Compacting context…' : 'Compact context (/compact)'}
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
                          archived ? 'Conversations restored' : 'Conversations archived',
                        )
                      }}
                    >
                      <span className="pane-more-item-label">
                        <HelmIcon
                          name={actionPending === 'archive' || actionPending === 'restore-archive'
                            ? 'loader'
                            : archived ? 'rotate-ccw' : 'archive'}
                          size={13}
                          className={actionPending === 'archive' || actionPending === 'restore-archive' ? 'spin-slow' : undefined}
                        />
                        {archived ? 'Restore conversation' : 'Archive conversation'}
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
                      <HelmIcon name={actionPending === 'reset' ? 'loader' : 'rotate-ccw'} size={13} />
                      Reset context (/reset)
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
                        <HelmIcon name="trash-2" size={13} />
                        Delete conversation
                      </span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
          </span>
          {isDrawer && onCloseDrawer !== undefined ? (
            <Tooltip content="Close child conversation drawer (Esc)" side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-ghost conversation-drawer-close-btn"
                aria-label="Close drawer"
                title="Close child conversation drawer (Esc)"
                onClick={onCloseDrawer}
              >
                <HelmIcon name="x" size={13} />
                <span className="pane-action-label">Close</span>
              </button>
            </Tooltip>
          ) : null}
        </div>
      </header>
      {isDrawer ? (
        <div className="pane-drawer-env-bar" aria-label="Child conversation environment">
          <span className="pane-drawer-env-item mono">#{conversationId}</span>
          <span className="pane-drawer-env-sep" aria-hidden="true">·</span>
          <span className="pane-drawer-env-item">
            <HelmIcon name="bot" size={11} />
            <span>{conversation.profileId}</span>
          </span>
          <span className="pane-drawer-env-sep" aria-hidden="true">·</span>
          <span className="pane-drawer-env-item mono" title={`${currentNodeId}:${conversation.cwd || '(not set)'}`}>
            <HelmIcon name={currentNodeId === 'local' ? 'laptop' : 'server'} size={11} />
            <span>{`${currentNodeId}:${conversation.cwd || '(not set)'}`}</span>
          </span>
          {conversation.ownedBy !== undefined ? (
            <>
              <span className="pane-drawer-env-sep" aria-hidden="true">·</span>
              <span className="badge badge-neutral">{`Owner ${conversation.ownedBy}`}</span>
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
        title={`Reset the context of conversation #${conversationId}?`}
        description="History is preserved; the model starts from a fresh context."
        confirmText="Reset context"
        danger
        onConfirm={() => {
          setConfirmAction(null)
          void runAction('reset', () => conversationsApi.reset(conversationId), 'Context reset')
        }}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmDialog
        open={confirmAction === 'delete'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
        title={`Delete conversation #${conversationId}?`}
        description="This action cannot be undone."
        confirmText="Delete conversation"
        danger
        onConfirm={() => {
          setConfirmAction(null)
          void (async () => {
            try {
              await conversationsApi.remove(conversationId)
              // 导航由 conversation.deleted 事件按当前目标做条件更新；这里不使用
              // await 前捕获的主屏/分屏快照，避免删除完成时打断用户的新导航。
              store.pushNotice({
                type: 'notification',
                level: 'info',
                title: 'Conversation deleted',
                body: `Conversation #${conversationId} deleted`,
              })
            } catch (err) {
              store.pushNotice({
                type: 'notification',
                level: 'error',
                title: 'Failed to delete conversation',
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
