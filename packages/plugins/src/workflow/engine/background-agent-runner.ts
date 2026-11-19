/**
 * background-agent-runner.ts — 受信单子代理运行器（启动与重启原位重挂统一实现）。
 *
 * 职责：
 * - startBackgroundAgent 与 reattachBackgroundAgent 共享同一套 ActiveRun 构建、
 *   onResolved / onGateResult 边界净化与节点落盘、abort 守卫中止快路径，以及
 *   run-settle.ts 的统一终态结算管线；
 * - 单子代理不写 JSONL 账本，ActiveRun.writer 保持 undefined，绝不创建空账本文件句柄。
 */

import {
  HelmxError,
  redactJsonValue,
  agentGateResultMissingError as gateResultMissingError,
  sanitizeAgentExecutionInfo as sanitizeExecutionInfo,
  sanitizeAgentGateResult as sanitizeGateResult,
  type AgentExecutionInfo,
  type AgentGateResult,
  type AgentSpawnRequest,
  type JsonSchema,
} from '@helmx/protocol'
import {
  extractWorkflowExecutionMeta,
  extractWorktreeExecutionMeta,
  parseWorkflowSpawnMeta,
  withWorkflowSpawnMeta,
  type WorkflowNodeState,
  type WorkflowRunSummary,
} from '../../contracts.js'
import { resolveForegroundWaiters, type ActiveRun } from './active-run.js'
import { createSubagentSettler, type SubagentRawOutcome } from './run-settle.js'
import { backgroundChildIds, newRunId, type PersistedSubagentSpec, type RunRecord } from './run-store.js'
import { redactNodes, redactSummaryNodes, toSummary } from './run-summary.js'
import type { WorkflowServiceContext } from './service-context.js'

interface SubagentSessionParams {
  svc: WorkflowServiceContext
  record: RunRecord
  node: WorkflowNodeState
  agentId: string
  agentType: string | undefined
  initialExecution?: AgentExecutionInfo
  initialChildren?: Iterable<number>
  cleanupParentSignal?: () => void
  onResolvedExtra?: (info: AgentExecutionInfo) => void
  onGateResultExtra?: (gate: AgentGateResult) => void
}

/** 构造单子代理共用的 ActiveRun、中止链与 onResolved/onGateResult 边界回调。 */
function createSubagentSession(params: SubagentSessionParams) {
  const { svc, record, node, agentId, agentType } = params
  const runId = record.id
  const abort = new AbortController()
  let resolveDone: () => void = () => {}
  const doneGate = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  let resolveHorizon: () => void = () => {}
  const horizonGate = new Promise<void>((resolve) => {
    resolveHorizon = resolve
  })

  let executionInfo: AgentExecutionInfo | undefined = params.initialExecution
  let gateResult: AgentGateResult | undefined
  let onResolvedFired = false
  const now = Date.now()

  const run: ActiveRun = {
    runId,
    conversationId: record.conversationId,
    abort,
    record,
    done: doneGate.then(() => undefined),
    summary: toSummary(record),
    journalPath: record.journalPath,
    progress: [],
    timeline: [],
    pendingAborts: new Set(),
    pendingExecs: new Set(),
    childConversations: new Set(params.initialChildren),
    foregroundWaiters: new Set(),
    lastPersistAt: now,
    lastNodeEventAt: now,
  }

  const settler = createSubagentSettler({
    svc,
    run,
    node,
    parentConversationId: record.conversationId,
    agentType,
    getExecutionInfo: () => executionInfo,
    resolveDone,
    ...(params.cleanupParentSignal !== undefined ? { cleanupParentSignal: params.cleanupParentSignal } : {}),
  })

  // 取消信号单入口：先登记守卫中止 pendingAborts，再走取消快路径结算（human 接管拒绝不卡死 run 终态）。
  abort.signal.addEventListener(
    'abort',
    () => {
      if (!svc.isRunSuspending(run)) {
        for (const childId of [...run.childConversations]) {
          svc.abortChildConversation(run, childId)
        }
      }
      void settler.settle({ ok: false, error: new HelmxError('aborted', '后台子代理执行已取消', 409) }).catch(
        (error: unknown) => {
          settler.reportSettleError(error)
        },
      )
    },
    { once: true },
  )

  const onResolved = (raw: unknown): void => {
    const info = sanitizeExecutionInfo(raw, { agentId })
    executionInfo = info
    if (info.nodeId !== undefined) node.nodeId = info.nodeId
    if (info.conversationId !== undefined) {
      node.conversationId = info.conversationId
      run.childConversations.add(info.conversationId)
      if (abort.signal.aborted && !svc.isRunSuspending(run)) {
        svc.abortChildConversation(run, info.conversationId)
      }
    }
    if (info.executionId !== undefined) node.executionId = info.executionId
    if (info.effectiveCwd !== undefined) node.effectiveCwd = info.effectiveCwd
    const wtExecMeta = extractWorktreeExecutionMeta(info)
    if (wtExecMeta.worktree !== undefined) node.worktree = wtExecMeta.worktree
    const wfExecMeta = extractWorkflowExecutionMeta(info)
    if (wfExecMeta.controls !== undefined) node.controls = wfExecMeta.controls
    record.subagentMeta = {
      ...(agentType !== undefined && agentType !== '' ? { agentType } : {}),
      execution: redactJsonValue(info, svc.redact) as typeof info,
    }
    record.nodes = redactNodes(svc.redact, [node])
    run.summary = toSummary(record)
    svc.writeRecord(record)
    onResolvedFired = true
    resolveHorizon()
    params.onResolvedExtra?.(info)
  }

  const onGateResult = (raw: unknown): void => {
    const gate = sanitizeGateResult(raw, { agentId })
    gateResult = gate
    node.gate = {
      ok: gate.ok,
      output: svc.redact(gate.output),
      ...(gate.exitCode !== undefined ? { exitCode: gate.exitCode } : {}),
      ...(gate.timedOut !== undefined ? { timedOut: gate.timedOut } : {}),
    }
    params.onGateResultExtra?.(gate)
  }

  return {
    run,
    abort,
    settler,
    horizonGate,
    resolveHorizon,
    resolveDone,
    onResolved,
    onGateResult,
    getExecutionInfo: () => executionInfo,
    getGateResult: () => gateResult,
    hasResolvedFired: () => onResolvedFired,
  }
}

