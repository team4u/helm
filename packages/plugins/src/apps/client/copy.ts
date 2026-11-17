/**
 * Display copy for the builtin:apps app center (pure copy table + builders,
 * no component exports — Fast Refresh friendly).
 *
 * Every human-visible string of the app center (launchpad grid, app card,
 * detail drawer, empty states) resolves through these LocalizedText entries
 * against the active host locale; plugin names, screen labels and backend
 * error messages pass through unchanged.
 */
import type { HelmLocale, LocalizedText } from '@helm/plugin-client'
import { resolveLocalizedText } from '@helm/plugin-client'
import type { AppCategory } from './models.ts'

/** Catalog category labels (keys mirror models.ts APP_CATEGORIES). */
const APP_CATEGORY_LABELS: Record<AppCategory, LocalizedText> = {
  productivity: { en: 'Productivity', 'zh-CN': '效率工具' },
  devops: { en: 'DevOps', 'zh-CN': '运维监控' },
  data: { en: 'Data', 'zh-CN': '数据看板' },
  finance: { en: 'Finance', 'zh-CN': '财务记账' },
  automation: { en: 'Automation', 'zh-CN': '自动化' },
  other: { en: 'Other', 'zh-CN': '其他' },
}

/** Resolve the display label for a normalized catalog category. */
export function appCategoryLabel(category: AppCategory, locale: HelmLocale): string {
  return resolveLocalizedText(APP_CATEGORY_LABELS[category], locale)
}

/** Launchpad header. */
export const APP_CENTER_TITLE: LocalizedText = { en: 'App Center', 'zh-CN': '应用中心' }
export const APP_CENTER_SUBTITLE: LocalizedText = {
  en: 'Launcher for AI-generated and managed full-stack micro apps',
  'zh-CN': 'AI 生成与受管安装的全栈微应用启动台',
}

/** Launchpad stats line (`N apps · M ready`). */
export function appCenterStats(total: number, ready: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `${total} apps · ${ready} ready`, 'zh-CN': `共 ${total} 个应用 · ${ready} 个已就绪` },
    locale,
  )
}

/** Search box (business-specific placeholder; generic widget copy stays in the SDK). */
export const APP_SEARCH_PLACEHOLDER: LocalizedText = {
  en: 'Search apps by name, ID, or description…',
  'zh-CN': '搜索应用名称、ID 或描述…',
}
export const APP_SEARCH_LABEL: LocalizedText = { en: 'Search apps', 'zh-CN': '搜索应用' }
export const APP_SEARCH_CLEAR: LocalizedText = { en: 'Clear search', 'zh-CN': '清空搜索' }

/** Filter tablist and the two retained tabs. */
export const APP_FILTER_LABEL: LocalizedText = { en: 'App filters', 'zh-CN': '应用筛选' }
export const APP_TAB_ALL: LocalizedText = { en: 'All', 'zh-CN': '全部' }
export const APP_TAB_PINNED: LocalizedText = { en: 'Pinned', 'zh-CN': '已置顶' }

/** Card / drawer badges. */
export const APP_PINNED_TITLE: LocalizedText = { en: 'Pinned', 'zh-CN': '已置顶' }
export const APP_BADGE_PINNED: LocalizedText = { en: 'Pinned', 'zh-CN': '置顶' }
export const APP_STATUS_READY: LocalizedText = { en: 'Ready', 'zh-CN': '已就绪' }
export const APP_STATUS_STOPPED: LocalizedText = { en: 'Stopped', 'zh-CN': '已停用' }

/** Counting pills (`N views`, `N actions`). */
export function appViewsCount(count: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `${count} ${count === 1 ? 'view' : 'views'}`, 'zh-CN': `${count} 视图` },
    locale,
  )
}
export function appActionsCount(count: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `${count} ${count === 1 ? 'action' : 'actions'}`, 'zh-CN': `${count} 动作` },
    locale,
  )
}

/** Pill shown instead of the view count while the plugin is stopped. */
export const APP_STOPPED_PILL: LocalizedText = { en: 'Stopped', 'zh-CN': '已停用' }
export const APP_STOPPED_PILL_TITLE: LocalizedText = {
  en: 'Plugin stopped: screen contributions are unloaded; they come back once it is enabled',
  'zh-CN': '插件已停用，视图贡献已卸载；启用后自动恢复',
}

/** Card footer actions. */
export const APP_OPEN_SPLIT_TITLE: LocalizedText = {
  en: 'Open side by side in the right split pane',
  'zh-CN': '在右侧分屏并排打开',
}
export const APP_OPEN_SPLIT_LABEL: LocalizedText = { en: 'Open app in split view', 'zh-CN': '分屏打开应用' }
export const APP_ENABLE_TITLE: LocalizedText = {
  en: 'Enable this app in the plugin center',
  'zh-CN': '在插件中心启用该应用',
}
export const APP_ENABLE_LABEL: LocalizedText = { en: 'Enable in plugin center', 'zh-CN': '插件中心启用' }
export const APP_DETAIL_TITLE: LocalizedText = { en: 'View app details', 'zh-CN': '查看应用详情' }

/** Accessible name of the detail drawer dialog. */
export function appDetailDialogLabel(name: string, locale: HelmLocale): string {
  return resolveLocalizedText({ en: `${name} app details`, 'zh-CN': `${name} 应用详情` }, locale)
}

