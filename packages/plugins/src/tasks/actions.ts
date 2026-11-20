/**
 * builtin:tasks 动作与模型工具统一注册入口。
 *
 * 双轨暴露（与 builtin:swarm 同款纪律）：
 * - 12 个 `ctx.action`（exposeAsTool: false）承载 HTTP / CLI / Workflow / Web 五端，
 *   CLI 自动映射 `helmx tasks <cmd>`；
 * - 8 个 `ctx.tool` 以精确短名（task_create / task_list / task_inspect / task_start /
 *   task_submit / task_request_plan_approval / task_approve / task_rework）直接进模型
 *   工具列表——不用 exposeAsTool 派生（派生名带哈希后缀，无法满足共享契约的精确短名）。
 *
 * 诚实性边界：
 * - 任务执行会话保持 `ownedBy: 'human'`、零 parentConversationId（完整保留
 *   subagent / SubagentWorkflow / Swarm 决策权）；
 * - 规划动作（create/start/approve/rework/update/archive/delete）在会话上下文中
 *   拒绝任务执行会话 / 子会话 / 自动化会话调用（防执行者自建看板卡或自审自批）；
 * - `task_submit` 仅允许交卷当前会话绑定的任务（防串单）；
 * - submit 进入 in_review 时发一条 info 级 `notification` 事件（全局 Toast 即时可见，
 *   通知失败仅记日志绝不影响交卷）；mergePending 授权一步结单保持安静零噪音。
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
  subtreeHasWorkingOrBlocked,
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

/** 持久化输入统一脱敏：brief/title/summary/feedback 等用户文本进 doc 前过宿主唯一脱敏入口（机密已登记则替换为标记）。 */
function sanitizeText(ctx: HelmxPluginContext, value: string): string {
  return ctx.host.redact(value)
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
  idempotencyKey?: string
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
  createKey?: string
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
  const createKey =
    input.idempotencyKey !== undefined && input.idempotencyKey.trim() !== ''
      ? input.idempotencyKey.trim()
      : undefined
  if (createKey !== undefined && createKey.length > 128) {
    throw new HelmxError('validation_error', `idempotencyKey 长度 ${createKey.length} 超过 128 上限（拒绝而非截断，防前缀碰撞）`, 400, {})
  }
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
    ...(createKey !== undefined ? { createKey } : {}),
  }
}

// ---------------------------------------------------------------------------
// 启动核心：解析执行者坐标并创建独立顶层 human-owned 执行会话
// ---------------------------------------------------------------------------

interface ResolvedCoordinates {
  nodeId: string
  cwd?: string
}

/** 可指派执行者判定（create 解析链与 update 显式修改同一口径）。 */
function isAssignableTaskProfile(profile: { humanSelectable?: boolean; runtime?: unknown }): boolean {
  return profile.humanSelectable !== false && profile.runtime === undefined
}

/**
 * 解析执行角色：显式指定时同样强校验（存在、humanSelectable !== false、未绑定外部
 * runtime——外部 runtime Profile 的生命周期归其宿主插件管理，不能作为看板执行者）；
 * 缺省链（config.defaultAssigneeProfile -> 发起会话 Profile -> assistant）逐级回退，
 * 跳过不可指派的候选。显式校验失败显式报错，缺省回退链耗尽报 tasks_no_assignee。
 */
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
  let lastReason: 'missing' | 'not_assignable' | undefined
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.trim() === '') continue
    const profile = await ctx.host.profiles.get(candidate)
    if (profile === undefined) {
      lastMissing = candidate
      lastReason = 'missing'
      continue
    }
    if (!isAssignableTaskProfile(profile)) {
      lastMissing = candidate
      lastReason = 'not_assignable'
      continue
    }
    return { profileId: profile.id, ...(profile.nodeId !== undefined ? { nodeId: profile.nodeId } : {}), ...(profile.cwd !== undefined ? { cwd: profile.cwd } : {}) }
  }
  if (explicitProfileId !== undefined) {
    if (lastReason === 'missing') {
      throw new HelmxError('not_found', `执行角色 Profile '${explicitProfileId}' 不存在`, 404, {
        pluginId: TASKS_PLUGIN_ID,
        profileId: explicitProfileId,
      })
    }
    throw new HelmxError(
      'validation_error',
      `执行角色 Profile '${explicitProfileId}' 不可被指派（humanSelectable 为 false 或绑定了外部 runtime，生命周期归其宿主插件管理）`,
      400,
      { pluginId: TASKS_PLUGIN_ID, profileId: explicitProfileId },
    )
  }
  throw new HelmxError('tasks_no_assignee', '无法解析可用执行角色（默认 Profile 与回退链均不可用）', 500, {
    pluginId: TASKS_PLUGIN_ID,
  })
}

/**
 * 解析执行坐标：nodeId 与 cwd 必须成对继承——cwd 只在其来源节点与最终 nodeId 一致时
 * 才可用（显式换节点时旧 Profile 的 cwd 属于另一台机器，绝不可串用）；显式 cwd 恒可用
 * （调用者对配对负责）。远端节点最终无 cwd 显式拒绝，绝不盲执行远端默认目录。
 */
