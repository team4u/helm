/**
 * run-progress.ts — workflow run 的进度事件策略（自 service.run 拆出的内部
 * 模块）。
 *
 * makeRunProgressHandler 产出 runtime 的 onProgress 回调：
 * - 时间线与 summary 镜像实时更新（phase/log 零延迟推送）；
 * - 节点边界事件在 250ms（NODE_EVENT_INTERVAL_MS）窗口内做 trailing timer
 *   兜底补发，绝不丢失也不打爆观察面；
 * - 周期性把时间线落库（PROGRESS_PERSIST_INTERVAL_MS 节流，尽力而为）：
 *   长时间 run 的 phase/log 不必等终态才可见。
 */

import { NODE_EVENT_INTERVAL_MS, PROGRESS_PERSIST_INTERVAL_MS, type ActiveRun } from './active-run.js'
import type { WorkflowEntry } from './progress.js'
import { nodesFromProgress, redactSummaryNodes } from './run-summary.js'
import type { WorkflowServiceContext } from './service-context.js'

/**
 * 组装 run 的 onProgress 处理器（绑定 run 运行态；record 为 run.record 同一
 * 引用，节流落库直接改写内存记录）。
 */
export function makeRunProgressHandler(
  svc: WorkflowServiceContext,
  run: ActiveRun,
): (entries: readonly WorkflowEntry[]) => void {
  const record = run.record
  return (entries) => {
    run.progress.push(...entries)
    const stamp = Date.now()
    for (const entry of entries) {
      if (entry.type === 'workflow_phase') {
        run.timeline.push({ at: stamp, kind: 'phase', index: entry.index, title: entry.title })
      } else if (entry.type === 'workflow_log') {
        run.timeline.push({ at: stamp, kind: 'log', message: entry.message })
      }
    }
    run.summary.updatedAt = stamp
    if (run.timeline.length > 0) run.summary.progress = [...run.timeline]

    // 立即推送判定：phase/log 必须零延迟；onResolved 回传元数据（会话/
    // 执行标识/worktree/gate）必须零延迟；节点边界在 250ms 窗口外强制。
    const hasPhaseOrLog = entries.some(
      (entry) => entry.type === 'workflow_phase' || entry.type === 'workflow_log',
    )
    const hasResolvedOrGate = entries.some(
      (entry) =>
        entry.type === 'workflow_agent' &&
        (entry.conversationId !== undefined ||
          entry.executionId !== undefined ||
          entry.worktree !== undefined ||
          entry.gate !== undefined),
    )
    const nodeBoundary = entries.some(
      (entry) =>
        (entry.type === 'workflow_agent' || entry.type === 'workflow_action') &&
        (entry.state === 'start' || entry.state === 'done' || entry.state === 'error'),
    )
    const due = stamp - run.lastNodeEventAt >= NODE_EVENT_INTERVAL_MS

    // 周期性把时间线落库：长时间 run 的 phase/log 不必等终态才可见。
    if (
      run.timeline.length > 0 &&
      (due || (nodeBoundary && due) || hasPhaseOrLog) &&
      stamp - run.lastPersistAt >= PROGRESS_PERSIST_INTERVAL_MS
    ) {
      run.lastPersistAt = stamp
      record.updatedAt = stamp
      record.progress = run.timeline
      try {
        svc.writeRecord(record)
        const flushed = svc.state.flush?.()
        if (flushed !== undefined) void flushed.catch(() => {})
      } catch {
        // 尽力而为的观察面：失败不阻断 run，终态写入会再次尝试。
      }
    }

    const emitUpdated = (at: number): void => {
      svc.emitEventSafe('workflow.updated', {
        run: redactSummaryNodes(svc.redact, {
          ...run.summary,
          updatedAt: at,
          nodes: nodesFromProgress(run.progress),
          ...(run.timeline.length > 0 ? { progress: [...run.timeline] } : {}),
        }),
      })
    }

    if ((nodeBoundary && due) || hasPhaseOrLog || hasResolvedOrGate) {
      // 窗口内补发 timer 不再需要：本次已携最新状态发布。
      if (run.pendingEventTimer !== undefined) {
        clearTimeout(run.pendingEventTimer)
        run.pendingEventTimer = undefined
      }
      run.lastNodeEventAt = stamp
      emitUpdated(stamp)
    } else if (nodeBoundary && !due && run.pendingEventTimer === undefined) {
      // 250ms 窗口内的节点启动/完成：trailing timer 兜底补发，绝不丢失。
      const delay = Math.max(10, NODE_EVENT_INTERVAL_MS - (stamp - run.lastNodeEventAt))
      const timer = setTimeout(() => {
        run.pendingEventTimer = undefined
        if (!svc.active.has(run.runId)) return
        const at = Date.now()
        run.lastNodeEventAt = at
        emitUpdated(at)
      }, delay)
      timer.unref?.()
      run.pendingEventTimer = timer
    }
  }
}
