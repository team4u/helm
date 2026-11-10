/**
 * 会话斜杠菜单技能可用性（Composer '/' 补全与 CommandPopover fallback 共用）。
 *
 * 规则唯一来源是协议 isSkillAvailable：当前会话 profile.skills 白名单 +
 * 插件启用状态双过滤。缺少当前 Profile 时先不展示技能（宁缺勿放开），
 * 等资产到达后自然出现。
 */

import type { Profile, SkillSummary } from '@helm/protocol'
import { isSkillAvailable } from '@helm/protocol'

/**
 * 当前会话可出现在 / 斜杠菜单的技能：
 * - profile 缺失（资产未返回 / Profile 已删）-> 空数组，不意外放开全部；
 * - profile.skills 未设置 -> 全部可见技能；
 * - [] -> 无技能；非空 -> 白名单；
 * - 托管插件停用的技能恒不可用。
 */
export function slashMenuSkills(
  profile: Profile | undefined,
  skills: ReadonlyArray<SkillSummary>,
  enabledPluginIds: ReadonlySet<string>,
): SkillSummary[] {
  if (profile === undefined) return []
  return skills.filter((s) => isSkillAvailable(s, profile, enabledPluginIds))
}
