/**
 * builtin:tasks 共享契约：常量、数据模型与边界强校验。
 *
 * 纯台账定位：任务卡 + 1:1 独立顶层执行会话 + 人工验收闭环（submit/approve/rework）。
 * Slice 2（后端）与 Slice 3（前端）唯一对齐事实源；看板投影携带徽标聚合
 * （attention/review/running/tone/summary）与 sidebarItem 徽标声明常量。
 */
import { HelmxError, type ConversationSummary, type LocalizedText } from '@helmx/protocol'

export const TASKS_PLUGIN_ID = 'builtin:tasks'
export const TASKS_SKILL_ID = 'tasks'

/** 私有持久 doc（单一真源）：{ nextSeq, tasks }。 */
export const TASK_RECORDS_DOC = 'records'
/** 公开瞬态投影 doc（public + non-durable）：前端看板实时数据源。 */
export const TASK_BOARD_DOC = 'board'

/** 进行中 / 待验收任务执行会话标签（sidebarSection 收口）。 */
export const TASK_ACTIVE_TAG = 'task'
/** 已结单 / 已归档任务执行会话标签。 */
export const TASK_ARCHIVED_TAG = 'task-archived'

/** before_turn 注入的恒定系统提示词段落 ID（100% 字节恒定，仅含任务生命周期不变事实）。 */
export const ACTIVE_TASK_SECTION_ID = 'tasks.active_task'

/** 看板投影保留的最近已完成 / 已归档历史条数（防公开 doc 超 2 MiB 写放大）。 */
export const TASK_BOARD_DONE_HISTORY_LIMIT = 50

export type TaskColumn = 'backlog' | 'in_progress' | 'in_review' | 'done'

export const TASK_COLUMNS: readonly TaskColumn[] = ['backlog', 'in_progress', 'in_review', 'done']

export interface TaskSubmission {
  summary: string
  verification?: string
  branch?: string
  worktreePath?: string
  changedFiles?: string[]
  artifactIds?: string[]
  submittedAt: number
}

export interface TaskRecord {
  id: string
  title: string
  brief: string
  column: TaskColumn
  project?: string
  assigneeProfileId: string
  nodeId?: string
  cwd?: string
  model?: string
  thinkingLevel?: string
  originConversationId?: number
  conversationId?: number
  conversationMissing?: boolean
  submission?: TaskSubmission
  reworkCount: number
  lastReworkFeedback?: string
  /** 建单幂等键（同 key 的重复 create 返回已建任务，防双击双开）。 */
  createKey?: string
  archived?: boolean
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
}

/** 私有持久真源 doc 形状。 */
export interface TaskStoreDoc {
  nextSeq: number
  tasks: Record<string, TaskRecord>
}

/** 看板徽标色调：error（会话缺失/报错）> warn（需处理）> accent（健康在跑）> neutral。 */
export type TaskBoardBadgeTone = 'error' | 'warn' | 'accent' | 'neutral'

/** 公开看板投影 doc 形状。 */
export interface TaskBoardDoc {
  tasks: TaskRecord[]
  updatedAt: number
  /** 当前需要人工介入的任务数：全部未归档 in_review + 携任一诚实注意信号的未归档 in_progress。 */
  attentionCount: number
  /** 未归档 in_review 任务数（等待验收）。 */
  reviewCount: number
  /** 健康在跑的未归档 in_progress 任务数（无任何注意信号）。 */
  runningCount: number
  /** attentionCount === 0 且 runningCount > 0：驱动安静 accent 圆点（无数值告警）。 */
  hasRunning: boolean
  /** 最高严重度色调：error（任一注意卡会话缺失/报错）> warn > accent > neutral。 */
  badgeTone: TaskBoardBadgeTone
  /** 徽标 tooltip / aria 双语摘要（如「2 个待验收 · 1 个需处理」）；无注意且无在跑时缺省。 */
  badgeSummary?: LocalizedText
}

