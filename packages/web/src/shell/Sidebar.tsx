import { useMemo, useState } from 'react'
import type { AskSpec, ConversationSummary } from '@helm/protocol'
import { ROOT_CONVERSATION_ID } from '@helm/protocol'
import { asksApi, conversationsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { isSameResolvedTarget, resolveTargetString, type HelmStoreValue } from '../lib/types.js'
import {
  AGENT_SUB_LIST_PREVIEW,
  buildAgentStandings,
  conversationStatusBadgeClass,
  conversationStatusLabel,
  extractSidebarViews,
  filterConversationsByTag,
  filterDeletableConversations,
  isConversationDeletable,
  type AgentStanding,
} from './sidebar-model.js'

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      title={connected ? '实时连接正常' : '实时连接断开，正在重连'}
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        flexShrink: 0,
        background: connected ? 'var(--ok)' : 'var(--fg-subtle)',
        boxShadow: connected ? '0 0 0 2px var(--ok-bg)' : 'none',
      }}
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
    <button
      className={`btn btn-ghost btn-sm${className ? ` ${className}` : ''}`}
      title={title}
      style={{ height: 22, width: 22, padding: 0, flexShrink: 0 }}
      onClick={onClick}
    >
      <HelmIcon name={icon} size={13} />
    </button>
  )
}

