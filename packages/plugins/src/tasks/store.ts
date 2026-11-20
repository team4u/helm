/**
 * builtin:tasks 任务存储运行时：
 * - 单一真源：私有持久 doc `records`（{ nextSeq, tasks }），全部写经串行 mutation 队列；
 * - 公开投影：瞬态内存 doc `board`（public + non-durable），每次真源变更同步刷新，
 *   仅投射未归档任务 + 最近 N 条归档 / 已完成历史，防公开 doc 超 2 MiB 写放大；
 * - 徽标聚合：投影把实时会话事实（可选 `listConversations` 事实源）折进 attention /
 *   review / running / tone / summary；会话事件侧走 `refreshBoardIfBadgeChanged` 脏检查，
 *   徽标元组不变即跳过写入，高频流式事件零 SSE 写放大；
 * - 任务编号单调分配 `T-1`, `T-2`, ...；
 * - 依赖校验：无自依赖、引用存在、全图无环（DFS）。
 */
import { HelmxError, type ConversationSummary, type PluginDocHandle } from '@helmx/protocol'
import {
  assertTaskStoreDoc,
  detectDependencyCycle,
  projectBoardDoc,
  taskBoardBadgeKey,
  type TaskBoardDoc,
  type TaskColumn,
  type TaskRecord,
  type TaskStoreDoc,
} from './contracts.js'

export interface TaskListFilter {
  column?: TaskColumn
  project?: string
  assigneeProfileId?: string
  nodeId?: string
  includeArchived?: boolean
}

export interface TasksStoreOptions {
  /** 实时会话事实源：每次写档与投影刷新都把真实会话状态（缺失 / error / blocked / 待答 Ask）折进 board 徽标；缺省仅按记录内信号判定。 */
  listConversations?: () => ConversationSummary[]
  onMutationStart?: (label: string) => void
  onMutationEnd?: (label: string) => void
}

export interface TasksStoreRuntime {
  /** 快照读（含归档；调用方自行过滤）。 */
  read(): TaskStoreDoc
  get(id: string): TaskRecord | undefined
  list(filter?: TaskListFilter): TaskRecord[]
  /** 串行读-改-写：在队列内对真源 draft 变更并同步刷新 board 投影。 */
  enqueueMutation<T>(fn: (draft: TaskStoreDoc) => Promise<T> | T): Promise<T>
  /** 立即按当前真源刷新公开投影（记录侧变更用）。 */
  refreshBoard(): void
  /** 会话事件侧徽标脏检查：仅当徽标元组真实变化才写 board（高频流式事件零 SSE 写放大）。 */
  refreshBoardIfBadgeChanged(): void
  /** 当前 in_progress 任务数（maxConcurrentTasks 计数口径）。 */
  countInProgress(): number
}

