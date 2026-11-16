/**
 * 主题与后台浏览器通知的响应式状态管理 hook。
 * 底层纯存储与系统主题解析由 theme-preferences.ts 提供。
 */
import { useCallback, useEffect, useState } from 'react'
import { requestBrowserNotificationPermission } from './browser-notification.js'
import {
  applyDocumentTheme,
  getStoredPreference,
  getStoredQuietNotify,
  nextThemePreference,
  persistQuietNotify,
  persistThemePreference,
  resolveTheme,
} from './theme-preferences.js'
import type { ThemeMode, ThemePreference, ToastNotice } from './types.js'

export interface UseThemePreferencesResult {
  theme: ThemeMode
  themePreference: ThemePreference
  quietNotifyEnabled: boolean
  setTheme: (next: ThemeMode) => void
  setThemePreference: (pref: ThemePreference) => void
  toggleTheme: () => void
  setQuietNotify: (on: boolean) => Promise<void>
}

export function useThemePreferences(
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void,
): UseThemePreferencesResult {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(getStoredPreference)
  const [theme, setThemeState] = useState<ThemeMode>(() => resolveTheme(getStoredPreference()))
  const [quietNotifyEnabled, setQuietNotifyEnabledState] = useState<boolean>(getStoredQuietNotify)

  const setThemePreference = useCallback((pref: ThemePreference) => {
    setThemePreferenceState(pref)
    const effective = resolveTheme(pref)
    setThemeState(effective)
    applyDocumentTheme(effective)
    persistThemePreference(pref)
  }, [])

  const setTheme = useCallback((next: ThemeMode) => setThemePreference(next), [setThemePreference])

  const toggleTheme = useCallback(() => {
    setThemePreferenceState((prev) => {
      const next = nextThemePreference(prev)
      const effective = resolveTheme(next)
      setThemeState(effective)
      applyDocumentTheme(effective)
      persistThemePreference(next)
      return next
    })
  }, [])

  /** 开启前先请求浏览器通知权限（用户手势内）：被拒不启用并明确提示，绝不静默装作已开启。 */
  const setQuietNotify = useCallback(
    async (on: boolean) => {
      if (!on) {
        setQuietNotifyEnabledState(false)
        persistQuietNotify(false)
        return
      }
      const permission = await requestBrowserNotificationPermission()
      if (permission === 'unsupported') {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: '当前浏览器不支持通知',
          body: '浏览器通知 API 不可用，无法开启后台通知提醒。',
        })
        return
      }
      if (permission !== 'granted') {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: '浏览器通知权限未授予',
          body: '请在浏览器站点设置中允许通知后重新开启。',
        })
        return
      }
      setQuietNotifyEnabledState(true)
      persistQuietNotify(true)
    },
    [pushNotice],
  )

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      if (themePreference === 'system') {
        const next: ThemeMode = e.matches ? 'dark' : 'light'
        setThemeState(next)
        applyDocumentTheme(next)
      }
    }
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [themePreference])

  return {
    theme,
    themePreference,
    quietNotifyEnabled,
    setTheme,
    setThemePreference,
    toggleTheme,
    setQuietNotify,
  }
}
