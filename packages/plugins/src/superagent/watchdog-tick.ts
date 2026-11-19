/**
 * builtin:superagent Watchdog 定时巡检（原内核 watchdog_tick 的采集段；
 * 策略评估在 watchdog-classify，动作执行在 watchdog-ops）。
 *
 * - singleflight：定时与手动（watchdog_tick 动作）共用同一在途 Promise，
 *   重入返回在途轮真实结果（skipped=true，计数为真实采集值，绝不伪造 0）；
 * - 单轮采集：先从 ctx.host 构造原生会话事实（listConversations /
 *   getConversationOwnership 为宿主只读端口；stalledMs/consecutiveErrors 来自
 *   watchdog-activity 的真实事件统计），再经 'diagnostics.collect' 内部事件
 *   （broadcast:false，await 全部监听器）采集外部探针（如 builtin:herdr 终端
 *   窗格）。任一环节失败显式抛出，绝不静默跳过（诚实性纪律）；
 * - 采集有界等待：监听器挂死时超时按本轮采集失败处理（不静默跳过），迟到
 *   settle 的原 Promise 吞掉 rejection，避免未观察 rejection 崩溃进程；
 * - 终态复验：监听方绕过 appendProbes 改写 collection 或注入非法探针在此
 *   拦截（assertValidCollection），非法产物绝不进入规则表。
 */

import { HelmxError, type HelmxPluginContext } from '@helmx/protocol'
import {
  assertValidCollection,
  DIAGNOSTICS_COLLECT_EVENT,
  type DiagnosticsCollection,
  type WatchdogProbe,
} from '../diagnostics.js'
import type { ConversationActivityTracker } from './watchdog-activity.js'
import {
  TICK_COLLECT_TIMEOUT_MS,
  TICK_INTERVAL_MS,
  STOP_TICK_WAIT_MS,
  type WatchdogNotify,
} from './watchdog-core.js'

/** 手动/定时共用的 singleflight 结果：skipped=true 表示复用在途轮真实结果。 */
export interface TickOutcome {
  skipped: boolean
  collection: DiagnosticsCollection
}

interface WatchdogTickDeps {
  ctx: HelmxPluginContext
  activity: ConversationActivityTracker
  /** 采集成功后的规则表评估（原 watchdog_tick 处理器主体）。 */
  evaluate(collection: DiagnosticsCollection): Promise<void>
  notify: WatchdogNotify
  isClosing: () => boolean
}

export class WatchdogTickController {
  /** 定时巡检定时器（unref 不阻退出；stop 清理）。 */
  private tickTimer: NodeJS.Timeout | undefined
  /** 在途 tick（singleflight；timer 与手动动作共用同一 Promise 与最终结果）。 */
  private tickInflight: Promise<DiagnosticsCollection> | undefined

  constructor(private readonly deps: WatchdogTickDeps) {}

  /** 定时入口：异常显式通知（不静默吞）；与手动动作共用 singleflightTick。 */
  schedule(): void {
    if (this.deps.isClosing() || this.tickTimer !== undefined) return
    this.tickTimer = setInterval(() => {
      void this.singleflightTick().catch((error) => {
        this.deps.notify(
          'error',
          'watchdog 巡检失败',
          error instanceof Error ? error.message : String(error),
        )
      })
    }, TICK_INTERVAL_MS)
    this.tickTimer.unref()
  }

  /**
   * 唯一 tick 入口（singleflight）：定时与手动共用同一在途 Promise；重入时
   * 返回在途轮的真实结果（skipped=true，计数为真实采集值，绝不伪造 0）。
   */
  async singleflightTick(): Promise<TickOutcome> {
    if (this.tickInflight !== undefined) {
      return this.tickInflight.then((collection) => ({ skipped: true, collection }))
    }
    let self: Promise<DiagnosticsCollection> | undefined
    const run = (async () => {
      try {
        const collection = await this.runTick()
        await this.deps.evaluate(collection)
        return collection
      } finally {
        if (this.tickInflight === self) this.tickInflight = undefined
      }
    })()
    self = run
    this.tickInflight = run
    return run.then((collection) => ({ skipped: false, collection }))
  }

