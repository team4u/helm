/**
 * Storage read/write for theme, background-notification and UI-locale
 * preferences plus system color-scheme resolution (zero React dependencies,
 * independently unit-testable).
 */
import type { HelmxLocale } from '@helmx/protocol/browser'
import { normalizeLocaleTag } from '@helmx/protocol/browser'
import type { LocalePreference, ThemeMode, ThemePreference } from './types.js'

export const THEME_STORAGE_KEY = 'helmx:theme'
export const QUIET_NOTIFY_STORAGE_KEY = 'helmx:quiet-notify'
export const LOCALE_STORAGE_KEY = 'helmx:locale'

/** Read the persisted theme preference; falls back to 'system' when storage is unavailable or the value is invalid. */
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

/** Persist the theme preference; 'system' removes the explicit key to follow the system color scheme. */
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
    /* The in-memory theme still works. */
  }
}

/** Cycles the theme preference in system -> light -> dark -> system order. */
export function nextThemePreference(prev: ThemePreference): ThemePreference {
  if (prev === 'system') return 'light'
  if (prev === 'light') return 'dark'
  return 'system'
}

/** Background browser notification preference (localStorage 'helmx:quiet-notify' = '1'). */
export function getStoredQuietNotify(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    const store = storage ?? localStorage
    return store.getItem(QUIET_NOTIFY_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the background browser notification toggle. */
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
    /* The in-memory preference still applies to this session. */
  }
}

// ---------------------------------------------------------------------------
// UI locale preference (localStorage 'helmx:locale'; browser-derived default)
// ---------------------------------------------------------------------------

/** Read the persisted UI locale preference; returns 'auto' when the key is absent. */
export function getStoredLocalePreference(storage?: Pick<Storage, 'getItem'>): LocalePreference {
  try {
    const store = storage ?? localStorage
    const raw = store.getItem(LOCALE_STORAGE_KEY)
    return raw === null ? 'auto' : normalizeLocaleTag(raw)
  } catch {
    return 'auto'
  }
}

/**
 * Persist the UI locale preference; 'auto' removes the explicit key so the
 * effective locale follows the browser language.
 */
export function persistLocalePreference(
  pref: LocalePreference,
  storage?: Pick<Storage, 'setItem' | 'removeItem'>,
): void {
  try {
    const store = storage ?? localStorage
    if (pref === 'auto') {
      store.removeItem(LOCALE_STORAGE_KEY)
    } else {
      store.setItem(LOCALE_STORAGE_KEY, pref)
    }
  } catch {
    /* The in-memory preference still applies to this session. */
  }
}

/** Resolve a LocalePreference into the effective HelmxLocale. */
export function resolveLocale(pref: LocalePreference, languages?: readonly string[]): HelmxLocale {
  return pref === 'auto' ? resolveBrowserLocale(languages) : pref
}

/**
 * Read the persisted UI locale preference. Returns undefined when the key is
 * absent (caller falls back to the browser locale, mirroring the theme
 * 'system' default); stored values are normalized through normalizeLocaleTag
 * (zh-* -> zh-CN, anything invalid/unsupported -> 'en').
 */
export function getStoredLocale(storage?: Pick<Storage, 'getItem'>): HelmxLocale | undefined {
  try {
    const store = storage ?? localStorage
    const raw = store.getItem(LOCALE_STORAGE_KEY)
    return raw === null ? undefined : normalizeLocaleTag(raw)
  } catch {
    return undefined
  }
}

/** Persist the UI locale preference; the value is always a supported HelmxLocale. */
export function persistLocale(locale: HelmxLocale, storage?: Pick<Storage, 'setItem' | 'removeItem'>): void {
  try {
    ;(storage ?? localStorage).setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    /* The in-memory locale still applies to this session. */
  }
}

/**
 * Resolve the browser locale preference: takes the first usable language tag
 * (navigator.languages, falling back to navigator.language) and normalizes it
 * — zh-* -> zh-CN, everything else -> 'en'. Defaults to 'en' without a
 * navigator (SSR/tests).
 */
export function resolveBrowserLocale(languages?: readonly string[]): HelmxLocale {
  let candidates: readonly string[]
  if (languages !== undefined) {
    candidates = languages
  } else if (typeof navigator !== 'undefined') {
    candidates =
      navigator.languages !== undefined && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language]
  } else {
    candidates = []
  }
  const first = candidates.find((tag) => typeof tag === 'string' && tag.trim() !== '')
  return normalizeLocaleTag(first)
}

/**
 * Resolve the initial UI locale: the persisted preference wins, otherwise the
 * browser locale decides (zh-* -> zh-CN, others -> 'en').
 */
export function resolveInitialLocale(
  storage?: Pick<Storage, 'getItem'>,
  languages?: readonly string[],
): HelmxLocale {
  return getStoredLocale(storage) ?? resolveBrowserLocale(languages)
}

/** Sync the effective locale to the root document lang attribute. */
export function applyDocumentLocale(locale: HelmxLocale): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
}

/** Resolve the current OS light/dark mode (defaults to 'light' without window/matchMedia). */
export function getSystemTheme(matchMediaFn?: (query: string) => { matches: boolean }): ThemeMode {
  if (matchMediaFn !== undefined) {
    return matchMediaFn('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

/** Resolve the theme preference into the actually effective light/dark theme. */
export function resolveTheme(pref: ThemePreference, systemTheme?: ThemeMode): ThemeMode {
  return pref === 'system' ? (systemTheme ?? getSystemTheme()) : pref
}

/** Sync the effective theme to the root document data-theme attribute. */
export function applyDocumentTheme(theme: ThemeMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme
  }
}
