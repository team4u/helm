/**
 * runtime.ts — 工作流 run 的宿主半边（执行编排）。
 *
 * 自 @tintinweb/pi-subagents v0.23.1 (MIT) 移植，helm 适配点：
 * - 新增 `action()` 原语的宿主侧处理：与 agent 共享同一全序前缀账本（index 按
 *   调用发起顺序分配）；`action_started` 追加+fsync 成功后才执行 handler，
 *   终态行落盘后才 resolve 调用 promise；任一写失败即 fatal（不可在无法记账
 *   的状态下继续执行副作用）。恢复时 started 无终态由上层显式报
 *   `workflow_action_uncertain`，绝不自动重跑。
 * - 前缀重放逐项匹配（index+key+kind+ok）：resumed 行不再整体禁用前缀，
 *   已确认成功的 action/agent 一律复用，副作用零重复。缓存子结果可作为同一
 *   脚本后续 resume 调用的前缀来源，但无活会话：前缀失配后需要真正续接时
 *   显式失败，绝不伪造 live 续接。
 * - spawn 接缝面向 helm `WorkflowServiceHost`（agent_spawn 钩子管道的注入式
 *   适配在 service.ts），runtime 本体保持零内核依赖、可独立测试。
 * - worker 线程 + vm 双层边界：terminate 可杀死循环脚本；vm 禁动态代码生成与
 *   非确定 API（见 worker-source.ts）。这是可终止/确定性边界，不是恶意代码
 *   安全沙箱。
 * - label/resume 句柄按 scopeId 命名空间隔离（根 = 0，未传视为根）：嵌套
 *   workflow() 的同名 label 互不干扰；失败调用只要拿到 conversationId /
 *   executionId 即登记续接句柄；maxAttempts > 1 复用同一 attempt 环，经
 *   resumeAgent 续接重试，失败原因以增量块追加进下次尝试 prompt。
 *
 * 职责拆分（本文件只保留编排，公共导出面不变）：
 * - runtime-types.ts：全部类型契约（宿主接缝 / run 选项 / worker 消息面）；
 * - runtime-validation.ts：边界校验 / args 标准化 / 脚本校验等纯函数与常量；
 * - runtime-control.ts：并发信号量 + 暂停/跳过/重试控制板；
 * - runtime-recorder.ts：agent 行尽力记账器（ioErrors 诊断面）；
 * - runtime-agent-handler.ts / runtime-action-handler.ts：两类调用的大块
 *   handler（显式依赖注入，语义与拆分前逐行一致）。
 */

import { Worker } from 'node:worker_threads'
import type { WorkflowJournalEntry } from './journal.js'
import type { WorkflowEntry } from './progress.js'
import { WORKER_SOURCE } from './worker-source.js'
import { JournalReplay } from './replay.js'
import {
  assertBoundarySafe,
  normalizeWorkflowArgs,
  unawaitedLaunchMessage,
  validateScript,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  WORKFLOW_NESTED_CAP,
  workflowConcurrency,
} from './runtime-validation.js'
import { RuntimeControl, Semaphore } from './runtime-control.js'
import { AgentJournalRecorder } from './runtime-recorder.js'
import { handleAgentCall, type AgentCallContext } from './runtime-agent-handler.js'
import { handleActionCall, type ActionCallContext } from './runtime-action-handler.js'
import type {
  CompletedChild,
  RunWorkflowOptions,
  WorkflowRunResult,
  WorkflowScriptRef,
  WorkflowScriptSource,
  WorkerMessage,
} from './runtime-types.js'

/* 公共面原样 re-export（既有导入路径 runtime.js / index.js 不变）。 */
export {
  WorkflowRuntimeError,
  workflowConcurrency,
  assertBoundarySafe,
  normalizeWorkflowArgs,
  redactPlainValue,
  validateScript,
  precheckScriptSyntax,
  MAX_SCRIPT_LENGTH,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  WORKFLOW_NESTED_CAP,
  MAX_AGENT_ATTEMPTS,
  scopedResumeKey,
  agentRetryPrompt,
} from './runtime-validation.js'
export type {
  WorkflowSpawnRequest,
  WorkflowSpawnResult,
  WorkflowGateResult,
  WorkflowScriptRef,
  WorkflowScriptSource,
  WorkflowHost,
  ResumeAgentOptions,
  WorkflowControl,
  RunWorkflowOptions,
  WorkflowRunResult,
} from './runtime-types.js'

