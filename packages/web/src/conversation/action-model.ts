/**
 * UI 动作（ctx.ui.action：conversation:header / conversation:row / timeline:entry
 * 三类微插槽）的纯函数匹配与载荷构造层。
 *
 * 契约要点：
 * - 所有微插槽均按 matchesUiScope(spec.scope, conversation) 过滤；
 * - action-only（仅 actionId，无 client）：宿主渲染标准极简图标按钮 /
 *   菜单项；声明了 client 时内联 <PluginUiView />；
 * - Action 载荷以实际上下文为准：conversationId / entryId 由宿主强制注入并
 *   覆盖 spec.input 同名字段（spec.input 不能伪造目标会话或条目）；
 * - 调用寻址 actionPluginId ?? pluginId。
 */
import type {
  ConversationEntry,
  ConversationSummary,
  UiActionSpec,
} from '@helm/protocol'
import { matchesUiScope, type QualifiedUiSpec, type QualifiedUiActionSpec } from '../lib/types.js'

/** UI 动作 action-only 判定：未声明 client，仅靠 actionId 执行。 */
export function isActionOnlyActionSpec(spec: UiActionSpec): boolean {
  return spec.actionId !== undefined && spec.client === undefined
}

/** 会话级 UI 动作过滤：target + scope 命中 + 声明了执行轨（actionId / client 至少其一）。 */
export function matchConversationActions(
  actions: ReadonlyArray<QualifiedUiActionSpec> | undefined,
  target: UiActionSpec['target'],
  conversation: ConversationSummary | undefined,
): Array<QualifiedUiActionSpec> {
  if (!actions || conversation === undefined) return []
  return actions.filter(
    (a) =>
      a.target === target &&
      matchesUiScope(conversation, a.spec.scope) &&
      (a.spec.actionId !== undefined || a.spec.client !== undefined),
  )
}

/**
 * 会话顶栏 placement 分组：'toolbar' 直出按钮组，'menu'（缺省）收纳进
 * 「更多操作」下拉菜单。
 */
export function splitConversationHeaderActions(
  actions: ReadonlyArray<QualifiedUiActionSpec>,
): {
  toolbar: Array<QualifiedUiActionSpec>
  menu: Array<QualifiedUiActionSpec>
} {
  const toolbar: Array<QualifiedUiActionSpec> = []
  const menu: Array<QualifiedUiActionSpec> = []
  for (const a of actions) {
    if (a.spec.placement === 'toolbar') toolbar.push(a)
    else menu.push(a)
  }
  return { toolbar, menu }
}

/** timeline:entry 的条目匹配上下文。 */
export interface TimelineEntryActionContext {
  /** 条目 kind（如 'pi.user'、'pi.assistant'、'helm.input'）。 */
  kind: string
  /** 文本消息角色：'user' | 'assistant'；非文本消息条目 undefined。 */
  role?: 'user' | 'assistant'
}

/**
 * 真实 ConversationEntry -> timeline:entry 匹配上下文：
 * kind 原样采用真实条目 kind；文本消息条目附角色
 * （pi.user / helm.input -> user，pi.assistant -> assistant），
 * 其余条目（自定义 kind、pi.tool-result 等）无角色，声明 roles 的动作不命中。
 */
export function timelineEntryActionContextOf(entry: ConversationEntry): TimelineEntryActionContext {
  if (entry.kind === 'pi.user' || entry.kind === 'helm.input') return { kind: entry.kind, role: 'user' }
  if (entry.kind === 'pi.assistant') return { kind: entry.kind, role: 'assistant' }
  return { kind: entry.kind }
}

/**
 * 单条 timeline:entry 匹配判定：
 * - kinds 提供时须包含 entry.kind（缺省匹配全部条目）；
 * - roles 提供时须包含条目角色（缺省不按角色过滤；无角色条目仅在 roles 缺省时命中）。
 */
export function matchesTimelineEntryAction(
  spec: UiActionSpec,
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

/** timeline:entry 过滤：target + scope + 执行轨 + kinds/roles。 */
export function matchTimelineEntryActions(
  actions: ReadonlyArray<QualifiedUiActionSpec> | undefined,
  conversation: ConversationSummary | undefined,
  entry: TimelineEntryActionContext,
): Array<QualifiedUiActionSpec> {
  if (!actions || conversation === undefined) return []
  return actions.filter(
    (a) =>
      a.target === 'timeline:entry' &&
      matchesUiScope(conversation, a.spec.scope) &&
      (a.spec.actionId !== undefined || a.spec.client !== undefined) &&
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
