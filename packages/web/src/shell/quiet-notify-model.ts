/**
 * 按根会话树独立结算的后台浏览器通知纯函数层（零 React/DOM 依赖，单测直测）。
 *
 * 数据源与侧栏后台在途环同一契约，不重复实现任何判定：
 * - 会话五态：working 表示主回合机器在途；blocked 表示等待人类输入/审批——
 *   这是「等待你」，不是机器活动；
 * - 后台在途：summarizeConversationBackgroundActivity 的按会话索引
 *   （workbench 面板角标 tone = 'accent'，如 builtin:workflow 运行中的后台
 *   子代理与 DSL run，以及会话 contextUsage.compacting = true 上下文精简），
 *   插件停用后对应面板贡献与 doc 自然归零；
 * - badge doc 未知：启用面板所需的按会话角标 doc 尚未首次加载时，全局后台在途
 *   事实不可知——badgeUnknown = true，阻止任何根会话树结算「已完成」
 *   （blocked 通知不受此未知门控阻滞，独立及时提醒）。
 *
 * 按根会话树独立结算：
 * - 每个活跃/blocked 会话沿 parentConversationId 归并到当前存活的最高祖先
 *   根会话 rootId（单轨模型，不做 ownedBy 过滤、不硬编码角色名）；
 * - 各根会话树彼此隔离：树 A 仍在运行不阻塞树 B 结算完成通知，也不阻塞树 B
 *   或树 A 自身内的 blocked 立即通知；
 * - 完成通知如实区分成败：累计参与者无 error → 「Helm 会话已完成」（#id 标题），
 *   任一参与者为 error → 「Helm 会话已结束」（#id 标题 · 有失败）；
 * - 等待处理通知：标题为「Helm 等待你的处理」，正文按根去重并如实标注失败，
 *   跳转该树内 updatedAt 最新的 blocked 会话。
 */

import type { ConversationSummary } from '@helm/protocol'
import { MAX_ANCESTRY_DEPTH } from '../conversation/ancestry-model.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'

/** 浏览器通知权限：标准三态 + 宿主不支持（happy-dom / 旧环境无 Notification）。 */
export type BrowserNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported'

/** 单棵根会话树的瞬时活动快照（机器在途 ∪ 等待人类）。 */
export interface RootTreeActivity {
  rootId: number
  /** 该树内当前处于机器在途（working、后台 accent 角标或上下文精简中）的会话 ID 集合。 */
  activeConversationIds: ReadonlySet<number>
  /** 该树内当前处于 blocked 态（等待人类输入/审批）的会话 ID 集合。 */
  blockedConversationIds: ReadonlySet<number>
}

/** 全局活动快照：按根会话树组织的状态集合 + 全局 badge doc 未知门控。 */
export interface ActivitySnapshot {
  /** 按根会话 ID 索引的活动树（仅包含当前有机器在途或 blocked 会话的树）。 */
  trees: ReadonlyMap<number, RootTreeActivity>
  /** 尚未首次加载的 badge doc key：全局后台在途事实未知，不得宣称任何树完成。 */
  pendingBadgeDocs: ReadonlySet<string>
  /** 是否存在尚未首次加载的 badge doc。 */
  badgeUnknown: boolean
}

/**
 * 派生会话归并：沿 parentConversationId 上溯到「当前存在的最顶层」会话——
 * 父摘要缺失（祖先已删除/未知）时停在当前最高存活节点；环与超深脏数据按
 * ancestry-model 的同一防御上限 MAX_ANCESTRY_DEPTH 截断，有限终止绝不递归
 * 失控。与 buildAncestorChain 的面包屑语义不同：此处只取存活代表，不保留
 * 缺失 ID（通知正文无法为不存在的会话提供标题与跳转目标）。
 */
export function resolveNotificationRootId(
  byId: ReadonlyMap<number, ConversationSummary>,
  conversationId: number,
): number {
  let currentId = conversationId
  const visited = new Set<number>([conversationId])
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    const current = byId.get(currentId)
    if (current?.parentConversationId === undefined) break
    const parentId = current.parentConversationId
    if (visited.has(parentId)) break
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (parent === undefined) break
    currentId = parentId
  }
  return currentId
}

