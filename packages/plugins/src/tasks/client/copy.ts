/**
 * Display copy for the builtin:tasks client (pure copy table + builders, zero
 * component exports — Fast Refresh friendly, zero Emoji).
 *
 * Every human-visible string of the task board (columns, cards, filters,
 * dialogs, detail drawer, empty states) and the tool-trace receipts resolves
 * through these LocalizedText entries against the active host locale. Task
 * titles / briefs / backend error messages pass through unchanged.
 */
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale, type LocalizedText } from '@helmx/plugin-client'
import type { TaskColumn, TaskLightStatus, TaskMobileTab } from './models.ts'

const L = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })

// ---------------------------------------------------------------------------
// Board header & toolbar
// ---------------------------------------------------------------------------

export const TASK_SEARCH_PLACEHOLDER: LocalizedText = L('Search tasks by title, ID, project…', '搜索任务标题、编号、项目…')
export const TASK_SEARCH_LABEL: LocalizedText = L('Search tasks', '搜索任务')
export const TASK_SEARCH_CLEAR: LocalizedText = L('Clear search', '清空搜索')

export const TASK_FILTER_PROJECT: LocalizedText = L('Project', '项目')
export const TASK_FILTER_ASSIGNEE: LocalizedText = L('Assignee', '执行角色')
export const TASK_FILTER_NODE: LocalizedText = L('Node', '节点')
export const TASK_FILTER_ALL: LocalizedText = L('All', '全部')
export const TASK_FILTER_RESET: LocalizedText = L('Reset filters', '重置筛选')

/** Mobile filter toggle (collapsible tray with the three property selects). */
export const TASK_FILTER_TOGGLE_LABEL: LocalizedText = L('Filters', '筛选')
export const TASK_FILTER_TOGGLE_TITLE: LocalizedText = L('Toggle project / assignee / node filters', '展开或收起项目/角色/节点筛选')
export function taskFilterActiveCount(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: `${count} active`, 'zh-CN': `${count} 项生效` }, locale)
}

export const TASK_NEW_TASK: LocalizedText = L('New task', '新建待办')
export const TASK_NEW_TASK_TITLE: LocalizedText = L('Create a backlog task', '新建一条待办任务')
export const TASK_CHAT_TASK: LocalizedText = L('Plan a task', '聊一个新任务')
export const TASK_CHAT_TASK_TITLE: LocalizedText = L(
  'Open a planning conversation to shape the requirement first',
  '打开规划对话，先聊清需求再落单',
)

/** Batch archive of every visible unarchived done card (sequential, honest errors). */
export const TASK_ARCHIVE_ALL: LocalizedText = L('Archive all', '全部归档')
export const TASK_ARCHIVE_ALL_TITLE: LocalizedText = L(
  'Archive every done task currently on the board (sequential; failures stop and surface)',
  '归档看板上全部已完成任务（逐个执行；失败即停并如实报错）',
)
export const TASK_ARCHIVING: LocalizedText = L('Archiving…', '正在归档…')

/** Archived history toggle (board toolbar) + archived card badge. */
export const TASK_ARCHIVE_HISTORY_SHOW: LocalizedText = L('Archived', '已归档')
export const TASK_ARCHIVE_HISTORY_HIDE: LocalizedText = L('Hide archived', '收起已归档')
export const TASK_ARCHIVE_HISTORY_TITLE: LocalizedText = L(
  'Show archived task cards kept as history (most recent 50)',
  '显示归档历史任务卡（最近 50 条）',
)
export const TASK_ARCHIVE_HISTORY_HIDDEN_HINT: LocalizedText = L(
  'archived hidden',
  '已归档已隐藏',
)
export const TASK_ARCHIVED_BADGE: LocalizedText = L('Archived', '已归档')
export const TASK_ARCHIVED_BADGE_TITLE: LocalizedText = L(
  'Archived off the active board; visible via the board Archived toggle',
  '已归档收离看板；通过看板「已归档」开关查看',
)
export const TASK_ARCHIVED_EMPTY: LocalizedText = L('No archived tasks', '暂无已归档任务')

