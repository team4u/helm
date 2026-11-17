/**
 * Pure display model for the app center (no component exports, Fast Refresh
 * friendly; consumed by AppCenterScreen).
 *
 * App detection follows the design doc's left-join rule: a non-builtin
 * external plugin that contributes at least one Screen counts as an "app";
 * the catalog doc (product metadata registered by the builtin:apps backend)
 * only overlays enhancements — when absent we honestly fall back to the
 * plugin summary itself.
 */
import { DEFAULT_HELM_LOCALE, resolveLocalizedText, type HelmLocale, type LocalizedText } from '@helm/plugin-client'
import type { PluginSummary, ScreenSpec } from '@helm/protocol'
import { APP_DESCRIPTION_FALLBACK, appDescriptionFromViews } from './copy.ts'

export type AppCategory = 'productivity' | 'devops' | 'data' | 'finance' | 'automation' | 'other'

/** Known category keys (display labels live in copy.ts appCategoryLabel). */
const APP_CATEGORIES: readonly AppCategory[] = ['productivity', 'devops', 'data', 'finance', 'automation', 'other']

/** Normalize an unknown category to 'other' (frontend guard for catalog backend drift; never invents categories). */
export function normalizeAppCategory(raw: unknown): AppCategory {
  return typeof raw === 'string' && (APP_CATEGORIES as readonly string[]).includes(raw) ? (raw as AppCategory) : 'other'
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
  label: LocalizedText
}

export interface AppItem {
  plugin: PluginSummary
  screens: AppScreenRef[]
  catalog: AppCatalogEntry | undefined
}

/**
 * App detection (left-join rule, mirrors the backend list action):
 * - a non-builtin external plugin that contributes at least one Screen; or
 * - an external plugin already registered in the catalog whose host
 *   PluginSummary still exists (screens are empty while stopped — the card
 *   honestly shows the stopped state and offers re-enabling; once uninstalled
 *   the summary disappears and the orphan entry is ignored automatically).
 * Both entry points require non-builtin: built-in plugin views never mix
 * into the user app list.
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
 * Merge host plugins + screens + catalog into the app view list:
 * a stopped plugin's screen contributions are already removed by the host, so
 * keep an honest empty list (never fabricate); catalog orphan entries (plugin
 * uninstalled) are ignored automatically.
 */
export function mergeAppItems(
  plugins: PluginSummary[],
  screens: Array<{ pluginId: string; spec: Pick<ScreenSpec, 'id' | 'label'> }>,
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

/** Resolve an app's display name for the active locale, falling back to plugin ID. */
export function resolveAppName(
  plugin: Pick<PluginSummary, 'id' | 'name'>,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  const resolved = plugin.name !== undefined ? resolveLocalizedText(plugin.name, locale) : ''
  return resolved.trim() !== '' ? resolved : plugin.id
}

/** Resolve a contributed screen label for the active locale, falling back to screen ID. */
export function resolveAppScreenLabel(
  screen: Pick<AppScreenRef, 'screenId' | 'label'>,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  const resolved = screen.label !== undefined ? resolveLocalizedText(screen.label, locale) : ''
  return resolved.trim() !== '' ? resolved : screen.screenId
}

/** Resolve an app's description for the active locale, falling back to its view list or generic copy. */
export function resolveAppDescription(
  plugin: Pick<PluginSummary, 'description'>,
  screens: readonly AppScreenRef[],
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  const declared = plugin.description !== undefined ? resolveLocalizedText(plugin.description, locale) : ''
  if (declared.trim() !== '') return declared
  if (screens.length > 0) {
    return appDescriptionFromViews(
      screens.map((s) => resolveAppScreenLabel(s, locale)),
      locale,
    )
  }
  return resolveLocalizedText(APP_DESCRIPTION_FALLBACK, locale)
}

/** Parsed `tab` URL parameter: all / pinned. Only these two tabs are kept. */
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

/** Filter the app list by pinned tab and keyword (name/ID/description); pure function. */
export function filterAppItems(
  items: AppItem[],
  filter: AppFilterState,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): AppItem[] {
  const query = filter.query.trim().toLowerCase()
  return items.filter((item) => {
    if (filter.tab === 'pinned' && item.catalog?.pinned !== true) return false
    if (query === '') return true
    const name = (item.plugin.name !== undefined ? resolveLocalizedText(item.plugin.name, locale) : '').toLowerCase()
    const id = (item.plugin.id ?? '').toLowerCase()
    const desc = (item.plugin.description !== undefined ? resolveLocalizedText(item.plugin.description, locale) : '').toLowerCase()
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

/** Declarative open target for the main/split pane (includes parameter encoding). */
export function appScreenTarget(item: AppItem, screenId?: string): string | null {
  const screen = screenId !== undefined
    ? item.screens.find((s) => s.screenId === screenId)
    : item.screens[0]
  if (screen === undefined) return null
  return `screen:${screen.pluginId}/${screen.screenId}`
}
