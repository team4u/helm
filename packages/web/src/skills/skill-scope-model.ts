/**
 * 技能作用域纯函数模型：技能中心与 '/' 技能菜单共用的物理坐标
 * (nodeId, cwd) 作用域推导、URL 参数解析与候选去重。
 *
 * 作用域语义（与 builtin:profile 节点技能契约一致）：
 * - Hub 默认作用域用 undefined 表达（消费 /api/skills 的 Hub 目录真源）；
 * - 物理作用域必须同时具备 nodeId 与 cwd；nodeId 缺省归一为 'local'；
 * - URL 侧按 agent 待命目标先例，以 skills 目标自身的顶层 `node` / `cwd`
 *   查询参数携带（主屏顶层、分屏在 split 值内编码）；两键必须成对出现——
 *   半参数按 Hub 处理并由调用方自愈清理，绝不猜测工作区。
 *
 * 遵循 Fast Refresh 约定：纯函数与常量只放本模块，不进组件文件。
 */
import type { ConversationSummary, Profile, SkillSummary } from '@helmx/protocol/browser'

/** 一个物理技能作用域（两者必有值）。 */
export interface SkillScope {
  nodeId: string
  cwd: string
}

/** 作用域候选来源：会话坐标或角色显式 cwd。 */
export type SkillScopeOrigin = 'conversation' | 'profile'

export interface SkillScopeCandidate extends SkillScope {
  origin: SkillScopeOrigin
}

/** nodeId 归一：空白/缺省视为 'local'（与内核会话坐标缺省语义一致）。 */
export function normalizeSkillScopeNodeId(nodeId: string | undefined): string {
  const trimmed = (nodeId ?? '').trim()
  return trimmed === '' ? 'local' : trimmed
}

/** 稳定作用域键（组件依赖数组与缓存共用）。 */
export function skillScopeKey(scope: SkillScope): string {
  return `${scope.nodeId}\u0000${scope.cwd}`
}

/**
 * 会话 / 待命草稿环境的物理作用域：cwd 缺失（理论不可达的占位会话）
 * 返回 undefined 按 Hub 处理，绝不编造工作区路径。
 */
export function conversationSkillScope(
  conversation: { nodeId?: string; cwd?: string },
): SkillScope | undefined {
  const cwd = (conversation.cwd ?? '').trim()
  if (cwd === '') return undefined
  return { nodeId: normalizeSkillScopeNodeId(conversation.nodeId), cwd }
}

/**
 * 作用域候选去重列表：会话坐标在前（按 updatedAt 倒序，最近使用的最先），
 * 角色显式 cwd（profile.cwd 有值）在后；同一 (nodeId, cwd) 只保留一个候选，
 * 会话来源优先。Hub 默认项不由本函数产出（恒为选择器第一项）。
 */
export function buildSkillScopeCandidates(
  conversations: ReadonlyArray<Pick<ConversationSummary, 'nodeId' | 'cwd' | 'updatedAt'>>,
  profiles: ReadonlyArray<Pick<Profile, 'nodeId' | 'cwd'>>,
): SkillScopeCandidate[] {
  const seen = new Set<string>()
  const out: SkillScopeCandidate[] = []
  const sortedConversations = [...conversations].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  )
  for (const conversation of sortedConversations) {
    const scope = conversationSkillScope(conversation)
    if (scope === undefined) continue
    const key = skillScopeKey(scope)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...scope, origin: 'conversation' })
  }
  for (const profile of profiles) {
    const cwd = (profile.cwd ?? '').trim()
    if (cwd === '') continue
    const scope: SkillScope = { nodeId: normalizeSkillScopeNodeId(profile.nodeId), cwd }
    const key = skillScopeKey(scope)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...scope, origin: 'profile' })
  }
  return out
}

/** skills 目标的作用域环境面（hash 顶层 node/cwd 查询参数的目标侧形状）。 */
export interface SkillScopeEnv {
  nodeId?: string
  cwd?: string
}

export interface ParsedSkillScopeEnv {
  /** 完整物理作用域；undefined 表示 Hub 默认。 */
  scope: SkillScope | undefined
  /** 目标携带了 node/cwd 但不成对（或全空白）：值不可信，调用方应以 replace 自愈清理。 */
  partial: boolean
}

/**
 * 从 skills 目标的环境字段解析作用域：node 与 cwd 都非空才构成物理作用域；
 * 只出现其一（或全空白）标记 partial 交由调用方清理，绝不静默猜测。
 */
export function parseSkillScopeEnv(env: SkillScopeEnv | undefined): ParsedSkillScopeEnv {
  const rawNode = env?.nodeId
  const rawCwd = env?.cwd
  const node = rawNode?.trim() ?? ''
  const cwd = rawCwd?.trim() ?? ''
  if (node !== '' && cwd !== '') {
    return { scope: { nodeId: node, cwd }, partial: false }
  }
  return { scope: undefined, partial: rawNode !== undefined || rawCwd !== undefined }
}

/** 作用域 → skills 目标环境字段（Hub 为清空两字段；空串不序列化）。 */
export function skillScopeTargetEnv(
  scope: SkillScope | undefined,
  keep?: { skillId?: string },
): { kind: 'skills'; skillId?: string; nodeId?: string; cwd?: string } {
  const base = { kind: 'skills' as const, ...(keep?.skillId !== undefined && keep.skillId !== '' ? { skillId: keep.skillId } : {}) }
  if (scope === undefined) return base
  return { ...base, nodeId: scope.nodeId, cwd: scope.cwd }
}

/** 待命草稿的有效环境作用域：显式定制（envCustomized）优先，否则回退角色
 * 显式 cwd；两处都无 cwd 时返回 undefined（Hub 基底）——运行时才决定的
 * 工作区不在 Web 侧猜测。 */
export function standbySkillScope(
  draft: { envCustomized: boolean; envNodeId?: string; envCwd?: string },
  profile: { nodeId?: string; cwd?: string } | undefined,
): SkillScope | undefined {
  if (draft.envCustomized) {
    const cwd = (draft.envCwd ?? '').trim()
    if (cwd === '') return undefined
    return { nodeId: normalizeSkillScopeNodeId(draft.envNodeId), cwd }
  }
  const cwd = (profile?.cwd ?? '').trim()
  if (cwd === '') return undefined
  return { nodeId: normalizeSkillScopeNodeId(profile?.nodeId), cwd }
}

/** 合并目录里属于节点工作区来源的技能。 */
export function isNodeSourceSkill(skill: SkillSummary): boolean {
  return skill.source === 'node'
}
