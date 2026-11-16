/**
 * Reactive state hooks for theme, background browser notifications and the UI
 * locale. Backing storage and system theme resolution live in
 * theme-preferences.ts; locale normalization lives in @helm/protocol
 * (normalizeLocaleTag).
 */
import { useCallback, useEffect, useState } from 'react'
import type { HelmLocale } from '@helm/protocol/browser'
import { requestBrowserNotificationPermission } from './browser-notification.js'
import {
  applyDocumentLocale,
  applyDocumentTheme,
  getStoredPreference,
  getStoredQuietNotify,
  nextThemePreference,
  persistLocale,
  persistQuietNotify,
  persistThemePreference,
  resolveInitialLocale,
  resolveTheme,
} from './theme-preferences.js'
import type { ThemeMode, ThemePreference, ToastNotice } from './types.js'

export interface UseThemePreferencesResult {
  theme: ThemeMode
  themePreference: ThemePreference
  quietNotifyEnabled: boolean
  /** Current UI locale (persisted preference; browser-derived default zh-* -> zh-CN, others -> en). */
  locale: HelmLocale
  setTheme: (next: ThemeMode) => void
  setThemePreference: (pref: ThemePreference) => void
  toggleTheme: () => void
  setQuietNotify: (on: boolean) => Promise<void>
  setLocale: (next: HelmLocale) => void
}

export function useThemePreferences(
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void,
): UseThemePreferencesResult {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(getStoredPreference)
  const [theme, setThemeState] = useState<ThemeMode>(() => resolveTheme(getStoredPreference()))
  const [quietNotifyEnabled, setQuietNotifyEnabledState] = useState<boolean>(getStoredQuietNotify)
  // Persisted locale preference wins over the browser-derived default; the
  // state initializer is deliberately lazy so SSR/hydration reads storage once.
  const [locale, setLocaleState] = useState<HelmLocale>(() => resolveInitialLocale())

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

  const setLocale = useCallback((next: HelmLocale) => {
    setLocaleState(next)
    persistLocale(next)
  }, [])

  // Keep <html lang> in sync with the effective locale (covers the initial mount too).
  useEffect(() => {
    applyDocumentLocale(locale)
  }, [locale])

  /** Requests browser notification permission before enabling (inside the user gesture): refused -> not enabled, explicit notice, never silently pretending it is on. */
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
    locale,
    setTheme,
    setThemePreference,
    toggleTheme,
    setQuietNotify,
    setLocale,
  }
}
