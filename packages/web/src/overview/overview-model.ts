/**
 * 会话总览纯函数层（零 React / DOM 依赖，可直接单测）。
 *
 * 复用态势模型的唯一树聚合口径（aggregateAttentionTrees：根树聚合、暴露
 * 边界、代表位、直达目标、后台聚合），在其上扩展「全部」视图需要的安静树，
 * 并提供 全部/需处理/进行中/未读 与 角色/节点 筛选。排序纪律与态势一致：
 * 桶序（需关注 > 运行中 > 未读完成 > 安静）内按 root.createdAt 倒序
 * （同刻 id 倒序），绝不用 updatedAt 防流式跳卡。只读视图：本层不产生任何
 * 副作用与编造事实，摘要复用 composeHonestTreeSummary。
 *
 * 灯位口径（与侧栏会话行通用统一）：卡面灯 = 根会话自身状态 + 树级后台
 * 在途聚合，经同一 resolveStatusLight 单灯裁决——representative 仅用于
 * 诚实摘要与桶位推导，绝不充当卡面灯位（防「侧栏空心蓝、总览无灯」的
 * 代表位/行语义分叉）。
 */

import type { ConversationSummary, Profile } from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import type { ConversationBackgroundIndex } from '../shell/background-activity-model.js'
import {
  aggregateAttentionTrees,
  composeHonestTreeSummary,
  type AttentionBucket,
} from '../shell/attention-model.js'
import { ARCHIVED_TAG } from '../shell/sidebar-model.js'

/** 总览卡片桶：态势三桶 + 安静（无任何信号的树，仅出现在「全部」筛选）。 */
export type OverviewCardBucket = AttentionBucket | 'quiet'

/** 总览桶筛选值。 */
export type OverviewBucketFilter = 'all' | AttentionBucket

/** 总览来源筛选值：全部 / 常规对话 / 托管会话（托管 = 插件 sidebarSection 接管）。 */
export type OverviewSourceFilter = 'all' | 'regular' | 'managed'

const CARD_BUCKET_ORDER: Record<OverviewCardBucket, number> = {
  needs_attention: 0,
  running: 1,
  unread_done: 2,
  quiet: 3,
}

/** 总览单卡：一棵根会话树的真实事实（只读展示）。 */
export interface OverviewCard {
  root: ConversationSummary
  bucket: OverviewCardBucket
  /** 树内最高优先级状态代表（灯位来源）。 */
  representative: ConversationSummary
  backgroundActive: boolean
  backgroundSummary: string
  activeDescendantCount: number
  /** 点击直达目标（等待人类的最新会话，否则根）。 */
  targetConversationId: number
  profileLabel: string
  /** 诚实摘要（真实 lastError / doing / 后台摘要 / 后代运行计数）。 */
  summaryText: string
  /** 根会话已被插件 sidebarSection filterTag 接管（托管 / 后台 Worker 等）。 */
  managed: boolean
  /** 整棵子树成员 ID（含根；OVERVIEW_CARD_META_SLOT 插槽 props 输入）。 */
  memberIds: number[]
  /** 卡内后代会话芯片（按关注优先 + createdAt 倒序截断；空树为空数组）。 */
  descendants: OverviewDescendant[]
  /** 被截断未展示的后代数。 */
  hiddenDescendantCount: number
}

/** 卡内后代会话芯片条目。 */
export interface OverviewDescendant {
  conv: ConversationSummary
  backgroundActive: boolean
}

/** 卡内后代芯片默认上限（超出折叠为「还有 N 个」）。 */
export const OVERVIEW_DESCENDANT_LIMIT = 5

/**
 * 构建总览卡片（全部根树，含安静树）：排序为桶序 + root.createdAt 倒序。
 * 后代芯片排序：有信号的（working/blocked/error/后台在途）优先，其后按
 * createdAt 倒序；截断后如实给出 hiddenDescendantCount。
 * sectionTags（插件 sidebarSection filterTag 集合，与侧栏同源）存在时，
 * 根会话带任一非归档命中标签的树归为 managed（托管会话）。
 */
