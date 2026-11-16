/**
 * 侧栏「已归档」分组（Web 宿主策略，非插件 sidebar.section）：
 *
 * - 收敛展示带宿主归档 tag 的人类自有根会话（暴露规则与 Agent 站位一致：
 *   有父链 / bot-helm 托管 / 插件 section 接管的会话绝不进入）；
 * - 默认折叠；展开后按归属智能体 + 标题辨识，单行恢复走行内「更多操作」菜单
 *   （菜单对已归档会话自动提供「恢复会话」项），也可进入批量恢复；
 * - 恢复经现有会话 PATCH（archive-ops），失败显式通知，不静默吞错；
 * - 分组为空时整体不渲染，零视觉残留。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Checkbox, HelmIcon } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import type { HelmStoreValue } from '../lib/types.js'
import { Tooltip } from '../ui/Tooltip.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import { buildArchivedConversationList, isConversationActive } from './sidebar-model.js'
import type { ArchivedConversationListItem } from './sidebar-model.js'
import { archiveBatchNotice, patchConversationsArchived } from './archive-ops.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'
import { ConversationStatusDot } from './SidebarPrimitives.js'

/** 已归档分组的单个会话行：状态灯前置行首 + 标题 + 归属智能体徽标 + 动作区菜单。 */
function ArchivedConversationRow({
  item,
  store,
  background,
  onNavigate,
  batchMode,
  selected,
  onToggleSelect,
}: {
  item: ArchivedConversationListItem
  store: HelmStoreValue
  background: ConversationBackgroundIndex
  onNavigate?: () => void
  batchMode?: boolean
  selected?: boolean
  onToggleSelect?: (id: number) => void
}): ReactNode {
  const conv = item.conv
  const active = isConversationActive(store, conv.id)

  return (
    <div
      className={`nav-item nav-item-sub${active ? ' nav-item-active' : ''}`}
      onClick={() => {
        if (batchMode) onToggleSelect?.(conv.id)
      }}
    >
      {batchMode && (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            className="sidebar-batch-checkbox"
            checked={Boolean(selected)}
            onChange={() => onToggleSelect?.(conv.id)}
          />
        </span>
      )}
      <button
        type="button"
        className="nav-item-main nav-open"
        onClick={(e) => {
          if (batchMode) {
            e.stopPropagation()
            onToggleSelect?.(conv.id)
            return
          }
          store.openTarget({ kind: 'conversation', conversationId: conv.id })
          onNavigate?.()
        }}
        aria-current={active ? 'page' : undefined}
      >
        <span className="nav-status-slot">
          <ConversationStatusDot conv={conv} background={background.get(conv.id)} />
        </span>
        <span className="nav-item-label">{conv.title || `会话 #${conv.id}`}</span>
      </button>
      <span className="nav-item-meta">
        <span
          className="badge badge-neutral archived-profile-label"
          title={`归属智能体：${item.profileLabel}`}
        >
          {item.profileLabel}
        </span>
        <span className="tabular-nums">#{conv.id}</span>
        <span className="nav-item-row-actions">
          <ConversationRowActionsMenu conversation={conv} />
        </span>
      </span>
    </div>
  )
}

/** 「已归档」分组：默认折叠，展开后逐行恢复或批量恢复。 */
export function ArchivedConversationsGroup({
  background,
  onNavigate,
}: {
  background: ConversationBackgroundIndex
  onNavigate?: () => void
}): ReactNode {
  const store = useHelmStore()
  const [open, setOpen] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [restoring, setRestoring] = useState(false)

  const items = useMemo(
    () =>
      buildArchivedConversationList({
        conversations: store.conversations,
        profiles: store.profiles,
        plugins: store.plugins,
        sidebarSections: store.groupedUi.sidebarSections,
      }),
    [store.conversations, store.profiles, store.plugins, store.groupedUi.sidebarSections],
  )

  const activeConversationIds = [
    store.primaryTarget.kind === 'conversation' ? store.primaryTarget.conversationId : null,
    store.splitTarget?.kind === 'conversation' ? store.splitTarget.conversationId : null,
  ]
  useEffect(() => {
    if (items.some((item) => activeConversationIds.includes(item.conv.id))) setOpen(true)
  }, [items, store.primaryTarget, store.splitTarget])

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isAllSelected = items.length > 0 && items.every((item) => selectedIds.has(item.conv.id))

  /** 批量恢复：逐会话 PATCH + allSettled 汇总（部分失败不掩盖成功项）；
   *  单行恢复走行内「更多操作」菜单（ConversationRowActionsMenu 对已归档会话自动提供恢复项）。 */
  const executeBatchRestore = async () => {
    if (selectedIds.size === 0 || restoring) return
    setRestoring(true)
    try {
      const convs = items
        .filter((item) => selectedIds.has(item.conv.id))
        .map((item) => item.conv)
      const outcome = await patchConversationsArchived(convs, false)
      store.pushNotice(archiveBatchNotice(false, outcome))
      setSelectedIds(new Set())
      setBatchMode(false)
    } finally {
      setRestoring(false)
    }
  }

  if (items.length === 0) return null

  return (
    <div className="sidebar-group archived-conversations-group">
      <div className="sidebar-group-header">
        <button
          type="button"
          className="sidebar-group-header-toggle"
          title={open ? '收起已归档分组' : '展开已归档分组'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            <HelmIcon name="archive" size={12} />
            <span className="nav-item-label">已归档</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span className="badge badge-neutral tabular-nums">{items.length}</span>
            <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </span>
        </button>
        {open && (
          <Tooltip content={batchMode ? '退出批量恢复' : '批量恢复已归档会话'} side="top">
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs"
              style={{ color: batchMode ? 'var(--accent)' : undefined }}
              title={batchMode ? '退出批量恢复' : '批量恢复已归档会话'}
              aria-label={batchMode ? '退出批量恢复' : '批量恢复已归档会话'}
              onClick={() => {
                setBatchMode((v) => {
                  if (v) setSelectedIds(new Set())
                  return !v
                })
              }}
            >
              <HelmIcon name="check-square" size={12} />
            </button>
          </Tooltip>
        )}
      </div>
      {open && batchMode && (
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
              title="退出批量恢复"
            >
              退出
            </button>
          </div>
          <div className="sidebar-batch-bar-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={items.length === 0 || restoring}
              onClick={() => {
                setSelectedIds(isAllSelected ? new Set() : new Set(items.map((item) => item.conv.id)))
              }}
            >
              {isAllSelected ? '清空' : '全选'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={selectedIds.size === 0 || restoring}
              onClick={() => void executeBatchRestore()}
            >
              {restoring ? '恢复中...' : `恢复 (${selectedIds.size})`}
            </button>
          </div>
        </div>
      )}
      {open &&
        items.map((item) => (
          <ArchivedConversationRow
            key={item.conv.id}
            item={item}
            store={store}
            background={background}
            onNavigate={onNavigate}
            batchMode={batchMode}
            selected={selectedIds.has(item.conv.id)}
            onToggleSelect={toggleSelect}
          />
        ))}
    </div>
  )
}