export function resolveCoordinates(input: {
  explicitNodeId?: string
  explicitCwd?: string
  profileNodeId?: string
  profileCwd?: string
  originConversation?: ConversationSummary
}): ResolvedCoordinates {
  const originConv = input.originConversation
  const nodeId = input.explicitNodeId ?? input.profileNodeId ?? originConv?.nodeId ?? 'local'
  let cwd = input.explicitCwd
  if (cwd === undefined && input.profileNodeId === nodeId && input.profileCwd !== undefined) {
    cwd = input.profileCwd
  }
  if (cwd === undefined && originConv !== undefined && originConv.nodeId === nodeId) {
    cwd = originConv.cwd
  }
  if (nodeId !== 'local' && cwd === undefined) {
    throw new HelmxError(
      'validation_error',
      `任务目标节点 '${nodeId}' 缺少工作目录（cwd）：远端节点必须显式提供与该节点配对的 cwd（或为执行角色 Profile 配置同节点默认 cwd）`,
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
 * 回滚覆盖**整个**两阶段窗口——含建会话前的坐标解析 / Profile 读取失败（否则占位
 * 卡死 in_progress 无会话，start 拒绝重入只能等重启恢复）。
 * 崩溃窗口：步骤 2/3 之间重启 → service.start 的 recoverInterruptedStartups 诚实回滚。
 */
async function launchTaskExecution(
  ctx: HelmxPluginContext,
  runtime: TasksRuntime,
  taskId: string,
  options?: { prompt?: string; requestId?: string; delivery?: 'reject' | 'followUp' },
): Promise<number> {
  const task = runtime.store.get(taskId)
  if (task === undefined) {
    throw new HelmxError('not_found', `任务 '${taskId}' 不存在`, 404, { pluginId: TASKS_PLUGIN_ID, taskId })
  }
  let created: Awaited<ReturnType<typeof ctx.host.createConversation>> | undefined
  try {
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

    created = await ctx.host.createConversation({
      title: task.title,
      profileId: task.assigneeProfileId,
      tags: [TASK_ACTIVE_TAG],
      ...(coordinates.cwd !== undefined ? { cwd: coordinates.cwd } : {}),
      nodeId: coordinates.nodeId,
      ...(task.model !== undefined && task.model !== '' ? { model: task.model } : {}),
    })
    if (task.thinkingLevel !== undefined && task.thinkingLevel !== '') {
      await ctx.host.updateConversation(created.id, { thinkingLevel: task.thinkingLevel })
    }
    await runtime.store.enqueueMutation((draft) => {
      const target = draft.tasks[taskId]
      if (target === undefined || target.conversationId !== undefined) return
      target.conversationId = created!.id
      target.startedAt = Date.now()
      target.updatedAt = target.startedAt
      delete target.conversationMissing
    })
    // 投递前落盘持久标记（flush）：投递成功后清除；「标记设置后、清除前」崩溃的重启残留
    // 即 kickoffUndelivered 事实源（若实际已送达，用户显式重投会被 requestId 幂等去重，安全）。
    await runtime.store.enqueueMutation((draft) => {
      const target = draft.tasks[taskId]
      if (target !== undefined && target.conversationId === created!.id) target.kickoffPending = true
    })
    await runtime.flushRecords()
    // 初始投递用 reject：新会话必 idle，若创建与投递之间被人类抢先输入（接管窗口），
    // 显式拒绝绝不串入；返工重建的合成任务书同用 reject。
    await ctx.host.submitInput(created.id, options?.prompt ?? buildTaskKickoffPrompt(task), {
      origin: 'agent',
      whenBusy: options?.delivery ?? 'reject',
      requestId: options?.requestId ?? `${TASKS_PLUGIN_ID}:kickoff:${taskId}`,
    })
    await runtime.store.enqueueMutation((draft) => {
      const target = draft.tasks[taskId]
      if (target !== undefined && target.kickoffPending === true) {
        delete target.kickoffPending
        target.updatedAt = Date.now()
      }
    })
  } catch (err) {
    // 干净回滚：任务回待办记 lastError（flush 后可重试 start）；显式抛错。回滚覆盖整个
    // 两阶段窗口（含建会话前失败）；绑定关系仅在「未绑定」或「绑定的正是本次会话」时
    // 才动，绝不误伤并发新绑定；kickoffPending 残留同步清除（防重试串味）。
    // 接管窗口（whenBusy reject 命中 conversation_busy：人在创建与投递之间抢先输入）不贴
    // task-archived——会话已被人类接管，保留 task 标签避免分组跳变，归位由后续流程处理。
    const takeover = err instanceof HelmxError && err.code === 'conversation_busy'
    runtime.reportError(
      takeover
        ? `任务 ${taskId} 初始任务书被拒（会话 #${created?.id ?? '?'} 已被用户接管，kickoff 未串入）`
        : `任务 ${taskId} 启动失败，执行回滚${created !== undefined ? `（会话 #${created.id} 已归档标记）` : '（会话尚未创建）'}`,
      err,
    )
    const createdId = created?.id
    await runtime.store
      .enqueueMutation((draft) => {
        const target = draft.tasks[taskId]
        if (target === undefined) return
        if (target.conversationId !== undefined && target.conversationId !== createdId) return
        target.column = 'backlog'
        delete target.conversationId
        delete target.startedAt
        delete target.kickoffPending
        target.silenceState = {
          ...(target.silenceState ?? {}),
          lastError: err instanceof Error ? err.message : String(err),
        }
        target.updatedAt = Date.now()
      })
      .catch(() => undefined)
    await runtime.flushRecords().catch(() => undefined)
    if (!takeover && created !== undefined) {
      await swapConversationTag(ctx, runtime, created.id, TASK_ARCHIVED_TAG).catch(() => {})
    }
    throw err instanceof HelmxError
      ? err
      : new HelmxError('task_start_failed', `任务 ${taskId} 启动失败：${err instanceof Error ? err.message : String(err)}`, 500, {
          pluginId: TASKS_PLUGIN_ID,
          taskId,
          ...(created !== undefined ? { conversationId: created.id } : {}),
        })
  }
  return created!.id
}

// ---------------------------------------------------------------------------
// planFirst 真实方案审批：ctx.host.createAsk confirm 卡片 -> 持久化决定
// ---------------------------------------------------------------------------

/**
 * planFirst 方案审批（真实 AskDoc 闭环）：向执行会话发 confirm Ask，等待用户明确
 * 批准 / 拒绝（cancelled / superseded 视为未获批准），把决定持久化到任务记录。
 * 工具执行期间会话 blocked（pendingAskCount > 0），看板如实显示等待人类决策；
 * task_submit 门禁只认 decision === 'approved'。
 */
async function requestPlanApproval(
  ctx: HelmxPluginContext,
  runtime: TasksRuntime,
  input: { plan: string },
  conversationId: number,
  signal?: AbortSignal,
): Promise<{ taskId: string; decision: 'approved' | 'rejected' | 'cancelled' | 'superseded'; askId: string }> {
  const store = runtime.store.read()
  const task = Object.values(store.tasks).find(
    (t) => t.conversationId === conversationId && (t.column === 'in_progress' || t.column === 'in_review'),
  )
  if (task === undefined) {
    throw new HelmxError(
      'task_not_found_in_conversation',
      `当前会话 #${conversationId} 未绑定进行中的看板任务`,
      404,
      { pluginId: TASKS_PLUGIN_ID, conversationId },
    )
  }
  if (task.planFirst !== true) {
    throw new HelmxError(
      'task_plan_first_not_enabled',
      `任务 ${task.id} 未开启 planFirst，无需方案审批（直接执行并 task_submit 交卷）`,
      409,
      { pluginId: TASKS_PLUGIN_ID, taskId: task.id },
    )
  }
  if (task.planApproval?.decision === 'approved') {
    return { taskId: task.id, decision: 'approved', askId: task.planApproval.askId }
  }

  const askedAt = Date.now()
  const askId = `${TASKS_PLUGIN_ID}:plan:${task.id}:${askedAt}`
  // 重试防遗留：先撤销本任务上一张仍 pending 的审批卡（superseded），再建新卡
  if (task.pendingPlanAskId !== undefined && task.pendingPlanAskId !== askId) {
    try {
      await ctx.host.cancelAsk(task.pendingPlanAskId, 'superseded')
    } catch (err) {
      if (!(err instanceof HelmxError && err.code === 'not_found')) throw err
    }
    await runtime.store.enqueueMutation((draft) => {
      const target = draft.tasks[task.id]
      if (target !== undefined) delete target.pendingPlanAskId
    })
  }
  await runtime.store.enqueueMutation((draft) => {
    const target = draft.tasks[task.id]
    if (target !== undefined) target.pendingPlanAskId = askId
  })
  let settled: Awaited<ReturnType<typeof ctx.host.createAsk>>
  try {
    settled = await ctx.host.createAsk({
      id: askId,
      conversationId,
      ownerPluginId: TASKS_PLUGIN_ID,
      title: `任务 ${task.id} 方案审批（planFirst）`,
      description: ctx.host.redact(input.plan),
      fields: [{ name: 'approve', label: `批准该方案并允许动工（任务 ${task.id}）`, type: 'confirm', required: true }],
    })
  } catch (err) {
    await runtime.store
      .enqueueMutation((draft) => {
        const target = draft.tasks[task.id]
        if (target !== undefined && target.pendingPlanAskId === askId) delete target.pendingPlanAskId
      })
      .catch(() => undefined)
    if (err instanceof HelmxError && err.code === 'ask_id_conflict') {
      // 同 ID 已存在（含已结算）：视为本次未获新决定，诚实返回未批准
      return { taskId: task.id, decision: 'superseded', askId }
    }
    throw err
  }
  if (signal?.aborted) {
    return { taskId: task.id, decision: 'cancelled', askId }
  }

  const decision: 'approved' | 'rejected' =
    settled.status === 'answered' && settled.answers['approve'] === 'true' ? 'approved' : 'rejected'
  const outcome = settled.status === 'answered' ? decision : settled.status
  await runtime.store.enqueueMutation((draft) => {
    const target = draft.tasks[task.id]
    if (target === undefined) return
    if (target.pendingPlanAskId === askId) delete target.pendingPlanAskId
    if (settled.status === 'answered') {
      target.planApproval = {
        decision,
        askedAt,
        decidedAt: Date.now(),
        askId,
      }
    }
    target.updatedAt = Date.now()
  })
  return { taskId: task.id, decision: outcome, askId }
}

/**
 * 查询 builtin:workflow 在该会话名下是否有 running run（无静态依赖，运行时按需调用）。
 * - 返回 false：确定无在途（含 workflow 停用/未注册——无后台 run 能力即无在途）；
 * - 返回 'unknown'：查询故障（网络/内部错误），调用方保守处理。
 */
export async function workflowHasRunningRuns(
  ctx: HelmxPluginContext,
  conversationId: number,
): Promise<boolean | 'unknown'> {
  try {
    const res = (await ctx.host.invokeAction('builtin:workflow', 'runs', { conversationId })) as {
      runs?: Array<{ status?: unknown }>
    }
    if (res === null || typeof res !== 'object' || !Array.isArray(res.runs)) return 'unknown'
    return res.runs.some((r) => r !== null && typeof r === 'object' && (r as { status?: unknown }).status === 'running')
  } catch (err) {
    if (err instanceof HelmxError && (err.code === 'plugin_disabled' || err.code === 'not_found' || err.code === 'unknown_action')) {
      return false
    }
    return 'unknown'
  }
}

/** 验收在途守卫（与停滞判定同口径）：根会话或整棵后代子树 working/blocked、Workflow
 * run 在途、或在途查询故障（unknown）均拒绝——done 是不可逆终转且触发下游自动接棒，
 * 查询故障时的保守方向是拒绝（宁可不结单也不误结）。 */
async function assertApprovalQuiescent(
  ctx: HelmxPluginContext,
  runtime: TasksRuntime,
  task: TaskRecord,
): Promise<void> {
  const conv =
    task.conversationId !== undefined ? runtime.readConversationOrUndefined(task.conversationId) : undefined
  const convBusy = conv !== undefined && (conv.status === 'working' || conv.status === 'blocked')
  const subtreeBusy =
    !convBusy && task.conversationId !== undefined
      ? subtreeHasWorkingOrBlocked(task.conversationId, ctx.host.listConversations())
      : false
  let workflowBusy: boolean | 'unknown' = false
  if (task.conversationId !== undefined) {
    workflowBusy = await workflowHasRunningRuns(ctx, task.conversationId)
  }
  if (convBusy || subtreeBusy || workflowBusy !== false) {
    throw new HelmxError(
      'task_still_running',
      `任务 ${task.id} 的执行仍在途（${
        convBusy
          ? `会话状态 ${conv!.status}`
          : subtreeBusy
            ? '后代子会话仍在运行'
            : workflowBusy === 'unknown'
              ? 'Workflow 在途查询故障（保守拒绝）'
              : 'Workflow run running'
      }），验收前先等待其完成或人工中止会话（helmx abort / 会话界面中止）后再操作`,
      409,
      {
        pluginId: TASKS_PLUGIN_ID,
        taskId: task.id,
        conversationStatus: conv?.status,
        subtreeBusy,
        workflowBusy,
      },
    )
  }
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
    parsed.title = sanitizeText(ctx, parsed.title)
    parsed.brief = sanitizeText(ctx, parsed.brief)
    if (parsed.project !== undefined) parsed.project = sanitizeText(ctx, parsed.project)
    return runtime.track('task:create', async () => {
      const decision = await runtime.store.enqueueMutation(async (draft) => {
        if (parsed.createKey !== undefined) {
          const existing = Object.values(draft.tasks).find((t) => t.createKey === parsed.createKey)
          if (existing !== undefined) {
            // 幂等重放：返回既有任务当前事实，绝不重新 launch（首次调用自会完成两阶段启动）
            return {
              taskId: existing.id,
              launch: false as const,
              blockedBy: [],
              idempotentReplay: true as const,
            }
          }
        }
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
          // 幂等键随记录落盘（含被阻塞 / 不自动启动 / 并发占满等所有不立即启动路径——
          // 晚于提前 return 赋值会让这些路径的重复 create 静默双开）。
          ...(parsed.createKey !== undefined ? { createKey: parsed.createKey } : {}),
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
      if (decision.idempotentReplay === true) {
        const task = runtime.store.get(decision.taskId)
        if (task === undefined) {
          throw new HelmxError('not_found', `任务 '${decision.taskId}' 在幂等重放时消失（并发删除？）`, 404, {
            pluginId: TASKS_PLUGIN_ID,
          })
        }
        return {
          task,
          started: task.column === 'in_progress' && task.conversationId !== undefined,
          ...(task.conversationId !== undefined ? { conversationId: task.conversationId } : {}),
          blockedBy: [],
        }
      }
      if (!decision.launch) {
        const task = runtime.store.get(decision.taskId)
        if (task === undefined) {
          throw new HelmxError('not_found', `任务 '${decision.taskId}' 在创建后消失（并发删除？）`, 404, {
            pluginId: TASKS_PLUGIN_ID,
          })
        }
        return { task, started: false, blockedBy: decision.blockedBy, notStartedReason: decision.notStartedReason }
      }
      const conversationId = await launchTaskExecution(ctx, runtime, decision.taskId)
      const task = runtime.store.get(decision.taskId)
      if (task === undefined) {
        throw new HelmxError('not_found', `任务 '${decision.taskId}' 在启动后被并发删除`, 404, {
          pluginId: TASKS_PLUGIN_ID,
          taskId: decision.taskId,
          conversationId,
        })
      }
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
    if (input.title !== undefined) input.title = sanitizeText(ctx, input.title)
    if (input.brief !== undefined) input.brief = sanitizeText(ctx, input.brief)
    if (input.project !== undefined && input.project !== null) input.project = sanitizeText(ctx, input.project)
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
          if (!isAssignableTaskProfile(profile)) {
            throw new HelmxError(
              'validation_error',
              `执行角色 Profile '${profileId}' 不可被指派（humanSelectable 为 false 或绑定了外部 runtime，生命周期归其宿主插件管理）`,
              400,
              { pluginId: TASKS_PLUGIN_ID, profileId },
            )
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
      const task = runtime.store.get(decision.taskId)
      if (task === undefined) {
        throw new HelmxError('not_found', `任务 '${decision.taskId}' 在启动后被并发删除`, 404, {
          pluginId: TASKS_PLUGIN_ID,
          taskId: decision.taskId,
          conversationId,
        })
      }
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
      merged?: boolean
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
    if (input.verification !== undefined) input.verification = sanitizeText(ctx, input.verification)
    if (input.branch !== undefined) input.branch = sanitizeText(ctx, input.branch)
    if (input.worktreePath !== undefined) input.worktreePath = sanitizeText(ctx, input.worktreePath)
    const summary = sanitizeText(ctx, input.summary)
    if (input.merged !== undefined && typeof input.merged !== 'boolean') {
      throw new HelmxError('validation_error', 'merged 必须是布尔值（合并完成的显式声明）', 400, {})
    }
    return runtime.track('task:submit', async () => {
      const submitted = await runtime.store.enqueueMutation((draft) => {
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
        // planFirst 门禁：未经用户明确批准方案的交付一律拒绝（task_request_plan_approval -> createAsk 真实审批）
        if (task.planFirst === true && task.planApproval?.decision !== 'approved') {
          throw new HelmxError(
            'task_plan_not_approved',
            `任务 ${task.id} 开启了 planFirst：动工前必须先调用 task_request_plan_approval 获得用户的明确方案批准（当前${
              task.planApproval === undefined ? '尚未发起审批' : `上次审批结果为 ${task.planApproval.decision}`
            }）`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id },
          )
        }
        const now = Date.now()
        task.submission = {
          summary: summary.trim(),
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
        // merge_and_close 授权闭环：mergePending 任务提交仅认显式 merged: true 声明即一步结单
        // （用户已审过并显式授权，不要求第二次人工点击）；branch 与 verification 文本均不构成
        // 已合并的证据（普通交付 branch≠已合并、诚实汇报「合并失败」的验证描述不得自动结单），
        // 无声明的提交维持 in_review 且 mergePending 保留待人工复核。
        if (task.mergePending === true && input.merged === true) {
          return { task, autoFinalized: true as const }
        }
        task.column = 'in_review'
        delete task.silenceState
        task.updatedAt = now
        return { task, autoFinalized: false as const }
      })
      if (submitted.autoFinalized) {
        const finalized = await finalizeTaskDone(submitted.task.id)
        return { task: finalized.task }
      }
      // 进入 in_review 等待人工验收：发一条 info 通知（用户在任意会话聊天也能立刻看到交卷）；
      // mergePending 授权一步结单（autoFinalized）保持安静零噪音。通知失败仅记日志，绝不影响交卷。
      notifyReviewRequested(submitted.task)
      return { task: submitted.task }
    })
  }

  /** in_review 交卷通知（payload 契约对齐 protocol NotificationEvent / Web ToastOverlay）。 */
  const notifyReviewRequested = (task: TaskRecord): void => {
    try {
      // summary 为空 / 纯空白时只报标题，不留尾随冒号（正常路径 summary 恒非空，防御观感）。
      const summary = task.submission?.summary?.trim() ?? ''
      ctx.host.emitEvent('notification', {
        type: 'notification',
        level: 'info',
        title: ctx.host.redact(`任务 ${task.id} 已提交验收`),
        body: ctx.host.redact(summary !== '' ? `${task.title}：${summary}` : task.title),
        ...(task.conversationId !== undefined ? { conversationId: task.conversationId } : {}),
        // 标准「查看」按钮直达看板详情抽屉（验收动作所在地）；会话入口由抽屉内「打开会话」承接
        view: `screen:${TASKS_PLUGIN_ID}/board?task=${encodeURIComponent(task.id)}`,
      })
    } catch (err) {
      console.error(
        `[tasks] 任务 ${task.id} 交卷通知发送失败（不影响交卷结果）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 共享终转：done 核心事实先落盘 flush；衍生动作（会话换归档标签、下游依赖接棒）
   * 失败容忍上报、不回滚验收事实。approve(close_only) 与 merge_and_close 授权下的
   * 证据交付 submit 共用同一条链。
   */
  const finalizeTaskDone = async (taskId: string): Promise<{
    task: TaskRecord
    unblockedTaskIds: string[]
    autoStartedTaskIds: string[]
  }> => {
    const { task, conversationId, downstream } = await runtime.store.enqueueMutation((draft) => {
      const task = requireTaskInDraft(draft.tasks, taskId)
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
        runtime.reportError(`任务结单后下游任务 ${candidate.id} 自动接棒启动失败（任务保留待办可手动 start）`, err)
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
  }

  // ---------------- approve ----------------
  const approveTask = async (
    input: { taskId: string; mergeAction?: 'close_only' | 'merge_and_close'; note?: string; confirmStopped?: boolean },
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
    const note = input.note !== undefined ? sanitizeText(ctx, input.note) : undefined
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
          await ctx.host.submitInput(conversationId, buildMergeClosingPrompt(task, note), {
            origin: 'agent',
            whenBusy: 'followUp',
            requestId: `${TASKS_PLUGIN_ID}:merge:${task.id}:${task.submission?.submittedAt ?? task.reworkCount}`,
          })
          await swapConversationTag(ctx, runtime, conversationId, TASK_ACTIVE_TAG)
          return task
        })
        return { task, unblockedTaskIds: [], autoStartedTaskIds: [] }
      }

      // close_only：在途收紧——待验收且无在途放行；在途一律 409（先等待或人工中止）；
      // 进行中任务仅经明示 confirmStopped 且无在途放行（人工确认停止后的手动收尾动作）；
      // 已完成任务幂等返回当前事实（刷新延迟双击不报错，不重复触发下游接棒）。
      {
        const task = getTaskOrThrow(runtime, input.taskId)
        if (task.column === 'done') {
          return { task, unblockedTaskIds: [], autoStartedTaskIds: [] }
        }
        if (task.column !== 'in_review' && task.column !== 'in_progress') {
          throw new HelmxError(
            'task_invalid_column',
            `任务 ${task.id} 当前位于 ${task.column} 列，仅待验收（或确认中的进行中）任务可验收通过；已完成无需重复验收，待办卡请先 start`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id, column: task.column },
          )
        }
        await assertApprovalQuiescent(ctx, runtime, task)
        if (task.column === 'in_progress' && input.confirmStopped !== true) {
          throw new HelmxError(
            'task_invalid_column',
            `任务 ${task.id} 仍在进行中：请先让执行者 task_submit 交卷（或 rework 重派）；确需人工收尾请确认会话已停止后传 confirmStopped: true`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id, column: task.column },
          )
        }
      }
      // 复用共享终转（done 先落盘 flush，衍生容忍）
      return finalizeTaskDone(input.taskId)
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
    const feedback = sanitizeText(ctx, input.feedback).trim()
    if (feedback === '') {
      throw new HelmxError('validation_error', 'feedback 脱敏后为空（原文本仅含机密标记）', 400, {})
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
        task.lastReworkFeedback = feedback
        delete task.mergePending
        delete task.silenceState
        task.updatedAt = Date.now()

        if (!conversationMissing) {
          const conversationId = task.conversationId!
          // 投递统一用脱敏后的 feedback（与 lastReworkFeedback 落盘同源），绝不把原文串进会话历史
          await ctx.host.submitInput(conversationId, buildReworkDeliveryPrompt(task, feedback), {
            origin: 'agent',
            whenBusy: 'followUp',
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

      // recreate：状态已落盘（flush 后）重建会话，投递**单条合成任务书**（原 brief + 返工意见，
      // #20/#36：不做 kickoff + 意见两条投递）；requestId 按 reworkCount 幂等。
      await runtime.flushRecords()
      const conversationId = await launchTaskExecution(ctx, runtime, outcome.task.id, {
        prompt: buildReworkDeliveryPrompt(outcome.task, feedback, { recreated: true }),
        requestId: `${TASKS_PLUGIN_ID}:rework-recreate:${outcome.task.id}:${outcome.task.reworkCount}`,
        delivery: 'reject',
      })
      const task = runtime.store.get(outcome.task.id)
      if (task === undefined) {
        throw new HelmxError('not_found', `任务 '${outcome.task.id}' 在重建后消失（并发删除？）`, 404, {
          pluginId: TASKS_PLUGIN_ID,
          taskId: outcome.task.id,
          conversationId,
        })
      }
      return { task, conversationId, recreatedConversation: true }
    })
  }

  // ---------------- archive ----------------
  const archiveTask = async (
    input: { taskId: string },
    context: PluginActionContext,
  ): Promise<{ task: TaskRecord; alreadyArchived?: boolean }> => {
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
        if (task.archived === true) {
          return { task, alreadyArchived: true }
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
          if (task.conversationId === undefined) {
            // 启动占位态（两阶段窗口内）：回滚/绑定可能仍在途，拒绝删除防状态撕裂
            throw new HelmxError(
              'task_in_progress',
              `任务 ${task.id} 处于启动占位态（尚未绑定执行会话），不可删除（稍等启动完成或失败回滚后再试）`,
              409,
              { pluginId: TASKS_PLUGIN_ID, taskId: task.id, column: task.column },
            )
          }
          const conv = runtime.readConversationOrUndefined(task.conversationId)
          if (conv !== undefined && (conv.status === 'working' || conv.status === 'blocked')) {
            throw new HelmxError(
              'task_in_progress',
              `任务 ${task.id} 执行中（column=${task.column}，会话状态 ${conv.status}），不可删除`,
              409,
              { pluginId: TASKS_PLUGIN_ID, taskId: task.id, column: task.column },
            )
          }
          // conv === undefined：绑定会话已被删除——允许删除死卡（rework 错误文案指引的出口之一）
        }
        // 前置引用守卫：仍被其他未删除任务 dependsOn 引用时拒删（先解除引用或删除引用方）
        const referencedBy = Object.values(draft.tasks)
          .filter((other) => other.id !== task.id && other.dependsOn.includes(task.id))
          .map((other) => other.id)
        if (referencedBy.length > 0) {
          throw new HelmxError(
            'task_dependency_referenced',
            `任务 ${task.id} 仍被 ${referencedBy.join(', ')} 作为前置依赖引用，不可删除（先在引用方的 dependsOn 中移除 '${task.id}'，或先删除引用方任务）`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id, referencedBy },
          )
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
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 128, description: 'Optional idempotency key: a repeated create with the same key returns the already-created task (double-click safe)' },
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
        // 可清空字段显式接受 null（前端清空即置 null；handler 对 null / 空串同语义清除回默认链）
        project: { anyOf: [{ type: 'string', maxLength: 120 }, { type: 'null' }], description: 'Pass null or empty to clear' },
        assigneeProfileId: { type: 'string', maxLength: 64 },
        nodeId: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }], description: 'Pass null or empty to clear (pre-start only)' },
        cwd: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Pass null or empty to clear (pre-start only)' },
        model: { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }], description: 'Pass null or empty to clear' },
        thinkingLevel: { anyOf: [{ type: 'string', maxLength: 16 }, { type: 'null' }], description: 'Pass null or empty to clear' },
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
        merged: { type: 'boolean', description: 'Explicit declaration that the authorized merge is complete (one-step closure under merge_and_close)' },
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
        confirmStopped: { type: 'boolean', description: 'Explicit manual close of an in_progress task after confirming its conversation has stopped' },
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
    id: 'request_plan_approval',
    description: 'Request explicit user approval of the plan for the planFirst task bound to a conversation (real AskDoc confirm; blocks until answered).',
    exposeAsTool: false,
    scope: { tags: [TASK_ACTIVE_TAG] },
    cli: { command: ['tasks', 'request-plan-approval'], description: 'Request plan approval for the bound planFirst task' },
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', minLength: 1, description: 'Concise implementation plan for the user to approve' },
        conversationId: { type: 'integer', minimum: 1, description: 'Task execution conversation to ask in (defaults to the calling conversation)' },
      },
      required: ['plan'],
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: async (input: { plan: string; conversationId?: number }, context) => {
      const conversationId = input.conversationId ?? context.conversationId
      if (conversationId === undefined) {
        throw new HelmxError('validation_error', 'conversationId 必填（会话外人工调用无法定位绑定任务）', 400, {})
      }
      return requestPlanApproval(ctx, runtime, input, conversationId, context.signal)
    },
  })

  ctx.action({
    id: 'resume_kickoff',
    description:
      'Explicitly re-deliver the kickoff briefing of a task marked kickoffUndelivered after a restart (user-driven continuation; never automatic). Idempotent via the original kickoff requestId.',
    exposeAsTool: false,
    cli: { command: ['tasks', 'resume-kickoff'], description: 'Re-deliver the undelivered kickoff of a task', positional: [{ field: 'taskId', required: true }] },
    inputSchema: {
      type: 'object',
      properties: { taskId: taskIdSchema },
      required: ['taskId'],
      additionalProperties: false,
    } as never,
    outputSchema: { type: 'object' } as never,
    handler: async (input: { taskId: string }, context) => {
      assertPlannerAuthority(runtime, context, 'resume_kickoff')
      return runtime.track('task:resume-kickoff', async () => {
        const task = getTaskOrThrow(runtime, input.taskId)
        if (task.kickoffUndelivered !== true) {
          throw new HelmxError(
            'validation_error',
            `任务 ${task.id} 不在「开工未送达」状态（无需重投；常规继续请在执行会话内直接发言）`,
            400,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id },
          )
        }
        if (task.conversationId === undefined || conversationLive(runtime, task.conversationId) === null) {
          throw new HelmxError(
            'task_conversation_missing',
            `任务 ${task.id} 无有效执行会话，无法重投任务书（可 rework recreateConversation 重建）`,
            409,
            { pluginId: TASKS_PLUGIN_ID, taskId: task.id },
          )
        }
        const conversationId = task.conversationId
        await ctx.host.submitInput(conversationId, buildTaskKickoffPrompt(task), {
          origin: 'agent',
          whenBusy: 'followUp',
          requestId: `${TASKS_PLUGIN_ID}:kickoff:${task.id}`,
        })
        await runtime.store.enqueueMutation((draft) => {
          const target = draft.tasks[task.id]
          if (target === undefined) return
          delete target.kickoffUndelivered
          delete target.kickoffPending
          target.updatedAt = Date.now()
        })
        return { task: runtime.store.get(task.id)!, conversationId }
      })
    },
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
    promptSnippet: 'Put work on the task board (`task_create`) only when the user explicitly asks to delegate or track it as a board card; keep ordinary requests inline.',
    promptGuidelines: [
      'Call task_create only when the user explicitly asks to put work on the board / delegate it (e.g. "create a task for this", "track this on the board"), or confirms a breakdown you proposed; never auto-delegate ordinary requests you can simply do inline.',
      'A bare go-ahead continues the already-agreed intent in the current conversation; do not reinterpret it as delegation to the board.',
      'Confirm multi-card breakdowns (with dependsOn wiring) with the user before creating them.',
      'Write a self-contained brief: background, scope, acceptance criteria, and target directory; never rely on unstated here-and-now context.',
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
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['title', 'brief'],
      additionalProperties: false,
    } as never,
    structuredOutputSchema: { type: 'object' } as never,
    replay: 'unsafe',
    execute: async (input: never, toolContext: PluginToolContext) => {
      const res = await createTask(input as CreateTaskInput, toolIo(toolContext))
      const reason = res.notStartedReason ?? 'already created'
      const tail =
        res.started
          ? `started on conversation #${res.conversationId}`
          : `kept in backlog (${reason}${res.blockedBy.length > 0 ? `: blocked by ${res.blockedBy.join(', ')}` : ''})`
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
        merged: { type: 'boolean' },
        worktreePath: { type: 'string' },
        changedFiles: { type: 'array', items: { type: 'string' } },
        artifactIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary'],
      additionalProperties: false,
    } as never,
    structuredOutputSchema: { type: 'object' } as never,
    scope: { tags: [TASK_ACTIVE_TAG] },
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
    name: 'task_request_plan_approval',
    description:
      'Request explicit user approval of your implementation plan for the planFirst task bound to this conversation. Blocks until the user answers a real Ask card (confirm); only after an approved result can task_submit hand in the work. Use exactly once per plan revision on planFirst tasks.',
    promptSnippet: 'On a planFirst task, call `task_request_plan_approval` with your concise plan and wait for the explicit user decision before writing code.',
    promptGuidelines: [
      'Call task_request_plan_approval only inside the planFirst execution conversation this tool is bound to; provide a concise, checkable plan.',
      'If the user rejects the plan, revise it and ask again (or surface the disagreement); never start coding after a rejection.',
      'task_submit is refused until the plan approval decision is approved.',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', minLength: 1, description: 'Concise implementation plan for the user to approve' },
      },
      required: ['plan'],
      additionalProperties: false,
    } as never,
    structuredOutputSchema: { type: 'object' } as never,
    scope: { tags: [TASK_ACTIVE_TAG] },
    replay: 'unsafe',
    execute: async (input: never, toolContext: PluginToolContext) => {
      const req = input as { plan: string }
      if (typeof req.plan !== 'string' || req.plan.trim() === '') {
        throw new HelmxError('validation_error', 'plan 必须是非空方案摘要', 400, {})
      }
      const res = await requestPlanApproval(ctx, runtime, req, toolContext.conversationId, toolContext.signal)
      const output =
        res.decision === 'approved'
          ? `Plan for task ${res.taskId} approved by the user; you may start implementing.`
          : res.decision === 'rejected'
            ? `Plan for task ${res.taskId} was rejected by the user; revise it and request approval again.`
            : `Plan approval ask for task ${res.taskId} ended without a decision (${res.decision}); no approval was recorded.`
      return { output, structuredOutput: res }
    },
  })

  ctx.tool({
    name: 'task_approve',
    description:
      'Accept a reviewed task (planner/human action): close_only marks it done and auto-unblocks downstream dependsOn tasks; merge_and_close asks the assignee to merge its branch and clean up first.',
    promptSnippet: 'Close the review loop with `task_approve` (close_only or merge_and_close) or `task_rework` with concrete feedback — only after explicit user acceptance.',
    promptGuidelines: [
      'Call task_approve only after the user has explicitly accepted the submission; the tool being callable never implies default authorization to approve on your own.',
      'Approve with close_only when the user accepts; the task moves to done and blocked downstream tasks auto-start.',
      'Use merge_and_close when the user accepts AND authorizes merging the assignee branch now; the assignee merges, cleans up, and its evidence-bearing task_submit completes the task directly.',
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
