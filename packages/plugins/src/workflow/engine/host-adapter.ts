/**
 * host-adapter.ts — 引擎 WorkflowHost ↔ WorkflowServiceHost 适配（自
 * WorkflowService 拆出的内部模块）。
 *
 * 职责：
 * - WorkflowServiceHost：引擎测试注入边界（宿主能力由 KernelRuntime 提供，
 *   测试可用确定性 fake 替换）；
 * - createEngineHost：runtime.ts 的 WorkflowHost（引擎接缝）适配——
 *   spawnAgent=agent_spawn 管道、invokeAction=PluginHost 动作总线（含内建
 *   env.exec）、abortAgent=守卫式中止、runGate=宿主自跑 fallback；
 * - invokeAgentSpawn：单次 agent/resume 调用（agentId 命名空间、单回合超时、
 *   迟到 onResolved 补杀、gate 缺失显式失败）；
 * - abortChildConversation：守卫中止一个 run 的子会话（human 红线由内核
 *   原子复核；绝不回退普通中止）。
 *
 * 服务级生命周期事实（closed / 取消窗口 / 子会话事实即时持久 / 嵌套
 * workflow 引用解析）经 EngineHostDeps 回调注入，避免适配层反向持有服务。
 */

import { HelmError } from '@helm/protocol'
import {
  agentGateResultMissingError as gateResultMissingError,
  sanitizeAgentExecutionInfo as sanitizeExecutionInfo,
  sanitizeAgentGateResult as sanitizeGateResult,
  isAbsoluteTargetPath,
  type ActionManifest,
  type AgentExecutionInfo,
  type AgentGateResult,
  type AgentSpawnRequest,
  type ConversationSummary,
  type EnvExecRequest,
  type EnvExecResponse,
} from '@helm/protocol'
import { extractWorkflowExecutionMeta, withWorkflowSpawnMeta, type WorkflowRunSummary } from '../../contracts.js'
import type { ActiveRun } from './active-run.js'
import { errorMessage } from './run-store.js'
import type { WorkflowHost, WorkflowSpawnRequest, WorkflowSpawnResult } from './runtime.js'

export const BUILTIN_ENV_EXEC_PLUGIN = 'env'
export const BUILTIN_ENV_EXEC_ACTION = 'exec'
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface ValidatedEnvExecInput {
  command: string | string[]
  nodeId?: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  allowFailure?: boolean
}

