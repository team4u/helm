/**
 * builtin:triggers 插件 client.tsx 纯数据模型（无组件导出，保 Fast Refresh 契约）。
 *
 * doc 形状与服务端 triggers/cron.ts、triggers/webhook.ts 契约同构；
 * 宽容解析：doc 未到达或字段缺失时返回安全缺省，不虚构数据。
 */

/** CronDoc（public doc 'crons'）行形状（展示字段子集）。 */
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

/** WebhooksDoc（public doc 'webhooks'）行形状（展示字段子集）。 */
export interface WebhookRow {
  id: string
  hasSecret: boolean
  description?: string
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
  createdAt: number
}

export function parseCronJobs(doc: { jobs?: unknown } | undefined): CronJobRow[] {
  return Array.isArray(doc?.jobs) ? (doc!.jobs as CronJobRow[]) : []
}

export function parseWebhooks(doc: { webhooks?: unknown } | undefined): WebhookRow[] {
  return Array.isArray(doc?.webhooks) ? (doc!.webhooks as WebhookRow[]) : []
}

/** 展示用紧凑时间（本地时区；缺失返回空串）。 */
export function formatTime(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
