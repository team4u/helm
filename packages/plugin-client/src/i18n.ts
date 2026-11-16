/**
 * Locale & translation helpers for plugin client components.
 *
 * - `usePluginLocale()` resolves the active host UI locale: plugin context
 *   (usePluginContext) first, then the host port, then DEFAULT_HELM_LOCALE —
 *   a locale always has a well-defined default, so unlike data ports this
 *   never throws for a missing provider;
 * - `usePluginTranslator()` returns a referentially stable minimal translator
 *   bound to that locale (resolves LocalizedText display copy);
 * - the locale essentials (HelmLocale / LocalizedText / normalize / resolve /
 *   translator factory) are re-exported so plugin client.tsx code can consume
 *   them from the shared module without depending on @helm/protocol at build
 *   time (the shared module is virtualized into
 *   __helm_shared_plugin_client, exactly like React).
 *
 * These hooks are exported from the SDK index and included in
 * PLUGIN_CLIENT_SHARED_EXPORTS so compiled plugin clients can consume the
 * host locale through the shared runtime namespace.
 *
 * No component exports in this file (Fast Refresh friendly).
 */
import { useContext, useMemo } from 'react'
import {
  DEFAULT_HELM_LOCALE,
  createLocaleTranslator,
  type HelmLocale,
  type LocaleTranslator,
} from '@helm/protocol/browser'
import { PluginClientHostContext } from './host-port.js'
import { PluginClientContext } from './plugin-context.js'

/** Resolve the active UI locale: plugin context first, host port fallback, default locale last. */
export function usePluginLocale(): HelmLocale {
  const ctx = useContext(PluginClientContext)
  const host = useContext(PluginClientHostContext)
  return ctx?.locale ?? host?.locale ?? DEFAULT_HELM_LOCALE
}

/** Minimal translator bound to the active locale; referentially stable across renders while the locale is unchanged. */
export function usePluginTranslator(): LocaleTranslator {
  const locale = usePluginLocale()
  return useMemo(() => createLocaleTranslator(locale), [locale])
}

// Locale essentials re-exported for plugin client consumption (same bindings as @helm/protocol).
export {
  HELM_LOCALES,
  DEFAULT_HELM_LOCALE,
  isHelmLocale,
  normalizeLocaleTag,
  parseLocalizedText,
  resolveLocalizedText,
  createLocaleTranslator,
} from '@helm/protocol/browser'
export type { HelmLocale, LocalizedText, ExecutionText, LocaleTranslator } from '@helm/protocol/browser'
