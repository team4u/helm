/**
 * runtime-agent-handler.ts — `agent()` 调用的宿主侧 handler：live attempt 环。
 *
 * 自 runtime.ts 的 handleAgent 闭包提取为显式依赖注入模块（语义逐行保持）：
 * 职责 = 调用载荷边界校验与账本重放命中判定（runtime-agent-replay.ts）→
 * attempt 环 live 执行（暂停门 / 并发许可 / 手动 skip / retry / maxAttempts
 * 自动续接重试 / gate 恰好一次）→ agent 行记账与进度发射。
 *
 * 依赖经 AgentCallContext 注入（emit/respond/allocateIndex 等由 runtime.ts
 * 的 runWorkflow 构造），本模块不持有 worker 与 run 终态，fatal 一律经
 * respond(…, true) 回流，由编排层统一 finish。
 */

import { extractWorkflowExecutionMeta } from '../../contracts.js'
import type { AgentExecutionInfo } from '@helm/protocol'
import type { WorkflowAgentEntry, WorkflowEntry } from './progress.js'
import type { JournalReplay } from './replay.js'
import type { AgentCallPayload, CompletedChild, WorkflowHost, WorkflowSpawnRequest, WorkflowSpawnResult } from './runtime-types.js'
import { agentRetryPrompt, applyGate, applySchema, executionInfoForMeta, preview, scopedResumeKey } from './runtime-validation.js'
import { type LiveAgent, RuntimeControl, Semaphore } from './runtime-control.js'
import type { AgentRecordInput, AgentStartedRecordInput } from './runtime-recorder.js'
import { resolveAgentReplayCall } from './runtime-agent-replay.js'
import { agentJournalKey } from './journal.js'

/** run 级可变计数（与 action handler / 编排层共享同一对象）。 */
export interface AgentRunCounters {
  agentCount: number
  replayedCount: number
  spentOutputTokens: number
}

/** handleAgentCall 的全部依赖（由 runWorkflow 构造；字段含义见 runWorkflow）。 */
export interface AgentCallContext {
  runId?: string
  inPlaceResume?: boolean
  host: WorkflowHost
  agentCap: number
  /** options.journal?.retryFailedCalls === true（失败目标续跑独立重试预算）。 */
  retryFailedCalls: boolean
  /** run 终态读取（每次调用读当前值，与原闭包变量读取语义一致）。 */
  runState: { isAborted(): boolean; isSettled(): boolean; isSuspended?(): boolean }
  emit(entries: WorkflowEntry[]): void
  respond(callId: number, ok: boolean, value?: unknown, error?: string, fatal?: boolean): void
  allocateIndex(): number
  /** agent 行尽力记账（写失败仅诊断计数，不中断 run）。 */
  recordAgent(entry: AgentRecordInput): Promise<void>
  /** agent_started 行记账（onResolved 落盘后供重启原位重挂使用）。 */
  recordAgentStarted?(entry: AgentStartedRecordInput): Promise<void>
  /** 通知 runWorkflow 原生 agent_started 的 onResolved 重挂已完成。 */
  markNativeReattachResolved?(coordKey: string): void
  inflight: Set<string>
  semaphore: Semaphore
  control: RuntimeControl
  completedByLabel: Map<string, CompletedChild>
  openLaunches: Map<number, string>
  replay: JournalReplay
  counters: AgentRunCounters
  redactText: (text: string) => string
}

