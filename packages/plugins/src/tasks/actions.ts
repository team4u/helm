/**
 * builtin:tasks 动作与模型工具统一注册入口。
 *
 * 双轨暴露（与 builtin:swarm 同款纪律）：
 * - 10 个 `ctx.action`（exposeAsTool: false）承载 HTTP / CLI / Workflow / Web 五端，
 *   CLI 自动映射 `helmx tasks <cmd>`；
 * - 7 个 `ctx.tool` 以精确短名（task_create / task_list / task_inspect / task_start /
 *   task_submit / task_approve / task_rework）直接进模型工具列表——不用 exposeAsTool
 *   派生（派生名带哈希后缀，无法满足共享契约的精确短名）。
 *
 * 诚实性边界：
 * - 任务执行会话保持 `ownedBy: 'human'`、零 parentConversationId（完整保留
 *   subagent / SubagentWorkflow / Swarm 决策权）；
 * - 规划动作（create/start/approve/rework/update/archive/delete）在会话上下文中
 *   拒绝任务执行会话 / 子会话 / 自动化会话调用（防执行者自建看板卡或自审自批）；
 * - `task_submit` 仅允许交卷当前会话绑定的任务（防串单）。
 */
import {
  HelmxError,
  type ConversationSummary,
  type HelmxPluginContext,
  type PluginActionContext,
  type PluginToolContext,
} from '@helmx/protocol'
import { recentEntrySummaries } from '../entry-text.js'
import { assertWorkerCwd, assertWorkerNodeId } from '../entry-text.js'
import {
  TASK_ACTIVE_TAG,
  TASK_ARCHIVED_TAG,
  TASKS_PLUGIN_ID,
  assertTaskId,
  blockedDependenciesOf,
  type TaskRecord,
  type TasksConfig,
} from './contracts.js'
import { assertDependenciesValid, type TasksStoreRuntime } from './store.js'
import { buildMergeClosingPrompt, buildReworkDeliveryPrompt, buildTaskKickoffPrompt } from './prompts.js'

export interface TasksRuntime {
  isActive(): boolean
  isShutdown(): boolean
  getConfig(): TasksConfig
  store: TasksStoreRuntime
  /** 等待私有真源 doc 的排队写全部落盘（副作用执行前调用，防「未落盘就派生副作用」）。 */
  flushRecords(): Promise<void>
  readConversationOrUndefined(id: number | undefined): ConversationSummary | undefined
  reportError(title: string, detail: unknown): void
  track<T>(label: string, task: () => Promise<T>): Promise<T>
}

function conversationLive(runtime: TasksRuntime, conversationId: number | undefined) {
  if (conversationId === undefined) return null
  const conv = runtime.readConversationOrUndefined(conversationId)
  if (conv === undefined) return null
  return {
    conversationId: conv.id,
    status: conv.status,
    doing: conv.doing ?? null,
    pendingAskCount: conv.pendingAskCount,
    ...(conv.lastError !== undefined ? { lastError: conv.lastError } : {}),
    ...(conv.nodeId !== undefined ? { nodeId: conv.nodeId } : {}),
    cwd: conv.cwd,
  }
}

/** 按会话摘要查绑定的活跃任务（in_progress / in_review）。 */
export function findActiveTaskByConversation(runtime: TasksRuntime, conversationId: number): TaskRecord | undefined {
  const store = runtime.store.read()
  for (const task of Object.values(store.tasks)) {
    if (task.conversationId === conversationId && (task.column === 'in_progress' || task.column === 'in_review')) {
      return task
    }
  }
  return undefined
}

/** 规划者动作防护：任务执行会话 / 子会话 / 自动化会话一律 403（人工 CLI/UI 不受限）。 */
function assertPlannerAuthority(runtime: TasksRuntime, context: PluginActionContext, action: string): void {
  if (context.conversationId === undefined) return
  const conv = runtime.readConversationOrUndefined(context.conversationId)
  if (conv === undefined) return
  if (findActiveTaskByConversation(runtime, conv.id) !== undefined) {
    throw new HelmxError(
      'task_scope_violation',
      `任务执行会话 #${conv.id} 不得调用规划者动作 ${action}（防执行者套娃建卡或自审自批）`,
      403,
      { pluginId: TASKS_PLUGIN_ID, conversationId: conv.id, action },
    )
  }
  if (conv.parentConversationId !== undefined || (conv.ownedBy !== undefined && conv.ownedBy !== 'human')) {
    throw new HelmxError(
      'task_scope_violation',
      `子会话或自动化会话 #${conv.id} 不得调用规划者动作 ${action}（请在顶层人类会话或人工 CLI/UI 操作看板）`,
      403,
      { pluginId: TASKS_PLUGIN_ID, conversationId: conv.id, action },
    )
  }
}

async function swapConversationTag(
  ctx: HelmxPluginContext,
  runtime: TasksRuntime,
  conversationId: number,
  next: typeof TASK_ACTIVE_TAG | typeof TASK_ARCHIVED_TAG,
): Promise<void> {
  const conv = runtime.readConversationOrUndefined(conversationId)
  if (conv === undefined) return
  const tags = conv.tags.filter((t) => t !== TASK_ACTIVE_TAG && t !== TASK_ARCHIVED_TAG)
  if (!tags.includes(next)) tags.push(next)
  if (tags.length === conv.tags.length && tags.every((t) => conv.tags.includes(t))) return
  await ctx.host.updateConversation(conversationId, { tags })
}

/** 摘除会话上的任务标签（delete 用；保留其他标签）。 */
async function stripConversationTaskTags(
  ctx: HelmxPluginContext,
  runtime: TasksRuntime,
  conversationId: number,
): Promise<void> {
  const conv = runtime.readConversationOrUndefined(conversationId)
  if (conv === undefined) return
  const tags = conv.tags.filter((t) => t !== TASK_ACTIVE_TAG && t !== TASK_ARCHIVED_TAG)
  if (tags.length === conv.tags.length) return
  await ctx.host.updateConversation(conversationId, { tags })
}

function getTaskOrThrow(runtime: TasksRuntime, rawTaskId: unknown): TaskRecord {
  const id = assertTaskId(rawTaskId)
  const task = runtime.store.get(id)
  if (task === undefined) {
    throw new HelmxError('not_found', `任务 '${id}' 不存在`, 404, { pluginId: TASKS_PLUGIN_ID, taskId: id })
  }
  return task
}

function requireTaskInDraft(draftTasks: Record<string, TaskRecord>, rawTaskId: unknown): TaskRecord {
  const id = assertTaskId(rawTaskId)
  const task = draftTasks[id]
  if (task === undefined) {
    throw new HelmxError('not_found', `任务 '${id}' 不存在`, 404, { pluginId: TASKS_PLUGIN_ID, taskId: id })
  }
  return task
}

