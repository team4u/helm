/**
 * run-settle.ts — workflow run 的终态结算（自 service.run 拆出的内部模块）。
 *
 * settleWorkflowRun 是 run 收尾的唯一出口：失败终态统一写入 record（内存
 * summary 只是镜像），writer 必关、active 必删、在途子会话中止必等待、宿主
 * onRunSettled 必等待结束——任何一步失败都不留假 running。后台 promise 的
 * rejection 被 done 吸收并由 record.error 如实上报，绝不 unhandled。
 */

import { redactJsonValue } from '@helm/protocol'
import type { ActiveRun } from './active-run.js'
import { nodesFromProgress, redactNodes, toSummary } from './run-summary.js'
import type { WorkflowRunResult } from './runtime.js'
import type { WorkflowServiceContext } from './service-context.js'

/**
 * 结算一个 workflow run（service.run 结算链调用；行为契约见模块头）。
 * @param resumeJournalIoErrors resume 旧账本的存量损行诊断（与引擎/写层损行合一）。
 */
export async function settleWorkflowRun(
  svc: WorkflowServiceContext,
  run: ActiveRun,
  resumeJournalIoErrors: string[] | undefined,
  result: WorkflowRunResult | undefined,
  failure?: unknown,
): Promise<void> {
  const record = run.record
  const runId = run.runId
  let settleFailure: unknown
  try {
    // 收尾前必须摘除 trailing timer：终态事件即将发布，窗口内补发会造成乱序。
    if (run.pendingEventTimer !== undefined) {
      clearTimeout(run.pendingEventTimer)
      run.pendingEventTimer = undefined
    }
    if (result !== undefined) {
      record.status = result.status === 'killed' ? 'aborted' : result.status
      if (result.error !== undefined) record.error = svc.redact(result.error)
      if (result.value !== undefined) record.result = redactJsonValue(result.value, svc.redact)
    } else {
      // runWorkflow 本身失败（坏 meta/语法/worker 启动异常/state 写失败续）。
      record.status = 'failed'
      const message = failure instanceof Error ? failure.message : failure !== undefined ? String(failure) : 'unknown workflow failure'
      record.error = svc.redact(message)
    }
    // 账本记账失败诊断（保守面：run 不中断，但绝不隐瞒）。
    // 三路来源合一：引擎 agent 行写失败（result 携带）+ resume 旧账本损行 +
    // writer 层 agent 行写失败计数；脱敏后 stderr 可见 + 入 record 诊断面。
    const journalIoErrors = [
      ...(result?.journalIoErrors ?? []),
      ...(resumeJournalIoErrors ?? []),
      ...(run.writer.agentIoErrors > 0
        ? [`${run.writer.agentIoErrors} journal agent-line append(s) failed (journal: ${run.journalPath})`]
        : []),
    ]
    if (journalIoErrors.length > 0) {
      const redacted = journalIoErrors.map((message) => svc.redact(message))
      // stderr 是宿主侧日志的最低保障可见面（与 persist/onRunSettled 失败同手法）。
      for (const message of redacted) {
        process.stderr.write(`workflow ${runId}: journal io error: ${message}\n`)
      }
      record.journalIoErrors = redacted
    }
    record.updatedAt = Date.now()
    // 只跟踪内建执行通道，不等待任意插件；取消后必须确认命令已退出，不能超时后假装完成清理。
    run.abort.abort()
    await Promise.allSettled([...run.pendingExecs])
    record.nodes = redactNodes(svc.redact, nodesFromProgress(run.progress))
    record.progress = run.timeline
    run.summary = toSummary(record)
    try {
      svc.writeRecord(record)
      await svc.state.flush?.()
    } catch (persistError) {
      // 持久化失败必须如实浮出（吞掉 = 下次读回假 running），但仍先完成清理。
      const persistMessage = persistError instanceof Error ? persistError.message : String(persistError)
      process.stderr.write(`workflow ${runId}: terminal state persist failed: ${persistMessage}\n`)
      run.summary = {
        ...run.summary,
        status: record.status,
        error: `${record.error ?? ''}\n[persist failed: ${persistMessage}]`.trim(),
      }
      run.settleError = persistError
    }
  } catch (settleError) {
    settleFailure = settleError
  } finally {
    try {
      await run.writer.close()
    } catch (closeError) {
      process.stderr.write(
        `workflow ${runId}: journal close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}\n`,
      )
    }
    // close 失败/持久化失败同样必须取消命令并等待执行通道和子会话中止结束。
    run.abort.abort()
    await Promise.allSettled([...run.pendingExecs])
    svc.active.delete(runId)
    if (run.pendingAborts.size > 0) {
      await Promise.allSettled([...run.pendingAborts])
    }
    // 宿主结算通知：每 run 恰一次；wait/close 经 done 等待它结束。
    if (svc.host.onRunSettled !== undefined) {
      try {
        await svc.host.onRunSettled({ ...run.summary })
      } catch (settledError) {
        // 结算清理失败显式进入诊断与 settleError，不破坏已落盘终态。
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
        run.settleError = run.settleError ?? settledError
      }
    }
    // 后台启动的 workflow run（notifyParentOnSettle）：终态落盘后向父会话
    // 投递结算通知——与 startBackgroundAgent 同款 outbox 语义（恰一次，
    // notifiedAt 防重复；失败/关停窗口不置位，init() 下次启动补发）。
    if (
      !svc.isClosed() &&
      record.notifyParentOnSettle === true &&
      record.notifiedAt === undefined &&
      svc.host.onBackgroundAgentSettled !== undefined
    ) {
      try {
        await svc.host.onBackgroundAgentSettled({ ...run.summary }, {
          parentConversationId: run.conversationId,
        })
        record.notifiedAt = Date.now()
        svc.writeRecord(record)
        await svc.state.flush?.()
      } catch (notifyError) {
        const message = notifyError instanceof Error ? notifyError.message : String(notifyError)
        process.stderr.write(`workflow ${runId}: onBackgroundAgentSettled failed: ${message}\n`)
      }
    }
    svc.emitEventSafe('workflow.updated', { run: { ...run.summary } })
    if (settleFailure !== undefined && run.settleError === undefined) {
      run.settleError = settleFailure
    }
  }
}