/** Detail drawer KV labels. */
export const APP_KV_APP_ID: LocalizedText = { en: 'App ID', 'zh-CN': '应用 ID' }
export const APP_KV_VERSION: LocalizedText = { en: 'Version', 'zh-CN': '版本' }
export const APP_KV_CATEGORY: LocalizedText = { en: 'Category', 'zh-CN': '分类' }
export const APP_KV_PINNED: LocalizedText = { en: 'Pinned status', 'zh-CN': '置顶状态' }
export const APP_KV_WORKSPACE: LocalizedText = { en: 'Workspace source', 'zh-CN': '工作区源码' }
export const APP_KV_INSTALL_SOURCE: LocalizedText = { en: 'Install source', 'zh-CN': '安装来源' }
export const APP_KV_ORIGIN_CONVERSATION: LocalizedText = { en: 'Origin conversation', 'zh-CN': '创建会话' }

/** Version badge tooltip. */
export function appVersionTitle(version: string, locale: HelmLocale): string {
  return resolveLocalizedText({ en: `Version ${version}`, 'zh-CN': `版本 ${version}` }, locale)
}

/** Pinned state values in the detail drawer. */
export const APP_PINNED_YES: LocalizedText = { en: 'Pinned', 'zh-CN': '已置顶' }
export const APP_PINNED_NO: LocalizedText = { en: 'Not pinned', 'zh-CN': '未置顶' }

/** Origin conversation jump button tooltip. */
export function appOriginJumpTitle(conversationId: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `Open conversation #${conversationId} that created this app`, 'zh-CN': `跳转到创建此应用的会话 #${conversationId}` },
    locale,
  )
}

/** Views section of the detail drawer. */
export function appViewsSectionTitle(count: number, locale: HelmLocale): string {
  return resolveLocalizedText({ en: `Views (${count})`, 'zh-CN': `应用视图 (${count})` }, locale)
}
export const APP_OPEN_VIEW_TITLE: LocalizedText = { en: 'Open this view in the main pane', 'zh-CN': '在主屏打开此视图' }
export const APP_OPEN_VIEW_LABEL: LocalizedText = { en: 'Open view', 'zh-CN': '打开视图' }
export const APP_OPEN_VIEW_SPLIT_LABEL: LocalizedText = { en: 'Open this view in split view', 'zh-CN': '分屏打开此视图' }

/** Exposed actions section of the detail drawer. */
export function appActionsSectionTitle(count: number, locale: HelmLocale): string {
  return resolveLocalizedText({ en: `Exposed actions (${count})`, 'zh-CN': `导出能力 (${count})` }, locale)
}

/** Delete confirmation bar in the drawer footer. */
export const APP_DELETE_CONFIRM: LocalizedText = {
  en: 'Uninstall and delete this app?',
  'zh-CN': '确认卸载并删除此应用？',
}
export const APP_CANCEL: LocalizedText = { en: 'Cancel', 'zh-CN': '取消' }
export const APP_DELETING: LocalizedText = { en: 'Deleting…', 'zh-CN': '正在删除…' }
export const APP_DELETE_CONFIRM_LABEL: LocalizedText = { en: 'Delete', 'zh-CN': '确认删除' }

/** Drawer footer actions. */
export const APP_CLOSE: LocalizedText = { en: 'Close', 'zh-CN': '关闭' }
export const APP_ITERATE: LocalizedText = { en: 'Continue iterating', 'zh-CN': '继续对话迭代' }
export const APP_ITERATE_DISABLED_TITLE: LocalizedText = {
  en: 'No origin conversation registered for this app',
  'zh-CN': '该应用未登记创建会话',
}
export const APP_ITERATE_TITLE: LocalizedText = {
  en: 'Return to the origin conversation with the app view in the right pane, edit while viewing',
  'zh-CN': '回到创建会话并把应用视图开到右屏，边看边改',
}
export const APP_UNINSTALL: LocalizedText = { en: 'Delete', 'zh-CN': '删除' }
export const APP_UNINSTALL_TITLE: LocalizedText = {
  en: 'Uninstall and delete this app from the system',
  'zh-CN': '从系统卸载并删除此应用',
}
export const APP_UNINSTALL_LABEL: LocalizedText = { en: 'Uninstall and delete app', 'zh-CN': '卸载删除应用' }

/** Empty states (no apps yet vs. no search match). */
export const APP_EMPTY_NO_APPS: LocalizedText = { en: 'No full-stack apps yet', 'zh-CN': '还没有全栈应用' }
export const APP_EMPTY_NO_MATCH: LocalizedText = { en: 'No matching apps', 'zh-CN': '未找到匹配的应用' }
export const APP_EMPTY_HINT_NO_APPS: LocalizedText = {
  en: 'Ask AI in a conversation to build a full-stack micro app and publish it to the app center; it launches from here.',
  'zh-CN': '在会话中让 AI 生成一个全栈微应用并发布到应用中心，即可在此启动。',
}
export const APP_EMPTY_HINT_NO_MATCH: LocalizedText = {
  en: 'Try different keywords or switch to the pinned tab.',
  'zh-CN': '请尝试调整搜索关键字或切换置顶标签。',
}
export const APP_RESET_FILTERS: LocalizedText = { en: 'Reset filters', 'zh-CN': '重置筛选条件' }

/** Description fallbacks when the plugin summary carries no description. */
export function appDescriptionFromViews(labels: readonly LocalizedText[], locale: HelmLocale): string {
  const resolved = labels.map((label) => resolveLocalizedText(label, locale))
  return resolveLocalizedText(
    {
      en: `Provides views: ${resolved.join(', ')}.`,
      'zh-CN': `提供 ${resolved.join('、')} 视图。`,
    },
    locale,
  )
}
export const APP_DESCRIPTION_FALLBACK: LocalizedText = { en: 'Full-stack micro app.', 'zh-CN': '全栈微应用。' }
