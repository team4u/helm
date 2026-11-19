/**
 * Shared locale contract for the helmx UI and plugin client surfaces.
 *
 * Browser-safe (zero runtime dependencies): pure types, constants and pure
 * functions only; re-exported by both `@helmx/protocol` and
 * `@helmx/protocol/browser`.
 *
 * Copy model (phase 1):
 * - Display copy (`LocalizedText`): text rendered to humans in the Web UI.
 *   Either a locale-independent plain string (backwards compatible with every
 *   existing string protocol field) or a per-locale map resolved via
 *   `resolveLocalizedText` / a translator bound to the active locale.
 * - Execution copy (`ExecutionText`): text consumed by automated surfaces
 *   (model prompts, workflow journals, logs, machine parsing). Always a plain
 *   string, deliberately never localized — the active locale must never change
 *   execution behavior.
 */

/** Locales supported by the helmx UI. Order is the fallback order after the requested locale. */
export const HELMX_LOCALES = ['en', 'zh-CN'] as const

/** Supported UI locale (stable union locked to HELMX_LOCALES). */
export type HelmxLocale = (typeof HELMX_LOCALES)[number]

/** Fallback locale when nothing better is available (also the invalid-tag fallback). */
export const DEFAULT_HELMX_LOCALE: HelmxLocale = 'en'

/** Exact-match guard for supported locales (case sensitive). */
export function isHelmxLocale(value: unknown): value is HelmxLocale {
  return value === 'en' || value === 'zh-CN'
}

/**
 * Normalize a BCP-47-ish language tag (dash separated, case insensitive) to a
 * supported locale:
 * - `zh` and any `zh-*` variant (zh-TW, zh-Hans, ...) map to `zh-CN`;
 * - everything else — including `en-*`, unsupported languages, malformed tags
 *   and non-string input — falls back to `en`.
 */
export function normalizeLocaleTag(tag: string | null | undefined): HelmxLocale {
  if (typeof tag !== 'string') return DEFAULT_HELMX_LOCALE
  const normalized = tag.trim().toLowerCase()
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
  return DEFAULT_HELMX_LOCALE
}

/**
 * Display copy: a locale-independent plain string, or a per-locale map with at
 * least one supported locale entry. Resolve with `resolveLocalizedText` or a
 * `LocaleTranslator`; never parse untrusted input directly (use
 * `parseLocalizedText` at the boundary).
 */
export type LocalizedText = string | Readonly<Partial<Record<HelmxLocale, string>>>

/**
 * Execution copy: locale-stable plain string for automated consumers (prompt
 * snippets, workflow journals, logs, machine parsing). Structural alias of
 * `string` — documents intent without breaking any existing string field.
 */
export type ExecutionText = string

/**
 * Validate and narrow unknown input to `LocalizedText` (boundary guard):
 * plain strings pass through; objects must map supported-locale keys to string
 * values and declare at least one own entry. Anything else returns undefined.
 * Note: empty/whitespace-only strings are accepted here — use
 * `parseNonEmptyLocalizedText` where display metadata must be non-empty.
 */
export function parseLocalizedText(value: unknown): LocalizedText | undefined {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  let entries = 0
  for (const [key, text] of Object.entries(value)) {
    if (!isHelmxLocale(key) || typeof text !== 'string') return undefined
    entries++
  }
  return entries > 0 ? (value as LocalizedText) : undefined
}

/**
 * Strict display-metadata guard: `parseLocalizedText` plus a non-empty
 * (after trim) requirement on the plain string and on every locale entry.
 * This is the single pure validator for plugin display metadata declared at
 * registration boundaries (definition name/description, UI spec label/title/
 * description, config field label/description): unsupported locale keys,
 * non-string values and blank copy are all rejected.
 */
export function parseNonEmptyLocalizedText(value: unknown): LocalizedText | undefined {
  const parsed = parseLocalizedText(value)
  if (parsed === undefined) return undefined
  if (typeof parsed === 'string') return parsed.trim().length > 0 ? parsed : undefined
  for (const text of Object.values(parsed)) {
    if (text.trim().length === 0) return undefined
  }
  return parsed
}

/**
 * Resolve display copy for a locale: exact hit wins, then the default locale,
 * then the first declared entry in HELMX_LOCALES order; plain strings pass
 * through unchanged; a map without any usable entry resolves to ''.
 */
export function resolveLocalizedText(text: LocalizedText, locale: HelmxLocale): string {
  if (typeof text === 'string') return text
  const direct = text[locale]
  if (typeof direct === 'string') return direct
  const fallback = text[DEFAULT_HELMX_LOCALE]
  if (typeof fallback === 'string') return fallback
  for (const candidate of HELMX_LOCALES) {
    const value = text[candidate]
    if (typeof value === 'string') return value
  }
  return ''
}

/** Minimal translator: resolves `LocalizedText` to a display string for one locale. */
export type LocaleTranslator = (text: LocalizedText) => string

/**
 * Reusable JSON Schema fragment for LocalizedText-typed action output fields
 * (a plain string or a map over supported locale keys; at least one entry).
 * Boundary output validation stays honest: localized display copy passes
 * through instead of being coerced to one locale.
 */
export const LOCALIZED_TEXT_JSON_SCHEMA = {
  anyOf: [
    { type: 'string', minLength: 1 },
    {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: { en: { type: 'string' }, 'zh-CN': { type: 'string' } },
    },
  ],
} as const

/** Create a translator bound to a locale (pure; safe to recreate per render). */
export function createLocaleTranslator(locale: HelmxLocale): LocaleTranslator {
  return (text) => resolveLocalizedText(text, locale)
}
