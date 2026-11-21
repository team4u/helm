/**
 * Skill availability for the conversation slash menu (shared by the Composer
 * '/' completion, the standby pane and the CommandPopover fallback).
 *
 * The single rule source is the protocol's isSkillAvailable: a double filter
 * of the current profile's skills whitelist plus plugin enablement state.
 * When the current Profile is missing, skills stay hidden (better absent than
 * overexposed) and appear naturally once assets arrive.
 *
 * Scope extension: the merged Hub+node catalog of the current physical
 * coordinates (conversation / standby draft environment) contributes
 * node-sourced additions — same-name Hub skills always win (the backend
 * contract already excludes them; the id set here re-guards it), and the
 * availability rule applies to node skills identically (the conversation
 * catalog filter on the server shares the same isSkillAvailable source).
 */

import type { Profile, SkillSummary } from '@helmx/protocol/browser'
import { isSkillAvailable } from '@helmx/protocol/browser'
import { isNodeSourceSkill } from '../skills/skill-scope-model.js'

/**
 * Skills eligible for the '/' slash menu in the current conversation:
 * - profile missing (assets not returned / Profile deleted) -> empty array,
 *   never accidentally exposing everything;
 * - profile.skills unset -> all visible skills;
 * - [] -> no skills; non-empty -> whitelist;
 * - skills of a disabled owning plugin are always unavailable.
 */
export function slashMenuSkills(
  profile: Profile | undefined,
  skills: ReadonlyArray<SkillSummary>,
  enabledPluginIds: ReadonlySet<string>,
): SkillSummary[] {
  if (profile === undefined) return []
  return skills.filter((s) => isSkillAvailable(s, profile, enabledPluginIds))
}

/**
 * Slash menu list extended with node-sourced skills from the merged catalog
 * of the current physical scope. `scopedSkills` null/undefined (Hub scope or
 * catalog not loaded / failed) keeps the Hub base untouched — a failed node
 * lookup never removes Hub skills from the menu.
 */
export function slashMenuSkillsWithScope(
  profile: Profile | undefined,
  skills: ReadonlyArray<SkillSummary>,
  enabledPluginIds: ReadonlySet<string>,
  scopedSkills: ReadonlyArray<SkillSummary> | null | undefined,
): SkillSummary[] {
  const base = slashMenuSkills(profile, skills, enabledPluginIds)
  if (profile === undefined || scopedSkills === null || scopedSkills === undefined) return base
  const hubIds = new Set(skills.map((s) => s.id))
  const additions = scopedSkills.filter(
    (s) => isNodeSourceSkill(s) && !hubIds.has(s.id) && isSkillAvailable(s, profile, enabledPluginIds),
  )
  return [...base, ...additions]
}
