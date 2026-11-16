import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { conversationsApi } from '../lib/api.js'
import type { ConversationSummary } from '@helm/protocol/browser'
import { archiveBatchNotice, patchConversationsArchived } from './archive-ops.js'
import { HelmIcon, Checkbox } from '@helm/plugin-client'
import { Tooltip } from '../ui/Tooltip.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import type { HelmStoreValue } from '../lib/types.js'
import {
  AGENT_SUB_LIST_PREVIEW,
  activeConversationIdsOf,
  activeProfileIdsOf,
  buildAgentStandings,
  filterAgentStandings,
  filterDeletableConversations,
  getAgentStandbyPresence,
  getConversationPresence,
  isConversationDeletable,
  openAgentStandby,
  presenceNavClassSuffix,
  type AgentStanding,
} from './sidebar-model.js'
import {
  resolveStandingStatusIndicator,
  resolveAgentSubListPreview,
  type ConversationBackgroundActivity,
  type ConversationBackgroundIndex,
} from './background-activity-model.js'
import {
  ConversationStatusDot,
  RemoteNodeTag,
  SidebarPaneTag,
  StandingStatusDot,
} from './SidebarPrimitives.js'

/** Agent 站位「+」按钮：进入待命页开始新话题（首次发送才创建会话）；仅人类可选 Agent 渲染。 */
function AgentNewConversationButton({
  agent,
  onCreate,
}: {
  agent: AgentStanding
  onCreate: (profileId: string) => void
}) {
  if (!agent.canCreateConversation) return null
  return (
    <Tooltip content={`在 ${agent.label} 下开始新话题`} side="right">
      <button
        type="button"
        className="btn btn-ghost btn-icon-xs agent-new-conv-btn"
        title={`在 ${agent.label} 下开始新话题`}
        aria-label={`在 ${agent.label} 下开始新话题`}
        onClick={(e) => {
          e.stopPropagation()
          onCreate(agent.profileId)
        }}
      >
        <HelmIcon name="plus" size={13} />
      </button>
    </Tooltip>
  )
}

/**
 * Agent 站位行（一级，按主/分屏及筛选状态自动展开，无折叠钮）：
 * - 普通模式：待命亮父行、进会话仅亮子行（父行呈归属分支弱态），点击名称进入待命态；
 * - 批量模式：点击行或名称切换子列表展开，展开后渲染扁平会话清单供勾选删除。
 */
