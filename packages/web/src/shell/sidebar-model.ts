/**
 * 侧栏「智能体站位」与插件资产可见性纯函数：
 * 从全量 Profile / 会话 / 插件 UI 贡献推导「每个 Agent 一个固定站位 + 下挂各自历史对话」，
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
import type { QualifiedUiSpec, ResolvedTarget } from '../lib/types.js'
import { resolveTargetString } from '../lib/types.js'

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

// ---------------------------------------------------------------------------
// 智能体站位（Agent Standings）
// ---------------------------------------------------------------------------

/** 左栏一级「智能体站位」：每个 Agent 一个固定站位，下挂其名下有效对话。 */
export interface AgentStanding {
  /** Agent 对应的 Profile ID（如 'assistant' | 'superagent' | 'watchdog' | 自定义 id）。 */
  profileId: string
  /** 左栏展示名（优先 sidebar.item 的 label -> profile.name -> profile.id）。 */
  label: string
  /** 排序权重（根会话/assistant 为 0，sidebar.item 指定 order 次之，其余 Profile 默认 100，孤儿兜底 200）。 */
  order: number
  /** 是否允许人类在该 Agent 下新建多个对话（由 isHumanSelectableProfile 决定；常驻单例为 false）。 */
  canCreateConversation: boolean
  /** 该 Agent 名下的所有有效对话（常驻/根会话置顶，其余按 updatedAt 倒序）。 */
  conversations: ConversationSummary[]
  /** 点击该 Agent 站位时的主对话（即 conversations[0] ?? null）。 */
  primaryConversation: ConversationSummary | null
}

/** 左栏独立「视图」分组的导航项（screen: 类型 sidebar.item 分流产物）。 */
export interface SidebarViewItem {
  key: string
  pluginId: string
  label: string
  icon: string
  order: number
  target: ResolvedTarget
}

export interface AgentStandingsInput {
  profiles: Profile[]
  conversations: ConversationSummary[]
  plugins: ReadonlyArray<{ id: string; enabled: boolean }>
  sidebarItems?: Array<QualifiedUiSpec<SidebarItemSpec>>
  sidebarSections?: Array<QualifiedUiSpec<SidebarSectionSpec>>
}

/** Agent 名下二级历史会话子列表默认显示条数（超出可展开）。 */
export const AGENT_SUB_LIST_PREVIEW = 5

/** 左栏展示名的 pin 元信息（按 profileId 归集）。 */
interface SidebarPinMeta {
  label?: string
  order?: number
}

/**
 * 构建左栏智能体站位列表：
 * - 可见 Profile 各占一个一级站位；未加载资产的会话按实际 profileId 展示；
 * - 会话指向型 sidebar.item 的 label/order 覆盖对应站位的默认展示；
 * - 人类自由会话按 profileId 归集到各自 Agent 下（Profile 已删时生成孤儿兜底站位）；
 * - 插件停用后其 managedByPlugin 站位与 ownedBy=helm/bot 遗留会话自动隐藏。
 */
