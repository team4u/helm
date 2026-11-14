/**
 * builtin:workflow 后台子代理安全插话（steer）纯逻辑。
 *
 * 定位：父主会话（或人工 HTTP/CLI）对 subagent(background:true) 派生的后台
 * 子代理运行插入一次指导，按节点解析结果路由原生子会话或外部执行：
 * 1. run 侧：仅 kind=subagent 且 status=running 的运行，且不在级联取消边界内；
 * 2. 目标解析：只认 run 记录内已解析（onResolved 回传）且仍在 running 的
 *    agent 节点——原生子会话（conversationId）与外部执行（controls.steer +
 *    executionId + nodeId）两类候选并存即歧义拒绝（绝不优先 native 吞掉
 *    external，也绝不按 agentType/runtime.kind 猜测路由）；
 * 3. caller 侧：携带会话上下文的调用（Agent 工具 / run_action / workflow
 *    action）必须是 run 发起会话的自身或祖先（与 runs 会话分片投影的可见
 *    面一致）；人工 HTTP/CLI 无会话上下文，以 run 发起会话为权威上下文放行；
 * 4. 原生路径：子会话父链必须可达 run 发起会话（防记录漂移/伪装）；归属
 *    human 显式拒绝（看门狗红线），bot/helm 经 ctx.host.submitInputGuarded
 *    在内核提交点原子复核（expectedOwnership/expectedStateSeq）；
 * 5. 外部路径：依据节点 controls.steer 动态 invokeAction（pluginId/actionId
 *    全部来自记录，零硬编码插件 ID）；委托输入为 ExternalSteerRequest 标准
 *    契约（executionId/nodeId/workflowRunId/parentConversationId/text），
 *    透传原调用 context（含 signal，绝不伪造 caller）；产物按
 *    ExternalSteerResult 逐字段核销（steered/executionId/nodeId/ownership
 *    'helm'/stateChangeSeq 非负安全整数/guardLevel 'cas'），任何坏产物显式
 *    拒绝。控制动作非幂等：超时/断线不重试、不伪造成功（invokeAction 单次
 *    调用即终局）。steered 仅代表投递成功，不代表指导已执行完成。
 *
 * 本模块零引擎依赖（不 import engine/），全部宿主端口经参数注入，
 * 供 workflow.ts 动作注册与确定性单测共用。
 */
import { HelmError, type ConversationSummary, type ExternalSteerResult, type WorkflowRunSummary } from '@helm/protocol'
import { isAncestorOrSelf } from '../lineage.js'

/** steer 所需宿主端口（ctx.host 子集；注入确定性 fake 即可全覆盖测试）。 */
export interface SteerHostPorts {
  getConversation(id: number): ConversationSummary
  getConversationOwnership(id: number): 'helm' | 'bot' | 'human'
  submitInputGuarded(
    conversationId: number,
    text: string,
    opts: { origin: 'agent'; whenBusy: 'steer'; whenIdle: 'reject'; meta: Record<string, unknown> },
    guard: { expectedOwnership: 'bot' | 'helm'; expectedStateSeq: number },
  ): Promise<unknown>
  /** 宿主动作调用端口（外部执行委托；输出已经宿主 outputSchema 校验）。 */
  invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: { conversationId?: number; signal?: AbortSignal },
  ): Promise<unknown>
}

/** steer 所需运行记录端口（WorkflowService 只读子集）。 */
export interface SteerRunPorts {
  getRun(runId: string): WorkflowRunSummary
  isConversationCancelling(conversationId: number): boolean
}

export interface SteerActionInput {
  runId: string
  text: string
}

/** steer 动作结果：targetKind 可辨识原生/外部联合（CLI/HTTP/模型同形）。 */
export type SteerActionOutput =
  | {
      steered: true
      runId: string
      targetKind: 'native'
      conversationId: number
      ownership: 'bot' | 'helm'
      stateChangeSeq: number
      guardLevel: 'cas'
    }
  | {
      steered: true
      runId: string
      targetKind: 'external'
      executionId: string
      nodeId: string
      ownership: 'helm'
      stateChangeSeq: number
      guardLevel: 'cas'
    }

export interface SteerActionContext {
  conversationId?: number
  signal?: AbortSignal
}