/**
 * `task-board` sidebarItem 徽标声明（字段名对齐宿主通用 `SidebarItemBadgeSpec` 契约：
 * doc + countField/toneField/dotField/summaryField）。`ui.ts` 注册处已声明
 * `badge: TASK_BOARD_SIDEBAR_BADGE` 完成接线（宿主订阅本插件公开 doc `board` 渲染）。
 */
export const TASK_BOARD_SIDEBAR_BADGE = {
  doc: TASK_BOARD_DOC,
  countField: 'attentionCount',
  toneField: 'badgeTone',
  dotField: 'hasRunning',
  summaryField: 'badgeSummary',
} as const

export interface TasksConfig {
  defaultPlannerProfile: string
  defaultAssigneeProfile: string
}

export const DEFAULT_TASKS_CONFIG: TasksConfig = {
  defaultPlannerProfile: 'assistant',
  defaultAssigneeProfile: 'assistant',
}

/** 任务 ID：系统单调分配 `T-<seq>`；输入按通用安全字符集校验（防穿越），查无显式 not_found。 */
export const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

// ---------------------------------------------------------------------------
// 边界守卫与纯校验函数
// ---------------------------------------------------------------------------

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

function isPosIntId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

/** 即时读取并严格校验配置：非法显式抛错，绝不静默取默认。 */
export function resolveTasksConfig(raw: Record<string, unknown>): TasksConfig {
  const err = (msg: string): HelmxError =>
    new HelmxError('tasks_config_invalid', `${TASKS_PLUGIN_ID} 配置非法：${msg}`, 500, { pluginId: TASKS_PLUGIN_ID })
  const readProfileId = (key: 'defaultPlannerProfile' | 'defaultAssigneeProfile'): string => {
    const fallback = DEFAULT_TASKS_CONFIG[key]
    if (key in raw && raw[key] !== undefined) {
      const v = raw[key]
      if (typeof v !== 'string' || v.trim() === '' || v.length > 64) {
        throw err(`字段 ${key} 必须是非空 1..64 字符 Profile ID（实际：${String(v)}）`)
      }
      return v.trim()
    }
    return fallback
  }
  return {
    defaultPlannerProfile: readProfileId('defaultPlannerProfile'),
    defaultAssigneeProfile: readProfileId('defaultAssigneeProfile'),
  }
}

export function assertTaskId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HelmxError('validation_error', `taskId 必须是字符串（收到：${String(value)}）`, 400, {})
  }
  const trimmed = value.trim()
  if (!TASK_ID_RE.test(trimmed)) {
    throw new HelmxError('validation_error', `taskId '${value}' 非法（需 1..64 位 [A-Za-z0-9_-]）`, 400, { taskId: value })
  }
  return trimmed
}

function assertTaskSubmission(value: unknown, where: string): TaskSubmission {
  if (!isJsonObject(value)) {
    throw new HelmxError('tasks_doc_corrupt', `${where}.submission 结构非法`, 500, { pluginId: TASKS_PLUGIN_ID })
  }
  if (typeof value.summary !== 'string' || value.summary.trim() === '') {
    throw new HelmxError('tasks_doc_corrupt', `${where}.submission.summary 必须是非空字符串`, 500, {
      pluginId: TASKS_PLUGIN_ID,
    })
  }
  for (const key of ['verification', 'branch', 'worktreePath'] as const) {
    const v = value[key]
    if (v !== undefined && typeof v !== 'string') {
      throw new HelmxError('tasks_doc_corrupt', `${where}.submission.${key} 必须是字符串`, 500, {
        pluginId: TASKS_PLUGIN_ID,
      })
    }
  }
  for (const key of ['changedFiles', 'artifactIds'] as const) {
    const v = value[key]
    if (v !== undefined && (!Array.isArray(v) || v.some((s) => typeof s !== 'string'))) {
      throw new HelmxError('tasks_doc_corrupt', `${where}.submission.${key} 必须是字符串数组`, 500, {
        pluginId: TASKS_PLUGIN_ID,
      })
    }
  }
  if (!isFiniteTime(value.submittedAt)) {
    throw new HelmxError('tasks_doc_corrupt', `${where}.submission.submittedAt 必须是有限时间戳`, 500, {
      pluginId: TASKS_PLUGIN_ID,
    })
  }
  return value as unknown as TaskSubmission
}