/** 引擎测试注入边界：宿主能力由 KernelRuntime 提供，测试可用确定性 fake 替换。 */
export interface WorkflowServiceHost {
  /** agent_spawn 管道入口（KernelRuntime.spawnAgent：hook 链 + 原生子会话默认行）。 */
  spawnAgent(request: AgentSpawnRequest): Promise<unknown>
  /**
   * 守卫式中止（通用取消机制）：SDK 调度器 paused（服务 prepare 屏障）时
   * 对会话存活任务只落持久 abort 标记（不唤醒调度器）；运行中则真中止。
   * 恢复屏障（调度器启动前持久取消遗留子会话）由此相位自适应兑现。
   */
  abortConversationGuarded(id: number): Promise<void>
  /**
   * 插件动作调用（PluginHost.invokeAction：manifest 精确匹配 + 输入输出 schema
   * 边界校验）。返回值必须已是安全 JSON（上游 app 层做 stash redact）。
   */
  invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: { conversationId?: number; signal?: AbortSignal },
  ): Promise<unknown>
  /**
   * 插件动作前置校验（PluginHost.prepareAction）：在落盘 action_started 前校验
   * 插件状态、会话 scope 与 inputSchema，并返回定义端 idempotent。
   */
  prepareAction?(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: { conversationId?: number },
  ): { idempotent?: boolean }
  /**
   * 跨节点命令执行（KernelRuntime.execEnv：EnvFabric + SecretStash + 超时 + 脱敏）。
   * 供工作流内建动作 `env.exec`（或无冲突短名 `exec`）调用。
   */
  execEnv?(
    req: Omit<EnvExecRequest, 'stream'>,
    signal?: AbortSignal,
  ): Promise<EnvExecResponse>
  listActions(): ActionManifest[]
  getConversation(id: number): ConversationSummary
  /**
   * 守卫式子会话中止：自动化取消（abort 级联 / init 恢复 / 引擎 abortAgent /
   * 迟到 onResolved 补杀）的唯一入口。实现职责：现读归属事实（human-owned
   * 一律拒绝——看门狗红线）并经内核 abortConversationGuarded 对
   * expectedOwnership + expectedStateSeq 原子复核；目标已删除/守卫冲突时
   * 确定性放弃（诊断），绝不回退普通 abortConversation。
   */
  abortConversationGuarded(id: number): Promise<void>
  emitEvent(type: string, payload: unknown): void
  /**
   * run 终态结算通知（每 run 恰一次；wait/close 必须等待它结束）。宿主用它
   * 驱动 app->kernel 的工作流结算广播（onWorkflowSettled 监听器）。清理异常
   * 在 service 内如实上报为 failed/诊断，不破坏 journal 副作用保护。
   */
  onRunSettled?(summary: WorkflowRunSummary): Promise<void> | void
  /**
   * 后台 run 终态汇报回调：对 notifyParentOnSettle=true 的后台 run 触发——
   * 包括 startBackgroundAgent 的后台子代理与经工具 background 启动的
   * workflow run（同步 SubagentWorkflow / 同步 workflow 不触发）。调用方
   * （app/kernel）向父会话投递完成/失败/中止通知；恰一次（notifiedAt 防重复，
   * init() 补发遗留）。
   */
  onBackgroundAgentSettled?(
    summary: WorkflowRunSummary,
    info: {
      parentConversationId: number
      agentType?: string
      execution?: AgentExecutionInfo
    },
  ): Promise<void> | void
  /**
   * gate 门禁执行（KernelRuntime.runGate：shell + SecretStash env 合并 + 超时）。
   * 这是宿主自跑 fallback：执行环境（native/herdr）已在实际 cwd 内执行过
   * gate 并经 onGateResult 回报时不会走到这里。缺省宿主让带 gate 的 agent
   * 调用显式失败——静默跳过的 gate 等于把未验证的工作标记为已验证。
   * cwd 传子会话工作目录（如有），否则父会话 cwd。
   */
  runGate?(
    command: string,
    options: { cwd?: string; conversationId?: number; signal?: AbortSignal; gateTimeoutMs?: number },
  ): Promise<{ ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean }>
}

/** createEngineHost 的服务侧依赖（生命周期事实回调，现查现用）。 */
export interface EngineHostDeps {
  host: WorkflowServiceHost
  redact: (text: string) => string
  /** 服务停机屏障（close 后拒绝派生）。 */
  isClosed(): boolean
  /** 会话是否处于级联取消窗口（取消期间拒绝派生子代理）。 */
  isCancelling(conversationId: number): boolean
  /** 子会话事实即时持久（onResolved 登记点，崩溃恢复权威坐标）。 */
  persistChildConversationFact(run: ActiveRun, conversationId: number): void
  /** 嵌套 workflow() 引用解析（仅保存目录安全名或显式本地路径）。 */
  loadWorkflowRef(
    ref: { name?: string; scriptPath?: string },
  ): { ok: true; script: string; path?: string } | { ok: false; message: string }
}

