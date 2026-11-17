/**
 * Display copy for the builtin:herdr client (pure copy table + builders, no
 * component exports — Fast Refresh friendly).
 *
 * Every human-visible string of the Herdr overview screen resolves here
 * against the active host locale (no independent language state): table
 * chrome, filter labels, ownership / status badges, action buttons and the
 * snapshot modal. Node ids, pane ids, agent names, cwd paths, raw
 * agent-status identifiers (working / idle / ...) and backend error messages
 * pass through unchanged. Display-copy builders that were pure model helpers
 * (outcome labels, owner/status filter options) live here rather than in
 * models.ts because models.ts is compiled and imported standalone by tests
 * without the shared @helm/plugin-client runtime.
 */
import type { HelmLocale, LocalizedText } from '@helm/plugin-client'
import { DEFAULT_HELM_LOCALE, resolveLocalizedText } from '@helm/plugin-client'

import { outcomeTone } from './models.ts'

// ---------------------------------------------------------------------------
// Toolbar stats & actions
// ---------------------------------------------------------------------------

/** Toolbar stat badges (count appended by the caller). */
export const HDR_STAT_PANES: LocalizedText = { en: 'Panes', 'zh-CN': '窗格' }
export const HDR_STAT_WORKING: LocalizedText = { en: 'Working', 'zh-CN': '工作中' }
export const HDR_STAT_BLOCKED: LocalizedText = { en: 'Awaiting input', 'zh-CN': '待确认' }
export const HDR_STAT_NODES: LocalizedText = { en: 'Nodes', 'zh-CN': '节点' }

/** Toolbar action buttons. */
export const HDR_REFRESH_LINKS: LocalizedText = { en: 'Refresh links', 'zh-CN': '刷新关联' }
export const HDR_REFETCH: LocalizedText = { en: 'Refetch', 'zh-CN': '重取' }

/** Degraded-connection callout: backend error passes through, timestamp of the last known snapshot appended. */
export function herdrDegradedNotice(error: string | undefined, timestamp: string, locale: HelmLocale): string {
  const reason = error !== undefined && error !== ''
    ? error
    : resolveLocalizedText({ en: 'unknown error', 'zh-CN': '未知错误' }, locale)
  return resolveLocalizedText(
    {
      en: `Herdr connection degraded or unreachable: ${reason} (showing the last known snapshot, taken ${timestamp})`,
      'zh-CN': `Herdr 连接降级或不可达：${reason}（以下为最后已知快照，时间 ${timestamp}）`,
    },
    locale,
  )
}

