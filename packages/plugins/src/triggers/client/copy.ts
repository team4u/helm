/**
 * Display copy for the builtin:triggers client (pure copy table + builders,
 * no component exports — Fast Refresh friendly).
 *
 * The cron/webhook manager tables, detail drawer and settings panel resolve
 * every human-visible string here against the active host locale; backend
 * action error messages pass through unchanged (only the failure prefix is
 * localized).
 */
import type { HelmxLocale, LocalizedText } from '@helmx/plugin-client'
import { resolveLocalizedText } from '@helmx/plugin-client'

/** Manager screen chrome. */
export const TRIGGERS_SCREEN_TITLE: LocalizedText = { en: 'Triggers', 'zh-CN': '触发器管理' }
export const TRIGGERS_SPLIT_SUFFIX: LocalizedText = { en: ' · Split', 'zh-CN': ' · 分屏' }

/** Section headings. */
export const TRIGGERS_CRON_SECTION: LocalizedText = { en: 'Cron jobs', 'zh-CN': 'Cron 定时任务' }
export const TRIGGERS_WEBHOOK_SECTION: LocalizedText = { en: 'Webhook endpoints', 'zh-CN': 'Webhook 端点' }
export const TRIGGERS_SETTINGS_SECTION: LocalizedText = { en: 'Triggers', 'zh-CN': '触发器' }

/** Cron table column headers (shared by <th> and data-label). */
export const TRIGGERS_COL_SCHEDULE: LocalizedText = { en: 'Schedule', 'zh-CN': '调度' }
export const TRIGGERS_COL_COMMAND: LocalizedText = { en: 'Command', 'zh-CN': '指令' }
export const TRIGGERS_COL_ENABLED: LocalizedText = { en: 'Enabled', 'zh-CN': '启用' }
export const TRIGGERS_COL_LAST_RUN: LocalizedText = { en: 'Last run', 'zh-CN': '上次运行' }
export const TRIGGERS_COL_NEXT_RUN: LocalizedText = { en: 'Next run', 'zh-CN': '下次运行' }
export const TRIGGERS_COL_LAST_ERROR: LocalizedText = { en: 'Last error', 'zh-CN': '最近错误' }
export const TRIGGERS_COL_ACTIONS: LocalizedText = { en: 'Actions', 'zh-CN': '操作' }
export const TRIGGERS_COL_DESCRIPTION: LocalizedText = { en: 'Description', 'zh-CN': '描述' }
export const TRIGGERS_COL_CREATED: LocalizedText = { en: 'Created', 'zh-CN': '创建时间' }

/** Loading and empty states (raw helmx-table cells, not the SDK DataTable). */
export const TRIGGERS_CRON_LOADING: LocalizedText = { en: 'Loading cron jobs…', 'zh-CN': 'Cron 任务读取中...' }
export const TRIGGERS_WEBHOOK_LOADING: LocalizedText = { en: 'Loading webhooks…', 'zh-CN': 'Webhook 端点读取中...' }
export const TRIGGERS_SETTINGS_LOADING: LocalizedText = { en: 'Loading trigger state…', 'zh-CN': '触发器状态读取中...' }
export const TRIGGERS_TABLE_EMPTY: LocalizedText = { en: 'No data', 'zh-CN': '暂无数据' }

/** Enabled / disabled badges and catch-up switch values. */
export const TRIGGERS_ENABLED: LocalizedText = { en: 'Enabled', 'zh-CN': '启用' }
export const TRIGGERS_DISABLED: LocalizedText = { en: 'Disabled', 'zh-CN': '停用' }
export const TRIGGERS_ON: LocalizedText = { en: 'On', 'zh-CN': '开启' }
export const TRIGGERS_OFF: LocalizedText = { en: 'Off', 'zh-CN': '关闭' }

/** Row actions. */
export const TRIGGERS_TRIGGER_NOW: LocalizedText = { en: 'Trigger now', 'zh-CN': '立即触发' }
export const TRIGGERS_DELETE: LocalizedText = { en: 'Delete', 'zh-CN': '删除' }
export const TRIGGERS_CLOSE: LocalizedText = { en: 'Close', 'zh-CN': '关闭' }

/** Detail drawer chrome. */
export const TRIGGERS_DETAIL_TITLE: LocalizedText = { en: 'Trigger details', 'zh-CN': '触发器详情' }
export const TRIGGERS_CRON_DETAIL_SUBTITLE: LocalizedText = { en: 'Cron trigger details', 'zh-CN': 'Cron 定时触发器详情' }
export const TRIGGERS_WEBHOOK_DETAIL_SUBTITLE: LocalizedText = { en: 'Webhook endpoint details', 'zh-CN': 'Webhook 触发端点详情' }