function AgentStandingItem({
  agent,
  store,
  background,
  activeProfileIds,
  activeConversationIds,
  searching,
  onCreate,
  onNavigate,
  batchMode,
  selectedIds,
  onToggleSelect,
}: {
  agent: AgentStanding
  store: HelmStoreValue
  background: ConversationBackgroundIndex
  activeProfileIds: ReadonlySet<string>
  activeConversationIds: ReadonlySet<number>
  searching: boolean
  onCreate: (profileId: string) => void
  onNavigate?: () => void
  batchMode?: boolean
  selectedIds?: Set<number>
  onToggleSelect?: (id: number) => void
}) {
  // 批量模式下：只要该 Agent 有会话（length > 0），就展开子列表展示会话行供勾选删除；
  // 机器人的主站位行永远代表角色 Profile，绝不提供勾选框，避免用户误勾选机器人。
  const hasSubList = agent.conversations.length > 0
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)

  const standbyPresence = getAgentStandbyPresence(store, agent.profileId)
  const hasActiveChild = agent.conversations.some((c) => {
    const p = getConversationPresence(store, c.id)
    return p.inPrimary || p.inSplit
  })
  // 归属分支弱态：子会话在主/分屏打开且父站位未进入待命态时仅提亮加粗文字，不抢子行高亮
  const isBranchActive = !standbyPresence.active && !standbyPresence.splitSecondary && hasActiveChild
  // 折叠态站位指示器：聚合名下全部会话（基础状态优先级 + 后台在途），
  // 不只看 primaryConversation——后台活跃的非 primary 会话同样透出。
  const standingIndicator = useMemo(
    () => resolveStandingStatusIndicator(agent.conversations, background),
    [agent.conversations, background],
  )
  // 无折叠钮：展开由筛选态或主/分屏当前目标推导（支持分屏双智能体协同展开）。
  const isOpen = batchMode
    ? hasSubList && expanded
    : hasSubList && (searching || activeProfileIds.has(agent.profileId))

  const openPrimary = () => {
    if (batchMode) {
      if (hasSubList) setExpanded((v) => !v)
      return
    }
    // 名称是稳定待命入口：人类可选 Agent 一律进入待命态（首次发送才落库），
    // 不自动跳进旧会话；仅不可新建的受管 singleton 打开其真实会话。
    if (agent.canCreateConversation) {
      openAgentStandby(store, agent.profileId, onNavigate)
      return
    }
    const primary = agent.primaryConversation
    if (primary) {
      store.openTarget({ kind: 'conversation', conversationId: primary.id })
      onNavigate?.()
    }
  }

  return (
    <div className={`agent-standing${isOpen ? ' agent-standing-open' : ''}`}>
      <div
        className={`nav-item agent-standing-row${presenceNavClassSuffix(standbyPresence)}${isBranchActive ? ' agent-standing-row-branch' : ''}`}
        onClick={() => {
          if (batchMode && hasSubList) {
            setExpanded((v) => !v)
          }
        }}
      >
        <button
          type="button"
          className="nav-item-main nav-open"
          onClick={(e) => {
            if (batchMode) {
              e.stopPropagation()
              if (hasSubList) setExpanded((v) => !v)
              return
            }
            openPrimary()
          }}
          disabled={!batchMode && !agent.primaryConversation && !agent.canCreateConversation}
          aria-current={standbyPresence.active ? 'page' : undefined}
        >
          <span className="nav-status-slot">
            {!isOpen && standingIndicator !== null && <StandingStatusDot indicator={standingIndicator} />}
          </span>
          <span className="nav-item-label">{agent.label}</span>
        </button>
        <span className="nav-item-meta" onClick={(e) => e.stopPropagation()}>
          {!isOpen && agent.primaryConversation?.nodeId && agent.primaryConversation.nodeId !== 'local' && (
            <RemoteNodeTag nodeId={agent.primaryConversation.nodeId} />
          )}
          {agent.conversations.length > 1 && (
            <span className="badge badge-neutral tabular-nums">{agent.conversations.length}</span>
          )}
          <SidebarPaneTag paneTag={standbyPresence.paneTag} />
          {!batchMode && (
            <AgentNewConversationButton agent={agent} onCreate={onCreate} />
          )}
        </span>
      </div>
      {isOpen && (
        <AgentConversationsList
          agent={agent}
          store={store}
          background={background}
          activeConversationIds={activeConversationIds}
          searching={searching}
          showAll={showAll}
          onToggleShowAll={() => setShowAll((v) => !v)}
          batchMode={batchMode}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
        />
      )}
    </div>
  )
}