/** 单条任务记录边界强校验（读档 / 写档共用；非法显式抛错，绝不静默丢弃字段）。 */
export function assertTaskRecord(value: unknown): TaskRecord {
  if (!isJsonObject(value)) {
    throw new HelmxError('tasks_doc_corrupt', `任务记录结构非法（期望对象）`, 500, { pluginId: TASKS_PLUGIN_ID })
  }
  const where = `任务 ${String(value.id ?? '<missing>')}`
  if (typeof value.id !== 'string' || !TASK_ID_RE.test(value.id)) {
    throw new HelmxError('tasks_doc_corrupt', `${where}.id 非法（需 1..64 位 [A-Za-z0-9_-]）`, 500, {
      pluginId: TASKS_PLUGIN_ID,
    })
  }
  if (typeof value.title !== 'string' || value.title.trim() === '' || value.title.length > 120) {
    throw new HelmxError('tasks_doc_corrupt', `${where}.title 必须是 1..120 字符`, 500, { pluginId: TASKS_PLUGIN_ID })
  }
  if (typeof value.brief !== 'string' || value.brief.trim() === '') {
    throw new HelmxError('tasks_doc_corrupt', `${where}.brief 必须是非空字符串`, 500, { pluginId: TASKS_PLUGIN_ID })
  }
  if (!(TASK_COLUMNS as readonly string[]).includes(value.column as string)) {
    throw new HelmxError(
      'tasks_doc_corrupt',
      `${where}.column 非法（期望 ${TASK_COLUMNS.join(' | ')}，收到：${String(value.column)}）`,
      500,
      { pluginId: TASKS_PLUGIN_ID },
    )
  }
  if (typeof value.assigneeProfileId !== 'string' || value.assigneeProfileId.trim() === '') {
    throw new HelmxError('tasks_doc_corrupt', `${where}.assigneeProfileId 必须是非空字符串`, 500, {
      pluginId: TASKS_PLUGIN_ID,
    })
  }
  if (typeof value.reworkCount !== 'number' || !Number.isInteger(value.reworkCount) || value.reworkCount < 0) {
    throw new HelmxError('tasks_doc_corrupt', `${where}.reworkCount 必须是非负整数`, 500, { pluginId: TASKS_PLUGIN_ID })
  }
  if (!isFiniteTime(value.createdAt) || !isFiniteTime(value.updatedAt)) {
    throw new HelmxError('tasks_doc_corrupt', `${where}.createdAt/updatedAt 必须是有限时间戳`, 500, {
      pluginId: TASKS_PLUGIN_ID,
    })
  }
  for (const key of ['project', 'nodeId', 'cwd', 'model', 'thinkingLevel', 'lastReworkFeedback', 'createKey'] as const) {
    const v = value[key]
    if (v !== undefined && typeof v !== 'string') {
      throw new HelmxError('tasks_doc_corrupt', `${where}.${key} 必须是字符串`, 500, { pluginId: TASKS_PLUGIN_ID })
    }
  }
  for (const key of ['conversationMissing', 'archived'] as const) {
    const v = value[key]
    if (v !== undefined && typeof v !== 'boolean') {
      throw new HelmxError('tasks_doc_corrupt', `${where}.${key} 必须是布尔值`, 500, { pluginId: TASKS_PLUGIN_ID })
    }
  }
  for (const key of ['originConversationId', 'conversationId'] as const) {
    const v = value[key]
    if (v !== undefined && !isPosIntId(v)) {
      throw new HelmxError('tasks_doc_corrupt', `${where}.${key} 必须是正整数`, 500, { pluginId: TASKS_PLUGIN_ID })
    }
  }
  for (const key of ['startedAt', 'completedAt'] as const) {
    const v = value[key]
    if (v !== undefined && !isFiniteTime(v)) {
      throw new HelmxError('tasks_doc_corrupt', `${where}.${key} 必须是有限时间戳`, 500, { pluginId: TASKS_PLUGIN_ID })
    }
  }
  if (value.submission !== undefined) assertTaskSubmission(value.submission, where)
  return value as unknown as TaskRecord
}

