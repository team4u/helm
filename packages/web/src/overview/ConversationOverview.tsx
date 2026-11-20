/**
 * 会话总览（只读宿主视图，对话空间主舞台 `#/overview`）：
 *
 * - 复用态势模型的唯一树聚合口径：一张卡片 = 一棵根会话树（含安静树），
 *   卡面只呈现真实事实（代表位灯、lastError / doing / 后台摘要 / 后代运行
 *   计数），绝不编造进度；
 * - 筛选：全部 / 需处理 / 进行中 / 未读（SegmentedControl）+ 角色 / 节点 /
 *   来源（SDK Select，来源 = 常规对话 vs 托管会话，托管判定与侧栏
 *   sidebarSection filterTag 同源，零插件 ID 特判）；排序桶序 + createdAt
 *   倒序，流式输出不跳卡；
 * - 卡片元信息区挂 OVERVIEW_CARD_META_SLOT 只读插槽（插件贡献跳转胶囊等，
 *   插槽内可点元素自行 stopPropagation，不误触卡片直达；无贡献零占位）；
 * - 打开真实会话：卡面点击直达 targetConversationId（树内有等待人类的会话
 *   时直达最新审批现场），后代会话芯片逐个直达——统一复用既有会话抽屉
 *   （conversation-drawer 模态，进 URL、浏览器返回即收起），人在总览不离场；
 * - 审批仍走 AskDoc、后台通知仍走浏览器通知旧链路——本视图是态势的只读
 *   总览，不是新的通知收件箱；
 * - 移动端主舞台自适应：筛选折行、卡片网格单列化（responsive 断点）。
 */
