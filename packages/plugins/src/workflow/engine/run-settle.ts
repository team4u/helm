/**
 * run-settle.ts — 工作流与单子代理统一的终态结算流水线。
 *
 * executeRunSettlement 是 ActiveRun 收尾的唯一权威出口（DSL workflow 与单子代理
 * 共用同一套生命周期纪律）：
 * - 优雅挂起（suspending → status='running' + suspendedCleanly=true）与终态区分；
 * - 关停窗口遗留子会话标记（pendingChildCleanup=true）；
 * - 结构化 errorCode 与权威 resumable 摘要派生（svc.summaryOf）；
 * - 终态原子落盘与 flush（失败追加诊断并通过 settleError 诚实上抛）；
 * - 可选账本句柄关闭（仅 DSL workflow 持有 writer；单子代理零空文件句柄）；
 * - active 移除、pendingExecs / pendingAborts 收敛等待；
 * - onRunSettled 与 onBackgroundAgentSettled（outbox + notifiedAt 防重）恰一次回调；
 * - workflow.updated 增量事件广播、done 门与前台同步等待者唤醒。
 */

import { HelmxError, redactJsonValue, type AgentExecutionInfo } from '@helmx/protocol'
import type { WorkflowNodeState } from '../../contracts.js'
import { resolveForegroundWaiters, type ActiveRun } from './active-run.js'
import { classifyRunFailureCode } from './run-resumability.js'
import { backgroundChildIds } from './run-store.js'
import { nodesFromProgress, redactNodes } from './run-summary.js'
import type { WorkflowRunResult } from './runtime.js'
import type { WorkflowServiceContext } from './service-context.js'

interface SettlementPipelineSpec {
  applyOutcome(hostClosing: boolean): Promise<{ suspending: boolean }> | { suspending: boolean }
  getBackgroundNotifyInfo(): {
    parentConversationId: number
    agentType?: string
    execution?: AgentExecutionInfo
  }
  cleanupParentSignal?: () => void
  resolveDone?: () => void
}

async function executeRunSettlement(
  svc: WorkflowServiceContext,
  run: ActiveRun,
  spec: SettlementPipelineSpec,
): Promise<void> {
  const record = run.record
  const runId = run.runId
  let suspending = false
  let settleFailure: unknown

  const recordSettleError = (error: unknown): void => {
    if (run.settleError === undefined) run.settleError = error
  }

  try {
    if (run.pendingEventTimer !== undefined) {
      clearTimeout(run.pendingEventTimer)
      run.pendingEventTimer = undefined
    }
    const hostClosing = svc.host.isHostClosing?.() === true
    const applied = await spec.applyOutcome(hostClosing)
    suspending = applied.suspending

    if (
      !suspending &&
      hostClosing &&
      record.status !== 'completed' &&
      (run.childConversations.size > 0 || backgroundChildIds(record).length > 0)
    ) {
      record.pendingChildCleanup = true
    }
    record.updatedAt = Date.now()
    run.summary = svc.summaryOf(record)

    try {
      svc.writeRecord(record)
      await svc.state.flush?.()
    } catch (persistError) {
      const persistMessage = persistError instanceof Error ? persistError.message : String(persistError)
      process.stderr.write(`workflow ${runId}: terminal state persist failed: ${persistMessage}\n`)
      run.summary = {
        ...run.summary,
        status: record.status,
        error: `${record.error ?? ''}\n[persist failed: ${persistMessage}]`.trim(),
      }
      recordSettleError(persistError)
    }
  } catch (error) {
    settleFailure = error
  } finally {
    if (run.writer !== undefined) {
      try {
        await run.writer.close()
      } catch (closeError) {
        process.stderr.write(
          `workflow ${runId}: journal close failed: ${
            closeError instanceof Error ? closeError.message : String(closeError)
          }\n`,
        )
      }
    }
    run.abort.abort()
    if (run.pendingExecs.size > 0) {
      await Promise.allSettled([...run.pendingExecs])
    }
    svc.active.delete(runId)
    if (run.pendingAborts.size > 0) {
      await Promise.allSettled([...run.pendingAborts])
    }
    if (!suspending && svc.host.onRunSettled !== undefined) {
      try {
        await svc.host.onRunSettled({ ...run.summary })
      } catch (settledError) {
        const message = settledError instanceof Error ? settledError.message : String(settledError)
        process.stderr.write(`workflow ${runId}: onRunSettled failed: ${message}\n`)
        run.summary = {
          ...run.summary,
          error: `${run.summary.error ?? ''}\n[onRunSettled failed: ${message}]`.trim(),
        }
        record.error = `${record.error ?? ''}\n[onRunSettled failed: ${message}]`.trim()
        try {
          svc.writeRecord(record)
          const flushed = svc.state.flush?.()
          if (flushed !== undefined) void flushed.catch(() => {})
        } catch {
          // 诊断补写尽力而为；settleError 已携带原始异常。
        }
        recordSettleError(settledError)
      }
    }
    if (
      !suspending &&
      !svc.isClosed() &&
      svc.host.isHostClosing?.() !== true &&
      record.notifyParentOnSettle === true &&
      record.notifiedAt === undefined &&
      svc.host.onBackgroundAgentSettled !== undefined
    ) {
      try {
        await svc.host.onBackgroundAgentSettled({ ...run.summary }, spec.getBackgroundNotifyInfo())
        record.notifiedAt = Date.now()
        svc.writeRecord(record)
        await svc.state.flush?.()
      } catch (notifyError) {
        const message = notifyError instanceof Error ? notifyError.message : String(notifyError)
        process.stderr.write(`workflow ${runId}: onBackgroundAgentSettled failed: ${message}\n`)
      }
    }
    svc.emitEventSafe('workflow.updated', { run: { ...run.summary } })
    if (settleFailure !== undefined) recordSettleError(settleFailure)
    spec.cleanupParentSignal?.()
    run.unbindForegroundSignal = undefined
    spec.resolveDone?.()
    resolveForegroundWaiters(run, 'settled')
  }
}

