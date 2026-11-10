/**
 * builtin:profile 跨 Profile 协作目录（纯函数，无 IO / 无宿主依赖）。
 *
 * 目录用途：让当前会话「知道还有哪些角色可点名」（@id 协作约定）与
 * subagent / SubagentWorkflow 的 agentType 候选。它只是一份认知目录：
 * - 不是权限沙箱：不做任何访问控制承诺；
 * - 不承诺候选运行时健康：listUi 的 profile.runtime 贡献只证明「声明该
 *   kind 的插件当前已启用」，未注册 UI 只挂 agent_spawn 钩子的第三方
 *   运行时不出现在目录中（保守可见，不冒充全集）；
 * - 实时重读：Profile 增删改与插件启停在下次请求 / 回合生效。
 *
 * 排除规则（缺省不鼓励嵌套协作，不是硬深度限制）：
 * - 排除当前会话自身 Profile（自己不能点名自己）；
 * - 排除 humanSelectable === false（常驻单例角色不面向人类选择）；
 * - 排除 managedByPlugin 指向未启用插件的 Profile（托管插件停用即隐藏）；
 * - 排除 runtime.kind 无任何已启用 profile.runtime UI 贡献对应的 Profile
 *  （外部运行时未被插件接管时原生执行行会显式拒绝，不进入目录误导）。
 */

import type { PluginUiContribution, Profile } from '@helm/protocol'

/** 补全摘要上限：100 Unicode 码点（与 PROFILE_STARTER 同口径的展示直觉）。 */
export const PROFILE_SUMMARY_MAX_CODEPOINTS = 100

/** 协作目录条目（纯数据；XML 渲染与补全条目由消费方派生）。 */
export interface ProfileCatalogEntry {
  id: string
  name: string
  /** 'native' 或外部运行时 kind（如 'herdr'；来自 profile.runtime.kind）。 */
  runtimeKind: string
  /** runtime.kind 对应的运行时是否已由插件声明接管（profile.runtime UI 贡献存在）。 */
  runtimeAvailable: boolean
  /** 候选 SYSTEM.md 首个非标题自然段摘要；缺失为 undefined（不伪造）。 */
  summary?: string
  /** 展示用执行位置（Profile 显式配置；undefined = 继承调用方上下文）。 */
  nodeId?: string
  /** 展示用工作目录（runtime.workspace 覆盖顶层 cwd；undefined = 继承）。 */
  cwd?: string
}

/** 已启用插件集合的最小形状（PluginHost.list() 消费方子集）。 */
export interface EnabledPluginsLike {
  id: string
  enabled: boolean
}

/** 按 runtime.kind 建立已声明接管的 kind 集合（仅 kind 字符串，不假设插件 id）。 */
export function activeRuntimeKinds(ui: readonly PluginUiContribution[]): Set<string> {
  const kinds = new Set<string>()
  for (const contribution of ui) {
    if (contribution.surface !== 'profile.runtime') continue
    const kind = (contribution.spec as { kind?: unknown }).kind
    if (typeof kind === 'string' && kind.length > 0) kinds.add(kind)
  }
  return kinds
}

/** 单个 Profile 是否可进入协作目录（排除规则见模块头注释）。 */
export function isCollaborationCandidate(
  profile: Profile,
  currentProfileId: string,
  enabledPluginIds: ReadonlySet<string>,
  runtimeKinds: ReadonlySet<string>,
): boolean {
  if (profile.id === currentProfileId) return false
  if (profile.humanSelectable === false) return false
  if (profile.managedByPlugin !== undefined && !enabledPluginIds.has(profile.managedByPlugin)) return false
  const runtime = profile.runtime
  if (runtime !== undefined && !runtimeKinds.has(runtime.kind)) return false
  return true
}

/** 目录条目构造（纯投影：不做摘要提取，summary 由调用方按需补充）。 */
export function toCatalogEntry(profile: Profile): ProfileCatalogEntry {
  const runtime = profile.runtime
  return {
    id: profile.id,
    name: profile.name ?? profile.id,
    runtimeKind: runtime?.kind ?? 'native',
    runtimeAvailable: runtime === undefined,
    summary: undefined,
    nodeId: profile.nodeId,
    // runtime.workspace 是外部执行目录（覆盖顶层 cwd 语义）；原生路径沿用 cwd。
    cwd: runtime?.workspace ?? profile.cwd,
  }
}

// ---------------------------------------------------------------------------
// SYSTEM.md 摘要提取
// ---------------------------------------------------------------------------

/**
 * 逐行跳过 YAML frontmatter（--- 围栏）、围栏代码块（``` / ~~~）与标题行
 * （# 开头），返回首个非空自然段（多行段折叠为单行；列表项 / 引用块 /
 * HTML 标签行跳过，避免取出伪标题或标签内 metadata）。
 * 无合法自然段时返回 undefined（调用方不伪造简介）。
 */
