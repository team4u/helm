/**
 * 会话总览（并发主入口，对话空间主舞台 `#/overview`，冷启动默认落地）：
 *
 * - 复用态势模型的唯一树聚合口径：一张卡片 = 一棵根会话树（含安静树），
 *   卡面只呈现真实事实（根会话状态 + 树级后台在途的灯位、lastError /
 *   doing / 后台摘要 / 后代运行计数），绝不编造进度；
 * - 直进语义：卡片主体 / 后代芯片点击直达主屏会话（树内有等待人类的会话
 *   时直达最新审批现场），与会话列表点击完全一致；「抽屉速览」与「右分屏
 *   打开」收进卡片 `...` 菜单（prependItems 通用前置动作），托管/受保护卡
 *   也至少保留这两个只读视图动作；
 * - 顶栏「新话题」：单候选角色直进待命页，多候选下拉选角（最近活跃根会话
 *   所属角色置顶，远端节点 @后缀标注）；首次发送才落库，不预创建会话；
 * - 筛选：全部 / 需处理 / 进行中 / 未读（SegmentedControl）+ 角色 / 节点 /
 *   来源（SDK Select）+ 标题/摘要搜索，全部状态经唯一 URL Hash 导航模型
 *   持久化（overview 目标的 sp. / ssp. 路由参数，仅参数变化 replace，
 *   刷新/前进/后退/深链可恢复）；来源 = 常规对话 vs 托管会话，托管判定与
 *   侧栏 sidebarSection filterTag 同源，零插件 ID 特判；排序桶序 + createdAt
 *   倒序，流式输出不跳卡；
 * - 无结果语义：真实空系统与筛选无命中显式区分，无命中提供一键清除筛选；
 *   桶徽标计数在其余筛选上下文内统计（如实表达切桶后的剩余量）；
 * - 批量管理：选择集合始终收敛为当前可见可勾选卡片的子集（筛选变化与
 *   实时会话变化后隐藏项立即出局，绝不悄悄操作不可见对象）；托管/bot 会话
 *   保护与部分失败通知与侧栏同语义；
 * - 卡片元信息区挂 OVERVIEW_CARD_META_SLOT 只读插槽（插件贡献跳转胶囊等，
 *   插槽内可点元素自行拦截冒泡；无贡献零占位）；
 * - 审批仍走 AskDoc、后台通知仍走浏览器通知旧链路——本视图是态势的分发
 *   大堂，不是新的通知收件箱；
 * - 移动端主舞台自适应：筛选折行、卡片网格单列化（responsive 断点）。
 */
import { HubUpdateCard } from './HubUpdateCard.js'
import { HubUpgradedNotice } from './HubUpgradedNotice.js'
import { useEffect, useId, useMemo, useState } from 'react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import { conversationsApi } from '../lib/api.js'
import { ConversationStatusDot, RemoteNodeTag } from '../shell/SidebarPrimitives.js'
import { buildAgentStandings, isConversationArchived, partitionSidebarUi, isConversationArchivable, type AgentStanding } from '../shell/sidebar-model.js'
import { archiveBatchNotice, patchConversationsArchived } from '../shell/archive-ops.js'
import { useGlobalAttention } from '../shell/use-attention-indicator.js'
import {
  buildOverviewCards,
  filterOverviewCards,
  overviewBucketCounts,
  overviewFilterParamsRepair,
  overviewNodeOptions,
  overviewProfileOptions,
  parseOverviewFilterParams,
  OVERVIEW_DESCENDANT_LIMIT,
  type OverviewBucketFilter,
  type OverviewCard,
  type OverviewFilterParamKey,
  type OverviewSourceFilter,
} from './overview-model.js'

export interface ConversationOverviewProps {
  isSplit?: boolean
  onCloseSplit?: () => void
}

type BucketFilterValue = OverviewBucketFilter
type SourceFilterValue = OverviewSourceFilter

/** 单卡：根会话树聚合卡（只读）；卡面/芯片直进主屏会话。
 * 可访问性结构：外层 div 仅承载鼠标整卡点击便利（不挂交互 ARIA 角色，
 * 避免交互嵌套），真正的语义入口是标题簇真按钮（含状态灯可读标签，
 * 键盘 Enter/Space 可达）；菜单/勾选框/芯片/展开开关均为独立兄弟控件，
 * 绝不嵌套进按钮。批量模式下按钮与整卡点击变为勾选切换（aria-pressed）。 */
