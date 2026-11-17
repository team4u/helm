/**
 * Display copy for the builtin:superagent client (pure copy table + builders,
 * no component exports — Fast Refresh friendly).
 *
 * Every human-visible string of the hub widgets, tool card, report card,
 * recall screen and settings panel resolves here against the active host
 * locale (no independent language state); public-doc fields, action payloads
 * and backend error messages pass through unchanged. Worker conversation
 * IDs (#42), profileIds, threadKeys and raw outcome identifiers stay as-is
 * (mono identifiers, not copy).
 */
import type { HelmLocale, LocalizedText } from '@helm/plugin-client'
import { resolveLocalizedText } from '@helm/plugin-client'

// ---------------------------------------------------------------------------
// Shared bits: loading states, table chrome, row actions
// ---------------------------------------------------------------------------

/** Generic inline loading label before the first doc frame arrives. */
export const SA_LOADING: LocalizedText = { en: 'Loading…', 'zh-CN': '读取中' }
/** Loading label for the composer status widget. */
export const SA_LOADING_STATUS: LocalizedText = { en: 'Loading status…', 'zh-CN': '态势读取中…' }
/** Loading label for the worker list (dispatch tool card). */
export const SA_LOADING_WORKERS: LocalizedText = { en: 'Loading workers…', 'zh-CN': 'Worker 清单读取中…' }
/** Loading label for the recall graph table. */
export const SA_LOADING_GRAPH: LocalizedText = { en: 'Loading graph…', 'zh-CN': '图谱读取中…' }
/** Loading label for the subscription table. */
export const SA_LOADING_SUBSCRIPTIONS: LocalizedText = { en: 'Loading subscriptions…', 'zh-CN': '订阅读取中…' }
/** Loading label for the managed-state settings panel. */
export const SA_LOADING_MANAGED: LocalizedText = { en: 'Loading managed state…', 'zh-CN': '托管状态读取中…' }

/** Empty-table cell shared by every hand-rolled helm-table here. */
export const SA_NO_DATA: LocalizedText = { en: 'No data', 'zh-CN': '暂无数据' }

/** Hand-rolled table column headers (mono identifiers like Profile/ThreadKey stay verbatim). */
export const SA_COL_CONVERSATION: LocalizedText = { en: 'Conversation', 'zh-CN': '会话' }
export const SA_COL_OUTCOME: LocalizedText = { en: 'Outcome', 'zh-CN': '终态' }
export const SA_COL_SUMMARY: LocalizedText = { en: 'Summary', 'zh-CN': '摘要' }
export const SA_COL_CREATED: LocalizedText = { en: 'Created', 'zh-CN': '创建时间' }
export const SA_COL_ACTIONS: LocalizedText = { en: 'Actions', 'zh-CN': '操作' }

/** Row action buttons. */
export const SA_ACTION_OPEN: LocalizedText = { en: 'Open', 'zh-CN': '打开' }
export const SA_ACTION_VIEW: LocalizedText = { en: 'View', 'zh-CN': '查看' }
export const SA_ACTION_ARCHIVE: LocalizedText = { en: 'Archive', 'zh-CN': '归档' }
export const SA_ACTION_OPEN_CONVERSATION: LocalizedText = { en: 'Open conversation', 'zh-CN': '打开会话' }
export const SA_ACTION_OPEN_WORKER: LocalizedText = { en: 'Open worker', 'zh-CN': '打开 Worker' }
export const SA_ACTION_SPLIT_OPEN: LocalizedText = { en: 'Open side-by-side in split view', 'zh-CN': '在右屏并排打开' }

// ---------------------------------------------------------------------------
// composerWidget: hub status
// ---------------------------------------------------------------------------

/** Widget title. */
export const SA_WIDGET_TITLE: LocalizedText = { en: 'Hub status', 'zh-CN': '中枢态势' }

/** One-line widget summary: active workers and event subscriptions. */
export function saWidgetSummary(workers: number, subscriptions: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    {
      en: `Active workers: ${workers}; event subscriptions: ${subscriptions}.`,
      'zh-CN': `活跃 Worker ${workers} 个；事件订阅 ${subscriptions} 条。`,
    },
    locale,
  )
}

// ---------------------------------------------------------------------------
// composerPill: router convergence mode
// ---------------------------------------------------------------------------

