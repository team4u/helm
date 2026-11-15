/**
 * run-detach.ts — 前台同步 run 的 detach 转后台与等待唤醒（引擎内部模块）。
 *
 * 统一同步 subagent（startBackgroundAgent foreground 模式）与同步
 * SubagentWorkflow（run foreground 上下文）的生命周期：从启动起即有 durable
 * WorkflowRun（record.syncForeground 标记），同步工具经 waitForegroundRun
 * 挂起等待终态，期间可被 detach 动作按 runId 原子转入后台。
 *
 * 原子性纪律（单线程事件循环的同步临界段）：
 * - detachForegroundRun 的「状态判定 → 置位 detachedAt/notifyParentOnSettle →
 *   持久写入 → 解绑父 signal → 唤醒等待者」全程无 await，与结算链的同步
 *   置位段（settle 入口先写 record.status）互斥：二者只有一方先完成临界段，
 *   自然完成与 detach 竞态下只能有一个终态/通知路径生效；
 * - waitForegroundRun 的「已 detach / 已终态即读判定 → 登记 waiter」同样
 *   无 await：登记后 detach 必命中唤醒，绝不悬挂。
 */

import { HelmError } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { resolveForegroundWaiters, type ForegroundWaitOutcome } from './active-run.js'
import { redactSummaryNodes, toSummary } from './run-summary.js'
import type { WorkflowServiceContext } from './service-context.js'

function detachError(code: string, message: string, status: number, details?: Record<string, unknown>): HelmError {
  return new HelmError(code, message, status, details)
}

/**
 * 前台等待：resolved 为 'detached'（工具立即返回后台句柄，结算汇报走
 * notifyParentOnSettle 链）或 'settled'（工具继续读终态；settleError 与
 * wait() 同语义原样抛出，不假成功）。
 */
export async function waitForegroundRun(
  svc: WorkflowServiceContext,
  runId: string,
): Promise<ForegroundWaitOutcome> {
  const activeRun = svc.active.get(runId)
  if (activeRun === undefined) {
    // 历史/未知 run：不存在显式 404；存在但不在活跃表（跨重启或已结算
    // 收尾）按已终态处理——工具读终态记录即为诚实结果。
    svc.runs.load(runId)
    return 'settled'
  }
  // 同步临界段：登记前的即读判定与 detach 的临界段互斥（见模块头）。
  if (activeRun.record.detachedAt !== undefined) return 'detached'
  if (activeRun.record.status !== 'running') return 'settled'
  const outcome = await new Promise<ForegroundWaitOutcome>((resolve) => {
    activeRun.foregroundWaiters.add(resolve)
  })
  if (outcome === 'settled' && activeRun.settleError !== undefined) {
    throw activeRun.settleError
  }
  return outcome
}

/**
 * 把运行中的前台同步 run 原子转为后台（detach 动作入口；全程同步无
 * await）。置位 detachedAt + notifyParentOnSettle（结算后经 outbox 向父
 * 会话 followUp 汇报）、持久写入、解除父 signal 中止绑定并唤醒等待者；
 * 任一步失败如实抛出（持久写失败回滚内存标记，状态不被半修改）。
 */
export function detachForegroundRun(svc: WorkflowServiceContext, runId: string): WorkflowRunSummary {
  const activeRun = svc.active.get(runId)
  if (activeRun === undefined) {
    // 未知 run 与已知非活跃 run 区分：不存在 404；存在但非活跃（跨重启
    // 僵尸或结算收尾中）不可 detach。
    const record = svc.runs.load(runId)
    throw detachError(
      'detach_not_running',
      `运行 ${runId} 不在进程内活跃表中（状态 ${record.status}），无法转入后台`,
      409,
      { runId, status: record.status },
    )
  }
  const record = activeRun.record
  // 权威状态判定（同步临界段，与结算链互斥）。
  if (record.status !== 'running') {
    throw detachError(
      'detach_not_running',
      `运行 ${runId} 已终态（status=${record.status}），无可转入后台的在途执行`,
      409,
      { runId, status: record.status },
    )
  }
  if (record.detachedAt !== undefined || record.notifyParentOnSettle === true) {
    throw detachError(
      'detach_not_foreground',
      `运行 ${runId} 已在后台（${record.detachedAt !== undefined ? `detachedAt=${record.detachedAt}` : 'background 启动'}），拒绝重复 detach`,
      409,
      { runId, ...(record.detachedAt !== undefined ? { detachedAt: record.detachedAt } : { background: true }) },
    )
  }
  if (record.syncForeground !== true) {
    throw detachError(
      'detach_not_foreground',
      `运行 ${runId} 不是前台同步运行（syncForeground 未标记），仅同步工具启动的 run 可转入后台`,
      409,
      { runId, syncForeground: record.syncForeground ?? false },
    )
  }
  // 原子置位 + 持久化（写失败回滚内存标记，动作可安全重试）。
  const detachedAt = Date.now()
  const previousUpdatedAt = record.updatedAt
  record.detachedAt = detachedAt
  record.notifyParentOnSettle = true
  record.updatedAt = detachedAt
  try {
    svc.writeRecord(record)
  } catch (error) {
    record.detachedAt = undefined
    record.notifyParentOnSettle = false
    record.updatedAt = previousUpdatedAt
    throw error
  }
  const flushed = svc.state.flush?.()
  if (flushed !== undefined) {
    void flushed.catch((error: unknown) => {
      process.stderr.write(
        `workflow ${runId}: detach state flush failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    })
  }
  // 父 signal 解绑（先于唤醒：工具返回后台句柄后父回合 signal 不再杀 run）。
  activeRun.unbindForegroundSignal?.()
  activeRun.unbindForegroundSignal = undefined
  activeRun.summary = toSummary(record)
  resolveForegroundWaiters(activeRun, 'detached')
  svc.emitEventSafe('workflow.updated', { run: redactSummaryNodes(svc.redact, { ...activeRun.summary }) })
  return redactSummaryNodes(svc.redact, { ...activeRun.summary })
}
