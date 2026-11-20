/**
 * builtin:tasks 生命周期 Hook（纯事件驱动，零定时器，零自动输入投递）：
 * - before_turn：规划/执行工具动态隔离 + 任务执行会话注入 100% 字节恒定的
 *   <active_task> 系统段落（仅含任务生命周期不变事实）；
 * - conversation.deleted：诚实标记 conversationMissing（不捏造、不自动删任务）。
 */
import type { ConversationSummary, HelmxPluginContext } from '@helmx/protocol'
import { ACTIVE_TASK_SECTION_ID, type TaskRecord } from './contracts.js'
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
  // 非任务会话：task_submit 不可见（ctx.tool scope tags ['task'] 在注册处硬拦，此处过滤兜底双保险）
  hide('task_submit')
  const isSubOrAutomated =
    conversation.parentConversationId !== undefined ||
    (conversation.ownedBy !== undefined && conversation.ownedBy !== 'human')
  if (isSubOrAutomated) {
    for (const name of PLANNER_TASK_TOOL_NAMES) hide(name)
  }
  return next
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