/** 账本追加输入见 journal.ts 的权威定义（此处旧别名仅为兼容本文件内引用）。 */
export type { JournalWriteInput } from './journal.js'

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const { script, host } = options

  const normalizedArgs = normalizeWorkflowArgs(options.args)
  assertBoundarySafe(normalizedArgs, 'args')

  const { meta, body } = validateScript(script)
  const agentCap = options.agentCap ?? WORKFLOW_AGENT_CAP
  const itemCap = options.itemCap ?? WORKFLOW_ITEM_CAP
  const semaphore = new Semaphore(options.concurrency ?? workflowConcurrency())

  const progress: WorkflowEntry[] = []
  const inflight = new Set<string>()
  const completedByLabel = new Map<string, CompletedChild>()
  const openLaunches = new Map<number, string>()
  /** run 级共享计数（agent/action handler 与 respond/finish 读写同一对象）。 */
  const counters = { agentCount: 0, replayedCount: 0, spentOutputTokens: 0 }
  let callIndex = 0
  let aborted = false
  let settled = false

  /* --- resume state ---------------------------------------------------- */

  const journalEntries: readonly WorkflowJournalEntry[] = options.journal?.entries ?? []
  const inPlaceResume = options.journal?.inPlaceResume === true
  const appendJournal = options.journal?.append
  const redactText = options.redact ?? ((text: string) => text)
  const replay = new JournalReplay(journalEntries)
  const recorder = new AgentJournalRecorder(appendJournal, redactText)
  const unsettledNativeCoords = new Set<string>(
    inPlaceResume
      ? replay
          .unsettledStartedAgents()
          .filter((e) => e.execution.conversationId !== undefined && e.execution.executionId === undefined)
          .map((e) => JSON.stringify([e.scopePath, e.scopeCallIndex, e.attempt ?? 1]))
      : [],
  )
  let reattachHorizonFired = false
  const fireReattachHorizon = () => {
    if (reattachHorizonFired) return
    reattachHorizonFired = true
    options.onReattachHorizon?.()
  }
  const markNativeReattachResolved = (coordKey: string) => {
    unsettledNativeCoords.delete(coordKey)
    if (unsettledNativeCoords.size === 0) fireReattachHorizon()
  }
  if (unsettledNativeCoords.size === 0) fireReattachHorizon()

  const allocateIndex = () => callIndex++

  /* --- live control ---------------------------------------------------- */

  const control = new RuntimeControl(host, () => aborted || settled)
  options.onControl?.(control.toControl())

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      body,
      metaJson: JSON.stringify(meta),
      argsJson: normalizedArgs === undefined ? undefined : JSON.stringify(normalizedArgs),
      itemCap,
      nestedCap: options.nestedCap ?? WORKFLOW_NESTED_CAP,
    },
  })

  return await new Promise<WorkflowRunResult>((resolve) => {
    const emit = (entries: WorkflowEntry[]) => {
      if (entries.length === 0) return
      progress.push(...entries)
      options.onProgress?.(entries)
    }

    const respond = (
      callId: number,
      ok: boolean,
      value?: unknown,
      error?: string,
      fatal?: boolean,
    ) => {
      openLaunches.delete(callId)
      if (settled) return
      // 致命错误属于整个 run，不能让脚本 catch 或后续并发消息绕过副作用保护。
      if (fatal) {
        finish({ status: 'failed', error: error ?? 'Fatal workflow error.' })
        return
      }
      worker.postMessage({ type: 'response', callId, ok, value, error, fatal, spent: counters.spentOutputTokens })
    }

    const isSuspended = () => options.isSuspended?.() === true

    const finish = (
      result: Omit<WorkflowRunResult, 'meta' | 'progress' | 'agentCount' | 'replayedCount'>,
    ) => {
      if (settled) return
      settled = true
      fireReattachHorizon()
      options.signal?.removeEventListener('abort', onAbort)
      control.releasePause()
      if (!isSuspended()) {
        for (const agentId of inflight) host.abortAgent(agentId)
      }
      inflight.clear()
      semaphore.drain()
      const settle = () =>
        resolve({ ...result, meta, progress, agentCount: counters.agentCount, replayedCount: counters.replayedCount, ...(recorder.ioErrors.length > 0 ? { journalIoErrors: [...recorder.ioErrors] } : {}) })
      void worker.terminate().then(settle, settle)
    }

    function onAbort() {
      aborted = true
      // terminate() 是 worker 层存在的理由：它能在脚本自旋或卡在 await 中途时停下。
      finish({ status: 'killed', error: isSuspended() ? 'Workflow suspended.' : 'Workflow aborted.' })
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const runState = { isAborted: () => aborted, isSettled: () => settled, isSuspended }

    const agentCtx: AgentCallContext = {
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      inPlaceResume,
      host,
      agentCap,
      retryFailedCalls: options.journal?.retryFailedCalls === true,
      runState,
      emit,
      respond,
      allocateIndex,
      recordAgent: (entry) => recorder.record(entry),
      recordAgentStarted: (entry) => recorder.recordStarted(entry),
      markNativeReattachResolved,
      inflight,
      semaphore,
      control,
      completedByLabel,
      openLaunches,
      replay,
      counters,
      redactText,
    }
    const actionCtx: ActionCallContext = {
      host,
      signal: options.signal,
      inPlaceResume,
      runState,
      emit,
      respond,
      allocateIndex,
      openLaunches,
      replay,
      semaphore,
      control,
      counters,
      appendJournal,
      redactText,
    }

    async function handleLoadWorkflow(callId: number, ref: WorkflowScriptRef): Promise<void> {
      const loadWorkflow = host.loadWorkflow?.bind(host)
      if (loadWorkflow === undefined) {
        respond(callId, false, undefined, 'This workflow host cannot run nested workflows.', true)
        return
      }
      let source: WorkflowScriptSource
      try {
        source = await loadWorkflow(ref)
      } catch (error) {
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error))
        return
      }
      if (!source.ok) {
        respond(callId, false, undefined, source.message)
        return
      }
      try {
        const child = validateScript(source.script)
        respond(callId, true, {
          name: child.meta.name,
          metaJson: JSON.stringify(child.meta),
          body: child.body,
        })
      } catch (error) {
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error))
      }
    }

    worker.on('message', (message: WorkerMessage) => {
      if (settled) return
      try {
      switch (message.type) {
        case 'progress':
          emit(message.entries)
          break
        case 'call':
          if (message.method === 'workflow') {
            void handleLoadWorkflow(message.callId, message.payload).catch((error: unknown) => {
              finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
            })
            break
          }
          if (message.method === 'action') {
            void handleActionCall(actionCtx, message.callId, message.payload).catch((error: unknown) => {
              finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
            })
            break
          }
          void handleAgentCall(agentCtx, message.callId, message.payload).catch((error: unknown) => {
            finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
          })
          break
        case 'complete': {
          const unawaited = [...openLaunches.values()]
          if (unawaited.length > 0) {
            finish({ status: 'failed', error: unawaitedLaunchMessage(unawaited) })
            break
          }
          finish({
            status: 'completed',
            ...(message.resultJson === undefined ? {} : { value: JSON.parse(message.resultJson) }),
          })
          break
        }
        case 'error':
          finish({ status: 'failed', error: message.message })
          break
      }
      } catch (outerError) {
        process.stderr.write(
          `WORKER-MSG-THROW: ${outerError instanceof Error ? outerError.stack : String(outerError)}\n`,
        )
        finish({
          status: 'failed',
          error: outerError instanceof Error ? outerError.message : String(outerError),
        })
      }
    })

    worker.on('error', (error) => {
      finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    })

    worker.on('exit', () => {
      finish({ status: 'failed', error: 'Workflow worker exited before completing.' })
    })
  })
}