/** Board stats line (`N tasks · M in flight · K awaiting review`). */
export function taskBoardStats(total: number, inFlight: number, inReview: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    { en: `${total} tasks · ${inFlight} in flight · ${inReview} awaiting review`, 'zh-CN': `共 ${total} 个任务 · ${inFlight} 个进行中 · ${inReview} 个待验收` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Columns & mobile tabs
// ---------------------------------------------------------------------------

export const TASK_COLUMN_LABELS: Readonly<Record<TaskColumn, LocalizedText>> = {
  backlog: L('Backlog', '待办'),
  in_progress: L('In Progress', '进行中'),
  in_review: L('In Review', '待验收'),
  done: L('Done', '已完成'),
}

export function taskColumnLabel(column: TaskColumn, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(TASK_COLUMN_LABELS[column], locale)
}

export const TASK_MOBILE_TAB_LABELS: Readonly<Record<TaskMobileTab, LocalizedText>> = {
  all: L('All', '全部'),
  attention: L('Needs me', '需我处理'),
  in_review: L('Review', '待验收'),
  in_progress: L('Running', '进行中'),
  backlog: L('Backlog', '待办'),
  done: L('Done', '已完成'),
}

export function taskMobileTabLabel(tab: TaskMobileTab, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(TASK_MOBILE_TAB_LABELS[tab], locale)
}

/** Horizontal scrollable status pill strip + grouped collapsible sections (mobile). */
export const TASK_MOBILE_PILLS_ARIA: LocalizedText = L('Task status filters', '任务状态过滤')

/** Mobile collapsible group section (used in the `all` grouped view). */
export const TASK_MOBILE_GROUP_ARIA: LocalizedText = L('Task group', '任务分组')

/** Changed-file count pill. */
export function taskChangedFiles(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    { en: `${count} changed file${count === 1 ? '' : 's'}`, 'zh-CN': `${count} 个改动文件` },
    locale,
  )
}

/** Artifact count pill (submission deliverables openable from the detail drawer). */
export function taskArtifactCount(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    { en: `${count} artifact${count === 1 ? '' : 's'}`, 'zh-CN': `${count} 个产物` },
    locale,
  )
}

export function taskReworkedTimes(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    { en: `Reworked ${count} time${count === 1 ? '' : 's'}`, 'zh-CN': `已返工 ${count} 次` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Card & drawer actions
// ---------------------------------------------------------------------------

export const TASK_ACTION_START: LocalizedText = L('Start', '开工')
export const TASK_ACTION_START_TITLE: LocalizedText = L('Start this task in an independent execution conversation', '启动独立执行会话开工')
export const TASK_ACTION_APPROVE: LocalizedText = L('Approve', '通过')
export const TASK_ACTION_APPROVE_TITLE: LocalizedText = L('Accept the submission and close the task', '验收通过并结单')
export const TASK_ACTION_REWORK: LocalizedText = L('Rework', '打回返工')
export const TASK_ACTION_REWORK_TITLE: LocalizedText = L('Send rework feedback to the execution conversation', '向执行会话发送返工意见')
export const TASK_ACTION_DETAIL_LABEL: LocalizedText = L('View task details', '查看任务详情')
export const TASK_ACTION_SPLIT: LocalizedText = L('Split view', '右分屏')
export const TASK_ACTION_SPLIT_LABEL: LocalizedText = L('Open the execution conversation in the right split pane', '在右侧分屏打开执行会话')
export const TASK_ACTION_ARCHIVE: LocalizedText = L('Archive', '归档')
export const TASK_ACTION_ARCHIVE_TITLE: LocalizedText = L('Archive this task', '归档该任务')
export const TASK_ACTION_DELETE: LocalizedText = L('Delete', '删除')
export const TASK_ACTION_DELETE_TITLE: LocalizedText = L('Delete this task record (conversation history stays)', '删除任务记录（会话历史保留）')
export const TASK_DELETE_CONFIRM: LocalizedText = L('Delete this task? The conversation history is preserved.', '确认删除该任务？会话历史保留。')
export const TASK_ACTION_EDIT: LocalizedText = L('Edit', '编辑')
export const TASK_ACTION_SAVE: LocalizedText = L('Save', '保存')
export const TASK_ACTION_CANCEL: LocalizedText = L('Cancel', '取消')
export const TASK_ACTION_CLOSE: LocalizedText = L('Close', '关闭')
export const TASK_DELETING: LocalizedText = L('Deleting…', '正在删除…')
export const TASK_SAVING: LocalizedText = L('Saving…', '正在保存…')

export const TASK_ACTION_FAILED: LocalizedText = L('Action failed', '操作失败')
export const TASK_SUBMIT_REQUIRED: LocalizedText = L('This field is required', '该字段必填')
export const TASK_TITLE_TOO_LONG: LocalizedText = L('Title must be 120 characters or fewer', '标题不能超过 120 字符')

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

export const TASK_CREATE_DIALOG_TITLE: LocalizedText = L('New task', '新建待办')
export function taskCreateDialogAria(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: 'Create a new backlog task', 'zh-CN': '新建一条待办任务' }, locale)
}