/** Visible switch label of the router-mode pill. */
export const SA_ROUTER_PILL_LABEL: LocalizedText = { en: 'Hub routing', 'zh-CN': '中枢路由' }
/** Accessible name spelling out the convergence-mode semantics. */
export const SA_ROUTER_PILL_ARIA: LocalizedText = {
  en: 'Hub router convergence mode',
  'zh-CN': '中枢路由收敛模式',
}

// ---------------------------------------------------------------------------
// toolView: dispatch_worker
// ---------------------------------------------------------------------------

/** Tool card title. */
export const SA_DISPATCH_TITLE: LocalizedText = { en: 'Worker dispatch', 'zh-CN': '后台 Worker 派工' }
/** Running dispatch state. */
export const SA_DISPATCHING: LocalizedText = { en: 'Dispatching…', 'zh-CN': '派工中…' }
/** Dispatch failed (action error banner shows the backend message). */
export const SA_DISPATCH_FAILED: LocalizedText = { en: 'Dispatch failed', 'zh-CN': '派工失败' }
/** Dispatch completed without a worker id in the result. */
export const SA_DISPATCH_DONE: LocalizedText = { en: 'Dispatch completed', 'zh-CN': '派工完成' }

/** Success line naming the spawned worker conversation. */
export function saDispatchedWorker(workerConversationId: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `Dispatched worker #${workerConversationId}`, 'zh-CN': `已派工 Worker #${workerConversationId}` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// timelineRenderer: worker report card
// ---------------------------------------------------------------------------

/** Report card badge label. */
export const SA_WORKER_REPORT: LocalizedText = { en: 'Worker report', 'zh-CN': 'Worker 汇报' }

/** Placeholder when the outcome field is missing on a report/recall node. */
export const SA_OUTCOME_UNKNOWN: LocalizedText = { en: 'Unknown', 'zh-CN': '未知' }

/** Artifact button tooltip (name is a passthrough identifier). */
export function saArtifactTitle(name: string, size: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `Artifact ${name} (${size} bytes)`, 'zh-CN': `产物 ${name}（${size} 字节）` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// screen: RecallGraph + subscriptions
// ---------------------------------------------------------------------------

/** Screen title. */
export const SA_RECALL_TITLE: LocalizedText = { en: 'RecallGraph memory graph', 'zh-CN': 'RecallGraph 记忆图谱' }
/** Subscriptions section title. */
export const SA_SUBSCRIPTIONS_TITLE: LocalizedText = { en: 'Event subscriptions', 'zh-CN': '事件订阅' }

/** Screen subtitle counts; appends the split marker in split mode. */
export function saRecallSubtitle(nodes: number, subscriptions: number, isSplit: boolean, locale: HelmLocale): string {
  const split = isSplit
    ? resolveLocalizedText({ en: ' · Split', 'zh-CN': ' · 分屏' }, locale)
    : ''
  return resolveLocalizedText(
    {
      en: `Nodes ${nodes} · Subscriptions ${subscriptions}`,
      'zh-CN': `节点 ${nodes} · 订阅 ${subscriptions}`,
    },
    locale,
  ) + split
}

// ---------------------------------------------------------------------------
// settingsPanel: read-only managed state
// ---------------------------------------------------------------------------

/** Settings panel title. */
export const SA_SETTINGS_TITLE: LocalizedText = { en: 'SuperAgent hub', 'zh-CN': 'SuperAgent 中枢' }

/** Pointer to the plugin config area; the panel itself stays read-only. */
export const SA_SETTINGS_HINT: LocalizedText = {
  en: 'To change the router switch, silent event sources or watchdog parameters, open this plugin\'s configuration settings; this panel only shows the managed state read-only.',
  'zh-CN': '修改路由开关、静默事件源与看门狗参数请前往本插件的配置项设置；本面板只读展示托管状态。',
}

/** Key-value rows of the managed state. */
export const SA_KV_ROUTER: LocalizedText = { en: 'Hub conversation', 'zh-CN': '中枢会话' }
export const SA_KV_WATCHDOG: LocalizedText = { en: 'Watchdog conversation', 'zh-CN': '看门狗会话' }
export const SA_KV_WORKERS: LocalizedText = { en: 'Active workers', 'zh-CN': '活跃 Worker' }
/** Dedicated conversations that have not been bootstrapped yet. */
export const SA_NOT_BOOTSTRAPPED: LocalizedText = { en: 'Not bootstrapped', 'zh-CN': '未自举' }
