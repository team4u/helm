import type {
  ConversationSummary,
  PluginSummary,
  Profile as ProtocolProfile,
  ProfileRuntime,
  ProfileStarterPrompt,
} from '@helmx/protocol/browser'
import {
  PROFILE_STARTERS_MAX_ITEMS,
  PROFILE_STARTER_LABEL_MAX_LENGTH,
  PROFILE_STARTER_PROMPT_MAX_LENGTH,
} from '@helmx/protocol/browser'
import { assetsApi, type ModelDescriptor } from '../lib/api.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import type { SelectOption } from '@helmx/plugin-client'

declare module '@helmx/protocol/browser' {
  interface Profile {
    description?: string
    defaultModel?: string
    isSystem?: boolean
  }
}

export type { Profile } from '@helmx/protocol/browser'
import type { Profile } from '@helmx/protocol/browser'

export type ProfileCategoryTab = 'all' | 'system' | 'custom' | 'herdr'

/**
 * Category tab constant. Kept with English labels for backward compatibility
 * of the export; rendering must resolve labels through
 * {@link profileCategoryTabLabel} so display copy follows the active locale.
 */
export const PROFILE_CATEGORY_TABS: Array<{ key: ProfileCategoryTab; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'system', label: 'Built-in' },
  { key: 'custom', label: 'Custom' },
  { key: 'herdr', label: 'Herdr' },
]

/** Localized category tab label ('all'/'system' reuse the common table). */
export function profileCategoryTabLabel(tab: ProfileCategoryTab, t?: WebMessageTranslator): string {
  const tt = t ?? englishWebTranslator
  switch (tab) {
    case 'all':
      return tt('common.all')
    case 'system':
      return tt('common.builtIn')
    case 'custom':
      return tt('profiles.tab.custom')
    case 'herdr':
      return tt('profiles.tab.herdr')
  }
}

/** Whether the profile is a protected built-in or plugin-managed profile. */
export function isSystemProfile(p: Profile): boolean {
  return Boolean(p.isSystem || p.managedByPlugin)
}

/** Whether the profile is bound to a Herdr external runtime. */
export function isHerdrProfile(p: Profile): boolean {
  return Boolean(
    p.runtime?.kind === 'herdr' ||
      (Array.isArray(p.tags) && p.tags.includes('herdr')),
  )
}

/** Resolve the profile's bound default model. */
export function resolveProfileModel(p: Profile): string | undefined {
  return p.defaultModel ?? p.model
}

/**
 * Short display name for a bound model: strips the provider/ path prefix
 * (same normalization as the Composer model picker and model center cards);
 * blank or separator-only values fall back to empty/original, while the full
 * path is preserved in hover titles and the detail drawer.
 */
export function formatShortModelName(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const trimmed = model.trim()
  if (trimmed === '') return undefined
  const slashIdx = trimmed.lastIndexOf('/')
  return slashIdx >= 0 && slashIdx < trimmed.length - 1 ? trimmed.slice(slashIdx + 1) : trimmed
}

/**
 * Build the selectable model options for a profile binding:
 * - the first entry is always "Follow system default" (value: '');
 * - only configured and non-disabled models are listed (available and not
 *   disabled); unconfigured/disabled models are not normal options;
 * - if the profile's currently configured model is not selectable (e.g.
 *   credentials gone, external model, or disabled), it is kept and annotated
 *   as "not configured" or "disabled" so existing values never disappear
 *   silently.
 */
export function buildProfileModelOptions(
  models: ModelDescriptor[],
  currentModel?: string,
  t?: WebMessageTranslator,
): SelectOption<string>[] {
  const tt = t ?? englishWebTranslator
  const list: SelectOption<string>[] = [{ value: '', label: tt('profiles.modelOption.followSystemDefault') }]
  const trimmedCurrent = currentModel?.trim() ?? ''
  for (const m of models) {
    if (!m.available || m.disabled === true) continue
    const label = m.label ? `${m.label} (${m.id})` : m.id
    list.push({ value: m.id, label })
  }
  if (trimmedCurrent !== '' && !list.some((o) => o.value === trimmedCurrent)) {
    const disabled = models.some((m) => m.id === trimmedCurrent && m.disabled === true)
    list.push({
      value: trimmedCurrent,
      label: disabled
        ? tt('profiles.modelOption.disabled', { model: trimmedCurrent })
        : tt('profiles.modelOption.notConfigured', { model: trimmedCurrent }),
    })
  }
  return list
}

