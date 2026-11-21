/**
 * builtin:profile 技能目录 / 节点技能读取 action 的 Web 适配层。
 *
 * 契约（与插件后端约定，见黑板 #7）：
 * - `skill_catalog`：input `{ nodeId, cwd }` → `{ skills, shadowedNodeSkillIds,
 *   nodeUnavailable? }`，skills 为 Hub+node 合并目录（节点条目 source:'node'，
 *   同名只保留生效 Hub 版本），shadowedNodeSkillIds 显式报告被 Hub 同名
 *   遮蔽的节点技能 id，nodeUnavailable 为节点离线/IO 的显式诊断；
 * - `skill_read`：input `{ nodeId, cwd, skillId, path? }` → `{ text }`，只用于
 *   节点源技能（Hub 源技能继续走 /api/skills/:id/read）。
 *
 * Web 经 HTTP action 调用（不带 conversationId）；本模块在消费边界对输出做
 * 严格形状校验，非法输出显式抛错，绝不静默降级或编造数据。
 */
import type { SkillSummary } from '@helmx/protocol/browser'
import type { SkillScope } from './skill-scope-model.js'

export const SKILLS_PLUGIN_ID = 'builtin:profile'
export const SKILL_CATALOG_ACTION_ID = 'skill_catalog'
export const SKILL_READ_ACTION_ID = 'skill_read'

/** 宿主 action 调用面（生产为 store 的 invokePluginAction；测试可注入桩）。 */
export type SkillActionInvoker = (
  pluginId: string,
  actionId: string,
  input: unknown,
) => Promise<unknown>

/** 合并技能目录结果（已通过边界校验）。 */
export interface ScopedSkillCatalog {
  skills: SkillSummary[]
  shadowedNodeSkillIds: string[]
  nodeUnavailable?: string
}

const SKILL_SOURCE_VALUES = new Set(['data', 'agents', 'node'])

function catalogError(detail: string): Error {
  return new Error(`skill_catalog 输出不合法：${detail}`)
}

/** 校验单个技能摘要条目（字段级拒绝，不静默丢弃）。 */
function parseSkillSummaryEntry(raw: unknown, index: number): SkillSummary {
  if (typeof raw !== 'object' || raw === null) {
    throw catalogError(`skills[${index}] 不是对象`)
  }
  const record = raw as Record<string, unknown>
  const { id, name, references, managedByPlugin, source } = record
  if (typeof id !== 'string' || id.trim() === '') {
    throw catalogError(`skills[${index}].id 必须是非空字符串`)
  }
  if (typeof name !== 'string') {
    throw catalogError(`skills[${index}].name 必须是字符串`)
  }
  if (!Array.isArray(references) || references.some((ref) => typeof ref !== 'string')) {
    throw catalogError(`skills[${index}].references 必须是字符串数组`)
  }
  if (managedByPlugin !== undefined && typeof managedByPlugin !== 'string') {
    throw catalogError(`skills[${index}].managedByPlugin 必须是字符串`)
  }
  if (source !== undefined && (typeof source !== 'string' || !SKILL_SOURCE_VALUES.has(source))) {
    throw catalogError(`skills[${index}].source 必须是 data|agents|node`)
  }
  if (record.description !== undefined && typeof record.description !== 'string') {
    throw catalogError(`skills[${index}].description 必须是字符串`)
  }
  return {
    id,
    name,
    references: references as string[],
    ...(managedByPlugin !== undefined ? { managedByPlugin } : {}),
    ...(source !== undefined ? { source: source as SkillSummary['source'] } : {}),
    ...(record.description !== undefined ? { description: record.description as string } : {}),
  }
}

/** 边界校验 skill_catalog 输出（外部输入显式拒绝，绝不静默截断）。 */
export function parseSkillCatalogResult(raw: unknown): ScopedSkillCatalog {
  if (typeof raw !== 'object' || raw === null) {
    throw catalogError('返回值不是对象')
  }
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.skills)) {
    throw catalogError('skills 必须是数组')
  }
  const skills = record.skills.map((entry, index) => parseSkillSummaryEntry(entry, index))
  if (
    record.shadowedNodeSkillIds !== undefined &&
    (
      !Array.isArray(record.shadowedNodeSkillIds) ||
      record.shadowedNodeSkillIds.some((id) => typeof id !== 'string')
    )
  ) {
    throw catalogError('shadowedNodeSkillIds 必须是字符串数组')
  }
  if (record.nodeUnavailable !== undefined && typeof record.nodeUnavailable !== 'string') {
    throw catalogError('nodeUnavailable 必须是字符串')
  }
  return {
    skills,
    shadowedNodeSkillIds: (record.shadowedNodeSkillIds as string[] | undefined) ?? [],
    ...(record.nodeUnavailable !== undefined
      ? { nodeUnavailable: record.nodeUnavailable as string }
      : {}),
  }
}

/** 边界校验 skill_read 输出。 */
export function parseSkillReadResult(raw: unknown): { text: string } {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('skill_read 输出不合法：返回值不是对象')
  }
  const text = (raw as Record<string, unknown>).text
  if (typeof text !== 'string') {
    throw new Error('skill_read 输出不合法：text 必须是字符串')
  }
  return { text }
}

/** 拉取物理作用域的合并技能目录（Hub+node）。 */
export function fetchScopedSkillCatalog(
  invoke: SkillActionInvoker,
  scope: SkillScope,
): Promise<ScopedSkillCatalog> {
  return invoke(SKILLS_PLUGIN_ID, SKILL_CATALOG_ACTION_ID, {
    nodeId: scope.nodeId,
    cwd: scope.cwd,
  }).then((raw) => parseSkillCatalogResult(raw))
}

/** 读取节点源技能文件（path 缺省读主 SKILL.md，与 Hub 读取约定一致）。 */
export function readScopedSkillFile(
  invoke: SkillActionInvoker,
  scope: SkillScope,
  skillId: string,
  path?: string,
): Promise<{ text: string }> {
  return invoke(SKILLS_PLUGIN_ID, SKILL_READ_ACTION_ID, {
    nodeId: scope.nodeId,
    cwd: scope.cwd,
    skillId,
    ...(path !== undefined && path !== '' ? { path } : {}),
  }).then((raw) => parseSkillReadResult(raw))
}
