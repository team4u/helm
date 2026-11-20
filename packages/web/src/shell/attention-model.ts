/**
 * 全局并发态势纯函数层（零 React / DOM 依赖，可直接单测）。
 *
 * 口径严格同源自既有模型，绝不重复实现判定：
 * - 根会话树聚合复用 quiet-notify-model 的 resolveNotificationRootId（沿
 *   parentConversationId 上溯到最高存活祖先，防御环与脏深度）；
 * - 后台在途复用 background-activity-model 的 ConversationBackgroundIndex
 *   （workbench badge tone=accent + 上下文精简），以及
 *   resolveStandingStatusIndicator 的代表位裁决（error > blocked > working >
 *   done > idle，平手保留列表头）与后台摘要合并；
 * - 暴露边界复用 sidebar-model 的 isConversationArchived /
 *   collectEnabledPluginIds / isProfileVisible：已归档根会话、已停用插件托管
 *   Profile 的会话不进态势；被 sidebarSection 接管的活跃会话（托管 / 后台
 *   Worker 等）依然纳入——并发在跑的工作无论挂在哪个空间都不允许失明。
 *
 * 诚实性：摘要只呈现真实 lastError / doing / backgroundSummary / 后代运行
 * 计数，绝不编造进度百分比；tone 只是既有五态事实的聚合灯色。逐树明细的
 * 展示形态是会话总览（overview-model 消费 aggregateAttentionTrees），侧栏
 * 只保留总览入口的脉冲灯点与真实摘要。
 */

import type { ConversationSummary, Profile } from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import type { ActiveModal, ResolvedTarget } from '../lib/types.js'
import {
  resolveStandingStatusIndicator,
  type ConversationBackgroundIndex,
} from './background-activity-model.js'
import { resolveNotificationRootId } from './quiet-notify-model.js'
import { collectEnabledPluginIds, isConversationArchived, isProfileVisible } from './sidebar-model.js'

/** 态势三桶：需关注 > 运行中 > 未读完成。 */
export type AttentionBucket = 'needs_attention' | 'running' | 'unread_done'

/** 全局态势灯色（聚合优先级 error > blocked > running > done；null = 无事发生）。 */
export type GlobalAttentionTone = 'error' | 'blocked' | 'running' | 'done' | null

/** 会话是否处于「等待人类」状态（blocked 或有待答 Ask）。 */
function isWaitingForHuman(conv: Pick<ConversationSummary, 'status' | 'pendingAskCount'>): boolean {
  return conv.status === 'blocked' || conv.pendingAskCount > 0
}

/** 会话是否机器活跃（working 或后台在途）。 */
function isMachineActive(
  conv: Pick<ConversationSummary, 'id' | 'status'>,
  background: ConversationBackgroundIndex,
): boolean {
  return conv.status === 'working' || background.get(conv.id)?.active === true
}

/** 全局态势微标（移动端汉堡 / 桌面折叠 Rail / 侧栏总览入口消费；排除正在查看的根树）。 */
export interface GlobalAttentionIndicator {
  /** 需关注树数（error 或等待人类）。 */
  needsAttentionCount: number
  /** 运行中树数（working 或后台在途）。 */
  runningCount: number
  /** 未读完成树数（根 done 且 unread）。 */
  unreadDoneCount: number
  /** 参与计数的树总数。 */
  totalCount: number
  /** 聚合灯色（error > blocked > running > done；无信号为 null）。 */
  tone: GlobalAttentionTone
}

