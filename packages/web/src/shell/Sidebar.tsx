import { useEffect, useMemo, useState } from 'react'
import type { AskSpec, ConversationSummary } from '@helm/protocol'
import { asksApi, conversationsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { Checkbox } from '../ui/Checkbox.js'
import { Tooltip } from '../ui/Tooltip.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import { isSameResolvedTarget, resolveTargetString, type HelmStoreValue } from '../lib/types.js'
import {
  AGENT_SUB_LIST_PREVIEW,
  buildAgentStandings,
  conversationStatusDotClass,
  conversationStatusTooltip,
  extractSidebarViews,
  filterAgentStandings,
  filterConversationsByTag,
  filterDeletableConversations,
  isConversationDeletable,
  type AgentStanding,
} from './sidebar-model.js'

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={`status-dot ${connected ? 'status-dot-done status-dot-connected' : 'status-dot-disconnected'}`}
      title={connected ? '实时连接正常' : '实时连接断开，正在重连'}
    />
  )
}

function HoverIconButton({
  title,
  icon,
  onClick,
  className,
}: {
  title: string
  icon: string
  onClick: (e: React.MouseEvent) => void
  className?: string
}) {
  return (
    <Tooltip content={title} side="top">
      <button
        type="button"
        className={`btn btn-ghost btn-icon-xs${className ? ` ${className}` : ''}`}
        title={title}
        aria-label={title}
        onClick={onClick}
      >
        <HelmIcon name={icon} size={13} />
      </button>
    </Tooltip>
  )
}

function ConversationStatusDot({ conv }: { conv: ConversationSummary }) {
  const dotClass = conversationStatusDotClass(conv.status)
  if (!dotClass) return null
  const tooltip = conversationStatusTooltip(conv.status, conv.doing, conv.lastError)
  return (
    <Tooltip content={tooltip} side="top">
      <span
        className={dotClass}
        title={tooltip}
        aria-label={tooltip}
        role="status"
      />
    </Tooltip>
  )
}

