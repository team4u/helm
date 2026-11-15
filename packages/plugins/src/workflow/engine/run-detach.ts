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
 *   持久写入 → 解绑父 signal（引擎绑定 + waiter.onDetached 工具侧绑定）→
 *   唤醒等待者」全程无 await，与结算链的同步置位段（settle 入口先写
 *   record.status）互斥：二者只有一方先完成临界段，自然完成与 detach 竞态
 *   下只能有一个终态/通知路径生效。临界段完成后才 await 状态存储 flush：
 *   记录文件已同步 fsync（detached 事实已持久），flush 失败不回滚已落盘
 *   记录（重启恢复以 record 文件为权威），仅向调用方如实抛错；
 * - waitForegroundRun 的「已 detach / 已终态即读判定 → 登记 waiter（含
 *   onDetached 同步回调）」同样无 await：登记后 detach 必命中唤醒，绝不悬挂。
 */

import { HelmError } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { resolveForegroundWaiters, type ForegroundWaitOutcome } from './active-run.js'
import { redactSummaryNodes, toSummary } from './run-summary.js'
import type { WorkflowServiceContext } from './service-context.js'

function detachError(code: string, message: string, status: number, details?: Record<string, unknown>): HelmError {
  return new HelmError(code, message, status, details)
}

/** waitForegroundRun 可选钩子（同步工具侧挂起时注册）。 */
export interface ForegroundWaitHooks {
  /**
   * detach 临界段同步回调：在唤醒 resolve 之前执行。同步工具在此解绑
   * context.signal 对 run 的中止绑定（转后台后父回合 signal 不再杀 run）；
   * 与 subagent 前台模式的引擎解绑（run.unbindForegroundSignal）同语义。
   */
  onDetached?: () => void
}

/**
 * 前台等待：resolved 为 'detached'（工具立即返回后台句柄，结算汇报走
 * notifyParentOnSettle 链）或 'settled'（工具继续读终态；settleError 与
 * wait() 同语义原样抛出，不假成功）。
 */
export async function waitForegroundRun(
  svc: WorkflowServiceContext,
  runId: string,
  hooks?: ForegroundWaitHooks,
): Promise<ForegroundWaitOutcome> {
  const activeRun = svc.active.get(runId)
  if (activeRun === undefined) {
    // 历史/未知 run：不存在显式 404。不在活跃表（已结算收尾或跨重启）时以
    // 持久记录为权威：detachedAt 已落盘说明 detach 先于工具登记到达——
    // 事件不可丢失（返回 'detached' 让工具交还后台句柄，并同步执行
    // onDetached 解绑父 signal）；未 detach 则按已终态处理。
    const record = svc.runs.load(runId)
    if (record.detachedAt !== undefined) {
      hooks?.onDetached?.()
      return 'detached'
    }
    return 'settled'
  }
  // 同步临界段：登记前的即读判定与 detach 的临界段互斥（见模块头）。
  if (activeRun.record.detachedAt !== undefined) {
    hooks?.onDetached?.()
    return 'detached'
  }
  if (activeRun.record.status !== 'running') return 'settled'
  const outcome = await new Promise<ForegroundWaitOutcome>((resolve) => {
    activeRun.foregroundWaiters.add({ resolve, ...(hooks?.onDetached !== undefined ? { onDetached: hooks.onDetached } : {}) })
  })
  if (outcome === 'settled' && activeRun.settleError !== undefined) {
    throw activeRun.settleError
  }
  return outcome
}

/**
 * 把运行中的前台同步 run 原子转为后台（detach 动作入口）。同步临界段
 * （无 await）：状态判定 → 置位 detachedAt + notifyParentOnSettle（结算后经
 * outbox 向父会话 followUp 汇报）→ 持久写入记录文件（失败回滚内存标记，
 * 状态不被半修改）→ 解除父 signal 中止绑定（引擎绑定 + waiter.onDetached
 * 工具侧绑定）→ 唤醒等待者。临界段完成（detach 已生效且记录文件已 fsync）
 * 后 await 状态存储 flush：失败如实抛 detach_flush_failed，绝不回滚已持久
 * 记录——重启恢复以 record 文件为权威，索引 doc 队列仅是会话投影的镜像。
 */
export async function detachForegroundRun(svc: WorkflowServiceContext, runId: string): Promise<WorkflowRunSummary> {
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
  // 原子置位 + 持久写入（记录文件同步 fsync；写失败回滚内存标记，动作可
  // 安全重试）。
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
  // 父 signal 解绑：引擎前台绑定（subagent）+ 各等待者的 onDetached 工具侧
  // 绑定（SubagentWorkflow），均在唤醒前同步完成——工具返回后台句柄后父
  // 回合 signal 不再杀 run。
  activeRun.unbindForegroundSignal?.()
  activeRun.unbindForegroundSignal = undefined
  for (const waiter of activeRun.foregroundWaiters) waiter.onDetached?.()
  activeRun.summary = toSummary(record)
  resolveForegroundWaiters(activeRun, 'detached')
  svc.emitEventSafe('workflow.updated', { run: redactSummaryNodes(svc.redact, { ...activeRun.summary }) })
  // 临界段完成：detach 已生效（内存 + 已 fsync 的记录文件）。此后等待状态
  // 存储队列落盘——成功才算动作成功；失败如实抛错（不回滚：记录文件是
  // 重启恢复的权威面，回滚内存只会制造与磁盘矛盾的半状态）。
  try {
    await svc.state.flush?.()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`workflow ${runId}: detach state flush failed: ${message}\n`)
    throw detachError(
      'detach_flush_failed',
      `运行 ${runId} 已转入后台且运行记录文件已持久（detachedAt=${detachedAt}），但状态存储队列落盘失败：${message}；任务将按后台语义继续并汇报，请检查状态存储`,
      500,
      { runId, detachedAt, cause: message },
    )
  }
  return redactSummaryNodes(svc.redact, { ...activeRun.summary })
}