function finalizeSubagentOutcome(
  outcome: SubagentRawOutcome,
  ctx: {
    aborted: boolean
    agentId: string
    gateCommand: string | undefined
    gateResult: AgentGateResult | undefined
    executionInfo: AgentExecutionInfo | undefined
  },
): SubagentRawOutcome {
  let effective = outcome
  if (effective.ok && ctx.aborted) {
    effective = { ok: false, error: new HelmxError('aborted', '后台子代理执行已取消', 409) }
  }
  if (effective.ok && ctx.gateResult !== undefined && !ctx.gateResult.ok) {
    effective = { ok: false, error: new HelmxError('gate_failed', ctx.gateResult.output, 502) }
  }
  if (
    effective.ok &&
    ctx.gateCommand !== undefined &&
    ctx.gateResult === undefined &&
    ctx.executionInfo?.executionId !== undefined
  ) {
    effective = {
      ok: false,
      error: gateResultMissingError({
        agentId: ctx.agentId,
        executionId: ctx.executionInfo.executionId,
        command: ctx.gateCommand,
      }),
    }
  }
  return effective
}

function deriveSubagentNameFromPrompt(prompt: string, redact: (text: string) => string): string | undefined {
  const withoutContract = prompt.replace(/<structured_output_contract>[\s\S]*?<\/structured_output_contract>/g, '')
  for (const rawLine of withoutContract.split(/\r?\n/)) {
    const cleaned = rawLine
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .trim()
      .replace(/^(?:#+\s*|[-*]+\s+)+/, '')
      .replace(/^[#\-*]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned === '') continue
    const redacted = redact(cleaned).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
    if (redacted === '') continue
    return redacted.length > 60 ? redacted.slice(0, 60).trimEnd() : redacted
  }
  return undefined
}

/** 启动后台或前台同步单子代理。 */
export async function startBackgroundAgent(
  svc: WorkflowServiceContext,
  request: AgentSpawnRequest,
  options?: {
    parentToolCallId?: string
    label?: string
    notifyParentOnSettle?: boolean
    foreground?: boolean
    preassigned?: {
      runId: string
      replayedFrom: string
      autoResumeCount: number
      onPersisted?: () => void
      onPersistFailed?: () => void
    }
  },
): Promise<{
  run: WorkflowRunSummary
  execution?: AgentExecutionInfo
}> {
  if (svc.isClosed()) {
    options?.preassigned?.onPersistFailed?.()
    throw new HelmxError('service_closed', 'WorkflowService 已关闭，拒绝启动新后台子代理', 503)
  }
  try {
    await svc.init()
    if (svc.isClosed()) throw new HelmxError('service_closed', 'WorkflowService 已关闭，拒绝启动新后台子代理', 503)
    svc.host.getConversation(request.parentConversationId)
    if (request.signal?.aborted) {
      throw new HelmxError('aborted', 'spawn 请求在创建前已取消', 409)
    }
  } catch (error) {
    options?.preassigned?.onPersistFailed?.()
    throw error
  }

  const runId = options?.preassigned?.runId ?? newRunId()
  const createdAt = Date.now()
  const foreground = options?.foreground === true
  const parentToolCallId =
    options?.parentToolCallId !== undefined && options.parentToolCallId !== ''
      ? options.parentToolCallId
      : request.parentToolCallId !== undefined && request.parentToolCallId !== ''
        ? request.parentToolCallId
        : undefined
  const explicitLabel = options?.label !== undefined ? options.label.trim() : ''
  const resolvedPromptName =
    explicitLabel !== ''
      ? svc.redact(explicitLabel)
      : deriveSubagentNameFromPrompt(request.prompt, svc.redact)
  const name =
    resolvedPromptName !== undefined && resolvedPromptName !== ''
      ? resolvedPromptName
      : request.agentType !== undefined && request.agentType !== ''
        ? `subagent:${request.agentType}`
        : 'subagent'

  const journalPath = svc.runs.journalPathFor(request.parentConversationId, runId)
  const agentIdForProto = request.agentId ?? `${runId}:subagent-0`
  const deterministicRequestId = request.requestId ?? `helmx:spawn:${runId}`
  const hadSecretGrant = Array.isArray(request.secretNames) && request.secretNames.length > 0
  const spawnMeta = parseWorkflowSpawnMeta(request.meta)
  const subagentSpec: PersistedSubagentSpec = {
    agentId: agentIdForProto,
    requestId: deterministicRequestId,
    prompt: svc.redact(request.prompt),
    ...(request.agentType !== undefined && request.agentType !== '' ? { agentType: request.agentType } : {}),
    ...(request.cwd !== undefined ? { cwd: svc.redact(request.cwd) } : {}),
    ...(request.isolation === 'worktree' || request.isolation === 'none'
      ? { isolation: request.isolation }
      : {}),
    ...(request.gate !== undefined ? { gate: svc.redact(request.gate) } : {}),
    ...(request.gateTimeoutMs !== undefined ? { gateTimeoutMs: request.gateTimeoutMs } : {}),
    ...(request.schema !== undefined ? { schema: redactJsonValue(request.schema, svc.redact) as JsonSchema } : {}),
    ...(spawnMeta.maxSubagentDepth !== undefined ? { maxSubagentDepth: spawnMeta.maxSubagentDepth } : {}),
    ...(request.model !== undefined ? { model: svc.redact(request.model) } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.fork !== undefined ? { fork: request.fork } : {}),
    ...(request.attachments !== undefined
      ? { attachments: request.attachments.map((item) => svc.redact(item)) }
      : {}),
    ...(hadSecretGrant ? { hadSecretGrant: true } : {}),
  }

  const node: WorkflowNodeState = {
    id: 'subagent-0',
    kind: 'agent',
    label: name,
    status: 'running',
    startedAt: createdAt,
    ...(request.agentType !== undefined && request.agentType !== ''
      ? { agentType: request.agentType }
      : {}),
    ...(request.gate !== undefined ? { gateCommand: svc.redact(request.gate) } : {}),
  }

  const record: RunRecord = {
    id: runId,
    name,
    conversationId: request.parentConversationId,
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
    status: 'running',
    createdAt,
    updatedAt: createdAt,
    kind: 'subagent',
    notifyParentOnSettle: options?.notifyParentOnSettle ?? !foreground,
    ...(foreground ? { syncForeground: true } : {}),
    ...(options?.preassigned !== undefined
      ? {
          replayedFrom: options.preassigned.replayedFrom,
          autoResumeCount: options.preassigned.autoResumeCount,
        }
      : {}),
    subagentSpec,
    journalPath,
    nodes: [node],
  }

  let cleanupParentSignal: (() => void) | undefined
  const session = createSubagentSession({
    svc,
    record,
    node,
    agentId: agentIdForProto,
    agentType: request.agentType,
    cleanupParentSignal: () => cleanupParentSignal?.(),
    ...(request.onResolved !== undefined ? { onResolvedExtra: request.onResolved } : {}),
    ...(request.onGateResult !== undefined ? { onGateResultExtra: request.onGateResult } : {}),
  })
  const { run, abort, settler, horizonGate, resolveHorizon, resolveDone } = session

  try {
    svc.cancellation.assertNotCancelling(request.parentConversationId)
  } catch (error) {
    options?.preassigned?.onPersistFailed?.()
    throw error
  }
  svc.active.set(runId, run)

  let wireBackground: (outcome: SubagentRawOutcome) => void = () => {}
  const backgroundWait = new Promise<SubagentRawOutcome>((resolve) => {
    wireBackground = resolve
  })
  const background = (async () => {
    const outcome = await backgroundWait
    await settler.settle(
      finalizeSubagentOutcome(outcome, {
        aborted: abort.signal.aborted,
        agentId: agentIdForProto,
        gateCommand: request.gate,
        gateResult: session.getGateResult(),
        executionInfo: session.getExecutionInfo(),
      }),
    )
  })()
  void background.catch((error: unknown) => {
    process.stderr.write(
      `workflow ${runId}: background settle crashed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    settler.reportSettleError(error)
    if (!settler.isSettled()) void settler.settle({ ok: false, error }).catch(() => {})
  })

  try {
    svc.writeRecord(record)
    options?.preassigned?.onPersisted?.()
    await svc.state.flush?.()
  } catch (persistError) {
    options?.preassigned?.onPersistFailed?.()
    svc.active.delete(runId)
    resolveDone()
    resolveForegroundWaiters(run, 'settled')
    throw persistError
  }
  svc.emitEventSafe('workflow.updated', { run: redactSummaryNodes(svc.redact, { ...run.summary }) })

  const proto: AgentSpawnRequest = {
    ...request,
    ...(request.title === undefined && request.resume === undefined && request.reattach === undefined
      ? { title: name }
      : {}),
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
    agentId: agentIdForProto,
    requestId: deterministicRequestId,
    meta: withWorkflowSpawnMeta(request.meta, { runId }),
    onResolved: session.onResolved,
    ...(request.gate !== undefined ? { onGateResult: session.onGateResult } : {}),
    signal: abort.signal,
  }

  const parentSignal = request.signal
  const onParentAbort = (): void => {
    if (settler.isSettled() || svc.isRunSuspending(run)) return
    if (foreground || !session.hasResolvedFired()) abort.abort()
  }
  const detachedBeforeBind = record.detachedAt !== undefined
  let detachParentSignal: () => void = () => {}
  if (!detachedBeforeBind) {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true })
    detachParentSignal = (): void => {
      parentSignal?.removeEventListener('abort', onParentAbort)
    }
    cleanupParentSignal = detachParentSignal
    if (foreground) run.unbindForegroundSignal = detachParentSignal
  }

  if (svc.isClosed() || svc.host.isHostClosing?.() === true) abort.abort()
  else if (!detachedBeforeBind && parentSignal?.aborted) abort.abort()

  const spawnPromise = (async () => {
    if (abort.signal.aborted) throw new HelmxError('aborted', '后台子代理启动期间已取消', 409)
    return svc.host.spawnAgent(proto)
  })()
  let spawnOutcome: SubagentRawOutcome | undefined
  const guarded: Promise<SubagentRawOutcome> = spawnPromise.then(
    (raw) => ({ ok: true as const, raw }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  const spawnEarly = guarded.then((outcome) => {
    spawnOutcome = outcome
    wireBackground(outcome)
    resolveHorizon()
    return outcome
  })
  void spawnEarly.catch(() => {})

  await Promise.race([horizonGate, spawnEarly])

  const preResolveFailure =
    spawnOutcome !== undefined && !spawnOutcome.ok && !session.hasResolvedFired() ? spawnOutcome.error : undefined
  if (preResolveFailure !== undefined) {
    detachParentSignal()
    throw preResolveFailure
  }

  if (!foreground) detachParentSignal()

  try {
    svc.writeRecord(record)
    await svc.state.flush?.()
  } catch (persistError) {
    const message = persistError instanceof Error ? persistError.message : String(persistError)
    process.stderr.write(`workflow ${runId}: execution metadata persist failed: ${message}\n`)
  }
  svc.emitEventSafe('workflow.updated', { run: redactSummaryNodes(svc.redact, { ...run.summary }) })

  const resolvedExecution = session.getExecutionInfo()
  return {
    run: redactSummaryNodes(svc.redact, { ...run.summary }),
    ...(resolvedExecution !== undefined ? { execution: resolvedExecution } : {}),
  }
}

/** 重启原位恢复单子代理（复用既有 runId 与共享结算器）。 */
export function reattachBackgroundAgent(
  svc: WorkflowServiceContext,
  record: RunRecord,
): { horizonGate: Promise<void>; isNativeReattach: boolean } {
  const runId = record.id
  const spec = record.subagentSpec!
  const exec = record.subagentMeta?.execution
  const hasHandle = exec?.conversationId !== undefined || exec?.executionId !== undefined
  const isNativeReattach = hasHandle && exec?.executionId === undefined && exec?.conversationId !== undefined
  const existingNode = record.nodes?.[0]
  const node: WorkflowNodeState =
    existingNode !== undefined
      ? { ...existingNode, status: 'running' }
      : {
          id: 'subagent-0',
          kind: 'agent',
          label: record.name,
          status: 'running',
          startedAt: record.createdAt,
          ...(spec.agentType !== undefined ? { agentType: spec.agentType } : {}),
          ...(spec.gate !== undefined ? { gateCommand: spec.gate } : {}),
        }
  record.nodes = [node]

  const session = createSubagentSession({
    svc,
    record,
    node,
    agentId: spec.agentId,
    agentType: spec.agentType,
    ...(exec !== undefined ? { initialExecution: exec } : {}),
    initialChildren: backgroundChildIds(record),
  })
  const { run, abort, settler, horizonGate, resolveHorizon } = session
  svc.active.set(runId, run)

  const proto: AgentSpawnRequest = {
    parentConversationId: record.conversationId,
    prompt: spec.prompt,
    agentId: spec.agentId,
    requestId: spec.requestId,
    ...(record.parentToolCallId !== undefined ? { parentToolCallId: record.parentToolCallId } : {}),
    ...(spec.agentType !== undefined ? { agentType: spec.agentType } : {}),
    ...(spec.isolation !== undefined ? { isolation: spec.isolation } : {}),
    ...(spec.gate !== undefined ? { gate: spec.gate } : {}),
    ...(spec.gateTimeoutMs !== undefined ? { gateTimeoutMs: spec.gateTimeoutMs } : {}),
    ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
    ...(hasHandle
      ? {
          reattach: {
            ...(exec?.conversationId !== undefined ? { conversationId: exec.conversationId } : {}),
            ...(exec?.executionId !== undefined ? { executionId: exec.executionId } : {}),
            ...(exec?.effectiveCwd !== undefined ? { effectiveCwd: exec.effectiveCwd } : {}),
          },
        }
      : {
          ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
          ...(spec.model !== undefined ? { model: spec.model } : {}),
          ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
          ...(spec.fork !== undefined ? { fork: spec.fork } : {}),
          ...(spec.attachments !== undefined ? { attachments: spec.attachments } : {}),
        }),
    meta: withWorkflowSpawnMeta(undefined, {
      runId,
      ...(spec.maxSubagentDepth !== undefined ? { maxSubagentDepth: spec.maxSubagentDepth } : {}),
    }),
    onResolved: session.onResolved,
    ...(spec.gate !== undefined ? { onGateResult: session.onGateResult } : {}),
    signal: abort.signal,
  }

  const spawnPromise = (async () => {
    if (!isNativeReattach && svc.deferExternalReattach) {
      await svc.waitExternalRuntimeReady()
    }
    if (abort.signal.aborted) throw new HelmxError('aborted', '后台子代理恢复期间已取消', 409)
    return svc.host.spawnAgent(proto)
  })()

  void spawnPromise
    .then(
      (raw) => ({ ok: true as const, raw }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    .then(async (outcome) => {
      resolveHorizon()
      await settler.settle(
        finalizeSubagentOutcome(outcome, {
          aborted: abort.signal.aborted,
          agentId: spec.agentId,
          gateCommand: spec.gate,
          gateResult: session.getGateResult(),
          executionInfo: session.getExecutionInfo(),
        }),
      )
    })
    .catch((error: unknown) => {
      resolveHorizon()
      settler.reportSettleError(error)
      if (!settler.isSettled()) void settler.settle({ ok: false, error }).catch(() => {})
    })

  return { horizonGate, isNativeReattach }
}
