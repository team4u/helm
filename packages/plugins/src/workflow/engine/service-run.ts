/**
 * service-run.ts — workflow run 的启动主体与原位续跑入口。
 *
 * startWorkflowRun 承载完整 run() 流程：请求校验（name/script/scriptPath
 * 恰一、512KB 上限）、resume 目标解析与单一权威可续跑校验（inspectRunResumability）、
 * 接管标记与并发接管保留、running 快照先于副作用落盘、引擎 host 组装与后台执行链。
 */

import { mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import { HelmxError, redactJsonValue, type AgentSpawnRequest, type ConversationSummary } from '@helmx/protocol'
import { withWorkflowSpawnMeta, type WorkflowRunRequest, type WorkflowRunSummary } from '../../contracts.js'
import {
  JournalWriter,
  redactJournalEntry,
  type WorkflowJournalEntry,
} from './journal.js'
import {
  MAX_SCRIPT_LENGTH,
  normalizeWorkflowArgs,
  runWorkflow,
  type WorkflowRunResult,
} from './runtime.js'
import { resolveForegroundWaiters, type ActiveRun } from './active-run.js'
import { inspectRunResumability } from './run-resumability.js'
import { backgroundChildIds, newRunId, type RunRecord } from './run-store.js'
import { redactSummaryNodes, toSummary } from './run-summary.js'
import { settleWorkflowRun } from './run-settle.js'
import { makeRunProgressHandler } from './run-progress.js'
import { startBackgroundAgent } from './background-agent-runner.js'
import type { WorkflowServiceContext } from './service-context.js'

const SUBAGENT_RESUME_PROMPT = '前次执行中断或未通过验收，请检查当前工作区状态并继续完成原任务。'

/** 检查并占位原 run 的 resumedByRunId 接管标记（workflow 与 subagent 续接共用）。 */
async function claimResumeTakeover(
  svc: WorkflowServiceContext,
  replayFrom: RunRecord,
  newRunIdValue: string,
): Promise<() => void> {
  const currentMarker = svc.runs.load(replayFrom.id).resumedByRunId
  if (currentMarker !== undefined) {
    const takeover = svc.runs.inspectTakeoverMarker(currentMarker, replayFrom.conversationId, {
      reserved: svc.takeoverReservations.has(currentMarker),
      active: svc.active.has(currentMarker),
    })
    if (!takeover.ghost) {
      throw new HelmxError(
        'conflict',
        `运行 ${replayFrom.id} 已被 ${currentMarker} 接管续跑（${takeover.reason}）；请从接管的 run 继续或人工核查`,
        409,
        { runId: replayFrom.id, resumedByRunId: currentMarker },
      )
    }
    process.stderr.write(
      `workflow resume: clearing orphaned takeover marker ${currentMarker} on ${replayFrom.id}（索引与磁盘均无接管痕迹，确证从未写记录/账本）\n`,
    )
    replayFrom.resumedByRunId = undefined
  }
  svc.takeoverReservations.add(newRunIdValue)
  let reservationHeld = true
  const release = (): void => {
    if (reservationHeld) {
      reservationHeld = false
      svc.takeoverReservations.delete(newRunIdValue)
    }
  }
  try {
    replayFrom.resumedByRunId = newRunIdValue
    replayFrom.updatedAt = Date.now()
    svc.writeRecord(replayFrom)
    await svc.state.flush?.()
  } catch (error) {
    release()
    throw error
  }
  svc.emitEventSafe('workflow.updated', { run: redactSummaryNodes(svc.redact, svc.summaryOf(replayFrom)) })
  return release
}

/** 启动一个工作流 run：后台执行，立即返回 summary（不等完成）。 */
export async function startWorkflowRun(
  svc: WorkflowServiceContext,
  request: WorkflowRunRequest,
  context?: { parentToolCallId?: string; notifyParentOnSettle?: boolean; foreground?: boolean },
): Promise<WorkflowRunSummary> {
  svc.assertNotClosed()
  await svc.init()

  const parentToolCallId =
    typeof context?.parentToolCallId === 'string' && context.parentToolCallId !== ''
      ? context.parentToolCallId
      : undefined

  if (request.label !== undefined && (typeof request.label !== 'string' || request.label.trim() === '')) {
    throw new HelmxError('validation_error', 'label 必须为非空字符串', 400, { label: request.label })
  }
  const explicitLabel = request.label !== undefined ? svc.redact(request.label.trim()) : undefined

  const sources = [request.name, request.script, request.scriptPath].filter((v) => v !== undefined)
  if (sources.length > 1) {
    throw new HelmxError(
      'validation_error',
      'exactly one of name, script, scriptPath must be provided (or omit all to reuse the old script with resumeFromRunId)',
      400,
      { provided: sources.length },
    )
  }

  let replayFrom: RunRecord | undefined
  if (request.resumeFromRunId !== undefined) {
    replayFrom = svc.runs.load(request.resumeFromRunId)
    if (svc.active.has(replayFrom.id)) {
      throw new HelmxError('conflict', `工作流 ${replayFrom.id} 仍在运行中`, 409, { runId: replayFrom.id })
    }
    if (replayFrom.kind === 'subagent') {
      if (replayFrom.status === 'running') {
        replayFrom.status = 'failed'
        replayFrom.errorCode = 'interrupted'
        replayFrom.error = 'run interrupted（可经 resumeFromRunId 续接）'
        svc.writeRecord(replayFrom)
        await svc.state.flush?.()
      }
      if (sources.length > 0 && (replayFrom.status === 'failed' || replayFrom.status === 'aborted')) {
        throw new HelmxError(
          'validation_error',
          '对单子代理执行 resumeFromRunId 时不允许同时提供 name/script/scriptPath',
          400,
          { runId: replayFrom.id },
        )
      }
      const verdict = inspectRunResumability(replayFrom, svc.resumabilityContext(), { mode: 'explicit_resume' })
      if (!verdict.resumable) {
        throw new HelmxError(verdict.code, verdict.reason, 400, {
          runId: replayFrom.id,
          status: replayFrom.status,
        })
      }
      if (request.conversationId !== undefined && request.conversationId !== replayFrom.conversationId) {
        throw new HelmxError(
          'validation_error',
          `恢复目标不匹配：子代理 ${replayFrom.id} 属于会话 ${replayFrom.conversationId}，不能改在会话 ${request.conversationId} 下恢复`,
          400,
          {
            runId: replayFrom.id,
            recordedConversationId: replayFrom.conversationId,
            requestedConversationId: request.conversationId,
          },
        )
      }
      try {
        svc.host.getConversation(replayFrom.conversationId)
      } catch {
        throw new HelmxError('not_found', `会话 ${replayFrom.conversationId} 不存在，无法在其下续接子代理`, 404, {
          conversationId: replayFrom.conversationId,
        })
      }
      const spec = replayFrom.subagentSpec!
      const nextRunId = newRunId()
      const releaseTakeover = await claimResumeTakeover(svc, replayFrom, nextRunId)
      const foregroundContext = context?.foreground === true
      const spawnReq: AgentSpawnRequest = {
        parentConversationId: replayFrom.conversationId,
        prompt: SUBAGENT_RESUME_PROMPT,
        resume: verdict.resumeRef!,
        ...(spec.agentType !== undefined ? { agentType: spec.agentType } : {}),
        ...(spec.isolation !== undefined ? { isolation: spec.isolation } : {}),
        ...(spec.gate !== undefined ? { gate: spec.gate } : {}),
        ...(spec.gateTimeoutMs !== undefined ? { gateTimeoutMs: spec.gateTimeoutMs } : {}),
        ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
        ...(spec.maxSubagentDepth !== undefined
          ? { meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: spec.maxSubagentDepth }) }
          : {}),
      }
      const started = await startBackgroundAgent(svc, spawnReq, {
        ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
        ...(explicitLabel !== undefined
          ? { label: explicitLabel }
          : replayFrom.name !== ''
            ? { label: replayFrom.name }
            : {}),
        foreground: foregroundContext,
        notifyParentOnSettle: foregroundContext ? false : (context?.notifyParentOnSettle ?? true),
        preassigned: {
          runId: nextRunId,
          replayedFrom: replayFrom.id,
          autoResumeCount: (replayFrom.autoResumeCount ?? 0) + 1,
          onPersisted: releaseTakeover,
          onPersistFailed: releaseTakeover,
        },
      })
      return started.run
    }
    if (replayFrom.status === 'running') {
      replayFrom.status = 'failed'
      replayFrom.errorCode = 'interrupted'
      replayFrom.error = 'run interrupted（账本完好，可经 resumeFromRunId 恢复）'
      svc.writeRecord(replayFrom)
      await svc.state.flush?.()
    }
  }

  const conversationId = request.conversationId ?? replayFrom?.conversationId
  if (conversationId === undefined) {
    throw new HelmxError(
      'validation_error',
      '缺少工作流目标会话：提供 conversationId，或从 CLI 使用 --current；工具调用会使用当前会话',
      400,
    )
  }
  if (replayFrom !== undefined && request.conversationId !== undefined && request.conversationId !== replayFrom.conversationId) {
    throw new HelmxError(
      'validation_error',
      `恢复目标不匹配：工作流 ${replayFrom.id} 属于会话 ${replayFrom.conversationId}，不能改在会话 ${request.conversationId} 下恢复`,
      400,
      { runId: replayFrom.id, recordedConversationId: replayFrom.conversationId, requestedConversationId: request.conversationId },
    )
  }

  let parent: ConversationSummary
  try {
    parent = svc.host.getConversation(conversationId)
  } catch {
    throw new HelmxError('not_found', `会话 ${conversationId} 不存在，无法在其下运行工作流`, 404, {
      conversationId,
    })
  }

  let script: string
  let scriptPath: string | undefined
  let savedName: string | undefined
  let replayEntries: readonly WorkflowJournalEntry[] = []
  let resumeJournalIoErrors: string[] | undefined

  if (request.script !== undefined) {
    script = request.script
  } else if (request.name !== undefined) {
    savedName = request.name
    scriptPath = svc.library.resolveSavedName(request.name)
    script = svc.library.readScriptFile(scriptPath)
  } else if (request.scriptPath !== undefined) {
    scriptPath = svc.library.resolveExplicitPath(request.scriptPath)
    script = svc.library.readScriptFile(scriptPath)
  } else if (replayFrom === undefined) {
    throw new HelmxError('validation_error', '必须提供 name、script 或 scriptPath 之一', 400)
  } else {
    script = ''
  }

  if (replayFrom !== undefined) {
    const verdict = inspectRunResumability(replayFrom, svc.resumabilityContext(), {
      mode: 'explicit_resume',
      hasExplicitScriptOverride: sources.length > 0,
    })
    if (!verdict.resumable) {
      if (verdict.code === 'validation_error') {
        throw new HelmxError('validation_error', verdict.reason, 400, { runId: request.resumeFromRunId })
      }
      if (verdict.code === 'journal_read_failed') {
        throw new HelmxError('journal_read_failed', verdict.reason, 409, {
          priorRunId: replayFrom.id,
          journalPath: replayFrom.journalPath,
          ...(verdict.journal?.readFailed ?? {}),
        })
      }
      throw new HelmxError(verdict.code, verdict.reason, 409, {
        priorRunId: replayFrom.id,
        journalPath: replayFrom.journalPath,
        failedActions: verdict.journal?.failedActions ?? 0,
      })
    }
    if (sources.length === 0) {
      script = verdict.script!
      scriptPath = verdict.scriptPath
      savedName = verdict.savedName
    }
    const journal = verdict.journal!
    replayEntries = journal.entries
    if (journal.ioErrors > 0) {
      resumeJournalIoErrors = [
        `journal ${replayFrom.id} has ${journal.ioErrors} corrupt/unreadable line(s) (replayed from ${replayFrom.journalPath})`,
      ]
    }
  }

  if (script.length > MAX_SCRIPT_LENGTH) {
    throw new HelmxError(
      'validation_error',
      `工作流脚本 ${script.length} 字符，超过上限 ${MAX_SCRIPT_LENGTH}`,
      400,
      { length: script.length },
    )
  }

  let args: unknown
  if (request.args !== undefined) {
    args = normalizeWorkflowArgs(request.args)
  } else if (replayFrom?.args !== undefined) {
    args = replayFrom.args
  }

  const runId = newRunId()
  mkdirSync(svc.runs.artifactsDir(conversationId), { recursive: true })
  const journalPath = svc.runs.journalPathFor(conversationId, runId)

  let releaseTakeoverReservation: () => void = () => {}
  if (replayFrom !== undefined) {
    releaseTakeoverReservation = await claimResumeTakeover(svc, replayFrom, runId)
  }

  const abort = new AbortController()
  const createdAt = Date.now()
  const meta = svc.library.peekMeta(script)
  const foregroundContext = context?.foreground === true
  const scriptBase = scriptPath !== undefined ? basename(scriptPath, '.js') : undefined
  const fallbackScriptName = scriptBase !== undefined && scriptBase !== '' ? scriptBase : undefined

  const record: RunRecord = {
    id: runId,
    name: explicitLabel ?? meta?.name ?? replayFrom?.name ?? fallbackScriptName ?? runId,
    conversationId,
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
    status: 'running',
    createdAt,
    updatedAt: createdAt,
    kind: 'workflow',
    ...(!foregroundContext &&
      (context?.notifyParentOnSettle === true || replayFrom?.notifyParentOnSettle === true)
      ? { notifyParentOnSettle: true }
      : {}),
    ...(foregroundContext ? { syncForeground: true } : {}),
    ...(replayFrom !== undefined ? { autoResumeCount: (replayFrom.autoResumeCount ?? 0) + 1 } : {}),
    ...(meta?.description !== undefined ? { description: svc.redact(meta.description) } : {}),
    ...(meta?.phases !== undefined
      ? { phases: redactJsonValue(meta.phases, svc.redact) as RunRecord['phases'] }
      : {}),
    ...(scriptPath === undefined ? { script } : {}),
    ...(scriptPath !== undefined ? { scriptPath } : {}),
    ...(savedName !== undefined ? { savedName } : {}),
    ...(args !== undefined ? { args: redactJsonValue(args, svc.redact) } : {}),
    journalPath,
    ...(replayFrom !== undefined ? { replayedFrom: replayFrom.id } : {}),
  }

  let resolveRunDone: () => void = () => {}
  const doneGate = new Promise<void>((resolve) => {
    resolveRunDone = resolve
  })
  const writer = new JournalWriter(journalPath)
  const run: ActiveRun = {
    runId,
    conversationId,
    abort,
    record,
    done: doneGate,
    summary: toSummary(record),
    journalPath,
    writer,
    progress: [],
    timeline: [],
    pendingAborts: new Set(),
    pendingExecs: new Set(),
    childConversations: new Set(),
    foregroundWaiters: new Set(),
    lastPersistAt: createdAt,
    lastNodeEventAt: createdAt,
  }

  try {
    svc.assertNotClosed()
    svc.cancellation.assertNotCancelling(conversationId)
  } catch (error) {
    releaseTakeoverReservation()
    throw error
  }
  svc.active.set(runId, run)

  try {
    svc.writeRecord(record)
    releaseTakeoverReservation()
    await svc.state.flush?.()
  } catch (error) {
    releaseTakeoverReservation()
    await writer.close().catch(() => {})
    svc.active.delete(runId)
    resolveRunDone()
    resolveForegroundWaiters(run, 'settled')
    throw error
  }
  svc.emitEventSafe('workflow.updated', { run: redactSummaryNodes(svc.redact, { ...run.summary }) })

  const engineHost = svc.makeEngineHost(run, parent)
  const onProgress = makeRunProgressHandler(svc, run)

  void (async () => {
    let result: WorkflowRunResult | undefined
    let failure: unknown
    try {
      result = await runWorkflow({
        runId,
        script,
        ...(args !== undefined ? { args } : {}),
        host: engineHost,
        signal: abort.signal,
        isSuspended: () => svc.isRunSuspending(run),
        ...svc.caps,
        ...(svc.redact !== undefined ? { redact: svc.redact } : {}),
        onProgress,
        journal: {
          ...(replayEntries.length > 0 ? { entries: replayEntries } : {}),
          retryFailedCalls: replayFrom?.status === 'failed',
          append: async (entry) => {
            await writer.append(redactJournalEntry(entry, svc.redact))
          },
        },
      })
    } catch (error) {
      failure = error
    }
    try {
      await settleWorkflowRun(svc, run, resumeJournalIoErrors, result, failure)
    } catch (error) {
      process.stderr.write(
        `workflow ${runId}: settle crashed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      run.settleError = run.settleError ?? error
    }
    resolveRunDone()
  })()

  return { ...run.summary }
}

/** 同 runId 原位续跑 DSL 工作流（重启恢复阶段调用）。 */
export function resumeWorkflowInPlace(
  svc: WorkflowServiceContext,
  record: RunRecord,
  options: {
    script: string
    journalEntries: readonly WorkflowJournalEntry[]
    initialSeq: number
    resumeJournalIoErrors?: string[]
  },
): { horizonGate: Promise<void> } {
  const runId = record.id
  const parent = svc.host.getConversation(record.conversationId)
  const abort = new AbortController()
  let resolveRunDone: () => void = () => {}
  const doneGate = new Promise<void>((resolve) => {
    resolveRunDone = resolve
  })
  let resolveHorizon: () => void = () => {}
  const horizonGate = new Promise<void>((resolve) => {
    resolveHorizon = resolve
  })

  const writer = new JournalWriter(record.journalPath, true, options.initialSeq)
  const run: ActiveRun = {
    runId,
    conversationId: record.conversationId,
    abort,
    record,
    done: doneGate,
    summary: toSummary(record),
    journalPath: record.journalPath,
    writer,
    progress: [],
    timeline: record.progress ? [...record.progress] : [],
    pendingAborts: new Set(),
    pendingExecs: new Set(),
    childConversations: new Set(backgroundChildIds(record)),
    foregroundWaiters: new Set(),
    lastPersistAt: Date.now(),
    lastNodeEventAt: Date.now(),
  }
  svc.active.set(runId, run)

  const engineHost = svc.makeEngineHost(run, parent)
  const onProgress = makeRunProgressHandler(svc, run)

  void (async () => {
    let result: WorkflowRunResult | undefined
    let failure: unknown
    try {
      result = await runWorkflow({
        runId,
        script: options.script,
        ...(record.args !== undefined ? { args: record.args } : {}),
        host: engineHost,
        signal: abort.signal,
        isSuspended: () => svc.isRunSuspending(run),
        onReattachHorizon: resolveHorizon,
        ...svc.caps,
        ...(svc.redact !== undefined ? { redact: svc.redact } : {}),
        onProgress,
        journal: {
          entries: options.journalEntries,
          inPlaceResume: true,
          retryFailedCalls: false,
          append: async (entry) => {
            await writer.append(redactJournalEntry(entry, svc.redact))
          },
        },
      })
    } catch (error) {
      failure = error
    } finally {
      resolveHorizon()
    }
    try {
      await settleWorkflowRun(svc, run, options.resumeJournalIoErrors, result, failure)
    } catch (error) {
      process.stderr.write(
        `workflow ${runId}: in-place resume settle crashed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      run.settleError = run.settleError ?? error
    }
    resolveRunDone()
  })()

  return { horizonGate }
}
