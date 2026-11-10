/**
 * Profile 编辑器「可用技能」区块纯逻辑（ProfileBasicTab SkillsSection 消费）。
 *
 * 语义对齐协议 isSkillAvailable：undefined = 全部可用技能；[] = 显式禁用全部；
 * 非空数组 = 白名单。停用插件托管的技能永远不可选（不可新勾选），
 * 但已配置在白名单里的失效技能（缺失 / 插件停用）必须保留展示、可移除，
 * 保存其它字段时不得暗中删除。
 */

import type { Profile, SkillSummary } from '@helm/protocol'

/** 技能区块的三种编辑模式：跟随全部（skills=undefined）/ 白名单 / 显式禁用（skills=[]）。 */
export type SkillsEditMode = 'all' | 'allowlist' | 'none'

/** 从 Profile.skills 推断编辑模式（undefined -> all，[] -> none，非空 -> allowlist）。 */
export function skillsEditMode(skills: string[] | undefined): SkillsEditMode {
  if (skills === undefined) return 'all'
  return skills.length === 0 ? 'none' : 'allowlist'
}

/** 模式切换：all 将 skills 置 undefined；none 置 []；allowlist 保持现有白名单（空则起于 []）。 */
export function skillsForEditMode(skills: string[] | undefined, mode: SkillsEditMode): string[] | undefined {
  switch (mode) {
    case 'all':
      return undefined
    case 'none':
      return []
    case 'allowlist':
      return skills ?? []
  }
}

/**
 * 白名单勾选切换：勾选仅允许可选技能（停用/缺失拒绝）；移除恒生效（含不可用技能的显式移除）。
 */
export function toggleSkillInAllowlist(
  skills: string[],
  skillId: string,
  checked: boolean,
  selectableIds: ReadonlySet<string>,
): string[] {
  if (checked) {
    if (!selectableIds.has(skillId)) return skills
    return skills.includes(skillId) ? skills : [...skills, skillId]
  }
  return skills.filter((id) => id !== skillId)
}

export interface SkillEditRow {
  skill: SkillSummary
  /** 白名单已包含（含失效技能——保留展示）。 */
  checked: boolean
  /** 可新勾选：可见（托管插件启用）技能才可选；停用托管技能不可勾选。 */
  selectable: boolean
  /** 已配置但缺失（技能目录已无此 id）——不可勾选、可移除。 */
  missing: boolean
  /** 已配置但托管插件停用——不可勾选、可移除。 */
  pluginDisabled: boolean
}

export interface SkillsSectionModel {
  /** 可见技能（托管插件启用），即可勾选范围。 */
  visible: SkillEditRow[]
  /** 已配置但失效的技能（缺失 / 插件停用），保留展示与移除入口。 */
  unavailable: SkillEditRow[]
}

/**
 * 组装技能区块行模型：
 * - 可见技能按目录顺序全部列出（勾选状态来自白名单，未配置为未勾选）；
 * - 白名单中目录已无对应技能的 id 生成 missing 行；
 * - 白名单中托管插件停用的技能生成 pluginDisabled 行（目录里存在但不可选）；
 * - undefined（全部）模式下仅展示可见技能清单，无任何失效行。
 */
export function buildSkillsSectionModel(
  skills: string[] | undefined,
  catalog: ReadonlyArray<SkillSummary>,
  enabledPluginIds: ReadonlySet<string>,
): SkillsSectionModel {
  const allowlist = skills !== undefined ? new Set(skills) : null
  const visible: SkillEditRow[] = []
  const unavailable: SkillEditRow[] = []
  const byId = new Map(catalog.map((s) => [s.id, s] as const))

  for (const skill of catalog) {
    const pluginEnabled = skill.managedByPlugin === undefined || enabledPluginIds.has(skill.managedByPlugin)
    const checked = allowlist?.has(skill.id) ?? false
    const row: SkillEditRow = {
      skill,
      checked,
      selectable: pluginEnabled,
      missing: false,
      pluginDisabled: !pluginEnabled,
    }
    if (pluginEnabled) visible.push(row)
    else if (checked) unavailable.push(row)
  }

  if (allowlist !== null) {
    for (const id of allowlist) {
      if (byId.has(id)) continue
      unavailable.push({
        skill: { id, name: id, references: [] },
        checked: true,
        selectable: false,
        missing: true,
        pluginDisabled: false,
      })
    }
  }

  return { visible, unavailable }
}
