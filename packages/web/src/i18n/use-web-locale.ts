/**
 * `useWebLocale`: the single Web-side locale hook.
 *
 * Reads the authoritative locale from the helm store (`useHelmStore`) — the
 * same source that feeds `PluginClientHostContext` for SDK components — and
 * returns a stable `{ locale, t }` pair. Components must consume locale
 * exclusively through this hook (never prop-drill locale, never read storage,
 * never keep a module-level mutable language variable). Switching the locale
 * via `store.setLocale` re-renders every consumer immediately.
 *
 * Pure model functions (`*-model.ts`) never call this hook: they take an
 * explicit `t` (or `locale`) parameter instead; see `i18n/catalog.ts` for the
 * English bridge default used at not-yet-migrated call sites.
 */
import { useContext, useMemo } from 'react'
import { DEFAULT_HELM_LOCALE, type HelmLocale } from '@helm/protocol/browser'
import { HelmStoreContext } from '../lib/store-context.js'
import { createWebTranslator, type WebMessageTranslator } from './catalog.js'

export interface WebLocaleValue {
  /** Active UI locale (authoritative store state, or DEFAULT_HELM_LOCALE outside a provider). */
  locale: HelmLocale
  /** Full-catalog message translator bound to the active locale. */
  t: WebMessageTranslator
}

export function useWebLocale(): WebLocaleValue {
  const store = useContext(HelmStoreContext)
  const locale = store?.locale ?? DEFAULT_HELM_LOCALE
  return useMemo(() => ({ locale, t: createWebTranslator(locale) }), [locale])
}
