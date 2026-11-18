/**
 * Display copy for the builtin:swarm client (pure copy table + builders, zero
 * component exports — Fast Refresh compliant, zero Emoji).
 *
 * Every human-visible string of the tool trace rows, the composer activity
 * tray, the workbench orchestration panel, and the timeline receipt pills
 * resolves here against the active host locale. Protocol vocabulary (#seq,
 * wake, raw channel names) stays available as auxiliary
 * facts, never as the primary control surface.
 */
import { DEFAULT_HELM_LOCALE, resolveLocalizedText, type HelmLocale, type LocalizedText } from '@helm/plugin-client'
import type { BoardPostKind, MemberLiveState } from './board-model.ts'

const L = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })

// ---------------------------------------------------------------------------
// Natural label maps (protocol vocabulary -> human verbs)
// ---------------------------------------------------------------------------

export const POST_KIND_LABELS: Readonly<Record<BoardPostKind, LocalizedText>> = {
  brief: L('Assignment', '派工'),
  handoff: L('Handoff', '交接'),
  review: L('Review', '审阅'),
  comment: L('Note', '留言'),
  blocker: L('Blocked', '受阻'),
  done: L('Delivered', '已交付'),
  stall: L('Stalled', '停滞'),
}

export function postKindLabel(kind: BoardPostKind, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(POST_KIND_LABELS[kind], locale)
}

export const MEMBER_LIVE_STATE_LABELS: Readonly<Record<MemberLiveState, LocalizedText>> = {
  idle: L('Idle', '空闲'),
  working: L('Working', '执行中'),
  blocked: L('Blocked', '受阻'),
  done: L('Done', '已完成'),
  error: L('Error', '错误'),
  missing: L('Missing', '会话缺失'),
}

export function memberLiveStateLabel(state: MemberLiveState, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(MEMBER_LIVE_STATE_LABELS[state], locale)
}

export const PANEL_STATUS_LABELS = {
  running: L('In progress', '进行中'),
  attention: L('Needs attention', '需要关注'),
  completed: L('Completed', '已完成'),
} as const

export type PanelStatusKey = keyof typeof PANEL_STATUS_LABELS

export function panelStatusLabel(status: PanelStatusKey, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(PANEL_STATUS_LABELS[status], locale)
}

export const MEMBER_ACCESS_LABELS = {
  readwrite: L('Read-write', '可写'),
  readonly: L('Read-only review', '只读审阅'),
} as const

export function memberAccessLabel(access: 'readwrite' | 'readonly', locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(MEMBER_ACCESS_LABELS[access], locale)
}

// ---------------------------------------------------------------------------
// Tool trace rows (26px timeline)
// ---------------------------------------------------------------------------

export const TRACE_CREATE_GROUP = L('Start swarm group', '创建协同编组')
export const TRACE_UPDATE_GROUP = L('Update swarm group', '更新协同编组')
export const TRACE_DISPATCH = L('Dispatch member', '派工成员')
export const TRACE_BOARD_POST = L('Board post', '黑板发布')
export const TRACE_BOARD_READ = L('Read board', '读取协同记录')
export const TRACE_BOARD_STATUS = L('Check status', '查看协同态势')
export const TRACE_ABORT = L('Abort member', '中止成员')
export const TRACE_SWITCH_MODEL = L('Switch member model', '切换成员模型')
export const TRACE_INSPECT = L('Inspect member', '检视成员')
export const TRACE_ARCHIVE = L('Archive member', '归档成员')
export const TRACE_CLOSE_GROUP = L('Close swarm group', '结单协同编组')
export const TRACE_UNKNOWN_TOOL = L('Swarm tool', '协同工具')
export const TRACE_EXPAND_DETAILS = L('Show raw details', '查看原始详情')
export const TRACE_COLLAPSE_DETAILS = L('Hide raw details', '收起原始详情')
export const TRACE_DETAILS_SUMMARY = L('Raw tool data', '原始工具数据')
export const TRACE_DETAILS_INPUT = L('Input', '输入')
export const TRACE_DETAILS_OUTPUT = L('Output', '输出')

