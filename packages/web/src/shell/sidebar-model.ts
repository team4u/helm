/**
 * 侧栏会话分组与插件资产可见性纯函数：从全量会话中推导「我的对话」列表，
 * 并按插件启用状态判定自举 Profile / Skill 的显隐。
 * 纯函数无 React 依赖，供 Sidebar / 各编辑弹窗渲染与单测共同消费。
 */

import type {
  ConversationSummary,
  Profile,
  SidebarItemSpec,
  SidebarSectionSpec,
  SkillSummary,
} from '@helm/protocol'
import { ROOT_CONVERSATION_ID } from '@helm/protocol'
import type { QualifiedUiSpec } from '../lib/types.js'

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
}

/** 一次性推导侧栏全部分组（分组本体由插件 sidebar.section 声明，此处仅产出「我的对话」）。 */
export function buildSidebarGroups(
  conversations: ConversationSummary[],
  sidebarItems: Array<QualifiedUiSpec<SidebarItemSpec>>,
  sidebarSections: Array<QualifiedUiSpec<SidebarSectionSpec>>,
): SidebarGroups {
  return {
    partition: partitionSidebarUi(sidebarItems, sidebarSections),
    humanConversations: selectHumanConversations(conversations, partitionSidebarUi(sidebarItems, sidebarSections)),
  }
}

/**
 * 插件自举资产的可见性纯函数：
 * 插件未启用时，其自举/托管的 Profile 与 Skill 在所有消费界面隐藏，
 * 不残留插件痕迹。判定仅依据资产自身携带的 managedByPlugin 字段，
 * 不按 id / 插件名猜测，无新增兑底。
 */

/** 收集已启用插件 ID 集合（资产可见性判定的统一输入）。 */
export function collectEnabledPluginIds(
  plugins: ReadonlyArray<{ id: string; enabled: boolean }>,
): Set<string> {
  return new Set(plugins.filter((p) => p.enabled).map((p) => p.id))
}

/** 插件自举/托管的 Profile 在对应插件未启用时隐藏（Profile 编辑器列表消费）。 */
export function isProfileVisible(profile: Profile, enabledPluginIds: ReadonlySet<string>): boolean {
  return profile.managedByPlugin === undefined || enabledPluginIds.has(profile.managedByPlugin)
}

/**
 * 人类可在「新建对话」下拉中选择的 Profile：可见性之外仅依据通用
 * humanSelectable 字段（常驻单例角色由托管插件置 false，缺省 true），
 * 不按插件 id / 固定角色 id 排除。
 */
export function isHumanSelectableProfile(
  profile: Profile,
  enabledPluginIds: ReadonlySet<string>,
): boolean {
  if (!isProfileVisible(profile, enabledPluginIds)) return false
  return profile.humanSelectable !== false
}

/** 插件自举/托管的 Skill 在对应插件未启用时隐藏（技能库与 / 斜杠菜单消费）。 */
export function isSkillVisible(skill: SkillSummary, enabledPluginIds: ReadonlySet<string>): boolean {
  return skill.managedByPlugin === undefined || enabledPluginIds.has(skill.managedByPlugin)
}

/**
 * 「我的对话」去重与归属规则：
 * - 排除根会话；
 * - 排除插件/内核托管会话（ownedBy 非 human）与子代理派生的子会话；
 * - 排除被 sidebar.item 指向或命中 sidebar.section filterTag 的会话（插件启用时的去重）。
 * 仅返回属于人类自己的自由对话，按 updatedAt 倒序。
 */
export function selectHumanConversations(
  conversations: ConversationSummary[],
  partition: SidebarPartition,
): ConversationSummary[] {
  return conversations
    .filter((c) => c.id !== ROOT_CONVERSATION_ID)
    .filter((c) => (c.ownedBy ?? 'human') === 'human')
    .filter((c) => c.parentConversationId === undefined)
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