/** 全局待审批琥珀色胶囊与快速审批浮层。 */
function PendingAsksPanel({ store }: { store: HelmStoreValue }) {
  const [expanded, setExpanded] = useState(false)
  const [busyAskId, setBusyAskId] = useState<string | null>(null)
  const asks = store.pendingAsks

  if (asks.length === 0) return null

  const isSimpleConfirm = (ask: AskSpec) =>
    ask.fields.length === 1 && ask.fields[0]?.type === 'confirm'

  const answerConfirm = async (ask: AskSpec, value: boolean) => {
    const field = ask.fields[0]
    if (!field) return
    setBusyAskId(ask.id)
    try {
      await asksApi.answer(ask.id, { [field.name]: value ? 'true' : 'false' }, ask.expectedStateSeq)
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: '审批已提交',
        body: `${ask.title} #${ask.conversationId}`,
      })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '审批提交失败',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusyAskId(null)
    }
  }

  return (
    <div className="sidebar-group" style={{ gap: 4 }}>
      <button
        className={`badge badge-warn${expanded ? ' badge-err' : ''}`}
        style={{ width: '100%', justifyContent: 'space-between', height: 26, cursor: 'pointer' }}
        title="展开待审批列表"
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <HelmIcon name="alert-triangle" size={12} />
          待确认 ({asks.length})
        </span>
        <HelmIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {expanded && (
        <div className="list" style={{ boxShadow: 'var(--shadow-md)' }}>
          {asks.map((ask) => (
            <div key={ask.id} className="row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ask.title}
                </span>
                <span className="badge badge-neutral tabular-nums">#{ask.conversationId}</span>
              </div>
              {ask.description && (
                <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                  {ask.description}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setExpanded(false)
                    store.openTarget({ kind: 'conversation', conversationId: ask.conversationId })
                  }}
                >
                  主屏处理
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setExpanded(false)
                    store.openTarget(
                      { kind: 'conversation', conversationId: ask.conversationId },
                      { split: true },
                    )
                  }}
                >
                  右屏并排
                </button>
                {isSimpleConfirm(ask) && (
                  <>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busyAskId === ask.id}
                      onClick={() => void answerConfirm(ask, true)}
                    >
                      <HelmIcon name="check" size={12} />
                      批准
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={busyAskId === ask.id}
                      onClick={() => void answerConfirm(ask, false)}
                    >
                      <HelmIcon name="x" size={12} />
                      取消
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 在指定 Agent 下新建对话并打开（唯一的新建入口路径）。 */
function createConversationFor(
  store: HelmStoreValue,
  onNavigate?: () => void,
): (profileId: string) => Promise<void> {
  return async (profileId: string) => {
    try {
      const conv = await conversationsApi.create({ profileId })
      store.openTarget({ kind: 'conversation', conversationId: conv.id })
      onNavigate?.()
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '新建会话失败',
        body: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/** Agent 站位「+」按钮：仅 canCreateConversation 的 Agent 渲染。 */
function AgentNewConversationButton({
  agent,
  onCreate,
}: {
  agent: AgentStanding
  onCreate: (profileId: string) => void
}) {
  if (!agent.canCreateConversation) return null
  return (
    <Tooltip content={`在 ${agent.label} 下新建对话`} side="right">
      <button
        type="button"
        className="btn btn-ghost btn-icon-xs agent-new-conv-btn"
        title={`在 ${agent.label} 下新建对话`}
        aria-label={`在 ${agent.label} 下新建对话`}
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

/** 远端会话紧凑只读标识：一眼区分非本机会话。 */
function RemoteNodeTag({ nodeId }: { nodeId: string }) {
  return (
    <span
      className="mono"
      style={{ fontSize: 10.5, color: 'var(--fg-muted)', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      title={`运行节点：${nodeId}`}
    >
      @{nodeId}
    </span>
  )
}

/** 会话行是否属于当前激活目标。 */
function isConversationActive(store: HelmStoreValue, convId: number): boolean {
  return store.primaryTarget.kind === 'conversation' && store.primaryTarget.conversationId === convId
}

/** 手风琴跟随目标：当前主屏/分屏会话所属的 profileId（无则 null）。 */
function activeProfileIdOf(store: HelmStoreValue): string | null {
  const ids: number[] = []
  if (store.primaryTarget.kind === 'conversation') ids.push(store.primaryTarget.conversationId)
  if (store.splitTarget?.kind === 'conversation') ids.push(store.splitTarget.conversationId)
  for (const id of ids) {
    const conv = store.conversations.find((c) => c.id === id)
    if (conv) return conv.profileId
  }
  return null
}

/**
 * Agent 站位行（一级，手风琴单展开）：
 * - 普通模式：整个侧栏仅当前展开的那 1 个智能体显示话题子列表（默认跟随当前会话
 *   所属智能体自动展开，点击行首箭头可手动切换），其余智能体永远只占一行；
 * - 批量模式：行首切换子列表展开，展开后渲染扁平会话清单供勾选删除。
 */
function AgentStandingItem({
  agent,
  store,
  onCreate,
  onNavigate,
  batchMode,
  accordionOpen,
  onToggleAccordion,
  selectedIds,
  onToggleSelect,
}: {
  agent: AgentStanding
  store: HelmStoreValue
  onCreate: (profileId: string) => void
  onNavigate?: () => void
  batchMode?: boolean
  /** 普通模式手风琴：本智能体是否为当前展开的那一个。 */
  accordionOpen: boolean
  onToggleAccordion: () => void
  selectedIds?: Set<number>
  onToggleSelect?: (id: number) => void
}) {
  // 批量模式下：只要该 Agent 有会话（length > 0），就展开子列表展示会话行供勾选删除；
  // 机器人的主站位行永远代表角色 Profile，绝不提供勾选框，避免用户误勾选机器人。
  const hasSubList = agent.conversations.length > 0
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)

  const activeInAgent = agent.conversations.some((c) => isConversationActive(store, c.id))
  const isOpen = batchMode ? (hasSubList && expanded) : (hasSubList && accordionOpen)
  const headerActive = activeInAgent && !isOpen

  const toggleOpen = () => {
    if (batchMode) {
      if (hasSubList) setExpanded((v) => !v)
      return
    }
    onToggleAccordion()
  }

  const openPrimary = () => {
    if (batchMode) {
      toggleOpen()
      return
    }
    const primary = agent.primaryConversation
    if (primary) {
      store.openTarget({ kind: 'conversation', conversationId: primary.id })
      onNavigate?.()
      return
    }
    if (agent.canCreateConversation) onCreate(agent.profileId)
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
        {hasSubList && (
          <Tooltip content={isOpen ? '收起话题列表' : '展开话题列表'} side="top">
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs agent-collapse-btn"
              title={isOpen ? '收起话题列表' : '展开话题列表'}
              aria-label={isOpen ? '收起话题列表' : '展开话题列表'}
              aria-expanded={isOpen}
              onClick={(e) => {
                e.stopPropagation()
                toggleOpen()
              }}
            >
              <HelmIcon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} />
            </button>
          </Tooltip>
        )}
        {!hasSubList && <span className="agent-standing-indent" aria-hidden="true" />}
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
          <HelmIcon name={agent.icon} size={14} />
          <span className="nav-item-label">{agent.label}</span>
        </button>
        <span className="nav-item-meta" onClick={(e) => e.stopPropagation()}>
          {!isOpen && agent.primaryConversation && (
            <ConversationStatusDot conv={agent.primaryConversation} />
          )}
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
            <span className="sidebar-split-action" style={{ display: 'inline-flex' }}>
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
  showAll,
  onToggleShowAll,
  batchMode,
  selectedIds,
  onToggleSelect,
}: {
  agent: AgentStanding
  store: HelmStoreValue
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

/** Agent 名下单个历史会话行（批量模式缩进渲染 + 勾选）。 */
function AgentConversationRow({
  conv,
  store,
  batchMode,
  selected,
  onToggleSelect,
}: {
  conv: ConversationSummary
  store: HelmStoreValue
  batchMode?: boolean
  selected?: boolean
  onToggleSelect?: (id: number) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const active = isConversationActive(store, conv.id)
  const deletable = isConversationDeletable(conv)
  const humanManageable = (conv.ownedBy ?? 'human') === 'human'

  const commitRename = async () => {
    const title = draft.trim()
    setRenaming(false)
    if (!title || title === conv.title) return
    try {
      await conversationsApi.patch(conv.id, { title })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '重命名失败',
        body: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (renaming) {
    return (
      <div className="nav-item nav-item-sub" style={{ display: 'flex', gap: 4 }}>
        <input
          className="input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename()
            if (e.key === 'Escape') setRenaming(false)
          }}
          style={{ height: 24, fontSize: 12 }}
        />
        <Tooltip content="确认重命名" side="top">
          <button type="button" className="btn btn-icon-xs" aria-label="确认重命名" onClick={() => void commitRename()}>
            <HelmIcon name="check" size={12} />
          </button>
        </Tooltip>
        <Tooltip content="取消重命名" side="top">
          <button type="button" className="btn btn-icon-xs" aria-label="取消重命名" onClick={() => setRenaming(false)}>
            <HelmIcon name="x" size={12} />
          </button>
        </Tooltip>
      </div>
    )
  }

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
        onDoubleClick={() => {
          if (!batchMode && humanManageable) {
            setDraft(conv.title)
            setRenaming(true)
          }
        }}
        aria-current={active ? 'page' : undefined}
      >
        <span className="nav-item-label">{conv.title || `会话 #${conv.id}`}</span>
      </button>
      <span className="nav-item-meta">
        <span className="tabular-nums">#{conv.id}</span>
        {conv.nodeId && conv.nodeId !== 'local' && <RemoteNodeTag nodeId={conv.nodeId} />}
        <ConversationStatusDot conv={conv} />
        {!batchMode && (
          <span className="nav-item-row-actions">
            <span className="sidebar-split-action" style={{ display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
              <HoverIconButton
                className="split-toggle-btn sidebar-split-btn"
                title="在右屏分屏打开"
                icon="columns"
                onClick={(e) => {
                  e.stopPropagation()
                  store.openTarget({ kind: 'conversation', conversationId: conv.id }, { split: true })
                }}
              />
            </span>
            <ConversationRowActionsMenu conversation={conv} />
            {humanManageable && (
              <HoverIconButton
                title="重命名会话"
                icon="edit-3"
                onClick={(e) => {
                  e.stopPropagation()
                  setDraft(conv.title)
                  setRenaming(true)
                }}
              />
            )}
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * 「智能体」分组（手风琴单展开）：
 * - 有活跃会话的智能体平铺在上（仅当前展开的那 1 个显示话题子列表）；
 * - 0 会话的闲置智能体收进底部折叠区；批量管理时展开扁平会话清单。
 */
function AgentStandingsGroup({ store, onNavigate }: { store: HelmStoreValue; onNavigate?: () => void }) {
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [idleOpen, setIdleOpen] = useState(false)

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

  // 手风琴：默认跟随当前主屏会话所属智能体；同一时刻仅展开一个。
  const [accordionId, setAccordionId] = useState<string | null>(() => activeProfileIdOf(store))
  useEffect(() => {
    setAccordionId((current) => {
      const follow = activeProfileIdOf(store)
      if (follow === null) return current
      return current === follow ? current : follow
    })
  }, [store])

  const activeStandings = useMemo(() => agentStandings.filter((a) => a.conversations.length > 0), [agentStandings])
  const idleStandings = useMemo(() => agentStandings.filter((a) => a.conversations.length === 0), [agentStandings])
  const visibleStandings = useMemo(
    () => filterAgentStandings(agentStandings, search),
    [agentStandings, search],
  )
  const visibleActive = useMemo(
    () => activeStandings.filter((a) => visibleStandings.some((v) => v.profileId === a.profileId)),
    [activeStandings, visibleStandings],
  )
  const visibleIdle = useMemo(
    () => idleStandings.filter((a) => visibleStandings.some((v) => v.profileId === a.profileId)),
    [idleStandings, visibleStandings],
  )
  const createConversation = useMemo(
    () => createConversationFor(store, onNavigate),
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

      if (
        store.primaryTarget.kind === 'conversation' &&
        selectedIds.has(store.primaryTarget.conversationId)
      ) {
        // 删除当前主屏会话：回退到无会话依赖的角色中心。
        store.openTarget({ kind: 'profiles' })
      }

      if (
        store.splitTarget?.kind === 'conversation' &&
        selectedIds.has(store.splitTarget.conversationId)
      ) {
        store.closeSplit()
      }

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
      {visibleActive.length === 0 && visibleIdle.length === 0 ? (
        <div className="sidebar-search-empty">没有匹配的智能体</div>
      ) : (
        <>
          {visibleActive.map((agent) => (
            <AgentStandingItem
              key={agent.profileId}
              agent={agent}
              store={store}
              onCreate={(profileId) => void createConversation(profileId)}
              onNavigate={onNavigate}
              batchMode={batchMode}
              accordionOpen={accordionId === agent.profileId}
              onToggleAccordion={() =>
                setAccordionId((current) => (current === agent.profileId ? null : agent.profileId))
              }
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
            />
          ))}
          {visibleIdle.length > 0 && !batchMode && (
            <div className="sidebar-idle-group">
              <button
                type="button"
                className="sidebar-group-header sidebar-idle-toggle"
                title={idleOpen ? '收起闲置智能体' : '展开闲置智能体'}
                aria-expanded={idleOpen}
                onClick={() => setIdleOpen((v) => !v)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  <HelmIcon name={idleOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                  <span className="nav-item-label">闲置智能体</span>
                </span>
                <span className="badge badge-neutral tabular-nums">{visibleIdle.length}</span>
              </button>
              {idleOpen &&
                visibleIdle.map((agent) => (
                  <AgentStandingItem
                    key={agent.profileId}
                    agent={agent}
                    store={store}
                    onCreate={(profileId) => void createConversation(profileId)}
                    onNavigate={onNavigate}
                    batchMode={false}
                    accordionOpen={false}
                    onToggleAccordion={() => {}}
                  />
                ))}
            </div>
          )}
          {batchMode &&
            visibleIdle.map((agent) => (
              <AgentStandingItem
                key={agent.profileId}
                agent={agent}
                store={store}
                onCreate={(profileId) => void createConversation(profileId)}
                onNavigate={onNavigate}
                batchMode
                accordionOpen={false}
                onToggleAccordion={() => {}}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
              />
            ))}
        </>
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

/** 插件动态会话分组区（sidebar.section）：filterTag 分组通用渲染，支持 collapsible / defaultCollapsed。 */
function SidebarSectionGroups({ store }: { store: HelmStoreValue }) {
  const sections = store.groupedUi.sidebarSections.filter((s) => s.spec.filterTag)
  // 纯内容型 section（无 filterTag，但声明了 client 内容）：渲染内容本身，
  // 不因缺少 filterTag 静默丢弃（与 sidebar.item 的 client 内容渲染同一策略）。
  const contentSections = store.groupedUi.sidebarSections.filter(
    (s) => !s.spec.filterTag && s.spec.client !== undefined,
  )
  return (
    <>
      {contentSections.map((section) => (
        <div key={`content:${section.pluginId}/${section.spec.id}`} style={{ padding: '0 10px 6px' }}>
          <PluginUiView pluginId={section.pluginId} spec={section.spec} label={`侧栏分组 ${section.spec.id}`} />
        </div>
      ))}
      {sections.map((section) => (
        <SidebarSectionGroup key={`${section.pluginId}/${section.spec.id}`} store={store} section={section} />
      ))}
    </>
  )
}

/** 单条会话行（插件 sidebar.section 分组内渲染）。 */
function ConversationRow({
  conv,
  active,
  onOpen,
  onOpenSplit,
}: {
  conv: ConversationSummary
  active: boolean
  onOpen: () => void
  onOpenSplit: () => void
}) {
  return (
    <div
      className={`nav-item${active ? ' nav-item-active' : ''}`}
      style={{ minHeight: 30, opacity: 1 }}
    >
      <button type="button" className="nav-item-main nav-open" onClick={onOpen} aria-current={active ? 'page' : undefined}>
        <span className="nav-item-label">{conv.title || `会话 #${conv.id}`}</span>
      </button>
      <span className="nav-item-meta">
        <span className="tabular-nums">#{conv.id}</span>
        <ConversationStatusDot conv={conv} />
        <span className="sidebar-split-action" style={{ display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
          <HoverIconButton
            className="split-toggle-btn sidebar-split-btn"
            title="在右屏分屏打开"
            icon="columns"
            onClick={(e) => {
              e.stopPropagation()
              onOpenSplit()
            }}
          />
        </span>
        <ConversationRowActionsMenu conversation={conv} />
      </span>
    </div>
  )
}

/** 单个 sidebar.section 分组：声明 collapsible 时渲染可折叠头部与计数徽标。 */
function SidebarSectionGroup({
  store,
  section,
}: {
  store: HelmStoreValue
  section: HelmStoreValue['groupedUi']['sidebarSections'][number]
}) {
  const spec = section.spec
  const tag = spec.filterTag as string
  const convs = useMemo(
    () => filterConversationsByTag(store.conversations, tag).sort((a, b) => b.updatedAt - a.updatedAt),
    [store.conversations, tag],
  )
  const collapsible = spec.collapsible === true
  const [open, setOpen] = useState(!collapsible || spec.defaultCollapsed !== true)

  return (
    <div className="sidebar-group">
      {collapsible ? (
        <button
          type="button"
          className="sidebar-group-header"
          style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer' }}
          title={open ? '收起分组' : '展开分组'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            {spec.icon !== undefined && <HelmIcon name={spec.icon} size={12} />}
            <span className="nav-item-label">{spec.label}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span className="badge badge-neutral tabular-nums">{convs.length}</span>
            <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </span>
        </button>
      ) : (
        <div className="sidebar-group-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <HelmIcon name={spec.icon} size={12} />
            {spec.label}
          </span>
          <span className="tabular-nums">{convs.length}</span>
        </div>
      )}
      {open &&
        convs.map((conv) => (
          <ConversationRow
            key={conv.id}
            conv={conv}
            active={isConversationActive(store, conv.id)}
            onOpen={() => store.openTarget({ kind: 'conversation', conversationId: conv.id })}
            onOpenSplit={() =>
              store.openTarget({ kind: 'conversation', conversationId: conv.id }, { split: true })
            }
          />
        ))}
    </div>
  )
}

/** 独立「视图」分组：screen: 导航项 + 无导航 target 的自定义客户端侧栏组件。 */
function ViewNavGroup({ store }: { store: HelmStoreValue }) {
  const viewItems = useMemo(
    () => extractSidebarViews(store.groupedUi.sidebarItems, store.conversations),
    [store.groupedUi.sidebarItems, store.conversations],
  )
  const clientItems = store.groupedUi.sidebarItems.filter(
    (item) => item.spec.client !== undefined && resolveTargetString(item.spec.target ?? '', store.conversations) === null,
  )
  if (viewItems.length === 0 && clientItems.length === 0) return null

  return (
    <div className="sidebar-group">
      <div className="sidebar-group-header">视图</div>
      {clientItems.map((item) => (
        <div key={`client:${item.pluginId}/${item.spec.id}`} style={{ padding: '0 10px 6px' }}>
          <PluginUiView pluginId={item.pluginId} spec={item.spec} label={`侧栏项 ${item.spec.id}`} />
        </div>
      ))}
      {viewItems.map((view) => {
        const active = isSameResolvedTarget(view.target, store.primaryTarget)
        return (
          <div
            key={view.key}
            className={`nav-item${active ? ' nav-item-active' : ''}`}
            style={{ cursor: 'pointer' }}
          >
            <button
              type="button"
              className="nav-item-main nav-open"
              onClick={() => store.openTarget(view.target)}
              aria-current={active ? 'page' : undefined}
            >
              <HelmIcon name={view.icon} size={14} />
              <span className="nav-item-label">{view.label}</span>
            </button>
            <span className="nav-item-meta" onClick={(e) => e.stopPropagation()}>
              <HoverIconButton
                title="在右屏分屏打开"
                icon="columns"
                onClick={(e) => {
                  e.stopPropagation()
                  store.openTarget(view.target, { split: true })
                }}
              />
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 系统中心目标键（Rail 高亮判定用）。 */
const CENTER_TARGETS = ['profiles', 'models', 'skills', 'nodes', 'plugins'] as const
type CenterKey = (typeof CENTER_TARGETS)[number]

const CENTER_ICONS: Record<CenterKey, string> = {
  profiles: 'bot',
  models: 'key',
  skills: 'sparkles',
  nodes: 'network',
  plugins: 'puzzle',
}

const CENTER_LABELS: Record<CenterKey, string> = {
  profiles: '角色',
  models: '模型与凭据',
  skills: '技能库',
  nodes: '计算节点',
  plugins: '插件中心',
}

/** 侧栏空间（Space）：对话 | 视图 | 设置。 */
type SidebarSpace = 'conversations' | 'views' | 'settings'

/** 根据 primaryTarget 推导应对齐展示的空间。 */
function spaceForTarget(target: HelmStoreValue['primaryTarget']): SidebarSpace {
  if (target.kind === 'screen') return 'views'
  if (CENTER_TARGETS.includes(target.kind as CenterKey)) return 'settings'
  return 'conversations'
}

const SPACE_ICONS: Record<SidebarSpace, string> = {
  conversations: 'message-square',
  views: 'layout-grid',
  settings: 'settings',
}

const SPACE_LABELS: Record<SidebarSpace, string> = {
  conversations: '对话空间',
  views: '视图空间',
  settings: '设置空间',
}

/**
 * Activity Rail（48px）：仅空间切换（对话/视图/设置）+ 主题按钮。
 * 桌面与移动抽屉共用；系统中心入口收敛到「设置」空间内的纵向列表。
 */
function ActivityRail({
  store,
  space,
  onSpaceChange,
  onClose,
}: {
  store: HelmStoreValue
  space: SidebarSpace
  onSpaceChange: (space: SidebarSpace) => void
  onClose?: () => void
}) {
  return (
    <nav className="activity-rail" aria-label="主导航">
      <div className="activity-rail-brand" title="Helm">
        <HelmIcon name="layers" size={17} />
        <StatusDot connected={store.sseConnected} />
      </div>
      <div className="activity-rail-spaces">
        {(Object.keys(SPACE_LABELS) as SidebarSpace[]).map((key) => (
          <Tooltip content={SPACE_LABELS[key]} side="right" key={key}>
            <button
              type="button"
              className={`rail-btn rail-space-btn${space === key ? ' rail-btn-active' : ''}`}
              title={SPACE_LABELS[key]}
              aria-label={SPACE_LABELS[key]}
              aria-current={space === key ? 'page' : undefined}
              onClick={() => onSpaceChange(key)}
            >
              <HelmIcon name={SPACE_ICONS[key]} size={16} />
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="activity-rail-footer">
        <Tooltip
          content={
            store.themePreference === 'system'
              ? `跟随系统（当前${store.theme === 'dark' ? '暗色' : '浅色'}，点击切换为浅色模式）`
              : store.themePreference === 'light'
                ? '浅色模式（点击切换为暗色模式）'
                : '暗色模式（点击切换为跟随系统）'
          }
          side="right"
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm sidebar-theme-toggle"
            title={
              store.themePreference === 'system'
                ? `跟随系统（当前${store.theme === 'dark' ? '暗色' : '浅色'}，点击切换为浅色模式）`
                : store.themePreference === 'light'
                  ? '浅色模式（点击切换为暗色模式）'
                  : '暗色模式（点击切换为跟随系统）'
            }
            aria-label={
              store.themePreference === 'system'
                ? '跟随系统'
                : store.themePreference === 'light'
                  ? '浅色模式'
                  : '暗色模式'
            }
            onClick={store.toggleTheme}
          >
            <HelmIcon
              name={
                store.themePreference === 'system'
                  ? 'monitor'
                  : store.themePreference === 'light'
                    ? 'sun'
                    : 'moon'
              }
              size={16}
            />
          </button>
        </Tooltip>
      </div>
    </nav>
  )
}

/** 设置空间导航：系统中心纵向列表，行结构与智能体站位行完全同构
 * （折叠钮占位 + nav-item-main 图标文本），保证两个空间的左缘视觉统一。 */
function SettingsNavGroup({ store, onNavigate }: { store: HelmStoreValue; onNavigate?: () => void }) {
  return (
    <div className="sidebar-group settings-nav">
      {CENTER_TARGETS.map((key) => {
        const active = store.primaryTarget.kind === key
        return (
          <div key={key} className={`nav-item settings-nav-item${active ? ' nav-item-active' : ''}`}>
            <span className="agent-standing-indent" aria-hidden="true" />
            <button
              type="button"
              className="nav-item-main nav-open"
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                store.openTarget({ kind: key })
                onNavigate?.()
              }}
            >
              <HelmIcon name={CENTER_ICONS[key]} size={14} />
              <span className="nav-item-label">{CENTER_LABELS[key]}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function Sidebar({ onClose }: { onClose?: () => void } = {}) {
  const store = useHelmStore()
  const alignedSpace = spaceForTarget(store.primaryTarget)
  const [space, setSpace] = useState<SidebarSpace>(alignedSpace)

  // primaryTarget 空间类别变化时自动对齐（如从中心返回对话）。
  useEffect(() => {
    setSpace((current) => (current === alignedSpace ? current : alignedSpace))
  }, [alignedSpace])

  return (
    <aside className="helm-sidebar">
      <ActivityRail store={store} space={space} onSpaceChange={setSpace} onClose={onClose} />
      <div className="sidebar-context">
        <div className="sidebar-header">
          <div className="sidebar-context-title">
            <HelmIcon
              name={space === 'conversations' ? 'message-square' : space === 'views' ? 'layout-grid' : 'settings'}
              size={14}
            />
            <span>{space === 'conversations' ? '对话' : space === 'views' ? '视图' : '设置'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Tooltip content="打开 Cmd K 全局搜索与命令面板" side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon"
                title="打开 Cmd K 全局搜索与命令面板"
                aria-label="打开 Cmd K 全局搜索与命令面板"
                onClick={() => store.setActiveModal({ kind: 'command-palette' })}
              >
                <HelmIcon name="search" size={13} />
              </button>
            </Tooltip>
            {onClose && (
              <Tooltip content="关闭导航栏" side="bottom">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm mobile-sidebar-close"
                  aria-label="关闭导航栏"
                  title="关闭导航栏"
                  onClick={onClose}
                >
                  <HelmIcon name="x" size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="sidebar-scroll">
          {space === 'conversations' ? (
            <>
              <PendingAsksPanel store={store} />
              <AgentStandingsGroup store={store} onNavigate={onClose} />
              <SidebarSectionGroups store={store} />
            </>
          ) : space === 'views' ? (
            <ViewNavGroup store={store} />
          ) : (
            <SettingsNavGroup store={store} onNavigate={onClose} />
          )}
        </div>
      </div>
    </aside>
  )
}
