/**
 * 侧栏「会话后台在途」纯函数层（零 React/DOM 依赖，单测直测）。
 *
 * 数据源：
 * 1. 复用通用 workbench.panel badge 契约——启用插件的 groupedUi.workbenchPanels 中
 *    声明 badge.byConversationField 的面板，其 public doc 提供按会话索引的
 *    { count, tone?, footerText? }（resolveWorkbenchPanelBadge 解析）。
 * 2. 会话上下文精简态——conversation.contextUsage?.compacting === true（内核异步
 *    compaction 在途，无需额外插件 doc，直接归并入同一在途索引与摘要「上下文精简中」）。
 * 本层不感知任何插件 ID、不新增协议字段；纯函数只做推导，badge doc 的按需
 * 加载由 Sidebar 的 effect 调 store.ensurePluginDoc 完成（纯函数零副作用）。
 *
 * 在途判定（最小且严格，只依赖契约自有字段，不解析任意插件文案）：
 * - 仅按会话索引（byConversationField）参与：全局 countField/toneField 角标无法
 *   归属到具体会话，点亮任何会话行都会误导；
 * - 条目 tone === 'accent' 即在途：builtin:workflow 的 `run-badges` 在 running > 0
 *   时置 accent（footerText 如「2 运行中」）。tone = 'neutral'（历史计数）与
 *   tone = 'warn'（如后台失败汇总）都不点亮在途环——计数与失败已在工作台
 *   角标可见，不在途就不冒充在途；
 * - count 不参与判定（含全部历史，不区分在途）；
 * - footerText 与「上下文精简中」原样进入 tooltip 摘要（去重后「 · 」拼接），绝不解析字符串含义。
 */

import type { ConversationSummary, WorkbenchPanelSpec } from '@helm/protocol/browser'
import type { QualifiedUiSpec } from '../lib/types.js'
import { matchesUiScope } from '../lib/types.js'
import { resolveWorkbenchPanelBadge } from '../conversation/workbench-model.js'
import { AGENT_SUB_LIST_PREVIEW, conversationStatusDotClass, conversationStatusTooltip } from './sidebar-model.js'

/** 摘要片段分隔符（与工作台底部状态栏 footerText 拼接风格一致）。 */
const SUMMARY_SEPARATOR = ' · '

/** 上下文精简进行中的后台在途摘要文案。 */
const COMPACTING_SUMMARY = '上下文精简中'

/** 单个会话的后台在途摘要（由命中面板的按会话角标与上下文精简态聚合）。 */
export interface ConversationBackgroundActivity {
  /** 存在在途后台任务（任一命中面板的按会话角标 tone = 'accent'，或 contextUsage.compacting = true）。 */
  active: boolean
  /** 运行摘要文案：各命中角标 footerText 与精简文案去重后拼接（可为空串）。 */
  summary: string
}

/** 会话后台在途索引（key: conversationId；侧栏各会话行按 id 查询）。 */
export type ConversationBackgroundIndex = ReadonlyMap<number, ConversationBackgroundActivity>

/** 把非空且未重复的摘要片段并入指定会话的后台在途条目。 */
function appendBackgroundSummary(
  result: Map<number, ConversationBackgroundActivity>,
  conversationId: number,
  fragment: string,
): void {
  const text = fragment.trim()
  const prev = result.get(conversationId)
  const parts = prev === undefined || prev.summary === '' ? [] : prev.summary.split(SUMMARY_SEPARATOR)
  if (text !== '' && !parts.includes(text)) parts.push(text)
  result.set(conversationId, { active: true, summary: parts.join(SUMMARY_SEPARATOR) })
}

/**
 * 汇总每个会话的后台在途摘要：
 * - 消费声明 badge.byConversationField 的启用面板（会话须命中 panel.spec.scope），
 *   将 tone = 'accent' 的条目标记为在途并汇入 footerText；
 * - 检查每个会话的 contextUsage?.compacting === true，将其标记为在途并汇入「上下文精简中」；
 * - 插件停用后其 UI 贡献与 doc 均从 store 消失，面板来源自然归零。
 */
