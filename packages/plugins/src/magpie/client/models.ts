/**
 * Pure data models for the builtin:magpie client.tsx (no component exports,
 * Fast Refresh friendly).
 *
 * The doc shape mirrors the MagpieStatusDoc contract from magpie/contracts.ts;
 * parsing is lenient: when the doc has not arrived we return safe defaults
 * instead of fabricating data.
 */
import { DEFAULT_HELM_LOCALE, type HelmLocale } from '@helm/plugin-client'
import { magpieBoolLabel } from './copy.ts'

/** Display field subset of MagpieStatusDoc. */
export interface MagpieStatusView {
  gatewayUrl: string
  configuredRoot: boolean
  local: boolean
  reachable: boolean
  modelCount: number
  groupCount: number
  lastRefreshedAt?: number
  lastError?: string
  summaryText: string
  quotas: Array<{ provider: string; account?: string; windowLabel?: string; remainingPercent: number; resetText?: string }>
  routes: Array<{ group: string; strategy?: string; provider?: string; model?: string; timestamp?: string }>
  diagnostics: string[]
}

const EMPTY: MagpieStatusView = {
  gatewayUrl: '',
  configuredRoot: false,
  local: true,
  reachable: false,
  modelCount: 0,
  groupCount: 0,
  summaryText: '',
  quotas: [],
  routes: [],
  diagnostics: [],
}

/** Lenient read of the status doc (missing fields fall back to safe defaults). */
export function parseStatus(doc: MagpieStatusView | undefined): MagpieStatusView {
  if (doc === undefined || typeof doc !== 'object') return EMPTY
  return {
    gatewayUrl: typeof doc.gatewayUrl === 'string' ? doc.gatewayUrl : '',
    configuredRoot: doc.configuredRoot === true,
    local: doc.local !== false,
    reachable: doc.reachable === true,
    modelCount: typeof doc.modelCount === 'number' ? doc.modelCount : 0,
    groupCount: typeof doc.groupCount === 'number' ? doc.groupCount : 0,
    lastRefreshedAt: typeof doc.lastRefreshedAt === 'number' ? doc.lastRefreshedAt : undefined,
    lastError: typeof doc.lastError === 'string' ? doc.lastError : undefined,
    summaryText: typeof doc.summaryText === 'string' ? doc.summaryText : '',
    quotas: Array.isArray(doc.quotas) ? doc.quotas : [],
    routes: Array.isArray(doc.routes) ? doc.routes : [],
    diagnostics: Array.isArray(doc.diagnostics) ? doc.diagnostics.filter((d) => typeof d === 'string') : [],
  }
}

/** Boolean display: yes / no (resolved against the given locale, defaults to en). */
export function boolLabel(value: boolean, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return magpieBoolLabel(value, locale)
}

/** Quota remaining-percent tone (<20% warning threshold). */
export function quotaTone(remainingPercent: number): 'ok' | 'warn' | 'err' {
  if (remainingPercent < 5) return 'err'
  if (remainingPercent < 20) return 'warn'
  return 'ok'
}