export const TASK_FIELD_TITLE: LocalizedText = L('Title', '标题')
export const TASK_FIELD_TITLE_PLACEHOLDER: LocalizedText = L('One-line summary (max 120 chars)', '一句话概括（120 字内）')
export const TASK_FIELD_BRIEF: LocalizedText = L('Brief', '任务简报')
export const TASK_FIELD_BRIEF_PLACEHOLDER: LocalizedText = L(
  'Background, scope and acceptance criteria — self-contained so the executor can work independently',
  '背景、范围与验收标准——自包含，执行者可独立开工',
)
export const TASK_FIELD_PROJECT: LocalizedText = L('Project', '项目')
export const TASK_FIELD_PROJECT_PLACEHOLDER: LocalizedText = L('Optional grouping name', '可选分组名')
export const TASK_FIELD_ASSIGNEE: LocalizedText = L('Assignee profile', '执行角色')
export const TASK_FIELD_ASSIGNEE_PLACEHOLDER: LocalizedText = L('Profile ID, defaults to assistant', '角色 Profile ID，默认 assistant')
export const TASK_FIELD_NODE: LocalizedText = L('Node', '节点')
export const TASK_FIELD_NODE_PLACEHOLDER: LocalizedText = L('Node ID, defaults to inherit', '节点 ID，默认继承')
export const TASK_FIELD_CWD: LocalizedText = L('Working directory', '工作目录')
export const TASK_FIELD_CWD_PLACEHOLDER: LocalizedText = L('Absolute path on the target node', '目标节点上的绝对路径')

/** Collapsible advanced options disclosure in the create dialog and the detail-drawer edit form. */
export const TASK_MORE_OPTIONS: LocalizedText = L('More options', '高级选项')

/** Started-task lock hint on executor / node / cwd inputs in the edit form (backend 409 task_already_started). */
export const TASK_EDIT_STARTED_LOCK_TITLE: LocalizedText = L(
  'Locked after start: the execution conversation already exists, executor / node / working directory cannot change',
  '已启动锁定：执行会话已创建，执行角色 / 节点 / 工作目录不可修改',
)

export const TASK_FIELD_AUTO_START: LocalizedText = L('Start immediately', '立即开工')
export const TASK_FIELD_AUTO_START_DESC: LocalizedText = L('Create the execution conversation right away', '创建后立即启动执行会话')

export const TASK_CREATE_SUBMIT: LocalizedText = L('Create task', '创建任务')
export const TASK_CREATING: LocalizedText = L('Creating…', '正在创建…')

// ---------------------------------------------------------------------------
// Rework dialog
// ---------------------------------------------------------------------------

