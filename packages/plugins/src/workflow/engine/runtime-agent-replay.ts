/**
 * runtime-agent-replay.ts -- input validation and ledger replay-hit adjudication for `agent()` calls.
 *
 * Split out of runtime-agent-handler.ts (semantics preserved line by line): resolveAgentReplayCall covers
 * the first half of handleAgentCall -- payload boundary validation -> resume resolution -> ledger prefix
 * replay (failed-chain continuation / success cache / schema recheck / cached-resume guard); 'responded' =
 * already responded directly, 'live' = handed to runtime-agent-handler.ts with the attempt ring's mutable state.
 */

import { agentJournalKey, type AgentJournalKeyInput, type JournalWriteInput } from './journal.js'
import { compileJsonSchema, type CompiledSchema } from './json-schema.js'
import { HARD_MAX_SUBAGENT_DEPTH } from '../../contracts.js'
import type { WorkflowAgentEntry } from './progress.js'
import type { AgentCallPayload, CompletedChild } from './runtime-types.js'
import type { AgentCallContext } from './runtime-agent-handler.js'
import { agentRetryPrompt, applySchema, derivedLabel, isValidAttachments, isValidSecretNames, MAX_AGENT_ATTEMPTS, preview, readCallScope, scopedResumeKey } from './runtime-validation.js'

/** All mutable state handed to the live attempt ring after replay adjudication (base has absorbed execution/gate; the live ring keeps updating in place; the attempt-* fields keep evolving inside the live ring). */
export interface AgentLiveState {
  base: WorkflowAgentEntry
  index: number
  scopeId: number
  label: string
  agentType: string
  model: string | undefined
  isolation: 'worktree' | undefined
  agentId: string
  compiledSchema: CompiledSchema | undefined
  /** Fingerprint input for recomputing attemptKey (prompt/resume evolve per attempt; other fields unchanged). */
  keyInput: AgentJournalKeyInput
  attemptKey: string
  attemptPrompt: string
  attempt: number
  attemptIndex: number
  /** previousAttempts + maxAttempts: the total attempt cap for auto-continuation retries. */
  attemptLimit: number
  /** The resume target (a resume call or a failure-registered handle). */
  resumeTarget: CompletedChild | undefined
  queuedAt: number
  /** The accounting function for a single agent attempt (scope and invocationIndex filled by the closure; shared by both replay and live sides). */
  recordAttempt: (entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq' | 'scopePath' | 'scopeCallIndex'>) => Promise<void>
}

/** resolveAgentReplayCall's result: 'responded' = already responded directly (fatal / cache / final). */
export type AgentReplayResolution = { kind: 'responded' } | { kind: 'live'; state: AgentLiveState }

export async function resolveAgentReplayCall(ctx: AgentCallContext, callId: number, payload: AgentCallPayload): Promise<AgentReplayResolution> {
  const runGate = ctx.host.runGate?.bind(ctx.host)
  const resumeAgent = ctx.host.resumeAgent?.bind(ctx.host)
  if (payload.gate !== undefined && runGate === undefined) {
    ctx.respond(callId, false, undefined, 'This workflow host cannot run gate commands.', true)
    return { kind: 'responded' }
  }
  if (payload.resume !== undefined && resumeAgent === undefined) {
    ctx.respond(callId, false, undefined, 'This workflow host cannot resume agents.', true)
    return { kind: 'responded' }
  }
  for (const [name, value, upper] of [
    ['timeoutMs', payload.timeoutMs, 3_600_000],
    ['gateTimeoutMs', payload.gateTimeoutMs, 600_000],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1_000 || value > upper)) {
      ctx.respond(callId, false, undefined, `agent() opts.${name} must be an integer between 1000 and ${upper}.`, true)
      return { kind: 'responded' }
    }
  }
  if (payload.gateTimeoutMs !== undefined && payload.gate === undefined) {
    ctx.respond(callId, false, undefined, 'agent() opts.gateTimeoutMs requires opts.gate.', true)
    return { kind: 'responded' }
  }