/** 私有真源 doc 边界强校验：nextSeq 正整数、tasks 键值一致、逐条记录校验。 */
export function assertTaskStoreDoc(value: unknown): TaskStoreDoc {
  if (!isJsonObject(value)) {
    throw new HelmxError('tasks_doc_corrupt', `插件 doc ${TASK_RECORDS_DOC} 结构非法（期望 { nextSeq, tasks }）`, 500, {
      pluginId: TASKS_PLUGIN_ID,
    })
  }
  if (typeof value.nextSeq !== 'number' || !Number.isInteger(value.nextSeq) || value.nextSeq < 1) {
    throw new HelmxError('tasks_doc_corrupt', `插件 doc ${TASK_RECORDS_DOC}.nextSeq 必须是 >=1 整数`, 500, {
      pluginId: TASKS_PLUGIN_ID,
    })
  }
  if (!isJsonObject(value.tasks)) {
    throw new HelmxError('tasks_doc_corrupt', `插件 doc ${TASK_RECORDS_DOC}.tasks 必须是对象`, 500, {
      pluginId: TASKS_PLUGIN_ID,
    })
  }
  for (const [id, record] of Object.entries(value.tasks)) {
    const checked = assertTaskRecord(record)
    if (checked.id !== id) {
      throw new HelmxError('tasks_doc_corrupt', `插件 doc ${TASK_RECORDS_DOC}.tasks 键 '${id}' 与记录 id '${checked.id}' 不一致`, 500, {
        pluginId: TASKS_PLUGIN_ID,
      })
    }
  }
  return value as unknown as TaskStoreDoc
}

export function asConversationDeletedEvent(payload: unknown): number | undefined {
  if (!isJsonObject(payload) || payload['type'] !== 'conversation.deleted') return undefined
  const conversationId = payload['conversationId']
  return isPosIntId(conversationId) ? conversationId : undefined
}

/** 绑定会话缺失或主会话报错态：注意卡里的最高严重度事实（error 色）。 */
function taskConversationMissingOrErrored(
  task: TaskRecord,
  conversations?: ReadonlyArray<ConversationSummary>,
): boolean {
  if (task.conversationMissing === true) return true
  if (conversations === undefined || task.conversationId === undefined) return false
  const conv = conversations.find((c) => c.id === task.conversationId)
  return conv === undefined || conv.status === 'error'
}

/**
 * 单卡诚实注意判定（未归档）：in_review 整列等待人工验收；in_progress 只看主会话事实
 * （conversationMissing / 会话缺失 / error / blocked / 待答 Ask → 需处理，否则健康在跑）。
 */
function classifyTaskAttention(
  task: TaskRecord,
  conversations?: ReadonlyArray<ConversationSummary>,
): { attention: boolean; error: boolean } {
  if (task.column === 'in_review') {
    return { attention: true, error: taskConversationMissingOrErrored(task, conversations) }
  }
  if (task.column !== 'in_progress') return { attention: false, error: false }
  const error = taskConversationMissingOrErrored(task, conversations)
  const conv =
    conversations !== undefined && task.conversationId !== undefined
      ? conversations.find((c) => c.id === task.conversationId)
      : undefined
  const blockedOrAsk = conv !== undefined && (conv.status === 'blocked' || conv.pendingAskCount > 0)
  return { attention: error || blockedOrAsk, error }
}