  /**
   * 单轮巡检采集：任一环节失败显式抛出（诚实性纪律）。
   */
  private async runTick(): Promise<DiagnosticsCollection> {
    const { ctx, activity, isClosing } = this.deps
    if (isClosing() || ctx.host.isClosing) {
      throw new HelmxError('plugin_disabled', 'builtin:superagent 或内核正在关闭，拒绝启动巡检', 409)
    }
    const summaries = ctx.host.listConversations()
    const probes: WatchdogProbe[] = summaries.map((summary) => {
      const activityFacts = activity.activityOf(summary)
      return {
        targetId: String(summary.id),
        /**
         * 归属权判定依据显式登记的 ownership 标记，绝不依赖用户可改的
         * tags/parent 推断；判不准一律 human 只读（宁漏管不越权）。
         */
        ownedBy: ctx.host.getConversationOwnership(summary.id),
        status: summary.status,
        targetKind: 'conversation' as const,
        conversationId: summary.id,
        stateChangeSeq: summary.stateChangeSeq,
        ...(activityFacts.stalledMs !== undefined ? { stalledMs: activityFacts.stalledMs } : {}),
        ...(activityFacts.consecutiveErrors > 0 ? { consecutiveErrors: activityFacts.consecutiveErrors } : {}),
        facts: { doing: summary.doing, pendingAskCount: summary.pendingAskCount },
      }
    })
    const collection: DiagnosticsCollection = {
      timestamp: Date.now(),
      conversations: summaries.map((summary) => ({ id: summary.id, profileId: summary.profileId })),
      probes,
    }
    // 外部采集（Herdr 等）：宿主事件会等待全部监听器，失败如实上抛。有界
    // 等待：监听器挂死时超时按本轮采集失败处理（不静默跳过），迟到 settle
    // 的原 Promise 吞掉 rejection，避免未观察 rejection 崩溃进程。
    const collect = Promise.resolve(
      ctx.host.emitEvent(DIAGNOSTICS_COLLECT_EVENT, collection, { broadcast: false }),
    )
    let timeoutTimer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        collect,
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(
            () =>
              reject(
                new HelmxError(
                  'watchdog_collect_timeout',
                  `巡检外部采集超过 ${TICK_COLLECT_TIMEOUT_MS}ms 未收敛（diagnostics.collect 监听器挂死或过慢），本轮按采集失败放弃`,
                  500,
                ),
              ),
            TICK_COLLECT_TIMEOUT_MS,
          )
          timeoutTimer.unref?.()
        }),
      ])
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      void collect.catch(() => {})
    }
    // 终态复验：监听方直接改写 collection（绕过 appendProbes）或注入非法探针
    // 在此拦截，非法产物绝不进入规则表（诚实性纪律）。
    assertValidCollection(collection)
    return collection
  }

  /**
   * service stop：先停定时器（不再产生新 tick），再有界等在途 tick 收敛：
   * 跨插件采集（diagnostics.collect 监听器）不可取消，无界等待会与慢监听方
   * 互相挂死。返回是否在限内收敛（false = 超时放弃等待，由调用方如实通知）。
   */
  async onStop(): Promise<boolean> {
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }
    if (this.tickInflight === undefined) return true
    const bounded = this.tickInflight.catch(() => undefined)
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, STOP_TICK_WAIT_MS).unref?.())
    return await Promise.race([bounded.then(() => true), timeout.then(() => false)])
  }

  /** service liveTasks：在途 tick 标记（stop/卸载前 PluginHost 据此 409 拒绝）。 */
  hasInflightTick(): boolean {
    return this.tickInflight !== undefined
  }
}