/** 结算一个 DSL workflow run。 */
export async function settleWorkflowRun(
  svc: WorkflowServiceContext,
  run: ActiveRun,
  resumeJournalIoErrors: string[] | undefined,
  result: WorkflowRunResult | undefined,
  failure?: unknown,
): Promise<void> {
  const record = run.record
  const runId = run.runId
  await executeRunSettlement(svc, run, {
    applyOutcome: async (hostClosing) => {
      const suspending = svc.isRunSuspending(run) && result?.status !== 'completed'
      if (suspending) {
        record.status = 'running'
        record.suspendedCleanly = true
      } else if (result !== undefined) {
        record.status =
          result.status === 'killed'
            ? 'aborted'
            : hostClosing && result.status !== 'completed'
              ? 'aborted'
              : result.status
        if (result.error !== undefined) record.error = svc.redact(result.error)
        if (record.status === 'failed') {
          record.errorCode = classifyRunFailureCode(failure, result.error, 'workflow_failed')
        } else {
          delete record.errorCode
        }
        if (result.value !== undefined) record.result = redactJsonValue(result.value, svc.redact)
      } else {
        record.status = hostClosing ? 'aborted' : 'failed'
        const message =
          failure instanceof Error
            ? failure.message
            : failure !== undefined
              ? String(failure)
              : 'unknown workflow failure'
        record.error = svc.redact(message)
        if (record.status === 'failed') {
          record.errorCode = classifyRunFailureCode(failure, message, 'workflow_failed')
        } else {
          delete record.errorCode
        }
      }

      const journalIoErrors = [
        ...(result?.journalIoErrors ?? []),
        ...(resumeJournalIoErrors ?? []),
        ...(run.writer !== undefined && run.writer.agentIoErrors > 0
          ? [`${run.writer.agentIoErrors} journal agent-line append(s) failed (journal: ${run.journalPath})`]
          : []),
      ]
      if (journalIoErrors.length > 0) {
        const redacted = journalIoErrors.map((message) => svc.redact(message))
        for (const message of redacted) {
          process.stderr.write(`workflow ${runId}: journal io error: ${message}\n`)
        }
        record.journalIoErrors = redacted
      }

      run.abort.abort()
      if (run.pendingExecs.size > 0) {
        await Promise.allSettled([...run.pendingExecs])
      }
      if (!suspending || run.progress.length > 0) {
        record.nodes = redactNodes(svc.redact, nodesFromProgress(run.progress))
      }
      if (!suspending || run.timeline.length > 0) {
        record.progress = run.timeline
      }
      return { suspending }
    },
    getBackgroundNotifyInfo: () => ({ parentConversationId: run.conversationId }),
  })
}