/** Detail drawer KV labels. */
export const TRIGGERS_KV_DESCRIPTION: LocalizedText = { en: 'Description', 'zh-CN': '描述' }
export const TRIGGERS_KV_CRON_EXPRESSION: LocalizedText = { en: 'Cron expression', 'zh-CN': 'Cron 表达式' }
export const TRIGGERS_KV_TIMEZONE: LocalizedText = { en: 'Timezone', 'zh-CN': '时区' }
export const TRIGGERS_KV_CATCH_UP: LocalizedText = { en: 'Catch-up', 'zh-CN': '错过补跑' }
export const TRIGGERS_KV_DELIVERY_TARGET: LocalizedText = { en: 'Delivery target', 'zh-CN': '投递目标' }
export const TRIGGERS_KV_LAST_RUN: LocalizedText = { en: 'Last run', 'zh-CN': '上次运行' }
export const TRIGGERS_KV_NEXT_RUN: LocalizedText = { en: 'Next run', 'zh-CN': '下次运行' }
export const TRIGGERS_KV_THREAD_KEY: LocalizedText = { en: 'ThreadKey', 'zh-CN': 'ThreadKey' }
export const TRIGGERS_KV_SECRET_STATE: LocalizedText = { en: 'Secret state', 'zh-CN': 'Secret 状态' }
export const TRIGGERS_KV_CREATED: LocalizedText = { en: 'Created', 'zh-CN': '创建时间' }
export const TRIGGERS_COMMAND_SECTION: LocalizedText = { en: 'Trigger command', 'zh-CN': '触发指令' }

/** Secret presence values (hasSecret boolean from the doc, secret itself never shown). */
export const TRIGGERS_SECRET_CONFIGURED: LocalizedText = {
  en: 'Configured (plaintext protected, never delivered)',
  'zh-CN': '已配置（明文受保护不下发）',
}
export const TRIGGERS_SECRET_MISSING: LocalizedText = { en: 'Not configured', 'zh-CN': '未配置' }

/** Settings panel KV keys. */
export const TRIGGERS_KV_CRON_COUNT: LocalizedText = { en: 'Cron jobs', 'zh-CN': 'Cron 任务数' }
export const TRIGGERS_KV_WEBHOOK_COUNT: LocalizedText = { en: 'Webhook endpoints', 'zh-CN': 'Webhook 端点数' }

/** Honest-secret footnotes (helmx CLI keeps mono command names verbatim). */
export const TRIGGERS_MANAGER_NOTE: LocalizedText = {
  en: 'Secrets are never shown in docs; create and delete via the helmx cron / helmx webhook commands or the matching action endpoints.',
  'zh-CN': 'secret 不在文档中展示；创建与删除请使用 helmx cron / helmx webhook 命令或对应动作端点。',
}
export const TRIGGERS_SETTINGS_NOTE: LocalizedText = {
  en: 'Manage cron schedules and webhook signing secrets in the trigger manager view or via the helmx CLI.',
  'zh-CN': 'cron 调度细节与 webhook 验签 secret 的管理请前往触发器管理视图或使用 helmx CLI。',
}
export const TRIGGERS_OPEN_MANAGER: LocalizedText = { en: 'Open trigger manager', 'zh-CN': '打开触发器管理' }

/** Row action failure banner prefix; the backend error message passes through verbatim. */
export function triggersActionFailed(actionId: string, message: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `${actionId} failed: ${message}`, 'zh-CN': `${actionId} 失败：${message}` },
    locale,
  )
}

/** Delivery target summary fragments (assembled by models.ts formatTriggerTargetSummary). */
export function triggerTargetConversation(conversationId: number, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Conversation #${conversationId}`, 'zh-CN': `会话 #${conversationId}` },
    locale,
  )
}
export function triggerTargetProfile(profileId: string, locale: HelmxLocale): string {
  return resolveLocalizedText({ en: `Profile ${profileId}`, 'zh-CN': `角色 ${profileId}` }, locale)
}
export function triggerTargetThreadKey(threadKey: string, locale: HelmxLocale): string {
  return resolveLocalizedText({ en: `ThreadKey ${threadKey}`, 'zh-CN': `ThreadKey ${threadKey}` }, locale)
}
export const TRIGGER_TARGET_DEFAULT: LocalizedText = { en: 'Default routing', 'zh-CN': '默认路由' }
