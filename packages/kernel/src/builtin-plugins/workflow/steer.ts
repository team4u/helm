/**
 * builtin:workflow 后台子代理安全插话（steer）纯逻辑。
 *
 * 定位：父主会话（或人工 HTTP/CLI）对 subagent(background:true) 派生的后台
 * 原生子代理运行插入一次指导。授权证明链 caller → run → child 全程沿真实
 * 会话父链推导，绝不凭 conversationId 猜测：
 * 1. run 侧：仅 kind=subagent 且 status=running 的运行，且不在级联取消边界内；
 * 2. child 侧：只认 run 记录内已解析（onResolved 回传）的原生子会话，且该
 *    子会话父链必须可达 run 发起会话（防记录漂移/伪装）；外部运行时
 *    （如 Herdr 窗格）不回传原生子会话，显式拒绝；
 * 3. caller 侧：携带会话上下文的调用（Agent 工具 / run_action / workflow
 *    action）必须是 run 发起会话的自身或祖先（与 runs 会话分片投影的可见
 *    面一致）；人工 HTTP/CLI 无会话上下文，以 run 发起会话为权威上下文放行；
 * 4. 归属红线：子会话归属 human 时在插件侧显式拒绝（看门狗红线），bot/helm
 *    归属经 ctx.host.submitInputGuarded 在内核提交点原子复核——探针现读的
 *    归属与权威水位（stateChangeSeq）在第一个不可逆动作（SDK submit）前于
 *    会话串行域内复核，期间人类按键、归属翻转或水位推进均以 409
 *    ownership_conflict / state_seq_conflict 无副作用拒绝，绝不回退普通
 *    submitInput。
 *
 * 本模块零引擎依赖（不 import engine/），全部宿主端口经参数注入，
 * 供 workflow.ts 动作注册与确定性单测共用。
 */
import { HelmError, type ConversationSummary, type WorkflowRunSummary } from '@helm/protocol'

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

export interface SteerActionOutput {
  steered: true
  runId: string
  conversationId: number
  ownership: 'bot' | 'helm'
  stateChangeSeq: number
}

/**
 * 沿真实会话父链上行：ancestor 是否为 start 的自身或祖先。
 * 环（visited 防护）与缺父/不可读（parentOf 返回 undefined 断链）一律按
 * 「不可证明」处理返回 false，绝不虚构祖先关系。
 */
export function isAncestorOrSelf(
  start: number,
  ancestor: number,
  parentOf: (id: number) => number | undefined,
  maxHops = 1_024,
): boolean {
  let current: number | undefined = start
  const visited = new Set<number>()
  for (let hops = 0; current !== undefined && hops < maxHops; hops++) {
    if (current === ancestor) return true
    if (visited.has(current)) return false
    visited.add(current)
    current = parentOf(current)
  }
  return false
}

/**
 * 后台原生子代理安全插话主入口。任何不支持情况显式抛 HelmError（错误码
 * 稳定，见各分支）；内核 guarded 端口的 409/404 冲突原样透传（确定性放弃，
 * 调用方可重读事实后重试，绝无静默降级）。
 */