export function buildOverviewCards(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
  profiles: ReadonlyArray<Profile>
  plugins: ReadonlyArray<{ id: string; enabled: boolean }>
  /** Locale translator（摘要与后代计数文案）；缺省英文桥接。 */
  t?: WebMessageTranslator
  /** 插件 sidebarSection filterTag 集合（缺省时全部树视为常规会话）。 */
  sectionTags?: ReadonlySet<string>
}): OverviewCard[] {
  const t = input.t ?? englishWebTranslator
  const sectionTags = input.sectionTags
  const profileNames = new Map(input.profiles.map((profile) => [profile.id, profile.name] as const))
  const cards: OverviewCard[] = []
  for (const aggregate of aggregateAttentionTrees(input)) {
    const descendantsAll = aggregate.members
      .filter((member) => member.id !== aggregate.root.id)
      .map((member) => ({
        member,
        signal:
          member.status === 'working' ||
          member.status === 'blocked' ||
          member.status === 'error' ||
          input.background.get(member.id)?.active === true ||
          member.pendingAskCount > 0,
      }))
      .sort((a, b) => {
        if (a.signal !== b.signal) return a.signal ? -1 : 1
        return b.member.createdAt - a.member.createdAt || b.member.id - a.member.id
      })
    const visible = descendantsAll.slice(0, OVERVIEW_DESCENDANT_LIMIT)
    cards.push({
      root: aggregate.root,
      bucket: aggregate.bucket ?? 'quiet',
      representative: aggregate.representative,
      backgroundActive: aggregate.backgroundActive,
      backgroundSummary: aggregate.backgroundSummary,
      activeDescendantCount: aggregate.activeDescendantCount,
      targetConversationId: aggregate.targetConversationId,
      profileLabel: profileNames.get(aggregate.root.profileId) ?? aggregate.root.profileId,
      summaryText: composeHonestTreeSummary({
        representative: aggregate.representative,
        backgroundActive: aggregate.backgroundActive,
        backgroundSummary: aggregate.backgroundSummary,
        activeDescendantCount: aggregate.activeDescendantCount,
        t,
      }),
      managed: sectionTags !== undefined && aggregate.root.tags.some((tag) => tag !== ARCHIVED_TAG && sectionTags.has(tag)),
      memberIds: aggregate.members.map((member) => member.id),
      descendants: visible.map((entry) => ({
        conv: entry.member,
        backgroundActive: input.background.get(entry.member.id)?.active === true,
      })),
      hiddenDescendantCount: descendantsAll.length - visible.length,
    })
  }
  return cards.sort(
    (a, b) =>
      CARD_BUCKET_ORDER[a.bucket] - CARD_BUCKET_ORDER[b.bucket] ||
      b.root.createdAt - a.root.createdAt ||
      b.root.id - a.root.id,
  )
}

/** 总览筛选条件（空串表示不过滤）。 */
export interface OverviewCardFilter {
  bucket: OverviewBucketFilter
  profileId: string
  /** 节点筛选值；'local' 聚合未标注 nodeId 的本机会话。 */
  nodeId: string
  /** 来源筛选（缺省 'all' 不过滤；与桶/角色/节点 AND 组合）。 */
  source?: OverviewSourceFilter
}

/** 会话的节点筛选键（缺省本机）。 */
export function overviewNodeKey(conv: Pick<ConversationSummary, 'nodeId'>): string {
  return conv.nodeId === undefined || conv.nodeId === '' ? 'local' : conv.nodeId
}

/**
 * 筛选总览卡片：桶（quiet 仅在 all）、角色、节点、来源四者 AND 组合；
 * 空串筛选值表示该维度不过滤，source 缺省 'all' 不过滤。纯函数，供组件与测试共用。
 */
export function filterOverviewCards(
  cards: ReadonlyArray<OverviewCard>,
  filter: OverviewCardFilter,
): OverviewCard[] {
  return cards.filter((card) => {
    if (filter.bucket !== 'all' && card.bucket !== filter.bucket) return false
    if (filter.profileId !== '' && card.root.profileId !== filter.profileId) return false
    if (filter.nodeId !== '' && overviewNodeKey(card.root) !== filter.nodeId) return false
    if (filter.source === 'regular' && card.managed) return false
    if (filter.source === 'managed' && !card.managed) return false
    return true
  })
}

/** 从卡片集提取可用角色筛选选项（去重，按卡片出现顺序）。 */
export function overviewProfileOptions(
  cards: ReadonlyArray<OverviewCard>,
): Array<{ id: string; label: string }> {
  const seen = new Set<string>()
  const options: Array<{ id: string; label: string }> = []
  for (const card of cards) {
    if (seen.has(card.root.profileId)) continue
    seen.add(card.root.profileId)
    options.push({ id: card.root.profileId, label: card.profileLabel })
  }
  return options
}

/** 从卡片集提取可用节点筛选选项（去重，'local' 归一化聚合）。 */
export function overviewNodeOptions(cards: ReadonlyArray<OverviewCard>): string[] {
  const seen = new Set<string>()
  for (const card of cards) seen.add(overviewNodeKey(card.root))
  return [...seen]
}