export function summarizeConversationBackgroundActivity(input: {
  panels: ReadonlyArray<QualifiedUiSpec<WorkbenchPanelSpec>>
  conversations: ReadonlyArray<ConversationSummary>
  pluginDocs: Record<string, unknown>
}): Map<number, ConversationBackgroundActivity> {
  const result = new Map<number, ConversationBackgroundActivity>()
  const perConversationPanels = input.panels.filter(
    (panel) => panel.spec.badge?.byConversationField !== undefined,
  )
  for (const panel of perConversationPanels) {
    const badge = panel.spec.badge
    if (badge === undefined) continue
    const docValue = input.pluginDocs[`${panel.pluginId}/${badge.doc}`]
    for (const conversation of input.conversations) {
      if (!matchesUiScope(conversation, panel.spec.scope)) continue
      const resolved = resolveWorkbenchPanelBadge(badge, docValue, conversation.id)
      if (resolved.tone !== 'accent') continue
      appendBackgroundSummary(result, conversation.id, resolved.footerText ?? '')
    }
  }
  for (const conversation of input.conversations) {
    if (conversation.contextUsage?.compacting === true) {
      appendBackgroundSummary(result, conversation.id, COMPACTING_SUMMARY)
    }
  }
  return result
}

/** 侧栏需要按需加载的 badge doc 引用（去重；供 Sidebar effect 调 ensurePluginDoc）。 */
export interface BackgroundBadgeDocRef {
  pluginId: string
  doc: string
}

/**
 * 收集侧栏应按需加载的 badge doc：仅声明 byConversationField 且 scope 至少
 * 命中一个会话的面板（全局角标 doc 不驱动会话在途，不加载）。
 */
