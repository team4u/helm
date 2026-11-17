/**
 * builtin:workflow detach（前台同步 run 转后台）纯逻辑。
 *
 * 定位：把同步工具（subagent / SubagentWorkflow 的 background:false 路径，
 * 或自动化会话缺省同步）启动、仍在运行中的前台同步 run 原子转入后台：
 * 阻塞中的父回合工具调用立即收到后台句柄，run 继续执行，终态经
 * notifyParentOnSettle outbox 向父会话 steer 插话汇报（BackgroundReporter）。
 *
 * 授权与状态纪律：
 * 1. run 侧：必须存在（getRun 404 透传）且为前台同步标记（record
 *    .syncForeground）的运行中 run——后台启动（notifyParentOnSettle）与已
 *    detach（detachedAt）的 run 拒绝（幂等防重复转后台），终态 run 拒绝；
 *    权威状态判定与原子置位在引擎 detachForegroundRun 的同步临界段（与
 *    结算链互斥：自然完成与 detach 竞态只能有一个终态/通知）；
 * 2. caller 侧：携带会话上下文的调用（run_action / workflow / Web）必须是
 *    run 发起会话的自身或祖先（与 steer 同款血统证明）；人工 HTTP/CLI
 *    无会话上下文不受限；
 * 3. 归属红线：run 发起会话必须 human-owned——自动化会话（bot/helm）的
 *    同步 run 缺省等待终态是防早结算的既定策略，detach 等于把后台句柄
 *    提前塞给自动化调用方，一律拒绝。
 *
 * 本模块零引擎依赖（不 import engine/），宿主端口与引擎 detach 入口经
 * 参数注入，供 workflow.ts 动作注册与确定性单测共用。
 */
import { HelmError, type ConversationSummary } from '@helm/protocol'
import type { WorkflowRunSummary } from '../contracts.js'
import { isAncestorOrSelf } from '../lineage.js'

/** detach 所需宿主端口（ctx.host 子集；注入确定性 fake 即可全覆盖测试）。 */
export interface DetachHostPorts {
  getConversation(id: number): ConversationSummary
  getConversationOwnership(id: number): 'helm' | 'bot' | 'human'
}

/** 引擎 detach 入口（WorkflowService.detachForegroundRun 子集）。 */
export interface DetachEnginePorts {
  /** 只读 run 查询（不存在抛 not_found 404）。 */
  getRun(runId: string): WorkflowRunSummary
  /** 原子转后台（状态判定在引擎同步临界段；不满足显式抛错）。 */
  detach(runId: string): Promise<WorkflowRunSummary>
}

interface DetachActionInput {
  runId: string
}

interface DetachActionContext {
  conversationId?: number
}

interface DetachActionOutput {
  detached: true
  runId: string
  run: WorkflowRunSummary
}

function detachError(code: string, message: string, status: number, details?: Record<string, unknown>): HelmError {
  return new HelmError(code, message, status, details)
}

/**
 * 前台同步 run 转后台主入口。任何不支持情况显式抛 HelmError（错误码稳定）；
 * 授权判定在本模块，权威状态判定与原子置位在引擎（竞态安全；detach 端口
 * 为 async——临界段后等待状态存储 flush，失败如实上抛）。
 */
export async function detachForegroundSyncRun(
  ports: DetachHostPorts & DetachEnginePorts,
  input: DetachActionInput,
  context: DetachActionContext,
): Promise<DetachActionOutput> {
  // 入参边界校验（外部输入显式拒绝；schema 之外的防御）。
  const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
  if (runId === '') {
    throw detachError('validation_error', 'runId 不能为空', 400, { field: 'runId' })
  }

  // 1) run 定位：不存在的 run 由 getRun 抛 not_found 404，原样透传。
  const run = ports.getRun(runId)

  // 2) caller → run 授权证明（与 steer 同款）：携带会话上下文的调用必须是
  //    run 发起会话的自身或祖先；人工 HTTP/CLI 无会话上下文不受限。
  const caller = context.conversationId
  if (caller !== undefined && !isAncestorOrSelf(run.conversationId, caller, parentOfVia(ports))) {
    throw detachError(
      'detach_out_of_scope',
      `会话 ${caller} 无权转后台运行 ${runId}：运行由会话 ${run.conversationId} 发起，仅其自身或祖先（或人工 HTTP/CLI）可操作`,
      403,
      { callerConversationId: caller, runConversationId: run.conversationId, runId },
    )
  }

  // 3) 归属红线：run 发起会话必须 human-owned（自动化会话的同步等待是防
  //    早结算策略，detach 会把后台句柄提前塞给自动化调用方，一律拒绝）。
  const ownership = ports.getConversationOwnership(run.conversationId)
  if (ownership !== 'human') {
    throw detachError(
      'detach_forbidden',
      `运行 ${runId} 的发起会话 ${run.conversationId} 归属 ${ownership}（自动化会话）：自动化同步等待是既定策略，拒绝 detach（防调用方早结算）`,
      403,
      { runId, runConversationId: run.conversationId, ownership },
    )
  }

  // 4) 权威状态判定 + 原子置位（引擎同步临界段）：非 running、非前台同步、
  //    已后台/已 detach 均显式拒绝（detach_not_running / detach_not_foreground）。
  const detached = await ports.detach(runId)
  return { detached: true, runId, run: detached }
}

/** 沿真实会话父链上行读取（缺父/不可读即链断，不虚构祖先）。 */
function parentOfVia(ports: DetachHostPorts): (id: number) => number | undefined {
  return (id: number): number | undefined => {
    try {
      return ports.getConversation(id).parentConversationId
    } catch (error) {
      if (error instanceof HelmError && error.code === 'not_found') return undefined
      throw error
    }
  }
}
