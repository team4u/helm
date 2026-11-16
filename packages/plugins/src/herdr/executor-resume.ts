/**
 * Herdr 执行器子模块：resume 权威确认与路由恢复。
 *
 * 从 executor.ts 拆出（行为与拆分前逐行等价）；依赖经 ResumePort 注入
 * （executor 持有 registry / 权威 agent.get / 附件门禁 / 环境基线与任务主循环）。
 *
 * 超时安全边界（TimeoutError 中止，区别于普通 AbortError 取消）：
 * - 无安全 stop/CAS 手段停止底层 CLI——超时只保存诊断并保留 pane（标 failed，
 *   不关窗、不发键），绝不把保留 pane 包装成可无条件续接；
 * - 后续 resume 在任何 prompt 发送前经 assertResumeAgentConfirmed 权威确认：
 *   仅 idle/done 可续接；working/blocked/unknown/无法确认一律显式拒绝
 *   （不新建、不按键中止）；启动期超时（agent.start 完成与否不确定）同样
 *   先安全确认，绝不盲目重发 agent.start。
 */

import { HelmError, type AgentExecutionInfo, type AgentSpawnRequest } from '@helm/protocol'
import { parseWorkflowSpawnMeta } from '../contracts.js'
import { targetNodeId, type HerdrPluginDependencies, type HerdrTarget } from './contracts.js'
import { nodeIdOf, paneStateKey, targetOf, type ManagedPane, type PaneRegistry } from './panes.js'
import type { HerdrAgentInfo } from './rpc.js'
import {
  assertNoUnsupportedOverrides,
  buildOutputFileName,
  HashShort,
  resolveSpawnRouting,
  type SpawnRouting,
} from './spawn-rules.js'

/** ResumeCoordinator 对执行器（executor）的最小依赖面。 */
export interface ResumePort {
  registry: PaneRegistry
  /** Profile 运行时表（resolveSpawnRouting 双入口解析用）。 */
  profiles: HerdrPluginDependencies['profiles']
  redact(text: string): string
  /** 权威 agent.get（seq 唯一可信来源；executor 持有）。 */
  agentGet(target: HerdrTarget, paneId: string, signal?: AbortSignal): Promise<HerdrAgentInfo>
  /** 附件诚实性门禁（任何续接副作用之前；远端无可达 HELM_HUB_URL 显式拒绝）。 */
  assertAttachmentsReachable(request: AgentSpawnRequest, target: HerdrTarget, routing: SpawnRouting): void
  /** 编排层执行信息（controls.steer 委托引用与 worktree 租约登记）。 */
  executionInfoOf(pane: ManagedPane): AgentExecutionInfo
  /** 窗格环境基线登记（resume 缺失时按当前路由重建；不含 stash 机密）。 */
  hasPaneEnv(key: string): boolean
  setPaneEnv(key: string, env: Record<string, string>): void
  /** 窗格环境基线重建（buildSpawnEnv 受管 HELM_* + Profile 合并；不含 stash 机密）。 */
  buildPaneBaselineEnv(parentConversationId: number, cwd: string, routing: SpawnRouting, target: HerdrTarget): Record<string, string>
  /** spawn 前解析附件元数据（展示字段）。 */
  preloadAttachmentMeta(request: AgentSpawnRequest): Promise<void>
  /** 任务主循环（投递-审批-交接；executor 持有）。 */
  runManagedTask(request: AgentSpawnRequest, pane: ManagedPane): Promise<unknown>
}

export class ResumeCoordinator {
  constructor(private readonly port: ResumePort) {}

