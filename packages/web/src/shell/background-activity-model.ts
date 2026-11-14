/**
 * 侧栏「会话后台在途」纯函数层（零 React/DOM 依赖，单测直测）。
 *
 * 数据源：复用通用 workbench.panel badge 契约——启用插件的
 * groupedUi.workbenchPanels 中声明 badge.byConversationField 的面板，其 public doc
 * 提供按会话索引的 { count, tone?, footerText? }（resolveWorkbenchPanelBadge 解析）。
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
 * - footerText 原样进入 tooltip 摘要（去重后「 · 」拼接），绝不解析字符串含义。
 */

import type { ConversationSummary, WorkbenchPanelSpec } from '@helm/protocol'
import type { QualifiedUiSpec } from '../lib/types.js'
import { matchesUiScope } from '../lib/types.js'
import { resolveWorkbenchPanelBadge } from '../conversation/workbench-model.js'
import { conversationStatusTooltip } from './sidebar-model.js'

/** 摘要片段分隔符（与工作台底部状态栏 footerText 拼接风格一致）。 */
const SUMMARY_SEPARATOR = ' · '

/** 单个会话的后台在途摘要（由命中面板的按会话角标聚合）。 */
export interface ConversationBackgroundActivity {
  /** 存在在途后台任务（任一命中面板的按会话角标 tone = 'accent'）。 */
  active: boolean
  /** 运行摘要文案：各命中角标 footerText 去重后拼接（可为空串）。 */
  summary: string
}

/** 会话后台在途索引（key: conversationId；侧栏各会话行按 id 查询）。 */
export type ConversationBackgroundIndex = ReadonlyMap<number, ConversationBackgroundActivity>

/**
 * 汇总每个会话的后台在途摘要：
 * - 只消费声明 badge.byConversationField 的启用面板，且会话必须命中 panel.spec.scope；
 * - tone = 'accent' 的按会话条目把该会话标记为在途并汇入 footerText；
 * - 插件停用后其 UI 贡献与 doc 均从 store 消失，本函数自然归零。
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
      const footer = resolved.footerText?.trim() ?? ''
      const prev = result.get(conversation.id)
      const parts = prev === undefined ? [] : prev.summary === '' ? [] : prev.summary.split(SUMMARY_SEPARATOR)
      if (footer !== '' && !parts.includes(footer)) parts.push(footer)
      result.set(conversation.id, { active: true, summary: parts.join(SUMMARY_SEPARATOR) })
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
 * - representative：名下基础状态优先级最高的会话（error > blocked > working，
 *   并列取列表首个即常驻/最新置顶序；无更高优先级时保持列表首个，与既有
 *   「看 primaryConversation」行为兼容）——支持后台在途来自非 primary 会话；
 * - backgroundActive / backgroundSummary：名下任一会话的后台在途聚合
 *   （footerText 去重拼接）。空心环与基础圆点并列呈现，两者同时透出，
 *   展开态由子会话行各自呈现，站位行不再重复。
 */
export interface StandingStatusIndicator {
  representative: ConversationSummary
  backgroundActive: boolean
  backgroundSummary: string
}

/** 基础状态聚合优先级：error 最需人介入，blocked 次之，working 再次；done/idle 不参与竞争。 */
const STANDING_STATUS_RANK: Record<string, number> = {
  error: 3,
  blocked: 2,
  working: 1,
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
 * 组合悬浮提示：基础会话状态（五态文案 + doing/lastError 诊断）叠加后台运行摘要。
 * 空心环不得误导为会话自身 working，tooltip 必须同时陈述两者。
 */
export function backgroundAwareStatusTooltip(input: {
  status: ConversationSummary['status']
  doing?: string
  lastError?: string
  backgroundActive: boolean
  backgroundSummary?: string
}): string {
  const base = conversationStatusTooltip(input.status, input.doing, input.lastError)
  if (!input.backgroundActive) return base
  const summary = input.backgroundSummary?.trim() ?? ''
  return summary === '' ? `${base} · 后台任务运行中` : `${base} · 后台任务: ${summary}`
}
