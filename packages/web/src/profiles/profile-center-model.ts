import type { Profile as ProtocolProfile, ProfileRuntime, ProfileStarterPrompt } from '@helm/protocol'
import {
  PROFILE_STARTERS_MAX_ITEMS,
  PROFILE_STARTER_LABEL_MAX_LENGTH,
  PROFILE_STARTER_PROMPT_MAX_LENGTH,
} from '@helm/protocol'
import { assetsApi, type ModelDescriptor } from '../lib/api.js'
import type { SelectOption } from '../ui/select-model.js'

declare module '@helm/protocol' {
  interface Profile {
    description?: string
    defaultModel?: string
    isSystem?: boolean
  }
}

export type { Profile } from '@helm/protocol'
import type { Profile } from '@helm/protocol'

export type ProfileCategoryTab = 'all' | 'system' | 'custom' | 'herdr'

export const PROFILE_CATEGORY_TABS: Array<{ key: ProfileCategoryTab; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'system', label: '内置' },
  { key: 'custom', label: '自定义' },
  { key: 'herdr', label: 'Herdr' },
]

/**
 * 判断是否为系统内置或受插件托管的保护角色
 */
export function isSystemProfile(p: Profile): boolean {
  return Boolean(p.isSystem || p.managedByPlugin)
}

/**
 * 判断是否为绑定了 Herdr 外部运行时的角色
 */
export function isHerdrProfile(p: Profile): boolean {
  return Boolean(
    p.runtime?.kind === 'herdr' ||
      (Array.isArray(p.tags) && p.tags.includes('herdr')),
  )
}

/**
 * 读取角色的默认绑定模型
 */
export function resolveProfileModel(p: Profile): string | undefined {
  return p.defaultModel ?? p.model
}

/**
 * 构造角色绑定的可选模型下拉列表：
 * - 第一项恒为「跟随系统默认」（value: ''）；
 * - 过滤只展示已配置的模型（m.available === true），未配置的不能出来；
 * - 若当前角色已配置的模型不在可用列表内（例如凭据失效或外部模型），
 *   保留该项并注明「未配置」，确保既有值不丢失且明确提示。
 */
export function buildProfileModelOptions(
  models: ModelDescriptor[],
  currentModel?: string,
): SelectOption<string>[] {
  const list: SelectOption<string>[] = [{ value: '', label: '跟随系统默认' }]
  const trimmedCurrent = currentModel?.trim() ?? ''
  for (const m of models) {
    if (!m.available) continue
    const label = m.label ? `${m.label} (${m.id})` : m.id
    list.push({ value: m.id, label })
  }
  if (trimmedCurrent !== '' && !models.some((m) => m.id === trimmedCurrent && m.available)) {
    list.push({ value: trimmedCurrent, label: `${trimmedCurrent}（未配置）` })
  }
  return list
}

/**
 * 根据搜索关键字与分类标签过滤 Profile 列表
 */
export function filterProfiles(
  profiles: Profile[],
  options: { query: string; categoryTab: ProfileCategoryTab },
): Profile[] {
  const { query, categoryTab } = options
  const q = query.trim().toLowerCase()

  return profiles.filter((p) => {
    // 1. 分类匹配
    if (categoryTab === 'system' && !isSystemProfile(p)) {
      return false
    }
    if (categoryTab === 'custom' && isSystemProfile(p)) {
      return false
    }
    if (categoryTab === 'herdr' && !isHerdrProfile(p)) {
      return false
    }

    // 2. 搜索匹配：匹配 profile.id, profile.name, profile.description, profile.tags, profile.defaultModel, profile.system, profile.skills
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

/**
 * 计算各分类下的角色数量
 */
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

/**
 * 汇总角色统计信息
 */
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

/**
 * 校验新建 Profile ID 的合法性（字母、数字与连字符，1-64 字符）
 */
export function profileIdValid(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
}

/** 表单内编辑中的引导词条目（尚未保存，允许临时空值）。 */
export interface StarterDraft {
  label: string
  prompt: string
}

/** Unicode 码点计数（代理对计 1；与服务层/HTTP 边界同口径）。 */
function starterCodePoints(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** 校验单条编辑草稿；返回首个错误文案，合法返回 null。 */
export function validateStarterDraft(draft: StarterDraft): string | null {
  const label = draft.label.trim()
  if (starterCodePoints(label) === 0) return '标题去除首尾空白后不能为空'
  if (starterCodePoints(label) > PROFILE_STARTER_LABEL_MAX_LENGTH) {
    return `标题最多 ${PROFILE_STARTER_LABEL_MAX_LENGTH} 个 Unicode 码点`
  }
  if (draft.prompt.trim() === '') return '提示词不能是纯空白'
  if (starterCodePoints(draft.prompt) > PROFILE_STARTER_PROMPT_MAX_LENGTH) {
    return `提示词最多 ${PROFILE_STARTER_PROMPT_MAX_LENGTH} 个 Unicode 码点`
  }
  return null
}

/** 校验整份 starters 草稿；通过返回 null，否则返回（索引, 错误）。 */
export function validateStarterDrafts(
  drafts: StarterDraft[],
): { index: number; error: string } | null {
  for (let i = 0; i < drafts.length; i++) {
    const error = validateStarterDraft(drafts[i]!)
    if (error !== null) return { index: i, error }
  }
  return null
}

/** Profile.starters -> 表单草稿（未定义时为空列表：保存为空=清空）。 */
export function startersToDrafts(starters: ProfileStarterPrompt[] | undefined): StarterDraft[] {
  return (starters ?? []).map((s) => ({ label: s.label, prompt: s.prompt }))
}

/** 空白会话可展示的引导词：空数组回退 undefined（宿主默认提示由 UI 层另行处理）。 */
export function visibleStarters(profile: Profile | undefined): ProfileStarterPrompt[] | undefined {
  const starters = profile?.starters
  return starters !== undefined && starters.length > 0 ? starters : undefined
}

/** 是否已达上限（禁止继续新增）。 */
export function startersAtLimit(drafts: StarterDraft[]): boolean {
  return drafts.length >= PROFILE_STARTERS_MAX_ITEMS
}

/**
 * 角色 API 封装对象
 */
export const profilesApi = {
  list: () => assetsApi.listProfiles(),
  get: (id: string) => assetsApi.getProfile(id),
  create: (profile: Profile) => assetsApi.createProfile(profile),
  update: (id: string, profile: Omit<Profile, 'id'> & { id?: string }) =>
    assetsApi.updateProfile(id, profile),
  delete: (id: string) => assetsApi.deleteProfile(id),
}