/** Failed action notification (backend error message passes through unchanged). */
export function herdrActionFailed(message: string, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `Herdr action failed: ${message}`, 'zh-CN': `Herdr 操作失败：${message}` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Accessible names for the three filter selects. */
export const HDR_FILTER_NODE_ARIA: LocalizedText = { en: 'Filter by node', 'zh-CN': '节点筛选' }
export const HDR_FILTER_OWNER_ARIA: LocalizedText = { en: 'Filter by ownership', 'zh-CN': '归属筛选' }
export const HDR_FILTER_STATUS_ARIA: LocalizedText = { en: 'Filter by status', 'zh-CN': '状态筛选' }

/** Node filter options: "all" plus one entry per observed node. */
export function herdrNodeFilterOptions(nodes: ReadonlyArray<string>, locale: HelmLocale): Array<{ value: string; label: string }> {
  const all = resolveLocalizedText({ en: 'All nodes', 'zh-CN': '全部节点' }, locale)
  const local = resolveLocalizedText({ en: 'Local (local)', 'zh-CN': '本机 (local)' }, locale)
  return [
    { value: 'all', label: all },
    ...nodes.map((m) => ({ value: m, label: m === 'local' ? local : m })),
  ]
}

/** Ownership filter options (raw owner values helm/human stay verbatim). */
export function herdrOwnerFilterOptions(locale: HelmLocale = DEFAULT_HELM_LOCALE): Array<{ value: string; label: string }> {
  return [
    { value: 'all', label: resolveLocalizedText({ en: 'All owners', 'zh-CN': '全部归属' }, locale) },
    { value: 'helm', label: resolveLocalizedText({ en: 'helm managed', 'zh-CN': 'helm 受管' }, locale) },
    { value: 'human', label: resolveLocalizedText({ en: 'human direct', 'zh-CN': 'human 直连' }, locale) },
  ]
}

/** Status filter options (agent-status identifiers stay verbatim). */
export function herdrStatusFilterOptions(locale: HelmLocale = DEFAULT_HELM_LOCALE): Array<{ value: string; label: string }> {
  return [
    { value: 'all', label: resolveLocalizedText({ en: 'All statuses', 'zh-CN': '全部状态' }, locale) },
    { value: 'working', label: 'working' },
    { value: 'idle', label: 'idle' },
    { value: 'blocked', label: 'blocked' },
    { value: 'done', label: 'done' },
    { value: 'unknown', label: 'unknown' },
  ]
}

/** Row-count metric next to the filters. */
export function herdrRowCount(filtered: number, total: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `${filtered}/${total} rows`, 'zh-CN': `${filtered}/${total} 行` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Table chrome & badges
// ---------------------------------------------------------------------------

/** Desktop table column headers. */
export const HDR_COL_NODE: LocalizedText = { en: 'Node', 'zh-CN': '节点' }
export const HDR_COL_PANE: LocalizedText = { en: 'Pane', 'zh-CN': '窗格' }
export const HDR_COL_LOCATION: LocalizedText = { en: 'Location', 'zh-CN': '位置' }
export const HDR_COL_OWNER: LocalizedText = { en: 'Ownership', 'zh-CN': '归属' }
export const HDR_COL_STATUS: LocalizedText = { en: 'Status', 'zh-CN': '状态' }
export const HDR_COL_CWD: LocalizedText = { en: 'Working directory', 'zh-CN': '工作目录' }
export const HDR_COL_OUTCOME: LocalizedText = { en: 'Outcome', 'zh-CN': '终态' }
export const HDR_COL_ACTIONS: LocalizedText = { en: 'Actions', 'zh-CN': '操作' }

/** Inline pane badges. */
export const HDR_BADGE_FOCUSED: LocalizedText = { en: 'Focused', 'zh-CN': '聚焦' }
export const HDR_BADGE_PENDING_ASK: LocalizedText = { en: 'Pending approval', 'zh-CN': '待审批' }

/** Mobile card list accessible name. */
export const HDR_PANE_LIST_ARIA: LocalizedText = { en: 'Pane list (mobile view)', 'zh-CN': '窗格列表（移动视图）' }

/** Empty / loading table cells. */
export const HDR_LOADING_DOC: LocalizedText = { en: 'Loading overview document…', 'zh-CN': '正在加载 overview 文档…' }
export const HDR_NO_MATCH: LocalizedText = { en: 'No matching panes', 'zh-CN': '没有匹配的窗格' }

/** Pending-approval (asks) card title. */
export const HDR_ASKS_TITLE: LocalizedText = { en: 'Pending approvals (asks)', 'zh-CN': '待审批（asks）' }

// ---------------------------------------------------------------------------
// Ownership red line & managed actions
// ---------------------------------------------------------------------------

/** Read-only diagnostic badge shown for human-owned panes. */
export const HDR_READ_ONLY: LocalizedText = { en: 'Read-only', 'zh-CN': '只读' }
export const HDR_READ_ONLY_TITLE: LocalizedText = {
  en: 'Human direct terminals only support read-only diagnostics and status display',
  'zh-CN': '人类直连终端仅支持只读诊断与状态展示',
}

/** Managed-pane action buttons. */
export const HDR_ACTION_FOCUS: LocalizedText = { en: 'Focus', 'zh-CN': '聚焦' }
export const HDR_ACTION_SNAPSHOT: LocalizedText = { en: 'Snapshot', 'zh-CN': '快照' }
export const HDR_ACTION_OPEN_LINKED: LocalizedText = { en: 'Open linked conversation', 'zh-CN': '打开关联会话' }

/** Linked-conversation button tooltips. */
export function herdrConversationTitle(conversationId: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `Conversation #${conversationId}`, 'zh-CN': `会话 #${conversationId}` },
    locale,
  )
}
export const HDR_LINK_REFRESH_HINT: LocalizedText = {
  en: 'Click "Refresh links" to load the linked conversation of managed panes',
  'zh-CN': '点「刷新关联」获取受管窗格的关联会话',
}

// ---------------------------------------------------------------------------
// Snapshot modal
// ---------------------------------------------------------------------------

export const HDR_SNAPSHOT_ARIA: LocalizedText = { en: 'Terminal snapshot', 'zh-CN': '终端快照' }
export const HDR_CLOSE: LocalizedText = { en: 'Close', 'zh-CN': '关闭' }

/** Snapshot modal title (pane identifier passes through unchanged). */
export function herdrSnapshotTitle(title: string, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `Terminal snapshot: ${title}`, 'zh-CN': `终端快照：${title}` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Outcome labels (moved from models.ts — display copy needs the locale runtime;
// the tone mapping itself stays in models.ts as pure logic)
// ---------------------------------------------------------------------------

/** Outcome badge copy table (tone comes from models.outcomeTone; keys align). */
const HDR_OUTCOME_LABELS: Record<string, LocalizedText> = {
  running: { en: 'Running', 'zh-CN': '运行中' },
  keepalive: { en: 'Keep-alive', 'zh-CN': '保活' },
  failed: { en: 'Failed', 'zh-CN': '失败' },
  settled: { en: 'Settled', 'zh-CN': '已收尾' },
}

/** Managed-row task outcome badge; undefined when there is no outcome to show. */
export function herdrOutcomeLabel(
  outcome: string | undefined,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): { label: string; tone: string } | undefined {
  const tone = outcomeTone(outcome)
  const text = outcome === undefined ? undefined : HDR_OUTCOME_LABELS[outcome]
  if (tone === undefined || text === undefined) return undefined
  return { label: resolveLocalizedText(text, locale), tone }
}
