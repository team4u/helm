/**
 * Herdr 执行器子模块：跨 Hub 重启原位重挂（reattach）与交接对账。
 *
 * 流程（设计文档 §3.3）：
 * 1. 按 (nodeId, executionId) 从 PaneRegistry 查回持久化的 ManagedPane
 *    （含 outputFileName）；缺失记录或缺少 outputFileName 时显式抛
 *    HelmError('herdr_reattach_missing')；
 * 2. 先经 request.onResolved 回传既有窗格坐标（executionId / nodeId /
 *    effectiveCwd / worktree / steer controls）；
 * 3. 优先检查交接文件（PaneHandoff.tryReadValidOutput）：若重启窗口内
 *    已写完且有效，直接消费交接文件、跑 gate（回传 onGateResult）并结算
 *    为 keepalive 返回产物；
 * 4. 交接文件尚未生成或未就绪时，经 agent.get 核查窗格真实状态：
 *    - working / blocked / launch_pending：重挂阶段跟踪、事件等待、
 *      ApprovalBridge（CAS 审批桥）与交接读取闭环直至验收结算；
 *    - idle / done：走既有单次原地追问自愈流程；
 *    - 404/不存在或自愈后仍无有效文件：严守诚实性红线，读取尾部 40 行
 *      脱敏终端快照（若窗格仍可读）并显式抛 herdr_pane_lost /
 *      herdr_output_contract_violation，标 failed 保留现场，绝不截取
 *      屏幕脏文本冒充成功结果。
 */

import { HelmError, type AgentExecutionInfo, type AgentSpawnRequest } from '@helm/protocol'
import { parseWorkflowSpawnMeta } from '../contracts.js'
import type { HerdrPluginDependencies, HerdrTarget } from './contracts.js'
import { targetNodeId } from './contracts.js'
import type { HandoffReadAttempt } from './executor-handoff.js'
import { nodeIdOf, paneStateKey, targetOf, type ManagedPane, type PaneRegistry } from './panes.js'
import { parseAgentResult, type HerdrAgentInfo } from './rpc.js'
import { resolveSpawnRouting, type SpawnRouting } from './spawn-rules.js'

/** ReattachCoordinator 对执行器（executor）的最小依赖面。 */
interface ReattachPort {
  registry: PaneRegistry
  profiles: HerdrPluginDependencies['profiles']
  transport: NonNullable<HerdrPluginDependencies['transport']>
  redact(text: string): string
  startupTimeoutMs(): number
  agentGet(target: HerdrTarget, paneId: string, signal?: AbortSignal): Promise<HerdrAgentInfo>
  waitInteractiveReady(target: HerdrTarget, paneId: string, initial: HerdrAgentInfo, signal?: AbortSignal): Promise<HerdrAgentInfo>
  assertAttachmentsReachable(request: AgentSpawnRequest, target: HerdrTarget, routing: SpawnRouting): void
  executionInfoOf(pane: ManagedPane): AgentExecutionInfo
  hasPaneEnv(key: string): boolean
  setPaneEnv(key: string, env: Record<string, string>): void
  buildPaneBaselineEnv(parentConversationId: number, cwd: string, routing: SpawnRouting, target: HerdrTarget): Record<string, string>
  preloadAttachmentMeta(request: AgentSpawnRequest): Promise<void>
  hasActiveTask(key: string): boolean
  setPhase(key: string, phase: 'startup' | 'task' | 'handoff' | 'gate'): void
  project(pane: ManagedPane, token: string): Promise<void>
  tryReadValidOutput(request: AgentSpawnRequest, pane: ManagedPane): Promise<HandoffReadAttempt>
  removeValidatedOutput(pane: ManagedPane, signal?: AbortSignal): Promise<void>
  readAndValidateOutput(request: AgentSpawnRequest, pane: ManagedPane): Promise<unknown>
  settleThroughSteers(request: AgentSpawnRequest, pane: ManagedPane, initialFileName: string, initial: HerdrAgentInfo): Promise<void>
  clearRetiredOutputs(request: AgentSpawnRequest, pane: ManagedPane): Promise<void>
  runGateFor(request: AgentSpawnRequest, pane: ManagedPane): Promise<void>
  driveTask(request: AgentSpawnRequest, pane: ManagedPane): Promise<unknown>
  finishHandoffAndGate(request: AgentSpawnRequest, pane: ManagedPane, preloadedOutput?: unknown): Promise<unknown>
  runTaskLifecycle(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    body: (effectiveRequest: AgentSpawnRequest) => Promise<unknown>,
  ): Promise<unknown>
}

