/**
 * 「全部空闲 / 等待你的处理」浏览器通知纯函数层（零 React/DOM 依赖，单测直测）。
 *
 * 数据源与侧栏后台在途环同一契约，不重复实现任何判定：
 * - 会话五态：working 表示主回合机器在途；blocked 表示等待人类输入/审批——
 *   这是「等待你」，不是机器活动，不阻止「机器停下」通知；
 * - 后台在途：summarizeConversationBackgroundActivity 的按会话索引
 *   （workbench 面板角标 tone = 'accent'，如 builtin:workflow 运行中的后台
 *   子代理与 DSL run），插件停用后索引自然归零；
 * - badge doc 未知：启用面板所需的按会话角标 doc 尚未首次加载时，后台在途
 *   事实不可知——保持 unknown，绝不据此宣称安静（宁可晚提醒，不误报空闲）。
 *
 * 「机器活动」判定（任一命中即 active）：任一会话 status = working，或任一
 * 会话存在后台在途（accent 角标）。blocked 不在其中：等待人类不是机器在忙。
 *
 * 通知只在「忙碌周期」结算时产生（见 use-quiet-notifier 的防抖与累积）：
 * 机器活动期间累计参与会话（跨多个被活动取消的安静防抖窗口保留），安静
 * 真正到期时用最新 conversations 事实组装：
 * - 无 blocked 会话 → 「Helm 已全部空闲」，罗列刚安静会话（派生子会话沿
 *   parentConversationId 归并到当前存在的最顶层会话，不重复列出、不抢跳转）；
 * - 有 blocked 会话 → 「Helm 等待你的处理」，正文明确待处理输入/审批，
 *   跳转优先给最新 blocked 会话本身（可见 = 仍存在于会话列表，直达提问处）。
 */

import type { ConversationSummary } from '@helm/protocol'
import { MAX_ANCESTRY_DEPTH } from '../conversation/ancestry-model.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'

/** 浏览器通知权限：标准三态 + 宿主不支持（happy-dom / 旧环境无 Notification）。 */
export type BrowserNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported'

/** 全局活动快照：机器活动 / 等待人类 / badge doc 未知三轴正交，是通知状态机的唯一输入。 */
export interface ActivitySnapshot {
  /** 机器在途（主回合 working 或后台 accent 角标）的会话 ID 集合。 */
  activeConversationIds: ReadonlySet<number>
  /** 等待人类输入/审批（status = blocked）的会话 ID 集合——不是机器活动。 */
  blockedConversationIds: ReadonlySet<number>
  /** 尚未首次加载的 badge doc key：后台在途事实未知，不得宣称安静。 */
  pendingBadgeDocs: ReadonlySet<string>
  /** 机器停下：无在途会话且无未知 badge doc（blocked 不影响本判定）。 */
  quiet: boolean
}

export function resolveActivitySnapshot(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
  /** 未完成首次加载的 badge doc key（由装配层发现，见 use-quiet-notifier）。 */
  pendingBadgeDocs?: ReadonlySet<string>
}): ActivitySnapshot {
  const activeConversationIds = new Set<number>()
  const blockedConversationIds = new Set<number>()
  for (const conversation of input.conversations) {
    // 后台 accent 优先于五态：blocked/idle 父会话名下后台仍在跑就是机器在途。
    if (conversation.status === 'working' || input.background.get(conversation.id)?.active === true) {
      activeConversationIds.add(conversation.id)
    }
    if (conversation.status === 'blocked') blockedConversationIds.add(conversation.id)
  }
  const pendingBadgeDocs = input.pendingBadgeDocs ?? new Set<string>()
  return {
    activeConversationIds,
    blockedConversationIds,
    pendingBadgeDocs,
    quiet: activeConversationIds.size === 0 && pendingBadgeDocs.size === 0,
  }
}

/** 「全部空闲」通知标题（常量：同 tag 通知互相替换，标题保持稳定）。 */
export const QUIET_NOTIFICATION_TITLE = 'Helm 已全部空闲'

/** 「等待你的处理」通知标题（机器停下但存在待人类输入/审批的会话）。 */
export const WAITING_NOTIFICATION_TITLE = 'Helm 等待你的处理'

/** 正文最多列出的会话数，超出折叠为「等 N 个 …」。 */
const MAX_LISTED_CONVERSATIONS = 3

/** 通知内容与点击跳转目标。 */
export interface QuietNotificationDraft {
  title: string
  body: string
  /** 点击通知直达的会话（无确定跳转目标为 null）。 */
  primaryConversationId: number | null
}