export function buildAgentStandings(input: AgentStandingsInput): AgentStanding[] {
  const { profiles, conversations, plugins, sidebarItems = [], sidebarSections = [] } = input
  const enabledPluginIds = collectEnabledPluginIds(plugins)
  const partition = partitionSidebarUi(sidebarItems, sidebarSections)

  const visibleProfiles = profiles.filter((p) => isProfileVisible(p, enabledPluginIds))
  const visibleProfileIds = new Set(visibleProfiles.map((p) => p.id))

  // sidebar.item 会话指向项 -> profileId 展示元信息（screen: 视图项在此分流，不进站位）。
  const pinMeta = new Map<string, SidebarPinMeta>()
  const convById = new Map(conversations.map((c) => [c.id, c] as const))
  for (const item of sidebarItems) {
    const target = item.spec.target
    if (!target) continue
    let pid: string | null = null
    if (target.startsWith('conversation:profile:')) {
      pid = target.slice('conversation:profile:'.length).trim() || null
    } else if (target.startsWith('conversation:')) {
      const rest = target.slice('conversation:'.length).trim()
      if (/^\d+$/.test(rest)) {
        const idNum = Number(rest)
        pid = convById.get(idNum)?.profileId ?? null
      }
    }
    if (pid && !pinMeta.has(pid)) {
      pinMeta.set(pid, { label: item.spec.label, order: item.spec.order })
    }
  }

  // 可挂到 Agent 站位下的会话：
  // 1. 排除子代理派生会话（有父链）；
  // 2. 排除被 sidebar.section 接管的会话（后台 Worker 等分组展示，不重复挂载）；
  // 3. 非 human 会话仅保留可见 Profile 的常驻会话（ownedBy=helm 或被启用 sidebar.item 指向）。
  const attachable = conversations.filter((c) => {
    if (c.parentConversationId !== undefined) return false
    if (c.tags.some((t) => partition.sectionTags.has(t))) return false
    if ((c.ownedBy ?? 'human') === 'human') return true
    return (
      visibleProfileIds.has(c.profileId) &&
      (c.ownedBy === 'helm' ||
        partition.pinnedConversationIds.has(c.id) ||
        partition.pinnedProfileIds.has(c.profileId))
    )
  })

  const byProfile = new Map<string, ConversationSummary[]>()
  const orphanProfileIds = new Set<string>()
  for (const c of attachable) {
    const list = byProfile.get(c.profileId)
    if (list) list.push(c)
    else byProfile.set(c.profileId, [c])
    // 孤儿 Profile：人类历史对话的 Profile 已被删除（非被停用插件隐藏），兜底生成站位防丢失。
    if (
      (c.ownedBy ?? 'human') === 'human' &&
      !visibleProfileIds.has(c.profileId) &&
      !profiles.some((p) => p.id === c.profileId)
    ) {
      orphanProfileIds.add(c.profileId)
    }
  }

  // 站位内排序：常驻会话置顶，其余 updatedAt 倒序（同刻按 id 倒序）。
  const residentTier = (c: ConversationSummary): number => {
    if (c.ownedBy === 'helm') return 1
    if (partition.pinnedConversationIds.has(c.id)) return 2
    return 3
  }
  const sortAgentConversations = (list: ConversationSummary[]): ConversationSummary[] =>
    [...list].sort((a, b) => {
      const ta = residentTier(a)
      const tb = residentTier(b)
      if (ta !== tb) return ta - tb
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
      return b.id - a.id
    })

  const standings: AgentStanding[] = []
  const emitStanding = (
    profileId: string,
    profile: Profile | undefined,
    meta: SidebarPinMeta | undefined,
    order: number,
    canCreateConversation: boolean,
  ): void => {
    const sorted = sortAgentConversations(byProfile.get(profileId) ?? [])
    standings.push({
      profileId,
      label: meta?.label || profile?.name || profileId,
      order,
      canCreateConversation,
      conversations: sorted,
      primaryConversation: sorted[0] ?? null,
    })
  }

  for (const profile of visibleProfiles) {
    const meta = pinMeta.get(profile.id)
    const order = meta?.order ?? 100
    emitStanding(profile.id, profile, meta, order, isHumanSelectableProfile(profile, enabledPluginIds))
  }
  for (const pid of orphanProfileIds) {
    const meta = pinMeta.get(pid)
    emitStanding(pid, undefined, meta, meta?.order ?? 200, false)
  }

  standings.sort((a, b) => a.order - b.order || a.profileId.localeCompare(b.profileId))
  return standings
}

/**
 * 提取 sidebar.item 中 target 解析为 screen: 的视图导航项，
 * 供左栏独立「视图」分组渲染（与智能体站位彻底分流）。
 */
export function extractSidebarViews(
  sidebarItems: Array<QualifiedUiSpec<SidebarItemSpec>>,
  conversations: ConversationSummary[],
): SidebarViewItem[] {
  const views: SidebarViewItem[] = []
  for (const item of sidebarItems) {
    const target = item.spec.target
    if (!target) continue
    const resolved = resolveTargetString(target, conversations)
    if (resolved?.kind !== 'screen') continue
    views.push({
      key: `${item.pluginId}/${item.spec.id}`,
      pluginId: item.pluginId,
      label: item.spec.label,
      icon: item.spec.icon ?? 'panel-right',
      order: item.spec.order ?? 100,
      target: resolved,
    })
  }
  return views.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
}