export function isPaneLostError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  const status = (error as { status?: unknown } | undefined)?.status
  return (
    code === 'agent_not_found' ||
    code === 'pane_not_found' ||
    code === 'tab_not_found' ||
    code === 'not_found' ||
    status === 404
  )
}

export class ReattachCoordinator {
  constructor(private readonly port: ReattachPort) {}

  async reattachInto(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    explicitRouting: SpawnRouting | undefined,
  ): Promise<unknown> {
    const routing = await this.resolveEffectiveRouting(pane, explicitRouting)
    this.assertPaneMatch(request, pane)
    const taskKey = paneStateKey(pane)
    if (this.port.hasActiveTask(taskKey)) {
      throw new HelmError(
        'pane_busy',
        `pane ${pane.paneId} 正在被另一个执行或重挂占用（activeTasks），拒绝并发 reattach`,
        409,
        { paneId: pane.paneId },
      )
    }
    this.port.assertAttachmentsReachable(request, targetOf(pane), routing)
    if (!this.port.hasPaneEnv(taskKey)) {
      this.port.setPaneEnv(
        taskKey,
        this.port.buildPaneBaselineEnv(request.parentConversationId, pane.effectiveCwd, routing, targetOf(pane)),
      )
    }
    await this.port.preloadAttachmentMeta(request)

    return this.port.runTaskLifecycle(request, pane, async (effectiveRequest) => {
      effectiveRequest.signal?.throwIfAborted()
      effectiveRequest.onResolved?.(this.port.executionInfoOf(pane))
      this.port.setPhase(taskKey, 'handoff')

      // 优先检查交接文件：若重启窗口内已写完且有效，直接过 gate 并结算。
      const initialAttempt = await this.port.tryReadValidOutput(effectiveRequest, pane)
      if (initialAttempt.ok) {
        return this.port.finishHandoffAndGate(effectiveRequest, pane, initialAttempt.value)
      }

      // 交接文件尚未生成或未就绪：核查窗格真实状态。
      let authority: HerdrAgentInfo
      try {
        authority = await this.port.agentGet(targetOf(pane), pane.paneId, effectiveRequest.signal)
      } catch (error) {
        if (isPaneLostError(error)) {
          if (initialAttempt.kind === 'invalid') {
            throw new HelmError(
              'herdr_output_contract_violation',
              `pane ${pane.paneId} 在重启期间已丢失且交接文件无效（${initialAttempt.reason}）`,
              502,
              { paneId: pane.paneId, reason: initialAttempt.reason },
            )
          }
          throw new HelmError(
            'herdr_pane_lost',
            `pane ${pane.paneId} 在重启期间已丢失且未产出有效交接文件 ${pane.outputFileName}`,
            502,
            { paneId: pane.paneId, outputFileName: pane.outputFileName },
          )
        }
        throw error
      }

      if (authority.paneId !== pane.paneId || authority.tabId !== pane.tabId || authority.name !== pane.agentName) {
        throw new HelmError(
          'herdr_ownership_lost',
          `pane ${pane.paneId} 权威身份与受管登记不一致（name=${String(authority.name)} tab=${authority.tabId}），拒绝重挂接管`,
          409,
          { paneId: pane.paneId, authorityName: authority.name, authorityTabId: authority.tabId },
        )
      }

      const wasLaunchPendingUnknown = authority.launchPending === true && authority.agentStatus === 'unknown'
      if (wasLaunchPendingUnknown) {
        authority = parseAgentResult(
          await this.port.transport.call(
            pane.target,
            'agent.wait',
            { target: pane.paneId, until: ['idle', 'blocked', 'done', 'working'], timeout_ms: this.port.startupTimeoutMs() },
            { signal: effectiveRequest.signal },
          ),
          'agent.wait',
          'agent_info',
        )
      }
      if (
        authority.launchPending === true &&
        !authority.interactiveReady &&
        (authority.agentStatus === 'idle' || authority.agentStatus === 'done')
      ) {
        authority = await this.port.waitInteractiveReady(pane.target, pane.paneId, authority, effectiveRequest.signal)
      }

      if (authority.agentStatus === 'working' || authority.agentStatus === 'blocked') {
        this.port.setPhase(taskKey, 'task')
        await this.port.project(pane, `run:${pane.agentName}`)
        await this.port.settleThroughSteers(effectiveRequest, pane, pane.outputFileName!, authority)
        const latest = this.port.registry.get(nodeIdOf(pane), pane.paneId)
        if (latest?.outputFileName === undefined) {
          throw new HelmError('herdr_context_unavailable', `pane ${pane.paneId} 的交接上下文已失效`, 409)
        }
        return this.port.finishHandoffAndGate(effectiveRequest, latest)
      }

      if (authority.agentStatus === 'unknown') {
        throw new HelmError('herdr_agent_unsettled', `pane ${pane.paneId} 状态 unknown，无法确认完成`, 502)
      }

      // 若此前停留在启动 launch_pending（首轮任务提示词尚未投递）且现在刚就绪为 idle：
      // 先复查文件是否恰好已落盘，否则按正常首轮投递；常规 idle/done 则走单次自愈闭环。
      if (wasLaunchPendingUnknown) {
        const recheck = await this.port.tryReadValidOutput(effectiveRequest, pane)
        if (recheck.ok) {
          return this.port.finishHandoffAndGate(effectiveRequest, pane, recheck.value)
        }
        return this.port.driveTask(effectiveRequest, pane)
      }

      return this.port.finishHandoffAndGate(effectiveRequest, pane)
    })
  }

