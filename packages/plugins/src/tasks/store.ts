/**
 * builtin:tasks 任务存储运行时：
 * - 单一真源：私有持久 doc `records`（{ nextSeq, tasks }），全部写经串行 mutation 队列；
 * - 公开投影：瞬态内存 doc `board`（public + non-durable），每次真源变更同步刷新，
 *   仅投射未归档任务 + 最近 N 条归档 / 已完成历史，防公开 doc 超 2 MiB 写放大；
 * - 任务编号单调分配 `T-1`, `T-2`, ...；
 * - 依赖校验：无自依赖、引用存在、全图无环（DFS）。
 */
import { HelmxError, type PluginDocHandle } from '@helmx/protocol'
import {
  assertTaskStoreDoc,
  detectDependencyCycle,
  projectBoardDoc,
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

export interface TasksStoreRuntime {
  /** 快照读（含归档；调用方自行过滤）。 */
  read(): TaskStoreDoc
  get(id: string): TaskRecord | undefined
  list(filter?: TaskListFilter): TaskRecord[]
  /** 串行读-改-写：在队列内对真源 draft 变更并同步刷新 board 投影。 */
  enqueueMutation<T>(fn: (draft: TaskStoreDoc) => Promise<T> | T): Promise<T>
  /** 立即按当前真源刷新公开投影（事件侧标记类变更用）。 */
  refreshBoard(): void
  /** 当前 in_progress 任务数（maxConcurrentTasks 计数口径）。 */
  countInProgress(): number
}

export function createTasksStore(
  records: PluginDocHandle<TaskStoreDoc>,
  board: PluginDocHandle<TaskBoardDoc>,
  hooks?: { onMutationStart?: (label: string) => void; onMutationEnd?: (label: string) => void },
): TasksStoreRuntime {
  const read = (): TaskStoreDoc => assertTaskStoreDoc(records.get())

  const write = (next: TaskStoreDoc): void => {
    assertTaskStoreDoc(next)
    records.set(next)
    board.set(projectBoardDoc(next))
  }

  let chain: Promise<unknown> = Promise.resolve()

  const enqueueMutation = <T>(fn: (draft: TaskStoreDoc) => Promise<T> | T): Promise<T> => {
    const label = `mutation:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    hooks?.onMutationStart?.(label)
    const task = chain.then(async () => {
      const draft = read()
      const result = await fn(draft)
      write(draft)
      return result
    })
    chain = task.catch(() => undefined)
    task.catch(() => undefined).finally(() => hooks?.onMutationEnd?.(label))
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
      board.set(projectBoardDoc(read()))
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