/**
 * 派生会话归并：沿 parentConversationId 上溯到「当前存在的最顶层」会话——
 * 父摘要缺失（祖先已删除/未知）时停在当前最高存活节点；环与超深脏数据按
 * ancestry-model 的同一防御上限 MAX_ANCESTRY_DEPTH 截断，有限终止绝不递归
 * 失控。与 buildAncestorChain 的面包屑语义不同：此处只取存活代表，不保留
 * 缺失 ID（通知正文无法为不存在的会话提供标题与跳转目标）。
 */
function resolveNotificationRootId(
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

/** 通知正文中的会话条目（与会话列表/命令面板一致的「#id 标题」格式）。 */
const conversationLabel = (conversation: ConversationSummary): string => `#${conversation.id} ${conversation.title}`

/** 把会话列表按根归并去重（输入须为仍存在的会话，顺序即通知罗列优先级）。 */
function mergeToRootIds(byId: ReadonlyMap<number, ConversationSummary>, conversations: ReadonlyArray<ConversationSummary>): number[] {
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
 * 组装忙碌周期结算的通知内容（机器从未活动 accumulated 为空时返回 null，
 * 覆盖「打开页面即安静」「仅 badge doc 从未知变为已知」等无从通知的场景）：
 * - 存在 blocked 会话 → 「Helm 等待你的处理」：正文以待处理输入/审批开头，
 *   罗列 blocked 会话（归并到根会话、去重、折叠），跳转最新 blocked 会话本身
 *   （直达提问处；若它是子代理会话，落地即该待审批回合）；
 * - 无 blocked 会话 → 「Helm 已全部空闲」：罗列本周期累计参与、当前仍存在
 *   的会话归并后的根会话（子会话不重复列出、不抢跳转），primary 取最新安静
 *   会话所属根；
 * - 两种正文均在任一累计会话（含被归并的子会话）处于 error 态时标注
 *   「有失败」——失败如实保留，绝不静默混进「已完成」；
 * - 累计会话在周期内被删除则不参与罗列（标题已不可知），通知仍成立。
 */
export function composeQuietNotification(input: {
  /** 本忙碌周期累计参与机器活动的会话 ID（含派生子会话）。 */
  accumulatedConversationIds: ReadonlySet<number>
  /** 结算时仍等待人类输入/审批（blocked）的会话 ID。 */
  blockedConversationIds: ReadonlySet<number>
  conversations: ReadonlyArray<ConversationSummary>
}): QuietNotificationDraft | null {
  if (input.accumulatedConversationIds.size === 0) return null
  const byId = new Map<number, ConversationSummary>(
    input.conversations.map((conversation) => [conversation.id, conversation] as [number, ConversationSummary]),
  )
  const accumulated = [...input.accumulatedConversationIds]
    .map((id) => byId.get(id))
    .filter((conversation): conversation is ConversationSummary => conversation !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const hasFailure = accumulated.some((conversation) => conversation.status === 'error')

  const blocked = [...input.blockedConversationIds]
    .map((id) => byId.get(id))
    .filter((conversation): conversation is ConversationSummary => conversation !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  if (blocked.length > 0) {
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

  const rootIds = mergeToRootIds(byId, accumulated)
  const parts = rootIds.slice(0, MAX_LISTED_CONVERSATIONS).map((id) => conversationLabel(byId.get(id)!))
  if (rootIds.length > parts.length) parts.push(`等 ${rootIds.length} 个会话`)
  if (hasFailure) parts.push('有失败')
  return {
    title: QUIET_NOTIFICATION_TITLE,
    body: parts.length > 0 ? parts.join(' · ') : '所有会话与后台任务已结束',
    primaryConversationId: rootIds[0] ?? null,
  }
}

/**
 * 触发当刻的投递门控（逐项现场复核，不信任任何缓存）：
 * - 偏好开启且权限已授予——权限可能随时被浏览器设置收回，必须现场读取；
 * - SSE 连接健康——断流期间状态是陈旧的，「安静」可能只是缺帧假象；
 * - 页面失焦或隐藏——用户正看着页面时浏览器通知是噪音；hasFocus 缺失的
 *   宿主按未聚焦处理（宁可多提醒一次，不静默漏提醒）。
 */
export function shouldDeliverQuietNotification(input: {
  authenticated: boolean
  preferenceEnabled: boolean
  permission: BrowserNotificationPermission
  connected: boolean
  pageVisible: boolean
  pageFocused: boolean
}): boolean {
  if (!input.authenticated || !input.preferenceEnabled || input.permission !== 'granted' || !input.connected) return false
  return !input.pageVisible || !input.pageFocused
}
