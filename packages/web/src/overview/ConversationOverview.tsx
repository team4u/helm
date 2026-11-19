/**
 * 会话总览（只读宿主视图，对话空间主舞台 `#/overview`）：
 *
 * - 复用态势模型的唯一树聚合口径：一张卡片 = 一棵根会话树（含安静树），
 *   卡面只呈现真实事实（代表位灯、lastError / doing / 后台摘要 / 后代运行
 *   计数），绝不编造进度；
 * - 筛选：全部 / 需处理 / 进行中 / 未读（SegmentedControl）+ 角色 / 节点
 *  （SDK Select）；排序桶序 + createdAt 倒序，流式输出不跳卡；
 * - 打开真实会话：卡面点击直达 targetConversationId（树内有等待人类的会话
 *   时直达最新审批现场），后代会话芯片逐个直达——统一复用既有会话抽屉
 *   （conversation-drawer 模态，进 URL、浏览器返回即收起），人在总览不离场；
 * - 审批仍走 AskDoc、后台通知仍走浏览器通知旧链路——本视图是态势的只读
 *   总览，不是新的通知收件箱；
 * - 移动端主舞台自适应：筛选折行、卡片网格单列化（responsive 断点）。
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { HelmxIcon, SegmentedControl, Select } from '@helmx/plugin-client'
import {
  useAuthConnection,
  useConversations,
  useLocationTargets,
  usePlugins,
  useProfilesSlice,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { ConversationStatusDot } from '../shell/SidebarPrimitives.js'
import { useGlobalAttention } from '../shell/use-attention-indicator.js'
import {
  buildOverviewCards,
  filterOverviewCards,
  overviewNodeOptions,
  overviewProfileOptions,
  type OverviewBucketFilter,
  type OverviewCard,
} from './overview-model.js'

export interface ConversationOverviewProps {
  isSplit?: boolean
  onCloseSplit?: () => void
}

type BucketFilterValue = OverviewBucketFilter

/** 单卡：根会话树聚合卡（只读）；卡面直达 target，芯片逐后代直达。 */
function OverviewCardView({
  card,
  onOpenConversation,
}: {
  card: OverviewCard
  onOpenConversation: (conversationId: number) => void
}): ReactNode {
  const { t } = useWebLocale()
  const subParts = card.profileLabel === '' ? [] : [card.profileLabel]
  if (card.summaryText !== '') subParts.push(card.summaryText)
  return (
    <div
      className={`overview-card overview-card-${card.bucket}`}
      onClick={() => onOpenConversation(card.targetConversationId)}
      title={t('shell.attention.openConversation', { id: card.targetConversationId })}
    >
      <div className="overview-card-head">
        <span className="nav-status-slot">
          <ConversationStatusDot
            conv={card.representative}
            background={{ active: card.backgroundActive, summary: card.backgroundSummary }}
          />
        </span>
        <span className="overview-card-title">
          {card.root.title || t('shell.conversationFallback', { id: card.root.id })}
        </span>
        <span className="overview-card-id tabular-nums">#{card.root.id}</span>
      </div>
      {subParts.length > 0 && <div className="overview-card-sub">{subParts.join(' · ')}</div>}
      {card.root.nodeId !== undefined && card.root.nodeId !== 'local' && (
        <div className="overview-card-node mono" title={t('shell.node.title', { id: card.root.nodeId })}>
          @{card.root.nodeId}
        </div>
      )}
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
                onOpenConversation(descendant.conv.id)
              }}
            >
              <ConversationStatusDot
                conv={descendant.conv}
                background={descendant.backgroundActive ? { active: true, summary: '' } : undefined}
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
  const { t } = useWebLocale()
  const { openTarget, closeSplit, setActiveModal } = useStoreActions()
  const { background } = useGlobalAttention()
  const conversations = useConversations()
  const plugins = usePlugins()
  const { profiles } = useProfilesSlice()
  const { splitTarget } = useLocationTargets()
  const { sseConnected } = useAuthConnection()
  const { assetsLoaded } = useProfilesSlice()
  const [bucketFilter, setBucketFilter] = useState<BucketFilterValue>('all')
  const [profileFilter, setProfileFilter] = useState('')
  const [nodeFilter, setNodeFilter] = useState('')

  const cards = useMemo(
    () => buildOverviewCards({ conversations, background, profiles, plugins, t }),
    [conversations, background, profiles, plugins, t],
  )
  const visibleCards = useMemo(
    () => filterOverviewCards(cards, { bucket: bucketFilter, profileId: profileFilter, nodeId: nodeFilter }),
    [cards, bucketFilter, profileFilter, nodeFilter],
  )
  const dataReady = conversations.length > 0 || (assetsLoaded && sseConnected)
  const profileOptions = useMemo(() => overviewProfileOptions(cards), [cards])
  const nodeOptions = useMemo(() => overviewNodeOptions(cards), [cards])

  const bucketCounts = useMemo(() => {
    const counts = { all: cards.length, needs_attention: 0, running: 0, unread_done: 0 }
    for (const card of cards) {
      if (card.bucket !== 'quiet') counts[card.bucket] += 1
    }
    return counts
  }, [cards])

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
            size="sm"
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
            size="sm"
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
        </div>
      </div>

      <div className="overview-grid">
        {dataReady === false ? (
          <div className="overview-empty overview-loading" role="status">{t('shell.overview.loading')}</div>
        ) : visibleCards.length === 0 ? (
          <div className="overview-empty">{t('shell.overview.empty')}</div>
        ) : (
          visibleCards.map((card) => (
            <OverviewCardView key={card.root.id} card={card} onOpenConversation={openConversationDrawer} />
          ))
        )}
      </div>
    </div>
  )
}