export function taskReworkDialogTitle(taskId: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: `Rework ${taskId}`, 'zh-CN': `打回返工 ${taskId}` }, locale)
}
export function taskReworkDialogAria(taskId: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: `Send rework feedback for task ${taskId}`, 'zh-CN': `发送任务 ${taskId} 的返工意见` }, locale)
}
export const TASK_REWORK_FEEDBACK_LABEL: LocalizedText = L('Rework feedback', '返工修改意见')
export const TASK_REWORK_FEEDBACK_PLACEHOLDER: LocalizedText = L(
  'What must change before this can pass review…',
  '需要修改哪些问题才能通过验收…',
)
export const TASK_REWORK_SUBMIT: LocalizedText = L('Send rework', '发送返工')
export const TASK_REWORK_SENDING: LocalizedText = L('Sending…', '正在发送…')

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

export function taskDetailDialogLabel(title: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: `Task details: ${title}`, 'zh-CN': `任务详情：${title}` }, locale)
}

export const TASK_KV_ID: LocalizedText = L('Task ID', '任务编号')
export const TASK_KV_ASSIGNEE: LocalizedText = L('Assignee', '执行角色')
export const TASK_KV_NODE: LocalizedText = L('Node', '节点')
export const TASK_KV_CWD: LocalizedText = L('Working directory', '工作目录')
export const TASK_KV_MODEL: LocalizedText = L('Model', '模型')
export const TASK_KV_THINKING_LEVEL: LocalizedText = L('Thinking level', '思考档位')
export const TASK_KV_CREATED: LocalizedText = L('Created', '创建时间')
export const TASK_KV_STARTED: LocalizedText = L('Started', '开工时间')
export const TASK_KV_COMPLETED: LocalizedText = L('Completed', '完成时间')
export const TASK_KV_CONVERSATION: LocalizedText = L('Execution conversation', '执行会话')
export const TASK_KV_ORIGIN: LocalizedText = L('Origin conversation', '来源会话')
export const TASK_KV_SUBMITTED_AT: LocalizedText = L('Submitted at', '交卷时间')

export const TASK_SECTION_BRIEF: LocalizedText = L('Brief', '任务简报')
export const TASK_SECTION_SUBMISSION: LocalizedText = L('Submission', '交付信息')
export const TASK_SECTION_LAST_REWORK: LocalizedText = L('Last rework feedback', '最近返工意见')

/** Submission artifacts section (clickable ctx.openArtifact chips in the detail drawer). */
export const TASK_SUBMISSION_ARTIFACTS: LocalizedText = L('Artifacts', '交付产物')
export const TASK_SUBMISSION_VERIFICATION: LocalizedText = L('Verification', '验证说明')
export function taskArtifactOpenTitle(artifactId: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: `Open artifact ${artifactId}`, 'zh-CN': `打开产物 ${artifactId}` }, locale)
}

/** Submission changed-files list (first 5 + expand toggle). */
export const TASK_CHANGED_FILES_LABEL: LocalizedText = L('Changed files', '改动文件')
export const TASK_CHANGED_FILES_EXPAND: LocalizedText = L('Show all', '显示全部')
export const TASK_CHANGED_FILES_COLLAPSE: LocalizedText = L('Show less', '收起')