import { HubUpdateCard } from './HubUpdateCard.js'
import { HubUpgradedNotice } from './HubUpgradedNotice.js'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { HelmxIcon, Checkbox, PluginSlot, SegmentedControl, Select } from '@helmx/plugin-client'
import { OVERVIEW_CARD_META_SLOT } from '@helmx/protocol/browser'
import {
  useAuthConnection,
  useConversations,
  useGroupedUi,
  useLocationTargets,
  usePlugins,
  useProfilesSlice,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { Tooltip } from '../ui/Tooltip.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import { conversationsApi } from '../lib/api.js'
import { ConversationStatusDot } from '../shell/SidebarPrimitives.js'
import { partitionSidebarUi, isConversationArchivable } from '../shell/sidebar-model.js'
import { archiveBatchNotice, patchConversationsArchived } from '../shell/archive-ops.js'
import { useGlobalAttention } from '../shell/use-attention-indicator.js'
import {
  buildOverviewCards,
  filterOverviewCards,
  overviewNodeOptions,
  overviewProfileOptions,
  type OverviewBucketFilter,
  type OverviewCard,
  type OverviewSourceFilter,
} from './overview-model.js'

export interface ConversationOverviewProps {
  isSplit?: boolean
  onCloseSplit?: () => void
}

type BucketFilterValue = OverviewBucketFilter
type SourceFilterValue = OverviewSourceFilter

/** 单卡：根会话树聚合卡（只读）；卡面直达 target，芯片逐后代直达。
 * 批量模式下整卡变为勾选目标（含芯片点击），不再触发导航。 */
function OverviewCardView({
  card,
  onOpenConversation,
  viewedConversationIds,
  batchMode = false,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  card: OverviewCard
  onOpenConversation: (conversationId: number) => void
  viewedConversationIds: ReadonlySet<number>
  batchMode?: boolean
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: (conversationId: number) => void
}): ReactNode {
  const { t } = useWebLocale()
  const remoteNodeId = card.root.nodeId !== undefined && card.root.nodeId !== 'local' ? card.root.nodeId : null
  // 紧凑元信息行：角色 · @节点 · 摘要 同一行（远端节点折叠进来，不再独占
  // 一行）；摘要尾随弹性截断，角色/节点固定不丢事实。
  const metaParts: ReactNode[] = []
  if (card.profileLabel !== '') {
    metaParts.push(
      <span key="profile" className="overview-card-sub-profile">
        {card.profileLabel}
      </span>,
    )
  }
  if (remoteNodeId !== null) {
    metaParts.push(
      <span key="node" className="overview-card-sub-node mono" title={t('shell.node.title', { id: remoteNodeId })}>
        @{remoteNodeId}
      </span>,
    )
  }
  if (card.summaryText !== '') {
    metaParts.push(
      <span key="summary" className="overview-card-sub-summary" title={card.summaryText}>
        {card.summaryText}
      </span>,
    )
  }
  const toggleCardSelect = (): void => {
    if (selectable) onToggleSelect?.(card.root.id)
  }
  return (
    <div
      className={`overview-card overview-card-${card.bucket}${selected ? ' is-selected' : ''}`}
      onClick={() => {
        if (batchMode) {
          toggleCardSelect()
          return
        }
        onOpenConversation(card.targetConversationId)
      }}
      title={t('shell.attention.openConversation', { id: card.targetConversationId })}
    >
      <div className="overview-card-head">
        {batchMode && (
          <span className="overview-card-batch-check" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={selected}
              disabled={!selectable}
              title={selectable ? undefined : t('shell.overview.batchProtected')}
              onChange={toggleCardSelect}
            />
          </span>
        )}
        <span className="nav-status-slot">
          {/* 灯位与侧栏会话行完全同构（通用统一口径）：根会话自身状态 +
              树级后台在途聚合，经同一 resolveStatusLight 单灯裁决——根 idle
              且树内有后台在途时同样渲染空心蓝环；子代理等后代状态由后代
              芯片各自的灯与诚实摘要承载，不在卡面灯位混入代表位语义。 */}
          <ConversationStatusDot
            conv={card.root}
            background={{ active: card.backgroundActive, summary: card.backgroundSummary }}
            showDone={card.root.unread && !viewedConversationIds.has(card.root.id)}
          />
        </span>
        <span className="overview-card-title">
          {card.root.title || t('shell.conversationFallback', { id: card.root.id })}
        </span>
        <span className="overview-card-id tabular-nums">#{card.root.id}</span>
        {!batchMode && (
          <span className="overview-card-actions" onClick={(e) => e.stopPropagation()}>
            <ConversationRowActionsMenu conversation={card.root} enableDelete />
          </span>
        )}
      </div>
      {metaParts.length > 0 && (
        <div className="overview-card-sub">
          {metaParts.flatMap((part, index) =>
            index === 0
              ? [part]
              : [
                  <span key={`sep-${index}`} className="overview-card-sub-sep" aria-hidden="true">
                    ·
                  </span>,
                  part,
                ],
          )}
        </div>
      )}
      {/* 卡片元信息只读插槽：外层不拦截冒泡（空白处点击仍直达卡片目标），
          插件可点元素自行 stopPropagation；无贡献时 PluginSlot 渲染 null 零占位。 */}
      <PluginSlot
        ownerPluginId="builtin:overview"
        name={OVERVIEW_CARD_META_SLOT}
        conversationId={card.root.id}
        slotProps={{ rootConversation: card.root, memberIds: card.memberIds }}
        className="overview-card-meta-slot"
      />
      {card.descendants.length > 0 && (
        <div className="overview-chips">
          {card.descendants.map((descendant) => (
            <button
              key={descendant.conv.id}
              type="button"
              className="overview-chip"
              title={t('shell.attention.openConversation', { id: descendant.conv.id })}
              onClick={(e) => {
                e.stopPropagation()
                if (batchMode) {
                  toggleCardSelect()
                  return
                }
                onOpenConversation(descendant.conv.id)
              }}
            >
              <ConversationStatusDot
                conv={descendant.conv}
                background={descendant.backgroundActive ? { active: true, summary: '' } : undefined}
                showDone={descendant.conv.unread && !viewedConversationIds.has(descendant.conv.id)}
              />
              <span className="overview-chip-label">
                {descendant.conv.title || t('shell.conversationFallback', { id: descendant.conv.id })}
              </span>
            </button>
          ))}
          {card.hiddenDescendantCount > 0 && (
            <span className="overview-chip-more tabular-nums">
              {t('shell.overview.moreDescendants', { count: card.hiddenDescendantCount })}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function ConversationOverview({ isSplit = false, onCloseSplit }: ConversationOverviewProps): ReactNode {
  const hubUpdateCard = (
    <>
      <HubUpgradedNotice />
      <HubUpdateCard />
    </>
  )
  const { t } = useWebLocale()
  const { openTarget, closeSplit, setActiveModal } = useStoreActions()
  const { background, viewedConversationIds } = useGlobalAttention()
  const conversations = useConversations()
  const plugins = usePlugins()
  const groupedUi = useGroupedUi()
  const { profiles } = useProfilesSlice()
  const { splitTarget } = useLocationTargets()
  const { sseConnected } = useAuthConnection()
  const { assetsLoaded } = useProfilesSlice()
  const [bucketFilter, setBucketFilter] = useState<BucketFilterValue>('all')
  const [profileFilter, setProfileFilter] = useState('')
  const [nodeFilter, setNodeFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilterValue>('all')
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [archiving, setArchiving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false)
  const { pushNotice } = useStoreActions()

  // 来源判定与侧栏同源（sidebarSection filterTag，零插件 ID 特判）：
  // 插件停用后其 section 贡献消失，卡片自然回到「常规对话」一侧。
  const { sectionTags, keptAliveTags } = useMemo(
    () => partitionSidebarUi(groupedUi.sidebarItems, groupedUi.sidebarSections),
    [groupedUi.sidebarItems, groupedUi.sidebarSections],
  )
  const cards = useMemo(
    () => buildOverviewCards({ conversations, background, profiles, plugins, t, sectionTags }),
    [conversations, background, profiles, plugins, t, sectionTags],
  )
  const visibleCards = useMemo(
    () =>
      filterOverviewCards(cards, {
        bucket: bucketFilter,
        profileId: profileFilter,
        nodeId: nodeFilter,
        source: sourceFilter,
      }),
    [cards, bucketFilter, profileFilter, nodeFilter, sourceFilter],
  )
  const dataReady = conversations.length > 0 || (assetsLoaded && sseConnected)
  const profileOptions = useMemo(() => overviewProfileOptions(cards), [cards])
  const nodeOptions = useMemo(() => overviewNodeOptions(cards), [cards])
  // 来源筛选仅在存在托管卡片（或已选非 all，防困住）时展示：无托管会话时
  // 不添无效控件，保持工具栏零噪音。
  const showSourceFilter = sourceFilter !== 'all' || cards.some((card) => card.managed)

  const bucketCounts = useMemo(() => {
    const counts = { all: cards.length, needs_attention: 0, running: 0, unread_done: 0 }
    for (const card of cards) {
      if (card.bucket !== 'quiet') counts[card.bucket] += 1
    }
    return counts
  }, [cards])

  // 批量管理口径与侧栏批量模式同界：仅人类自有、未被插件 sidebarSection
  // 接管的根会话可勾选（isConversationArchivable ⇒ 可归档且可删除）；托管
  // （任务执行等）与 bot 会话不参与批量，保护语义与侧栏勾选框一致。
  const isCardSelectable = useMemo(
    () => (conv: ConversationSummary) => isConversationArchivable(conv, sectionTags, keptAliveTags),
    [sectionTags, keptAliveTags],
  )
  const selectableCardIds = useMemo(
    () => visibleCards.filter((card) => isCardSelectable(card.root)).map((card) => card.root.id),
    [visibleCards, isCardSelectable],
  )
  const isAllSelected = selectableCardIds.length > 0 && selectableCardIds.every((id) => selectedIds.has(id))

  const toggleCardSelect = (conversationId: number): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(conversationId)) {
        next.delete(conversationId)
      } else {
        next.add(conversationId)
      }
      return next
    })
  }

  const exitBatchMode = (): void => {
    setBatchMode(false)
    setSelectedIds(new Set())
  }

  /** 批量归档：逐会话 PATCH 宿主归档 tag + allSettled 聚合（部分失败不掩盖
   * 成功）；归档不删除会话、无导航，列表纯靠 conversation.upsert 更新
   * （归档根树随即离开总览）。快照从全量 cards 解析（不随筛选丢失已选项）。 */
  const executeBatchArchive = async (): Promise<void> => {
    if (selectedIds.size === 0 || archiving || deleting) return
    setArchiving(true)
    try {
      const convs = cards.filter((card) => selectedIds.has(card.root.id)).map((card) => card.root)
      const outcome = await patchConversationsArchived(convs, true)
      pushNotice(archiveBatchNotice(true, outcome, t))
      exitBatchMode()
    } finally {
      setArchiving(false)
    }
  }

  /** 批量删除：逐会话 DELETE + allSettled 聚合（与侧栏批量删除同语义）；
   * 不做任何导航——若被删会话正被打开，由 conversation.deleted SSE 兜底
   * 管道统一处理当前目标回退。 */
  const executeBatchDelete = async (): Promise<void> => {
    if (selectedIds.size === 0 || deleting) return
    setBatchDeleteConfirmOpen(false)
    setDeleting(true)
    try {
      const ids = Array.from(selectedIds)
      const results = await Promise.allSettled(ids.map((id) => conversationsApi.remove(id)))
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length
      const rejected = results.filter((r) => r.status === 'rejected').length
      if (rejected === 0) {
        pushNotice({
          type: 'notification',
          level: 'info',
          title: t('shell.batch.bulkDeleteCompleted'),
          body: t('shell.batch.bulkDeleteCompletedBody', { count: fulfilled }),
        })
      } else if (fulfilled === 0) {
        pushNotice({
          type: 'notification',
          level: 'error',
          title: t('shell.batch.bulkDeleteFailed'),
          body: t('shell.batch.bulkDeleteFailedBody', { count: rejected }),
        })
      } else {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('shell.batch.bulkDeletePartial'),
          body: t('shell.batch.bulkDeletePartialBody', { fulfilled, rejected }),
        })
      }
      exitBatchMode()
    } catch (err) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('shell.batch.bulkDeleteError'),
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDeleting(false)
    }
  }

  const openConversationDrawer = (conversationId: number): void => {
    setActiveModal({ kind: 'conversation-drawer', conversationId })
  }

  // 数据就绪门：会话快照未到（且资产未齐/SSE 未连）时如实展示加载态，
  // 绝不把「还没加载」伪报成「没有会话」；一旦有任何会话或资产+SSE 双就绪，
  // 空列表才是真实的空（此后瞬时断连保留既有快照，不闪加载）。

  return (
    <div className={`primary-center conversation-overview${isSplit ? ' is-split' : ''}`} data-view="conversation-overview">
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmxIcon name="activity" size={14} />
            <span>{t('shell.overview.title')}</span>
          </div>
          <span className="primary-center-subtitle tabular-nums">
            {t('shell.overview.stats', { count: visibleCards.length })}
          </span>
        </div>
        <div className="primary-center-topbar-actions pane-actions">
          {isSplit ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton
              isSplitActive={splitTarget !== null}
              onToggleSplit={() => {
                if (splitTarget !== null) closeSplit()
                else openTarget({ kind: 'overview' }, { split: true })
              }}
            />
          )}
        </div>
      </div>
      {hubUpdateCard}

      <div className="primary-center-toolbar overview-toolbar">
        <SegmentedControl<BucketFilterValue>
          value={bucketFilter}
          onValueChange={setBucketFilter}
          aria-label={t('shell.overview.title')}
          items={[
            { value: 'all', label: t('shell.overview.filterAll'), badge: <span className="tabular-nums">{bucketCounts.all}</span> },
            { value: 'needs_attention', label: t('shell.overview.filterNeeds'), badge: <span className="tabular-nums">{bucketCounts.needs_attention}</span> },
            { value: 'running', label: t('shell.overview.filterRunning'), badge: <span className="tabular-nums">{bucketCounts.running}</span> },
            { value: 'unread_done', label: t('shell.overview.filterUnread'), badge: <span className="tabular-nums">{bucketCounts.unread_done}</span> },
          ]}
        />
        <div className="overview-filter-selects">
          <Select
            className="overview-filter-select"
            aria-label={t('shell.overview.profileFilterLabel')}
            options={[
              { value: '', label: t('shell.overview.profileFilter') },
              ...profileOptions.map((option) => ({ value: option.id, label: option.label })),
            ]}
            value={profileFilter}
            onChange={(event) => setProfileFilter(event.target.value)}
          />
          <Select
            className="overview-filter-select"
            aria-label={t('shell.overview.nodeFilterLabel')}
            options={[
              { value: '', label: t('shell.overview.nodeFilter') },
              ...nodeOptions.map((nodeId) => ({
                value: nodeId,
                label: nodeId === 'local' ? t('shell.overview.localNode') : nodeId,
              })),
            ]}
            value={nodeFilter}
            onChange={(event) => setNodeFilter(event.target.value)}
          />
          {showSourceFilter && (
            <Select
              className="overview-filter-select"
              aria-label={t('shell.overview.sourceFilterLabel')}
              options={[
                { value: 'all', label: t('shell.overview.sourceFilter') },
                { value: 'regular', label: t('shell.overview.sourceRegular') },
                { value: 'managed', label: t('shell.overview.sourceManaged') },
              ]}
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value as SourceFilterValue)}
            />
          )}
        </div>
        <Tooltip content={batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')} side="top">
          <button
            type="button"
            className={`btn btn-ghost btn-icon-xs overview-batch-toggle${batchMode ? ' is-active' : ''}`}
            title={batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')}
            aria-label={batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')}
            aria-pressed={batchMode}
            onClick={() => {
              if (batchMode) exitBatchMode()
              else setBatchMode(true)
            }}
          >
            <HelmxIcon name="check-square" size={12} />
          </button>
        </Tooltip>
      </div>

      {batchMode && (
        <div className="overview-batch-bar">
          <span className="overview-batch-bar-count tabular-nums">
            {t('shell.batch.selected', { count: selectedIds.size })}
          </span>
          <span className="overview-batch-bar-spacer" />
          <div className="overview-batch-bar-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={selectableCardIds.length === 0 || deleting || archiving}
              onClick={() => {
                if (isAllSelected) {
                  setSelectedIds(new Set())
                } else {
                  setSelectedIds(new Set(selectableCardIds))
                }
              }}
            >
              {isAllSelected ? t('shell.batch.clear') : t('shell.batch.selectAll')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={selectedIds.size === 0 || deleting || archiving}
              onClick={() => {
                void executeBatchArchive()
              }}
            >
              {archiving ? t('shell.agents.archiving') : t('shell.agents.archiveCount', { count: selectedIds.size })}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger-sm"
              disabled={selectedIds.size === 0 || deleting || archiving}
              onClick={() => setBatchDeleteConfirmOpen(true)}
            >
              {deleting ? t('shell.batch.deleting') : t('shell.batch.deleteCount', { count: selectedIds.size })}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={deleting || archiving} onClick={exitBatchMode}>
              {t('shell.batch.exit')}
            </button>
          </div>
        </div>
      )}

      <div className="overview-grid">
        {dataReady === false ? (
          <div className="overview-empty overview-loading" role="status">{t('shell.overview.loading')}</div>
        ) : visibleCards.length === 0 ? (
          <div className="overview-empty">{t('shell.overview.empty')}</div>
        ) : (
          visibleCards.map((card) => (
            <OverviewCardView
              key={card.root.id}
              card={card}
              onOpenConversation={openConversationDrawer}
              viewedConversationIds={viewedConversationIds}
              batchMode={batchMode}
              selectable={isCardSelectable(card.root)}
              selected={selectedIds.has(card.root.id)}
              onToggleSelect={toggleCardSelect}
            />
          ))
        )}
      </div>

      <ConfirmDialog
        open={batchDeleteConfirmOpen}
        onOpenChange={setBatchDeleteConfirmOpen}
        title={t('shell.batch.deleteConfirmTitle', { count: selectedIds.size })}
        description={t('shell.batch.deleteConfirmDesc')}
        confirmText={t('shell.batch.deleteConfirmButton')}
        danger
        onConfirm={() => {
          void executeBatchDelete()
        }}
        onCancel={() => setBatchDeleteConfirmOpen(false)}
      />
    </div>
  )
}