export function createEngineHost(
  deps: EngineHostDeps,
  run: ActiveRun,
  parent: ConversationSummary,
): WorkflowHost {
  /** agentId → 子会话 id（onResolved 建立；abort 使用）。 */
  const conversationByAgent = new Map<string, number>()

  return {
    async spawnAgent(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult> {
      return invokeAgentSpawn(deps, run, parent, conversationByAgent, request, false)
    },
    async resumeAgent(agentId, prompt, options): Promise<WorkflowSpawnResult> {
      return invokeAgentSpawn(
        deps,
        run,
        parent,
        conversationByAgent,
        {
          agentId,
          index: -1,
          prompt,
          label: agentId,
          // resume 缺省不携带 agentType（不重配原子会话 Profile）；
          // schema/gate/attachments/回调由引擎续接调用原样下传（附件仅属本轮提交）。
          agentType: '',
          ...(options?.schema !== undefined ? { schema: options.schema } : {}),
          ...(options?.gate !== undefined ? { gate: options.gate } : {}),
          ...(options?.attachments !== undefined ? { attachments: options.attachments } : {}),
          // 显式续接授权透传（ResumeAgentOptions.maxSubagentDepth）：静默丢弃
          // 等于假装授予了子树深度；引擎/内核边界照常校验非法值。
          ...(options?.maxSubagentDepth !== undefined ? { maxSubagentDepth: options.maxSubagentDepth } : {}),
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options?.gateTimeoutMs !== undefined ? { gateTimeoutMs: options.gateTimeoutMs } : {}),
          ...(options?.resumeRef !== undefined ? { resumeRef: options.resumeRef } : {}),
          ...(options?.onResolved !== undefined ? { onResolved: options.onResolved } : {}),
          ...(options?.onGateResult !== undefined ? { onGateResult: options.onGateResult } : {}),
        },
        true,
      )
    },
    abortAgent(agentId: string): void {
      const convId = conversationByAgent.get(agentId)
      if (convId === undefined) return
      // 只中止本 run 派生的子会话（守卫中止：human 红线由内核原子复核）；
      // fire-and-forget 会让 abort/close 返回时子会话仍在跑——记入
      // pendingAborts 由 done 收尾统一 await；不存在（已结束）时幂等静默，
      // 但 rejection 仍须诊断，绝不吞。
      abortChildConversation(deps.host, run, convId)
    },
    ...(deps.host.runGate !== undefined
      ? {
          runGate: async (command: string, options: { agentId: string; cwd?: string; gateTimeoutMs?: number }) => {
            const convId = conversationByAgent.get(options.agentId)
            // cwd 只用引擎确认过的值（result.cwd / 回传元数据）；缺省父会话
            // cwd，绝不猜测远端工作目录。
            return deps.host.runGate!(command, {
              ...(options.cwd !== undefined ? { cwd: options.cwd } : { cwd: parent.cwd }),
              ...(convId !== undefined ? { conversationId: convId } : { conversationId: parent.id }),
              signal: run.abort.signal,
              ...(options.gateTimeoutMs !== undefined ? { gateTimeoutMs: options.gateTimeoutMs } : {}),
            })
          },
        }
      : {}),
    prepareAction: async (actionId, input) => {
      const resolved = resolveActionId(deps.host, actionId)
      if (resolved.builtin === 'env.exec') {
        validateEnvExecInput(deps.host, input)
        return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: false }
      }
      if (deps.host.prepareAction !== undefined) {
        const prep = deps.host.prepareAction(resolved.pluginId, resolved.actionId, input, {
          conversationId: run.conversationId,
        })
        return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: prep?.idempotent }
      }
      const manifests = deps.host.listActions()
      const manifest = manifests.find((m) => m.pluginId === resolved.pluginId && m.id === resolved.actionId)
      return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: manifest?.idempotent }
    },
    async invokeAction(actionId, input, context) {
      const resolved = resolveActionId(deps.host, actionId)
      if (resolved.builtin === 'env.exec') {
        const parsed = validateEnvExecInput(deps.host, input)
        const execPromise = deps.host.execEnv?.(
          {
            command: parsed.command,
            ...(parsed.nodeId !== undefined ? { nodeId: parsed.nodeId } : {}),
            ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
            ...(parsed.env !== undefined ? { env: parsed.env } : {}),
            ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
            conversationId: run.conversationId,
          },
          context.signal,
        )
        if (execPromise === undefined) {
          throw new HelmError('not_supported', '当前工作流宿主未配置 env.exec 命令执行端口', 501)
        }
        run.pendingExecs.add(execPromise)
        let res: EnvExecResponse
        try {
          res = await execPromise
        } finally {
          run.pendingExecs.delete(execPromise)
        }
        const redactedOutput = deps.redact(res.output)
        const succeeded = res.ok && res.exitCode === 0 && !res.timedOut
        if (!succeeded && parsed.allowFailure !== true) {
          const tail = redactedOutput.length > 2000 ? redactedOutput.slice(-2000) : redactedOutput
          throw new HelmError(
            'env_exec_failed',
            `命令执行失败${res.timedOut ? '（超时）' : ''}（exitCode=${String(res.exitCode)}）${tail ? ': ' + tail : ''}`,
            502,
            { exitCode: res.exitCode, timedOut: res.timedOut },
          )
        }
        return {
          pluginId: 'env',
          actionId: 'exec',
          result: {
            ok: succeeded,
            exitCode: res.exitCode,
            output: redactedOutput,
            timedOut: res.timedOut,
          },
        }
      }
      const result = await deps.host.invokeAction(resolved.pluginId, resolved.actionId, input, {
        conversationId: run.conversationId,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      })
      return { pluginId: resolved.pluginId, actionId: resolved.actionId, result }
    },
    loadWorkflow: (ref) => deps.loadWorkflowRef(ref),
  }
}