/** Agent 名下扁平会话清单：默认前 5 条，超出可展开；搜索或分屏在场会话绝不被折叠隐藏。 */
function AgentConversationsList({
  agent,
  store,
  background,
  activeConversationIds,
  searching,
  showAll,
  onToggleShowAll,
  batchMode,
  selectedIds,
  onToggleSelect,
}: {
  agent: AgentStanding
  store: HelmStoreValue
  background: ConversationBackgroundIndex
  activeConversationIds: ReadonlySet<number>
  searching: boolean
  showAll: boolean
  onToggleShowAll: () => void
  batchMode?: boolean
  selectedIds?: Set<number>
  onToggleSelect?: (id: number) => void
}) {
  const convs = agent.conversations
  const primaryActiveId = convs.find((c) => getConversationPresence(store, c.id).active)?.id ?? null
  // 折叠预览切片（纯函数）：默认前 5 条，但激活 / 分屏 / working / blocked / 后台在途 /
  // 搜索命中会话绝不因折叠丢失；归档会话已在 buildAgentStandings 上游过滤，无从进入。
  const { visible, hiddenCount } = resolveAgentSubListPreview({
    conversations: convs,
    showAll: showAll || searching,
    activeId: primaryActiveId,
    activeIds: activeConversationIds,
    background,
  })
  const hidden = hiddenCount

  return (
    <div className="agent-conversations-list">
      {visible.map((conv) => (
        <AgentConversationRow
          key={conv.id}
          conv={conv}
          store={store}
          background={background.get(conv.id)}
          batchMode={batchMode}
          selected={selectedIds?.has(conv.id)}
          onToggleSelect={onToggleSelect}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-sm agent-list-toggle"
          onClick={onToggleShowAll}
        >
          展开更多 (剩余 {hidden} 条)
        </button>
      )}
      {hidden === 0 && !searching && showAll && convs.length > AGENT_SUB_LIST_PREVIEW && (
        <button
          type="button"
          className="btn btn-ghost btn-sm agent-list-toggle"
          onClick={onToggleShowAll}
        >
          收起
        </button>
      )}
    </div>
  )
}

/** Agent 名下单个历史会话行（批量模式缩进渲染 + 勾选）。
 * 状态灯前置行首固定灯位；分屏入口收敛到会话详情顶栏，会话行不携带分屏按钮。 */
function AgentConversationRow({
  conv,
  store,
  background,
  batchMode,
  selected,
  onToggleSelect,
}: {
  conv: ConversationSummary
  store: HelmStoreValue
  background?: ConversationBackgroundActivity
  batchMode?: boolean
  selected?: boolean
  onToggleSelect?: (id: number) => void
}) {
  const presence = getConversationPresence(store, conv.id)
  const deletable = isConversationDeletable(conv)

  return (
    <div
      className={`nav-item nav-item-sub${presenceNavClassSuffix(presence)}`}
      onClick={() => {
        if (batchMode && deletable) {
          onToggleSelect?.(conv.id)
        }
      }}
    >
      {batchMode && (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            className="sidebar-batch-checkbox"
            checked={Boolean(selected)}
            disabled={!deletable}
            title={deletable ? undefined : '受保护会话不可删除'}
            onChange={() => {
              if (deletable) onToggleSelect?.(conv.id)
            }}
          />
        </span>
      )}
      <button
        type="button"
        className="nav-item-main nav-open"
        onClick={(e) => {
          if (batchMode) {
            e.stopPropagation()
            if (deletable) onToggleSelect?.(conv.id)
            return
          }
          store.openTarget({ kind: 'conversation', conversationId: conv.id })
        }}
        aria-current={presence.active ? 'page' : undefined}
      >
        <span className="nav-status-slot">
          <ConversationStatusDot conv={conv} background={background} />
        </span>
        <span className="nav-item-label">{conv.title || `会话 #${conv.id}`}</span>
      </button>
      <span className="nav-item-meta">
        <span className="tabular-nums">#{conv.id}</span>
        {conv.nodeId && conv.nodeId !== 'local' && <RemoteNodeTag nodeId={conv.nodeId} />}
        <SidebarPaneTag paneTag={presence.paneTag} />
        {!batchMode && (
          <span className="nav-item-row-actions">
            <ConversationRowActionsMenu conversation={conv} />
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * 「智能体」分组（单展开，无折叠钮）：
 * - 全部可见智能体稳定平铺（仅当前目标所属的那 1 个展开显示话题子列表）；
 * - 批量管理时展开扁平会话清单供勾选删除。
 */
export function AgentStandingsGroup({
  store,
  background,
  onNavigate,
}: {
  store: HelmStoreValue
  background: ConversationBackgroundIndex
  onNavigate?: () => void
}) {
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const filterOpen = searchOpen || search !== ''
  const searching = search.trim() !== ''

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
    }
  }, [searchOpen])

  const activeProfileIds = useMemo(
    () => activeProfileIdsOf(store),
    [store.primaryTarget, store.splitTarget, store.conversations],
  )
  const activeConversationIds = useMemo(
    () => activeConversationIdsOf(store),
    [store.primaryTarget, store.splitTarget],
  )

  const agentStandings = useMemo(
    () =>
      buildAgentStandings({
        profiles: store.profiles,
        conversations: store.conversations,
        plugins: store.plugins,
        sidebarItems: store.groupedUi.sidebarItems,
        sidebarSections: store.groupedUi.sidebarSections,
      }),
    [store.profiles, store.conversations, store.plugins, store.groupedUi.sidebarItems, store.groupedUi.sidebarSections],
  )

  const visibleStandings = useMemo(
    () => filterAgentStandings(agentStandings, search),
    [agentStandings, search],
  )
  const openStandby = useCallback(
    (profileId: string) => openAgentStandby(store, profileId, onNavigate),
    [store, onNavigate],
  )

  const allDeletableIds = useMemo(() => {
    const allConvs = agentStandings.flatMap((a) => a.conversations)
    return filterDeletableConversations(allConvs).map((c) => c.id)
  }, [agentStandings])

  const isAllSelected = allDeletableIds.length > 0 && allDeletableIds.every((id) => selectedIds.has(id))

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  /**
   * 批量归档：逐会话 PATCH 宿主归档 tag + allSettled 汇总（部分失败不掩盖
   * 成功项）；归档不删除会话，当前目标仍有效，仅依赖 conversation.upsert
   * 更新列表，与删除的 SSE 回退管道不同，此处不做任何导航。
   */
  const executeBatchArchive = async () => {
    if (selectedIds.size === 0 || archiving || deleting) return
    setArchiving(true)
    try {
      const convs = agentStandings
        .flatMap((agent) => agent.conversations)
        .filter((conversation) => selectedIds.has(conversation.id))
      const outcome = await patchConversationsArchived(convs, true)
      store.pushNotice(archiveBatchNotice(true, outcome))
      setSelectedIds(new Set())
      setBatchMode(false)
    } finally {
      setArchiving(false)
    }
  }

  const executeBatchDelete = async () => {
    const count = selectedIds.size
    if (count === 0 || deleting) return
    setBatchDeleteConfirmOpen(false)
    setDeleting(true)
    try {
      const ids = Array.from(selectedIds)
      const results = await Promise.allSettled(ids.map((id) => conversationsApi.remove(id)))
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length
      const rejected = results.filter((r) => r.status === 'rejected').length

      if (rejected === 0) {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: '批量删除完成',
          body: `成功删除 ${fulfilled} 个会话`,
        })
      } else if (fulfilled === 0) {
        store.pushNotice({
          type: 'notification',
          level: 'error',
          title: '批量删除失败',
          body: `删除失败 ${rejected} 个会话`,
        })
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: '批量删除部分失败',
          body: `成功删除 ${fulfilled} 个，失败 ${rejected} 个`,
        })
      }

      // 导航不在此处做：仅依赖每个成功删除的 conversation.deleted SSE 事件，
      // 由 Provider 按当前目标条件回退（避免旧快照/selectedIds 二次跳转误伤失败项与新导航）。

      setSelectedIds(new Set())
      setBatchMode(false)
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '批量删除异常',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="sidebar-group agent-standing-group">
      <div className="sidebar-group-header">
        <span>智能体</span>
        <div className="sidebar-group-header-actions">
          <Tooltip content={filterOpen ? '收起筛选' : '筛选智能体与话题'} side="top">
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs"
              style={{
                color: filterOpen ? 'var(--accent)' : undefined,
              }}
              title={filterOpen ? '收起筛选' : '筛选智能体与话题'}
              aria-label="筛选智能体与话题"
              aria-pressed={filterOpen}
              onClick={() => {
                if (filterOpen) {
                  setSearch('')
                  setSearchOpen(false)
                } else {
                  setSearchOpen(true)
                }
              }}
            >
              <HelmIcon name="list-filter" size={12} />
            </button>
          </Tooltip>
          <Tooltip content={batchMode ? '退出批量管理' : '批量管理会话'} side="top">
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs"
              style={{
                color: batchMode ? 'var(--accent)' : undefined,
              }}
              title={batchMode ? '退出批量管理' : '批量管理会话'}
              aria-label={batchMode ? '退出批量管理' : '批量管理会话'}
              onClick={() => {
                setBatchMode((v) => {
                  if (v) {
                    setSelectedIds(new Set())
                  }
                  return !v
                })
              }}
            >
              <HelmIcon name="check-square" size={12} />
            </button>
          </Tooltip>
        </div>
      </div>
      {filterOpen && (
        <div className="sidebar-search">
          <HelmIcon name="search" size={12} />
          <input
            ref={searchInputRef}
            type="text"
            className="sidebar-search-input"
            value={search}
            placeholder="筛选智能体或话题..."
            aria-label="筛选智能体或话题"
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                if (search !== '') setSearch('')
                else setSearchOpen(false)
              }
            }}
          />
          {search !== '' && (
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs sidebar-search-clear"
              title="清空筛选"
              aria-label="清空筛选"
              onClick={() => {
                setSearch('')
                searchInputRef.current?.focus()
              }}
            >
              <HelmIcon name="x" size={11} />
            </button>
          )}
        </div>
      )}
      {batchMode && (
        <div className="sidebar-batch-bar">
          <div className="sidebar-batch-bar-header">
            <span style={{ fontWeight: 500, color: 'var(--fg-secondary)' }}>
              已选择 {selectedIds.size} 项
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setBatchMode(false)
                setSelectedIds(new Set())
              }}
              title="退出批量管理"
            >
              退出
            </button>
          </div>
          <div className="sidebar-batch-bar-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={allDeletableIds.length === 0 || deleting}
              onClick={() => {
                if (isAllSelected) {
                  setSelectedIds(new Set())
                } else {
                  setSelectedIds(new Set(allDeletableIds))
                }
              }}
            >
              {isAllSelected ? '清空' : '全选'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={selectedIds.size === 0 || deleting || archiving}
              onClick={() => void executeBatchArchive()}
            >
              {archiving ? '归档中...' : `归档 (${selectedIds.size})`}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger-sm"
              disabled={selectedIds.size === 0 || deleting || archiving}
              onClick={() => setBatchDeleteConfirmOpen(true)}
            >
              {deleting ? '删除中...' : `删除 (${selectedIds.size})`}
            </button>
          </div>
        </div>
      )}
      {visibleStandings.length === 0 ? (
        <div className="sidebar-search-empty">没有匹配的智能体或话题</div>
      ) : (
        visibleStandings.map((agent) => (
          <AgentStandingItem
            key={agent.profileId}
            agent={agent}
            store={store}
            background={background}
            activeProfileIds={activeProfileIds}
            activeConversationIds={activeConversationIds}
            searching={searching}
            onCreate={openStandby}
            onNavigate={onNavigate}
            batchMode={batchMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
          />
        ))
      )}
      <ConfirmDialog
        open={batchDeleteConfirmOpen}
        onOpenChange={setBatchDeleteConfirmOpen}
        title={`确定删除选中的 ${selectedIds.size} 个会话吗？`}
        description="此操作无法撤销。"
        confirmText="删除会话"
        danger
        onConfirm={() => {
          void executeBatchDelete()
        }}
        onCancel={() => setBatchDeleteConfirmOpen(false)}
      />
    </div>
  )
}
