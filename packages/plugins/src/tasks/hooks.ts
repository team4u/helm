/**
 * builtin:tasks 生命周期 Hook（纯事件驱动，零定时器，零自动输入投递）：
 * - before_turn：规划/执行工具动态隔离 + 任务执行会话注入 100% 字节恒定的
 *   <active_task> 系统段落（仅含任务生命周期不变事实）；
 * - turn_settled：failed 记录 lastError；completed 且完全静止（无待答、子树无
 *   working/blocked、无 Workflow 在途 run）未交卷时诚实标记 stalledAt——
 *   **绝不向 human-owned 会话投递任何自动输入**（AGENTS Watchdog 红线），
 *   「停下未交卷」仅呈现于看板，由用户显式打开会话继续或 rework；
 * - conversation.deleted：诚实标记 conversationMissing（不捏造、不自动删任务）。
 */
import { HelmxError, type ConversationSummary, type HelmxPluginContext } from '@helmx/protocol'
import { ACTIVE_TASK_SECTION_ID, TASKS_PLUGIN_ID, type TaskRecord } from './contracts.js'
import { findActiveTaskByConversation, type TasksRuntime } from './actions.js'
import { activeTaskSection } from './prompts.js'

/** 规划者专属模型工具名（任务执行会话 / 子会话 / 自动化会话隐藏）。 */
export const PLANNER_TASK_TOOL_NAMES = ['task_create', 'task_approve', 'task_rework', 'task_start'] as const

/** before_turn 工具过滤纯函数：返回过滤后工具列表（无变化返回 undefined 便于单测与短路）。 */
export function filterTaskToolsForTurn<T extends { name: string }>(
  tools: readonly T[],
  conversation: Pick<ConversationSummary, 'id' | 'tags' | 'parentConversationId' | 'ownedBy'>,
  boundTask: TaskRecord | undefined,
): T[] | undefined {
  let next: T[] | undefined
  const hide = (name: string): void => {
    const source = next ?? tools
    if (!source.some((t) => t.name === name)) return
    next = source.filter((t) => t.name !== name)
  }

  if (boundTask !== undefined) {
    // 任务执行会话：隐藏规划工具（防套娃建卡 / 自审自批），保留 task_submit 与只读 task_inspect/task_list
    for (const name of PLANNER_TASK_TOOL_NAMES) hide(name)
    return next
  }
  // 非任务会话：task_submit 不可见（scope 已硬拦，此处兜底）
  hide('task_submit')
  const isSubOrAutomated =
    conversation.parentConversationId !== undefined ||
    (conversation.ownedBy !== undefined && conversation.ownedBy !== 'human')
  if (isSubOrAutomated) {
    for (const name of PLANNER_TASK_TOOL_NAMES) hide(name)
  }
  return next
}

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

/**
 * 静止判定纯函数：任务仍在进行且本回合正常结束、无待答 Ask、子树与 Workflow
 * 均无在途时返回 true（调用方据此诚实标记 stalledAt；不做任何投递）。
 * `workflowBusy: 'unknown'`（在途查询失败且非停用类错误）时保守返回 false，宁漏报不误报。
 */
export function shouldMarkStalled(input: {
  task: TaskRecord
  conversation: Pick<ConversationSummary, 'id' | 'status' | 'pendingAskCount'>
  subtreeBusy: boolean
  workflowBusy: boolean | 'unknown'
}): boolean {
  if (input.task.column !== 'in_progress' || input.task.conversationId !== input.conversation.id) return false
  if (input.task.silenceState?.stalledAt !== undefined) return false
  if (input.conversation.pendingAskCount > 0) return false
  if (input.subtreeBusy) return false
  if (input.workflowBusy !== false) return false
  return true
}

/**
 * 查询 builtin:workflow 在该会话名下是否有 running run（无静态依赖，运行时按需调用）。
 * - 返回 false：确定无在途（含 workflow 停用/未注册——无后台 run 能力即无在途）；
 * - 返回 'unknown'：查询故障（网络/内部错误），调用方保守跳过标记。
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

export function registerTasksHooks(ctx: HelmxPluginContext, runtime: TasksRuntime): void {
  const { isActive } = runtime

  // ------------------------------------------------------------------
  // before_turn：工具隔离 + 恒定 <active_task> 段落注入
  // ------------------------------------------------------------------
  ctx.hook.onBeforeTurn(async (turn) => {
    if (!isActive()) return
    const conv = turn.conversation
    const boundTask = findActiveTaskByConversation(runtime, conv.id)

    const nextTools = filterTaskToolsForTurn(turn.tools, conv, boundTask)

    let sections: typeof turn.sections | undefined
    if (boundTask !== undefined) {
      sections = [...turn.sections, { id: ACTIVE_TASK_SECTION_ID, text: activeTaskSection(boundTask) }]
    }

    if (nextTools === undefined && sections === undefined) return
    return {
      action: 'transform',
      value: {
        ...turn,
        ...(nextTools !== undefined ? { tools: nextTools } : {}),
        ...(sections !== undefined ? { sections } : {}),
      },
    }
  })

  // ------------------------------------------------------------------
  // turn_settled：纯事件驱动的诚实标记（零定时器、零投递、零强杀）
  // ------------------------------------------------------------------
  ctx.hook.onTurnSettled(async (payload) => {
    if (!isActive()) return
    const conversation = payload.conversation
    const boundTask = findActiveTaskByConversation(runtime, conversation.id)
    if (boundTask === undefined) return

    if (payload.outcome === 'failed') {
      await runtime.store.enqueueMutation((draft) => {
        const task = draft.tasks[boundTask.id]
        if (task === undefined || task.conversationId !== conversation.id || task.column !== 'in_progress') return
        task.silenceState = {
          ...(task.silenceState ?? {}),
          lastError: payload.error ?? 'turn_failed',
        }
        task.updatedAt = Date.now()
      })
      return
    }
    if (payload.outcome !== 'completed') return

    const fresh = runtime.readConversationOrUndefined(conversation.id)
    if (fresh === undefined) return
    const subtreeBusy = subtreeHasWorkingOrBlocked(conversation.id, ctx.host.listConversations())
    const workflowBusy = await workflowHasRunningRuns(ctx, conversation.id)
    if (
      !shouldMarkStalled({
        task: runtime.store.get(boundTask.id) ?? boundTask,
        conversation: fresh,
        subtreeBusy,
        workflowBusy,
      })
    ) {
      return
    }
    await runtime.store.enqueueMutation((draft) => {
      const task = draft.tasks[boundTask.id]
      if (task === undefined || task.conversationId !== conversation.id || task.column !== 'in_progress') return
      if (task.silenceState?.stalledAt !== undefined) return
      task.silenceState = {
        ...(task.silenceState ?? {}),
        stalledAt: Date.now(),
      }
      task.updatedAt = Date.now()
    })
  })
}

// ------------------------------------------------------------------
// conversation.deleted：诚实标记会话缺失（由插件入口 service.start 订阅挂载）
// ------------------------------------------------------------------
export async function onTasksConversationDeleted(runtime: TasksRuntime, conversationId: number): Promise<void> {
  if (!runtime.isActive()) return
  const store = runtime.store.read()
  const affected = Object.values(store.tasks).filter((t) => t.conversationId === conversationId)
  if (affected.length === 0) return
  await runtime.store.enqueueMutation((draft) => {
    for (const task of Object.values(draft.tasks)) {
      if (task.conversationId !== conversationId) continue
      task.conversationMissing = true
      task.updatedAt = Date.now()
    }
  })
}