export function createTasksStore(
  records: PluginDocHandle<TaskStoreDoc>,
  board: PluginDocHandle<TaskBoardDoc>,
  options?: TasksStoreOptions,
): TasksStoreRuntime {
  const read = (): TaskStoreDoc => assertTaskStoreDoc(records.get())
  const conversationsSnapshot = (): ReadonlyArray<ConversationSummary> | undefined =>
    options?.listConversations?.()

  const write = (next: TaskStoreDoc): void => {
    assertTaskStoreDoc(next)
    records.set(next)
    board.set(projectBoardDoc(next, conversationsSnapshot()))
  }

  let chain: Promise<unknown> = Promise.resolve()

  const enqueueMutation = <T>(fn: (draft: TaskStoreDoc) => Promise<T> | T): Promise<T> => {
    const label = `mutation:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    options?.onMutationStart?.(label)
    const task = chain.then(async () => {
      const draft = read()
      const result = await fn(draft)
      write(draft)
      return result
    })
    chain = task.catch(() => undefined)
    task.catch(() => undefined).finally(() => options?.onMutationEnd?.(label))
    return task
  }

  const get = (id: string): TaskRecord | undefined => read().tasks[id]

  const list = (filter: TaskListFilter = {}): TaskRecord[] => {
    const store = read()
    return Object.values(store.tasks)
      .filter((task) => {
        if (filter.includeArchived !== true && task.archived === true) return false
        if (filter.column !== undefined && task.column !== filter.column) return false
        if (filter.project !== undefined && task.project !== filter.project) return false
        if (filter.assigneeProfileId !== undefined && task.assigneeProfileId !== filter.assigneeProfileId) return false
        if (filter.nodeId !== undefined && task.nodeId !== filter.nodeId) return false
        return true
      })
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
  }

  return {
    read,
    get,
    list,
    enqueueMutation,
    refreshBoard: () => {
      board.set(projectBoardDoc(read(), conversationsSnapshot()))
    },
    refreshBoardIfBadgeChanged: () => {
      const next = projectBoardDoc(read(), conversationsSnapshot())
      if (taskBoardBadgeKey(board.get()) === taskBoardBadgeKey(next)) return
      board.set(next)
    },
    countInProgress: () => Object.values(read().tasks).filter((t) => t.column === 'in_progress').length,
  }
}

/** 依赖图整链校验：自依赖、引用不存在、成环均显式抛错（写入真源前调用）。 */
export function assertDependenciesValid(
  taskId: string,
  dependsOn: string[],
  tasks: Record<string, TaskRecord>,
): void {
  const seen = new Set<string>()
  for (const dep of dependsOn) {
    if (dep === taskId) {
      throw new HelmxError('validation_error', `任务 ${taskId} 不得依赖自身（dependsOn 含 '${dep}'）`, 400, {
        taskId,
        dependsOn,
      })
    }
    if (seen.has(dep)) continue
    seen.add(dep)
    if (!(dep in tasks)) {
      throw new HelmxError(
        'validation_error',
        `任务 ${taskId} 依赖了不存在的任务 '${dep}'（先创建前置任务或修正 dependsOn）`,
        400,
        { taskId, missingDependency: dep },
      )
    }
  }
  const cycle = detectDependencyCycle({ ...tasks, [taskId]: { ...tasks[taskId], dependsOn } as TaskRecord })
  if (cycle !== null) {
    throw new HelmxError('validation_error', `dependsOn 构成依赖环：${cycle.join(' -> ')}（拒绝写入）`, 400, { cycle })
  }
}

/**
 * 重启恢复（开工未送达，#59-2 红线口径）：kickoffPending 持久标记的残留 = 投递未完成的
 * 事实源。仅落 kickoffUndelivered 呈现态供看板显示「开工未送达，点继续」——绝不向
 * human-owned 会话自动提交；显式继续由 resume_kickoff 动作承担。非进行中或无绑定的
 * 残留标记只清除不标记。返回受影响任务 ID 供诊断上报。
 */
export function recoverKickoffMarkers(draft: TaskStoreDoc): string[] {
  const undelivered: string[] = []
  for (const task of Object.values(draft.tasks)) {
    if (task.kickoffPending !== true) continue
    delete task.kickoffPending
    if (task.column === 'in_progress' && task.conversationId !== undefined) {
      task.kickoffUndelivered = true
      task.updatedAt = Date.now()
      undelivered.push(task.id)
    }
  }
  return undelivered
}

/**
 * 重启恢复：启动中断任务回滚（in_progress 但执行会话尚未绑定——服务在两阶段启动的
 * 占位落盘与绑定之间重启）。诚实回滚 backlog 并记录原因，绝不假装在跑；返回受影响
 * 任务 ID 供诊断上报。
 */
export function recoverInterruptedStartups(draft: TaskStoreDoc): string[] {
  const interrupted: string[] = []
  for (const task of Object.values(draft.tasks)) {
    if (task.column !== 'in_progress' || task.conversationId !== undefined) continue
    task.column = 'backlog'
    delete task.startedAt
    task.silenceState = {
      ...(task.silenceState ?? {}),
      lastError: 'startup interrupted: the service restarted before the execution conversation was bound',
    }
    task.updatedAt = Date.now()
    interrupted.push(task.id)
  }
  return interrupted
}
