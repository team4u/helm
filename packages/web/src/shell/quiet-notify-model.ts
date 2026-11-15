/**
 * 「全部空闲」浏览器通知纯函数层（零 React/DOM 依赖，单测直测）。
 *
 * 数据源与侧栏后台在途环同一契约，不重复实现任何判定：
 * - 会话五态：working / blocked 表示主回合在途或等待人类输入；
 * - 后台在途：summarizeConversationBackgroundActivity 的按会话索引
 *   （workbench 面板角标 tone = 'accent'，如 builtin:workflow 运行中的后台
 *   子代理与 DSL run），插件停用后索引自然归零。
 *
 * 「忙碌」判定（任一命中即忙）：
 * - 任一会话 status ∈ {working, blocked}——blocked 是等待人类输入，系统并未
 *   安静，绝不能在有待答复提问时谎报「全部完成」；
 * - 任一会话存在后台在途任务（父会话主回合已 idle 也算忙，这正是本功能的
 *   核心：不能只在主会话空闲就提醒，要等后台活动也全部结束）。
 *
 * 通知只在「忙碌 → 安静」状态转移时产生（打开页面即安静不提醒）；安静需在
 * 防抖窗口内持续（见 use-quiet-notifier 的 quietNotifyTimings），覆盖主回合
 * 落定与后台角标推进之间的瞬时缝隙、SSE 重同步与插件重载瞬间 badge doc
 * 清空造成的假安静抖动。
 */

import type { ConversationSummary } from '@helm/protocol'
import type { ConversationBackgroundIndex } from './background-activity-model.js'

/** 浏览器通知权限：标准三态 + 宿主不支持（happy-dom / 旧环境无 Notification）。 */
export type BrowserNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported'

/** 全局活动快照：由会话列表与后台在途索引推导，是通知状态机的唯一输入。 */
export interface ActivitySnapshot {
  /** 主回合在途或等待人类输入（working/blocked）的会话 ID 集合。 */
  busyConversationIds: ReadonlySet<number>
  /** 存在后台在途任务的会话 ID 集合（仅主回合 working 的会话不在此列）。 */
  backgroundConversationIds: ReadonlySet<number>
  /** 全局安静：无 working/blocked 会话且无任何后台在途。 */
  quiet: boolean
}

export function resolveActivitySnapshot(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
}): ActivitySnapshot {
  const busyConversationIds = new Set<number>()
  const backgroundConversationIds = new Set<number>()
  for (const conversation of input.conversations) {
    if (conversation.status === 'working' || conversation.status === 'blocked') busyConversationIds.add(conversation.id)
    if (input.background.get(conversation.id)?.active === true) backgroundConversationIds.add(conversation.id)
  }
  return {
    busyConversationIds,
    backgroundConversationIds,
    quiet: busyConversationIds.size === 0 && backgroundConversationIds.size === 0,
  }
}

/** 「全部空闲」通知标题（常量：同 tag 通知互相替换，标题保持稳定）。 */
export const QUIET_NOTIFICATION_TITLE = 'Helm 已全部空闲'

/** 正文最多列出的刚安静会话数，超出折叠为「等 N 个会话」。 */
const MAX_LISTED_CONVERSATIONS = 3

/** 「全部空闲」通知内容与点击跳转目标。 */
export interface QuietNotificationDraft {
  title: string
  body: string
  /** 点击通知直达的会话（刚安静会话中 updatedAt 最新者；无可跳转目标为 null）。 */
  primaryConversationId: number | null
}

/**
 * 组装「忙碌 → 安静」转移的通知内容（其余转移返回 null 不通知）：
 * - 罗列上一快照忙碌（主回合或后台在途）且当前仍存在、现已安静的会话；
 *   忙碌会话若在窗口内被删除则不参与罗列（标题已不可知），但转移本身仍成立；
 * - 任一刚安静会话处于 error 态时正文标注「有失败」，提示回来处理而不是
 *   让失败静默混进「已完成」；
 * - primary 取刚安静会话中 updatedAt 最新者，点击通知直达。
 */
export function composeQuietNotification(
  prev: ActivitySnapshot,
  next: ActivitySnapshot,
  conversations: ReadonlyArray<ConversationSummary>,
): QuietNotificationDraft | null {
  if (prev.quiet || !next.quiet) return null
  const settledIds = new Set<number>([...prev.busyConversationIds, ...prev.backgroundConversationIds])
  const settled = [...conversations]
    .filter((conversation) => settledIds.has(conversation.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const listed = settled.slice(0, MAX_LISTED_CONVERSATIONS)
  const parts = listed.map((conversation) => `#${conversation.id} ${conversation.title}`)
  if (settled.length > listed.length) parts.push(`等 ${settled.length} 个会话`)
  if (settled.some((conversation) => conversation.status === 'error')) parts.push('有失败')
  const primary = settled[0]
  return {
    title: QUIET_NOTIFICATION_TITLE,
    body: parts.length > 0 ? parts.join(' · ') : '所有会话与后台任务已结束',
    primaryConversationId: primary === undefined ? null : primary.id,
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
  preferenceEnabled: boolean
  permission: BrowserNotificationPermission
  connected: boolean
  pageVisible: boolean
  pageFocused: boolean
}): boolean {
  if (!input.preferenceEnabled || input.permission !== 'granted' || !input.connected) return false
  return !input.pageVisible || !input.pageFocused
}
