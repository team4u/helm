/**
 * Skill center pure-function model and category filtering.
 *
 * Provides skill category derivation, multi-dimension search (name / ID /
 * description / reference files), source distinction and metric summaries.
 * Follows the web Fast Refresh rule: pure functions, constants and data
 * models live here, never mixed into components.
 */
import type { SkillSummary } from '@helmx/protocol/browser'
import { assetsApi } from '../lib/api.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'

export type SkillCategoryTab = 'all' | 'builtin' | 'plugins' | 'agents' | 'workspace'

export interface SkillFilterOptions {
  query: string
  categoryTab: SkillCategoryTab
}

export interface SkillSummaryStats {
  total: number
  builtin: number
  plugins: number
  agents: number
  workspace: number
}

/**
 * Whether the skill is a system built-in core skill:
 * - managedByPlugin starts with 'builtin:'
 */
export function isSkillBuiltin(skill: SkillSummary): boolean {
  return Boolean(skill.managedByPlugin?.startsWith('builtin:'))
}

/**
 * Whether the skill is managed by a third-party / external plugin:
 * - managedByPlugin set and not starting with 'builtin:'
 */
export function isSkillPlugin(skill: SkillSummary): boolean {
  return Boolean(skill.managedByPlugin && !skill.managedByPlugin.startsWith('builtin:'))
}

/**
 * Whether the skill comes from the machine-level shared root
 * (~/.agents/skills, the pi ecosystem skill library):
 * - source === 'agents'
 */
export function isSkillAgents(skill: SkillSummary): boolean {
  return skill.source === 'agents'
}

/**
 * Whether the skill is private to the local workspace:
 * - no managedByPlugin and not from the machine-level shared root
 */
export function isSkillWorkspace(skill: SkillSummary): boolean {
  return !skill.managedByPlugin && !isSkillAgents(skill)
}

/** Whether the skill matches the given category pill tab. */
export function isSkillInTab(skill: SkillSummary, tab: SkillCategoryTab): boolean {
  if (tab === 'all') return true
  if (tab === 'builtin') return isSkillBuiltin(skill)
  if (tab === 'workspace') return isSkillWorkspace(skill)
  if (tab === 'plugins') return isSkillPlugin(skill)
  if (tab === 'agents') return isSkillAgents(skill)
  return false
}

/**
 * Filter the skill list by multiple conditions (pure; returns a new array,
 * never mutates the input).
 *
 * Search match scopes:
 * - skill.id
 * - skill.name
 * - skill.description
 * - each skill.references path
 */
export function filterSkills(
  skills: SkillSummary[],
  options: { query: string; categoryTab: SkillCategoryTab },
): SkillSummary[] {
  if (!Array.isArray(skills)) return []
  const query = (options.query ?? '').trim().toLowerCase()
  const tab = options.categoryTab ?? 'all'

  return skills.filter((skill) => {
    // 1. Category tab filter
    if (tab !== 'all' && !isSkillInTab(skill, tab)) {
      return false
    }

    // 2. Keyword search
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

/** Count skills per category tab. */
export function buildSkillCategoryCounts(skills: SkillSummary[]): Record<SkillCategoryTab, number> {
  const list = Array.isArray(skills) ? skills : []
  let builtin = 0
  let workspace = 0
  let plugins = 0
  let agents = 0

  for (const s of list) {
    if (isSkillAgents(s)) {
      agents++
    } else if (isSkillBuiltin(s)) {
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
    agents,
  }
}

/** Summarize skill metrics. */
export function summarizeSkills(skills: SkillSummary[]): SkillSummaryStats {
  const counts = buildSkillCategoryCounts(skills)
  return {
    total: counts.all,
    builtin: counts.builtin,
    plugins: counts.plugins,
    agents: counts.agents,
    workspace: counts.workspace,
  }
}

/**
 * Resolve the skill's source badge label and variant (agents checked first:
 * shared skills never carry managedByPlugin, but they are semantically their
 * own category, not folded into the plugin dimension).
 */
export function getSkillSourceBadge(
  skill: SkillSummary,
  t?: WebMessageTranslator,
): {
  label: string
  variant: 'builtin' | 'workspace' | 'plugin' | 'agents'
} {
  const tt = t ?? englishWebTranslator
  if (isSkillAgents(skill)) {
    return { label: tt('skills.category.shared'), variant: 'agents' }
  }
  if (isSkillBuiltin(skill)) {
    return { label: tt('common.builtIn'), variant: 'builtin' }
  }
  if (isSkillPlugin(skill)) {
    return { label: skill.managedByPlugin ?? tt('skills.category.plugins'), variant: 'plugin' }
  }
  return { label: tt('skills.category.workspace'), variant: 'workspace' }
}

/** Localized category tab label ('all'/'builtin' reuse the common table). */
export function skillCategoryTabLabel(tab: SkillCategoryTab, t?: WebMessageTranslator): string {
  const tt = t ?? englishWebTranslator
  switch (tab) {
    case 'all':
      return tt('common.all')
    case 'builtin':
      return tt('common.builtIn')
    case 'plugins':
      return tt('skills.category.plugins')
    case 'agents':
      return tt('skills.category.shared')
    case 'workspace':
      return tt('skills.category.workspace')
  }
}

/** Skill HTTP API facade consumed by the skill center and drawer. */
export const skillsApi = {
  read: (id: string, path?: string) => assetsApi.readSkill(id, path),
  list: () => assetsApi.listSkills(),
}