function steerError(code: string, message: string, status: number, details?: Record<string, unknown>): HelmError {
  return new HelmError(code, message, status, details)
}

/** 外部委托产物严格核销（见 ExternalSteerResult；任何坏产物显式拒绝）。 */
export function parseExternalSteerResult(
  raw: unknown,
  expected: { executionId: string; nodeId: string; pluginId: string; actionId: string },
): { stateChangeSeq: number } {
  const invalid = (reason: string): HelmError =>
    steerError(
      'steer_delegate_invalid',
      `外部执行 steer 委托 ${expected.pluginId}.${expected.actionId} 返回非法产物（${reason}）：拒绝采信，绝不伪造成功`,
      502,
      { pluginId: expected.pluginId, actionId: expected.actionId, executionId: expected.executionId, nodeId: expected.nodeId, reason },
    )
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('产物必须是对象')
  const source = raw as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!['steered', 'executionId', 'nodeId', 'stateChangeSeq', 'ownership', 'guardLevel'].includes(key)) {
      throw invalid(`未知字段 "${key}"`)
    }
  }
  if (source['steered'] !== true) throw invalid('steered 必须为 true')
  if (source['executionId'] !== expected.executionId) throw invalid('executionId 与目标节点不一致')
  if (source['nodeId'] !== expected.nodeId) throw invalid('nodeId 与目标节点不一致')
  if (source['ownership'] !== 'helm') throw invalid("ownership 必须为 'helm'")
  if (source['guardLevel'] !== 'cas') throw invalid("guardLevel 必须为 'cas'（未通告原子守卫能力的执行环境必须显式拒绝）")
  const seq = source['stateChangeSeq']
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    throw invalid('stateChangeSeq 必须是非负安全整数')
  }
  return { stateChangeSeq: seq }
}

/**
 * 后台子代理安全插话主入口。任何不支持情况显式抛 HelmError（错误码
 * 稳定，见各分支）；内核 guarded 端口的 409/404 冲突原样透传（确定性放弃，
 * 调用方可重读事实后重试，绝无静默降级）。
 */
