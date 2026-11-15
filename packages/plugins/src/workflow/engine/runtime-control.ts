/**
 * runtime-control.ts — run 级协调原语：并发信号量与暂停/跳过/重试控制板。
 *
 * 自 runtime.ts 拆出（语义逐行保持）：
 * - Semaphore：全局 agent 并发许可（release 直接把许可递给下一个等待者，
 *   一波 release 不放行超限并发；drain 用于 run 终止时唤醒全部等待者）。
 * - RuntimeControl：原先散落在 runWorkflow 闭包里的暂停门（pauseGate /
 *   actionPauseGate）、pauseWaiters 与 liveAgents 表的显式类化。宿主
 *   （abortAgent）与「run 已停止」判定（aborted || settled）经构造函数
 *   注入，本模块不持有 worker / 账本 / 进度等 run 其余状态。
 */

import type { WorkflowControl, WorkflowHost } from './runtime-types.js'

export class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    // 直接把许可递给下一个等待者；先减后加会让一波 release 放行超限并发。
    if (next) next()
    else this.active--
  }

  drain(): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.()
    }
  }
}

/** 一个在途 agent 调用的控制面状态（skip/retry 意图与暂停唤醒句柄）。 */
export interface LiveAgent {
  agentId: string
  started: boolean
  intent?: 'skip' | 'retry'
  wake?: () => void
}

/**
 * 暂停 / 跳过 / 重试控制板。全部操作幂等 best-effort，与原闭包实现逐行对应：
 * - pause 后新的 acquire 循环在 gate 上挂起；resume / run 终止统一唤醒；
 * - skip 对未启动调用只置意图（启动前消费），对已启动调用 abort 宿主 agent；
 * - retry 仅对已启动且尚无意图的调用有效，abort 后由 attempt 环重跑。
 */
export class RuntimeControl {
  private paused = false
  private readonly pauseWaiters = new Set<() => void>()
  readonly liveAgents = new Map<number, LiveAgent>()

  constructor(
    private readonly host: Pick<WorkflowHost, 'abortAgent'>,
    /** run 已进入终态（aborted || settled）时暂停门不再挂起新等待者。 */
    private readonly isStopped: () => boolean,
  ) {}

  isPaused(): boolean {
    return this.paused
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.releasePause()
  }

  /** 唤醒全部暂停等待者（run 终止 / resume 共用）。 */
  releasePause(): void {
    for (const wake of [...this.pauseWaiters]) wake()
    this.pauseWaiters.clear()
  }

  pauseGate(live: LiveAgent): Promise<void> {
    if (!this.paused || this.isStopped()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = () => {
        this.pauseWaiters.delete(wake)
        live.wake = undefined
        resolve()
      }
      live.wake = wake
      this.pauseWaiters.add(wake)
    })
  }

  actionPauseGate(): Promise<void> {
    if (!this.paused || this.isStopped()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = () => {
        this.pauseWaiters.delete(wake)
        resolve()
      }
      this.pauseWaiters.add(wake)
    })
  }

  skip(index: number): boolean {
    const live = this.liveAgents.get(index)
    if (live === undefined || live.intent !== undefined) return false
    live.intent = 'skip'
    if (live.started) this.host.abortAgent(live.agentId)
    else live.wake?.()
    return true
  }

  retry(index: number): boolean {
    const live = this.liveAgents.get(index)
    if (live === undefined || !live.started || live.intent !== undefined) return false
    live.intent = 'retry'
    this.host.abortAgent(live.agentId)
    return true
  }

  /** 暴露给 onControl 的公共控制面（幂等 best-effort）。 */
  toControl(): WorkflowControl {
    return {
      pause: () => this.pause(),
      resume: () => this.resume(),
      isPaused: () => this.isPaused(),
      skip: (index) => this.skip(index),
      retry: (index) => this.retry(index),
    }
  }
}