/** Filter the profile list by search query and category tab. */
export function filterProfiles(
  profiles: Profile[],
  options: { query: string; categoryTab: ProfileCategoryTab },
): Profile[] {
  const { query, categoryTab } = options
  const q = query.trim().toLowerCase()

  return profiles.filter((p) => {
    // 1. Category match
    if (categoryTab === 'system' && !isSystemProfile(p)) {
      return false
    }
    if (categoryTab === 'custom' && isSystemProfile(p)) {
      return false
    }
    if (categoryTab === 'herdr' && !isHerdrProfile(p)) {
      return false
    }

    // 2. Search match: profile.id, profile.name, profile.description,
    //    profile.tags, profile.defaultModel, profile.system, profile.skills
    if (!q) {
      return true
    }

    if (p.id?.toLowerCase().includes(q)) return true
    if (p.name?.toLowerCase().includes(q)) return true
    if (p.description?.toLowerCase().includes(q)) return true
    if (p.tags?.some((t) => t.toLowerCase().includes(q))) return true
    const model = resolveProfileModel(p)
    if (model?.toLowerCase().includes(q)) return true
    if (p.system?.toLowerCase().includes(q)) return true
    if (p.skills?.some((s) => s.toLowerCase().includes(q))) return true

    return false
  })
}

/** Count profiles per category tab. */
export function buildProfileCategoryCounts(
  profiles: Profile[],
): Record<ProfileCategoryTab, number> {
  let systemCount = 0
  let customCount = 0
  let herdrCount = 0

  for (const p of profiles) {
    if (isSystemProfile(p)) {
      systemCount++
    } else {
      customCount++
    }
    if (isHerdrProfile(p)) {
      herdrCount++
    }
  }

  return {
    all: profiles.length,
    system: systemCount,
    custom: customCount,
    herdr: herdrCount,
  }
}

/** Summarize profile counts. */
export function summarizeProfiles(profiles: Profile[]): {
  total: number
  system: number
  custom: number
} {
  const counts = buildProfileCategoryCounts(profiles)
  return {
    total: counts.all,
    system: counts.system,
    custom: counts.custom,
  }
}

/** Validate a new profile ID (letters, digits and hyphens, 1-64 chars). */
export function profileIdValid(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
}

/** A starter entry being edited in the form (not saved yet; transient blanks allowed). */
export interface StarterDraft {
  label: string
  prompt: string
}

