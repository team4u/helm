/**
 * active-run.ts — 在途 run 的内存运行态（自 WorkflowService 拆出的内部模块）。
 *
 * ActiveRun 是 run 运行期在服务内的唯一内存镜像：abort 控制器、结算 gate、
 * progress/timeline、在途子会话中止与命令执行通道的追踪集合。持久化归
 * run-store；本模块只描述运行态形状与节流常量，不含行为。
 */

import type { WorkflowProgressEntry, WorkflowRunSummary } from '../../contracts.js'
import type { JournalWriter } from './journal.js'
import type { WorkflowEntry } from './progress.js'
import type { RunRecord } from './run-store.js'

/** 前台等待唤醒结果：detached = 已被 detach 动作转入后台；settled = run 已终态。 */
export type ForegroundWaitOutcome = 'detached' | 'settled'

/** 前台等待者登记项：resolve 唤醒 + detach 临界段同步回调。 */
export interface ForegroundWaiter {
  resolve: (outcome: ForegroundWaitOutcome) => void
  /**
   * detach 临界段回调：在唤醒 resolve 之前同步执行（工具侧在此解绑父
   * signal listener——转后台后父回合 signal 不再中止 run；与 subagent
   * 前台绑定的引擎解绑 run.unbindForegroundSignal 同语义）。
   */
  onDetached?: () => void
}

export interface ActiveRun {
  runId: string
  conversationId: number
  abort: AbortController
  /** run 结束（含 abort、子会话中止收尾、终态落盘）后 resolve；绝不 reject。 */
  done: Promise<void>
  /** 终态落盘/flush 失败时由 wait() 原样抛出（done 不 reject，避免无人 await 时 unhandled）。 */
  settleError?: unknown
  summary: WorkflowRunSummary
  journalPath: string
  /** DSL 工作流账本追加器；单子代理运行不写 JSONL 账本，保持 undefined 免开空句柄。 */
  writer?: JournalWriter
  progress: WorkflowEntry[]
  timeline: WorkflowProgressEntry[]
  /** 在途子会话的中止 promise（close/abort 需 await 后才算真正结束）。 */
  pendingAborts: Set<Promise<void>>
  /** 在途命令执行通道的 promise（收尾时 abort 并在结算前等待退出，避免脱管进程）。 */
  pendingExecs: Set<Promise<unknown>>
  /**
   * 本 run 派生的子会话集合（onResolved 回传即登记）：abort 级联时逐个经
   * host.abortConversationGuarded 守卫中止；迟到 onResolved 在登记时若已
   * 取消则立即补杀（防快照时序漏杀）。
   */
  childConversations: Set<number>
  /**
   * 前台同步等待者（同步工具的 waitForeground 挂起处）：detach 动作先同步
   * 执行各 waiter.onDetached（解绑父 signal）再以 'detached' 唤醒（工具
   * 立即返回后台句柄）；结算链以 'settled' 收尾（工具继续读终态）。注册
   * 与唤醒互斥于单线程事件循环的同步临界段。
   */
  foregroundWaiters: Set<ForegroundWaiter>
  /**
   * 前台父 signal 解绑口（startBackgroundAgent foreground 模式注入）：
   * detach 的同步临界段调用，解除父工具调用 signal 对本 run 的中止绑定
   * （父回合结束/中止不再误杀已转后台的 run）。
   */
  unbindForegroundSignal?: () => void
  /** 宿主关停优雅挂起标记：true 时不中止子会话，不写终态，落盘 suspendedCleanly=true。 */
  suspended?: boolean
  /** 显式取消/关停关闭标记：防止误入优雅挂起路径。 */
  userAborted?: boolean
  /** 本 run 的持久记录引用（同一对象）：子会话事实即时落盘与终态写共用。 */
  record: RunRecord
  /** progress 持久化节流（timeline 非空后定期落盘）。 */
  lastPersistAt: number
  /** 节点开始/结束必须推送的 workflow.updated 事件（有界频率内的强制点）。 */
  lastNodeEventAt: number
  /** 250ms 窗口内节点边界事件的 trailing timer：窗口内启动绝不丢失。 */
  pendingEventTimer?: ReturnType<typeof setTimeout>
}

/** 唤醒全部前台等待者（Promise 单次 resolve 幂等；detach 与结算链共用出口）。 */
export function resolveForegroundWaiters(run: ActiveRun, outcome: ForegroundWaitOutcome): void {
  for (const waiter of run.foregroundWaiters) waiter.resolve(outcome)
  run.foregroundWaiters.clear()
}

/** progress 持久化最小间隔：高频进度不逐条落库。 */
export const PROGRESS_PERSIST_INTERVAL_MS = 1_000

/** workflow.updated 节点事件最小间隔：有界频率，但节点开始/结束强制推送。 */
export const NODE_EVENT_INTERVAL_MS = 250