function OverviewCardView({
  card,
  onOpenConversation,
  onDrawerPeek,
  onOpenSplit,
  viewedConversationIds,
  batchMode = false,
  selectable = false,
  selected = false,
  expanded = false,
  onToggleSelect,
  onToggleExpanded,
}: {
  card: OverviewCard
  onOpenConversation: (conversationId: number) => void
  onDrawerPeek: (conversationId: number) => void
  onOpenSplit: (conversationId: number) => void
  viewedConversationIds: ReadonlySet<number>
  batchMode?: boolean
  selectable?: boolean
  selected?: boolean
  /** 卡内后代芯片是否展开全量（确定性排序不变，仅补齐剩余）。 */
  expanded?: boolean
  onToggleSelect?: (conversationId: number) => void
  onToggleExpanded?: (rootConversationId: number) => void
}): ReactNode {
  const { t } = useWebLocale()
  const attentionId = useId()
  const needsAttention = card.bucket === 'needs_attention'
  const errorText = card.representative.status === 'error' ? card.representative.lastError?.trim() : undefined
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
  if (!needsAttention && card.summaryText !== '') {
    metaParts.push(
      <span key="summary" className="overview-card-sub-summary" title={card.summaryText}>
        {card.summaryText}
      </span>,
    )
  }
  const toggleCardSelect = (): void => {
    if (selectable) onToggleSelect?.(card.root.id)
  }
  const activateCard = (): void => {
    if (batchMode) {
      toggleCardSelect()
      return
    }
    onOpenConversation(card.targetConversationId)
  }
  const openLabel = t('shell.attention.openConversation', { id: card.targetConversationId })
  const cardTitleText = card.root.title || t('shell.conversationFallback', { id: card.root.id })
  // 批量模式按钮语义切换为勾选（aria-pressed 表态，名称如实描述切换动作）；
  // 普通模式不覆写 aria-label——可访问名称直接由内容组成（状态灯可读标签 +
  // 标题 + #id），异常/等待人类事实原样进入读屏。
  const buttonLabel = batchMode ? `${cardTitleText} · ${t('shell.overview.batchToggleCard')}` : openLabel
  const shownDescendants = expanded ? card.descendants : card.descendants.slice(0, OVERVIEW_DESCENDANT_LIMIT)
  return (
    <article
      className={`overview-card overview-card-${card.bucket}${selected ? ' is-selected' : ''}`}
      onClick={activateCard}
    >
      <div className="overview-card-head">
        {batchMode && (
          <span className="overview-card-batch-check" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={selected}
              aria-label={cardTitleText}
              disabled={!selectable}
              title={selectable ? undefined : t('shell.overview.batchProtected')}
              onChange={toggleCardSelect}
            />
          </span>
        )}
        {/* 语义主入口：真按钮包住标题簇（灯 + 标题 + #id）。按钮内容即
            标题提供可访问名称，需处理原因通过 aria-describedby 关联。 */}
        <button
          type="button"
          className="overview-card-open"
          title={buttonLabel}
          aria-label={batchMode ? buttonLabel : undefined}
          aria-pressed={batchMode ? selected : undefined}
          aria-describedby={needsAttention ? attentionId : undefined}
          disabled={batchMode && !selectable}
          onClick={(e) => {
            e.stopPropagation()
            activateCard()
          }}
        >
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
            {cardTitleText}
          </span>
          <span className="overview-card-id tabular-nums">#{card.root.id}</span>
        </button>
        {!batchMode && (
          <span className="overview-card-actions" onClick={(e) => e.stopPropagation()}>
            <ConversationRowActionsMenu
              conversation={card.root}
              enableDelete
              prependItems={[
                {
                  key: 'drawer-peek',
                  icon: 'panel-right',
                  label: t('shell.overview.drawerPeek'),
                  onSelect: () => onDrawerPeek(card.targetConversationId),
                },
                {
                  key: 'open-split',
                  icon: 'columns',
                  label: t('shell.sidebar.openInRightSplit'),
                  onSelect: () => onOpenSplit(card.targetConversationId),
                },
              ]}
            />
          </span>
        )}
      </div>
      {needsAttention && (
        <p id={attentionId} className="overview-card-attention" title={errorText}>
          {card.hasWaiting && t('shell.overview.waitingForYou')}
          {card.hasError && card.hasWaiting && ' · '}
          {card.hasError && t('shell.overview.hasError')}
          {errorText && ` · ${errorText}`}
        </p>
      )}
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
      {/* 插槽位于标题按钮之外，插件可点元素沿用 stopPropagation 契约。 */}
      <PluginSlot
        ownerPluginId="builtin:overview"
        name={OVERVIEW_CARD_META_SLOT}
        conversationId={card.root.id}
        slotProps={{ rootConversation: card.root, memberIds: card.memberIds }}
        className="overview-card-meta-slot"
      />
      {card.descendants.length > 0 && (
        <div className="overview-chips">
          {shownDescendants.map((descendant) => (
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
          {/* 「+N / 还有 N 个」是真实入口：点击卡内展开剩余后代（同一
              确定性排序补齐，不重排、不另建树模型），再点收起。 */}
          {card.hiddenDescendantCount > 0 && (
            <button
              type="button"
              className="overview-chip-more tabular-nums"
              aria-expanded={expanded}
              title={expanded ? t('shell.overview.collapseDescendants') : t('shell.overview.moreDescendants', { count: card.hiddenDescendantCount })}
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpanded?.(card.root.id)
              }}
            >
              {expanded ? t('shell.overview.collapseDescendants') : t('shell.overview.moreDescendants', { count: card.hiddenDescendantCount })}
            </button>
          )}
        </div>
      )}
    </article>
  )
}

export function ConversationOverview({ isSplit = false, onCloseSplit }: ConversationOverviewProps): ReactNode {
  const hubUpdateCard = (
    <>
      <HubUpgradedNotice />
      <HubUpdateCard />
    </>
  )
  const { locale, t } = useWebLocale()
  const { openTarget, closeSplit, setActiveModal, setScreenParams, pushNotice } = useStoreActions()
  const { background, viewedConversationIds } = useGlobalAttention()
  const conversations = useConversations()
  const plugins = usePlugins()
  const groupedUi = useGroupedUi()
  const { profiles } = useProfilesSlice()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { sseConnected } = useAuthConnection()
  const { assetsLoaded } = useProfilesSlice()
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [expandedCardIds, setExpandedCardIds] = useState<Set<number>>(new Set())
  const [archiving, setArchiving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [batchDeleteIds, setBatchDeleteIds] = useState<ReadonlySet<number> | null>(null)

  // 筛选状态接入唯一 URL Hash 导航模型：总览目标在 sp. / ssp. 命名空间携带
  // bucket/profile/node/source/q 路由参数（主屏 sp.、分屏 ssp.），经
  // store.setScreenParams 写入——仅参数变化默认 replace 不污染后退栈，
  // 刷新/前进/后退/深链恢复全由地址栏唯一事实源驱动；切换主屏目标时
  // 命名空间参数随之丢弃（重新进入总览即回到未筛选态）。
  const routeTarget = isSplit ? splitTarget : primaryTarget
  const overviewParams = routeTarget !== null && routeTarget.kind === 'overview' ? routeTarget.params : undefined
  const filter = parseOverviewFilterParams(overviewParams)
  const bucketFilter = filter.bucket
  const profileFilter = filter.profileId
  const nodeFilter = filter.nodeId
  const sourceFilter = filter.source
  const queryFilter = filter.query
  const applyFilterParam = (patch: Partial<Record<OverviewFilterParamKey, string | undefined>>): void => {
    setScreenParams(patch, { split: isSplit === true })
  }
  // 深链自愈：手工拼写的非法枚举值/未知键（Hash 模型只能拦键形与空值）
  // 在组件边界一次性修正为规范形态（replace，不产生额外历史项）。
  useEffect(() => {
    const repair = overviewFilterParamsRepair(overviewParams)
    if (repair !== null) setScreenParams(repair, { split: isSplit === true })
  }, [overviewParams, isSplit, setScreenParams])

  // 来源判定与侧栏同源（sidebarSection filterTag，零插件 ID 特判）：
  // 插件停用后其 section 贡献消失，卡片自然回到「常规对话」一侧。
  const { sectionTags } = useMemo(
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
        query: queryFilter,
      }),
    [cards, bucketFilter, profileFilter, nodeFilter, sourceFilter, queryFilter],
  )
  const dataReady = conversations.length > 0 || (assetsLoaded && sseConnected)
  const profileOptions = useMemo(() => overviewProfileOptions(cards), [cards])
  const nodeOptions = useMemo(() => overviewNodeOptions(cards), [cards])
  // 来源筛选仅在存在托管卡片（或已选非 all，防困住）时展示：无托管会话时
  // 不添无效控件，保持工具栏零噪音。
  const showSourceFilter = sourceFilter !== 'all' || cards.some((card) => card.managed)
  const anyFilterActive =
    bucketFilter !== 'all' ||
    profileFilter !== '' ||
    nodeFilter !== '' ||
    sourceFilter !== 'all' ||
    queryFilter.trim() !== ''

  // 桶计数在角色/节点/来源/搜索上下文内统计：徽标如实表达「切到该桶后
  // 剩几张卡」，避免全量计数与当前上下文错位造成误解。
  const bucketCounts = useMemo(
    () =>
      overviewBucketCounts(cards, {
        profileId: profileFilter,
        nodeId: nodeFilter,
        source: sourceFilter,
        query: queryFilter,
      }),
    [cards, profileFilter, nodeFilter, sourceFilter, queryFilter],
  )

  // 批量管理口径与侧栏批量模式同界：仅人类自有、未被插件 sidebarSection
  // 接管的根会话可勾选（isConversationArchivable ⇒ 可归档且可删除）；托管
  // 与 bot 会话不参与批量，保护语义与侧栏勾选框一致。
  const isCardSelectable = useMemo(
    () => (conv: ConversationSummary) => isConversationArchivable(conv, sectionTags),
    [sectionTags],
  )
  const selectableCardIds = useMemo(
    () => visibleCards.filter((card) => isCardSelectable(card.root)).map((card) => card.root.id),
    [visibleCards, isCardSelectable],
  )
  // 批量选择边界：选择集合始终收敛为「当前可见且可勾选」卡片的子集——
  // 筛选变化、实时会话变化（归档/被接管/离开总览）后，不可见对象立即
  // 出局，绝不悄悄操作用户看不见的卡片。此处派生有效集合并回写状态，
  // 批量条计数、按钮与执行链路一律消费有效集合。
  const effectiveSelectedIds = useMemo(() => {
    const visible = new Set(selectableCardIds)
    const effective = new Set<number>()
    for (const id of selectedIds) {
      if (visible.has(id)) effective.add(id)
    }
    return effective
  }, [selectedIds, selectableCardIds])
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size !== effectiveSelectedIds.size) return new Set(effectiveSelectedIds)
      for (const id of effectiveSelectedIds) {
        if (!prev.has(id)) return new Set(effectiveSelectedIds)
      }
      return prev
    })
  }, [effectiveSelectedIds])
  const isAllSelected = selectableCardIds.length > 0 && selectableCardIds.length === effectiveSelectedIds.size
  const batchDeleteConfirmOpen = batchDeleteIds !== null &&
    batchDeleteIds.size === effectiveSelectedIds.size &&
    [...batchDeleteIds].every((id) => effectiveSelectedIds.has(id))
  useEffect(() => {
    if (!batchDeleteConfirmOpen) setBatchDeleteIds(null)
  }, [batchDeleteConfirmOpen])

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

  const toggleCardExpanded = (rootConversationId: number): void => {
    setExpandedCardIds((prev) => {
      const next = new Set(prev)
      if (next.has(rootConversationId)) {
        next.delete(rootConversationId)
      } else {
        next.add(rootConversationId)
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
   * （归档根树随即离开总览）。操作集合 = 有效选择集（可见可勾选卡片）。 */
  const executeBatchArchive = async (): Promise<void> => {
    if (effectiveSelectedIds.size === 0 || archiving || deleting) return
    setArchiving(true)
    try {
      const convs = cards.filter((card) => effectiveSelectedIds.has(card.root.id)).map((card) => card.root)
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
    if (!batchDeleteConfirmOpen || batchDeleteIds === null || archiving || deleting) return
    const ids = Array.from(batchDeleteIds)
    setBatchDeleteIds(null)
    setDeleting(true)
    try {
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

  const openConversation = (conversationId: number): void => {
    // 直进语义：与会话列表点击完全一致（总览开在右分屏时进同侧分屏）。
    openTarget({ kind: 'conversation', conversationId }, isSplit ? { split: true } : undefined)
  }

  const drawerPeek = (conversationId: number): void => {
    setActiveModal({ kind: 'conversation-drawer', conversationId })
  }

  const openSplit = (conversationId: number): void => {
    openTarget({ kind: 'conversation', conversationId }, { split: true })
  }

  // 顶栏「新话题」候选：与侧栏站位同源（buildAgentStandings），仅人类可选
  // 且可见的角色可开新聊；最近活跃根会话所属角色置顶，其余按站位序。
  const newTopicCandidates = useMemo(() => {
    const standings = buildAgentStandings({
      profiles,
      conversations,
      plugins,
      sidebarItems: groupedUi.sidebarItems,
      sidebarSections: groupedUi.sidebarSections,
      locale,
    })
    const creatable = standings.filter((standing) => standing.canCreateConversation)
    const latestRootProfileId =
      conversations
        .filter((c) => c.parentConversationId === undefined && !isConversationArchived(c))
        .reduce<ConversationSummary | null>(
          (best, c) =>
            best === null || c.updatedAt > best.updatedAt || (c.updatedAt === best.updatedAt && c.id > best.id)
              ? c
              : best,
          null,
        )?.profileId ?? null
    return [...creatable].sort((a, b) => {
      if (a.profileId === latestRootProfileId) return -1
      if (b.profileId === latestRootProfileId) return 1
      return a.order - b.order || a.profileId.localeCompare(b.profileId)
    })
  }, [profiles, conversations, plugins, groupedUi.sidebarItems, groupedUi.sidebarSections, locale])

  const openNewTopic = (profileId: string): void => {
    openTarget({ kind: 'agent', profileId }, isSplit ? { split: true } : undefined)
  }

  // 单候选直进按钮的稳定绑定（闭包内索引访问会丢失窄化，这里一次性收敛）。
  const singleNewTopicCandidate: AgentStanding | null =
    newTopicCandidates.length === 1 ? (newTopicCandidates[0] ?? null) : null

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
            {anyFilterActive
              ? t('shell.overview.statsFiltered', { count: visibleCards.length, total: cards.length })
              : t('shell.overview.stats', { count: visibleCards.length })}
          </span>
        </div>
        <div className="primary-center-topbar-actions pane-actions">
          {singleNewTopicCandidate !== null && (
            <button
              type="button"
              className="btn btn-sm overview-newtopic-btn"
              aria-label={t('conv.pane.newTopic')}
              title={t('shell.agents.newTopicUnder', { label: singleNewTopicCandidate.label })}
              onClick={() => {
                openNewTopic(singleNewTopicCandidate.profileId)
              }}
            >
              <HelmxIcon name="plus" size={12} />
              <span className="pane-action-label">{t('conv.pane.newTopic')}</span>
            </button>
          )}
          {newTopicCandidates.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="btn btn-sm overview-newtopic-btn"
                  aria-label={t('conv.pane.newTopic')}
                  title={t('conv.pane.newTopicTitle')}
                  aria-haspopup="menu"
                >
                  <HelmxIcon name="plus" size={12} />
                  <span className="pane-action-label">{t('conv.pane.newTopic')}</span>
                  <HelmxIcon name="chevron-down" size={11} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent className="pane-more-popover" align="end" sideOffset={4}>
                  {newTopicCandidates.map((standing) => {
                    const nodeId = standing.primaryConversation?.nodeId
                    const remoteNodeId = nodeId !== undefined && nodeId !== '' && nodeId !== 'local' ? nodeId : null
                    return (
                      <DropdownMenuItem
                        key={standing.profileId}
                        title={t('shell.agents.newTopicUnder', { label: standing.label })}
                        onSelect={() => {
                          openNewTopic(standing.profileId)
                        }}
                      >
                        <span className="pane-more-item-label">
                          <HelmxIcon name="bot" size={13} />
                          {standing.label}
                          {remoteNodeId !== null && <RemoteNodeTag nodeId={remoteNodeId} />}
                        </span>
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
          )}
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
          onValueChange={(value) => applyFilterParam({ bucket: value === 'all' ? undefined : value })}
          aria-label={t('shell.overview.title')}
          items={[
            { value: 'all', label: t('shell.overview.filterAll'), badge: <span className="tabular-nums">{bucketCounts.all}</span> },
            { value: 'needs_attention', label: t('shell.overview.filterNeeds'), badge: <span className="tabular-nums">{bucketCounts.needs_attention}</span> },
            { value: 'running', label: t('shell.overview.filterRunning'), badge: <span className="tabular-nums">{bucketCounts.running}</span> },
            { value: 'unread_done', label: t('shell.overview.filterUnread'), badge: <span className="tabular-nums">{bucketCounts.unread_done}</span> },
          ]}
        />
        <div className="overview-filter-selects">
          <div className="search-box overview-search-box">
            <HelmxIcon name="search" size={13} />
            <input
              type="text"
              value={queryFilter}
              placeholder={t('shell.overview.searchPlaceholder')}
              aria-label={t('shell.overview.searchLabel')}
              onChange={(event) =>
                applyFilterParam({ q: event.target.value.trim() === '' ? undefined : event.target.value })
              }
            />
            {queryFilter !== '' && (
              <button
                type="button"
                className="btn btn-ghost btn-icon-xs overview-search-clear"
                title={t('shell.overview.clearSearch')}
                aria-label={t('shell.overview.clearSearch')}
                onClick={() => applyFilterParam({ q: undefined })}
              >
                <HelmxIcon name="x" size={12} />
              </button>
            )}
          </div>
          <Select
            className="overview-filter-select"
            aria-label={t('shell.overview.profileFilterLabel')}
            options={[
              { value: '', label: t('shell.overview.profileFilter') },
              ...profileOptions.map((option) => ({ value: option.id, label: option.label })),
            ]}
            value={profileFilter}
            onChange={(event) => applyFilterParam({ profile: event.target.value === '' ? undefined : event.target.value })}
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
            onChange={(event) => applyFilterParam({ node: event.target.value === '' ? undefined : event.target.value })}
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
              onChange={(event) =>
                applyFilterParam({
                  source: event.target.value === 'all' ? undefined : (event.target.value as SourceFilterValue),
                })
              }
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
            {t('shell.batch.selected', { count: effectiveSelectedIds.size })}
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
              disabled={effectiveSelectedIds.size === 0 || deleting || archiving}
              onClick={() => {
                void executeBatchArchive()
              }}
            >
              {archiving ? t('shell.agents.archiving') : t('shell.agents.archiveCount', { count: effectiveSelectedIds.size })}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger-sm"
              disabled={effectiveSelectedIds.size === 0 || deleting || archiving}
              onClick={() => setBatchDeleteIds(effectiveSelectedIds)}
            >
              {deleting ? t('shell.batch.deleting') : t('shell.batch.deleteCount', { count: effectiveSelectedIds.size })}
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
          cards.length === 0 ? (
            <div className="overview-empty">{t('shell.overview.emptySystem')}</div>
          ) : (
            <div className="overview-empty">
              <span>{t('shell.overview.emptyFiltered')}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm overview-clear-filters"
                onClick={() =>
                  applyFilterParam({ bucket: undefined, profile: undefined, node: undefined, source: undefined, q: undefined })
                }
              >
                {t('shell.overview.clearFilters')}
              </button>
            </div>
          )
        ) : (
          visibleCards.map((card) => (
            <OverviewCardView
              key={card.root.id}
              card={card}
              onOpenConversation={openConversation}
              onDrawerPeek={drawerPeek}
              onOpenSplit={openSplit}
              viewedConversationIds={viewedConversationIds}
              batchMode={batchMode}
              selectable={isCardSelectable(card.root)}
              selected={effectiveSelectedIds.has(card.root.id)}
              expanded={expandedCardIds.has(card.root.id)}
              onToggleSelect={toggleCardSelect}
              onToggleExpanded={toggleCardExpanded}
            />
          ))
        )}
      </div>

      <ConfirmDialog
        open={batchDeleteConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setBatchDeleteIds(null)
        }}
        title={t('shell.batch.deleteConfirmTitle', { count: effectiveSelectedIds.size })}
        description={t('shell.batch.deleteConfirmDesc')}
        confirmText={t('shell.batch.deleteConfirmButton')}
        danger
        onConfirm={() => {
          void executeBatchDelete()
        }}
        onCancel={() => setBatchDeleteIds(null)}
      />
    </div>
  )
}