function taskLiveBlock(runtime: TasksRuntime, task: TaskRecord) {
  const store = runtime.store.read()
  return {
    blockedBy: blockedDependenciesOf(task, store.tasks),
    conversation: conversationLive(runtime, task.conversationId),
    ...(task.conversationId !== undefined && conversationLive(runtime, task.conversationId) === null
      ? { conversationMissing: true }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// 输入边界解析
// ---------------------------------------------------------------------------

interface CreateTaskInput {
  title: string
  brief: string
  project?: string
  assigneeProfileId?: string
  nodeId?: string
  cwd?: string
  model?: string
  thinkingLevel?: string
  planFirst?: boolean
  autoMerge?: boolean
  dependsOn?: string[]
  autoStart?: boolean
}

function parseCreateInput(input: CreateTaskInput): {
  title: string
  brief: string
  project?: string
  assigneeProfileId?: string
  nodeId?: string
  cwd?: string
  model?: string
  thinkingLevel?: string
  planFirst?: boolean
  autoMerge?: boolean
  dependsOn: string[]
  autoStart: boolean
} {
  if (typeof input.title !== 'string') {
    throw new HelmxError('validation_error', 'title 必须是字符串', 400, {})
  }
  const title = input.title.trim()
  if (title === '' || title.length > 120) {
    throw new HelmxError('validation_error', `title 必须是 1..120 字符（收到长度 ${title.length}）`, 400, {})
  }
  if (typeof input.brief !== 'string' || input.brief.trim() === '') {
    throw new HelmxError('validation_error', 'brief 必须是非空自包含任务书（Markdown，含背景/范围/验收标准）', 400, {})
  }
  const optString = (value: unknown, field: string, max = 400): string | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
      throw new HelmxError('validation_error', `${field} 必须是非空 1..${max} 字符`, 400, {})
    }
    return value.trim()
  }
  const optBool = (value: unknown, field: string): boolean | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') {
      throw new HelmxError('validation_error', `${field} 必须是布尔值`, 400, {})
    }
    return value
  }
  let dependsOn: string[] = []
  if (input.dependsOn !== undefined) {
    if (!Array.isArray(input.dependsOn) || input.dependsOn.some((d) => typeof d !== 'string')) {
      throw new HelmxError('validation_error', 'dependsOn 必须是任务 ID 字符串数组', 400, {})
    }
    dependsOn = input.dependsOn.map((d) => assertTaskId(d))
  }
  const nodeId = input.nodeId !== undefined ? assertWorkerNodeId(input.nodeId) : undefined
  const cwd = input.cwd !== undefined ? assertWorkerCwd(input.cwd) : undefined
  return {
    title,
    brief: input.brief.trim(),
    ...(optString(input.project, 'project', 120) !== undefined ? { project: optString(input.project, 'project', 120) } : {}),
    ...(optString(input.assigneeProfileId, 'assigneeProfileId', 64) !== undefined
      ? { assigneeProfileId: optString(input.assigneeProfileId, 'assigneeProfileId', 64) }
      : {}),
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(optString(input.model, 'model', 128) !== undefined ? { model: optString(input.model, 'model', 128) } : {}),
    ...(optString(input.thinkingLevel, 'thinkingLevel', 16) !== undefined
      ? { thinkingLevel: optString(input.thinkingLevel, 'thinkingLevel', 16) }
      : {}),
    ...(optBool(input.planFirst, 'planFirst') !== undefined ? { planFirst: optBool(input.planFirst, 'planFirst') } : {}),
    ...(optBool(input.autoMerge, 'autoMerge') !== undefined ? { autoMerge: optBool(input.autoMerge, 'autoMerge') } : {}),
    dependsOn,
    autoStart: optBool(input.autoStart, 'autoStart') ?? true,
  }
}

// ---------------------------------------------------------------------------
// 启动核心：解析执行者坐标并创建独立顶层 human-owned 执行会话
// ---------------------------------------------------------------------------

interface ResolvedCoordinates {
  nodeId: string
  cwd?: string
}

async function resolveAssigneeProfile(
  ctx: HelmxPluginContext,
  runtime: TasksRuntime,
  explicitProfileId: string | undefined,
  originConversationId: number | undefined,
): Promise<{ profileId: string; nodeId?: string; cwd?: string }> {
  const config = runtime.getConfig()
  const candidates: Array<string | undefined> = explicitProfileId !== undefined
    ? [explicitProfileId]
    : [config.defaultAssigneeProfile, ...(originConversationId !== undefined
        ? [runtime.readConversationOrUndefined(originConversationId)?.profileId]
        : []), 'assistant']

  let lastMissing: string | undefined
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.trim() === '') continue
    const profile = await ctx.host.profiles.get(candidate)
    if (profile === undefined) {
      lastMissing = candidate
      continue
    }
    if (explicitProfileId === undefined && profile.humanSelectable === false) continue
    return { profileId: profile.id, ...(profile.nodeId !== undefined ? { nodeId: profile.nodeId } : {}), ...(profile.cwd !== undefined ? { cwd: profile.cwd } : {}) }
  }
  if (explicitProfileId !== undefined) {
    if (lastMissing !== undefined) {
      throw new HelmxError('not_found', `执行角色 Profile '${explicitProfileId}' 不存在`, 404, {
        pluginId: TASKS_PLUGIN_ID,
        profileId: explicitProfileId,
      })
    }
    throw new HelmxError(
      'validation_error',
      `执行角色 Profile '${explicitProfileId}' 不可被指派（humanSelectable 为 false）`,
      400,
      { pluginId: TASKS_PLUGIN_ID, profileId: explicitProfileId },
    )
  }
  throw new HelmxError('tasks_no_assignee', '无法解析可用执行角色（默认 Profile 与回退链均不可用）', 500, {
    pluginId: TASKS_PLUGIN_ID,
  })
}

function resolveCoordinates(input: {
  explicitNodeId?: string
  explicitCwd?: string
  profileNodeId?: string
  profileCwd?: string
  originConversation?: ConversationSummary
}): ResolvedCoordinates {
  const originConv = input.originConversation
  const nodeId =
    input.explicitNodeId ??
    input.profileNodeId ??
    originConv?.nodeId ??
    'local'
  let cwd = input.explicitCwd ?? input.profileCwd
  if (cwd === undefined && originConv !== undefined && originConv.nodeId === nodeId) {
    cwd = originConv.cwd
  }
  if (nodeId !== 'local' && cwd === undefined) {
    throw new HelmxError(
      'validation_error',
      `任务目标节点 '${nodeId}' 缺少工作目录（cwd）：远端节点必须显式提供 cwd（或为执行角色 Profile 配置默认 cwd）`,
      400,
      { nodeId },
    )
  }
  return { nodeId, ...(cwd !== undefined ? { cwd } : {}) }
}

/**
 * 两阶段启动（副作用前落盘 + 可重试）：
 * 1. 调用方已在串行 mutation 中把任务占位为 `in_progress`（无 conversationId）且已 write+flush；
 * 2. `createConversation`（内核自身持久化）；
 * 3. 串行 mutation 绑定 conversationId + startedAt（write+flush，先于任务书投递）；
 * 4. `submitInput` 任务书（origin 'agent'、requestId 按 taskId 幂等）；失败显式回滚
 *    （会话标 task-archived 保留现场、任务回 backlog 记 lastError 可重试），绝不静默。
 * 崩溃窗口：步骤 2/3 之间重启 → service.start 的 recoverInterruptedStartups 诚实回滚。
 */
