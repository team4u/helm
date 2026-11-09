/**
 * 微插槽（conversation.header.action / conversation.row.action /
 * timeline.entry.action）的纯函数匹配与载荷构造层。
 *
 * 契约要点（见 20261109 Web 界面扩展机制设计文档 P2）：
 * - 所有微插槽均按 matchesUiScope(spec.scope, conversation) 过滤；
 * - action-only（仅 actionId，无 client/json）：宿主渲染标准极简图标按钮 /
 *   菜单项；声明了 client 或 json 时内联 <PluginUiView />；
 * - Action 载荷以实际上下文为准：conversationId / entryId 由宿主强制注入并
 *   覆盖 spec.input 同名字段（spec.input 不能伪造目标会话或条目）；
 * - 调用寻址 actionPluginId ?? pluginId。
 */
import type {
  ConversationActionSpec,
  ConversationSummary,
  TimelineEntryActionSpec,
} from '@helm/protocol'
import { matchesUiScope, type QualifiedUiSpec } from '../lib/types.js'

/** 微插槽 action-only 判定：未声明 client/json，仅靠 actionId 执行。 */
export function isActionOnlyActionSpec(spec: ConversationActionSpec): boolean {
  return spec.actionId !== undefined && spec.client === undefined && spec.json === undefined
}

/** 会话级微插槽过滤：scope 命中 + 声明了执行轨（actionId / client / json 至少其一）。 */
export function matchConversationActions(
  actions: ReadonlyArray<QualifiedUiSpec<ConversationActionSpec>> | undefined,
  conversation: ConversationSummary | undefined,
): Array<QualifiedUiSpec<ConversationActionSpec>> {
  if (!actions || conversation === undefined) return []
  return actions.filter(
    (a) =>
      matchesUiScope(conversation, a.spec.scope) &&
      (a.spec.actionId !== undefined || a.spec.client !== undefined || a.spec.json !== undefined),
  )
}

/**
 * 会话顶栏 placement 分组：'toolbar' 直出按钮组，'menu'（缺省）收纳进
 * 「更多操作」下拉菜单。
 */
export function splitConversationHeaderActions(
  actions: ReadonlyArray<QualifiedUiSpec<ConversationActionSpec>>,
): {
  toolbar: Array<QualifiedUiSpec<ConversationActionSpec>>
  menu: Array<QualifiedUiSpec<ConversationActionSpec>>
} {
  const toolbar: Array<QualifiedUiSpec<ConversationActionSpec>> = []
  const menu: Array<QualifiedUiSpec<ConversationActionSpec>> = []
  for (const a of actions) {
    if (a.spec.placement === 'toolbar') toolbar.push(a)
    else menu.push(a)
  }
  return { toolbar, menu }
}

/** timeline.entry.action 的条目匹配上下文。 */
export interface TimelineEntryActionContext {
  /** 条目 kind（如 'pi.user'、'pi.assistant'、'helm.input'）。 */
  kind: string
  /** 文本消息角色：'user' | 'assistant'；非文本消息条目 undefined。 */
  role?: 'user' | 'assistant'
}

/**
 * 单条 timeline.entry.action 匹配判定：
 * - kinds 提供时须包含 entry.kind（缺省匹配全部条目）；
 * - roles 提供时须包含条目角色（缺省不按角色过滤；无角色条目仅在 roles 缺省时命中）。
 */
export function matchesTimelineEntryAction(
  spec: TimelineEntryActionSpec,
  entry: TimelineEntryActionContext,
): boolean {
  const kinds = spec.kinds
  if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.includes(entry.kind))) return false
  const roles = spec.roles
  if (roles !== undefined) {
    if (entry.role === undefined) return false
    if (!roles.includes(entry.role)) return false
  }
  return true
}

/** timeline.entry.action 过滤：scope + 执行轨 + kinds/roles。 */
export function matchTimelineEntryActions(
  actions: ReadonlyArray<QualifiedUiSpec<TimelineEntryActionSpec>> | undefined,
  conversation: ConversationSummary | undefined,
  entry: TimelineEntryActionContext,
): Array<QualifiedUiSpec<TimelineEntryActionSpec>> {
  if (!actions || conversation === undefined) return []
  return actions.filter(
    (a) =>
      matchesUiScope(conversation, a.spec.scope) &&
      (a.spec.actionId !== undefined || a.spec.client !== undefined || a.spec.json !== undefined) &&
      matchesTimelineEntryAction(a.spec, entry),
  )
}

/**
 * 构造 action 调用载荷：实际上下文强制覆盖 spec.input 同名字段。
 * spec.input 可补充任意附加字段，但 conversationId / entryId 永远以宿主实际
 * 上下文为准：插件声明不能伪造目标会话；宿主无 entryId 上下文时会话级动作
 * 载荷也不携带 spec.input 里的伪造 entryId（剔除而非透传）。
 */
export function buildMicroActionInput(
  spec: { input?: Record<string, unknown> },
  context: { conversationId: number; entryId?: string },
): Record<string, unknown> {
  const { entryId: _forged, ...rest } = spec.input ?? {}
  void _forged
  return {
    ...rest,
    conversationId: context.conversationId,
    ...(context.entryId !== undefined ? { entryId: context.entryId } : {}),
  }
}

/** action 调用目标插件：actionPluginId 覆写，缺省贡献插件自身。 */
export function microActionPluginId(spec: { actionPluginId?: string }, fallbackPluginId: string): string {
  return spec.actionPluginId ?? fallbackPluginId
}