/** Count Unicode code points (surrogate pairs count as 1; same as the service/HTTP boundary). */
function starterCodePoints(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** Validate one draft starter; returns the first error copy, or null when valid. */
export function validateStarterDraft(draft: StarterDraft, t?: WebMessageTranslator): string | null {
  const tt = t ?? englishWebTranslator
  const label = draft.label.trim()
  if (starterCodePoints(label) === 0) return tt('profiles.starter.error.titleEmpty')
  if (starterCodePoints(label) > PROFILE_STARTER_LABEL_MAX_LENGTH) {
    return tt('profiles.starter.error.titleTooLong', { max: PROFILE_STARTER_LABEL_MAX_LENGTH })
  }
  if (draft.prompt.trim() === '') return tt('profiles.starter.error.promptWhitespace')
  if (starterCodePoints(draft.prompt) > PROFILE_STARTER_PROMPT_MAX_LENGTH) {
    return tt('profiles.starter.error.promptTooLong', { max: PROFILE_STARTER_PROMPT_MAX_LENGTH })
  }
  return null
}

/** Validate the whole starters draft; null when valid, else (index, error). */
export function validateStarterDrafts(
  drafts: StarterDraft[],
  t?: WebMessageTranslator,
): { index: number; error: string } | null {
  for (let i = 0; i < drafts.length; i++) {
    const error = validateStarterDraft(drafts[i]!, t)
    if (error !== null) return { index: i, error }
  }
  return null
}

/** Profile.starters -> form drafts (undefined becomes an empty list: saving empty clears). */
export function startersToDrafts(starters: ProfileStarterPrompt[] | undefined): StarterDraft[] {
  return (starters ?? []).map((s) => ({ label: s.label, prompt: s.prompt }))
}

/** Starters shown on empty conversations: empty array falls back to undefined (host default hint is handled by the UI layer). */
export function visibleStarters(profile: Profile | undefined): ProfileStarterPrompt[] | undefined {
  const starters = profile?.starters
  return starters !== undefined && starters.length > 0 ? starters : undefined
}

/** Whether the starter cap is reached (no further additions). */
export function startersAtLimit(drafts: StarterDraft[]): boolean {
  return drafts.length >= PROFILE_STARTERS_MAX_ITEMS
}

export interface EffectiveProfileModelInfo {
  model?: string
  thinkingLevel?: string
  source: 'bound' | 'global' | 'unset'
}

/**
 * Resolve the model and thinking level actually in effect for a profile
 * (own binding first, then the global default).
 */
export function resolveEffectiveProfileModel(
  profile: Profile,
  defaultModelInfo?: { defaultModel?: string; defaultThinkingLevel?: string } | null,
): EffectiveProfileModelInfo {
  const boundModel = resolveProfileModel(profile)?.trim() ?? ''
  if (boundModel !== '') {
    const thinking = profile.thinkingLevel?.trim()
    return {
      model: boundModel,
      thinkingLevel: thinking && thinking !== 'off' ? thinking : undefined,
      source: 'bound',
    }
  }
  const globalModel = defaultModelInfo?.defaultModel?.trim() ?? ''
  if (globalModel !== '') {
    const globalThinking = defaultModelInfo?.defaultThinkingLevel?.trim()
    return {
      model: globalModel,
      thinkingLevel: globalThinking && globalThinking !== 'off' ? globalThinking : undefined,
      source: 'global',
    }
  }
  return { source: 'unset' }
}

/** Format the profile's default compute node and working directory location. */
export function formatProfileLocation(profile: Profile): {
  nodeId: string
  isRemoteNode: boolean
  cwd?: string
} {
  const nodeId = profile.nodeId?.trim() || 'local'
  const cwd = profile.cwd?.trim() || undefined
  return {
    nodeId,
    isRemoteNode: nodeId !== 'local',
    cwd,
  }
}

export interface ProfileActivitySummary {
  conversationCount: number
  workingCount: number
  blockedCount: number
  errorCount: number
  managingPluginDisabled: boolean
  stateKind: 'working' | 'blocked' | 'error' | 'plugin-disabled' | 'active' | 'idle'
  stateLabel: string
}

/** Summarize the profile's conversation activity and managing plugin status. */
export function summarizeProfileActivity(
  profile: Profile,
  conversations: ConversationSummary[] = [],
  plugins: PluginSummary[] = [],
  t?: WebMessageTranslator,
): ProfileActivitySummary {
  const tt = t ?? englishWebTranslator
  let conversationCount = 0
  let workingCount = 0
  let blockedCount = 0
  let errorCount = 0

  for (const conv of conversations) {
    if (conv.profileId !== profile.id) continue
    conversationCount++
    if (conv.status === 'working') workingCount++
    else if (conv.status === 'blocked') blockedCount++
    else if (conv.status === 'error') errorCount++
  }

  const managingPlugin = profile.managedByPlugin
    ? plugins.find((plugin) => plugin.id === profile.managedByPlugin)
    : undefined
  const managingPluginDisabled = Boolean(managingPlugin && !managingPlugin.enabled)

  if (managingPluginDisabled) {
    return {
      conversationCount,
      workingCount,
      blockedCount,
      errorCount,
      managingPluginDisabled,
      stateKind: 'plugin-disabled',
      stateLabel: tt('profiles.activity.pluginDisabled'),
    }
  }
  if (workingCount > 0) {
    return {
      conversationCount,
      workingCount,
      blockedCount,
      errorCount,
      managingPluginDisabled,
      stateKind: 'working',
      stateLabel:
        workingCount > 1
          ? tt('profiles.activity.runningCount', { count: workingCount })
          : tt('profiles.activity.running'),
    }
  }
  if (blockedCount > 0) {
    return {
      conversationCount,
      workingCount,
      blockedCount,
      errorCount,
      managingPluginDisabled,
      stateKind: 'blocked',
      stateLabel:
        blockedCount > 1
          ? tt('profiles.activity.pendingApprovalCount', { count: blockedCount })
          : tt('profiles.activity.pendingApproval'),
    }
  }
  if (errorCount > 0) {
    return {
      conversationCount,
      workingCount,
      blockedCount,
      errorCount,
      managingPluginDisabled,
      stateKind: 'error',
      stateLabel:
        errorCount > 1 ? tt('profiles.activity.errors', { count: errorCount }) : tt('profiles.activity.hasErrors'),
    }
  }
  if (conversationCount > 0) {
    return {
      conversationCount,
      workingCount,
      blockedCount,
      errorCount,
      managingPluginDisabled,
      stateKind: 'active',
      stateLabel: tt('profiles.activity.conversations', { count: conversationCount }),
    }
  }
  return {
    conversationCount,
    workingCount,
    blockedCount,
    errorCount,
    managingPluginDisabled,
    stateKind: 'idle',
    stateLabel: tt('profiles.activity.standingBy'),
  }
}

/** Profile HTTP API facade. */
export const profilesApi = {
  list: () => assetsApi.listProfiles(),
  get: (id: string) => assetsApi.getProfile(id),
  create: (profile: Profile) => assetsApi.createProfile(profile),
  update: (id: string, profile: Omit<Profile, 'id'> & { id?: string }) =>
    assetsApi.updateProfile(id, profile),
  delete: (id: string) => assetsApi.deleteProfile(id),
}