  /**
   * 真实 resume 双入口（先识别自有记录，不依赖 request.agentType）：
   * - standalone subagent：resume = onResolved.executionId（paneId），通常无
   *   request.agentId；
   * - workflow resumeAgent：resume = 本 run 记录的 agentId，无 agentType。
   * 校验：只准同 workflow（含 undefined 轨道一致）及同父会话；拒绝 busy/
   * settled/未知/歧义；显式 kind/nodeId/cwd 不一致显式拒绝（不静默忽略）；
   * 任何 prompt 发送前经 assertResumeAgentConfirmed 权威确认底层 Agent
   * （仅 idle/done 可续接；超时保留 pane 的 working/blocked 与启动期未定
   * 状态一律显式拒绝，不新建、不按键中止）。
   * 返回 undefined 表示该 ref 非本插件记录（交还内核原生 resume）。
   */
  async resumeInto(request: AgentSpawnRequest, candidates: ManagedPane[]): Promise<unknown> {
    const resumeRef = request.resume!
    if (candidates.length > 1) {
      throw new HelmError(
        'resume_ambiguous',
        `resume ref '${resumeRef}' 命中 ${candidates.length} 个窗格（跨机器 paneId 撞号），请用稳定 agentId 消歧`,
        409,
        { resumeRef, panes: candidates.map((p) => `${nodeIdOf(p) ?? 'local'}:${p.paneId}`) },
      )
    }
    const pane = candidates[0]!
    if (pane.parentConversationId !== request.parentConversationId) {
      throw new HelmError(
        'cross_parent_resume_rejected',
        `resume ref '${resumeRef}' 属于父会话 ${pane.parentConversationId}，当前父会话 ${request.parentConversationId} 无权续接`,
        409,
        { resumeRef, ownerParent: pane.parentConversationId, requesterParent: request.parentConversationId },
      )
    }
    // workflow 轨道一致性：两边必须同为同一 workflow（或同为 undefined）。
    const paneWf = pane.workflowRunId
    const reqWf = parseWorkflowSpawnMeta(request.meta).runId
    if (paneWf !== reqWf) {
      throw new HelmError(
        'resume_workflow_mismatch',
        `resume ref '${resumeRef}' 属于 workflow ${String(paneWf)}，当前调用轨道 ${String(reqWf)}，拒绝跨轨道续接`,
        409,
        { resumeRef, paneWorkflowRunId: paneWf, requestWorkflowRunId: reqWf },
      )
    }
    if (pane.outcome === 'running') {
      throw new HelmError(
        'pane_busy',
        `pane ${pane.paneId} 正在被另一个执行占用（outcome=running），拒绝并发 resume`,
        409,
        { paneId: pane.paneId },
      )
    }
    if (pane.outcome === 'settled') {
      throw new HelmError(
        'pane_settled',
        `pane ${pane.paneId} 已结算关闭（outcome=settled），无 PTY 可续接`,
        409,
        { paneId: pane.paneId },
      )
    }
    // 路由：缺 agentType 沿用登记路由；显式给出且 kind 不一致显式拒绝。
    assertNoUnsupportedOverrides(request.model, request.effort)
    const resumeRouting = await this.resolveResumeRouting(request, pane)
    // resume 附件门禁：与新建同语义（远端窗格无可达 HELM_HUB_URL 拒绝）。
    this.port.assertAttachmentsReachable(request, targetOf(pane), resumeRouting)
    if (request.cwd !== undefined && request.cwd !== pane.effectiveCwd) {
      throw new HelmError(
        'resume_cwd_conflict',
        `resume 显式 cwd '${request.cwd}' 与窗格实际工作目录 '${pane.effectiveCwd}' 不一致；续接必须保留原 worktree cwd`,
        409,
        { resumeRef, requestCwd: request.cwd, effectiveCwd: pane.effectiveCwd },
      )
    }
    // 权威续接门禁：任何 prompt 发送前以 agent.get 确认底层 Agent 可安全续接
    // （TimeoutError 保留 pane 的底层 CLI 可能仍 working/blocked；启动期超时
    // 的 agent.start 完成与否未定——都先安全确认，绝不盲目投递）。
    await this.assertResumeAgentConfirmed(request, pane)

    const unique = `${Date.now()}-resume-${HashShort.of(request.prompt.slice(0, 160))}-${request.parentConversationId}-${Math.random().toString(36).slice(2, 6)}`
    const safeId = `r${HashShort.of(unique)}`
    const ext = request.schema !== undefined ? 'json' : 'md'
    if (this.port.registry.get(nodeIdOf(pane), pane.paneId)?.outcome === 'running') {
      throw new HelmError('pane_busy', `pane ${pane.paneId} 已由另一续接占用`, 409)
    }
    const spawnRunId = parseWorkflowSpawnMeta(request.meta).runId
    const updated = this.port.registry.update(nodeIdOf(pane), pane.paneId, {
      outcome: 'running',
      outputFileName: buildOutputFileName(safeId, ext),
      agentId: request.agentId ?? pane.agentId,
      ...(spawnRunId !== undefined ? { workflowRunId: spawnRunId } : {}),
    })!
    await this.port.registry.flushDisk()
    request.onResolved?.(this.port.executionInfoOf(updated))
    // request.cwd 缺省代表沿用窗格实际 cwd（不重开窗、不重建 env tab）。
    // 续接不重跑 agent.start（窗格已有 agent）；直接进入投递-审批-交接循环。
    // env 缺失（失败窗格清理后）：按当前路由与窗格实际 cwd 重建基线（不含机密；
    // resume 的 Gate 按 resume 请求自身 secretNames 重新授权，不沿用建窗时授予）。
    if (!this.port.hasPaneEnv(paneStateKey(updated))) {
      this.port.setPaneEnv(
        paneStateKey(updated),
        this.port.buildPaneBaselineEnv(request.parentConversationId, updated.effectiveCwd, resumeRouting, targetOf(updated)),
      )
    }
    await this.port.preloadAttachmentMeta(request)
    return this.port.runManagedTask(request, updated)
  }

