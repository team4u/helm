/**
 * Pure logic for the profile editor "available skills" section (consumed by
 * ProfileBasicTab SkillsSection).
 *
 * Semantics align with the protocol isSkillAvailable: undefined = all
 * available skills; [] = explicitly disable all; a non-empty array =
 * allowlist. Skills managed by a disabled plugin are never selectable (no
 * new checks), but stale skills already configured in the allowlist (missing
 * / plugin disabled) must stay visible and removable — saving other fields
 * must never silently delete them.
 */

import type { Profile, SkillSummary } from '@helmx/protocol/browser'

/** The three edit modes of the skills section: follow all (skills=undefined) / allowlist / explicitly none (skills=[]). */
export type SkillsEditMode = 'all' | 'allowlist' | 'none'

/** Infer the edit mode from Profile.skills (undefined -> all, [] -> none, non-empty -> allowlist). */
export function skillsEditMode(skills: string[] | undefined): SkillsEditMode {
  if (skills === undefined) return 'all'
  return skills.length === 0 ? 'none' : 'allowlist'
}

/** Mode switch: all sets skills to undefined; none sets []; allowlist keeps the existing allowlist (starting from [] when unset). */
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
 * Allowlist check toggling: checking only allows selectable skills (disabled/
 * missing rejected); unchecking always works (including explicit removal of
 * unavailable skills).
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
  /** Included in the allowlist (including stale skills — kept visible). */
  checked: boolean
  /** Newly checkable: only visible (managing plugin enabled) skills are selectable; disabled managed skills cannot be checked. */
  selectable: boolean
  /** Configured but missing (no such id in the skill catalog) — not checkable, removable. */
  missing: boolean
  /** Configured but the managing plugin is disabled — not checkable, removable. */
  pluginDisabled: boolean
}

export interface SkillsSectionModel {
  /** Visible skills (managing plugin enabled): the checkable scope. */
  visible: SkillEditRow[]
  /** Configured but stale skills (missing / plugin disabled): kept visible with a removal entry. */
  unavailable: SkillEditRow[]
}

/**
 * Build the skills section row model:
 * - visible skills list the whole catalog in order (check state from the
 *   allowlist; unchecked when unconfigured);
 * - allowlist ids absent from the catalog produce missing rows;
 * - allowlist skills whose managing plugin is disabled produce pluginDisabled
 *   rows (present in the catalog but not selectable);
 * - undefined (all) mode lists only visible skills, with no stale rows.
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