function StatusBadge({ conv }: { conv: ConversationSummary }) {
  if (conv.status === 'idle') return null
  return (
    <span className={conversationStatusBadgeClass(conv.status)} title={conv.doing ?? ''}>
      {conv.status === 'working' && conv.doing ? conv.doing : conversationStatusLabel(conv.status)}
    </span>
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
    <button
      type="button"
      className="btn btn-ghost btn-sm agent-new-conv-btn"
      style={{ height: 20, width: 20, padding: 0 }}
      title={`在 ${agent.label} 下新建对话`}
      onClick={(e) => {
        e.stopPropagation()
        onCreate(agent.profileId)
      }}
    >
      <HelmIcon name="plus" size={13} />
    </button>
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

/** Agent 站位行（一级）。会话数 <= 1 时整行直接打开主会话；>= 2 时带折叠子列表。 */
function AgentStandingItem({
  agent,
  store,
  onCreate,
  onNavigate,
  batchMode,
  selectedIds,
  onToggleSelect,
}: {
  agent: AgentStanding
  store: HelmStoreValue
  onCreate: (profileId: string) => void
  onNavigate?: () => void
  batchMode?: boolean
  selectedIds?: Set<number>
  onToggleSelect?: (id: number) => void
}) {
  const hasSubList = agent.conversations.length > 1
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)

  const activeInAgent = agent.conversations.some((c) => isConversationActive(store, c.id))
  const headerActive = activeInAgent && (!hasSubList || !expanded)

  const primaryDeletable = agent.primaryConversation
    ? isConversationDeletable(agent.primaryConversation)
    : false

  const openPrimary = () => {
    if (batchMode) {
      if (!hasSubList && agent.primaryConversation && primaryDeletable) {
        onToggleSelect?.(agent.primaryConversation.id)
      }
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
        style={{ minHeight: 30 }}
        onClick={() => {
          if (batchMode && !hasSubList && agent.primaryConversation && primaryDeletable) {
            onToggleSelect?.(agent.primaryConversation.id)
          }
        }}
      >
        {batchMode && !hasSubList && agent.primaryConversation && (
          <input
            type="checkbox"
            className="sidebar-batch-checkbox"
            checked={Boolean(selectedIds?.has(agent.primaryConversation.id))}
            disabled={!primaryDeletable}
            title={
              agent.primaryConversation.id === ROOT_CONVERSATION_ID
                ? '根会话不可删除'
                : !primaryDeletable
                ? '受保护会话不可删除'
                : undefined
            }
            onChange={(e) => {
              e.stopPropagation()
              if (primaryDeletable) onToggleSelect?.(agent.primaryConversation!.id)
            }}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {hasSubList && (
          <button
            type="button"
            className="btn btn-ghost btn-sm agent-collapse-btn"
            style={{ height: 20, width: 20, padding: 0, flexShrink: 0 }}
            title={expanded ? '收起历史对话' : '展开历史对话'}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
          >
            <HelmIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} />
          </button>
        )}
        <button
          type="button"
          className="nav-item-main nav-open"
          onClick={(e) => {
            if (batchMode) {
              e.stopPropagation()
              if (!hasSubList && agent.primaryConversation && primaryDeletable) {
                onToggleSelect?.(agent.primaryConversation.id)
              }
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
          {!hasSubList && agent.primaryConversation && (
            <StatusBadge conv={agent.primaryConversation} />
          )}
          {!hasSubList && agent.primaryConversation?.nodeId && agent.primaryConversation.nodeId !== 'local' && (
            <RemoteNodeTag nodeId={agent.primaryConversation.nodeId} />
          )}
          {hasSubList && (
            <span className="badge badge-neutral tabular-nums">{agent.conversations.length}</span>
          )}
          {!batchMode && (
            <>
              <AgentNewConversationButton agent={agent} onCreate={onCreate} />
              {agent.primaryConversation && !hasSubList && (
                <span className="sidebar-split-action" style={{ display: 'inline-flex' }}>
                  <HoverIconButton
                    className="split-toggle-btn sidebar-split-btn"
                    title="在右屏分屏打开"
                    icon="columns"
                    onClick={(e) => openSplit(e, agent.primaryConversation!.id)}
                  />
                </span>
              )}
            </>
          )}
        </span>
      </div>
      {hasSubList && expanded && (
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

/** Agent 名下二级历史会话子列表：默认显示前 5 条，超出可展开；行内重命名/分屏。 */
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

/** Agent 名下单个历史会话行（缩进渲染 + 悬停重命名/分屏）。 */
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
  const humanManageable =
    conv.id !== ROOT_CONVERSATION_ID && (conv.ownedBy ?? 'human') === 'human'

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
        <button className="btn btn-sm" style={{ height: 22, width: 22, padding: 0 }} onClick={() => void commitRename()}>
          <HelmIcon name="check" size={12} />
        </button>
        <button className="btn btn-sm" style={{ height: 22, width: 22, padding: 0 }} onClick={() => setRenaming(false)}>
          <HelmIcon name="x" size={12} />
        </button>
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
        <input
          type="checkbox"
          className="sidebar-batch-checkbox"
          checked={Boolean(selected)}
          disabled={!deletable}
          title={deletable ? undefined : '受保护会话不可删除'}
          onChange={(e) => {
            e.stopPropagation()
            if (deletable) onToggleSelect?.(conv.id)
          }}
          onClick={(e) => e.stopPropagation()}
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
        <StatusBadge conv={conv} />
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

/** 「智能体」分组：每个 Agent 一个固定站位，下挂各自历史对话。 */
function AgentStandingsGroup({ store, onNavigate }: { store: HelmStoreValue; onNavigate?: () => void }) {
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)

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

  const handleBatchDelete = async () => {
    const count = selectedIds.size
    if (count === 0 || deleting) return
    const confirmed =
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(`确定删除选中的 ${count} 个会话吗？此操作无法撤销。`)
        : true
    if (!confirmed) return

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
        store.openTarget({ kind: 'conversation', conversationId: ROOT_CONVERSATION_ID })
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{
              height: 18,
              width: 18,
              padding: 0,
              color: batchMode ? 'var(--accent)' : undefined,
            }}
            title={batchMode ? '退出批量管理' : '批量管理会话'}
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
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ height: 18, width: 18, padding: 0 }}
            title="管理智能体角色 (Profile)"
            onClick={() => store.setActiveModal({ kind: 'profile-editor' })}
          >
            <HelmIcon name="plus" size={12} />
          </button>
        </div>
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
              onClick={() => void handleBatchDelete()}
            >
              {deleting ? '删除中...' : `删除所选 (${selectedIds.size})`}
            </button>
          </div>
        </div>
      )}
      {agentStandings.map((agent) => (
        <AgentStandingItem
          key={agent.profileId}
          agent={agent}
          store={store}
          onCreate={(profileId) => void createConversation(profileId)}
          onNavigate={onNavigate}
          batchMode={batchMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
        />
      ))}
    </div>
  )
}

/** 插件动态会话分组区（sidebar.section）：filterTag 分组通用渲染，支持 collapsible / defaultCollapsed。 */
function SidebarSectionGroups({ store }: { store: HelmStoreValue }) {
  const sections = store.groupedUi.sidebarSections.filter((s) => s.spec.filterTag)
  // 纯内容型 section（无 filterTag，但声明了 client/json 内容）：渲染内容本身，
  // 不因缺少 filterTag 静默丢弃（与 sidebar.item 的 client 内容渲染同一策略）。
  const contentSections = store.groupedUi.sidebarSections.filter(
    (s) => !s.spec.filterTag && (s.spec.client !== undefined || s.spec.json !== undefined),
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
        <StatusBadge conv={conv} />
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

export function Sidebar({ onClose }: { onClose?: () => void } = {}) {
  const store = useHelmStore()

  return (
    <aside className="helm-sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <HelmIcon name="layers" size={16} />
          Helm
          <StatusDot connected={store.sseConnected} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="btn btn-sm"
            title="打开 Cmd K 全局搜索与命令面板"
            onClick={() => store.setActiveModal({ kind: 'command-palette' })}
          >
            <HelmIcon name="search" size={13} />
          </button>
          {onClose && (
            <button
              type="button"
              className="btn btn-ghost btn-sm mobile-sidebar-close"
              aria-label="关闭导航栏"
              title="关闭导航栏"
              onClick={onClose}
            >
              <HelmIcon name="x" size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-scroll">
        <PendingAsksPanel store={store} />

        <AgentStandingsGroup store={store} onNavigate={onClose} />

        <SidebarSectionGroups store={store} />

        <ViewNavGroup store={store} />
      </div>

      <div className="sidebar-footer">
        <div style={{ display: 'flex', gap: 2 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="角色 Profiles"
            onClick={() => store.setActiveModal({ kind: 'profile-editor' })}
          >
            <HelmIcon name="bot" size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="模型与凭据"
            onClick={() => store.setActiveModal({ kind: 'provider-auth' })}
          >
            <HelmIcon name="key" size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="技能库 Skills"
            onClick={() => store.setActiveModal({ kind: 'skill-viewer' })}
          >
            <HelmIcon name="sparkles" size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="计算节点 Nodes"
            aria-label="计算节点 Nodes"
            onClick={() => store.setActiveModal({ kind: 'nodes' })}
          >
            <HelmIcon name="network" size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="插件与设置"
            onClick={() => store.setActiveModal({ kind: 'plugin-settings' })}
          >
            <HelmIcon name="settings" size={14} />
          </button>
        </div>
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
            size={14}
          />
        </button>
      </div>
    </aside>
  )
}