  /**
   * resume 权威就绪门禁（在任何 prompt 发送前执行；安全边界）：
   * - TimeoutError 超时保留的 pane 底层 CLI 可能仍 working/blocked——没有
   *   安全 stop/CAS 手段，不能把保留 pane 包装成可无条件续接；
   * - 启动期超时（agent.start 完成与否不确定）同样以此门禁显式拒绝或安全
   *   确认：身份与状态均权威确认才放行，绝不盲目重发 agent.start；
   * - 放行条件：身份（pane/tab/name）与受管登记精确一致且状态 idle/done；
   *   working/blocked/unknown/launch_pending、无法权威确认（agent.get 失败）
   *   或身份不一致一律显式拒绝——不新建 Agent、不代发按键中止，交人类在
   *   Herdr 终端确认后再续接。
   */
  private async assertResumeAgentConfirmed(request: AgentSpawnRequest, pane: ManagedPane): Promise<void> {
    const resumeRef = request.resume!
    let authority: HerdrAgentInfo
    try {
      authority = await this.port.agentGet(targetOf(pane), pane.paneId, request.signal)
    } catch (error) {
      if (request.signal?.aborted) throw error
      throw new HelmError(
        'resume_agent_unconfirmed',
        `pane ${pane.paneId} 无法权威确认底层 Agent 状态（${error instanceof Error ? this.port.redact(error.message) : String(error)}）；常见于启动期超时后 agent.start 完成与否不确定，或窗格已无受管 Agent。拒绝盲目续接：不新建 Agent、不重发 agent.start、不代发按键；请先在 Herdr 终端人工确认该窗格后再 resume`,
        409,
        { resumeRef, paneId: pane.paneId, cause: (error as { code?: string }).code ?? 'agent_get_failed' },
      )
    }
    if (authority.paneId !== pane.paneId || authority.tabId !== pane.tabId || authority.name !== pane.agentName) {
      throw new HelmError(
        'herdr_ownership_lost',
        `pane ${pane.paneId} 权威身份与受管登记不一致（name=${String(authority.name)} tab=${authority.tabId}），无法确认受管 Agent 仍在该窗格（可能从未启动成功或已被替换），拒绝续接`,
        409,
        { resumeRef, paneId: pane.paneId, authorityName: authority.name, authorityTabId: authority.tabId },
      )
    }
    if (authority.launchPending === true) {
      throw new HelmError(
        'resume_agent_busy',
        `pane ${pane.paneId} 仍在启动（launch_pending），底层 CLI 状态未定，拒绝续接`,
        409,
        { resumeRef, paneId: pane.paneId, agentStatus: authority.agentStatus },
      )
    }
    if (authority.agentStatus === 'working') {
      throw new HelmError(
        'resume_agent_busy',
        `pane ${pane.paneId} 底层 CLI 仍在执行（working；常见于超时保留的 pane），拒绝续接：不新建、不按键中止；请等其在 Herdr 终端完结（idle/done）后再 resume`,
        409,
        { resumeRef, paneId: pane.paneId, agentStatus: authority.agentStatus },
      )
    }
    if (authority.agentStatus === 'blocked') {
      throw new HelmError(
        'resume_agent_blocked',
        `pane ${pane.paneId} 底层 CLI 正 blocked 等待审批按键，续接绝不代人类发键；请在 Herdr 终端直接处理该阻塞后再 resume`,
        409,
        { resumeRef, paneId: pane.paneId, agentStatus: authority.agentStatus, stateChangeSeq: authority.stateChangeSeq },
      )
    }
    if (authority.agentStatus !== 'idle' && authority.agentStatus !== 'done') {
      throw new HelmError(
        'resume_agent_unconfirmed',
        `pane ${pane.paneId} 权威状态为 ${authority.agentStatus}，无法确认可安全续接（仅 idle/done 可续接）`,
        409,
        { resumeRef, paneId: pane.paneId, agentStatus: authority.agentStatus },
      )
    }
  }