/** 生成 blocked 会话的水位键：stateChangeSeq 或 pendingAskCount 任一推进即视为新/变化待处理。 */
export function getBlockedWatermark(
  conversation: Pick<ConversationSummary, 'stateChangeSeq' | 'pendingAskCount'>,
): string {
  return `${conversation.stateChangeSeq}:${conversation.pendingAskCount}`
}

export function resolveActivitySnapshot(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
  /** 未完成首次加载的 badge doc key（由装配层发现，见 use-quiet-notifier）。 */
  pendingBadgeDocs?: ReadonlySet<string>
}): ActivitySnapshot {
  const byId = new Map<number, ConversationSummary>(
    input.conversations.map((conversation) => [conversation.id, conversation] as [number, ConversationSummary]),
  )
  const trees = new Map<
    number,
    { rootId: number; activeConversationIds: Set<number>; blockedConversationIds: Set<number> }
  >()
  const ensureTree = (rootId: number) => {
    let tree = trees.get(rootId)
    if (tree === undefined) {
      tree = { rootId, activeConversationIds: new Set<number>(), blockedConversationIds: new Set<number>() }
      trees.set(rootId, tree)
    }
    return tree
  }
  for (const conversation of input.conversations) {
    // 后台在途（accent 角标或上下文精简）优先于五态：blocked/idle 父会话名下后台仍在跑就是机器在途。
    const active = conversation.status === 'working' || input.background.get(conversation.id)?.active === true
    const blocked = conversation.status === 'blocked'
    if (!active && !blocked) continue
    const rootId = resolveNotificationRootId(byId, conversation.id)
    const tree = ensureTree(rootId)
    if (active) tree.activeConversationIds.add(conversation.id)
    if (blocked) tree.blockedConversationIds.add(conversation.id)
  }
  const pendingBadgeDocs = input.pendingBadgeDocs ?? new Set<string>()
  return {
    trees,
    pendingBadgeDocs,
    badgeUnknown: pendingBadgeDocs.size > 0,
  }
}

/** 根会话树无参与者处于 error 态时的完成通知标题。 */
export const COMPLETED_NOTIFICATION_TITLE = 'Helm 会话已完成'

/** 根会话树任一参与者处于 error 态时的结束通知标题（绝不谎称已完成）。 */
export const ENDED_NOTIFICATION_TITLE = 'Helm 会话已结束'

/** 等待人类输入/审批（blocked）通知标题。 */
export const WAITING_NOTIFICATION_TITLE = 'Helm 等待你的处理'

/** 正文最多列出的根条目数，超出折叠为「等 N 个 …」。 */
const MAX_LISTED_CONVERSATIONS = 3

/** 通知内容与点击跳转目标。 */
export interface QuietNotificationDraft {
  title: string
  body: string
  /** 点击通知直达的会话（无确定跳转目标为 null）。 */
  primaryConversationId: number | null
}

/** 通知正文中的会话条目（与会话列表/命令面板一致的「#id 标题」格式）。 */
const conversationLabel = (conversation: ConversationSummary): string => `#${conversation.id} ${conversation.title}`

/** 把会话列表按根归并去重（输入须为仍存在的会话，顺序即通知罗列优先级）。 */
function mergeToRootIds(
  byId: ReadonlyMap<number, ConversationSummary>,
  conversations: ReadonlyArray<ConversationSummary>,
): number[] {
  const rootIds: number[] = []
  const seen = new Set<number>()
  for (const conversation of conversations) {
    const rootId = resolveNotificationRootId(byId, conversation.id)
    if (seen.has(rootId)) continue
    seen.add(rootId)
    if (byId.has(rootId)) rootIds.push(rootId)
  }
  return rootIds
}

/**
 * 组装单棵根会话树完成周期的通知内容（累计参与者为空返回 null）：
 * - 任一累计参与者（含被归并的子会话）处于 error 态 → 「Helm 会话已结束」，
 *   正文为 `#id 标题 · 有失败`；
 * - 无 error 参与者 → 「Helm 会话已完成」，正文为 `#id 标题`；
 * - 根会话仍存在时跳转 rootId；若根已被删且仍有存活子参与者则跳转存活根；
 *   若整棵树在周期内均被删除，通知仍成立但不编造标题，primary 为 null。
 */
