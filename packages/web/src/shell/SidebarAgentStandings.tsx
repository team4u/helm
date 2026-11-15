import { useCallback, useMemo, useState } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { conversationsApi } from '../lib/api.js'
import { HelmIcon, Checkbox } from '@helm/plugin-client'
import { Tooltip } from '../ui/Tooltip.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import type { HelmStoreValue } from '../lib/types.js'
import {
  AGENT_SUB_LIST_PREVIEW,
  activeProfileIdOf,
  buildAgentStandings,
  filterAgentStandings,
  filterDeletableConversations,
  isAgentStandbyActive,
  isConversationActive,
  isConversationDeletable,
  openAgentStandby,
  type AgentStanding,
} from './sidebar-model.js'
import {
  resolveStandingStatusIndicator,
  type ConversationBackgroundActivity,
  type ConversationBackgroundIndex,
} from './background-activity-model.js'
import {
  ConversationStatusDot,
  HoverIconButton,
  RemoteNodeTag,
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
 * Agent 站位行（一级，单展开，无折叠钮）：
 * - 普通模式：点击名称进入待命态（首次发送才落库），名下话题列表展开由当前
 *   目标唯一推导——仅当前目标所属智能体展开，其余智能体永远只占一行；
 * - 批量模式：点击行或名称切换子列表展开，展开后渲染扁平会话清单供勾选删除。
 */
function AgentStandingItem({
  agent,
  store,
  background,
  onCreate,
  onNavigate,
  batchMode,
  selectedIds,
  onToggleSelect,
}: {
  agent: AgentStanding
  store: HelmStoreValue
  background: ConversationBackgroundIndex
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

  const activeInAgent = agent.conversations.some((c) => isConversationActive(store, c.id))
  const standbyActive = isAgentStandbyActive(store, agent.profileId)
  // 折叠态站位指示器：聚合名下全部会话（基础状态优先级 + 后台在途），
  // 不只看 primaryConversation——后台活跃的非 primary 会话同样透出。
  const standingIndicator = useMemo(
    () => resolveStandingStatusIndicator(agent.conversations, background),
    [agent.conversations, background],
  )
  // 无折叠钮：展开由当前目标唯一推导（点击智能体即选中并展开）。
  const isOpen = batchMode
    ? hasSubList && expanded
    : hasSubList && activeProfileIdOf(store) === agent.profileId
  // 高亮策略（父强子弱，参考 magpie）：当前目标所属智能体的站位行恒点亮——
  // 待命或任一会话激活时父行保持高亮，与当前会话子行同时点亮、互不排斥。
  const headerActive = standbyActive || activeInAgent

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

  const openSplit = (e: React.MouseEvent, convId: number) => {
    e.stopPropagation()
    store.openTarget({ kind: 'conversation', conversationId: convId }, { split: true })
  }

  return (
    <div className="agent-standing">
      <div
        className={`nav-item agent-standing-row${headerActive ? ' nav-item-active' : ''}`}
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
          aria-current={headerActive ? 'page' : undefined}
        >
          <span className="nav-item-label">{agent.label}</span>
        </button>
        <span className="nav-item-meta" onClick={(e) => e.stopPropagation()}>
          {!isOpen && standingIndicator !== null && <StandingStatusDot indicator={standingIndicator} />}
          {!isOpen && agent.primaryConversation?.nodeId && agent.primaryConversation.nodeId !== 'local' && (
            <RemoteNodeTag nodeId={agent.primaryConversation.nodeId} />
          )}
          {agent.conversations.length > 1 && (
            <span className="badge badge-neutral tabular-nums">{agent.conversations.length}</span>
          )}
          {!batchMode && (
            <AgentNewConversationButton agent={agent} onCreate={onCreate} />
          )}
          {!batchMode && agent.primaryConversation && !isOpen && (
            <span className="sidebar-split-action">
              <HoverIconButton
                className="split-toggle-btn sidebar-split-btn"
                title="在右屏分屏打开"
                icon="columns"
                onClick={(e) => openSplit(e, agent.primaryConversation!.id)}
              />
            </span>
          )}
        </span>
      </div>
      {isOpen && (
        <AgentConversationsList
          agent={agent}
          store={store}
          background={background}
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

/** Agent 名下扁平会话清单（仅批量管理时渲染）：默认前 5 条，超出可展开；行内勾选删除。 */
function AgentConversationsList({
  agent,
  store,
  background,
  showAll,
  onToggleShowAll,
  batchMode,
  selectedIds,
  onToggleSelect,
}: {
  agent: AgentStanding
  store: HelmStoreValue
  background: ConversationBackgroundIndex
  showAll: boolean
  onToggleShowAll: () => void
  batchMode?: boolean
  selectedIds?: Set<number>
  onToggleSelect?: (id: number) => void
}) {
  const convs = agent.conversations
  const activeIdx = convs.findIndex((c) => isConversationActive(store, c.id))
  const visibleCount =
    showAll || (activeIdx >= 0 && activeIdx >= AGENT_SUB_LIST_PREVIEW)
      ? convs.length
      : Math.min(AGENT_SUB_LIST_PREVIEW, convs.length)
  const visible = convs.slice(0, visibleCount)
  const hidden = convs.length - visibleCount

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
      {hidden === 0 && showAll && convs.length > AGENT_SUB_LIST_PREVIEW && (
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
 * 分屏入口收敛到会话详情顶栏，会话行不再携带分屏按钮。 */
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
  const active = isConversationActive(store, conv.id)
  const deletable = isConversationDeletable(conv)

  return (
    <div
      className={`nav-item nav-item-sub${active ? ' nav-item-active' : ''}`}
      onClick={() => {
        if (batchMode && deletable) {
          onToggleSelect?.(conv.id)
        }
      }}
    >
      {batchMode && (
        <Checkbox
          className="sidebar-batch-checkbox"
          checked={Boolean(selected)}
          disabled={!deletable}
          title={deletable ? undefined : '受保护会话不可删除'}
          onChange={() => {
            if (deletable) onToggleSelect?.(conv.id)
          }}
        />
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
        aria-current={active ? 'page' : undefined}
      >
        <span className="nav-item-label">{conv.title || `会话 #${conv.id}`}</span>
      </button>
      <span className="nav-item-meta">
        <span className="tabular-nums">#{conv.id}</span>
        {conv.nodeId && conv.nodeId !== 'local' && <RemoteNodeTag nodeId={conv.nodeId} />}
        <ConversationStatusDot conv={conv} background={background} />
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
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false)
  const [search, setSearch] = useState('')

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
      <div className="sidebar-search">
        <HelmIcon name="search" size={12} />
        <input
          className="sidebar-search-input"
          value={search}
          placeholder="搜索智能体"
          aria-label="搜索智能体"
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
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
              {isAllSelected ? '清空' : '全选可删'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger-sm"
              disabled={selectedIds.size === 0 || deleting}
              onClick={() => setBatchDeleteConfirmOpen(true)}
            >
              {deleting ? '删除中...' : `删除所选 (${selectedIds.size})`}
            </button>
          </div>
        </div>
      )}
      {visibleStandings.length === 0 ? (
        <div className="sidebar-search-empty">没有匹配的智能体</div>
      ) : (
        visibleStandings.map((agent) => (
          <AgentStandingItem
            key={agent.profileId}
            agent={agent}
            store={store}
            background={background}
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