/** 根树聚合中间产物：态势平铺条目与会话总览共用的单树事实（含未落入三桶的安静树）。 */
export interface AttentionTreeAggregate {
  /** 根会话（树的锚点）。 */
  root: ConversationSummary
  /** 整棵子树成员（含根；输入顺序）。 */
  members: ConversationSummary[]
  hasError: boolean
  hasWaiting: boolean
  hasMachineActive: boolean
  /** 三桶归属；无任何信号（安静树）为 null。 */
  bucket: AttentionBucket | null
  /** 树内最高优先级状态代表（error > blocked > working > done > idle）。 */
  representative: ConversationSummary
  /** 树内任一会话后台在途（badge accent / 上下文精简）。 */
  backgroundActive: boolean
  /** 树内后台摘要（去重后以「 · 」连接，可为空串）。 */
  backgroundSummary: string
  /** 子树中除根外正在 working/blocked 或后台在途的后代会话数。 */
  activeDescendantCount: number
  /** 点击直达目标：树内有等待人类的会话时指向最新一条（直达审批现场），否则根会话。 */
  targetConversationId: number
}

/**
 * 按根会话树聚合全量事实（态势与总览共享的唯一聚合口径）：
 * - 沿 resolveNotificationRootId 上溯归树；根按 createdAt 倒序（同刻 id 倒序）；
 * - 暴露边界：已归档根树、根会话 Profile 被已停用插件托管的树不产出；
 *   sidebarSection 接管的会话照常纳入；
 * - 安静树（bucket === null）也产出——总览「全部」筛选需要。
 */
export function aggregateAttentionTrees(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
  profiles: ReadonlyArray<Profile>
  plugins: ReadonlyArray<{ id: string; enabled: boolean }>
}): AttentionTreeAggregate[] {
  const byId = new Map<number, ConversationSummary>(
    input.conversations.map((conversation) => [conversation.id, conversation] as const),
  )
  const enabledPluginIds = collectEnabledPluginIds(input.plugins)

  const trees = new Map<number, ConversationSummary[]>()
  for (const conversation of input.conversations) {
    const rootId = resolveNotificationRootId(byId, conversation.id)
    const members = trees.get(rootId)
    if (members) members.push(conversation)
    else trees.set(rootId, [conversation])
  }
  const rootIds = [...trees.keys()].sort((a, b) => {
    const rootA = byId.get(a)!
    const rootB = byId.get(b)!
    return rootB.createdAt - rootA.createdAt || rootB.id - rootA.id
  })

  const aggregates: AttentionTreeAggregate[] = []
  for (const rootId of rootIds) {
    const root = byId.get(rootId)
    const members = trees.get(rootId)
    if (root === undefined || members === undefined) continue
    if (isConversationArchived(root)) continue
    const rootProfile = input.profiles.find((profile) => profile.id === root.profileId)
    if (rootProfile !== undefined && !isProfileVisible(rootProfile, enabledPluginIds)) continue

    let hasError = false
    let hasWaiting = false
    let hasMachineActive = false
    let activeDescendantCount = 0
    for (const member of members) {
      if (member.status === 'error') hasError = true
      if (isWaitingForHuman(member)) hasWaiting = true
      if (isMachineActive(member, input.background)) hasMachineActive = true
      if (member.id !== root.id && (member.status === 'working' || member.status === 'blocked' || input.background.get(member.id)?.active === true)) {
        activeDescendantCount += 1
      }
    }
    const bucket: AttentionBucket | null = hasError || hasWaiting
      ? 'needs_attention'
      : hasMachineActive
        ? 'running'
        : root.status === 'done' && root.unread === true
          ? 'unread_done'
          : null

    // 代表位与后台聚合：成员按 updatedAt 倒序传入，平手保留最近更新者（确定性）。
    const membersByRecency = [...members].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
    const standing = resolveStandingStatusIndicator(membersByRecency, input.background)
    if (standing === null) continue

    // 直达目标：树内有等待人类的会话时指向最新一条（updatedAt 倒序，同刻 id 倒序）。
    let targetConversationId = root.id
    for (const member of members) {
      if (!isWaitingForHuman(member)) continue
      const current = byId.get(targetConversationId)
      const currentIsWaiting = current !== undefined && isWaitingForHuman(current)
      if (
        !currentIsWaiting ||
        member.updatedAt > current!.updatedAt ||
        (member.updatedAt === current!.updatedAt && member.id > current!.id)
      ) {
        targetConversationId = member.id
      }
    }

    aggregates.push({
      root,
      members,
      hasError,
      hasWaiting,
      hasMachineActive,
      bucket,
      representative: standing.representative,
      backgroundActive: standing.backgroundActive,
      backgroundSummary: standing.backgroundSummary,
      activeDescendantCount,
      targetConversationId,
    })
  }
  return aggregates
}