export function composeTreeCompletionNotification(input: {
  rootId: number
  /** 该树本周期累计参与机器活动的会话 ID（含派生子会话）。 */
  accumulatedConversationIds: ReadonlySet<number>
  conversations: ReadonlyArray<ConversationSummary>
}): QuietNotificationDraft | null {
  if (input.accumulatedConversationIds.size === 0) return null
  const byId = new Map<number, ConversationSummary>(
    input.conversations.map((conversation) => [conversation.id, conversation] as [number, ConversationSummary]),
  )
  const accumulated = [...input.accumulatedConversationIds]
    .map((id) => byId.get(id))
    .filter((conversation): conversation is ConversationSummary => conversation !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
  const hasFailure = accumulated.some((conversation) => conversation.status === 'error')
  const title = hasFailure ? ENDED_NOTIFICATION_TITLE : COMPLETED_NOTIFICATION_TITLE

  const directRoot = byId.get(input.rootId)
  const survivingRootId =
    directRoot !== undefined
      ? directRoot.id
      : accumulated.length > 0
        ? resolveNotificationRootId(byId, accumulated[0]!.id)
        : undefined
  const rootConv = survivingRootId !== undefined ? byId.get(survivingRootId) : undefined

  if (rootConv === undefined) {
    return {
      title,
      body: hasFailure ? '会话已结束 · 有失败' : '会话已结束',
      primaryConversationId: null,
    }
  }
  const parts = [conversationLabel(rootConv)]
  if (hasFailure) parts.push('有失败')
  return {
    title,
    body: parts.join(' · '),
    primaryConversationId: rootConv.id,
  }
}

/**
 * 组装单棵根会话树等待人类处理（blocked）的通知内容：
 * - 无存活 blocked 会话返回 null；
 * - 标题固定 WAITING_NOTIFICATION_TITLE（「Helm 等待你的处理」）；
 * - 正文按根归并去重（多个子 blocked 不重复列），若累计参与者中有 error 则如实标注「有失败」；
 * - primaryConversationId 取该树内 updatedAt 最新的 blocked 会话（直达提问/审批处）。
 */
export function composeTreeBlockedNotification(input: {
  rootId: number
  /** 该树当前处于 blocked 态的会话 ID。 */
  blockedConversationIds: ReadonlySet<number>
  /** 可选：该树本周期累计参与会话 ID（用于如实检出失败参与者）。 */
  accumulatedConversationIds?: ReadonlySet<number>
  conversations: ReadonlyArray<ConversationSummary>
}): QuietNotificationDraft | null {
  const byId = new Map<number, ConversationSummary>(
    input.conversations.map((conversation) => [conversation.id, conversation] as [number, ConversationSummary]),
  )
  const blocked = [...input.blockedConversationIds]
    .map((id) => byId.get(id))
    .filter((conversation): conversation is ConversationSummary => conversation !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
  if (blocked.length === 0) return null

  const hasFailure = [...(input.accumulatedConversationIds ?? [])]
    .map((id) => byId.get(id))
    .some((conversation) => conversation?.status === 'error')

  const rootIds = mergeToRootIds(byId, blocked)
  const parts = rootIds.slice(0, MAX_LISTED_CONVERSATIONS).map((id) => conversationLabel(byId.get(id)!))
  if (rootIds.length > parts.length) parts.push(`等 ${rootIds.length} 个待处理`)
  if (hasFailure) parts.push('有失败')
  return {
    title: WAITING_NOTIFICATION_TITLE,
    body: `待处理输入/审批：${parts.join(' · ')}`,
    primaryConversationId: blocked[0]!.id,
  }
}

/**
 * 触发当刻的投递门控（逐项现场复核，不信任任何缓存）：
 * - 已认证、偏好开启、浏览器通知权限已授予、SSE 连接健康；
 * - 页面处于非前台活跃态（!isPageActive()，即页面隐藏或窗口失焦）：用户正看着页面时不弹噪音。
 */
export function shouldDeliverQuietNotification(input: {
  authenticated: boolean
  preferenceEnabled: boolean
  permission: BrowserNotificationPermission
  connected: boolean
  pageActive: boolean
}): boolean {
  if (!input.authenticated || !input.preferenceEnabled || input.permission !== 'granted' || !input.connected) return false
  return !input.pageActive
}
