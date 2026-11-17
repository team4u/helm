/**
 * Pure data models for the builtin:triggers client.tsx (no component exports,
 * Fast Refresh friendly).
 *
 * Doc shapes mirror the server-side triggers/cron.ts and triggers/webhook.ts
 * contracts; parsing is lenient: when a doc has not arrived or fields are
 * missing we return safe defaults instead of fabricating data.
 */
import { DEFAULT_HELM_LOCALE, resolveLocalizedText, type HelmLocale } from '@helm/plugin-client'
import { TRIGGER_TARGET_DEFAULT, triggerTargetConversation, triggerTargetProfile, triggerTargetThreadKey } from './copy.ts'

/** Row shape of the CronDoc (public doc 'crons'), display field subset. */
export interface CronJobRow {
  id: string
  description?: string
  schedule: string
  timezone: string
  text: string
  enabled: boolean
  catchUp: boolean
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
  lastRunAt?: number
  nextRunAt?: number
  lastError?: string
}

/** Row shape of the WebhooksDoc (public doc 'webhooks'), display field subset. */
export interface WebhookRow {
  id: string
  hasSecret: boolean
  description?: string
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
  createdAt: number
}

export type TriggerDetailSelection =
  | { kind: 'cron'; id: string }
  | { kind: 'webhook'; id: string }

/**
 * Human-readable summary of a trigger's delivery target (conversation /
 * profile / ThreadKey, falling back to default routing when no explicit
 * target is set). Copy resolves against the given locale (defaults to en so
 * existing English assertions stay valid).
 */
export function formatTriggerTargetSummary(
  row: {
    targetConversationId?: number
    targetProfileId?: string
    threadKey?: string
  },
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  const parts: string[] = []
  if (row.targetConversationId !== undefined) {
    parts.push(triggerTargetConversation(row.targetConversationId, locale))
  }
  if (row.targetProfileId) {
    parts.push(triggerTargetProfile(row.targetProfileId, locale))
  }
  if (row.threadKey) {
    parts.push(triggerTargetThreadKey(row.threadKey, locale))
  }
  return parts.length > 0 ? parts.join(' · ') : resolveLocalizedText(TRIGGER_TARGET_DEFAULT, locale)
}

export function parseCronJobs(doc: { jobs?: unknown } | undefined): CronJobRow[] {
  return Array.isArray(doc?.jobs) ? (doc!.jobs as CronJobRow[]) : []
}

export function parseWebhooks(doc: { webhooks?: unknown } | undefined): WebhookRow[] {
  return Array.isArray(doc?.webhooks) ? (doc!.webhooks as WebhookRow[]) : []
}