/**
 * 守卫中止一个 run 的子会话：经宿主守卫入口（human 红线由内核原子复核；
 * 拒绝/失败诊断不吞 stderr），绝不回退普通中止；完成前计入 pendingAborts
 * （settle 前必等完——迟到调用在结算后仅诊断，同样不阻断终态）。
 */
export function abortChildConversation(
  host: WorkflowServiceHost,
  run: ActiveRun,
  conversationId: number,
): Promise<void> {
  const pending = host
    .abortConversationGuarded(conversationId)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `workflow ${run.runId}: guarded abort conversation ${conversationId} rejected: ${message}\n`,
      )
    })
    .then(() => {
      run.pendingAborts.delete(pending)
    })
  // 先注册再执行：catch 链已保证 pending 不 reject，then 删除自引用安全。
  run.pendingAborts.add(pending)
  // 返回该 pending（绝不 reject）：单回合超时路径需在返回失败前等完自己
  // 触发的守卫中止，避免紧随的 resume 撞上在途 abort。
  return pending
}

/** 单次 agent/resume 调用：组装 protocol AgentSpawnRequest 投 agent_spawn 管道。 */
export async function invokeAgentSpawn(
  deps: EngineHostDeps,
  run: ActiveRun,
  parent: ConversationSummary,
  conversationByAgent: Map<string, number>,
  request: WorkflowSpawnRequest,
  isResume: boolean,
): Promise<WorkflowSpawnResult> {
  if (deps.isClosed() || run.abort.signal.aborted) {
    return { ok: false, error: 'Workflow aborted.' }
  }
  // 级联取消窗口内的会话不再派生（防取消期间又派新任务；返回节点错误而非
  // 抛出——引擎把 agent 节点结算为失败，不阻断同批其他节点）。
  if (deps.isCancelling(run.conversationId)) {
    return { ok: false, error: '[aborted] 发起会话所在任务树正在取消，拒绝派生子代理' }
  }

  // 引擎内 agentId（wf-agent-N）跨 run 重复；全局 agentSessions 是进程级
  // Map，两个同 parent 的并行 run 会互相覆盖对方的映射，resume 可能续接错
  // child。投给 native 的稳定 ID加 runId 命名空间；引擎内部 ID/label 不变。
  const nativeAgentId = `${run.runId}:${request.agentId}`
  // resume 严格续接：优先用本 run 内 spawn 时记录的 convId；仅当本 run 未见
  // 过（如 resume 自重放账本的 agent）才退回 native 全局映射。
  const knownConvId = conversationByAgent.get(request.agentId)
  // resumeRef 已是 WorkflowSpawnRequest 正式字段（runtime 重放/续接时透传
  // executionId 或 conversationId 字符串），无需再经交集类型强转读取。
  const resumeRef = isResume ? String(request.resumeRef ?? knownConvId ?? nativeAgentId) : undefined

  /** 已 sanitized 的执行元数据（onResolved 可能与 spawn 返回前多次回调——幂等只记最新）。 */
  let executionInfo: AgentExecutionInfo | undefined
  /** 已 sanitized 的 gate 回报（执行环境内恰好一次执行后的结果）。 */
  let gateResult: AgentGateResult | undefined

  // agent({ timeoutMs }) 单回合超时：runtime 侧 WorkflowSpawnRequest 的扩展
  // 字段（DSL 接入由 runtime 分支落地）；服务边界按设计范围强校验。
  const timeoutMs = readAgentTimeoutMs(request)
  /**
   * 自有 AbortController + unref 计时器（不用 AbortSignal.timeout：其计时器
   * 不可撤销，旧 attempt 的超时会在 spawn 终局后迟到触发，经 agentId 映射
   * 误中止同会话的新 attempt）。超时 abort 以 TimeoutError 为 reason（Herdr
   * 按 signal.reason.name === 'TimeoutError' 识别单回合超时，无需新增协议
   * 字段）；成功/失败出口统一清计时器。
   */
  let timeoutController: AbortController | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  /** 本 attempt 因超时触发的守卫中止（返回前必等完，防 resume 撞在途 abort）。 */
  const timeoutAborts = new Set<Promise<void>>()
  if (timeoutMs !== undefined) {
    timeoutController = new AbortController()
    const controller = timeoutController
    timeoutTimer = setTimeout(() => {
      timeoutTimer = undefined
      // run 级取消已另有归因；此处只记录单回合超时事实。
      if (run.abort.signal.aborted) return
      timedOut = true
      controller.abort(new DOMException(`子代理回合超过 ${timeoutMs}ms 上限`, 'TimeoutError'))
      // 超时即守卫中止子会话（human 红线由内核原子复核）：优先 onResolved
      // 已回传的 conversationId，否则用本 run 内登记的 agentId 映射。
      const childId = executionInfo?.conversationId ?? conversationByAgent.get(request.agentId)
      if (childId !== undefined) timeoutAborts.add(abortChildConversation(deps.host, run, childId))
    }, timeoutMs)
    timeoutTimer.unref?.()
  }
  const timeoutSignal = timeoutController?.signal
  /** 成功/失败出口统一撤销计时器（监听随 controller 置空一并失效可回收）。 */
  const disarmTimeout = (): void => {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer)
      timeoutTimer = undefined
    }
    timeoutController = undefined
  }
  /** 超时失败返回前等完自己触发的守卫中止（后续 resume 不撞忙）。 */
  const awaitTimeoutAborts = async (): Promise<void> => {
    if (timeoutAborts.size > 0) await Promise.allSettled([...timeoutAborts])
  }
  const timeoutMessage = (cause?: unknown): string =>
    `[agent_timeout] 子代理 ${request.label} 回合超过 ${timeoutMs}ms 上限；已请求取消，` +
    '实际执行状态与续接条件以 execution 和执行方诊断为准' +
    (cause === undefined ? '' : `\n${deps.redact(errorMessage(cause))}`)

  const proto: AgentSpawnRequest = {
    parentConversationId: run.conversationId,
    prompt: request.prompt,
    agentId: nativeAgentId,
    // gate 原样下传：执行权在实际执行环境（native 子会话 cwd / herdr 窗格），
    // 经 onGateResult 回报后引擎免二次执行。
    ...(request.gate !== undefined ? { gate: request.gate } : {}),
    ...(request.agentType !== '' ? { agentType: request.agentType } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.isolation !== undefined ? { isolation: request.isolation } : {}),
    ...(!isResume && request.cwd !== undefined ? { cwd: request.cwd } : {}),
    ...(request.gateTimeoutMs !== undefined ? { gateTimeoutMs: request.gateTimeoutMs } : {}),
    meta: withWorkflowSpawnMeta(undefined, {
      runId: run.runId,
      ...(request.maxSubagentDepth !== undefined ? { maxSubagentDepth: request.maxSubagentDepth } : {}),
    }),
    ...(request.schema !== undefined ? { schema: request.schema.schema } : {}),
    ...(request.attachments !== undefined ? { attachments: request.attachments } : {}),
    ...(request.secretNames !== undefined ? { secretNames: request.secretNames } : {}),
    ...(resumeRef !== undefined ? { resume: resumeRef } : {}),
    // cwd 不注入：执行行按自身链解析（原生 request>Profile>parent镜像>Hub；
    // herdr request>Profile.workspace>parent>Hub）。引擎层注入会压过 Profile
    // 路由，resume 时更会把已建子会话/Worktree 的实际 cwd 重置回父目录。
    onResolved: (raw: unknown) => {
      const info = sanitizeExecutionInfo(raw, { agentId: nativeAgentId })
      executionInfo = info
      if (info.conversationId !== undefined) {
        conversationByAgent.set(request.agentId, info.conversationId)
        run.childConversations.add(info.conversationId)
        // 迟到 onResolved 补杀：abort/超时先于执行元数据落地时，abortAgent
        // 的映射里还没有该子会话——在登记点立即补守卫中止，绝不因时序漏杀；
        // 超时路径计入本 attempt 等待面（返回前等完）。
        if (run.abort.signal.aborted) {
          abortChildConversation(deps.host, run, info.conversationId)
        } else if (timedOut) {
          timeoutAborts.add(abortChildConversation(deps.host, run, info.conversationId))
        }
        // 子会话事实即时持久：崩溃恢复以这组 IDs 为权威坐标（见
        // persistChildConversationFact）。同步/后台 workflow 一视同仁——
        // 统一经 invokeSpawn，不按启动形态分支。
        deps.persistChildConversationFact(run, info.conversationId)
      }
      request.onResolved?.(info)
    },
    ...(request.gate !== undefined
      ? {
          onGateResult: (raw: unknown) => {
            gateResult = sanitizeGateResult(raw, { agentId: nativeAgentId })
            request.onGateResult?.(gateResult)
          },
        }
      : {}),
    signal: timeoutSignal === undefined ? run.abort.signal : AbortSignal.any([run.abort.signal, timeoutSignal]),
  }

  try {
    const raw = await deps.host.spawnAgent(proto)
    // 超时已触发：子会话已被守卫中止，迟到的返回不可信，按超时失败处理；
    // 返回前等完自己触发的守卫中止（后续 resume 不撞在途 abort）。
    if (timedOut) {
      await awaitTimeoutAborts()
      return {
        ok: false,
        error: timeoutMessage(),
        timedOut: true,
        ...(executionInfo !== undefined ? { executionInfo } : {}),
        ...(gateResult !== undefined ? { gate: gateResult } : {}),
      }
    }
    // native 返回：有 schema → 已校验对象（转 JSON 交引擎复核）；无 schema → 文本。
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
    // 外部执行环境（executionId 存在）必须回报 gate；缺失即显式失败，
    // 绝不在本机猜远端工作目录补跑。
    if (request.gate !== undefined && gateResult === undefined && executionInfo?.executionId !== undefined) {
      throw gateResultMissingError({
        agentId: nativeAgentId,
        executionId: executionInfo.executionId,
        command: request.gate,
      })
    }
    return {
      ok: true,
      text,
      ...(executionInfo !== undefined ? { executionInfo } : {}),
      ...(gateResult !== undefined ? { gate: gateResult } : {}),
    }
  } catch (error) {
    // 失败分支保留已拿到的执行元数据与门禁结果：已创建的 Worktree 与
    // conversationId 不随失败丢弃，供 agent.withMeta/goal 上报与原地 resume。
    const retained: Pick<WorkflowSpawnResult, 'executionInfo' | 'gate'> = {
      ...(executionInfo !== undefined ? { executionInfo } : {}),
      ...(gateResult !== undefined ? { gate: gateResult } : {}),
    }
    if (timedOut) {
      await awaitTimeoutAborts()
      return {
        ok: false,
        error: timeoutMessage(error),
        timedOut: true,
        ...retained,
      }
    }
    if (error instanceof HelmError) {
      // 错误码随消息透传（节点 error 面向用户，码即诊断锚点）。
      return { ok: false, error: `[${error.code}] ${error.message}`, ...retained }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message, ...retained }
  } finally {
    // 成功/失败出口统一清计时器与监听：旧 attempt 的超时绝不允许在未来
    // 触发（同会话可能已被新 attempt 续接，迟到超时会误杀新回合）。
    disarmTimeout()
  }
}

