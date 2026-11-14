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