  private async resolveEffectiveRouting(
    pane: ManagedPane,
    explicitRouting: SpawnRouting | undefined,
  ): Promise<SpawnRouting> {
    if (explicitRouting !== undefined) {
      if (explicitRouting.kind !== pane.routing.kind || explicitRouting.profileId !== pane.routing.profileId) {
        throw new HelmError(
          'herdr_reattach_missing',
          `reattach 路由（kind=${explicitRouting.kind}, profile=${String(explicitRouting.profileId)}）与窗格记录（kind=${pane.routing.kind}, profile=${String(pane.routing.profileId)}）不一致`,
          409,
          { executionId: pane.paneId },
        )
      }
      return explicitRouting
    }
    if (pane.routing.profileId !== undefined) {
      const resolved = await resolveSpawnRouting(pane.routing.profileId, this.port.profiles)
      if (resolved !== undefined) {
        return { ...resolved, nodeId: targetNodeId(pane.target) ?? 'local' }
      }
    }
    return {
      kind: pane.routing.kind,
      ...(pane.routing.profileId !== undefined ? { profileId: pane.routing.profileId } : {}),
      args: [],
      profileEnv: {},
      nodeId: targetNodeId(pane.target) ?? 'local',
    }
  }

  private assertPaneMatch(request: AgentSpawnRequest, pane: ManagedPane): void {
    if (pane.parentConversationId !== request.parentConversationId) {
      throw new HelmError(
        'herdr_reattach_missing',
        `窗格 ${pane.paneId} 属于父会话 ${pane.parentConversationId}，与重挂请求父会话 ${request.parentConversationId} 不匹配`,
        409,
        { executionId: pane.paneId, ownerParent: pane.parentConversationId, requesterParent: request.parentConversationId },
      )
    }
    const spawnRunId = parseWorkflowSpawnMeta(request.meta).runId
    if (pane.workflowRunId !== undefined && spawnRunId !== undefined && pane.workflowRunId !== spawnRunId) {
      throw new HelmError(
        'herdr_reattach_missing',
        `窗格 ${pane.paneId} 属于 workflow ${pane.workflowRunId}，与重挂请求 ${spawnRunId} 不匹配`,
        409,
        { executionId: pane.paneId, paneWorkflowRunId: pane.workflowRunId, requestWorkflowRunId: spawnRunId },
      )
    }
    if (request.reattach?.effectiveCwd !== undefined && request.reattach.effectiveCwd !== pane.effectiveCwd) {
      throw new HelmError(
        'herdr_reattach_missing',
        `重挂请求的 effectiveCwd '${request.reattach.effectiveCwd}' 与窗格实际工作目录 '${pane.effectiveCwd}' 不一致`,
        409,
        { executionId: pane.paneId, requestCwd: request.reattach.effectiveCwd, effectiveCwd: pane.effectiveCwd },
      )
    }
    if (pane.outcome === 'failed') {
      throw new HelmError(
        'herdr_execution_failed',
        pane.failureNote ?? `窗格 ${pane.paneId} 重挂前已处于 failed 状态`,
        502,
        { paneId: pane.paneId },
      )
    }
    if (pane.outcome !== 'running' || pane.outputFileName === undefined) {
      throw new HelmError(
        'herdr_reattach_missing',
        `窗格 ${pane.paneId}（outcome=${pane.outcome}）缺少可重挂的持久化交接文件名 outputFileName`,
        409,
        { executionId: pane.paneId, outcome: pane.outcome },
      )
    }
  }
}