export function taskOriginJumpTitle(conversationId: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    { en: `Open conversation #${conversationId} that planned this task`, 'zh-CN': `跳转到规划此任务的会话 #${conversationId}` },
    locale,
  )
}
export function taskConversationJumpTitle(conversationId: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    { en: `Open execution conversation #${conversationId}`, 'zh-CN': `打开执行会话 #${conversationId}` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Invalid board doc, explicit continue
// ---------------------------------------------------------------------------

export const TASK_BOARD_INVALID: LocalizedText = L('Task board data is invalid', '任务看板数据无效')
export const TASK_BOARD_INVALID_HINT: LocalizedText = L(
  'The board projection failed validation; reloading may recover it.',
  '看板投影校验失败；重新加载可能恢复。',
)
export const TASK_BOARD_RETRY: LocalizedText = L('Reload board', '重新加载')
export const TASK_BOARD_RELOADING: LocalizedText = L('Reloading…', '正在重新加载…')

/** Explicit user-initiated continue for an idle-not-submitted task — never an automated nudge. */
export const TASK_ACTION_CONTINUE: LocalizedText = L('Continue', '继续')
export const TASK_ACTION_CONTINUE_TITLE: LocalizedText = L(
  'Send an explicit continue message to the execution conversation',
  '向执行会话发送明确的继续消息',
)

/** The submit prompt is model-facing execution copy (English only, per the display-metadata conventions). */
export const TASK_CONTINUE_PROMPT =
  'The task conversation is idle without a submission. Please continue the work (or report what you need) and call task_submit when done.'

/** Distinct affordances: the live execution conversation drawer vs the task detail drawer. */
export const TASK_ACTION_OPEN_CONV_BTN: LocalizedText = L('Conversation', '会话')
export const TASK_ACTION_OPEN_CONV_BTN_TITLE: LocalizedText = L(
  'Open the live execution conversation (not the task details)',
  '打开实时执行会话（非任务详情）',
)
export const TASK_ACTION_DETAIL_BTN_TITLE: LocalizedText = L('Open the task details (brief, submission)', '打开任务详情（简报、交付）')

/** Current rework context on reworked in-progress cards. */
export function taskCardReworkLine(feedback: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: `Rework: ${feedback}`, 'zh-CN': `返工：${feedback}` }, locale)
}
export const TASK_ACTION_CONTINUE_REWORK_TITLE: LocalizedText = L(
  'Send an explicit continue message resuming from the current rework revision',
  '发送明确的继续消息，从当前返工修订状态继续',
)

// ---------------------------------------------------------------------------
// Off-board task deep link (inspect affordance)
// ---------------------------------------------------------------------------

export function taskOffBoardNotice(taskId: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    { en: `Task ${taskId} is not on the current board (archived, done-truncated, or deleted)`, 'zh-CN': `任务 ${taskId} 不在当前看板（已归档、完成截断或已删除）` },
    locale,
  )
}
export const TASK_OFF_BOARD_INSPECT: LocalizedText = L('Load full record (inspect)', '加载完整记录 (inspect)')
export const TASK_OFF_BOARD_INSPECTING: LocalizedText = L('Loading…', '正在加载…')
export const TASK_OFF_BOARD_INSPECT_FAILED: LocalizedText = L('Inspect failed', 'inspect 调用失败')
export const TASK_OFF_BOARD_CLOSE: LocalizedText = L('Dismiss', '关闭提示')

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

export const TASK_EMPTY_NO_TASKS: LocalizedText = L('No tasks yet', '还没有任务')
export const TASK_EMPTY_NO_MATCH: LocalizedText = L('No matching tasks', '未找到匹配的任务')
export const TASK_EMPTY_HINT: LocalizedText = L(
  'Plan a task in a conversation, or create a backlog entry here and start it when ready.',
  '在对话中规划一个任务，或先在这里记一条待办，就绪后开工。',
)
export const TASK_EMPTY_HINT_NO_MATCH: LocalizedText = L('Try different keywords or reset the filters.', '请调整搜索关键字或重置筛选条件。')
export const TASK_EMPTY_LOADING: LocalizedText = L('Loading task board…', '正在加载任务看板…')

// ---------------------------------------------------------------------------
// Card live facts
// ---------------------------------------------------------------------------

export const TASK_LIGHT_LABELS: Readonly<Record<TaskLightStatus, LocalizedText>> = {
  error: L('Error', '出错'),
  blocked: L('Waiting for input', '等待处理'),
  running: L('Working', '执行中'),
  background: L('Background active', '后台在途'),
  done: L('Round settled', '回合完成'),
  idle: L('Idle', '空闲'),
}

export function taskLightLabel(status: TaskLightStatus, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(TASK_LIGHT_LABELS[status], locale)
}

/** Card light label that keeps approval waits distinct from generic blocked (errors already have their own tone). */
export function taskCardLightLabel(
  status: TaskLightStatus,
  approvalPending: boolean,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  if (status === 'blocked' && approvalPending) return resolveLocalizedText({ en: 'Waiting for approval', 'zh-CN': '等待审批' }, locale)
  return taskLightLabel(status, locale)
}

