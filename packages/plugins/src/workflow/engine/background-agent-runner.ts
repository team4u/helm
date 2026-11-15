/**
 * background-agent-runner.ts — 受信后台单子代理启动（自 WorkflowService
 * .startBackgroundAgent 拆出的内部模块）。
 *
 * startBackgroundAgent 复用 run 记录 / 持久化 / abort / wait / getRun /
 * onRunSettled / 重启恢复，但不经 DSL 引擎（不伪造空 script），直接投
 * host.spawnAgent 受信通道。时序纪律见函数头注释；终态结算链（settle 闭包）
 * 与 spawn 地平线 race 原样保留。行为契约与错误码不变。
 */

import { mkdirSync } from 'node:fs'
import {
  HelmError,
  redactJsonValue,
  agentGateResultMissingError as gateResultMissingError,
  sanitizeAgentExecutionInfo as sanitizeExecutionInfo,
  sanitizeAgentGateResult as sanitizeGateResult,
  type AgentExecutionInfo,
  type AgentGateResult,
  type AgentSpawnRequest,
} from '@helm/protocol'
import {
  extractWorkflowExecutionMeta,
  withWorkflowSpawnMeta,
  type WorkflowNodeState,
  type WorkflowRunSummary,
} from '../../contracts.js'
import { JournalWriter } from './journal.js'
import { resolveForegroundWaiters, type ActiveRun } from './active-run.js'
import { newRunId, type RunRecord } from './run-store.js'
import { redactNodes, redactSummaryNodes, toSummary } from './run-summary.js'
import type { WorkflowServiceContext } from './service-context.js'

/**
 * 启动后台单子代理：
 * 1. durable running 快照与 active 登记**先于** spawnAgent 副作用——onResolved
 *    前进程崩溃也能由 init() 恢复发现并补发通知；
 * 2. 等 onResolved 地平线后立即返回 running（拿到真实 execution 元数据）；
 * 3. 前置错误（onResolved 前 spawn reject）当场同步 rethrow 原始错误——但
 *    durable 记录已存在，由后台兜底链将其结算为 failed（诚实终态，不删记录
 *    留僵尸 running，也不伪造成功）；
 * 4. 父 signal 传播分两种模式：后台模式（缺省）仅启动阶段（onResolved 前）
 *    传播，就绪即解绑——父回合结束后的 signal abort 不误杀后台子代理；
 *    前台同步模式（foreground:true，同步 subagent 工具）绑定持续到 detach
 *    或终态——detach 的临界段解绑（转后台后父 signal 不再杀 run），此后
 *    只受 abort(runId)/close() 控制；
 * 5. 插件从不 onResolved 但 settle：execution 留空（绝不伪造），abort 无子会话
 *    可停，仅取消本 run；
 * 6. onBackgroundAgentSettled 失败不推翻终态：notifiedAt 不置位，init() 按
 *    outbox 语义补发（至少一次；父侧 reportBackgroundAgent 幂等去重）。
 * 前台模式（foreground:true）：record 标记 syncForeground（可被 detach 转入
 * 后台），notifyParentOnSettle 缺省 false（detach 置位后才走结算汇报链）。
 */
