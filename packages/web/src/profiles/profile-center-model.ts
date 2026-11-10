import type { Profile as ProtocolProfile, ProfileRuntime } from '@helm/protocol'
import { assetsApi } from '../lib/api.js'

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
  return Boolean(
    p.isSystem ||
      p.id === 'superagent' ||
      p.id === 'watchdog' ||
      Boolean(p.managedByPlugin),
  )
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

/**
 * 根据 Profile ID、tags 或 runtime 推导线性矢量图标名称
 */
export function getProfileIcon(p: Partial<Profile>): string {
  const id = (p.id ?? '').toLowerCase()
  const tags = p.tags ?? []
  if (id === 'superagent' || tags.includes('superagent')) return 'sparkles'
  if (id === 'watchdog' || tags.includes('watchdog')) return 'shield'
  if (isHerdrProfile(p as Profile) || id.includes('herdr')) return 'terminal'
  if (id.includes('workflow') || tags.includes('workflow')) return 'workflow'
  if (id.includes('assistant')) return 'bot'
  return 'bot'
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
