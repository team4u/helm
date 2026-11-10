/**
 * 技能中心纯函数模型与分类过滤
 *
 * 提供技能分类推导、多维检索（名称/ID/描述/参考文件）、来源区分及指标统计。
 * 遵循前端 Fast Refresh 规范：纯函数、常量与数据模型统一定义于此，不与组件混写。
 */
import type { SkillSummary } from '@helm/protocol'
import { assetsApi } from '../lib/api.js'

export type SkillCategoryTab = 'all' | 'builtin' | 'workspace' | 'plugins'

export interface SkillFilterOptions {
  query: string
  categoryTab: SkillCategoryTab
}

export interface SkillSummaryStats {
  total: number
  builtin: number
  plugins: number
  workspace: number
}

/**
 * 判断技能是否为系统内置核心技能：
 * - managedByPlugin 声明以 'builtin:' 起头
 * - 或 ID 为系统内建受管技能 'helm-cli'
 */
export function isSkillBuiltin(skill: SkillSummary): boolean {
  return Boolean(skill.managedByPlugin?.startsWith('builtin:') || skill.id === 'helm-cli')
}

/**
 * 判断技能是否由三方/外部扩展插件托管：
 * - managedByPlugin 有值且不以 'builtin:' 起头
 */
export function isSkillPlugin(skill: SkillSummary): boolean {
  return Boolean(skill.managedByPlugin && !skill.managedByPlugin.startsWith('builtin:'))
}

/**
 * 判断技能是否为本地工作区私有技能：
 * - 无 managedByPlugin 且非系统内建 'helm-cli'
 */
export function isSkillWorkspace(skill: SkillSummary): boolean {
  return !skill.managedByPlugin && skill.id !== 'helm-cli'
}

/**
 * 判断技能是否命中指定的分类药丸标签
 */
export function isSkillInTab(skill: SkillSummary, tab: SkillCategoryTab): boolean {
  if (tab === 'all') return true
  if (tab === 'builtin') return isSkillBuiltin(skill)
  if (tab === 'workspace') return isSkillWorkspace(skill)
  if (tab === 'plugins') return isSkillPlugin(skill)
  return false
}

/**
 * 按多维条件过滤技能列表（纯函数，返回新数组，不修改原数组）
 *
 * 搜索匹配范围：
 * - skill.id
 * - skill.name
 * - skill.description
 * - skill.references 各子项路径
 */
export function filterSkills(
  skills: SkillSummary[],
  options: { query: string; categoryTab: SkillCategoryTab },
): SkillSummary[] {
  if (!Array.isArray(skills)) return []
  const query = (options.query ?? '').trim().toLowerCase()
  const tab = options.categoryTab ?? 'all'

  return skills.filter((skill) => {
    // 1. 分类标签筛选
    if (tab !== 'all' && !isSkillInTab(skill, tab)) {
      return false
    }

    // 2. 关键字搜索匹配
    if (query) {
      const matchId = (skill.id ?? '').toLowerCase().includes(query)
      const matchName = (skill.name ?? '').toLowerCase().includes(query)
      const matchDesc = (skill.description ?? '').toLowerCase().includes(query)
      const matchRefs = Array.isArray(skill.references) && skill.references.some((ref) => (ref ?? '').toLowerCase().includes(query))
      if (!matchId && !matchName && !matchDesc && !matchRefs) {
        return false
      }
    }

    return true
  })
}

/**
 * 计算分类标签的数量统计
 */
export function buildSkillCategoryCounts(skills: SkillSummary[]): Record<SkillCategoryTab, number> {
  const list = Array.isArray(skills) ? skills : []
  let builtin = 0
  let workspace = 0
  let plugins = 0

  for (const s of list) {
    if (isSkillBuiltin(s)) {
      builtin++
    } else if (isSkillPlugin(s)) {
      plugins++
    } else {
      workspace++
    }
  }

  return {
    all: list.length,
    builtin,
    workspace,
    plugins,
  }
}

/**
 * 汇总技能统计指标
 */
export function summarizeSkills(skills: SkillSummary[]): SkillSummaryStats {
  const counts = buildSkillCategoryCounts(skills)
  return {
    total: counts.all,
    builtin: counts.builtin,
    plugins: counts.plugins,
    workspace: counts.workspace,
  }
}

/**
 * 根据技能 ID 或来源推导对应的线性矢量图标名称（严格对应 icons.tsx ICON_MAP 键）
 */
export function getSkillIcon(skill: SkillSummary): string {
  const id = (skill.id ?? '').toLowerCase()
  if (id === 'helm-cli' || id.includes('cli')) return 'terminal'
  if (id.includes('code') || id.includes('dev') || id.includes('script') || id.includes('test')) return 'file-code'
  if (id.includes('tool') || id.includes('wrench')) return 'wrench'
  if (id.includes('bot') || id.includes('agent') || id.includes('assistant')) return 'bot'
  if (skill.managedByPlugin?.startsWith('builtin:')) return 'sparkles'
  if (skill.managedByPlugin) return 'boxes'
  return 'file-text'
}

/**
 * 获取技能来源徽章标签与类型
 */
export function getSkillSourceBadge(skill: SkillSummary): {
  label: string
  variant: 'builtin' | 'workspace' | 'plugin'
} {
  if (isSkillBuiltin(skill)) {
    return { label: '内置', variant: 'builtin' }
  }
  if (isSkillPlugin(skill)) {
    return { label: skill.managedByPlugin ?? '插件', variant: 'plugin' }
  }
  return { label: '工作区', variant: 'workspace' }
}

/**
 * 技能 HTTP API 调用代理封装，供技能中心与抽屉消费
 */
export const skillsApi = {
  read: (id: string, path?: string) => assetsApi.readSkill(id, path),
  list: () => assetsApi.listSkills(),
}