/**
 * 构建全局态势微标（汉堡/Rail/侧栏总览入口的同源 indicator）：
 * - 聚合口径见 aggregateAttentionTrees（树成员、桶归属）；
 * - 按「成员级排除」重算：只剔除当前主屏/分屏正在查看的那一个会话的信号
 *   ——同根其他后代的 Ask / 运行事实绝不被正在查看的面板抹掉；整棵树的
 *   信号都落在被查看会话上时该树才退出计数。
 */
export function buildAttentionModel(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
  profiles: ReadonlyArray<Profile>
  plugins: ReadonlyArray<{ id: string; enabled: boolean }>
  /** 当前主屏/分屏正在查看的会话 ID（成员级排除；缺省不排除任何信号）。 */
  viewedConversationIds?: ReadonlySet<number>
  /** Locale translator（后代运行计数文案）；缺省英文桥接。 */
  t?: WebMessageTranslator
}): GlobalAttentionIndicator {
  const viewed = input.viewedConversationIds ?? EMPTY_VIEWED

  let needsAttentionCount = 0
  let runningCount = 0
  let unreadDoneCount = 0
  let totalCount = 0
  let toneRank = 0
  let tone: GlobalAttentionTone = null
  for (const aggregate of aggregateAttentionTrees(input)) {
    const { root, members } = aggregate

    // 微标成员级排除：剔除正在查看的会话信号后重算桶（同根其他后代的
    // Ask/运行事实保留；整树信号都在被查看会话上才退出计数）。
    let viewedHasError = false
    let viewedHasWaiting = false
    let viewedHasMachineActive = false
    for (const member of members) {
      if (viewed.has(member.id)) continue
      if (member.status === 'error') viewedHasError = true
      if (isWaitingForHuman(member)) viewedHasWaiting = true
      if (isMachineActive(member, input.background)) viewedHasMachineActive = true
    }
    const indicatorBucket: AttentionBucket | null = viewedHasError || viewedHasWaiting
      ? 'needs_attention'
      : viewedHasMachineActive
        ? 'running'
        : !viewed.has(root.id) && root.status === 'done' && root.unread === true
          ? 'unread_done'
          : null

    if (indicatorBucket === null) continue

    totalCount += 1
    if (indicatorBucket === 'needs_attention') needsAttentionCount += 1
    else if (indicatorBucket === 'running') runningCount += 1
    else unreadDoneCount += 1
    const indicatorTone: Exclude<GlobalAttentionTone, null> =
      indicatorBucket === 'needs_attention' ? (viewedHasError ? 'error' : 'blocked') : indicatorBucket === 'running' ? 'running' : 'done'
    if (TONE_RANK[indicatorTone] > toneRank) {
      toneRank = TONE_RANK[indicatorTone]
      tone = indicatorTone
    }
  }

  return { needsAttentionCount, runningCount, unreadDoneCount, totalCount, tone }
}

/**
 * 诚实树摘要（态势行与总览卡片共用）：只呈现真实事实，优先级
 * error 诊断 > working 动作 > 后台摘要 > 后代运行计数；绝不编造进度。
 */