export type SubagentRawOutcome = { ok: true; raw: unknown } | { ok: false; error: unknown }

/** 创建单子代理幂等结算器（startBackgroundAgent 与 reattachBackgroundAgent 共用）。 */
export function createSubagentSettler(params: {
  svc: WorkflowServiceContext
  run: ActiveRun
  node: WorkflowNodeState
  parentConversationId: number
  agentType: string | undefined
  getExecutionInfo: () => AgentExecutionInfo | undefined
  resolveDone: () => void
  cleanupParentSignal?: () => void
}) {
  const { svc, run, node, parentConversationId, agentType, getExecutionInfo, resolveDone, cleanupParentSignal } = params
  const record = run.record
  const startedAt = node.startedAt ?? record.createdAt
  let settled = false

  const reportSettleError = (error: unknown): void => {
    if (run.settleError === undefined) run.settleError = error
  }

  const settle = async (outcome: SubagentRawOutcome): Promise<void> => {
    if (settled) return
    settled = true
    await executeRunSettlement(svc, run, {
      applyOutcome: (hostClosing) => {
        const settledAt = Date.now()
        const outcomeCompleted = outcome.ok && !run.abort.signal.aborted && !run.suspended
        const suspending = !outcomeCompleted && svc.isRunSuspending(run)
        const aborted =
          !outcome.ok &&
          (hostClosing ||
            run.abort.signal.aborted ||
            (outcome.error instanceof HelmxError && outcome.error.code === 'aborted'))

        if (suspending) {
          record.status = 'running'
          record.suspendedCleanly = true
          node.status = 'running'
        } else if (outcomeCompleted) {
          node.status = 'done'
          node.settledAt = settledAt
          node.durationMs = settledAt - startedAt
          node.output = redactJsonValue(outcome.raw, svc.redact)
          record.status = 'completed'
          record.result = redactJsonValue(outcome.raw, svc.redact)
          delete record.error
          delete record.errorCode
        } else {
          node.status = aborted ? 'skipped' : 'failed'
          node.settledAt = settledAt
          node.durationMs = settledAt - startedAt
          const message = outcome.ok
            ? '宿主正在关停，后台子代理执行已中止'
            : outcome.error instanceof HelmxError
              ? `[${outcome.error.code}] ${outcome.error.message}`
              : outcome.error instanceof Error
                ? outcome.error.message
                : String(outcome.error)
          node.error = svc.redact(message)
          record.status = aborted ? 'aborted' : 'failed'
          record.error = svc.redact(message)
          if (record.status === 'failed') {
            record.errorCode = classifyRunFailureCode(outcome.ok ? undefined : outcome.error, message, 'subagent_failed')
          } else {
            delete record.errorCode
          }
        }
        record.nodes = redactNodes(svc.redact, [node])
        return { suspending }
      },
      getBackgroundNotifyInfo: () => {
        const executionInfo = getExecutionInfo()
        return {
          parentConversationId,
          ...(agentType !== undefined && agentType !== '' ? { agentType } : {}),
          ...(executionInfo !== undefined
            ? { execution: redactJsonValue(executionInfo, svc.redact) as typeof executionInfo }
            : {}),
        }
      },
      ...(cleanupParentSignal !== undefined ? { cleanupParentSignal } : {}),
      resolveDone,
    })
  }

  return { settle, reportSettleError, isSettled: () => settled }
}
