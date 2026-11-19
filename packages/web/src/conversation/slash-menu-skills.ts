/**
 * Skill availability for the conversation slash menu (shared by the Composer
 * '/' completion and the CommandPopover fallback).
 *
 * The single rule source is the protocol's isSkillAvailable: a double filter
 * of the current profile's skills whitelist plus plugin enablement state.
 * When the current Profile is missing, skills stay hidden (better absent than
 * overexposed) and appear naturally once assets arrive.
 */

import type { Profile, SkillSummary } from '@helmx/protocol/browser'
import { isSkillAvailable } from '@helmx/protocol/browser'

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
