/**
 * builtin:tasks 任务存储运行时：
 * - 单一真源：私有持久 doc `records`（{ nextSeq, tasks }），全部写经串行 mutation 队列；
 * - 公开投影：瞬态内存 doc `board`（public + non-durable），每次真源变更同步刷新，
 *   仅投射未归档任务 + 最近 N 条归档 / 已完成历史，防公开 doc 超 2 MiB 写放大；
 * - 徽标聚合：投影把主会话实时事实（可选 `listConversations` 事实源）折进 attention /
 *   review / running / tone / summary；会话事件侧走 `refreshBoardIfBadgeChanged` 脏检查，
 *   徽标元组不变即跳过写入，高频流式事件零 SSE 写放大；
 * - 任务编号单调分配 `T-1`, `T-2`, ...。
 */
import type { ConversationSummary, PluginDocHandle } from '@helmx/protocol'
import {
  assertTaskStoreDoc,
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
  /** 实时会话事实源：每次写档与投影刷新都把真实主会话状态（缺失 / error / blocked / 待答 Ask）折进 board 徽标；缺省仅按记录内信号判定。 */
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
  }
}