  /**
   * resume 路由解析：显式 agentType 校验 kind 一致；缺省沿用 pane.routing。
   * 节点语义：resume 沿用旧窗格登记的节点（缺省与显式一致仅校验不重算——
   * 显式 nodeId 与旧节点不同即 resume_node_conflict 拒绝，绝不静默把续接
   * 投到另一台机器；也不按当前父会话节点重新解析）。
   */
  private async resolveResumeRouting(request: AgentSpawnRequest, pane: ManagedPane): Promise<SpawnRouting> {
    if (request.agentType === undefined || request.agentType === '') {
      const routing = pane.routing
      return {
        kind: routing.kind,
        ...(pane.routing.profileId !== undefined ? { profileId: pane.routing.profileId } : {}),
        args: [],
        profileEnv: {},
        nodeId: nodeIdOf(pane) ?? 'local',
      }
    }
    const routing = await resolveSpawnRouting(request.agentType, this.port.profiles)
    if (routing === undefined) {
      throw new HelmError(
        'resume_agent_type_rejected',
        `resume 显式 agentType '${request.agentType}' 非 Herdr 运行时，与既有 herdr 窗格不匹配`,
        409,
        { resume: request.resume, agentType: request.agentType },
      )
    }
    if (routing.kind !== pane.routing.kind || routing.profileId !== pane.routing.profileId) {
      throw new HelmError(
        'resume_kind_conflict',
        `resume 显式 agentType kind '${routing.kind}' 与窗格 agent kind '${pane.routing.kind}' 不一致，拒绝静默改型`,
        409,
        { resume: request.resume, requestKind: routing.kind, paneKind: pane.routing.kind },
      )
    }
    const requestNodeId = routing.nodeId !== undefined ? targetNodeId({ nodeId: routing.nodeId }) ?? 'local' : undefined
    const paneNodeId = nodeIdOf(pane) ?? 'local'
    if (requestNodeId !== undefined && requestNodeId !== paneNodeId) {
      throw new HelmError(
        'resume_node_conflict',
        `resume 显式节点 '${requestNodeId}' 与窗格目标节点 '${paneNodeId}' 不一致，拒绝跨节点续接`,
        409,
        { resume: request.resume, requestNodeId, paneNodeId },
      )
    }
    // 沿用窗格冻结目标（显式节点仅作一致性校验，不热换连接）。
    return { ...routing, nodeId: paneNodeId }
  }
}
