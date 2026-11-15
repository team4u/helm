/**
 * cancellation-tracker.ts — 取消窗口与子树边界取消（自 WorkflowService 拆出的
 * 内部模块）。
 *
 * 两块机制：
 * - 引用计数取消窗口（cancellingCounts）：会话子树取消期间，窗口内的会话拒绝
 *   新 run/spawn（服务在注册点断言）；并发取消重叠时最后一个释放才解除窗口；
 * - 边界取消（cancelBoundary）：先落取消标记，再反复扫描 active 中命中边界的
 *   run 逐个取消，直到无新增，最后等待全部 settle；同 key 重入共享同一次
 *   取消，防回调相互等待死锁。子树归属沿真实会话父链判定（父链读取由服务
 *   注入；缺失即链断，不虚构可达）。
 */

import { HelmError } from '@helm/protocol'
import type { ActiveRun } from './active-run.js'

export interface CancellationTrackerOptions {
  /** 在途 run 的实时视图（WorkflowService 持有；边界扫描每轮重拍快照）。 */
  active: Map<string, ActiveRun>
  /** 真实父会话（读取异常由 tracker 吸收为链断：不可达，不虚构）。 */
  parentConversationOf(id: number): number | undefined
}

/** 边界命中判定：run 及其发起会话是否落在取消边界内。 */
export type BoundaryMatch = (
  run: ActiveRun,
  isWithin: (candidate: number, seed: number) => boolean,
) => boolean

export class CancellationTracker {
  /** 取消窗口中的会话集合（引用计数：并发取消重叠时最后一个释放才解除）：窗口内拒绝该会话新 run/spawn（防取消期间又派新任务）。 */
  private readonly cancellingCounts = new Map<number, number>()
  /** 进行中的边界取消（key -> promise）：同边界重入共享同一次取消，防回调相互等待死锁。 */
  private readonly boundaryCancels = new Map<string, Promise<void>>()
  private readonly active: Map<string, ActiveRun>
  private readonly parentConversationOf: (id: number) => number | undefined

  constructor(options: CancellationTrackerOptions) {
    this.active = options.active
    this.parentConversationOf = options.parentConversationOf
  }

  /** 会话是否处于级联取消窗口。 */
  isCancelling(conversationId: number): boolean {
    return this.cancellingCounts.has(conversationId)
  }

  /** 取消窗口断言：边界内会话拒绝新 run（HelmError aborted，不静默排队）。 */
  assertNotCancelling(conversationId: number): void {
    if (this.cancellingCounts.has(conversationId)) {
      throw new HelmError(
        'aborted',
        `会话 ${conversationId} 所在任务树正在取消，拒绝启动新运行`,
        409,
        { conversationId },
      )
    }
  }

  /**
   * 边界取消核心：先落取消标记（窗口内新 run 在注册点被拒），再反复扫描
   * active 中命中边界的 run 逐个取消，直到无新增；最后等待全部 settle。
   * 标记引用计数（并发取消重叠时最后一个释放才解除）；同 key 重入共享同
   * 一次取消，防回调相互等待死锁。
   */
  async cancelBoundary(
    key: string,
    seeds: readonly number[],
    match: BoundaryMatch,
  ): Promise<void> {
    const inflight = this.boundaryCancels.get(key)
    if (inflight !== undefined) return inflight
    const cancel = this.runBoundaryCancel(key, seeds, match)
    this.boundaryCancels.set(key, cancel)
    try {
      await cancel
    } finally {
      if (this.boundaryCancels.get(key) === cancel) this.boundaryCancels.delete(key)
    }
  }

  private runBoundaryCancel(
    key: string,
    seeds: readonly number[],
    match: BoundaryMatch,
  ): Promise<void> {
    return (async () => {
      /** 本次取消持有的标记增量（finally 逐一释放）。 */
      const held: number[] = []
      const mark = (id: number): void => {
        this.cancellingCounts.set(id, (this.cancellingCounts.get(id) ?? 0) + 1)
        held.push(id)
      }
      // 先落边界标记再扫描：注册点断言保证标记后的新 run 必被拒。
      for (const seed of seeds) mark(seed)

      /** 发起会话父链缓存（getConversation 网络式读取；缺失即链断）。 */
      const parentCache = new Map<number, number | undefined>()
      const parentOf = (id: number): number | undefined => {
        if (!parentCache.has(id)) {
          let parent: number | undefined
          try {
            parent = this.parentConversationOf(id)
          } catch {
            parent = undefined
          }
          parentCache.set(id, parent)
        }
        return parentCache.get(id)
      }
      /** 沿真实会话父链判定 candidate 是否在 seed 子树内：visited 防环（父链
       * 环按不可达处理），缺父即止（不虚构可达）。 */
      const isWithin = (candidate: number, seed: number): boolean => {
        if (candidate === seed) return true
        const visited = new Set<number>()
        let current: number | undefined = candidate
        while (current !== undefined && !visited.has(current)) {
          visited.add(current)
          if (current === seed) return true
          current = parentOf(current)
        }
        return false
      }

      const aborted = new Set<ActiveRun>()
      try {
        // 扫描-取消循环：每轮取全部命中且未取消的 run；标记其发起会话（窗口
        // 内该会话不能再派新任务）后取消控制器。标记先于取消到位 + 注册点
        // 断言 ⇒ 不会出现越标新 run；循环收敛（上限 64 轮防御，超出如实诊断）。
        for (let round = 0; round < 64; round++) {
          const next = [...this.active.values()].filter((r) => !aborted.has(r) && match(r, isWithin))
          if (next.length === 0) break
          for (const run of next) {
            mark(run.conversationId)
            aborted.add(run)
            run.abort.abort()
          }
        }
        if (aborted.size > 0 && [...this.active.values()].some((r) => !aborted.has(r) && match(r, isWithin))) {
          process.stderr.write(
            `workflow: 边界取消 ${key} 64 轮扫描后仍有命中 run（防御上限，剩余项由后续事件链结算）\n`,
          )
        }
        // 全部 settle：各 run 的结算链内等待子会话守卫中止与结算通知完成。
        await Promise.all([...aborted].map((r) => r.done))
        // 防御性收尾扫描：等待期间理论不存在新注册（注册点已拒），仍兜底一轮。
        const stragglers = [...this.active.values()].filter((r) => !aborted.has(r) && match(r, isWithin))
        for (const run of stragglers) {
          mark(run.conversationId)
          run.abort.abort()
          await run.done
        }
      } finally {
        for (const id of held) {
          const count = this.cancellingCounts.get(id) ?? 1
          if (count <= 1) this.cancellingCounts.delete(id)
          else this.cancellingCounts.set(id, count - 1)
        }
      }
    })()
  }
}
