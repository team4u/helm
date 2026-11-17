/**
 * Reactive state hooks for theme, background browser notifications and the UI
 * locale. Backing storage and system theme resolution live in
 * theme-preferences.ts; locale normalization lives in @helm/protocol
 * (normalizeLocaleTag).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HelmLocale, LocalizedText } from '@helm/protocol/browser'
import { resolveLocalizedText } from '@helm/protocol/browser'
import { requestBrowserNotificationPermission } from './browser-notification.js'
import {
  applyDocumentLocale,
  applyDocumentTheme,
  getStoredLocalePreference,
  getStoredPreference,
  getStoredQuietNotify,
  nextThemePreference,
  persistLocalePreference,
  persistQuietNotify,
  persistThemePreference,
  resolveBrowserLocale,
  resolveLocale,
  resolveTheme,
} from './theme-preferences.js'
import type { LocalePreference, ThemeMode, ThemePreference, ToastNotice } from './types.js'

export interface UseThemePreferencesResult {
  theme: ThemeMode
  themePreference: ThemePreference
  quietNotifyEnabled: boolean
  /** Current UI locale (resolved from localePreference; browser-derived default zh-* -> zh-CN, others -> en). */
  locale: HelmLocale
  /** Stored UI locale preference ('auto' follows browser language; explicit locale overrides). */
  localePreference: LocalePreference
  /**
   * Referentially stable display-copy translator: always resolves with the
   * locale current at call time (localeRef), so async callbacks neither
   * rebuild on locale switches nor capture a stale locale.
   */
  translate: (text: LocalizedText) => string
  setTheme: (next: ThemeMode) => void
  setThemePreference: (pref: ThemePreference) => void
  toggleTheme: () => void
  setQuietNotify: (on: boolean) => Promise<void>
  setLocale: (next: HelmLocale) => void
  setLocalePreference: (next: LocalePreference) => void
}

export function useThemePreferences(
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void,
): UseThemePreferencesResult {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(getStoredPreference)
  const [theme, setThemeState] = useState<ThemeMode>(() => resolveTheme(getStoredPreference()))
  const [quietNotifyEnabled, setQuietNotifyEnabledState] = useState<boolean>(getStoredQuietNotify)
  // Persisted locale preference wins over the browser-derived default; the
  // state initializer is deliberately lazy so SSR/hydration reads storage once.
  const [localePreference, setLocalePreferenceState] = useState<LocalePreference>(getStoredLocalePreference)
  const [locale, setLocaleState] = useState<HelmLocale>(() => resolveLocale(getStoredLocalePreference()))
  // Locale mirror for stable callbacks: kept fresh in a layout effect so a
  // discarded concurrent render never leaks an uncommitted locale, while every
  // post-commit callback (permission requests, timers) reads the live value.
  const localeRef = useRef(locale)
  useLayoutEffect(() => {
    localeRef.current = locale
  }, [locale])
  const translate = useCallback((text: LocalizedText) => resolveLocalizedText(text, localeRef.current), [])

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

  const setLocalePreference = useCallback((next: LocalePreference) => {
    setLocalePreferenceState(next)
    const effective = resolveLocale(next)
    setLocaleState(effective)
    applyDocumentLocale(effective)
    persistLocalePreference(next)
  }, [])

  const setLocale = useCallback((next: HelmLocale) => setLocalePreference(next), [setLocalePreference])

  // Keep <html lang> in sync with the effective locale (covers the initial mount too).
  useEffect(() => {
    applyDocumentLocale(locale)
  }, [locale])

  // Follow browser language changes while localePreference === 'auto'.
  useEffect(() => {
    if (typeof window === 'undefined' || localePreference !== 'auto') return
    const handler = () => {
      const next = resolveBrowserLocale()
      setLocaleState(next)
      applyDocumentLocale(next)
    }
    window.addEventListener('languagechange', handler)
    return () => window.removeEventListener('languagechange', handler)
  }, [localePreference])

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
          title: translate({ en: 'Notifications unsupported in this browser', 'zh-CN': '当前浏览器不支持通知' }),
          body: translate({
            en: 'The browser notification API is unavailable, so background notification alerts cannot be enabled.',
            'zh-CN': '浏览器通知 API 不可用，无法开启后台通知提醒。',
          }),
        })
        return
      }
      if (permission !== 'granted') {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: translate({ en: 'Browser notification permission not granted', 'zh-CN': '浏览器通知权限未授予' }),
          body: translate({
            en: 'Allow notifications in the browser site settings, then enable background notifications again.',
            'zh-CN': '请在浏览器站点设置中允许通知后重新开启。',
          }),
        })
        return
      }
      setQuietNotifyEnabledState(true)
      persistQuietNotify(true)
    },
    [pushNotice, translate],
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
    localePreference,
    translate,
    setTheme,
    setThemePreference,
    toggleTheme,
    setQuietNotify,
    setLocale,
    setLocalePreference,
  }
}