export async function steerBackgroundSubagent(
  ports: SteerHostPorts & SteerRunPorts,
  input: SteerActionInput,
  context: { conversationId?: number },
): Promise<SteerActionOutput> {
  // 入参边界校验（外部输入显式拒绝；schema 之外的白文本仍需防御）。
  const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (runId === '') {
    throw new HelmError('validation_error', 'runId 不能为空', 400, { field: 'runId' })
  }
  if (text === '') {
    throw new HelmError('validation_error', 'text 不能为空（插话内容不可为空白）', 400, { field: 'text' })
  }

  // 1) run 定位：不存在的 run 由 getRun 抛 not_found 404，原样透传。
  const run = ports.getRun(runId)

  // 2) 仅后台原生子代理运行：DSL 编排工作流（多节点编排语义，无单一可插话
  //    子代理）与外部运行时执行一律显式拒绝。
  if (run.kind !== 'subagent') {
    throw new HelmError(
      'steer_unsupported_run',
      `运行 ${runId} 不是后台子代理运行（kind=${run.kind ?? 'workflow'}）：steer 仅支持 kind=subagent 的后台原生子代理；DSL 编排工作流与外部运行时（如 Herdr 窗格）不适用`,
      400,
      { runId, kind: run.kind ?? 'workflow' },
    )
  }

  // 3) 仅 running：终态运行无可插话的在途回合。
  if (run.status !== 'running') {
    throw new HelmError(
      'steer_run_not_running',
      `运行 ${runId} 已终态（status=${run.status}），无可插话的在途子代理`,
      409,
      { runId, status: run.status },
    )
  }

  // 4) 级联取消边界内拒绝：取消期间注入输入会唤醒被取消子树的新回合
  //    （与「取消窗口内拒绝该子树新 run/spawn」同一纪律）。
  if (ports.isConversationCancelling(run.conversationId)) {
    throw new HelmError(
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
    throw new HelmError(
      'steer_out_of_scope',
      `会话 ${caller} 无权插话运行 ${runId}：运行由会话 ${run.conversationId} 发起，仅其自身或祖先（或人工 HTTP/CLI）可插话`,
      403,
      { callerConversationId: caller, runConversationId: run.conversationId, runId },
    )
  }

  // 6) run → child 解析：只认 run 记录内已解析且仍在执行的原生子会话，
  //    不接受调用方传入的任何 conversationId（不猜）。
  const nodes = run.nodes ?? []
  const candidates = [
    ...new Set(
      nodes
        .filter((node) => node.conversationId !== undefined && node.status === 'running')
        .map((node) => node.conversationId!),
    ),
  ]
  if (candidates.length === 0) {
    const anyResolved = nodes.some((node) => node.conversationId !== undefined)
    throw new HelmError(
      anyResolved ? 'steer_subagent_not_running' : 'steer_no_native_conversation',
      anyResolved
        ? `运行 ${runId} 的子代理节点已不在执行中，无可插话的在途回合`
        : `运行 ${runId} 尚无可插话的原生子会话（执行环境未就绪，或外部运行时（如 Herdr）不回传原生子会话）`,
      409,
      { runId },
    )
  }
  if (candidates.length > 1) {
    throw new HelmError(
      'steer_ambiguous_subagent',
      `运行 ${runId} 解析到多个在途子会话（${candidates.join(', ')}），拒绝歧义插话`,
      409,
      { runId, conversationIds: candidates },
    )
  }
  const childId = candidates[0]!

  // 7) run → child 后代证明：子会话父链必须可达 run 发起会话（记录漂移或
  //    伪装的 conversationId 在此拦截）；子会话已删除则 not_found 透传。
  const childSummary = ports.getConversation(childId)
  if (childId === run.conversationId || !isAncestorOrSelf(childId, run.conversationId, parentOf)) {
    throw new HelmError(
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
    throw new HelmError(
      'steer_human_owned',
      `子会话 ${childId} 归属 human（人类直连/终端窗格），禁止自动化插话（看门狗红线；仅 bot/helm 归属的后台会话可 steer）`,
      403,
      { runId, conversationId: childId, ownership },
    )
  }

  // run 可能仍在验收 Gate 或刚完成环境创建；此时不能把指导当成新任务提交。
  // 执行态现读与下方 CAS 共用同一水位，异步提交期间回合结束会被内核拒绝。
  if (childSummary.status !== 'working' && childSummary.status !== 'blocked') {
    throw new HelmError(
      'steer_subagent_not_running',
      `子会话 ${childId} 当前状态为 ${childSummary.status}，没有可插话的在途回合`,
      409,
      { runId, conversationId: childId, status: childSummary.status },
    )
  }
  if (ports.isConversationCancelling(childId)) {
    throw new HelmError('steer_run_cancelling', `子会话 ${childId} 正在取消，拒绝插话`, 409, { runId, conversationId: childId })
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
  return { steered: true, runId, conversationId: childId, ownership, stateChangeSeq: expectedStateSeq }
}