export function traceOpenMemberLabel(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L(`Open @${name} conversation drawer`, `打开 @${name} 会话抽屉`), locale)
}

export function traceOpenWorkbenchLabel(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L('Open swarm workbench panel', '打开协同工作台面板'), locale)
}

export function traceStatusDone(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L('Done', '完成'), locale)
}

export function traceStatusRunning(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L('Running', '执行中'), locale)
}

export function traceStatusError(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L('Failed', '失败'), locale)
}

export function traceRetainedCount(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    L(`${count} branch${count === 1 ? '' : 'es'} kept for merge`, `保留 ${count} 个分支待合入`),
    locale,
  )
}

export function tracePostCount(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L(`${count} post${count === 1 ? '' : 's'}`, `${count} 条记录`), locale)
}

export function traceAbortedNoop(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L('not running', '未在运行'), locale)
}

// ---------------------------------------------------------------------------
// Composer activity tray (COMPOSER_DOCK_SLOT)
// ---------------------------------------------------------------------------

export const TRAY_REGION_ARIA = L('Swarm collaboration in flight', '协同任务进行中')
export const TRAY_COLLAPSE = L('Collapse', '收起')
export const TRAY_EXPAND = L('Expand', '展开')
export const TRAY_WORKBENCH = L('Workbench', '工作台')
export const ACTION_ABORT = L('Abort', '中止')
export const TRAY_AWAITING_APPROVAL = L('Awaiting approval', '待审批')
export const TRAY_AWAITING_HUMAN = L('Waiting for confirmation', '等待确认')
export const TRAY_OUTPUT_TAG = L('Output', '输出')
export const TRAY_THINKING_TAG = L('Thinking', '思考')
export const TRAY_LOAD_FAILED_TAG = L('Load failed', '加载失败')

export function trayParallelToolsTag(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L(`${count} tools running`, `并行 ${count} 个工具`), locale)
}

export function trayCount(blocked: number, working: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  if (blocked > 0) {
    return working > 0
      ? resolveLocalizedText(L(`${blocked} blocked · ${working} working`, `${blocked} 项受阻 · ${working} 项执行中`), locale)
      : resolveLocalizedText(L(`${blocked} blocked`, `${blocked} 项受阻`), locale)
  }
  return resolveLocalizedText(L(`${working} working`, `${working} 项执行中`), locale)
}

export function trayToggleLabel(
  expanded: boolean,
  countText: string,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  return resolveLocalizedText(
    L(`${expanded ? 'Collapse' : 'Expand'} swarm activity — ${countText}`, `${expanded ? '收起' : '展开'}协同任务 — ${countText}`),
    locale,
  )
}

export function trayRowOpenLabel(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L(`Open @${name} conversation drawer`, `打开 @${name} 会话抽屉`), locale)
}

export function trayAbortFailed(err: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L(`Abort failed: ${err}`, `中止失败：${err}`), locale)
}

export function trayFrontline(
  frontline: { from: string; to: string; kind: BoardPostKind | string; digest: string },
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  const kindText =
    typeof frontline.kind === 'string' && frontline.kind in POST_KIND_LABELS
      ? postKindLabel(frontline.kind as BoardPostKind, locale)
      : frontline.kind
  const arrow = frontline.to !== '' ? ` -> ${frontline.to}` : ''
  return `${frontline.from}${arrow} ${kindText}: ${frontline.digest}`
}

export function trayProgress(done: number, total: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L(`${done}/${total} delivered`, `已交付 ${done}/${total}`), locale)
}

// ---------------------------------------------------------------------------
// Workbench orchestration panel
// ---------------------------------------------------------------------------

