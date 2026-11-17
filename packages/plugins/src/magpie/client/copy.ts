/**
 * Display copy for the builtin:magpie settings panel (pure copy table, no
 * component exports — Fast Refresh friendly).
 *
 * The gateway status overview, diagnostics / quota / route tables and the
 * refresh action resolve every human-visible string here against the active
 * host locale; gateway diagnostics, lastError and quota data from the status
 * doc pass through unchanged.
 */
import type { HelmLocale, LocalizedText } from '@helm/plugin-client'
import { resolveLocalizedText } from '@helm/plugin-client'

/** Panel header and refresh action. */
export const MAGPIE_TITLE: LocalizedText = { en: 'Magpie Gateway', 'zh-CN': 'Magpie 网关' }
export const MAGPIE_REFRESHING: LocalizedText = { en: 'Refreshing…', 'zh-CN': '刷新中...' }
export const MAGPIE_REFRESH: LocalizedText = { en: 'Refresh model catalog', 'zh-CN': '刷新模型目录' }
export const MAGPIE_LOADING: LocalizedText = { en: 'Loading gateway status…', 'zh-CN': '网关状态读取中...' }

/** Boolean yes/no display. */
export const MAGPIE_YES: LocalizedText = { en: 'Yes', 'zh-CN': '是' }
export const MAGPIE_NO: LocalizedText = { en: 'No', 'zh-CN': '否' }

/** Status overview KV keys. */
export const MAGPIE_KV_GATEWAY_URL: LocalizedText = { en: 'Gateway URL', 'zh-CN': '网关地址' }
export const MAGPIE_KV_LOCAL_LOOPBACK: LocalizedText = { en: 'Local loopback', 'zh-CN': '本机 loopback' }
export const MAGPIE_KV_REACHABLE: LocalizedText = { en: 'Reachable', 'zh-CN': '可达' }
export const MAGPIE_KV_MODELS: LocalizedText = { en: 'Models', 'zh-CN': '模型数' }
export const MAGPIE_KV_MODELS_CACHED: LocalizedText = { en: 'Models (cached)', 'zh-CN': '模型数（缓存）' }
export const MAGPIE_KV_GROUPS: LocalizedText = { en: 'Route groups', 'zh-CN': '路由组数' }
export const MAGPIE_KV_LAST_REFRESHED: LocalizedText = { en: 'Last refreshed', 'zh-CN': '最近刷新' }
export const MAGPIE_KV_LAST_ERROR: LocalizedText = { en: 'Last error', 'zh-CN': '最近错误' }

/** Diagnostics table. */
export const MAGPIE_DIAGNOSTICS_SECTION: LocalizedText = { en: 'Diagnostics', 'zh-CN': '诊断' }
export const MAGPIE_DIAGNOSTICS_COL: LocalizedText = { en: 'Unavailable items', 'zh-CN': '不可用项' }
export const MAGPIE_DIAGNOSTICS_EMPTY: LocalizedText = { en: 'No diagnostics', 'zh-CN': '无诊断信息' }

/** Quota & route tables shared column. */
export const MAGPIE_COL_PROVIDER: LocalizedText = { en: 'Provider', 'zh-CN': '供应商' }

/** Quota table. */
export const MAGPIE_QUOTA_SECTION: LocalizedText = { en: 'Quotas', 'zh-CN': '配额' }
export const MAGPIE_QUOTA_COL_ACCOUNT: LocalizedText = { en: 'Account', 'zh-CN': '账号' }
export const MAGPIE_QUOTA_COL_WINDOW: LocalizedText = { en: 'Window', 'zh-CN': '窗口' }
export const MAGPIE_QUOTA_COL_REMAINING: LocalizedText = { en: 'Remaining %', 'zh-CN': '剩余 %' }
export const MAGPIE_QUOTA_COL_RESET: LocalizedText = { en: 'Reset', 'zh-CN': '重置' }
export const MAGPIE_QUOTA_EMPTY: LocalizedText = { en: 'No quota data', 'zh-CN': '暂无配额数据' }

/** Route history table. */
export const MAGPIE_ROUTES_SECTION: LocalizedText = { en: 'Route history', 'zh-CN': '路由轨迹' }
export const MAGPIE_ROUTES_COL_GROUP: LocalizedText = { en: 'Route group', 'zh-CN': '路由组' }
export const MAGPIE_ROUTES_COL_STRATEGY: LocalizedText = { en: 'Strategy', 'zh-CN': '策略' }
export const MAGPIE_ROUTES_COL_MODEL: LocalizedText = { en: 'Hit model', 'zh-CN': '命中模型' }
export const MAGPIE_ROUTES_COL_TIME: LocalizedText = { en: 'Time', 'zh-CN': '时间' }
export const MAGPIE_ROUTES_EMPTY: LocalizedText = { en: 'No route history', 'zh-CN': '暂无路由记录' }

/** Resolve the yes/no label used by models.ts boolLabel. */
export function magpieBoolLabel(value: boolean, locale: HelmLocale): string {
  return resolveLocalizedText(value ? MAGPIE_YES : MAGPIE_NO, locale)
}