  // scopeId is the scope namespace field (assigned by the worker's makeScope; root = 0).
  // Invalid shapes are rejected explicitly at the boundary: the worker message surface is untrusted, and nothing is silently clamped.
  if (payload.scopeId !== undefined && (!Number.isInteger(payload.scopeId) || payload.scopeId < 0)) {
    ctx.respond(callId, false, undefined, 'agent() opts.scopeId must be a non-negative integer.', true)
    return { kind: 'responded' }
  }
  const scopeId = payload.scopeId ?? 0
  const scope = readCallScope(payload)
  const { scopePath, scopeCallIndex } = scope

  let resumed: CompletedChild | undefined
  if (payload.resume !== undefined) {
    resumed = ctx.completedByLabel.get(scopedResumeKey(scopeId, payload.resume))
    if (resumed === undefined) {
      const known = [...ctx.completedByLabel.values()]
        .filter((child) => (child.scopeId ?? 0) === scopeId)
        .map((child) => child.label)
      ctx.respond(
        callId,
        false,
        undefined,
        ctx.counters.replayedCount > 0
          ? `agent() opts.resume: "${payload.resume}" was replayed from the resume journal, not run, so there is ` +
              'no conversation in this run to continue. Re-run without resumeFromRunId.'
          : `agent() opts.resume: no agent has completed under the label "${payload.resume}" in this run. ${
              known.length === 0
                ? 'No agent has completed yet.'
                : `Known labels: ${known.map((label) => `"${label}"`).join(', ')}.`
            }`,
        true,
      )
      return { kind: 'responded' }
    }
  // Match the ledger first; only when real execution is needed is a cached continuation without a live session rejected.
  }

  let compiledSchema: CompiledSchema | undefined
  if (payload.schema !== undefined) {
    const compilation = compileJsonSchema(payload.schema)
    if (!compilation.ok) {
      ctx.respond(callId, false, undefined, compilation.message, true)
      return { kind: 'responded' }
    }
    compiledSchema = compilation.compiled
  }

  // Host-boundary re-validation (the worker message surface is untrusted): invalid attachments are fatal,
  // never forwarded to the real host spawn/resume ports while sick.
  if (payload.attachments !== undefined && !isValidAttachments(payload.attachments)) {
    ctx.respond(callId, false, undefined, 'agent() opts.attachments must be an array of non-empty string artifact IDs.', true)
    return { kind: 'responded' }
  }
  // Same as above: secretNames is a secret-grant field; invalid shapes are rejected explicitly at the boundary (not silently dropped).
  if (payload.secretNames !== undefined && !isValidSecretNames(payload.secretNames)) {
    ctx.respond(callId, false, undefined, 'agent() opts.secretNames must be an array of non-empty string secret env names.', true)
    return { kind: 'responded' }
  }
  // Same as above: maxSubagentDepth is a policy-grant field; invalid values are rejected explicitly at the
  // boundary (no clamping, no silent dropping); sent down only for fresh spawns, while resume keeps the registered facts.
  if (
    payload.maxSubagentDepth !== undefined &&
    (!Number.isInteger(payload.maxSubagentDepth) ||
      payload.maxSubagentDepth < 1 ||
      payload.maxSubagentDepth > HARD_MAX_SUBAGENT_DEPTH)
  ) {
    ctx.respond(
      callId,
      false,
      undefined,
      `agent() opts.maxSubagentDepth must be an integer between 1 and ${HARD_MAX_SUBAGENT_DEPTH}.`,
      true,
    )
    return { kind: 'responded' }
  }
  // Same as above: maxAttempts is an auto-retry policy field; invalid values are rejected explicitly
  // (silently rewriting a policy value would distort retry semantics).
  if (
    payload.maxAttempts !== undefined &&
    (!Number.isInteger(payload.maxAttempts) ||
      payload.maxAttempts < 1 ||
      payload.maxAttempts > MAX_AGENT_ATTEMPTS)
  ) {
    ctx.respond(
      callId,
      false,
      undefined,
      `agent() opts.maxAttempts must be an integer between 1 and ${MAX_AGENT_ATTEMPTS}.`,
      true,
    )
    return { kind: 'responded' }
  }