export const PANEL_EMPTY_TITLE = L('No swarm group in this conversation', '当前会话没有协同编组')
export const PANEL_EMPTY_HINT = L(
  'Send /skill:swarm <task> in a top-level conversation to start one.',
  '在顶层对话发送 /skill:swarm <任务> 即可发起协同。',
)
export const PANEL_OBJECTIVE = L('Objective', '协同目标')
export const PANEL_MEMBERS_TITLE = L('Members', '成员')
export const PANEL_ACTIVITY_TITLE = L('Recent activity', '最近动态')
export const PANEL_RETAINED_TITLE = L('Branches kept for merge', '保留待合入分支')
export const PANEL_LOADING = L('Loading swarm group…', '读取协同编组…')
export const PANEL_FALLBACK_NOTE = L('Loaded via one-time status snapshot', '经一次性状态快照加载')
export const PANEL_RETRY = L('Retry', '重试')
export const PANEL_REFRESH = L('Refresh', '刷新')
export const PANEL_HISTORY_TOGGLE = L('Show full record', '查看完整记录')
export const PANEL_HISTORY_COLLAPSE = L('Show less', '收起记录')
export const SW_BODY_EXPAND: LocalizedText = { en: 'Expand full text', 'zh-CN': '展开全文' }
export const SW_BODY_COLLAPSE: LocalizedText = { en: 'Collapse', 'zh-CN': '收起长文' }
export const PANEL_POSTS_EMPTY = L('No board posts yet.', '暂无协同记录。')
export const PANEL_MEMBER_ARCHIVED = L('Archived', '已归档')
export const PANEL_STATUS_LOAD_FAILED = L('Failed to load swarm group status', '协同编组状态读取失败')
export function panelStatusInvalid(locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L('Swarm status payload is structurally invalid', '协同状态返回结构无效'), locale)
}
export const PANEL_ACTIVITY_RECEIVED = L('received', '收到')
export const PANEL_ACTIVITY_AUTHORED = L('latest', '最新')

export function panelRowOpenLabel(name: string, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(L(`Open @${name} conversation drawer`, `打开 @${name} 会话抽屉`), locale)
}

export function panelWorktreeSummary(
  snap: { branch?: string; commitsAhead?: number; dirtyCount: number },
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  const parts: string[] = []
  if (snap.branch !== undefined && snap.branch !== '') parts.push(snap.branch)
  if (snap.commitsAhead !== undefined) {
    parts.push(resolveLocalizedText(L(`+${snap.commitsAhead} commits`, `领先 ${snap.commitsAhead} 提交`), locale))
  }
  parts.push(resolveLocalizedText(L(`${snap.dirtyCount} uncommitted`, `未提交 ${snap.dirtyCount}`), locale))
  return parts.join(' · ')
}

export function panelRetainedSummary(
  item: { memberName: string; branch: string; commitsAhead: number },
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  return resolveLocalizedText(
    L(`@${item.memberName} · ${item.branch} · +${item.commitsAhead} commits`, `@${item.memberName} · ${item.branch} · 领先 ${item.commitsAhead} 提交`),
    locale,
  )
}

export function panelPostTargets(post: { to: string[] }): string {
  return post.to.map((t) => (t.startsWith('#') || t === 'all' ? t : `@${t}`)).join(', ')
}

// ---------------------------------------------------------------------------
// Timeline 1-line receipt pills (swarm:board-report / swarm:board-wakeup)
// ---------------------------------------------------------------------------

export const SW_BOARD_REPORT_PILL = L('Swarm report', '协同汇总')
export const SW_BOARD_WAKEUP_PILL = L('Swarm wakeup', '协同唤醒')
export const SW_PILL_OPEN_WORKBENCH = L('Open swarm workbench', '打开协同工作台')

export function swReceiptCountLabel(count: number, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return resolveLocalizedText(
    L(`${count} post${count === 1 ? '' : 's'}`, `${count} 条流转`),
    locale,
  )
}