// ---------------------------------------------------------------------------
// 插件痕迹清理：ownedBy / parentConversationId 归一 + 插件自举资产可见性
// ---------------------------------------------------------------------------

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
 * 人类可在该 Agent 下新建对话的 Profile：可见性之外仅依据通用
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

/** 会话状态圆点样式类：idle 状态返回 null（不显示圆点）。 */
export function conversationStatusDotClass(
  status: ConversationSummary['status'],
): string | null {
  if (status === 'idle') return null
  switch (status) {
    case 'working':
      return 'status-dot status-dot-working'
    case 'blocked':
      return 'status-dot status-dot-blocked'
    case 'done':
      return 'status-dot status-dot-done'
    case 'error':
      return 'status-dot status-dot-error'
    default:
      return 'status-dot'
  }
}

/** 会话状态悬浮提示文案；error 附带当前失败诊断摘要（lastError）。 */
export function conversationStatusTooltip(
  status: ConversationSummary['status'],
  doing?: string,
  lastError?: string,
): string {
  const base = conversationStatusLabel(status)
  if (status === 'working' && doing?.trim()) {
    return `${base}: ${doing.trim()}`
  }
  if (status === 'error' && lastError?.trim()) {
    return `${base}: ${lastError.trim()}`
  }
  return base
}

/**
 * 判断会话是否允许被人类删除：
 * - 插件托管或非人类拥有的会话（ownedBy !== 'human'，如 'helm' | 'bot'）不可删除；
 * - 普通人类会话（ownedBy 为 undefined 或 'human'）允许删除（无 id 级豁免；
 *   插件管理权保护在服务端 conversation_managed_by_plugin 统一判定）。
 */
export function isConversationDeletable(conv: Pick<ConversationSummary, 'id' | 'ownedBy'>): boolean {
  if ((conv.ownedBy ?? 'human') !== 'human') return false
  return true
}

/** 过滤出允许人类删除的会话列表。 */
export function filterDeletableConversations(conversations: ConversationSummary[]): ConversationSummary[] {
  return conversations.filter(isConversationDeletable)
}

// ---------------------------------------------------------------------------
// 双层导航：智能体行过滤 + 当前 Profile 话题列表
// ---------------------------------------------------------------------------

/**
 * 过滤智能体站位行：label / profileId 命中，或其名下任一会话标题 / #id 命中均保留
 * （命中会话标题时整行保留，用户在 Popover 中再精确定位话题）。
 */
export function filterAgentStandings(
  standings: AgentStanding[],
  query: string,
): AgentStanding[] {
  const q = query.trim().toLowerCase()
  if (!q) return standings
  const numeric = /^\d+$/.test(q) ? Number(q) : null
  return standings.filter(
    (agent) =>
      agent.label.toLowerCase().includes(q) ||
      agent.profileId.toLowerCase().includes(q) ||
      agent.conversations.some(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          (numeric !== null && c.id === numeric),
      ),
  )
}

/** 当前 Profile 的话题（根会话）行：供主舞台顶栏话题切换 Popover 消费。 */
export interface TopicListItem {
  conv: ConversationSummary
  active: boolean
}

/**
 * 构建当前 profileId 的话题列表：仅取无父链的根会话，稳定按
 * pinned 置顶 -> updatedAt 倒序 -> id 倒序排序；markActiveId 为当前激活会话。
 */
export function buildProfileTopics(
  conversations: ConversationSummary[],
  profileId: string,
  markActiveId: number | null,
): TopicListItem[] {
  const roots = conversations.filter(
    (c) => c.profileId === profileId && c.parentConversationId === undefined,
  )
  const sorted = [...roots].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    return b.id - a.id
  })
  return sorted.map((conv) => ({ conv, active: conv.id === markActiveId }))
}

/** 过滤话题列表：标题、#id（#10 或 10 形式）模糊匹配。 */
export function filterTopicList(items: TopicListItem[], query: string): TopicListItem[] {
  const raw = query.trim().toLowerCase()
  if (!raw) return items
  const numeric = /^#?(\d+)$/.exec(raw)
  const q = numeric ? numeric[1]! : raw
  return items.filter(
    (item) =>
      item.conv.title.toLowerCase().includes(q) ||
      (numeric !== null && String(item.conv.id).includes(q)),
  )
}

