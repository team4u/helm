/**
 * runtime-agent-replay.ts — `agent()` 调用的入参校验与账本重放命中判定。
 *
 * 自 runtime-agent-handler.ts 拆出（语义逐行保持）：resolveAgentReplayCall 覆盖
 * handleAgentCall 前半程——载荷边界校验 → resume 解析 → 账本前缀重放（失败链续跑 /
 * 成功缓存 / schema 复检 / 缓存 resume 守卫）；'responded' = 已直接 respond，
 * 'live' = 携带 attempt 环可变状态交 runtime-agent-handler.ts 执行。
 */

import { agentJournalKey, type AgentJournalKeyInput, type JournalWriteInput } from './journal.js'
import { compileJsonSchema, type CompiledSchema } from './json-schema.js'
import { HARD_MAX_SUBAGENT_DEPTH } from '../../contracts.js'
import type { WorkflowAgentEntry } from './progress.js'
import type { AgentCallPayload, CompletedChild } from './runtime-types.js'
import type { AgentCallContext } from './runtime-agent-handler.js'
import { agentRetryPrompt, applySchema, derivedLabel, isValidAttachments, isValidSecretNames, MAX_AGENT_ATTEMPTS, preview, readCallScope, scopedResumeKey } from './runtime-validation.js'

/** replay 判定完成后交棒 live attempt 环的全部可变状态（base 已吸收 execution/gate，live 环继续原地更新；attempt 系列字段在 live 环内继续演化）。 */
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
  /** 重算 attemptKey 的指纹输入（prompt/resume 随尝试演化，其余字段不变）。 */
  keyInput: AgentJournalKeyInput
  attemptKey: string
  attemptPrompt: string
  attempt: number
  attemptIndex: number
  /** previousAttempts + maxAttempts：自动续接重试的总尝试上限。 */
  attemptLimit: number
  /** 续接目标（resume 调用或失败登记句柄）。 */
  resumeTarget: CompletedChild | undefined
  queuedAt: number
  /** agent 单次尝试的记账函数（scope 与 invocationIndex 由闭包补齐；replay/live 两侧共用）。 */
  recordAttempt: (entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq' | 'scopePath' | 'scopeCallIndex'>) => Promise<void>
}

/** resolveAgentReplayCall 的结果：'responded' = 已直接 respond（fatal / 缓存 / 终局）。 */
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

  // scopeId 是 scope 命名空间字段（worker makeScope 分配，根 = 0）。
  // 非法形状在边界显式拒绝：不信任 worker 消息面，也不静默钳制。
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
    // 先匹配账本；只有真正需要执行时，才拒绝无活会话的缓存续接。
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

  // host 边界二次校验（不信任 worker 消息面）：非法 attachments 是 fatal，
  // 绝不带病下发到真实宿主 spawn/resume 端口。
  if (payload.attachments !== undefined && !isValidAttachments(payload.attachments)) {
    ctx.respond(callId, false, undefined, 'agent() opts.attachments must be an array of non-empty string artifact IDs.', true)
    return { kind: 'responded' }
  }
  // 同上：secretNames 是机密授予字段，非法形状在边界显式拒绝（不静默丢弃）。
  if (payload.secretNames !== undefined && !isValidSecretNames(payload.secretNames)) {
    ctx.respond(callId, false, undefined, 'agent() opts.secretNames must be an array of non-empty string secret env names.', true)
    return { kind: 'responded' }
  }
  // 同上：maxSubagentDepth 是策略授予字段，非法值在边界显式拒绝（不钳制、
  // 不静默丢弃）；仅对新鲜 spawn 下发，resume 续接沿用登记表既有事实。
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
  // 同上：maxAttempts 是自动重试策略字段，非法值显式拒绝（策略值被静默
  // 改写会让重试语义失真）。
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
  // 调用位次在发起时分配（agent 与 action 共享全序）；并发完成顺序不参与。
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
  // agentType 缺省 'assistant'：helm 的 agentType 是 Profile ID，宿主
  // ProfileService.ensureDefault 保证 assistant 存在（root 同源）。绝不沿用
  // 上游 'general-purpose'——helm 没有该 profile，NativeSpawn 严格校验会硬失败。
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
    // 缓存节点登记：原生持久子会话（有 conversationId 且无外部 executionId）
    // 保留 resumeRef 供后续未落账的 agent({ resume: label }) 真实续接原子会话；
    // 外部运行时或无 conversationId 的纯缓存记录维持 replayed: true（前缀失配
    // 后需要实时续接时由下方 replayed 守卫显式失败）。
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
    // 缓存分支记账保留 resumed 标记：原始调用是 resume 的，新账本必须如实。
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

  // 前缀失配（含本调用新增导致账本无此位次）而 resume 目标只存在于缓存子
  // 结果：无活会话可续接。显式失败，绝不伪造续接、也不重跑之前 action
  // 重建上下文。
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