async function launchTaskExecution(
  ctx: HelmxPluginContext,
  runtime: TasksRuntime,
  taskId: string,
): Promise<number> {
  const task = runtime.store.get(taskId)
  if (task === undefined) {
    throw new HelmxError('not_found', `任务 '${taskId}' 不存在`, 404, { pluginId: TASKS_PLUGIN_ID, taskId })
  }
  const profile = await ctx.host.profiles.get(task.assigneeProfileId)
  const coordinates = resolveCoordinates({
    explicitNodeId: task.nodeId,
    explicitCwd: task.cwd,
    profileNodeId: profile?.nodeId,
    profileCwd: profile?.cwd,
    originConversation:
      task.originConversationId !== undefined
        ? runtime.readConversationOrUndefined(task.originConversationId)
        : undefined,
  })

  const created = await ctx.host.createConversation({
    title: task.title,
    profileId: task.assigneeProfileId,
    tags: [TASK_ACTIVE_TAG],
    ...(coordinates.cwd !== undefined ? { cwd: coordinates.cwd } : {}),
    nodeId: coordinates.nodeId,
    ...(task.model !== undefined && task.model !== '' ? { model: task.model } : {}),
  })
  try {
    if (task.thinkingLevel !== undefined && task.thinkingLevel !== '') {
      await ctx.host.updateConversation(created.id, { thinkingLevel: task.thinkingLevel })
    }
    await runtime.store.enqueueMutation((draft) => {
      const target = draft.tasks[taskId]
      if (target === undefined || target.conversationId !== undefined) return
      target.conversationId = created.id
      target.startedAt = Date.now()
      target.updatedAt = target.startedAt
      delete target.conversationMissing
    })
    await runtime.flushRecords()
    await ctx.host.submitInput(created.id, buildTaskKickoffPrompt(task), {
      origin: 'agent',
      whenBusy: 'steer',
      requestId: `${TASKS_PLUGIN_ID}:kickoff:${taskId}`,
    })
  } catch (err) {
    // 干净回滚：任务回待办记 lastError（flush 后可重试 start），会话保留标 task-archived；显式抛错
    runtime.reportError(`任务 ${taskId} 启动投递失败，执行回滚（会话 #${created.id} 已归档标记）`, err)
    await runtime.store
      .enqueueMutation((draft) => {
        const target = draft.tasks[taskId]
        if (target === undefined || target.conversationId !== created.id) return
        target.column = 'backlog'
        delete target.conversationId
        delete target.startedAt
        target.silenceState = {
          ...(target.silenceState ?? {}),
          lastError: err instanceof Error ? err.message : String(err),
        }
        target.updatedAt = Date.now()
      })
      .catch(() => undefined)
    await runtime.flushRecords().catch(() => undefined)
    await swapConversationTag(ctx, runtime, created.id, TASK_ARCHIVED_TAG).catch(() => {})
    throw err instanceof HelmxError
      ? err
      : new HelmxError('task_start_failed', `任务 ${taskId} 启动失败：${err instanceof Error ? err.message : String(err)}`, 500, {
          pluginId: TASKS_PLUGIN_ID,
          taskId,
          conversationId: created.id,
        })
  }
  return created.id
}

// ---------------------------------------------------------------------------
// 注册入口
// ---------------------------------------------------------------------------

