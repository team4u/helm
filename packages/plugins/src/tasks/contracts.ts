/**
 * builtin:tasks 共享契约：常量、数据模型与边界强校验。
 *
 * Slice 2（后端）与 Slice 3（前端）唯一对齐事实源——字段、语义与默认值
 * 严格锁定 #1 板书共享契约；新增字段必须双方同步。
 */
import { HelmxError, type ConversationSummary } from '@helmx/protocol'

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

export interface TaskSilenceState {
  nudgedAt?: number
  stalledAt?: number
  lastError?: string
}

/**
 * planFirst 任务的真实方案审批记录（经 task_request_plan_approval -> ctx.host.createAsk
 * 的 confirm Ask 由用户明确批准/拒绝；task_submit 前置门禁校验 approved）。
 */
export interface TaskPlanApproval {
  decision: 'approved' | 'rejected'
  askedAt: number
  decidedAt: number
  askId: string
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
  planFirst?: boolean
  autoMerge?: boolean
  dependsOn: string[]
  autoStartOnUnblock?: boolean
  originConversationId?: number
  conversationId?: number
  conversationMissing?: boolean
  submission?: TaskSubmission
  reworkCount: number
  lastReworkFeedback?: string
  mergePending?: boolean
  /** 任务书投递前落盘的持久标记（投递成功后清除；重启残留即「开工未送达」事实源）。 */
  kickoffPending?: boolean
  /** 重启恢复呈现态：开工任务书未送达，等待用户显式继续（resume_kickoff），绝不自动投递。 */
  kickoffUndelivered?: boolean
  planApproval?: TaskPlanApproval
  /** 发起中的方案审批 Ask ID（新一轮发起前先 cancelAsk 旧的，防重试遗留 pending 卡）。 */
  pendingPlanAskId?: string
  /** 建单幂等键（同 key 的重复 create 返回已建任务，防双击双开）。 */
  createKey?: string
  silenceState?: TaskSilenceState
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

/** 公开看板投影的单张卡片：任务记录 + 依赖真值（板书截断后 UI 无需自算 blockedBy）。 */
export type TaskBoardEntry = TaskRecord & { blockedBy: string[] }

/** 公开看板投影 doc 形状。 */
export interface TaskBoardDoc {
  tasks: TaskBoardEntry[]
  updatedAt: number
}

export interface TasksConfig {
  defaultPlannerProfile: string
  defaultAssigneeProfile: string
  maxConcurrentTasks: number
}

export const DEFAULT_TASKS_CONFIG: TasksConfig = {
  defaultPlannerProfile: 'assistant',
  defaultAssigneeProfile: 'assistant',
  maxConcurrentTasks: 0,
}

/** 任务 ID：系统单调分配 `T-<seq>`；输入按通用安全字符集校验（防穿越），查无显式 not_found。 */
export const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

// ---------------------------------------------------------------------------
// 边界守卫与纯校验函数
// ---------------------------------------------------------------------------

/** 会话整棵后代子树是否存在 working / blocked（沿 parentConversationId 遍历，带环防御）。 */
export function subtreeHasWorkingOrBlocked(rootId: number, all: readonly ConversationSummary[]): boolean {
  const childrenOf = new Map<number, number[]>()
  for (const conv of all) {
    if (conv.parentConversationId === undefined) continue
    const list = childrenOf.get(conv.parentConversationId) ?? []
    list.push(conv.id)
    childrenOf.set(conv.parentConversationId, list)
  }
  const seen = new Set<number>()
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const conv = all.find((c) => c.id === id)
    if (conv !== undefined && (conv.status === 'working' || conv.status === 'blocked')) return true
    for (const child of childrenOf.get(id) ?? []) queue.push(child)
  }
  return false
}

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
  let maxConcurrentTasks = DEFAULT_TASKS_CONFIG.maxConcurrentTasks
  if ('maxConcurrentTasks' in raw && raw.maxConcurrentTasks !== undefined) {
    const v = raw.maxConcurrentTasks
    if (typeof v !== 'number' || !Number.isInteger(v) || !Number.isFinite(v) || v < 0 || v > 50) {
      throw err(`字段 maxConcurrentTasks 必须是 0..50 整数，0 表示不限制（实际：${String(v)}）`)
    }
    maxConcurrentTasks = v
  }
  return {
    defaultPlannerProfile: readProfileId('defaultPlannerProfile'),
    defaultAssigneeProfile: readProfileId('defaultAssigneeProfile'),
    maxConcurrentTasks,
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

function assertTaskSilenceState(value: unknown, where: string): TaskSilenceState {
  if (!isJsonObject(value)) {
    throw new HelmxError('tasks_doc_corrupt', `${where}.silenceState 结构非法`, 500, { pluginId: TASKS_PLUGIN_ID })
  }
  for (const key of ['nudgedAt', 'stalledAt'] as const) {
    const v = value[key]
    if (v !== undefined && !isFiniteTime(v)) {
      throw new HelmxError('tasks_doc_corrupt', `${where}.silenceState.${key} 必须是有限时间戳`, 500, {
        pluginId: TASKS_PLUGIN_ID,
      })
    }
  }
  if (value.lastError !== undefined && typeof value.lastError !== 'string') {
    throw new HelmxError('tasks_doc_corrupt', `${where}.silenceState.lastError 必须是字符串`, 500, {
      pluginId: TASKS_PLUGIN_ID,
    })
  }
  return value as TaskSilenceState
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
  if (!Array.isArray(value.dependsOn) || value.dependsOn.some((d) => typeof d !== 'string')) {
    throw new HelmxError('tasks_doc_corrupt', `${where}.dependsOn 必须是字符串数组`, 500, { pluginId: TASKS_PLUGIN_ID })
  }
  if (typeof value.reworkCount !== 'number' || !Number.isInteger(value.reworkCount) || value.reworkCount < 0) {
    throw new HelmxError('tasks_doc_corrupt', `${where}.reworkCount 必须是非负整数`, 500, { pluginId: TASKS_PLUGIN_ID })
  }
  if (!isFiniteTime(value.createdAt) || !isFiniteTime(value.updatedAt)) {
    throw new HelmxError('tasks_doc_corrupt', `${where}.createdAt/updatedAt 必须是有限时间戳`, 500, {
      pluginId: TASKS_PLUGIN_ID,
    })
  }
  for (const key of ['project', 'nodeId', 'cwd', 'model', 'thinkingLevel', 'lastReworkFeedback', 'pendingPlanAskId', 'createKey'] as const) {
    const v = value[key]
    if (v !== undefined && typeof v !== 'string') {
      throw new HelmxError('tasks_doc_corrupt', `${where}.${key} 必须是字符串`, 500, { pluginId: TASKS_PLUGIN_ID })
    }
  }
  for (const key of ['planFirst', 'autoMerge', 'autoStartOnUnblock', 'conversationMissing', 'mergePending', 'archived', 'kickoffPending', 'kickoffUndelivered'] as const) {
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
  if (value.silenceState !== undefined) assertTaskSilenceState(value.silenceState, where)
  const planApproval = value.planApproval
  if (planApproval !== undefined) {
    if (
      !isJsonObject(planApproval) ||
      (planApproval.decision !== 'approved' && planApproval.decision !== 'rejected') ||
      typeof planApproval.askId !== 'string' ||
      planApproval.askId.trim() === '' ||
      !isFiniteTime(planApproval.askedAt) ||
      !isFiniteTime(planApproval.decidedAt)
    ) {
      throw new HelmxError('tasks_doc_corrupt', `${where}.planApproval 结构非法`, 500, { pluginId: TASKS_PLUGIN_ID })
    }
  }
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

/**
 * 依赖环检测（DFS 三色标记）：返回环路径（首尾同 ID，如 ['T-1','T-2','T-1']）或 null。
 * 引用不存在的任务 ID 不算环（由调用方先行存在性校验）。
 */
export function detectDependencyCycle(tasks: Record<string, TaskRecord>): string[] | null {
  const color = new Map<string, 1 | 2>()
  const path: string[] = []
  const visit = (id: string): string[] | null => {
    const c = color.get(id)
    if (c === 2) return null
    if (c === 1) {
      const start = path.indexOf(id)
      return [...path.slice(start < 0 ? 0 : start), id]
    }
    color.set(id, 1)
    path.push(id)
    const record = tasks[id]
    if (record !== undefined) {
      for (const dep of record.dependsOn) {
        const cycle = visit(dep)
        if (cycle !== null) return cycle
      }
    }
    path.pop()
    color.set(id, 2)
    return null
  }
  for (const id of Object.keys(tasks)) {
    const cycle = visit(id)
    if (cycle !== null) return cycle
  }
  return null
}

/** 未 done 的前置依赖 ID 列表（阻塞开工的任务）。 */
export function blockedDependenciesOf(task: Pick<TaskRecord, 'dependsOn'>, tasks: Record<string, TaskRecord>): string[] {
  return task.dependsOn.filter((dep) => tasks[dep]?.column !== 'done')
}

/** 公开看板投影：全部未归档任务 + 最近 N 条已归档 / 已完成历史（updatedAt 降序）。
 * 每卡附依赖真值 blockedBy（未 done 的前置 ID）：板书截断后前端无法看到被截掉的
 * 依赖卡状态，必须由投影携带真值，杜绝 UI 误判「未知依赖」为已完成。 */
export function projectBoardDoc(store: TaskStoreDoc): TaskBoardDoc {
  const active: TaskRecord[] = []
  const doneHistory: TaskRecord[] = []
  for (const record of Object.values(store.tasks)) {
    if (record.archived === true) doneHistory.push(record)
    else active.push(record)
  }
  doneHistory.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
  const selected = [...active, ...doneHistory.slice(0, TASK_BOARD_DONE_HISTORY_LIMIT)]
  selected.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
  const tasks = selected.map((record) => ({
    ...record,
    blockedBy: record.dependsOn.filter((dep) => store.tasks[dep]?.column !== 'done'),
  }))
  return { tasks, updatedAt: Date.now() }
}
