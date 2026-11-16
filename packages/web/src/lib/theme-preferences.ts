/**
 * 主题与后台通知偏好的存储读写及系统配色解析（零 React 依赖，可独立单测）。
 */
import type { ThemeMode, ThemePreference } from './types.js'

export const THEME_STORAGE_KEY = 'helm:theme'
export const QUIET_NOTIFY_STORAGE_KEY = 'helm:quiet-notify'

/** 读取本地保存的主题偏好；存储不可用或值非法时回退 'system'。 */
export function getStoredPreference(storage?: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    const store = storage ?? localStorage
    const saved = store.getItem(THEME_STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
    return 'system'
  } catch {
    return 'system'
  }
}

/** 持久化主题偏好；'system' 移除显式键以跟随系统配色。 */
export function persistThemePreference(
  pref: ThemePreference,
  storage?: Pick<Storage, 'setItem' | 'removeItem'>,
): void {
  try {
    const store = storage ?? localStorage
    if (pref === 'system') {
      store.removeItem(THEME_STORAGE_KEY)
    } else {
      store.setItem(THEME_STORAGE_KEY, pref)
    }
  } catch {
    /* 内存主题仍可使用。 */
  }
}

/** 按 system -> light -> dark -> system 顺序循环切换主题偏好。 */
export function nextThemePreference(prev: ThemePreference): ThemePreference {
  if (prev === 'system') return 'light'
  if (prev === 'light') return 'dark'
  return 'system'
}

/** 后台浏览器通知偏好（localStorage 'helm:quiet-notify' = '1'）。 */
export function getStoredQuietNotify(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    const store = storage ?? localStorage
    return store.getItem(QUIET_NOTIFY_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** 持久化后台浏览器通知开关状态。 */
export function persistQuietNotify(
  enabled: boolean,
  storage?: Pick<Storage, 'setItem' | 'removeItem'>,
): void {
  try {
    const store = storage ?? localStorage
    if (enabled) {
      store.setItem(QUIET_NOTIFY_STORAGE_KEY, '1')
    } else {
      store.removeItem(QUIET_NOTIFY_STORAGE_KEY)
    }
  } catch {
    /* 内存偏好仍生效于本次会话。 */
  }
}

/** 解析当前操作系统的深浅色模式（无 window/matchMedia 时默认 'light'）。 */
export function getSystemTheme(matchMediaFn?: (query: string) => { matches: boolean }): ThemeMode {
  if (matchMediaFn !== undefined) {
    return matchMediaFn('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

/** 将主题偏好解析为实际生效的亮/暗主题。 */
export function resolveTheme(pref: ThemePreference, systemTheme?: ThemeMode): ThemeMode {
  return pref === 'system' ? (systemTheme ?? getSystemTheme()) : pref
}

/** 将实际生效的主题同步到根文档 data-theme 属性。 */
export function applyDocumentTheme(theme: ThemeMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme
  }
}
