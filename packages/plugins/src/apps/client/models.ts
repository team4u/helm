/**
 * 应用中心纯函数模型（无组件，供 AppCenterScreen 消费）。
 *
 * 应用判定遵循设计文档的左连接规则：非 builtin 外部插件且声明至少一个
 * Screen 贡献即视为「应用」；catalog 文档（builtin:apps 后端登记的产品元数据）
 * 仅做叠加增强，缺失时如实回退到插件摘要本身。
 */
import type { PluginSummary } from '@helm/protocol'

export type AppCategory = 'productivity' | 'devops' | 'data' | 'finance' | 'automation' | 'other'

export const APP_CATEGORY_LABELS: Record<AppCategory, string> = {
  productivity: '效率工具',
  devops: '运维监控',
  data: '数据看板',
  finance: '财务记账',
  automation: '自动化',
  other: '其他',
}

/** 归一化未知分类为 'other'（catalog 后端演进时的前端防御，不虚构未知类目）。 */
export function normalizeAppCategory(raw: unknown): AppCategory {
  return typeof raw === 'string' && raw in APP_CATEGORY_LABELS ? (raw as AppCategory) : 'other'
}

export interface AppCatalogEntry {
  pluginId: string
  icon?: string
  category?: string
  pinned?: boolean
  workspaceDir?: string
  originConversationId?: number
  publishedAt?: number
  updatedAt?: number
}

export interface AppCatalogDoc {
  apps: Record<string, AppCatalogEntry>
}

export interface AppScreenRef {
  pluginId: string
  screenId: string
  label: string
}

export interface AppItem {
  plugin: PluginSummary
  screens: AppScreenRef[]
  catalog: AppCatalogEntry | undefined
}

/**
 * 应用判定（左连接规则，与后端 list 动作一致）：
 * - 声明了至少一个 Screen 贡献的非 builtin 外部插件；或
 * - catalog 已登记且宿主 PluginSummary 仍存在的外部插件（停用后 screens 为空，
 *   卡片如实展示停用态并可重新启用；卸载后摘要消失则自动忽略孤儿条目）。
 * 两个入口都要求非 builtin：内置插件的视图不混入用户应用列表。
 */
export function isAppPlugin(
  plugin: Pick<PluginSummary, 'id'>,
  screens: Array<{ pluginId: string }> | undefined,
  catalog: AppCatalogDoc | undefined,
): boolean {
  if (plugin.id.startsWith('builtin:')) return false
  if (screens !== undefined && screens.some((s) => s.pluginId === plugin.id)) return true
  return catalog?.apps[plugin.id] !== undefined
}

/**
 * 合并宿主 plugins + screens + catalog 为应用视图列表：
 * 停用插件的 screens 贡献已被宿主移除，如实保留空列表（不虚构）；
 * catalog 孤儿条目（插件已卸载）自动忽略。
 */
export function mergeAppItems(
  plugins: PluginSummary[],
  screens: Array<{ pluginId: string; spec: { id: string; label: string } }>,
  catalog: AppCatalogDoc | undefined,
): AppItem[] {
  return plugins
    .filter((plugin) => isAppPlugin(plugin, screens, catalog))
    .map((plugin) => ({
      plugin,
      screens: screens
        .filter((s) => s.pluginId === plugin.id)
        .map((s) => ({ pluginId: s.pluginId, screenId: s.spec.id, label: s.spec.label })),
      catalog: catalog?.apps[plugin.id],
    }))
}

/** URL 参数 `tab` 的解析结果：all / pinned。仅保留全部与已置顶。 */
export type AppTabParam = 'all' | 'pinned'

export function parseAppTabParam(raw: string | undefined): AppTabParam {
  if (raw === 'pinned') return 'pinned'
  return 'all'
}

export function formatAppTabParam(tab: AppTabParam): string | undefined {
  if (tab === 'pinned') return 'pinned'
  return undefined
}

export interface AppFilterState {
  query: string
  tab: AppTabParam
}

/** 按置顶 Tab 与关键字（名称/ID/描述）过滤应用列表（纯函数）。 */
export function filterAppItems(items: AppItem[], filter: AppFilterState): AppItem[] {
  const query = filter.query.trim().toLowerCase()
  return items.filter((item) => {
    if (filter.tab === 'pinned' && item.catalog?.pinned !== true) return false
    if (query === '') return true
    const name = (item.plugin.name ?? '').toLowerCase()
    const id = (item.plugin.id ?? '').toLowerCase()
    const desc = (item.plugin.description ?? '').toLowerCase()
    return name.includes(query) || id.includes(query) || desc.includes(query)
  })
}

export interface AppCenterStats {
  total: number
  ready: number
  stopped: number
  pinned: number
}

export function summarizeAppItems(items: AppItem[]): AppCenterStats {
  let ready = 0
  let stopped = 0
  let pinned = 0
  for (const item of items) {
    if (item.plugin.enabled) ready++
    else stopped++
    if (item.catalog?.pinned === true) pinned++
  }
  return { total: items.length, ready, stopped, pinned }
}

/** 主屏/分屏打开的目标字符串（声明式目标，含参数编码）。 */
export function appScreenTarget(item: AppItem, screenId?: string): string | null {
  const screen = screenId !== undefined
    ? item.screens.find((s) => s.screenId === screenId)
    : item.screens[0]
  if (screen === undefined) return null
  return `screen:${screen.pluginId}/${screen.screenId}`
}
