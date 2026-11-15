/**
 * runtime-agent-handler.ts — `agent()` 调用的宿主侧 handler。
 *
 * 自 runtime.ts 的 handleAgent 闭包提取为显式依赖注入模块（语义逐行保持）：
 * 职责 = 调用载荷边界校验 → 账本前缀重放（失败链自动续跑 / 成功缓存复用 /
 * 缓存 resume 守卫）→ attempt 环 live 执行（暂停门 / 并发许可 / 手动 skip /
 * retry / maxAttempts 自动续接重试）→ agent 行记账与进度发射。
 *
 * 依赖经 AgentCallContext 注入（emit/respond/allocateIndex 等由 runtime.ts
 * 的 runWorkflow 构造），本模块不持有 worker 与 run 终态，fatal 一律经
 * respond(…, true) 回流，由编排层统一 finish。
 */

import { agentJournalKey, type AgentJournalKeyInput, type JournalWriteInput } from './journal.js'
import { compileJsonSchema, type CompiledSchema } from './json-schema.js'
import { extractWorkflowExecutionMeta, HARD_MAX_SUBAGENT_DEPTH } from '../../contracts.js'
import type { AgentExecutionInfo } from '@helm/protocol'
import type { WorkflowAgentEntry, WorkflowEntry } from './progress.js'
import type { JournalReplay } from './replay.js'
import type { AgentCallPayload, CompletedChild, WorkflowHost, WorkflowSpawnRequest, WorkflowSpawnResult } from './runtime-types.js'
import {
  agentRetryPrompt,
  applyGate,
  applySchema,
  derivedLabel,
  executionInfoForMeta,
  isValidAttachments,
  isValidSecretNames,
  MAX_AGENT_ATTEMPTS,
  preview,
  readCallScope,
  scopedResumeKey,
} from './runtime-validation.js'
import { type LiveAgent, RuntimeControl, Semaphore } from './runtime-control.js'
import type { AgentRecordInput } from './runtime-recorder.js'

/** run 级可变计数（与 action handler / 编排层共享同一对象）。 */
export interface AgentRunCounters {
  agentCount: number
  replayedCount: number
  spentOutputTokens: number
}

/** handleAgentCall 的全部依赖（由 runWorkflow 构造；字段含义见 runWorkflow）。 */
export interface AgentCallContext {
  host: WorkflowHost
  agentCap: number
  /** options.journal?.retryFailedCalls === true（失败目标续跑独立重试预算）。 */
  retryFailedCalls: boolean
  /** run 终态读取（每次调用读当前值，与原闭包变量读取语义一致）。 */
  runState: { isAborted(): boolean; isSettled(): boolean }
  emit(entries: WorkflowEntry[]): void
  respond(callId: number, ok: boolean, value?: unknown, error?: string, fatal?: boolean): void
  allocateIndex(): number
  /** agent 行尽力记账（写失败仅诊断计数，不中断 run）。 */
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
  const runGate = ctx.host.runGate?.bind(ctx.host)
  const resumeAgent = ctx.host.resumeAgent?.bind(ctx.host)
  if (payload.gate !== undefined && runGate === undefined) {
    ctx.respond(callId, false, undefined, 'This workflow host cannot run gate commands.', true)
    return
  }
  if (payload.resume !== undefined && resumeAgent === undefined) {
    ctx.respond(callId, false, undefined, 'This workflow host cannot resume agents.', true)
    return
  }
  for (const [name, value, upper] of [
    ['timeoutMs', payload.timeoutMs, 3_600_000],
    ['gateTimeoutMs', payload.gateTimeoutMs, 600_000],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1_000 || value > upper)) {
      ctx.respond(callId, false, undefined, `agent() opts.${name} must be an integer between 1000 and ${upper}.`, true)
      return
    }
  }
  if (payload.gateTimeoutMs !== undefined && payload.gate === undefined) {
    ctx.respond(callId, false, undefined, 'agent() opts.gateTimeoutMs requires opts.gate.', true)
    return
  }

  // scopeId 是 scope 命名空间字段（worker makeScope 分配，根 = 0）。
  // 非法形状在边界显式拒绝：不信任 worker 消息面，也不静默钳制。
  if (payload.scopeId !== undefined && (!Number.isInteger(payload.scopeId) || payload.scopeId < 0)) {
    ctx.respond(callId, false, undefined, 'agent() opts.scopeId must be a non-negative integer.', true)
    return
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
      return
    }
    // 先匹配账本；只有真正需要执行时，才拒绝无活会话的缓存续接。
  }

  let compiledSchema: CompiledSchema | undefined
  if (payload.schema !== undefined) {
    const compilation = compileJsonSchema(payload.schema)
    if (!compilation.ok) {
      ctx.respond(callId, false, undefined, compilation.message, true)
      return
    }
    compiledSchema = compilation.compiled
  }

  // host 边界二次校验（不信任 worker 消息面）：非法 attachments 是 fatal，
  // 绝不带病下发到真实宿主 spawn/resume 端口。
  if (payload.attachments !== undefined && !isValidAttachments(payload.attachments)) {
    ctx.respond(callId, false, undefined, 'agent() opts.attachments must be an array of non-empty string artifact IDs.', true)
    return
  }
  // 同上：secretNames 是机密授予字段，非法形状在边界显式拒绝（不静默丢弃）。
  if (payload.secretNames !== undefined && !isValidSecretNames(payload.secretNames)) {
    ctx.respond(callId, false, undefined, 'agent() opts.secretNames must be an array of non-empty string secret env names.', true)
    return
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
    return
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
    return
  }

  if (ctx.counters.agentCount >= ctx.agentCap) {
    ctx.respond(callId, false, undefined, `Workflow exceeded its cap of ${ctx.agentCap} agents.`, true)
    return
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
    return
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
          return
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
      return
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
      return
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
        return
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
    // 缓存节点也登记为可 resume 的 child（标 replayed）：同一脚本内后续
    // 匹配账本的 resume 调用可直接返回缓存文本；但它无活会话，前缀失配
    // 后需要真正续接时由上方 replayed 守卫显式失败。
    ctx.completedByLabel.set(scopedResumeKey(scopeId, label), {
      agentId,
      label,
      agentType,
      ...(model !== undefined ? { model } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
      scopeId,
      replayed: true,
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
    return
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
    return
  }

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