export function collectBackgroundBadgeDocs(
  panels: ReadonlyArray<QualifiedUiSpec<WorkbenchPanelSpec>>,
  conversations: ReadonlyArray<ConversationSummary>,
): BackgroundBadgeDocRef[] {
  const seen = new Set<string>()
  const refs: BackgroundBadgeDocRef[] = []
  for (const panel of panels) {
    const badge = panel.spec.badge
    if (badge?.byConversationField === undefined) continue
    if (!conversations.some((conversation) => matchesUiScope(conversation, panel.spec.scope))) continue
    const key = `${panel.pluginId}/${badge.doc}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ pluginId: panel.pluginId, doc: badge.doc })
  }
  return refs
}

/**
 * 智能体站位行折叠态聚合指示器：
 * - representative：名下基础状态优先级最高的会话（error > blocked > working > done > idle，
 *   并列取列表首个即常驻/最新置顶序；纯 idle 时保持列表首个，与既有
 *   「看 primaryConversation」行为兼容）——支持非 primary 会话的未读 done 绿点与后台在途透出；
 * - backgroundActive / backgroundSummary：名下任一会话的后台在途聚合
 *   （footerText 去重拼接）。灯位渲染由 resolveStatusLight 单灯裁决：代表会话
 *   working/blocked/error 时状态灯独占（隐藏整个站位的后台环），代表 idle/done
 *   时让位唯一的后台空心环；展开态由子会话行各自呈现，站位行不重复。
 */
export interface StandingStatusIndicator {
  representative: ConversationSummary
  backgroundActive: boolean
  backgroundSummary: string
}

/** 基础状态聚合优先级：error > blocked > working > done > idle（idle 不参与竞争）。 */
const STANDING_STATUS_RANK: Record<string, number> = {
  error: 4,
  blocked: 3,
  working: 2,
  done: 1,
}

export function resolveStandingStatusIndicator(
  conversations: ReadonlyArray<ConversationSummary>,
  background: ConversationBackgroundIndex,
): StandingStatusIndicator | null {
  if (conversations.length === 0) return null
  const first = conversations[0]
  if (first === undefined) return null
  let representative = first
  let top = STANDING_STATUS_RANK[representative.status] ?? 0
  for (let i = 1; i < conversations.length; i++) {
    const candidate = conversations[i]
    if (candidate === undefined) continue
    const rank = STANDING_STATUS_RANK[candidate.status] ?? 0
    if (rank > top) {
      representative = candidate
      top = rank
    }
  }
  let backgroundActive = false
  const parts: string[] = []
  for (const conversation of conversations) {
    const activity = background.get(conversation.id)
    if (activity?.active !== true) continue
    backgroundActive = true
    if (activity.summary !== '' && !parts.includes(activity.summary)) parts.push(activity.summary)
  }
  return { representative, backgroundActive, backgroundSummary: parts.join(SUMMARY_SEPARATOR) }
}

/**
 * 会话在途判定（供折叠预览保留）：主回合 working/blocked，或存在后台在途
 * （badge tone = accent 或 contextUsage.compacting = true）。复用本模型的后台在途索引，不重复实现后台活动判定。
 */
export function isConversationInFlight(
  conv: Pick<ConversationSummary, 'id' | 'status'>,
  background: ConversationBackgroundIndex,
): boolean {
  return (
    conv.status === 'working' ||
    conv.status === 'blocked' ||
    background.get(conv.id)?.active === true
  )
}

/** Agent 子列表折叠预览切片结果。 */
export interface AgentSubListPreview {
  /** 折叠态应渲染的会话（保持原排序，不重排）。 */
  visible: ConversationSummary[]
  /** 被折叠隐藏的会话数（驱动「展开更多」按钮）。 */
  hiddenCount: number
}

/**
 * Agent 子列表折叠预览切片：默认仅展示前 AGENT_SUB_LIST_PREVIEW 条，但三类行
 * 绝不因折叠丢失——当前活跃会话（activeId 与 activeIds 并集，含分屏双开）、
 * working/blocked 会话、后台在途会话（在途需要被看见，埋在「展开更多」后面会误导用户以为空闲）。
 * showAll 时全量展示。纯函数无副作用，组件与单测共用。
 */
export function resolveAgentSubListPreview(input: {
  conversations: ReadonlyArray<ConversationSummary>
  showAll: boolean
  /** 当前激活会话 ID（单屏或聚焦面板目标；无则 null）。 */
  activeId: number | null
  /** 分屏多活跃会话 ID 集合（主屏与分屏所有会话均受保护，避免分屏会话被折叠隐藏）。 */
  activeIds?: ReadonlySet<number>
  background: ConversationBackgroundIndex
}): AgentSubListPreview {
  const { conversations, showAll, activeId, activeIds, background } = input
  const activeSet = new Set<number>(activeIds)
  if (activeId !== null) activeSet.add(activeId)
  const list = [...conversations]
  if (
    showAll ||
    list.length <= AGENT_SUB_LIST_PREVIEW ||
    list.some((conv, index) => index >= AGENT_SUB_LIST_PREVIEW && activeSet.has(conv.id))
  ) {
    return { visible: list, hiddenCount: 0 }
  }
  const visible = list.filter(
    (conv, index) =>
      index < AGENT_SUB_LIST_PREVIEW ||
      activeSet.has(conv.id) ||
      isConversationInFlight(conv, background),
  )
  return { visible, hiddenCount: list.length - visible.length }
}

/** 后台在途空心环完整类名（与基础状态圆点共用 status-dot 基类）。 */
const BACKGROUND_DOT_CLASS = 'status-dot status-dot-background'

/** 单灯位渲染判定：基础状态圆点或后台在途空心环二选一，绝无第二盏灯。 */
export interface StatusLight {
  /** 唯一灯位完整类名（含 status-dot 前缀）；null = 无灯（idle 且无后台在途）。 */
  dotClass: string | null
  /** 该灯位是否为后台在途空心环（true 时 tooltip 才叠加后台摘要）。 */
  background: boolean
}

/**
 * 单灯优先级（侧栏每个会话/智能体站位行只保留一个灯位）：
 * 1. working / blocked / error：主会话状态灯独占灯位，后台空心环完全不渲染；
 * 2. idle / done 且该行有后台在途：仅渲染后台空心环（idle 的无灯与 done 的
 *    绿点让位，父会话已空闲/完成而后台仍在运行）；
 * 3. 无后台在途：保持既有五态显示（done 绿点、idle 无灯、其余各自状态点）。
 */
export function resolveStatusLight(
  status: ConversationSummary['status'],
  backgroundActive: boolean,
): StatusLight {
  const base = conversationStatusDotClass(status)
  if (status === 'working' || status === 'blocked' || status === 'error') {
    return { dotClass: base, background: false }
  }
  if (backgroundActive) return { dotClass: BACKGROUND_DOT_CLASS, background: true }
  return { dotClass: base, background: false }
}

/**
 * 单灯位悬浮提示：主会话状态灯（working/blocked/error）只陈述主回合诊断
 * （doing/lastError），不叠加后台摘要，避免干扰当前主回合；仅当灯位为后台
 * 空心环（idle/done 让位）时，才在基础状态文案后拼后台运行摘要，明确父会话
 * 已空闲/完成而后台仍在运行。无在途时与既有文案完全一致。
 */
export function backgroundAwareStatusTooltip(input: {
  status: ConversationSummary['status']
  doing?: string
  lastError?: string
  backgroundActive: boolean
  backgroundSummary?: string
}): string {
  const base = conversationStatusTooltip(input.status, input.doing, input.lastError)
  const light = resolveStatusLight(input.status, input.backgroundActive)
  if (!light.background) return base
  const summary = input.backgroundSummary?.trim() ?? ''
  return summary === '' ? `${base} · 后台任务运行中` : `${base} · 后台任务: ${summary}`
}
