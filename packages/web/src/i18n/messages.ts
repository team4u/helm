/**
 * Web UI message catalog primitives: pure types plus a table-bound translator
 * factory (zero React, zero DOM; independently unit-testable).
 *
 * Copy model alignment with `@helmx/protocol` locale.ts:
 * - Display copy lives in message tables keyed by dot-namespaced ids; every
 *   entry must declare BOTH supported locales (`en` + `zh-CN`) at compile time,
 *   which is stricter than protocol `LocalizedText` (a plain string or partial
 *   map) — tables remain assignable wherever a `LocalizedText` is expected.
 * - Execution copy (thrown errors, protocol payloads, journal/log text) stays
 *   a plain locale-stable string and must NOT be routed through these tables.
 *
 * Interpolation: `{name}` placeholders, resolved from `MessageParams`; unknown
 * placeholders are left verbatim so missing data stays greppable.
 *
 * Missing keys return the key itself (visible in tests and UI, never a silent
 * empty string) — production code is protected by the `WebMessageKey` literal
 * union, so runtime misses can only come from hand-built tables in tests.
 */
import type { HelmxLocale } from '@helmx/protocol/browser'

/** One catalog entry: display copy for every supported UI locale. */
export type MessageEntry = Readonly<{ en: string; 'zh-CN': string }>

/** A domain message table: dot-namespaced message ids to bilingual entries. */
export type MessageTable = Readonly<Record<string, MessageEntry>>

/** Interpolation params for `{name}` placeholders. */
export type MessageParams = Readonly<Record<string, string | number>>

/** Translator bound to one locale and one table; referentially cheap to create. */
export type MessageTranslator<Table extends MessageTable = MessageTable> = (
  key: keyof Table & string,
  params?: MessageParams,
) => string

/** Replace `{name}` placeholders with params; unknown placeholders stay verbatim. */
export function formatMessage(template: string, params?: MessageParams): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]!) : match,
  )
}

/** Resolve one message: exact entry hit then interpolate; a missing key echoes the key itself. */
export function translateMessage(
  table: MessageTable,
  locale: HelmxLocale,
  key: string,
  params?: MessageParams,
): string {
  const entry = table[key]
  if (entry === undefined) return key
  return formatMessage(entry[locale], params)
}

/** Create a translator bound to a locale and a table (pure; safe to recreate per render). */
export function createMessageTranslator<Table extends MessageTable>(
  locale: HelmxLocale,
  table: Table,
): MessageTranslator<Table> {
  return (key, params) => translateMessage(table, locale, key, params)
}