export function taskLiveErrorLine(error: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: `Error: ${error}`, 'zh-CN': `出错：${error}` }, locale)
}

/** Blocked on the main execution conversation: a human Ask is a decision wait, plain blocked is generic input wait. */
export function taskLiveWaitingApproval(doing: string | undefined, locale: HelmxLocale = DEFAULT_HELMX_LOCALE, ask = true): string {
  const word = resolveLocalizedText({ en: 'Waiting for approval', 'zh-CN': '等待审批' }, locale)
  const plain = resolveLocalizedText({ en: 'Waiting for input', 'zh-CN': '等待处理' }, locale)
  const label = ask ? word : plain
  if (doing !== undefined && doing !== '') {
    return resolveLocalizedText({ en: `${label} — ${doing}`, 'zh-CN': `${label} — ${doing}` }, locale)
  }
  return label
}

/** Pure derivation fact: in_progress + main conversation idle + no background in flight. */
export function taskLiveIdleNotSubmitted(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: 'Conversation idle, not submitted', 'zh-CN': '会话已空闲 · 未交卷' }, locale)
}

export function taskLiveConversationMissing(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: 'Execution conversation missing', 'zh-CN': '执行会话缺失' }, locale)
}

// ---------------------------------------------------------------------------
// Tool-trace receipts (TaskToolView)
// ---------------------------------------------------------------------------

/** Verb-keyed titles (verbs are extracted leniently from both short and hashed tool names). */
export const TASK_TOOL_TITLES: Readonly<Record<'create' | 'start' | 'submit' | 'approve' | 'rework', LocalizedText>> = {
  create: L('Create task', '创建任务'),
  start: L('Start task', '开工'),
  submit: L('Submit task', '交卷'),
  approve: L('Approve task', '验收通过'),
  rework: L('Rework task', '打回返工'),
}

export const TASK_TOOL_UNKNOWN: LocalizedText = L('Task', '任务')

export function taskToolTitle(verb: 'create' | 'start' | 'submit' | 'approve' | 'rework' | undefined, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  const entry = verb !== undefined ? TASK_TOOL_TITLES[verb] : undefined
  return entry !== undefined ? resolveLocalizedText(entry, locale) : resolveLocalizedText(TASK_TOOL_UNKNOWN, locale)
}

export const TASK_TOOL_STATUS_RUNNING: LocalizedText = L('Running', '执行中')
export const TASK_TOOL_STATUS_ERROR: LocalizedText = L('Error', '出错')
export const TASK_TOOL_STATUS_DONE: LocalizedText = L('Done', '完成')

export function taskToolOpenBoardLabel(taskId: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: `Open task ${taskId} on the board`, 'zh-CN': `在看板打开任务 ${taskId}` }, locale)
}

export function taskToolOpenConversationLabel(taskId: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText({ en: `Open the execution conversation of ${taskId}`, 'zh-CN': `打开 ${taskId} 的执行会话` }, locale)
}

export const TASK_TOOL_TASK_MISSING: LocalizedText = L('Not on the current board (archived or deleted)', '不在当前看板（已归档或删除）')

/** Compact review affordance on in_review receipts: jumps straight to the board review drawer. */
export const TASK_TOOL_REVIEW: LocalizedText = L('Review', '去验收')
export const TASK_TOOL_REVIEW_TITLE: LocalizedText = L(
  'Open this task on the board for acceptance',
  '在看板打开该任务进行验收',
)

// ---------------------------------------------------------------------------
// Conversation header task badge (conversation:header action contribution)
// ---------------------------------------------------------------------------

/** Badge status word: the column label (honest lifecycle state). */
export function taskHeaderBadgeStatus(task: { column: TaskColumn }, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return taskColumnLabel(task.column, locale)
}

/** Badge tooltip: full task line + the deep-link destination. */
export function taskHeaderBadgeTitle(task: { id: string }, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return taskToolOpenBoardLabel(task.id, locale)
}