export function extractSystemSummary(systemMd: string): string | undefined {
  if (typeof systemMd !== 'string') return undefined
  const lines = systemMd.split(/\r?\n/)
  let inFrontmatter = false
  let frontmatterSeen = false
  let fence: string | undefined
  const paragraph: string[] = []
  let started = false

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    if (fence !== undefined) {
      // 围栏代码块内：只认闭合围栏。
      if (line.trimStart().startsWith(fence)) fence = undefined
      continue
    }
    if (!started && !frontmatterSeen && line.trim() === '---') {
      inFrontmatter = true
      frontmatterSeen = true
      continue
    }
    if (inFrontmatter) {
      if (line.trim() === '---' || line.trim() === '...') inFrontmatter = false
      continue
    }
    const fenceMatch = /^(\s*)(```|~~~)/.exec(line)
    if (fenceMatch !== null) {
      fence = fenceMatch[2]!
      continue
    }
    // 段落已开始：空行结束本段。
    if (paragraph.length > 0 && line.trim() === '') break
    const candidate = line.trim()
    if (candidate === '') continue
    // 标题 / 列表 / 引用 / HTML 标签 / 表格行都不是自然段正文。
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|<[A-Za-z/!]|\\?<!--|\|)/.test(candidate)) continue
    paragraph.push(candidate)
    started = true
    if (paragraph.length >= 12) break // 防御性上限：超长畸形段落不再继续吞行
  }
  if (paragraph.length === 0) return undefined
  return truncateCodePoints(paragraph.join(' '), PROFILE_SUMMARY_MAX_CODEPOINTS)
}

/** 按码点截断（代理对计 1）；超长加省略号标记（省略号计入上限）。 */
export function truncateCodePoints(text: string, maxCodePoints: number): string {
  const chars = [...text]
  if (chars.length <= maxCodePoints) return text
  return `${chars.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`
}

/** XML 文本转义（与 profile.ts 主插件同一实现口径，供目录渲染复用）。 */
export function escapeXmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/**
 * 渲染 profile.catalog 注入段（<available_profiles>）：每条候选一行紧凑
 * XML 条目，全部动态字段经转义。runtime 标注：native=原生 subagent；
 * external:kind=外部运行时（外部运行时不加载该 Profile 的 SYSTEM /
 * skills / MEMORY，执行环境与生命周期和原生会话不同）。
 */
export function renderProfileCatalogSection(
  entries: readonly ProfileCatalogEntry[],
  options: { dispatchToolNames: readonly string[] },
): string {
  const lines = entries.map((entry) => {
    const attrs = [`id="${escapeXmlText(entry.id)}"`, `name="${escapeXmlText(entry.name)}"`]
    attrs.push(
      entry.runtimeKind === 'native'
        ? 'runtime="native"'
        : `runtime="external:${escapeXmlText(entry.runtimeKind)}"`,
    )
    const position = describePosition(entry)
    if (position !== undefined) attrs.push(`at="${escapeXmlText(position)}"`)
    const inner = entry.summary !== undefined ? escapeXmlText(entry.summary) : ''
    return `<profile ${attrs.join(' ')}>${inner}</profile>`
  })
  const tools = options.dispatchToolNames.length > 0 ? options.dispatchToolNames.join(' / ') : '（本回合无派工工具）'
  return [
    '<available_profiles>',
    '可 @点名 协作的角色目录（@<id> 是纯文本点名约定，不是必然执行的指令；引用或代码中的 @ 不代表派工）：',
    ...lines,
    '协作指引：',
    `- 需要委派任务时用 ${tools} 的 agentType 指定 Profile id；缺省不主动转发用户消息（主持串并联，不劫持输入）。`,
    '- 点名只是让对应角色在需要时参与；不自动读取对方 SYSTEM/MEMORY 全文，不复制本会话全部历史，只在必要时转述任务所需上下文。',
    '- 附件只能传递当前会话有权使用的产物（自己或父链产出）；兄弟/子孙会话的产物不能直接转发。',
    '- node/cwd 不同的会话没有自动文件同步：不能把本机路径当远端文件；执行位置见 at 属性（未标注则继承当前会话）。',
    '- 原生子会话的 resume 沿用父子归属与空闲要求；external 运行时生命周期由其插件管理（如 Herdr 终端窗格），两者语义不同，不承诺任意永久 resume。',
    '</available_profiles>',
  ].join('\n')
}

/** 位置展示串：node 与目录至少其一显式配置时返回，否则 undefined（继承）。 */
export function describePosition(entry: Pick<ProfileCatalogEntry, 'nodeId' | 'cwd'>): string | undefined {
  if (entry.nodeId === undefined && entry.cwd === undefined) return undefined
  return [entry.nodeId ?? '继承当前会话节点', entry.cwd ?? '继承当前会话目录'].join(' · ')
}

/** 补全 hint：位置 + 摘要（均可能缺省）。 */
export function describeHint(entry: ProfileCatalogEntry): string {
  const parts: string[] = []
  const position = describePosition(entry)
  if (position !== undefined) parts.push(position)
  else parts.push('继承当前会话节点与目录')
  if (entry.summary !== undefined) parts.push(entry.summary)
  return parts.join(' · ')
}