export function registerTasksActions(ctx: HelmxPluginContext, runtime: TasksRuntime): void {
  // ---------------- create ----------------
  const createTask = async (
    input: CreateTaskInput,
    context: PluginActionContext,
  ): Promise<{
    task: TaskRecord
    started: boolean
    conversationId?: number
    blockedBy: string[]
    notStartedReason?: 'dependencies_blocked' | 'concurrency_limit' | 'auto_start_disabled'
  }> => {
    assertPlannerAuthority(runtime, context, 'create')
    const parsed = parseCreateInput(input)
    return runtime.track('task:create', async () => {
      const decision = await runtime.store.enqueueMutation(async (draft) => {
        const taskId = `T-${draft.nextSeq}`
        draft.nextSeq += 1
        const assignee = await resolveAssigneeProfile(ctx, runtime, parsed.assigneeProfileId, context.conversationId)
        assertDependenciesValid(taskId, parsed.dependsOn, draft.tasks)
        const now = Date.now()
        const task: TaskRecord = {
          id: taskId,
          title: parsed.title,
          brief: parsed.brief,
          column: 'backlog',
          ...(parsed.project !== undefined ? { project: parsed.project } : {}),
          assigneeProfileId: assignee.profileId,
          ...(parsed.nodeId !== undefined ? { nodeId: parsed.nodeId } : {}),
          ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
          ...(parsed.model !== undefined ? { model: parsed.model } : {}),
          ...(parsed.thinkingLevel !== undefined ? { thinkingLevel: parsed.thinkingLevel } : {}),
          ...(parsed.planFirst !== undefined ? { planFirst: parsed.planFirst } : {}),
          ...(parsed.autoMerge !== undefined ? { autoMerge: parsed.autoMerge } : {}),
          dependsOn: parsed.dependsOn,
          ...(context.conversationId !== undefined ? { originConversationId: context.conversationId } : {}),
          reworkCount: 0,
          createdAt: now,
          updatedAt: now,
        }
        draft.tasks[taskId] = task

        const blockedBy = blockedDependenciesOf(task, draft.tasks)
        if (blockedBy.length > 0) {
          task.autoStartOnUnblock = parsed.autoStart
          return { taskId, launch: false as const, blockedBy, notStartedReason: 'dependencies_blocked' as const }
        }
        if (parsed.autoStart === false) {
          return { taskId, launch: false as const, blockedBy, notStartedReason: 'auto_start_disabled' as const }
        }
        const { maxConcurrentTasks } = runtime.getConfig()
        const inProgress = Object.values(draft.tasks).filter((t) => t.column === 'in_progress').length
        if (maxConcurrentTasks > 0 && inProgress >= maxConcurrentTasks) {
          return { taskId, launch: false as const, blockedBy, notStartedReason: 'concurrency_limit' as const }
        }
        // 两阶段启动占位：in_progress 无 conversationId 先落盘（串行队列内原子占并发额度，杜绝双开）
        task.column = 'in_progress'
        task.startedAt = Date.now()
        task.updatedAt = task.startedAt
        return { taskId, launch: true as const, blockedBy: [] as string[] }
      })
      // 占位事实已 write；flush 确保落盘后才执行创建会话副作用
      await runtime.flushRecords()
      if (!decision.launch) {
        const task = runtime.store.get(decision.taskId)!
        return { task, started: false, blockedBy: decision.blockedBy, notStartedReason: decision.notStartedReason }
      }
      const conversationId = await launchTaskExecution(ctx, runtime, decision.taskId)
      const task = runtime.store.get(decision.taskId)!
      return { task, started: true, conversationId, blockedBy: [] }
    })
  }

  // ---------------- list ----------------
  const listTasks = async (input: {
    column?: string
    project?: string
    assigneeProfileId?: string
    nodeId?: string
    includeArchived?: boolean
  }): Promise<{
    tasks: Array<TaskRecord & { live: ReturnType<typeof taskLiveBlock> }>
    total: number
  }> => {
    const filter: Parameters<TasksStoreRuntime['list']>[0] = {}
    if (input.column !== undefined) {
      if (!['backlog', 'in_progress', 'in_review', 'done'].includes(input.column)) {
        throw new HelmxError('validation_error', `column 非法（收到：${input.column}）`, 400, {})
      }
      filter.column = input.column as TaskRecord['column']
    }
    if (input.project !== undefined) filter.project = input.project.trim()
    if (input.assigneeProfileId !== undefined) filter.assigneeProfileId = input.assigneeProfileId.trim()
    if (input.nodeId !== undefined) filter.nodeId = input.nodeId.trim()
    if (input.includeArchived === true) filter.includeArchived = true
    const tasks = runtime.store.list(filter)
    return {
      tasks: tasks.map((task) => ({ ...task, live: taskLiveBlock(runtime, task) })),
      total: tasks.length,
    }
  }

  // ---------------- inspect ----------------
  const inspectTask = async (input: { taskId: string }): Promise<Record<string, unknown>> => {
    const task = getTaskOrThrow(runtime, input.taskId)
    const store = runtime.store.read()
    const dependencies = task.dependsOn.map((dep) => {
      const depTask = store.tasks[dep]
      return {
        id: dep,
        title: depTask?.title ?? null,
        column: depTask?.column ?? null,
        ...(depTask === undefined ? { missing: true } : {}),
      }
    })
    const result: Record<string, unknown> = {
      task,
      dependencies,
      blockedBy: blockedDependenciesOf(task, store.tasks),
      conversation: conversationLive(runtime, task.conversationId),
      ...(task.conversationId !== undefined
        ? { conversationMissing: conversationLive(runtime, task.conversationId) === null }
        : {}),
    }
    if (task.conversationId !== undefined) {
      const conv = runtime.readConversationOrUndefined(task.conversationId)
      if (conv !== undefined) {
        try {
          const detail = await ctx.host.getConversationDetail(task.conversationId, { limit: 20 })
          const artifacts = await ctx.host.listArtifacts(task.conversationId)
          result.recentEntries = recentEntrySummaries(ctx.host, detail.entries, 10)
          result.artifacts = artifacts.map((a) => ({ id: a.id, name: a.name, size: a.size }))
        } catch (err) {
          if (!(err instanceof HelmxError && err.code === 'not_found')) throw err
        }
      }
    }
    return result
  }

  // ---------------- update ----------------
  const updateTask = async (
    input: {
      taskId: string
      title?: string
      brief?: string
      project?: string | null
      assigneeProfileId?: string
      nodeId?: string | null
      cwd?: string | null
      model?: string | null
      thinkingLevel?: string | null
      planFirst?: boolean
      autoMerge?: boolean
      dependsOn?: string[]
      autoStartOnUnblock?: boolean
    },
    context: PluginActionContext,
  ): Promise<{ task: TaskRecord }> => {
    assertPlannerAuthority(runtime, context, 'update')
    return runtime.track('task:update', () =>
      runtime.store.enqueueMutation(async (draft) => {
        const task = requireTaskInDraft(draft.tasks, input.taskId)
        const started = task.column !== 'backlog' || task.conversationId !== undefined
        if (
          started &&
          (input.assigneeProfileId !== undefined ||
            input.nodeId !== undefined ||
            input.cwd !== undefined)
        ) {
          throw new HelmxError(
            'task_already_started',
            `任务 ${task.id} 已启动（会话 #${task.conversationId ?? '?'}），禁止修改执行角色 / 节点 / 工作目录`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id },
          )
        }
        if (input.title !== undefined) {
          const title = input.title.trim()
          if (title === '' || title.length > 120) {
            throw new HelmxError('validation_error', 'title 必须是 1..120 字符', 400, {})
          }
          task.title = title
        }
        if (input.brief !== undefined) {
          if (input.brief.trim() === '') {
            throw new HelmxError('validation_error', 'brief 必须是非空任务书', 400, {})
          }
          task.brief = input.brief.trim()
        }
        if (input.project !== undefined) {
          if (input.project === null || input.project.trim() === '') delete task.project
          else task.project = input.project.trim()
        }
        if (input.assigneeProfileId !== undefined) {
          const profileId = input.assigneeProfileId.trim()
          const profile = await ctx.host.profiles.get(profileId)
          if (profile === undefined) {
            throw new HelmxError('not_found', `执行角色 Profile '${profileId}' 不存在`, 404, { profileId })
          }
          task.assigneeProfileId = profileId
        }
        if (input.nodeId !== undefined) {
          if (input.nodeId === null || input.nodeId.trim() === '') delete task.nodeId
          else task.nodeId = assertWorkerNodeId(input.nodeId)
        }
        if (input.cwd !== undefined) {
          if (input.cwd === null || input.cwd.trim() === '') delete task.cwd
          else task.cwd = assertWorkerCwd(input.cwd)
        }
        if (input.model !== undefined) {
          if (input.model === null || input.model.trim() === '') delete task.model
          else task.model = input.model.trim()
        }
        if (input.thinkingLevel !== undefined) {
          if (input.thinkingLevel === null || input.thinkingLevel.trim() === '') delete task.thinkingLevel
          else task.thinkingLevel = input.thinkingLevel.trim()
        }
        if (input.planFirst !== undefined) {
          if (typeof input.planFirst !== 'boolean') throw new HelmxError('validation_error', 'planFirst 必须是布尔值', 400, {})
          task.planFirst = input.planFirst
        }
        if (input.autoMerge !== undefined) {
          if (typeof input.autoMerge !== 'boolean') throw new HelmxError('validation_error', 'autoMerge 必须是布尔值', 400, {})
          task.autoMerge = input.autoMerge
        }
        if (input.autoStartOnUnblock !== undefined) {
          if (typeof input.autoStartOnUnblock !== 'boolean') {
            throw new HelmxError('validation_error', 'autoStartOnUnblock 必须是布尔值', 400, {})
          }
          task.autoStartOnUnblock = input.autoStartOnUnblock
        }
        if (input.dependsOn !== undefined) {
          if (!Array.isArray(input.dependsOn) || input.dependsOn.some((d) => typeof d !== 'string')) {
            throw new HelmxError('validation_error', 'dependsOn 必须是任务 ID 字符串数组', 400, {})
          }
          const dependsOn = input.dependsOn.map((d) => assertTaskId(d))
          assertDependenciesValid(task.id, dependsOn, draft.tasks)
          task.dependsOn = dependsOn
        }
        task.updatedAt = Date.now()
        return { task }
      }),
    )
  }

  // ---------------- start ----------------
  const startTask = async (
    input: { taskId: string },
    context: PluginActionContext,
  ): Promise<{ task: TaskRecord; conversationId: number }> => {
    assertPlannerAuthority(runtime, context, 'start')
    return runtime.track('task:start', async () => {
      const decision = await runtime.store.enqueueMutation((draft) => {
        const task = requireTaskInDraft(draft.tasks, input.taskId)
        if (task.conversationId !== undefined || (task.column !== 'backlog' && task.column !== 'in_progress')) {
          throw new HelmxError(
            'task_already_started',
            `任务 ${task.id} 已启动（column=${task.column}，会话 #${task.conversationId ?? '?'}）`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id },
          )
        }
        if (task.column === 'in_progress') {
          // 启动中断恢复残留（conversationId 未绑定）由 service.start 回滚；此处显式拒绝并发重入
          throw new HelmxError(
            'task_already_started',
            `任务 ${task.id} 处于启动中断残留态（in_progress 无绑定会话），等待服务重启恢复或稍后重试`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id },
          )
        }
        const blockedBy = blockedDependenciesOf(task, draft.tasks)
        if (blockedBy.length > 0) {
          throw new HelmxError(
            'task_blocked_by_dependencies',
            `任务 ${task.id} 被未完成前置依赖阻塞：${blockedBy.join(', ')}`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id, blockedBy },
          )
        }
        const { maxConcurrentTasks } = runtime.getConfig()
        const inProgress = Object.values(draft.tasks).filter((t) => t.column === 'in_progress').length
        if (maxConcurrentTasks > 0 && inProgress >= maxConcurrentTasks) {
          throw new HelmxError(
            'task_concurrency_limit',
            `并发开工任务数已达上限 ${maxConcurrentTasks}（当前 in_progress=${inProgress}），稍后再启动`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id, maxConcurrentTasks },
          )
        }
        // 两阶段启动占位（先落盘再创建会话）
        task.column = 'in_progress'
        task.startedAt = Date.now()
        task.updatedAt = task.startedAt
        delete task.silenceState
        return { taskId: task.id }
      })
      await runtime.flushRecords()
      const conversationId = await launchTaskExecution(ctx, runtime, decision.taskId)
      const task = runtime.store.get(decision.taskId)!
      return { task, conversationId }
    })
  }

  // ---------------- submit ----------------
  const submitTask = async (
    input: {
      taskId?: string
      summary: string
      verification?: string
      branch?: string
      worktreePath?: string
      changedFiles?: string[]
      artifactIds?: string[]
    },
    context: PluginActionContext,
  ): Promise<{ task: TaskRecord }> => {
    if (typeof input.summary !== 'string' || input.summary.trim() === '') {
      throw new HelmxError('validation_error', 'summary 必须是非空交卷摘要', 400, {})
    }
    for (const field of ['verification', 'branch', 'worktreePath'] as const) {
      const v = input[field]
      if (v !== undefined && typeof v !== 'string') {
        throw new HelmxError('validation_error', `${field} 必须是字符串`, 400, {})
      }
    }
    for (const field of ['changedFiles', 'artifactIds'] as const) {
      const v = input[field]
      if (v !== undefined && (!Array.isArray(v) || v.some((s) => typeof s !== 'string'))) {
        throw new HelmxError('validation_error', `${field} 必须是字符串数组`, 400, {})
      }
    }
    return runtime.track('task:submit', () =>
      runtime.store.enqueueMutation((draft) => {
        let task: TaskRecord
        if (input.taskId !== undefined) {
          task = requireTaskInDraft(draft.tasks, input.taskId)
          if (
            context.conversationId !== undefined &&
            task.conversationId !== context.conversationId
          ) {
            throw new HelmxError(
              'task_conversation_mismatch',
              `会话 #${context.conversationId} 只能交卷自己绑定的任务（任务 ${task.id} 绑定会话 #${task.conversationId ?? '未绑定'}）`,
              403,
              { pluginId: TASKS_PLUGIN_ID, taskId: task.id, conversationId: context.conversationId },
            )
          }
        } else if (context.conversationId !== undefined) {
          const bound = Object.values(draft.tasks).find(
            (t) =>
              t.conversationId === context.conversationId &&
              (t.column === 'in_progress' || t.column === 'in_review'),
          )
          if (bound === undefined) {
            throw new HelmxError(
              'task_not_found_in_conversation',
              `当前会话 #${context.conversationId} 未绑定进行中的看板任务（请显式传 taskId 或在任务执行会话内调用）`,
              404,
              { pluginId: TASKS_PLUGIN_ID, conversationId: context.conversationId },
            )
          }
          task = bound
        } else {
          throw new HelmxError(
            'validation_error',
            'taskId 必填（会话外人工调用无法反查绑定任务）',
            400,
            {},
          )
        }
        if (task.column !== 'in_progress' && task.column !== 'in_review') {
          throw new HelmxError(
            'task_not_started',
            `任务 ${task.id} 当前位于 ${task.column} 列，仅进行中 / 待验收任务可交卷`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id, column: task.column },
          )
        }
        const now = Date.now()
        task.submission = {
          summary: input.summary.trim(),
          ...(input.verification !== undefined && input.verification.trim() !== ''
            ? { verification: input.verification.trim() }
            : {}),
          ...(input.branch !== undefined && input.branch.trim() !== '' ? { branch: input.branch.trim() } : {}),
          ...(input.worktreePath !== undefined && input.worktreePath.trim() !== ''
            ? { worktreePath: input.worktreePath.trim() }
            : {}),
          ...(input.changedFiles !== undefined ? { changedFiles: input.changedFiles } : {}),
          ...(input.artifactIds !== undefined ? { artifactIds: input.artifactIds } : {}),
          submittedAt: now,
        }
        task.column = 'in_review'
        delete task.silenceState
        delete task.mergePending
        task.updatedAt = now
        return { task }
      }),
    )
  }

  // ---------------- approve ----------------
  const approveTask = async (
    input: { taskId: string; mergeAction?: 'close_only' | 'merge_and_close'; note?: string },
    context: PluginActionContext,
  ): Promise<{
    task: TaskRecord
    unblockedTaskIds: string[]
    autoStartedTaskIds: string[]
  }> => {
    assertPlannerAuthority(runtime, context, 'approve')
    if (
      input.mergeAction !== undefined &&
      input.mergeAction !== 'close_only' &&
      input.mergeAction !== 'merge_and_close'
    ) {
      throw new HelmxError('validation_error', `mergeAction 非法（收到：${String(input.mergeAction)}）`, 400, {})
    }
    const mergeAction = input.mergeAction ?? 'close_only'
    return runtime.track('task:approve', async () => {
      if (mergeAction === 'merge_and_close') {
        // 投递原子模式：状态变更与指令投递在同一串行 mutation 内，submitInput 成功后才 write；
        // 失败 draft 丢弃（状态回滚可干净重试）；requestId 按 submission 时间戳幂等（重试不重复投递）。
        const task = await runtime.store.enqueueMutation(async (draft) => {
          const task = requireTaskInDraft(draft.tasks, input.taskId)
          if (task.column !== 'in_review' && task.column !== 'in_progress') {
            throw new HelmxError(
              'task_invalid_column',
              `任务 ${task.id} 当前位于 ${task.column} 列，仅待验收（或确认中的进行中）任务可验收通过`,
              409,
              { pluginId: TASKS_PLUGIN_ID, taskId: task.id, column: task.column },
            )
          }
          const conversationMissing =
            task.conversationId === undefined || conversationLive(runtime, task.conversationId) === null
          if (conversationMissing) {
            throw new HelmxError(
              'task_conversation_missing',
              `任务 ${task.id} 无有效关联执行会话，无法投递合并收尾指令（可改用 close_only 或先 rework 重建会话）`,
              409,
              { pluginId: TASKS_PLUGIN_ID, taskId: task.id },
            )
          }
          task.mergePending = true
          task.column = 'in_progress'
          delete task.silenceState
          task.updatedAt = Date.now()
          const conversationId = task.conversationId!
          await ctx.host.submitInput(conversationId, buildMergeClosingPrompt(task, input.note), {
            origin: 'agent',
            whenBusy: 'followUp',
            requestId: `${TASKS_PLUGIN_ID}:merge:${task.id}:${task.submission?.submittedAt ?? Date.now()}`,
          })
          await swapConversationTag(ctx, runtime, conversationId, TASK_ACTIVE_TAG)
          return task
        })
        return { task, unblockedTaskIds: [], autoStartedTaskIds: [] }
      }

      // close_only：核心事实（done 终转）先落盘 flush，衍生动作（会话换标签、下游接棒）失败容忍上报不回滚
      const { task, conversationId, downstream } = await runtime.store.enqueueMutation((draft) => {
        const task = requireTaskInDraft(draft.tasks, input.taskId)
        if (task.column !== 'in_review' && task.column !== 'in_progress') {
          throw new HelmxError(
            'task_invalid_column',
            `任务 ${task.id} 当前位于 ${task.column} 列，仅待验收（或确认中的进行中）任务可验收通过`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id, column: task.column },
          )
        }
        const now = Date.now()
        task.column = 'done'
        task.completedAt = now
        delete task.mergePending
        delete task.silenceState
        task.updatedAt = now

        // 下游依赖解锁扫描：backlog 中依赖本任务的任务，全部前置 done 即解锁（启动在落盘后逐个执行）
        const downstream: Array<{ id: string; autoStartOnUnblock: boolean }> = []
        for (const candidate of Object.values(draft.tasks)) {
          if (candidate.column !== 'backlog' || !candidate.dependsOn.includes(task.id)) continue
          if (blockedDependenciesOf(candidate, draft.tasks).length > 0) continue
          downstream.push({ id: candidate.id, autoStartOnUnblock: candidate.autoStartOnUnblock === true })
        }
        return { task, conversationId: task.conversationId, downstream }
      })
      await runtime.flushRecords()

      // 衍生 1：会话换归档标签（失败仅影响侧栏分组展示，容忍上报）
      if (conversationId !== undefined) {
        await swapConversationTag(ctx, runtime, conversationId, TASK_ARCHIVED_TAG).catch((err) => {
          runtime.reportError(`任务 ${task.id} 结单后会话 #${conversationId} 换标签失败（不影响验收结果）`, err)
        })
      }

      // 衍生 2：下游接棒逐个两阶段启动（单个失败上报继续，不阻断其余与验收事实）
      const unblockedTaskIds = downstream.map((d) => d.id)
      const autoStartedTaskIds: string[] = []
      for (const candidate of downstream) {
        if (!candidate.autoStartOnUnblock) continue
        try {
          const occupied = await runtime.store.enqueueMutation((draft) => {
            const target = draft.tasks[candidate.id]
            if (target === undefined || target.column !== 'backlog') return false
            const { maxConcurrentTasks } = runtime.getConfig()
            const inProgress = Object.values(draft.tasks).filter((t) => t.column === 'in_progress').length
            if (maxConcurrentTasks > 0 && inProgress >= maxConcurrentTasks) return false
            target.column = 'in_progress'
            target.startedAt = Date.now()
            target.updatedAt = target.startedAt
            delete target.silenceState
            return true
          })
          if (!occupied) continue
          await runtime.flushRecords()
          await launchTaskExecution(ctx, runtime, candidate.id)
          autoStartedTaskIds.push(candidate.id)
        } catch (err) {
          runtime.reportError(`任务 ${task.id} 验收后下游任务 ${candidate.id} 自动接棒启动失败（任务保留待办可手动 start）`, err)
          await runtime.store
            .enqueueMutation((draft) => {
              const target = draft.tasks[candidate.id]
              if (target === undefined || target.conversationId !== undefined || target.column !== 'in_progress') return
              target.column = 'backlog'
              delete target.startedAt
              target.updatedAt = Date.now()
            })
            .catch(() => undefined)
        }
      }
      return { task, unblockedTaskIds, autoStartedTaskIds }
    })
  }

  // ---------------- rework ----------------
  const reworkTask = async (
    input: { taskId: string; feedback: string; recreateConversation?: boolean },
    context: PluginActionContext,
  ): Promise<{ task: TaskRecord; conversationId?: number; recreatedConversation?: boolean }> => {
    assertPlannerAuthority(runtime, context, 'rework')
    if (typeof input.feedback !== 'string' || input.feedback.trim() === '') {
      throw new HelmxError('validation_error', 'feedback 必须是非空返工意见', 400, {})
    }
    return runtime.track('task:rework', async () => {
      // 投递原子模式：状态变更 + 意见投递同一串行 mutation，submitInput 成功后才 write（失败 draft 丢弃可干净重试）；
      // requestId 按 reworkCount 幂等——崩溃窗口内已投递的重试不会重复投递意见。
      const outcome = await runtime.store.enqueueMutation(
        async (
          draft,
        ): Promise<{ kind: 'delivered'; task: TaskRecord; conversationId: number } | { kind: 'recreate'; task: TaskRecord }> => {
        const task = requireTaskInDraft(draft.tasks, input.taskId)
        const conversationMissing =
          task.conversationId === undefined || conversationLive(runtime, task.conversationId) === null
        // in_progress + 会话缺失（被删除）也允许返工——这是重建执行会话的唯一入口；
        // in_progress 且会话健在时无需返工（直接与会话沟通即可）。
        if (
          task.column !== 'in_review' &&
          task.column !== 'done' &&
          !(task.column === 'in_progress' && conversationMissing)
        ) {
          throw new HelmxError(
            'task_invalid_column',
            `任务 ${task.id} 当前位于 ${task.column} 列，仅待验收 / 已完成（或会话缺失的进行中）任务可打回返工`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id, column: task.column },
          )
        }
        // 拒绝路径先于任何状态变更抛出（fn 抛错则 draft 丢弃，绝不半途落盘）
        if (conversationMissing && input.recreateConversation !== true) {
          throw new HelmxError(
            'task_conversation_missing',
            `任务 ${task.id} 的原执行会话已不存在，无法投递返工意见（传 recreateConversation: true 重建执行会话，或先删除该任务）`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id },
          )
        }
        task.column = 'in_progress'
        task.reworkCount += 1
        task.lastReworkFeedback = input.feedback.trim()
        delete task.mergePending
        delete task.silenceState
        task.updatedAt = Date.now()

        if (!conversationMissing) {
          const conversationId = task.conversationId!
          await ctx.host.submitInput(conversationId, buildReworkDeliveryPrompt(task, input.feedback), {
            origin: 'agent',
            whenBusy: 'steer',
            requestId: `${TASKS_PLUGIN_ID}:rework:${task.id}:${task.reworkCount}`,
          })
          await swapConversationTag(ctx, runtime, conversationId, TASK_ACTIVE_TAG)
          return { kind: 'delivered', task, conversationId }
        }
        // recreate 分支：清掉失效绑定与缺失标记，回到两阶段启动占位态（in_progress 无 conversationId）
        delete task.conversationId
        delete task.conversationMissing
        return { kind: 'recreate', task }
      })

      if (outcome.kind === 'delivered') {
        return { task: outcome.task, conversationId: outcome.conversationId }
      }

      // recreate：状态已落盘（flush 后）再重建会话并投递「任务书 + 返工意见」
      await runtime.flushRecords()
      const conversationId = await launchTaskExecution(ctx, runtime, outcome.task.id)
      await ctx.host.submitInput(
        conversationId,
        buildReworkDeliveryPrompt(outcome.task, input.feedback, { recreated: true }),
        {
          origin: 'agent',
          whenBusy: 'followUp',
          requestId: `${TASKS_PLUGIN_ID}:rework-recreate:${outcome.task.id}:${outcome.task.reworkCount}`,
        },
      )
      const task = runtime.store.get(outcome.task.id)!
      return { task, conversationId, recreatedConversation: true }
    })
  }

  // ---------------- archive ----------------
  const archiveTask = async (
    input: { taskId: string },
    context: PluginActionContext,
  ): Promise<{ task: TaskRecord }> => {
    assertPlannerAuthority(runtime, context, 'archive')
    return runtime.track('task:archive', () =>
      runtime.store.enqueueMutation(async (draft) => {
        const task = requireTaskInDraft(draft.tasks, input.taskId)
        if (task.column === 'in_progress' || task.column === 'in_review') {
          throw new HelmxError(
            'task_in_progress',
            `任务 ${task.id} 进行中（column=${task.column}），不可归档（先验收或删除）`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id, column: task.column },
          )
        }
        task.archived = true
        task.updatedAt = Date.now()
        if (task.conversationId !== undefined) {
          await swapConversationTag(ctx, runtime, task.conversationId, TASK_ARCHIVED_TAG)
        }
        return { task }
      }),
    )
  }

  // ---------------- delete ----------------
  const deleteTask = async (
    input: { taskId: string },
    context: PluginActionContext,
  ): Promise<{ deleted: true; taskId: string; conversationId?: number }> => {
    assertPlannerAuthority(runtime, context, 'delete')
    return runtime.track('task:delete', () =>
      runtime.store.enqueueMutation(async (draft) => {
        const task = requireTaskInDraft(draft.tasks, input.taskId)
        if (task.column === 'in_progress' || task.column === 'in_review') {
          const conv =
            task.conversationId !== undefined ? runtime.readConversationOrUndefined(task.conversationId) : undefined
          if (conv === undefined || conv.status === 'working' || conv.status === 'blocked') {
            throw new HelmxError(
              'task_in_progress',
              `任务 ${task.id} 执行中（column=${task.column}${conv !== undefined ? `，会话状态 ${conv.status}` : '，会话缺失'}），不可删除`,
              409,
              { pluginId: TASKS_PLUGIN_ID, taskId: task.id, column: task.column },
            )
          }
        }
        const conversationId = task.conversationId
        delete draft.tasks[task.id]
        if (conversationId !== undefined) {
          await stripConversationTaskTags(ctx, runtime, conversationId)
        }
        return { deleted: true, taskId: task.id, ...(conversationId !== undefined ? { conversationId } : {}) }
      }),
    )
  }

  // ------------------------------------------------------------------
  // ctx.action（HTTP / CLI / Workflow / Web 五端同源复用，exposeAsTool: false）
  // ------------------------------------------------------------------

  const taskIdSchema: Record<string, unknown> = {
    type: 'string',
    minLength: 1,
    maxLength: 64,
    description: 'Board task id (e.g. T-1)',
  }

  ctx.action({
    id: 'create',
    description: 'Create a board task with a self-contained brief; optionally auto-starts an independent top-level execution conversation.',
    exposeAsTool: false,
    cli: { command: ['tasks', 'create'], description: 'Create a board task' },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120, description: 'Short task title' },
        brief: { type: 'string', minLength: 1, description: 'Self-contained task brief (Markdown: context, scope, acceptance criteria)' },
        project: { type: 'string', maxLength: 120, description: 'Optional lightweight project grouping name' },
        assigneeProfileId: { type: 'string', maxLength: 64, description: 'Executor profile id (defaults to plugin config, then caller profile, then assistant)' },
        nodeId: { type: 'string', maxLength: 64, description: 'Target compute node id (defaults to profile/origin node)' },
        cwd: { type: 'string', description: 'Absolute working directory on the target node (required for remote nodes)' },
        model: { type: 'string', maxLength: 128, description: 'Optional model override (provider/model)' },
        thinkingLevel: { type: 'string', maxLength: 16, description: 'Optional thinking level override' },
        planFirst: { type: 'boolean', description: 'Require plan confirmation before coding (default false)' },
        autoMerge: { type: 'boolean', description: 'Allow the assignee to merge the branch itself after verification (default false)' },
        dependsOn: { type: 'array', items: taskIdSchema, description: 'Prerequisite task ids; the task stays in backlog until all are done' },
        autoStart: { type: 'boolean', description: 'Start immediately when unblocked (default true)' },
      },
      required: ['title', 'brief'],
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: (input: CreateTaskInput, context) => createTask(input, context),
  })

  ctx.action({
    id: 'list',
    description: 'List board tasks with live conversation status, doing, pending asks, and blockedBy dependencies.',
    exposeAsTool: false,
    idempotent: true,
    cli: { command: ['tasks', 'list'], description: 'List board tasks' },
    inputSchema: {
      type: 'object',
      properties: {
        column: { type: 'string', enum: ['backlog', 'in_progress', 'in_review', 'done'] },
        project: { type: 'string', maxLength: 120 },
        assigneeProfileId: { type: 'string', maxLength: 64 },
        nodeId: { type: 'string', maxLength: 64 },
        includeArchived: { type: 'boolean' },
      },
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: (input: Parameters<typeof listTasks>[0]) => listTasks(input),
  })

  ctx.action({
    id: 'inspect',
    description: 'Inspect one board task: full record, dependency status, live conversation state, recent entries, artifacts.',
    exposeAsTool: false,
    idempotent: true,
    cli: { command: ['tasks', 'inspect'], description: 'Inspect a board task', positional: [{ field: 'taskId', required: true }] },
    inputSchema: {
      type: 'object',
      properties: { taskId: taskIdSchema },
      required: ['taskId'],
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: (input: { taskId: string }) => inspectTask(input),
  })

  ctx.action({
    id: 'update',
    description: 'Edit task fields before or after start (executor profile/node/cwd are locked once started; dependency graph must stay acyclic).',
    exposeAsTool: false,
    cli: { command: ['tasks', 'update'], description: 'Update a board task', positional: [{ field: 'taskId', required: true }] },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdSchema,
        title: { type: 'string', minLength: 1, maxLength: 120 },
        brief: { type: 'string', minLength: 1 },
        project: { type: 'string', maxLength: 120, description: 'Pass null or empty to clear' },
        assigneeProfileId: { type: 'string', maxLength: 64 },
        nodeId: { type: 'string', maxLength: 120, description: 'Pass null or empty to clear (pre-start only)' },
        cwd: { type: 'string', description: 'Pass null or empty to clear (pre-start only)' },
        model: { type: 'string', maxLength: 128 },
        thinkingLevel: { type: 'string', maxLength: 16 },
        planFirst: { type: 'boolean' },
        autoMerge: { type: 'boolean' },
        dependsOn: { type: 'array', items: taskIdSchema },
        autoStartOnUnblock: { type: 'boolean' },
      },
      required: ['taskId'],
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: (input: Parameters<typeof updateTask>[0], context) => updateTask(input, context),
  })

  ctx.action({
    id: 'start',
    description: 'Start a backlog task: validates dependencies are done and concurrency limits, then creates an independent top-level execution conversation.',
    exposeAsTool: false,
    cli: { command: ['tasks', 'start'], description: 'Start a backlog board task', positional: [{ field: 'taskId', required: true }] },
    inputSchema: {
      type: 'object',
      properties: { taskId: taskIdSchema },
      required: ['taskId'],
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: (input: { taskId: string }, context) => startTask(input, context),
  })

  ctx.action({
    id: 'submit',
    description: 'Assignee submission: move the bound task to in_review with a summary and verification evidence. Inside a task conversation the bound task is resolved automatically.',
    exposeAsTool: false,
    scope: { tags: [TASK_ACTIVE_TAG] },
    cli: { command: ['tasks', 'submit'], description: 'Submit a board task for review' },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdSchema,
        summary: { type: 'string', minLength: 1, description: 'What was delivered' },
        verification: { type: 'string', description: 'How it was verified (commands, results)' },
        branch: { type: 'string', description: 'Delivery branch name' },
        worktreePath: { type: 'string', description: 'Isolated worktree path used' },
        changedFiles: { type: 'array', items: { type: 'string' } },
        artifactIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary'],
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: (input: Parameters<typeof submitTask>[0], context) => submitTask(input, context),
  })

  ctx.action({
    id: 'approve',
    description: 'Accept a task: close_only marks it done and unblocks downstream dependencies; merge_and_close sends a merge-and-cleanup instruction back to the execution conversation.',
    exposeAsTool: false,
    cli: { command: ['tasks', 'approve'], description: 'Approve a board task', positional: [{ field: 'taskId', required: true }] },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdSchema,
        mergeAction: { type: 'string', enum: ['close_only', 'merge_and_close'] },
        note: { type: 'string', description: 'Optional reviewer note delivered with the merge instruction' },
      },
      required: ['taskId'],
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: (input: Parameters<typeof approveTask>[0], context) => approveTask(input, context),
  })

  ctx.action({
    id: 'rework',
    description: 'Send a task back for rework: returns it to in_progress, records the feedback, and delivers it to the original execution conversation.',
    exposeAsTool: false,
    cli: { command: ['tasks', 'rework'], description: 'Send a board task back for rework', positional: [{ field: 'taskId', required: true }] },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdSchema,
        feedback: { type: 'string', minLength: 1, description: 'Rework feedback describing what must change' },
        recreateConversation: { type: 'boolean', description: 'Recreate the execution conversation when the original is gone' },
      },
      required: ['taskId', 'feedback'],
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: (input: Parameters<typeof reworkTask>[0], context) => reworkTask(input, context),
  })

  ctx.action({
    id: 'archive',
    description: 'Archive a backlog or done task off the active board (running tasks are refused).',
    exposeAsTool: false,
    cli: { command: ['tasks', 'archive'], description: 'Archive a board task', positional: [{ field: 'taskId', required: true }] },
    inputSchema: {
      type: 'object',
      properties: { taskId: taskIdSchema },
      required: ['taskId'],
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: (input: { taskId: string }, context) => archiveTask(input, context),
  })

  ctx.action({
    id: 'delete',
    description: 'Delete a backlog/done/archived task record (never deletes the underlying conversation history). Running tasks are refused.',
    exposeAsTool: false,
    cli: { command: ['tasks', 'delete'], description: 'Delete a board task', positional: [{ field: 'taskId', required: true }] },
    inputSchema: {
      type: 'object',
      properties: { taskId: taskIdSchema },
      required: ['taskId'],
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: (input: { taskId: string }, context) => deleteTask(input, context),
  })

  // ------------------------------------------------------------------
  // ctx.tool（精确短名直暴模型；与 action 共用同一 handler）
  // ------------------------------------------------------------------

  const toolIo = (toolContext: PluginToolContext): PluginActionContext => ({
    conversationId: toolContext.conversationId,
    signal: toolContext.signal,
  })

  ctx.tool({
    name: 'task_create',
    description:
      'Create a task board card with a self-contained brief (context, scope, acceptance criteria) and optionally start it immediately on an independent top-level execution conversation. Use when the user wants to delegate a well-defined unit of work instead of doing it in the current conversation.',
    promptSnippet: 'Delegate well-defined units of work to the task board (`task_create`) and keep this conversation for planning and review.',
    promptGuidelines: [
      'Write a self-contained brief: background, scope, acceptance criteria, and target directory; never rely on unstated here-and-now context.',
      'Do not write the business code yourself in the planning conversation; delegate it via task_create and review via task_approve / task_rework.',
      'Split large efforts into multiple tasks wired with dependsOn; chained tasks auto-start when their prerequisites pass review.',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        brief: { type: 'string', minLength: 1 },
        project: { type: 'string', maxLength: 120 },
        assigneeProfileId: { type: 'string', maxLength: 64 },
        nodeId: { type: 'string', maxLength: 64 },
        cwd: { type: 'string' },
        model: { type: 'string', maxLength: 128 },
        thinkingLevel: { type: 'string', maxLength: 16 },
        planFirst: { type: 'boolean' },
        autoMerge: { type: 'boolean' },
        dependsOn: { type: 'array', items: taskIdSchema },
        autoStart: { type: 'boolean' },
      },
      required: ['title', 'brief'],
      additionalProperties: false,
    } as never,
    structuredOutputSchema: { type: 'object' } as never,
    replay: 'unsafe',
    execute: async (input: never, toolContext: PluginToolContext) => {
      const res = await createTask(input as CreateTaskInput, toolIo(toolContext))
      const tail =
        res.started
          ? `started on conversation #${res.conversationId}`
          : `kept in backlog (${res.notStartedReason}${res.blockedBy.length > 0 ? `: blocked by ${res.blockedBy.join(', ')}` : ''})`
      return { output: `Task ${res.task.id} "${res.task.title}" ${tail}.`, structuredOutput: res }
    },
  })

  ctx.tool({
    name: 'task_list',
    description: 'List task board cards with live conversation status and blockedBy dependencies. Filters: column, project, assigneeProfileId, nodeId, includeArchived.',
    inputSchema: {
      type: 'object',
      properties: {
        column: { type: 'string', enum: ['backlog', 'in_progress', 'in_review', 'done'] },
        project: { type: 'string', maxLength: 120 },
        assigneeProfileId: { type: 'string', maxLength: 64 },
        nodeId: { type: 'string', maxLength: 64 },
        includeArchived: { type: 'boolean' },
      },
      additionalProperties: false,
    } as never,
    structuredOutputSchema: { type: 'object' } as never,
    replay: 'safe',
    execute: async (input: never, toolContext: PluginToolContext) => {
      const res = await listTasks(input as Parameters<typeof listTasks>[0])
      const lines = res.tasks.map(
        (t) =>
          `${t.id} [${t.column}] "${t.title}" @${t.assigneeProfileId}${t.live.conversation ? ` (${t.live.conversation.status})` : ''}${t.live.blockedBy.length > 0 ? ` blockedBy=${t.live.blockedBy.join(',')}` : ''}`,
      )
      const output =
        lines.length === 0 ? 'No matching board tasks.' : `Board tasks (${res.total}):\n${lines.join('\n')}`
      void toolContext
      return { output, structuredOutput: res }
    },
  })

  ctx.tool({
    name: 'task_inspect',
    description: 'Inspect one board task: full record, dependency status, live conversation state, recent entries, and artifacts.',
    inputSchema: {
      type: 'object',
      properties: { taskId: taskIdSchema },
      required: ['taskId'],
      additionalProperties: false,
    } as never,
    structuredOutputSchema: { type: 'object' } as never,
    replay: 'safe',
    execute: async (input: never, toolContext: PluginToolContext) => {
      const res = await inspectTask(input as { taskId: string })
      void toolContext
      return {
        output: `Task ${(res.task as TaskRecord).id} [${(res.task as TaskRecord).column}] "${(res.task as TaskRecord).title}".`,
        structuredOutput: res,
      }
    },
  })

  ctx.tool({
    name: 'task_start',
    description: 'Start a backlog board task whose dependencies are all done: creates an independent top-level execution conversation and delivers the task brief.',
    inputSchema: {
      type: 'object',
      properties: { taskId: taskIdSchema },
      required: ['taskId'],
      additionalProperties: false,
    } as never,
    structuredOutputSchema: { type: 'object' } as never,
    replay: 'unsafe',
    execute: async (input: never, toolContext: PluginToolContext) => {
      const res = await startTask(input as { taskId: string }, toolIo(toolContext))
      return {
        output: `Task ${res.task.id} started on conversation #${res.conversationId}.`,
        structuredOutput: res,
      }
    },
  })

  ctx.tool({
    name: 'task_submit',
    description:
      'Submit the task bound to this conversation for review (assignee-only): moves it to in_review with summary, verification, branch, changed files. Call this when the assigned work meets its acceptance criteria.',
    promptSnippet: 'When working inside a task execution conversation, hand in finished work via `task_submit` instead of ending silently.',
    promptGuidelines: [
      'Call task_submit with a truthful summary and verification evidence when the task meets its acceptance criteria.',
      'If a human decision is needed, ask a clear question instead of submitting half-done work.',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdSchema,
        summary: { type: 'string', minLength: 1 },
        verification: { type: 'string' },
        branch: { type: 'string' },
        worktreePath: { type: 'string' },
        changedFiles: { type: 'array', items: { type: 'string' } },
        artifactIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary'],
      additionalProperties: false,
    } as never,
    structuredOutputSchema: { type: 'object' } as never,
    replay: 'unsafe',
    execute: async (input: never, toolContext: PluginToolContext) => {
      const res = await submitTask(input as Parameters<typeof submitTask>[0], toolIo(toolContext))
      return {
        output: `Task ${res.task.id} submitted for review: ${res.task.submission?.summary ?? ''}`.trim(),
        structuredOutput: res,
      }
    },
  })

  ctx.tool({
    name: 'task_approve',
    description:
      'Accept a reviewed task (planner/human action): close_only marks it done and auto-unblocks downstream dependsOn tasks; merge_and_close asks the assignee to merge its branch and clean up first.',
    promptSnippet: 'Close the review loop with `task_approve` (close_only or merge_and_close) or `task_rework` with concrete feedback.',
    promptGuidelines: [
      'Approve with close_only when the submission passes; the task moves to done and blocked downstream tasks auto-start.',
      'Use merge_and_close when the assignee must merge its isolated branch and clean up the worktree before completion.',
      'Never approve from inside a task execution conversation; approval belongs to the planning side.',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdSchema,
        mergeAction: { type: 'string', enum: ['close_only', 'merge_and_close'] },
        note: { type: 'string' },
      },
      required: ['taskId'],
      additionalProperties: false,
    } as never,
    structuredOutputSchema: { type: 'object' } as never,
    replay: 'unsafe',
    execute: async (input: never, toolContext: PluginToolContext) => {
      const res = await approveTask(input as Parameters<typeof approveTask>[0], toolIo(toolContext))
      const tail =
        res.autoStartedTaskIds.length > 0
          ? ` Auto-started downstream: ${res.autoStartedTaskIds.join(', ')}.`
          : res.unblockedTaskIds.length > 0
            ? ` Unblocked downstream: ${res.unblockedTaskIds.join(', ')}.`
            : ''
      return { output: `Task ${res.task.id} approved (${res.task.column}).${tail}`, structuredOutput: res }
    },
  })

  ctx.tool({
    name: 'task_rework',
    description:
      'Send a reviewed task back for rework (planner/human action): returns it to in_progress and delivers the feedback to the original execution conversation.',
    promptSnippet: 'Reject unclear or failing submissions with `task_rework` and concrete, actionable feedback.',
    promptGuidelines: [
      'Give concrete feedback describing what must change and how to verify it; vague feedback produces vague rework.',
      'If the original execution conversation was deleted, either pass recreateConversation: true or delete the task record.',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdSchema,
        feedback: { type: 'string', minLength: 1 },
        recreateConversation: { type: 'boolean' },
      },
      required: ['taskId', 'feedback'],
      additionalProperties: false,
    } as never,
    structuredOutputSchema: { type: 'object' } as never,
    replay: 'unsafe',
    execute: async (input: never, toolContext: PluginToolContext) => {
      const res = await reworkTask(input as Parameters<typeof reworkTask>[0], toolIo(toolContext))
      return {
        output: `Task ${res.task.id} sent back for rework (round ${res.task.reworkCount}).`,
        structuredOutput: res,
      }
    },
  })

}