export async function startBackgroundAgent(
  svc: WorkflowServiceContext,
  request: AgentSpawnRequest,
  options?: {
    parentToolCallId?: string
    label?: string
    notifyParentOnSettle?: boolean
    /** 前台同步模式：record 标记 syncForeground、父 signal 绑定至 detach/终态。 */
    foreground?: boolean
  },
): Promise<{
  run: WorkflowRunSummary
  execution?: AgentExecutionInfo
}> {
  if (svc.isClosed()) {
    throw new HelmError('service_closed', 'WorkflowService 已关闭，拒绝启动新后台子代理', 503)
  }
  await svc.init()
  if (svc.isClosed()) throw new HelmError('service_closed', 'WorkflowService 已关闭，拒绝启动新后台子代理', 503)

  // 父会话不存在时 getConversation 抛 not_found，原样透传给调用方。
  svc.host.getConversation(request.parentConversationId)

  if (request.signal?.aborted) {
    throw new HelmError('aborted', 'spawn 请求在创建前已取消', 409)
  }

  const runId = newRunId()
  const createdAt = Date.now()
  const abort = new AbortController()
  const foreground = options?.foreground === true
  const parentToolCallId =
    options?.parentToolCallId !== undefined && options.parentToolCallId !== ''
      ? options.parentToolCallId
      : request.parentToolCallId !== undefined && request.parentToolCallId !== ''
        ? request.parentToolCallId
        : undefined
  const name =
    options?.label !== undefined && options.label.trim() !== ''
      ? options.label.trim()
      : request.agentType !== undefined && request.agentType !== ''
        ? `subagent:${request.agentType}`
        : 'subagent'

  mkdirSync(svc.runs.artifactsDir(request.parentConversationId), { recursive: true })
  const journalPath = svc.runs.journalPathFor(request.parentConversationId, runId)

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
    // 前台同步：缺省不通知（等待 detach 置位或终态）；后台：缺省通知。
    notifyParentOnSettle: options?.notifyParentOnSettle ?? !foreground,
    ...(foreground ? { syncForeground: true } : {}),
    journalPath,
    nodes: [node],
  }

  let resolveDone: () => void = () => {}
  const doneGate = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const run: ActiveRun = {
    runId,
    conversationId: request.parentConversationId,
    abort,
    record,
    // done 立即挂后台兜底链：从创建第一刻起 wait/abort/close 都有可等的终点。
    done: doneGate.then(() => undefined),
    summary: toSummary(record),
    journalPath,
    writer: new JournalWriter(journalPath),
    progress: [],
    timeline: [],
    pendingAborts: new Set(),
    pendingExecs: new Set(),
    childConversations: new Set(),
    foregroundWaiters: new Set(),
    lastPersistAt: createdAt,
    lastNodeEventAt: createdAt,
  }
  // 取消窗口复查（与 active.set 零 await 间隔）：入口检查后已经过 getConversation
  // 等多个 await 点，父会话可能已进入级联取消边界——在此拒绝，不留漏网 run。
  svc.cancellation.assertNotCancelling(request.parentConversationId)
  svc.active.set(runId, run)

  // 父 signal 解绑口（下方 parentSignal 段赋值；settle/启动失败路径经此收口，
  // 前台模式下 detach 临界段经 run.unbindForegroundSignal 解绑）。声明先于
  // 首个 await：durable 写失败窗口内触发的 settle 不触碰 TDZ。
  let cleanupParentSignal: (() => void) | undefined

  // abort(runId)/close()/级联取消 → 取消本 run 信号（spawn 信号桥停子会话回合）+
  // 经 host.abortConversationGuarded 守卫中止已 onResolved 的子会话（human
  // 红线由内核原子复核；幂等，已结束的子会话静默）。注册进 pendingAborts：
  // settle 前必等完。
  const onRunAbort = (): void => {
    for (const childId of [...run.childConversations]) {
      svc.abortChildConversation(run, childId)
    }
  }
  abort.signal.addEventListener('abort', onRunAbort, { once: true })

  // --- 后台兜底结算链（唯一终态出口；绝不 reject，避免 unhandled） -------
  let settled = false
  let reportedSettleError = false
  let settleError: unknown
  const reportSettleError = (error: unknown): void => {
    if (!reportedSettleError) {
      reportedSettleError = true
      settleError = error
    }
  }

  /** 已 sanitized 执行元数据（onResolved 可能多次回调，幂等取最新）。 */
  let executionInfo: AgentExecutionInfo | undefined
  let gateResult: AgentGateResult | undefined
  /** onResolved 是否真实触发（与地平线 race 分开判定，防 spawnEarly 混淆）。 */
  let onResolvedFired = false
  let resolveHorizon: () => void = () => {}
  const horizonGate = new Promise<void>((resolve) => {
    resolveHorizon = resolve
  })

  const settle = async (
    outcome: { ok: true; raw: unknown } | { ok: false; error: unknown },
  ): Promise<void> => {
    // 同步置位幂等门：abort 快路径与 spawn 迟到终局竞态下二次进入直接
    // no-op（迟到结果只经 active 删除后的 records 事实可见，不翻终态）。
    if (settled) return
    settled = true
    try {
      const settledAt = Date.now()
      const aborted =
        !outcome.ok &&
        (abort.signal.aborted ||
          (outcome.error instanceof HelmError && outcome.error.code === 'aborted'))
      if (outcome.ok) {
        node.status = 'done'
        node.settledAt = settledAt
        node.durationMs = settledAt - createdAt
        node.output = redactJsonValue(outcome.raw, svc.redact)
        record.status = 'completed'
        record.result = redactJsonValue(outcome.raw, svc.redact)
      } else {
        node.status = aborted ? 'skipped' : 'failed'
        node.settledAt = settledAt
        node.durationMs = settledAt - createdAt
        const message =
          outcome.error instanceof HelmError
            ? `[${outcome.error.code}] ${outcome.error.message}`
            : outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error)
        node.error = svc.redact(message)
        record.status = aborted ? 'aborted' : 'failed'
        record.error = svc.redact(message)
      }
      record.updatedAt = settledAt
      record.nodes = redactNodes(svc.redact, [node])
      run.summary = toSummary(record)
      try {
        svc.writeRecord(record)
        await svc.state.flush?.()
      } catch (persistError) {
        const message = persistError instanceof Error ? persistError.message : String(persistError)
        process.stderr.write(`workflow ${runId}: terminal state persist failed: ${message}\n`)
        run.summary = {
          ...run.summary,
          error: `${run.summary.error ?? ''}\n[persist failed: ${message}]`.trim(),
        }
        reportSettleError(persistError)
      }
    } finally {
      try {
        await run.writer.close()
      } catch (closeError) {
        process.stderr.write(
          `workflow ${runId}: journal close failed: ${
            closeError instanceof Error ? closeError.message : String(closeError)
          }\n`,
        )
      }
      if (run.pendingAborts.size > 0) {
        await Promise.allSettled([...run.pendingAborts])
      }
      if (svc.host.onRunSettled !== undefined) {
        try {
          await svc.host.onRunSettled({ ...run.summary })
        } catch (hookError) {
          const message = hookError instanceof Error ? hookError.message : String(hookError)
          process.stderr.write(`workflow ${runId}: onRunSettled failed: ${message}\n`)
          reportSettleError(hookError)
        }
      }
      if (
        !svc.isClosed() &&
        record.notifyParentOnSettle === true &&
        record.notifiedAt === undefined &&
        svc.host.onBackgroundAgentSettled !== undefined
      ) {
        try {
          await svc.host.onBackgroundAgentSettled({ ...run.summary }, {
            parentConversationId: request.parentConversationId,
            ...(request.agentType !== undefined && request.agentType !== ''
              ? { agentType: request.agentType }
              : {}),
            // 通知面向父会话输入（可进模型上下文）：与持久面同标准脱敏。
            ...(executionInfo !== undefined
              ? { execution: redactJsonValue(executionInfo, svc.redact) as typeof executionInfo }
              : {}),
          })
          record.notifiedAt = Date.now()
          svc.writeRecord(record)
          await svc.state.flush?.()
        } catch (notifyError) {
          // 通知失败不推翻已落盘终态：notifiedAt 不置位，init() 按 outbox 补发。
          const message = notifyError instanceof Error ? notifyError.message : String(notifyError)
          process.stderr.write(`workflow ${runId}: onBackgroundAgentSettled failed: ${message}\n`)
        }
      }
      svc.emitEventSafe('workflow.updated', { run: { ...run.summary } })
      svc.active.delete(runId)
      if (settleError !== undefined) run.settleError = settleError
      cleanupParentSignal?.()
      run.unbindForegroundSignal = undefined
      resolveDone()
      // 前台等待者最后唤醒（settleError 已定稿）：工具侧 waitForegroundRun
      // 以 'settled' 继续读终态；已 detach 的等待者早已返回（Promise 单次）。
      resolveForegroundWaiters(run, 'settled')
    }
  }

  // abort 快路径：取消即结算（不等 spawn 终局）。守卫拒绝（human 接管等
  // 红线事实）时 spawn 可能长期不返回，而 run 的终态绝不能依赖被保护
  // 子会话的完成；迟到 spawn 结果经 settle 的幂等门丢弃。
  abort.signal.addEventListener(
    'abort',
    () => {
      void settle({ ok: false, error: new HelmError('aborted', '后台子代理执行已取消', 409) }).catch(
        (error: unknown) => {
          reportSettleError(error)
        },
      )
    },
    { once: true },
  )

  const agentIdForProto = request.agentId ?? `${runId}:subagent-0`
  // spawn 终局透传：guarded 在下方组装后立刻接入（wireBackground），后台链
  // 从创建第一刻起即可等待（含 durable 快照写入前的窗口）。
  let wireBackground: (outcome: { ok: true; raw: unknown } | { ok: false; error: unknown }) => void = () => {}
  const backgroundWait = new Promise<{ ok: true; raw: unknown } | { ok: false; error: unknown }>((resolve) => {
    wireBackground = resolve
  })
  const background = (async () => {
    const outcome = await backgroundWait
    let effective = outcome
    if (effective.ok && abort.signal.aborted) {
      effective = { ok: false, error: new HelmError('aborted', '后台子代理执行已取消', 409) }
    }
    if (effective.ok && gateResult !== undefined && !gateResult.ok) {
      effective = { ok: false, error: new HelmError('gate_failed', gateResult.output, 502) }
    }
    if (
      effective.ok &&
      request.gate !== undefined &&
      gateResult === undefined &&
      executionInfo?.executionId !== undefined
    ) {
      // 外部执行环境（executionId 存在）必须回报 gate；缺失即显式失败，
      // 与 invokeSpawn 同款规则，绝不在本机猜远端工作目录补跑。
      effective = {
        ok: false,
        error: gateResultMissingError({
          agentId: agentIdForProto,
          executionId: executionInfo.executionId,
          command: request.gate,
        }),
      }
    }
    await settle(effective)
  })()
  void background.catch((error: unknown) => {
    process.stderr.write(
      `workflow ${runId}: background settle crashed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    reportSettleError(error)
    if (!settled) void settle({ ok: false, error }).catch(() => {})
  })

  // --- durable running 快照（副作用 spawnAgent 之前！）------------------
  try {
    svc.writeRecord(record)
    await svc.state.flush?.()
  } catch (persistError) {
    svc.active.delete(runId)
    await run.writer.close().catch(() => {})
    resolveDone()
    // 此窗口内不可能有前台等待者（runId 尚未返回给调用方），防御性收口。
    resolveForegroundWaiters(run, 'settled')
    throw persistError
  }
  svc.emitEventSafe('workflow.updated', { run: redactSummaryNodes(svc.redact, { ...run.summary }) })

  // --- 组装 proto 并发起 spawn -----------------------------------------
  const proto: AgentSpawnRequest = {
    ...request,
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
    agentId: agentIdForProto,
    meta: withWorkflowSpawnMeta(undefined, { runId }),
    onResolved: (raw: unknown) => {
      const info = sanitizeExecutionInfo(raw, { agentId: agentIdForProto })
      executionInfo = info
      if (info.nodeId !== undefined) node.nodeId = info.nodeId
      if (info.conversationId !== undefined) {
        node.conversationId = info.conversationId
        run.childConversations.add(info.conversationId)
        // 迟到 onResolved 补杀：取消先于执行元数据落地时，onRunAbort 的快照
        // 看不到该子会话——在登记点立即补守卫中止，绝不因时序漏杀。
        if (abort.signal.aborted) svc.abortChildConversation(run, info.conversationId)
      }
      if (info.executionId !== undefined) node.executionId = info.executionId
      if (info.effectiveCwd !== undefined) node.effectiveCwd = info.effectiveCwd
      // 业务扩展（worktree / 控制引用）在引擎边界用本插件契约校验并落到节点。
      const wfExecMeta = extractWorkflowExecutionMeta(info)
      if (wfExecMeta.worktree !== undefined) node.worktree = wfExecMeta.worktree
      if (wfExecMeta.controls !== undefined) node.controls = wfExecMeta.controls
      record.subagentMeta = {
        ...(request.agentType !== undefined && request.agentType !== ''
          ? { agentType: request.agentType }
          : {}),
        // 持久面统一脱敏（effectiveCwd/worktree 路径可能含秘密 token）。
        execution: redactJsonValue(info, svc.redact) as typeof info,
      }
      record.nodes = redactNodes(svc.redact, [node])
      run.summary = toSummary(record)
      svc.writeRecord(record)
      onResolvedFired = true
      resolveHorizon()
      request.onResolved?.(info)
    },
    ...(request.gate !== undefined
      ? {
          onGateResult: (raw: unknown) => {
            const gate = sanitizeGateResult(raw, { agentId: agentIdForProto })
            gateResult = gate
            // exitCode/timedOut 是诊断事实（非机密），保留不丢弃。
            node.gate = {
              ok: gate.ok,
              output: svc.redact(gate.output),
              ...(gate.exitCode !== undefined ? { exitCode: gate.exitCode } : {}),
              ...(gate.timedOut !== undefined ? { timedOut: gate.timedOut } : {}),
            }
            request.onGateResult?.(gate)
          },
        }
      : {}),
    signal: abort.signal,
  }

  // 父 signal 传播（按模式）：
  // - 后台模式（缺省）：仅启动阶段（ready 前）传播，onResolved 即解绑——
  //   父回合结束后的 signal abort 不误杀后台子代理；
  // - 前台同步模式（foreground:true）：绑定持续到 detach 或终态——同步工具
  //   的父 signal abort 中止本 run（保留同步语义）；detach 临界段经
  //   run.unbindForegroundSignal 解绑（转后台后父 signal 不再杀 run）。
  const parentSignal = request.signal
  const onParentAbort = (): void => {
    if (settled) return
    if (foreground || !onResolvedFired) abort.abort()
  }
  parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  const detachParentSignal = (): void => {
    parentSignal?.removeEventListener('abort', onParentAbort)
  }
  cleanupParentSignal = detachParentSignal
  if (foreground) run.unbindForegroundSignal = detachParentSignal

  if (parentSignal?.aborted || svc.isClosed()) abort.abort()
  const spawnPromise = (async () => {
    if (abort.signal.aborted) throw new HelmError('aborted', '后台子代理启动期间已取消', 409)
    return svc.host.spawnAgent(proto)
  })()
  // spawn 终局（guard 后绝不 reject）；onResolved 前失败在地平线 race 中
  // 同步透出给调用方，同时喂给后台链结算为 failed。
  let spawnOutcome: { ok: true; raw: unknown } | { ok: false; error: unknown } | undefined
  const guarded: Promise<{ ok: true; raw: unknown } | { ok: false; error: unknown }> = spawnPromise.then(
    (raw) => ({ ok: true as const, raw }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  const spawnEarly = guarded.then((outcome) => {
    spawnOutcome = outcome
    wireBackground(outcome)
    resolveHorizon()
    return outcome
  })
  // 防御：spawnEarly 链自身异常不产生 unhandled rejection。
  void spawnEarly.catch(() => {})

  await Promise.race([horizonGate, spawnEarly.then((o) => o)])

  const preResolveFailure =
    spawnOutcome !== undefined && !spawnOutcome.ok && !onResolvedFired ? spawnOutcome.error : undefined
  if (preResolveFailure !== undefined) {
    // 情况 A：spawn 在 onResolved 之前就失败（Profile 不存在、参数非法、节点
    // 离线、非 Git 仓库建 worktree 失败等）。durable 记录已在副作用前登记，
    // 后台兜底链会把该失败结算为 failed（诚实终态，不留僵尸 running，也不
    // 伪造成功）；同时把原始错误当场同步 rethrow 给调用方。
    detachParentSignal()
    throw preResolveFailure
  }

  // 情况 B：onResolved 已触发（真实 execution 元数据），或外部插件未回
  // onResolved 但已同步 settle（execution 留空，绝不伪造）。后台模式就地
  // 解绑父 signal；前台模式保持绑定至 detach/终态。
  if (!foreground) detachParentSignal()

  try {
    svc.writeRecord(record)
    await svc.state.flush?.()
  } catch (persistError) {
    // running 快照已落盘；此处仅补 execution 元数据失败，不撤销 run。
    const message = persistError instanceof Error ? persistError.message : String(persistError)
    process.stderr.write(`workflow ${runId}: execution metadata persist failed: ${message}\n`)
  }
  svc.emitEventSafe('workflow.updated', { run: redactSummaryNodes(svc.redact, { ...run.summary }) })

  return {
    run: redactSummaryNodes(svc.redact, { ...run.summary }),
    ...(executionInfo !== undefined ? { execution: executionInfo } : {}),
  }
}