/**
 * agent({ timeoutMs }) 边界校验：runtime 侧 WorkflowSpawnRequest 扩展字段
 * （DSL 侧由 runtime 分支接入；未携带 = 无单回合超时）。取值 1_000..
 * 3_600_000 整数毫秒，非法显式拒绝，绝不静默锐化。
 */
export function readAgentTimeoutMs(request: WorkflowSpawnRequest): number | undefined {
  // timeoutMs 已是 WorkflowSpawnRequest 正式字段；运行时值仍做形状校验
  // （边界校验纪律：引擎侧输入不因类型声明而免检）。
  const raw: unknown = request.timeoutMs
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1_000 || raw > 3_600_000) {
    throw new HelmError(
      'validation_error',
      `agent timeoutMs 必须是 1_000..3_600_000 的整数毫秒值（收到 ${JSON.stringify(raw)}）`,
      400,
      { timeoutMs: raw },
    )
  }
  return raw
}

/**
 * 全限定 actionId 解析：以 listActions() 的 manifest 精确匹配，支持内建 env.exec。
 * pluginId 含 ':'（builtin:profile），actionId 理论上可含 '.'，简单 split
 * 会在坏点号上错位——只信 manifest 与内建白名单。
 */
export function resolveActionId(
  host: WorkflowServiceHost,
  qualified: string,
): { pluginId: string; actionId: string; builtin?: 'env.exec' } {
  if (qualified === `${BUILTIN_ENV_EXEC_PLUGIN}.${BUILTIN_ENV_EXEC_ACTION}`) {
    return {
      pluginId: BUILTIN_ENV_EXEC_PLUGIN,
      actionId: BUILTIN_ENV_EXEC_ACTION,
      builtin: 'env.exec',
    }
  }

  const manifests = host.listActions()
  if (qualified === BUILTIN_ENV_EXEC_ACTION) {
    const sameShort = manifests.filter((m) => m.id === BUILTIN_ENV_EXEC_ACTION)
    if (sameShort.length === 0) {
      return {
        pluginId: BUILTIN_ENV_EXEC_PLUGIN,
        actionId: BUILTIN_ENV_EXEC_ACTION,
        builtin: 'env.exec',
      }
    }
    throw new HelmError(
      'ambiguous_action',
      `动作短 id "${qualified}" 命中多个动作（含内建 env.exec），请用全限定 id：env.exec, ${sameShort.map((m) => `${m.pluginId}.${m.id}`).join(', ')}`,
      400,
      { qualified },
    )
  }

  // 1) 全限定精确匹配。
  for (const manifest of manifests) {
    if (`${manifest.pluginId}.${manifest.id}` === qualified) {
      return { pluginId: manifest.pluginId, actionId: manifest.id }
    }
  }
  // 2) 裸短 id：唯一时允许，歧义拒绝。
  const sameShort = manifests.filter((m) => m.id === qualified)
  if (sameShort.length === 1) {
    return { pluginId: sameShort[0]!.pluginId, actionId: sameShort[0]!.id }
  }
  if (sameShort.length > 1) {
    throw new HelmError(
      'ambiguous_action',
      `动作短 id "${qualified}" 命中多个插件，请用全限定 id：${sameShort.map((m) => `${m.pluginId}.${m.id}`).join(', ')}`,
      400,
      { qualified },
    )
  }
  throw new HelmError('unknown_action', `未注册的动作：${qualified}`, 404, { qualified })
}