export function composeHonestTreeSummary(input: {
  representative: ConversationSummary
  backgroundActive: boolean
  backgroundSummary: string
  activeDescendantCount: number
  t?: WebMessageTranslator
}): string {
  const t = input.t ?? englishWebTranslator
  const representative = input.representative
  if (representative.status === 'error' && representative.lastError?.trim()) {
    return representative.lastError.trim()
  }
  if (representative.status === 'working' && representative.doing?.trim()) {
    return representative.doing.trim()
  }
  if (input.backgroundActive && input.backgroundSummary.trim()) {
    return input.backgroundSummary.trim()
  }
  if (input.activeDescendantCount > 0) {
    return t('shell.attention.descendantsActive', { count: input.activeDescendantCount })
  }
  return ''
}

/**
 * 全量聚合微标的输入条目：一棵树的桶归属与聚合灯色（不绑定展示形态）。
 */
export interface AttentionIndicatorEntry {
  bucket: AttentionBucket
  tone: Exclude<GlobalAttentionTone, null>
}

/**
 * 收集当前主屏/分屏正在查看的会话 ID（微标成员级排除的输入——精确到会话，
 * 不上卷整棵根树：同根其他后代的 Ask / 运行事实不允许被正在查看的面板抹掉）。
 */
export function collectViewedConversationIds(input: {
  primaryTarget: ResolvedTarget | null
  splitTarget: ResolvedTarget | null
  activeModal?: ActiveModal
}): Set<number> {
  const viewed = new Set<number>()
  for (const target of [input.primaryTarget, input.splitTarget]) {
    if (target?.kind === 'conversation') viewed.add(target.conversationId)
  }
  const modal = input.activeModal
  if (modal?.kind === 'conversation-drawer' || modal?.kind === 'artifact-preview' || modal?.kind === 'workspace-file') {
    if (modal.conversationId !== undefined) viewed.add(modal.conversationId)
  }
  return viewed
}

const TONE_RANK: Record<Exclude<GlobalAttentionTone, null>, number> = {
  error: 4,
  blocked: 3,
  running: 2,
  done: 1,
}

const EMPTY_VIEWED: ReadonlySet<number> = new Set()

/**
 * 全量聚合微标（不做任何排除）：按桶计数，tone 取最高优先级
 * （error > blocked > running > done）；无任何信号时 tone 为 null。
 * 供无「正在查看」概念的调用方使用；带排除语义的微标走 buildAttentionModel。
 */
export function resolveGlobalAttentionIndicator(
  items: ReadonlyArray<AttentionIndicatorEntry>,
): GlobalAttentionIndicator {
  let needsAttentionCount = 0
  let runningCount = 0
  let unreadDoneCount = 0
  let totalCount = 0
  let toneRank = 0
  let tone: GlobalAttentionTone = null
  for (const item of items) {
    totalCount += 1
    if (item.bucket === 'needs_attention') needsAttentionCount += 1
    else if (item.bucket === 'running') runningCount += 1
    else unreadDoneCount += 1
    if (TONE_RANK[item.tone] > toneRank) {
      toneRank = TONE_RANK[item.tone]
      tone = item.tone
    }
  }
  return { needsAttentionCount, runningCount, unreadDoneCount, totalCount, tone }
}

/**
 * 态势可读摘要（汉堡/Rail 的 aria-label / title 附加段）：只列出非零桶，
 * 以「 · 」连接；无信号返回空串（调用方据此不加后缀）。
 */
export function composeAttentionSummary(
  indicator: GlobalAttentionIndicator,
  t: WebMessageTranslator = englishWebTranslator,
): string {
  const parts: string[] = []
  if (indicator.needsAttentionCount > 0) {
    parts.push(t('shell.attention.needsCount', { count: indicator.needsAttentionCount }))
  }
  if (indicator.runningCount > 0) {
    parts.push(t('shell.attention.runningCount', { count: indicator.runningCount }))
  }
  if (indicator.unreadDoneCount > 0) {
    parts.push(t('shell.attention.unreadCount', { count: indicator.unreadDoneCount }))
  }
  return parts.join(' · ')
}