  if (ctx.counters.agentCount >= ctx.agentCap) {
    ctx.respond(callId, false, undefined, `Workflow exceeded its cap of ${ctx.agentCap} agents.`, true)
    return { kind: 'responded' }
  }
  // The call position is assigned at initiation (agent and action share the total order); completion order plays no part.
  const index = ctx.allocateIndex()
  const recordAttempt = (entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq' | 'scopePath' | 'scopeCallIndex'>) =>
    ctx.recordAgent({ ...entry, ...scope, invocationIndex: index })
  ctx.counters.agentCount++
  const maxAttempts = payload.maxAttempts ?? 1
  const previousAttempts = ctx.retryFailedCalls && maxAttempts > 1
    ? ctx.replay.terminalFailureAttempt(scope) : 0
  const attemptLimit = previousAttempts + maxAttempts
  const logicalId = scopePath === 'root' ? String(scopeCallIndex) : `${scopePath}:${scopeCallIndex}`
  const agentId = resumed?.agentId ?? `wf-agent-${logicalId}`
  const label = payload.label ?? resumed?.label ?? derivedLabel(payload.prompt)
  // agentType defaults to 'assistant': helm's agentType is a Profile ID, and the host's
  // ProfileService.ensureDefault guarantees assistant exists (same source as root). Never inherit
  // the upstream 'general-purpose' -- helm has no such profile, and NativeSpawn's strict validation would hard-fail.
  const agentType = resumed?.agentType ?? payload.agentType ?? 'assistant'
  const model = resumed !== undefined ? resumed.model : payload.model
  const isolation = resumed !== undefined ? resumed.isolation : payload.isolation
  ctx.openLaunches.set(callId, label)

  const base: WorkflowAgentEntry = {
    type: 'workflow_agent',
    index,
    label,
    state: 'start',
    agentId,
    agentType,
    promptPreview: preview(payload.prompt),
    prompt: payload.prompt,
    ...(compiledSchema !== undefined ? { schema: compiledSchema.schema } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
    ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
    ...(payload.gate !== undefined ? { gateCommand: payload.gate } : {}),
  }

  const queuedAt = Date.now()
  ctx.emit([{ ...base, queuedAt }])

  const keyInput: AgentJournalKeyInput = {
    prompt: payload.prompt,
    label: payload.label,
    model: payload.model,
    agentType: payload.agentType,
    effort: payload.effort,
    isolation: payload.isolation,
    gate: payload.gate,
    resume: payload.resume,
    attachments: payload.attachments,
    maxSubagentDepth: payload.maxSubagentDepth,
    secretNames: payload.secretNames,
    cwd: payload.cwd,
    schema: payload.schema !== undefined ? JSON.stringify(payload.schema) : undefined,
  }
  const firstAttemptKey = agentJournalKey(keyInput)
  const firstHistory = ctx.replay.history(scope)
  const replayed = ctx.replay.match(scope, firstAttemptKey, 'agent', {
    attempt: 1,
    allowFailure: maxAttempts > 1 || (firstHistory?.type === 'agent' && (firstHistory.retryKind === 'manual' || firstHistory.skipped === true)),
    resumed: payload.resume !== undefined,
  })
  if (replayed.conflictError !== undefined) {
    ctx.respond(callId, false, undefined, replayed.conflictError, true)
    return { kind: 'responded' }
  }
  let replayedEntry = replayed.hit ? replayed.entry : undefined
  let attempt = 1
  let attemptIndex = index
  let attemptPrompt = payload.prompt!
  let attemptKey = firstAttemptKey
  let resumeTarget: CompletedChild | undefined = resumed
  while (replayedEntry?.type === 'agent' && !replayedEntry.ok) {
    const failed = replayedEntry
    const execution = failed.execution
    if (execution !== undefined) {
      base.nodeId = execution.nodeId
      base.conversationId = execution.conversationId
      base.executionId = execution.executionId
      base.effectiveCwd = execution.effectiveCwd
      base.worktree = execution.worktree as WorkflowAgentEntry['worktree']
    }
    base.gate = failed.gate
    const { v: _version, seq: _seq, type: _type, ...recorded } = failed
    ctx.counters.replayedCount++
    await recordAttempt({ ...recorded, index: attemptIndex })
    ctx.emit([{
      ...base, queuedAt, state: 'error', cached: true,
      attempt, error: failed.error ?? 'Agent failed.',
      ...(failed.skipped === true ? { skipped: true } : {}),
    }])
    const persistedHandle = execution?.executionId ??
      (execution?.conversationId !== undefined ? String(execution.conversationId) : undefined)
    const manualRetry = failed.retryKind === 'manual'
    const canRetry = failed.skipped !== true && (manualRetry ||
      (attempt < attemptLimit && persistedHandle !== undefined && resumeAgent !== undefined))
    if (!canRetry) {
      if (ctx.replay.history(scope, attempt + 1) !== undefined) {
        const conflict = ctx.replay.miss(scope)
        if (conflict.conflictError !== undefined) {
          ctx.respond(callId, false, undefined, conflict.conflictError, true)
          return { kind: 'responded' }
        }
      }
      if (persistedHandle !== undefined) ctx.completedByLabel.set(scopedResumeKey(scopeId, label), {
        agentId, label, agentType, scopeId, resumeRef: persistedHandle,
        ...(model !== undefined ? { model } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
      })
      ctx.respond(callId, true, payload.withMeta === true ? {
        ok: false, output: null, attempts: attempt, error: failed.error ?? 'Agent failed.',
        ...(failed.timedOut === true ? { timedOut: true } : {}),
        ...(execution !== undefined ? { execution } : {}),
        ...(failed.gate !== undefined ? { gate: failed.gate } : {}),
      } : null)
      return { kind: 'responded' }
    }
    if (!manualRetry) resumeTarget = {
      agentId, label, agentType, scopeId, resumeRef: persistedHandle!,
      ...(model !== undefined ? { model } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
    }
    attemptPrompt = manualRetry ? payload.prompt :
      agentRetryPrompt(payload.prompt, attempt, failed.error ?? 'Agent failed.')
    attempt++
    attemptIndex = ctx.allocateIndex()
    attemptKey = agentJournalKey({ ...keyInput, prompt: attemptPrompt,
      resume: resumeTarget === undefined ? payload.resume : agentId })
    const next = ctx.replay.match(scope, attemptKey, 'agent', {
      attempt, allowFailure: true, resumed: resumeTarget !== undefined,
    })
    if (next.conflictError !== undefined) {
      ctx.respond(callId, false, undefined, next.conflictError, true)
      return { kind: 'responded' }
    }
    replayedEntry = next.entry
  }
  if (replayedEntry !== undefined && replayedEntry.type === 'agent' && replayedEntry.ok && compiledSchema !== undefined) {
    const recheck = applySchema({ ok: true, text: replayedEntry.type === 'agent' ? replayedEntry.text ?? '' : '' }, compiledSchema)
    if (!recheck.ok) {
      replayedEntry = undefined
      const conflict = ctx.replay.miss(scope)
      if (conflict.conflictError !== undefined) {
        ctx.respond(callId, false, undefined, conflict.conflictError, true)
        return { kind: 'responded' }
      }
    }
  }
  if (replayedEntry !== undefined && replayedEntry.type === 'agent' && replayedEntry.ok) {
    const execution = replayedEntry.execution
    if (execution !== undefined) {
      base.nodeId = execution.nodeId
      base.conversationId = execution.conversationId
      base.executionId = execution.executionId
      base.effectiveCwd = execution.effectiveCwd
      base.worktree = execution.worktree as WorkflowAgentEntry['worktree']
    }
    base.gate = replayedEntry.gate
    base.prompt = replayedEntry.prompt ?? attemptPrompt
    base.promptPreview = preview(base.prompt)
    base.attempt = replayedEntry.attempt ?? attempt
    ctx.counters.replayedCount++
    const replayedText = replayedEntry.text ?? ''
    const nativeResumeRef =
      execution?.conversationId !== undefined && execution.executionId === undefined
        ? String(execution.conversationId)
        : undefined
    // Cache-node registration: native persistent sub-conversations (with a conversationId and no external executionId)
    // keep a resumeRef for later not-yet-ledgered agent({ resume: label }) to truly resume the atomic conversation;
    // external runtimes or pure cache records without a conversationId stay replayed: true (when a live continuation
    // is needed after a prefix mismatch, the replayed guard below fails explicitly).
    ctx.completedByLabel.set(scopedResumeKey(scopeId, label), {
      agentId,
      label,
      agentType,
      ...(model !== undefined ? { model } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
      scopeId,
      ...(nativeResumeRef !== undefined ? { resumeRef: nativeResumeRef } : { replayed: true }),
    })
    const at = Date.now()
    ctx.emit([
      {
        ...base,
        queuedAt,
        startedAt: at,
        lastProgressAt: at,
        durationMs: 0,
        state: 'done',
        cached: true,
        resultPreview: preview(replayedText),
      },
    ])
    ctx.openLaunches.delete(callId)
    // The cache branch keeps the resumed marker in accounting: the original call was a resume; the new ledger must be honest.
    await recordAttempt({
      index: attemptIndex,
      key: replayedEntry.key,
      ok: true,
      text: replayedText,
      ...(replayedEntry.type === 'agent' && replayedEntry.resumed === true ? { resumed: true } : {}),
      ...(replayedEntry.execution !== undefined ? { execution: replayedEntry.execution } : {}),
      ...(replayedEntry.gate !== undefined ? { gate: replayedEntry.gate } : {}),
      ...(replayedEntry.attempt !== undefined ? { attempt: replayedEntry.attempt } : {}),
      ...(replayedEntry.invocationIndex !== undefined ? { invocationIndex: replayedEntry.invocationIndex } : {}),
      ...(replayedEntry.prompt !== undefined ? { prompt: replayedEntry.prompt } : {}),
    })
    ctx.respond(callId, true, payload.withMeta === true ? {
      ok: true,
      output: replayedText,
      attempts: replayedEntry.attempt ?? 1,
      ...(replayedEntry.execution !== undefined ? { execution: replayedEntry.execution } : {}),
      ...(replayedEntry.gate !== undefined ? { gate: replayedEntry.gate } : {}),
    } : replayedText)
    return { kind: 'responded' }
  }

  // Prefix mismatch (incl. this call being new so the ledger lacks the position) while the resume target exists only
  // in cached sub-results: no live session to resume. Fail explicitly; never fabricate a continuation, never rerun
  // earlier actions to rebuild context.
  if (resumed?.replayed === true) {
    ctx.respond(
      callId,
      false,
      undefined,
      `agent() opts.resume: "${payload.resume}" only exists as a replayed (cached) context with no live ` +
        'conversation in this run to continue; a replayed context cannot be resumed. ' +
        'Re-run the workflow without resumeFromRunId.',
      true,
    )
    return { kind: 'responded' }
  }
  return {
    kind: 'live',
    state: { base, index, scopeId, label, agentType, model, isolation, agentId, compiledSchema, keyInput, attemptKey, attemptPrompt, attempt, attemptIndex, attemptLimit, resumeTarget, queuedAt, recordAttempt },
  }
}