export async function handleAgentCall(ctx: AgentCallContext, callId: number, payload: AgentCallPayload): Promise<void> {
  const resolution = await resolveAgentReplayCall(ctx, callId, payload)
  if (resolution.kind !== 'live') return
  const state = resolution.state
  const {
    base, index, scope, scopeId, label, agentType, model, isolation, agentId, compiledSchema,
    keyInput, attemptLimit, queuedAt, recordAttempt,
  } = state
  let attempt = state.attempt
  let attemptIndex = state.attemptIndex
  let attemptPrompt = state.attemptPrompt
  let attemptKey = state.attemptKey
  let resumeTarget = state.resumeTarget
  let reattachEntry = state.reattachEntry
  const runGate = ctx.host.runGate?.bind(ctx.host)
  const resumeAgent = ctx.host.resumeAgent?.bind(ctx.host)

  const settleSkipped = async (extra: Partial<WorkflowAgentEntry>) => {
    await recordAttempt({
      index: attemptIndex, key: attemptKey,
      prompt: attemptPrompt, ok: false, attempt, skipped: true, error: 'Skipped by user.',
      ...(resumeTarget !== undefined ? { resumed: true } : {}),
    })
    ctx.emit([{ ...base, queuedAt, ...extra, state: 'error', skipped: true, error: 'Skipped by user.' }])
    ctx.respond(callId, true, payload.withMeta === true ? {
      ok: false, output: null, attempts: attempt, error: 'Skipped by user.',
    } : null)
  }

  const live: LiveAgent = { agentId, started: false }
  ctx.control.liveAgents.set(index, live)
  const intent = (): LiveAgent['intent'] => live.intent

  /** 吸收执行环境元数据到进度行；失败分支同样吸收——conversationId/executionId 是登记续接句柄的依据。 */
  const absorbExecutionInfo = (info: AgentExecutionInfo): void => {
    if (info.nodeId !== undefined) base.nodeId = info.nodeId
    if (info.conversationId !== undefined) base.conversationId = info.conversationId
    if (info.executionId !== undefined) base.executionId = info.executionId
    if (info.effectiveCwd !== undefined) base.effectiveCwd = info.effectiveCwd
    const wfExecMeta = extractWorkflowExecutionMeta(info)
    if (wfExecMeta.worktree !== undefined) base.worktree = wfExecMeta.worktree
  }
  try {
    for (;;) {
      await ctx.control.pauseGate(live)
      if (intent() === 'skip') return settleSkipped({})

      await ctx.semaphore.acquire()
      if (ctx.runState.isAborted() || ctx.runState.isSettled()) {
        ctx.semaphore.release()
        ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
        return
      }
      if (ctx.control.isPaused() && !ctx.runState.isAborted() && !ctx.runState.isSettled()) {
        ctx.semaphore.release()
        continue
      }
      if (intent() === 'skip') {
        ctx.semaphore.release()
        return settleSkipped({})
      }

      const attemptMark = { attempt }
      base.prompt = attemptPrompt
      base.promptPreview = preview(attemptPrompt)
      // 跨尝试不沿用旧 gate 回报：每次尝试的 gate 结论必须来自本次执行，
      // 旧失败/旧成功冒充新结果都会失真。
      if (attempt > 1) base.gate = undefined

      const startedAt = Date.now()
      ctx.emit([{ ...base, queuedAt, startedAt, ...attemptMark }])

      const currentReattach = reattachEntry
      reattachEntry = undefined
      const coordKey = JSON.stringify([scope.scopePath, scope.scopeCallIndex, attempt])
      const spawnRequestId =
        currentReattach !== undefined
          ? currentReattach.requestId
          : ctx.runId !== undefined
            ? `helm:spawn:${ctx.runId}:${scope.scopePath}:${scope.scopeCallIndex}:${attempt}`
            : undefined
      let pendingStartedWrite: Promise<void> | undefined

      const onResolved: NonNullable<WorkflowSpawnRequest['onResolved']> = (info) => {
        if (info.nodeId !== undefined) base.nodeId = info.nodeId
        if (info.conversationId !== undefined) base.conversationId = info.conversationId
        if (info.executionId !== undefined) base.executionId = info.executionId
        if (info.effectiveCwd !== undefined) base.effectiveCwd = info.effectiveCwd
        const wfExecMeta = extractWorkflowExecutionMeta(info)
        if (wfExecMeta.worktree !== undefined) base.worktree = wfExecMeta.worktree
        if (info.modelName !== undefined) base.model = info.modelName
        if (info.thinking !== undefined) base.thinking = info.thinking
        if (info.requestedThinking !== undefined) base.requestedThinking = info.requestedThinking
        if (info.requestedModel !== undefined) base.requestedModel = info.requestedModel
        if (!ctx.inflight.has(agentId)) return
        if (currentReattach !== undefined) {
          ctx.markNativeReattachResolved?.(coordKey)
        } else if (
          pendingStartedWrite === undefined &&
          spawnRequestId !== undefined &&
          ctx.recordAgentStarted !== undefined
        ) {
          const execSnapshot = executionInfoForMeta(base)
          if (execSnapshot !== undefined) {
            pendingStartedWrite = ctx.recordAgentStarted({
              ...scope,
              index: attemptIndex,
              key: attemptKey,
              attempt,
              invocationIndex: index,
              requestId: spawnRequestId,
              execution: execSnapshot,
            })
          }
        }
        ctx.emit([{ ...base, queuedAt, startedAt, ...attemptMark, lastProgressAt: Date.now() }])
      }
      const onGateResult: NonNullable<WorkflowSpawnRequest['onGateResult']> = (gateResult) => {
        base.gate = gateResult
        if (!ctx.inflight.has(agentId)) return
        ctx.emit([{ ...base, queuedAt, startedAt, ...attemptMark, lastProgressAt: Date.now() }])
      }
      live.started = true
      ctx.inflight.add(agentId)

      let result: WorkflowSpawnResult
      try {
        result =
          currentReattach !== undefined
            ? await ctx.host.spawnAgent({
                agentId,
                index: attemptIndex,
                prompt: attemptPrompt,
                label,
                agentType,
                ...(model !== undefined ? { model } : {}),
                ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
                ...(payload.maxSubagentDepth !== undefined ? { maxSubagentDepth: payload.maxSubagentDepth } : {}),
                ...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
                ...(isolation !== undefined ? { isolation } : {}),
                ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
                ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
                ...(payload.gate !== undefined ? { gate: payload.gate } : {}),
                ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
                ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
                ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
                ...(payload.gateTimeoutMs !== undefined ? { gateTimeoutMs: payload.gateTimeoutMs } : {}),
                requestId: currentReattach.requestId,
                reattach: {
                  ...(currentReattach.execution.conversationId !== undefined
                    ? { conversationId: currentReattach.execution.conversationId }
                    : {}),
                  ...(currentReattach.execution.executionId !== undefined
                    ? { executionId: currentReattach.execution.executionId }
                    : {}),
                  ...(currentReattach.execution.effectiveCwd !== undefined
                    ? { effectiveCwd: currentReattach.execution.effectiveCwd }
                    : {}),
                },
                onResolved,
                ...(payload.gate !== undefined ? { onGateResult } : {}),
              })
            : resumeTarget !== undefined && resumeAgent !== undefined
            ? await resumeAgent(resumeTarget.agentId, attemptPrompt, {
                ...(resumeTarget.resumeRef !== undefined ? { resumeRef: resumeTarget.resumeRef } : {}),
                ...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
                ...(payload.gate !== undefined ? { gate: payload.gate } : {}),
                ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
                ...(payload.maxSubagentDepth !== undefined ? { maxSubagentDepth: payload.maxSubagentDepth } : {}),
                ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
                ...(payload.gateTimeoutMs !== undefined ? { gateTimeoutMs: payload.gateTimeoutMs } : {}),
                onResolved,
                ...(payload.gate !== undefined ? { onGateResult } : {}),
              })
            : await ctx.host.spawnAgent({
                agentId,
                index: attemptIndex,
                prompt: attemptPrompt,
                label,
                agentType,
                ...(model !== undefined ? { model } : {}),
                ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
                ...(payload.maxSubagentDepth !== undefined ? { maxSubagentDepth: payload.maxSubagentDepth } : {}),
                ...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
                ...(isolation !== undefined ? { isolation } : {}),
                ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
                ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
                ...(payload.gate !== undefined ? { gate: payload.gate } : {}),
                ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
                ...(payload.secretNames !== undefined ? { secretNames: payload.secretNames } : {}),
                ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
                ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
                ...(payload.gateTimeoutMs !== undefined ? { gateTimeoutMs: payload.gateTimeoutMs } : {}),
                ...(spawnRequestId !== undefined ? { requestId: spawnRequestId } : {}),
                onResolved,
                ...(payload.gate !== undefined ? { onGateResult } : {}),
              })
        if (result.ok) {
          ctx.completedByLabel.set(scopedResumeKey(scopeId, label), {
            agentId,
            label,
            agentType,
            ...(model !== undefined ? { model } : {}),
            ...(isolation !== undefined ? { isolation } : {}),
            scopeId,
          })
          if (result.executionInfo !== undefined) absorbExecutionInfo(result.executionInfo)
          if (result.gate !== undefined && base.gate === undefined) base.gate = result.gate
          if (compiledSchema !== undefined && result.ok) {
            result = applySchema(result, compiledSchema)
          }
          if (result.ok && payload.gate !== undefined) {
            // gate 恰好一次：优先 onGateResult/result.gate 已回报结果；
            // 否则宿主自跑 fallback（仍缺 runGate 则上方前置检查已 fatal）。
            result = await applyGate(result, payload.gate, agentId, runGate, base.gate, payload.gateTimeoutMs, base.effectiveCwd)
            if (result.gate !== undefined) base.gate = result.gate
          }
        } else {
          // 失败分支同样吸收 executionInfo（§2.3：service 失败时保留元数据
          // 回传），供失败句柄登记与进度行使用。
          if (result.executionInfo !== undefined) absorbExecutionInfo(result.executionInfo)
          if (payload.gate !== undefined && result.gate !== undefined && base.gate === undefined) {
            base.gate = result.gate
          }
        }
        if (base.gate?.timedOut === true) result = { ...result, timedOut: true }
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        if (currentReattach !== undefined) ctx.markNativeReattachResolved?.(coordKey)
        ctx.inflight.delete(agentId)
        live.started = false
        ctx.semaphore.release()
      }

      if (pendingStartedWrite !== undefined) await pendingStartedWrite
      if (ctx.runState.isSettled() || ctx.runState.isSuspended?.() === true) return
      if (intent() === 'skip') return settleSkipped({})

      if (intent() === 'retry' && !ctx.runState.isAborted()) {
        live.intent = undefined
        const retryError = ctx.redactText(result.error ?? 'Agent failed.')
        const retryExecution = executionInfoForMeta(base)
        await recordAttempt({
          index: attemptIndex,
          key: attemptKey,
          ok: false,
          ...(resumeTarget !== undefined ? { resumed: true } : {}),
          attempt,
          invocationIndex: index,
          prompt: attemptPrompt,
          retryKind: 'manual',
          error: retryError,
          ...(result.timedOut === true ? { timedOut: true } : {}),
          ...(retryExecution !== undefined ? { execution: retryExecution } : {}),
          ...(base.gate !== undefined ? { gate: base.gate } : {}),
        })
        attempt++
        attemptIndex = ctx.allocateIndex()
        attemptPrompt = payload.prompt
        attemptKey = agentJournalKey({ ...keyInput, prompt: attemptPrompt,
          resume: resumeTarget === undefined ? payload.resume : agentId })
        ctx.emit([{ ...base, queuedAt, attempt }])
        continue
      }

      ctx.counters.spentOutputTokens += result.outputTokens ?? 0

      const finishedAt = Date.now()
      const common = {
        ...base,
        queuedAt,
        startedAt,
        ...attemptMark,
        lastProgressAt: finishedAt,
        durationMs: finishedAt - startedAt,
        ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
        ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
      }
      if (result.ok) {
        const text = result.text ?? ''
        ctx.emit([{ ...common, state: 'done', resultPreview: preview(text) }])
        const execution = executionInfoForMeta(base)
        await recordAttempt({
          index: attemptIndex,
          key: attemptKey,
          ok: true,
          text,
          ...(resumeTarget !== undefined ? { resumed: true } : {}),
          attempt,
          invocationIndex: index,
          prompt: attemptPrompt,
          ...(execution !== undefined ? { execution } : {}),
          ...(base.gate !== undefined ? { gate: base.gate } : {}),
        })
        ctx.respond(callId, true, payload.withMeta === true ? {
          ok: true, output: text, attempts: attempt,
          ...(execution !== undefined ? { execution } : {}),
          ...(base.gate !== undefined ? { gate: base.gate } : {}),
        } : text)
        return
      }
      // 失败但已观察到执行环境（conversationId/executionId，含 service 失败
      // 分支回传的 executionInfo）：登记续接句柄。同 scope 后续
      // agent({ resume: label }) 可续接该子会话与其 Worktree（设计 §2.3）。
      const failureHandle: CompletedChild | undefined =
        base.conversationId !== undefined || base.executionId !== undefined
          ? {
              agentId,
              label,
              agentType,
              ...(model !== undefined ? { model } : {}),
              ...(isolation !== undefined ? { isolation } : {}),
              scopeId,
            }
          : undefined
      if (failureHandle !== undefined) {
        ctx.completedByLabel.set(scopedResumeKey(scopeId, label), failureHandle)
      }
      // maxAttempts 自动重试（与手动 control.retry 共用同一 attempt 环）：
      // 失败原因以增量块追加进下次尝试 prompt，经 resumeAgent 续接同一
      // 子会话继续修改，而非另起新会话重跑。
      if (failureHandle !== undefined && attempt < attemptLimit && resumeAgent !== undefined) {
        const failedError = ctx.redactText(result.error ?? 'Agent failed.')
        const execution = executionInfoForMeta(base)
        await recordAttempt({
          index: attemptIndex,
          key: attemptKey,
          ok: false,
          ...(resumeTarget !== undefined ? { resumed: true } : {}),
          attempt,
          invocationIndex: index,
          prompt: attemptPrompt,
          error: failedError,
          ...(result.timedOut === true ? { timedOut: true } : {}),
          ...(execution !== undefined ? { execution } : {}),
          ...(base.gate !== undefined ? { gate: base.gate } : {}),
        })
        attemptPrompt = agentRetryPrompt(payload.prompt!, attempt, failedError)
        attempt++
        const resumeRef = base.executionId ?? (base.conversationId !== undefined ? String(base.conversationId) : undefined)
        resumeTarget = {
          ...failureHandle,
          ...(resumeRef !== undefined ? { resumeRef } : {}),
        }
        attemptIndex = ctx.allocateIndex()
        attemptKey = agentJournalKey({ ...keyInput, prompt: attemptPrompt, resume: agentId })
        ctx.emit([{ ...base, queuedAt, attempt }])
        continue
      }
      const execution = executionInfoForMeta(base)
      await recordAttempt({
        index: attemptIndex,
        key: attemptKey,
        ok: false,
        ...(resumeTarget !== undefined ? { resumed: true } : {}),
        attempt,
        invocationIndex: index,
        prompt: attemptPrompt,
        error: result.error ?? 'Agent failed.',
        ...(result.timedOut === true ? { timedOut: true } : {}),
        ...(execution !== undefined ? { execution } : {}),
        ...(base.gate !== undefined ? { gate: base.gate } : {}),
      })
      ctx.emit([
        {
          ...common,
          state: 'error',
          error: result.error ?? 'Agent failed.',
          ...(result.skipped ? { skipped: true } : {}),
        },
      ])
      ctx.respond(callId, true, payload.withMeta === true ? {
        ok: false,
        output: null,
        attempts: attempt,
        error: result.error ?? 'Agent failed.',
        ...(result.timedOut === true ? { timedOut: true } : {}),
        ...(execution !== undefined ? { execution } : {}),
        ...(base.gate !== undefined ? { gate: base.gate } : {}),
      } : null)
      return
    }
  } finally {
    ctx.control.liveAgents.delete(index)
  }
}
