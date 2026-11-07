/**
 * 侧栏会话分组纯函数：从全量会话中推导「我的对话」列表，
 * 自动排除 #1 根会话、sidebar.item 常驻指向的 profile 会话、
 * 以及已命中 sidebar.section（worker / worker-archived）的后台会话。
 * 纯函数无 React 依赖，供 Sidebar 渲染与单测共同消费。
 */

import type {
  ConversationSummary,
  SidebarItemSpec,
  SidebarSectionSpec,
} from '@helm/protocol'
import type { QualifiedUiSpec } from '../lib/types.js'

/** 根会话 ID 固定为 1（与 ROOT_CONVERSATION_ID 一致，此处避免引入运行时常量依赖）。 */
export const ROOT_CONVERSATION = 1

/** 内置「已归档 Worker」分组标签（即使插件未声明 sidebar.section 也收纳该分组）。 */
export const ARCHIVED_WORKER_TAG = 'worker-archived'

export interface SidebarPartition {
  /** sidebar.item 的 'conversation:profile:<id>' 已指向的 profileId 集合。 */
  pinnedProfileIds: Set<string>
  /** sidebar.item 的 'conversation:<id>' 已指向的会话 ID 集合。 */
  pinnedConversationIds: Set<number>
  /** sidebar.section 声明的过滤标签集合（如 'worker'、'worker-archived'）。 */
  sectionTags: Set<string>
}

/** 从 UI 贡献中提取 sidebar.item / sidebar.section 的去重规则输入。 */
export function partitionSidebarUi(
  sidebarItems: Array<QualifiedUiSpec<SidebarItemSpec>>,
  sidebarSections: Array<QualifiedUiSpec<SidebarSectionSpec>>,
): SidebarPartition {
  const pinnedProfileIds = new Set<string>()
  const pinnedConversationIds = new Set<number>()
  const sectionTags = new Set<string>()

  for (const item of sidebarItems) {
    const target = item.spec.target
    if (!target) continue
    if (target.startsWith('conversation:profile:')) {
      const pid = target.slice('conversation:profile:'.length).trim()
      if (pid) pinnedProfileIds.add(pid)
    } else if (target.startsWith('conversation:')) {
      const rest = target.slice('conversation:'.length).trim()
      if (rest.startsWith('profile:') || rest.startsWith('tag:')) continue
      const idNum = Number(rest)
      if (Number.isInteger(idNum) && idNum > 0) pinnedConversationIds.add(idNum)
    }
  }
  for (const section of sidebarSections) {
    const tag = section.spec.filterTag?.trim()
    if (tag) sectionTags.add(tag)
  }
  return { pinnedProfileIds, pinnedConversationIds, sectionTags }
}

/** sidebar.section 过滤：会话 tags 命中 filterTag 即属该分组。 */
export function filterConversationsByTag(
  conversations: ConversationSummary[],
  tag: string,
): ConversationSummary[] {
  return conversations.filter((c) => c.tags.includes(tag))
}

export interface SidebarGroups {
  /** sidebar.item / sidebar.section 去重规则输入。 */
  partition: SidebarPartition
  /** 人类自由对话列表（已去重，updatedAt 倒序）。 */
  humanConversations: ConversationSummary[]
  /** 已归档 Worker 会话（worker-archived 标签，updatedAt 倒序）。 */
  archivedWorkers: ConversationSummary[]
}

/** 一次性推导侧栏全部分组（含内置已归档 Worker 收纳）。 */
export function buildSidebarGroups(
  conversations: ConversationSummary[],
  sidebarItems: Array<QualifiedUiSpec<SidebarItemSpec>>,
  sidebarSections: Array<QualifiedUiSpec<SidebarSectionSpec>>,
): SidebarGroups {
  const partition = partitionSidebarUi(sidebarItems, sidebarSections)
  // 内置「已归档 Worker」分组即使没有插件声明 section 也要收纳并从人类列表排除。
  const effectiveTags = new Set([...partition.sectionTags, ARCHIVED_WORKER_TAG])
  const effectivePartition: SidebarPartition = { ...partition, sectionTags: effectiveTags }
  return {
    partition,
    humanConversations: selectHumanConversations(conversations, effectivePartition),
    archivedWorkers: filterConversationsByTag(conversations, ARCHIVED_WORKER_TAG).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    ),
  }
}

/**
 * 「我的对话」去重规则：
 * - 排除 #1 根会话；
 * - 排除被 sidebar.item 以 'conversation:profile:<id>' 指向的常驻中枢/看门狗会话；
 * - 排除被 sidebar.item 以 'conversation:<id>' 直接指向的会话；
 * - 排除命中任一 sidebar.section filterTag（worker / worker-archived 等）的后台会话；
 * 仅返回属于人类自己的自由对话，按 updatedAt 倒序。
 */
export function selectHumanConversations(
  conversations: ConversationSummary[],
  partition: SidebarPartition,
): ConversationSummary[] {
  return conversations
    .filter((c) => c.id !== ROOT_CONVERSATION)
    .filter((c) => !partition.pinnedProfileIds.has(c.profileId))
    .filter((c) => !partition.pinnedConversationIds.has(c.id))
    .filter((c) => !c.tags.some((t) => partition.sectionTags.has(t)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 按标题或 #id 模糊过滤会话（供命令面板快速跳转）。 */
export function fuzzyMatchConversations(
  conversations: ConversationSummary[],
  query: string,
): ConversationSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const numeric = /^\d+$/.test(q) ? Number(q) : null
  return conversations.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.profileId.toLowerCase().includes(q) ||
      (numeric !== null && c.id === numeric),
  )
}

/** 会话五态的展示文案。 */
export function conversationStatusLabel(status: ConversationSummary['status']): string {
  switch (status) {
    case 'working':
      return '运行中'
    case 'blocked':
      return '待确认'
    case 'done':
      return '已完成'
    case 'idle':
      return '空闲'
    case 'error':
      return '异常'
    default:
      return status
  }
}

/** 会话五态对应的徽章样式类。 */
export function conversationStatusBadgeClass(status: ConversationSummary['status']): string {
  switch (status) {
    case 'working':
      return 'badge badge-accent'
    case 'blocked':
      return 'badge badge-warn'
    case 'done':
      return 'badge badge-ok'
    case 'error':
      return 'badge badge-err'
    default:
      return 'badge badge-neutral'
  }
}