export function validateEnvExecInput(host: WorkflowServiceHost, input: unknown): ValidatedEnvExecInput {
  if (host.execEnv === undefined) {
    throw new HelmError('not_supported', '当前工作流宿主未配置 env.exec 命令执行端口', 501)
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HelmError('validation_error', 'env.exec 入参必须是 JSON 对象', 400)
  }
  const raw = input as Record<string, unknown>
  const allowedKeys = new Set(['command', 'nodeId', 'cwd', 'env', 'timeoutMs', 'allowFailure'])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new HelmError('validation_error', `env.exec 发现未知选项 "${key}"`, 400)
    }
  }

  const rawCommand = raw.command
  let command: string | string[]
  if (typeof rawCommand === 'string') {
    if (rawCommand.trim().length === 0) {
      throw new HelmError('validation_error', 'env.exec command 不能为空字符串', 400)
    }
    command = rawCommand
  } else if (Array.isArray(rawCommand)) {
    if (
      rawCommand.length === 0 ||
      !rawCommand.every((item) => typeof item === 'string') ||
      rawCommand[0]!.trim().length === 0
    ) {
      throw new HelmError('validation_error', 'env.exec command 数组必须非空且首项为非空字符串', 400)
    }
    command = rawCommand as string[]
  } else {
    throw new HelmError('validation_error', 'env.exec command 必须是非空字符串或非空字符串数组', 400)
  }

  let nodeId: string | undefined
  if (raw.nodeId !== undefined) {
    if (typeof raw.nodeId !== 'string' || !NODE_ID_RE.test(raw.nodeId)) {
      throw new HelmError(
        'validation_error',
        'env.exec nodeId 需匹配 /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/（字母数字开头，可含 . _ -）',
        400,
      )
    }
    nodeId = raw.nodeId
  }

  let cwd: string | undefined
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || raw.cwd.trim().length === 0 || !isAbsoluteTargetPath(raw.cwd)) {
      throw new HelmError(
        'validation_error',
        'env.exec cwd 必须为跨平台绝对路径（POSIX/Windows/UNC）',
        400,
      )
    }
    cwd = raw.cwd
  }

  let env: Record<string, string> | undefined
  if (raw.env !== undefined) {
    if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
      throw new HelmError('validation_error', 'env.exec env 必须是键值对象', 400)
    }
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v !== 'string') {
        throw new HelmError('validation_error', `env.exec env.${k} 必须为字符串`, 400)
      }
    }
    env = raw.env as Record<string, string>
  }

  let timeoutMs: number | undefined
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== 'number' || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 600_000) {
      throw new HelmError('validation_error', 'env.exec timeoutMs 必须是 1 到 600000 之间的整数', 400)
    }
    timeoutMs = raw.timeoutMs
  }

  let allowFailure: boolean | undefined
  if (raw.allowFailure !== undefined) {
    if (typeof raw.allowFailure !== 'boolean') {
      throw new HelmError('validation_error', 'env.exec allowFailure 必须为 boolean', 400)
    }
    allowFailure = raw.allowFailure
  }

  return { command, nodeId, cwd, env, timeoutMs, allowFailure }
}
