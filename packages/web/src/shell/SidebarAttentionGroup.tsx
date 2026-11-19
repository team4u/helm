/**
 * 侧栏「态势」平铺分组（Web 宿主，非插件 sidebar.section）：
 *
 * - 收录需要跨角色关注的根会话树（attention-model 三桶：需关注 / 运行中 /
 *   未读完成），挂在待审批面板下方、智能体站位上方——无论用户停在哪个
 *   空间、助手分组是否展开，并发在跑的工作都不失明；
 * - 空时整组返回 null（零视觉残留）；可折叠（默认展开），头部带紧凑计数；
 * - 每行单灯位状态点（代表会话状态 + 树级后台在途聚合，复用
 *   ConversationStatusDot 的单灯裁决）+ 根会话标题 + 极简副信息（角色名 +
 *   真实动作/子任务数，诚实呈现 lastError / doing / 后台摘要，绝不编造）；
 * - 点击直达 item.targetConversationId（树内有等待人类的会话时直达最新
 *   审批现场，否则根会话），并收起移动端抽屉；绝不移走下方智能体站位
 *   分组里的会话（本分组只做聚合视图，不做搬迁）。
 */
import { useState, type MouseEvent, type ReactNode } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  getConversationPresence,
  presenceNavClassSuffix,
  shouldSkipNavRowClick,
  type SidebarStoreView,
} from './sidebar-model.js'
import type { AttentionTreeItem } from './attention-model.js'
import { ConversationStatusDot, RemoteNodeTag, SidebarPaneTag } from './SidebarPrimitives.js'

/** 单条态势行：单灯位 + 根会话标题 + 角色名/真实动作副信息 + 远端节点与 #id。 */
function AttentionRow({
  item,
  store,
  onNavigate,
}: {
  item: AttentionTreeItem
  store: SidebarStoreView
  onNavigate?: () => void
}): ReactNode {
  const { t } = useWebLocale()
  const presence = getConversationPresence(store, item.targetConversationId)
  const openTargetConversation = (): void => {
    store.openTarget({ kind: 'conversation', conversationId: item.targetConversationId })
    onNavigate?.()
  }
  const handleRowActivate = (e: MouseEvent<HTMLDivElement>): void => {
    if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
    openTargetConversation()
  }
  const subParts = item.profileLabel === '' ? [] : [item.profileLabel]
  if (item.summaryText !== '') subParts.push(item.summaryText)
  return (
    <div
      className={`nav-item nav-item-sub attention-row${presenceNavClassSuffix(presence)}`}
      onClick={handleRowActivate}
      title={t('shell.attention.openConversation', { id: item.targetConversationId })}
    >
      <button
        type="button"
        className="nav-item-main nav-open"
        onClick={openTargetConversation}
        aria-current={presence.active ? 'page' : undefined}
      >
        <span className="nav-status-slot">
          <ConversationStatusDot
            conv={item.representative}
            background={{ active: item.backgroundActive, summary: item.backgroundSummary }}
          />
        </span>
        <span className="attention-row-body">
          <span className="nav-item-label">
            {item.root.title || t('shell.conversationFallback', { id: item.root.id })}
          </span>
          {subParts.length > 0 && <span className="attention-row-sub">{subParts.join(' · ')}</span>}
        </span>
      </button>
      <span className="nav-item-meta">
        <SidebarPaneTag paneTag={presence.paneTag} />
        {item.root.nodeId !== undefined && item.root.nodeId !== 'local' && (
          <RemoteNodeTag nodeId={item.root.nodeId} />
        )}
        <span className="tabular-nums">#{item.root.id}</span>
      </span>
    </div>
  )
}

/** 态势平铺分组：items 为空时整组不渲染（零占位）。 */
export function SidebarAttentionGroup({
  items,
  store,
  onNavigate,
}: {
  items: AttentionTreeItem[]
  store: SidebarStoreView
  onNavigate?: () => void
}): ReactNode {
  const { t } = useWebLocale()
  const [open, setOpen] = useState(true)
  if (items.length === 0) return null
  const toggleTitle = open ? t('shell.attention.collapseGroup') : t('shell.attention.expandGroup')
  return (
    <div className="sidebar-group sidebar-attention-group">
      <div className="sidebar-group-header">
        <button
          type="button"
          className="sidebar-group-header-toggle"
          title={toggleTitle}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="sidebar-attention-header-label">
            <HelmxIcon name="activity" size={12} />
            <span className="nav-item-label">{t('shell.attention.groupTitle')}</span>
          </span>
          <span className="sidebar-attention-header-meta">
            <span className="badge badge-neutral tabular-nums">{items.length}</span>
            <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </span>
        </button>
      </div>
      {open &&
        items.map((item) => (
          <AttentionRow
            key={item.root.id}
            item={item}
            store={store}
            onNavigate={onNavigate}
          />
        ))}
    </div>
  )
}