export async function steerBackgroundSubagent(
  ports: SteerHostPorts & SteerRunPorts,
  input: SteerActionInput,
  context: SteerActionContext,
): Promise<SteerActionOutput> {
  // 入参边界校验（外部输入显式拒绝；schema 之外的白文本仍需防御）。
  const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (runId === '') {
    throw steerError('validation_error', 'runId 不能为空', 400, { field: 'runId' })
  }
  if (text === '') {
    throw steerError('validation_error', 'text 不能为空（插话内容不可为空白）', 400, { field: 'text' })
  }

  // 1) run 定位：不存在的 run 由 getRun 抛 not_found 404，原样透传。
  const run = ports.getRun(runId)

  // 2) 仅后台子代理运行：DSL 编排工作流（多节点编排语义，无单一可插话
  //    子代理）显式拒绝。
  if (run.kind !== 'subagent') {
    throw steerError(
      'steer_unsupported_run',
      `运行 ${runId} 不是后台子代理运行（kind=${run.kind ?? 'workflow'}）：steer 仅支持 kind=subagent 的后台运行；DSL 编排工作流不适用`,
      400,
      { runId, kind: run.kind ?? 'workflow' },
    )
  }

  // 3) 仅 running：终态运行无可插话的在途回合。
  if (run.status !== 'running') {
    throw steerError(
      'steer_run_not_running',
      `运行 ${runId} 已终态（status=${run.status}），无可插话的在途子代理`,
      409,
      { runId, status: run.status },
    )
  }

  // 4) 级联取消边界内拒绝：取消期间注入输入会唤醒被取消子树的新回合
  //    （与「取消窗口内拒绝该子树新 run/spawn」同一纪律）。
  if (ports.isConversationCancelling(run.conversationId)) {
    throw steerError(
      'steer_run_cancelling',
      `运行 ${runId} 所在子树正在级联取消，拒绝插话（取消边界内不投递新输入）`,
      409,
      { runId, conversationId: run.conversationId },
    )
  }

  const parentOf = (id: number): number | undefined => {
    try {
      return ports.getConversation(id).parentConversationId
    } catch (error) {
      if (error instanceof HelmError && error.code === 'not_found') return undefined
      throw error
    }
  }

  // 5) caller → run 授权证明：会话上下文调用必须是 run 发起会话的自身或
  //    祖先（跨树控制拒绝）；人工 HTTP/CLI 无会话上下文不受限。
  const caller = context.conversationId
  if (caller !== undefined && !isAncestorOrSelf(run.conversationId, caller, parentOf)) {
    throw steerError(
      'steer_out_of_scope',
      `会话 ${caller} 无权插话运行 ${runId}：运行由会话 ${run.conversationId} 发起，仅其自身或祖先（或人工 HTTP/CLI）可插话`,
      403,
      { callerConversationId: caller, runConversationId: run.conversationId, runId },
    )
  }

  // 6) run → 目标解析：只认 run 记录内已解析且仍在执行的 agent 节点，
  //    不接受调用方传入的任何 conversationId/executionId（不猜）。
  //    同一节点同时呈原生与外部候选（conversationId 与 controls.steer 并存）
  //    视为歧义：宁可拒绝也不吞掉任何一方。
  const nodes = run.nodes ?? []
  const nativeCandidates: number[] = []
  const externalCandidates: Array<{ executionId: string; nodeId: string; pluginId: string; actionId: string }> = []
  for (const node of nodes) {
    if (node.status !== 'running') continue
    let native = false
    let external = false
    if (node.conversationId !== undefined) {
      native = true
      if (!nativeCandidates.includes(node.conversationId)) nativeCandidates.push(node.conversationId)
    }
    const steer = node.controls?.steer
    if (steer !== undefined && node.executionId !== undefined && node.nodeId !== undefined) {
      const pluginId = typeof steer.pluginId === 'string' ? steer.pluginId.trim() : ''
      const actionId = typeof steer.actionId === 'string' ? steer.actionId.trim() : ''
      if (pluginId === '' || actionId === '') {
        throw steerError(
          'steer_delegate_invalid',
          `运行 ${runId} 节点 ${node.id} 的 controls.steer 引用非法（pluginId/actionId 必须是非空 trim 字符串），拒绝插话`,
          502,
          { runId, nodeId: node.id },
        )
      }
      external = true
      externalCandidates.push({ executionId: node.executionId, nodeId: node.nodeId, pluginId, actionId })
    }
    if (native && external) {
      throw ambiguousError(runId, '节点同时登记原生子会话与外部控制引用')
    }
  }
  if (nativeCandidates.length > 0 && externalCandidates.length > 0) {
    throw ambiguousError(runId, '同时存在原生子会话与外部执行候选（混合路由拒绝，不优先任何一方）')
  }
  if (nativeCandidates.length === 0 && externalCandidates.length === 0) {
    const anyResolved = nodes.some((node) => node.conversationId !== undefined || node.executionId !== undefined)
    const hasRunningUnsteerable = nodes.some(
      (node) => node.status === 'running' && (node.conversationId !== undefined || node.executionId !== undefined),
    )
    if (anyResolved && !hasRunningUnsteerable) {
      throw steerError(
        'steer_subagent_not_running',
        `运行 ${runId} 的子代理节点已不在执行中，无可插话的在途回合`,
        409,
        { runId },
      )
    }
    throw steerError(
      'steer_no_steerable_target',
      hasRunningUnsteerable
        ? `运行 ${runId} 的外部执行未回传 steer 控制引用（如未提供原子守卫能力的外部运行时），拒绝插话`
        : `运行 ${runId} 尚无可插话目标（执行环境未就绪）`,
      409,
      { runId },
    )
  }
  if (nativeCandidates.length > 1) {
    throw ambiguousError(runId, `解析到多个在途原生子会话（${nativeCandidates.join(', ')}）`)
  }
  if (externalCandidates.length > 1) {
    throw ambiguousError(runId, `解析到多个在途外部执行（${externalCandidates.map((c) => `${c.nodeId}:${c.executionId}`).join(', ')}）`)
  }

  // ---- 外部执行路径：controls.steer 动态委托（零硬编码插件 ID） ----
  if (externalCandidates.length === 1) {
    const target = externalCandidates[0]!
    // 委托输入为标准契约；context 透传原调用方（含 signal；绝不伪造 caller）。
    // invokeAction 单次调用即终局：控制动作非幂等，超时/断线由真实错误显式
    // 上抛，绝不自动重试或伪造成功。
    const raw = await ports.invokeAction(
      target.pluginId,
      target.actionId,
      {
        executionId: target.executionId,
        nodeId: target.nodeId,
        workflowRunId: runId,
        parentConversationId: run.conversationId,
        text,
      },
      {
        ...(caller !== undefined ? { conversationId: caller } : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      },
    )
    const parsed = parseExternalSteerResult(raw, target)
    return {
      steered: true,
      runId,
      targetKind: 'external',
      executionId: target.executionId,
      nodeId: target.nodeId,
      ownership: 'helm',
      stateChangeSeq: parsed.stateChangeSeq,
      guardLevel: 'cas',
    }
  }

  // ---- 原生路径：唯一在途原生子会话经内核 guarded 端口提交 ----
  const childId = nativeCandidates[0]!

  // 7) run → child 后代证明：子会话父链必须可达 run 发起会话（记录漂移或
  //    伪装的 conversationId 在此拦截）；子会话已删除则 not_found 透传。
  const childSummary = ports.getConversation(childId)
  if (childId === run.conversationId || !isAncestorOrSelf(childId, run.conversationId, parentOf)) {
    throw steerError(
      'steer_lineage_mismatch',
      `子会话 ${childId} 不在运行 ${runId} 发起会话 ${run.conversationId} 的后代树内（记录与真实会话树不一致），拒绝插话`,
      403,
      { runId, conversationId: childId, runConversationId: run.conversationId },
    )
  }

  // 8) 归属红线：human 一律拒绝（人类直连会话/终端窗格严禁自动化插话）；
  //    内核提交点仍会原子兜底复核，此处的现读只是 fail-fast。
  const ownership = ports.getConversationOwnership(childId)
  if (ownership === 'human') {
    throw steerError(
      'steer_human_owned',
      `子会话 ${childId} 归属 human（人类直连/终端窗格），禁止自动化插话（看门狗红线；仅 bot/helm 归属的后台会话可 steer）`,
      403,
      { runId, conversationId: childId, ownership },
    )
  }

  // run 可能仍在验收 Gate 或刚完成环境创建；此时不能把指导当成新任务提交。
  // 执行态现读与下方 CAS 共用同一水位，异步提交期间回合结束会被内核拒绝。
  if (childSummary.status !== 'working' && childSummary.status !== 'blocked') {
    throw steerError(
      'steer_subagent_not_running',
      `子会话 ${childId} 当前状态为 ${childSummary.status}，没有可插话的在途回合`,
      409,
      { runId, conversationId: childId, status: childSummary.status },
    )
  }
  if (ports.isConversationCancelling(childId)) {
    throw steerError('steer_run_cancelling', `子会话 ${childId} 正在取消，拒绝插话`, 409, { runId, conversationId: childId })
  }

  // 9) 探针事实现读 + 内核原子复核：expectedOwnership/expectedStateSeq 为
  //    本刻事实，ctx.host.submitInputGuarded 在会话串行域内、SDK submit
  //    调用前同步复核；窗口内事实变化（人类按键推进水位、归属移交、目标
  //    删除）确定性 409/404 拒绝且无副作用，调用方重读事实后重试即可。
  const expectedStateSeq = childSummary.stateChangeSeq
  await ports.submitInputGuarded(
    childId,
    `父会话插话纠偏（后台运行 ${runId}）：\n${text}`,
    { origin: 'agent', whenBusy: 'steer', whenIdle: 'reject', meta: { kind: 'subagent_steer', runId } },
    { expectedOwnership: ownership, expectedStateSeq },
  )
  return {
    steered: true,
    runId,
    targetKind: 'native',
    conversationId: childId,
    ownership,
    stateChangeSeq: expectedStateSeq,
    guardLevel: 'cas',
  }
}

function ambiguousError(runId: string, reason: string): HelmError {
  return steerError(
    'steer_ambiguous_subagent',
    `运行 ${runId} ${reason}，拒绝歧义插话`,
    409,
    { runId, reason },
  )
}