/** 徽标双语摘要：待验收 + 其他需处理组合；仅健康在跑时给进行中；全静默为 undefined。 */
function taskBoardBadgeSummary(input: {
  attentionCount: number
  reviewCount: number
  runningCount: number
}): LocalizedText | undefined {
  if (input.attentionCount > 0) {
    const otherAttention = input.attentionCount - input.reviewCount
    const en: string[] = []
    const zh: string[] = []
    if (input.reviewCount > 0) {
      en.push(`${input.reviewCount} awaiting review`)
      zh.push(`${input.reviewCount} 个待验收`)
    }
    if (otherAttention > 0) {
      en.push(`${otherAttention} ${otherAttention === 1 ? 'needs' : 'need'} attention`)
      zh.push(`${otherAttention} 个需处理`)
    }
    return { en: en.join(' · '), 'zh-CN': zh.join(' · ') }
  }
  if (input.runningCount > 0) {
    return { en: `${input.runningCount} running`, 'zh-CN': `${input.runningCount} 个进行中` }
  }
  return undefined
}

/**
 * 徽标脏检查键：会话事件侧以此键不变为由跳过 board 写入（高频流式事件零 SSE 写放大）。
 * badgeSummary 由同组计数确定性派生，键不变即摘要不变。
 */
export function taskBoardBadgeKey(
  doc: Pick<TaskBoardDoc, 'attentionCount' | 'reviewCount' | 'runningCount' | 'hasRunning' | 'badgeTone'>,
): string {
  return `${doc.attentionCount}|${doc.reviewCount}|${doc.runningCount}|${doc.hasRunning}|${doc.badgeTone}`
}

/** 公开看板投影：全部未归档任务 + 最近 N 条已归档 / 已完成历史（createdAt 降序）。
 * 徽标聚合（attention/review/running/tone/summary）只统计未归档任务；`conversations`
 * 可选——提供时按主会话实时事实（缺失 / error / blocked / 待答 Ask）诚实判定，
 * 缺省时仅按记录内持久信号判定（纯单测无会话源仍可用）。 */
export function projectBoardDoc(
  store: TaskStoreDoc,
  conversations?: ReadonlyArray<ConversationSummary>,
): TaskBoardDoc {
  const active: TaskRecord[] = []
  const doneHistory: TaskRecord[] = []
  for (const record of Object.values(store.tasks)) {
    if (record.archived === true) doneHistory.push(record)
    else active.push(record)
  }
  doneHistory.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
  const tasks = [...active, ...doneHistory.slice(0, TASK_BOARD_DONE_HISTORY_LIMIT)]
  tasks.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))

  let attentionCount = 0
  let reviewCount = 0
  let runningCount = 0
  let errorSeverity = false
  for (const record of active) {
    if (record.column === 'in_review') {
      reviewCount += 1
      attentionCount += 1
      if (taskConversationMissingOrErrored(record, conversations)) errorSeverity = true
      continue
    }
    if (record.column !== 'in_progress') continue
    const { attention, error } = classifyTaskAttention(record, conversations)
    if (attention) {
      attentionCount += 1
      if (error) errorSeverity = true
    } else {
      runningCount += 1
    }
  }
  const hasRunning = attentionCount === 0 && runningCount > 0
  const badgeTone: TaskBoardBadgeTone = errorSeverity
    ? 'error'
    : attentionCount > 0
      ? 'warn'
      : runningCount > 0
        ? 'accent'
        : 'neutral'
  const badgeSummary = taskBoardBadgeSummary({ attentionCount, reviewCount, runningCount })
  return {
    tasks,
    updatedAt: Date.now(),
    attentionCount,
    reviewCount,
    runningCount,
    hasRunning,
    badgeTone,
    ...(badgeSummary !== undefined ? { badgeSummary } : {}),
  }
}
