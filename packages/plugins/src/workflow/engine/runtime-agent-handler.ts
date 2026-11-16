/**
 * runtime-agent-handler.ts -- the host-side handler for `agent()` calls: the live attempt ring.
 *
 * Extracted from runtime.ts's handleAgent closure into an explicit dependency-injection module
 * (semantics preserved line by line): responsibility = call payload boundary validation and
 * ledger replay-hit adjudication (runtime-agent-replay.ts) -> live execution in the attempt ring
 * (pause gate / concurrency permits / manual skip / retry / maxAttempts auto-continuation retries / gate
 * exactly once) -> agent-row accounting and progress emission.
 *
 * Dependencies are injected via AgentCallContext (emit/respond/allocateIndex etc. constructed by runtime.ts's
 * Dependencies are injected via AgentCallContext (emit/respond/allocateIndex etc. constructed by
 * runtime.ts's runWorkflow); this module holds no worker or run terminal state -- fatal always flows
 */

import { extractWorkflowExecutionMeta } from '../../contracts.js'
import type { AgentExecutionInfo } from '@helm/protocol'
import type { WorkflowAgentEntry, WorkflowEntry } from './progress.js'
import type { JournalReplay } from './replay.js'
import type { AgentCallPayload, CompletedChild, WorkflowHost, WorkflowSpawnRequest, WorkflowSpawnResult } from './runtime-types.js'
import { agentRetryPrompt, applyGate, applySchema, executionInfoForMeta, preview, scopedResumeKey } from './runtime-validation.js'
import { type LiveAgent, RuntimeControl, Semaphore } from './runtime-control.js'
import type { AgentRecordInput } from './runtime-recorder.js'
import { resolveAgentReplayCall } from './runtime-agent-replay.js'
import { agentJournalKey } from './journal.js'

/** Run-level mutable counters (sharing the same object with the action handler / orchestration layer). */
export interface AgentRunCounters {
  agentCount: number
  replayedCount: number
  spentOutputTokens: number
}

/** All dependencies of handleAgentCall (constructed by runWorkflow; field meanings in runWorkflow). */
export interface AgentCallContext {
  host: WorkflowHost
  agentCap: number
  /** options.journal?.retryFailedCalls === true (failed goals get an independent retry budget on continuation). */
  retryFailedCalls: boolean
  /** Read the run terminal state (reads the current value on each call, matching the former closure-variable reads). */
  runState: { isAborted(): boolean; isSettled(): boolean }
  emit(entries: WorkflowEntry[]): void
  respond(callId: number, ok: boolean, value?: unknown, error?: string, fatal?: boolean): void
  allocateIndex(): number
  /** Best-effort agent-row accounting (write failures only count diagnostics, never interrupt the run). */
  recordAgent(entry: AgentRecordInput): Promise<void>
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
    base, index, scopeId, label, agentType, model, isolation, agentId, compiledSchema,
    keyInput, attemptLimit, queuedAt, recordAttempt,
  } = state
  let attempt = state.attempt
  let attemptIndex = state.attemptIndex
  let attemptPrompt = state.attemptPrompt
  let attemptKey = state.attemptKey
  let resumeTarget = state.resumeTarget
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

  /** Absorb execution-environment metadata into progress rows; the failure branch absorbs too -- conversationId/executionId are the basis for registering resume handles. */
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
      // Do not reuse an old gate report across attempts: each attempt's gate verdict must come from
      // this execution; an old failure/success posing as a new result would distort.
      if (attempt > 1) base.gate = undefined

      const startedAt = Date.now()
      ctx.emit([{ ...base, queuedAt, startedAt, ...attemptMark }])

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
          resumeTarget !== undefined && resumeAgent !== undefined
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
            // Gate exactly once: prefer an already-reported result via onGateResult/result.gate;
            // otherwise the host runs the fallback itself (if runGate is still missing, the precheck above already went fatal).
            result = await applyGate(result, payload.gate, agentId, runGate, base.gate, payload.gateTimeoutMs, base.effectiveCwd)
            if (result.gate !== undefined) base.gate = result.gate
          }
        } else {
          // The failure branch absorbs executionInfo too (§2.3: keep the metadata return
          // when the service fails), for failure-handle registration and progress rows.
          if (result.executionInfo !== undefined) absorbExecutionInfo(result.executionInfo)
          if (payload.gate !== undefined && result.gate !== undefined && base.gate === undefined) {
            base.gate = result.gate
          }
        }
        if (base.gate?.timedOut === true) result = { ...result, timedOut: true }
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        ctx.inflight.delete(agentId)
        live.started = false
        ctx.semaphore.release()
      }

      if (ctx.runState.isSettled()) return
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
      // Failed but the execution environment was observed (conversationId/executionId, incl. the
      // executionInfo returned by the service-failure branch): register a resume handle. Later
      // agent({ resume: label }) in the same scope can resume that sub-conversation and its worktree (design §2.3).
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
      // maxAttempts auto retry (sharing the same attempt ring with manual control.retry):
      // the failure reason is appended as an incremental block into the next attempt's prompt,
      // continuing edits in the same sub-conversation via resumeAgent, not a fresh conversation rerun.
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
