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
  writer: JournalWriter
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
  /** 本 run 的持久记录引用（同一对象）：子会话事实即时落盘与终态写共用。 */
  record: RunRecord
  /** progress 持久化节流（timeline 非空后定期落盘）。 */
  lastPersistAt: number
  /** 节点开始/结束必须推送的 workflow.updated 事件（有界频率内的强制点）。 */
  lastNodeEventAt: number
  /** 250ms 窗口内节点边界事件的 trailing timer：窗口内启动绝不丢失。 */
  pendingEventTimer?: ReturnType<typeof setTimeout>
}

/** progress 持久化最小间隔：高频进度不逐条落库。 */
export const PROGRESS_PERSIST_INTERVAL_MS = 1_000

/** workflow.updated 节点事件最小间隔：有界频率，但节点开始/结束强制推送。 */
export const NODE_EVENT_INTERVAL_MS = 250
