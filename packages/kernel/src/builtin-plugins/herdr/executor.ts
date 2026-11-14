/**
 * Herdr 执行行：两步建窗 -> agent.start -> 就绪等待 -> prompt --wait ->
 * blocked 审批桥 -> 文件交接（含一次自愈）-> gate -> 双轨保活清理。
 *
 * 诚实性纪律（不静默降级）：
 * - 文件缺失/坏 JSON/schema 不合格仅在自愈一次后显式 herdr_output_contract_violation
 *   （附 agent.read recent_unwrapped 40 行脱敏快照），绝不截终端脏文本冒充结果；
 * - transport IO/SSH/权限错误如实抛诊断（herdr_output_missing 404 是唯一可自愈
 *   边界码），绝不把其它错误当缺文件重投任务；
 * - 真实启动序列（服务端实测）：agent.start 返回 agent_status=unknown +
 *   launch_pending=true + seq=0；必须 agent.wait(until idle/blocked) 等权威
 *   就绪后再 prompt，不得把 unknown 当终态失败，也不得提前 prompt。
 *
 * 并发纪律（abort 双路径）：
 * - driveTask 的 request.signal 触发 abortCleanup（销单 Ask + 关自有 PTY），
 *   与 workflow settle / turn settle 的 closePane 可能同时到达：closePane 按
 *   pane 单飞（activeCloses promise 复用），settled 幂等（二次清理直接返回），
 *   关闭中不再把 registry 改回 running；
 * - 成功/失败路径必须 removeEventListener 释放 abort 监听器；
 * - 所有长 RPC 携带 request.signal。
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, targetPlatformOf, type AgentExecutionInfo, type AgentSpawnRequest, type TargetPlatform } from '@helm/protocol'
import type { CreateAskResultLike, CreateAskSpecLike, HerdrPluginDependencies, HerdrTarget } from './contracts.js'
import { targetNodeId } from './contracts.js'
import { validateOrThrow } from '@helm/protocol'
import { AskCoordinator, backoffForDuplicateBlocked, type AskEntry } from './asks.js'
import { buildHerdrAskPromptPlan, extractMenuItemsFromSnapshot, parseCustomKeys, type BlockedSnapshotAnalysis, type HerdrAskPromptPlan } from './prompt-options.js'
import { MetadataProjector } from './metadata.js'
import { PaneRegistry, nodeIdOf, targetOf, type ManagedPane, type PaneRouting } from './panes.js'
import {
  assertOkResult,
  buildSendKeysParams,
  isStaleStateError,
  parseAgentResult,
  parsePaneRead,
  parsePong,
  parseTabCreated,
  parseWorktreeCreated,
  SEND_KEYS_CAS_CAPABILITY,
  type HerdrAgentInfo,
} from './rpc.js'
import {
  assertNoUnsupportedOverrides,
  buildAgentName,
  buildOutputFileName,
  buildSpawnPaneEnv,
  HashShort,
  redactPromptText,
  redactSchemaText,
  resolveCwd,
  resolveSpawnRouting,
  type SpawnRouting,
} from './spawn-rules.js'
import { HERDR_STEER_CONTROLS } from './contracts.js'

export interface ExecutorHost {
  /** 父会话 cwd 解析（宿主 getConversation 桥；错误如实上抛）。 */
  parentCwdOf(parentConversationId: number): string | undefined
  /**
   * 父会话绑定节点（宿主 getConversation(id).nodeId；undefined = 本机）。
   * 子 spawn 未显式/Profile 指定节点时继承它（否则总落本机，远端父会话
   * 的任务会被误发到 Hub 本机执行）。
   */
  parentNodeIdOf(parentConversationId: number): string | undefined
  /** AskDoc 目标会话（缺省父会话）。 */
  askConversationId(parentConversationId: number): number
  /** 非机密通知。 */
  notify(title: string, body: string, level: 'info' | 'error'): void
  /** agent.start 启动超时（config.startupTimeoutMs；3001..300000）。 */
  startupTimeoutMs(): number
  /** 宿主 createAsk（预分配 id；ask.id 形如 herdr:<nodeId>:<pane>:<seq>）。 */
  createAsk(spec: CreateAskSpecLike): Promise<CreateAskResultLike>
  /** 宿主 cancelAsk（404 = 已结算，调用方据此清条目；其余错误如实上抛）。 */
  cancelAsk(askId: string, reason: 'cancelled' | 'superseded'): Promise<void>
}

interface WindowPane {
  paneId: string
  tabId: string
  /** 仅 worktree 模式（专属 workspace）；普通 tab 模式缺省（只关 tab）。 */
  workspaceId?: string
  effectiveCwd: string
  worktree?: { path: string; branch?: string }
}

/** handle() 返回：handled 表示接管（result 为交接产物）；continue 放行内核默认。 */
export type HandleOutcome = { action: 'handled'; result: unknown } | { action: 'continue' }

/**
 * 受管任务生命周期阶段（显式跟踪）：仅 'task'（首轮提示已投递、等待结算）
 * 允许 steer；startup（建窗/agent 就绪等待）、handoff（交接文件读取与自愈）、
 * gate（验收）与任务结束（keepalive/failed/settled，无条目）一律拒绝。
 */
type PaneTaskPhase = 'startup' | 'task' | 'handoff' | 'gate'

/** steerPane 入参（与 @helm/protocol ExternalSteerRequest 对齐；signal 为调用上下文取消）。 */
export interface SteerPaneInput {
  workflowRunId: string
  parentConversationId: number
  text: string
  signal?: AbortSignal
}

export class HerdrExecutor {
  /** pane scopeKey -> 进行中的 closePane promise（abort 双路径单飞）。 */
  private readonly activeCloses = new Map<string, Promise<void>>()

  /** env 只留在内存；Gate 与续接复用建窗时的实际环境，绝不持久化机密。 */
  private readonly paneEnvs = new Map<string, Record<string, string>>()
  private readonly blockedTasks = new Map<string, Promise<boolean>>()
  private readonly unstartedPanes = new Set<string>()
  /** 在途受管任务的生命周期阶段与原始 spawn 请求（steer 门禁与尾读复核用）。 */
  private readonly panePhases = new Map<string, PaneTaskPhase>()
  private readonly activeTasks = new Map<string, AgentSpawnRequest>()
  /** 在途 steer（按 pane 互斥；driveTask 结算前排空）。 */
  private readonly activeSteers = new Map<string, Promise<{ stateChangeSeq: number }>>()
  /**
   * 不确定投递（超时/断线/坏响应）的插话失败记录（paneKey -> 脱敏原因）：
   * 任务结算排空在途 steer 后据此显式失败并保留现场（绝不读旧结果或
   * 自愈冒充），后续插话不得清除未确认的投递。服务端 admission
   * 确定零写入拒绝（agent_not_ready/agent_blocked/agent_not_found）
   * 不记本表。
   */
  private readonly steerFailures = new Map<string, string>()
  /** 已被插话作废的旧交接文件名（paneKey -> 名单；仅成功交接后统一清理）。 */
  private readonly steerRetiredFiles = new Map<string, string[]>()
  /** 本机冻结连接目标（启用时注入）。 */
  private readonly localTarget: HerdrTarget

  constructor(
    private readonly deps: HerdrPluginDependencies,
    private readonly registry: PaneRegistry,
    private readonly asks: AskCoordinator,
    private readonly projector: MetadataProjector,
    private readonly host: ExecutorHost,
    private readonly transport: NonNullable<HerdrPluginDependencies['transport']>,
    localTarget: HerdrTarget,
    /** 轮询间隔（测试可缩短；生产缺省 100ms）。用于 waitInteractiveReady 与 AskDoc 存续复核。 */
    private readonly pollIntervalMs = 100,
  ) {
    this.localTarget = localTarget
  }

  /**
   * agent_spawn 拦截主流程。
   * - resume：先按自有记录识别（agentId/paneId 双键），不依赖 request.agentType
   *   （真实 standalone resume 无 agentId、workflow resume 无 agentType）；
   * - 新建：resolveSpawnRouting 双入口解析，非 Herdr 目标放行；
   * - 节点选定：显式 herdr:kind@node（含 @local） > Profile.runtime.nodeId >
   *   Profile.nodeId > 父会话绑定节点 > 本机。'local' 显式覆盖远端父节点，
   *   不折叠丢失；显式/Profile 指定与父节点不同时以更高优先级为准（合法切换）。
   * - 附件：远端机器无可达 HELM_HUB_URL 时在建窗之前显式拒绝
   *   （remote_hub_unreachable_for_artifacts，零远端副作用）。
   */
  async handle(request: AgentSpawnRequest): Promise<HandleOutcome> {
    if (request.resume !== undefined) {
      const candidates = this.registry.findByResumeRef(request.resume)
      if (candidates.length === 0) {
        // 非本插件记录：原生 resume（conversationId）交还内核；显式 herdr
        // 运行时的 resume 绝不静默新建续接窗格。
        const routing = await resolveSpawnRouting(request.agentType, this.deps.profiles)
        if (routing === undefined) return { action: 'continue' }
        throw new HelmError(
          'not_found',
          `resume ref '${request.resume}' 不存在（非本插件登记的 herdr agentId/paneId）`,
          404,
          { resumeRef: request.resume },
        )
      }
      const outcome = await this.resumeInto(request, candidates)
      return { action: 'handled', result: outcome }
    }
    const routing = await resolveSpawnRouting(request.agentType, this.deps.profiles)
    if (routing === undefined) return { action: 'continue' }
    assertNoUnsupportedOverrides(request.model, request.effort)
    if (request.signal?.aborted) {
      throw new HelmError('aborted', 'herdr spawn 请求在创建前已取消', 409)
    }
    const target = this.resolveSpawnTarget(request, routing)
    this.assertAttachmentsReachable(request, target, routing)
    const result = await this.spawnNew(request, routing, target)
    return { action: 'handled', result }
  }

  /**
   * 节点选定：显式/Profile 指定（routing.nodeId，含 'local'）优先；否则继承
   * 父会话绑定节点（parentNodeIdOf；undefined = 本机）。
   * 目标 HerdrTarget 的 socketPath/session 继承冻结的本机连接配置仅当目标为
   * 本机（远端目标只携带 nodeId，端点由目标节点自解析）。
   */
  private resolveSpawnTarget(request: AgentSpawnRequest, routing: SpawnRouting): HerdrTarget {
    const parentNodeId = this.parentNodeIdOrThrow(request.parentConversationId)
    const nodeId = routing.nodeId !== undefined ? targetNodeId({ nodeId: routing.nodeId }) : targetNodeId({ nodeId: parentNodeId })
    if (nodeId === undefined) return this.localTargetOf()
    return { nodeId }
  }

  /**
   * 附件诚实性门禁（任何建窗副作用之前）：
   * 远端节点且既无 Profile 配置也无节点通道提供的可达 HELM_HUB_URL 时，远端窗格
   * 无法拉取产物（本机 artifacts 目录不在远端文件系统上），显式拒绝而非静默截断。
   */
  private assertAttachmentsReachable(
    request: AgentSpawnRequest,
    target: HerdrTarget,
    routing: SpawnRouting,
  ): void {
    if (request.attachments === undefined || request.attachments.length === 0) return
    const nodeId = targetNodeId(target)
    if (nodeId === undefined) return // 本机窗格：直接读本机 artifacts。
    const base = this.deps.buildSpawnEnv(request.parentConversationId, '/tmp/helm-attachment-gate', nodeId)
    const { hubUrlOverridden } = buildSpawnPaneEnv(base, routing.profileEnv, {
      remote: true,
      nodeHubUrl: this.deps.nodeChannel?.getNodeHubUrl?.(nodeId),
    })
    if (hubUrlOverridden) return // 远端已有可达 HELM_HUB_URL（Profile 或节点通道）：可经 CLI 拉取。
    throw new HelmError(
      'remote_hub_unreachable_for_artifacts',
      `远端节点 '${nodeId}' 未配置可达的 HELM_HUB_URL，无法传递附件（${request.attachments.join(', ')}）；请在 Profile runtime.env.HELM_HUB_URL 配置远端可达的 http(s) 地址，或让节点经 helm-node 接入上报 hubUrl`,
      400,
      { nodeId, attachments: request.attachments },
    )
  }

  // ------------------------------------------------------------------
  // 建窗与启动
  // ------------------------------------------------------------------

  private async spawnNew(request: AgentSpawnRequest, routing: SpawnRouting, target: HerdrTarget, existing?: ManagedPane): Promise<unknown> {
    if (existing === undefined) {
      // 新窗格：cwd 解析链 request.cwd > profile.workspace > 父 cwd；
      // 链尾无真实 cwd 时显式拒绝（绝不猜进程 cwd，更不让远端窗格默认落 Hub 目录）。
      // 解析后按目标节点平台统一收口（local = process.platform；远端仅信
      // NodeRegistry 注册上报，无可信信息则透传不改写）。
      const parentCwd = this.parentCwdOrThrow(request.parentConversationId)
      const cwd = resolveCwd(request.cwd, routing, parentCwd, this.platformOfTarget(target))
      if (cwd === '') {
        throw new HelmError(
          'validation_error',
          `无法解析 herdr 窗格工作目录（request.cwd / profile.workspace / 父会话 ${request.parentConversationId} cwd 均未提供绝对路径）；请在 spawn 请求显式指定 cwd 或为父会话/Profile 绑定真实工作目录`,
          400,
          { parentConversationId: request.parentConversationId },
        )
      }
      existing = await this.createManagedPane(request, routing, target, cwd)
    }
    const pane = existing
    this.registry.update(nodeIdOf(pane), pane.paneId, {
      routing: { kind: routing.kind, ...(routing.profileId !== undefined ? { profileId: routing.profileId } : {}) },
    })
    await this.preloadAttachmentMeta(request)
    return this.runManagedTask(request, pane, routing)
  }

  /** 父会话 cwd：宿主 getConversation 错误如实上抛（不存在即 spawn 缺陷输入）。 */
  private parentCwdOrThrow(parentConversationId: number): string {
    const cwd = this.host.parentCwdOf(parentConversationId)
    if (cwd === undefined) {
      throw new HelmError(
        'not_found',
        `父会话 ${parentConversationId} 不存在或无 cwd，无法解析 herdr 窗格工作目录`,
        404,
        { parentConversationId },
      )
    }
    return cwd
  }

  /**
   * 父会话绑定节点：getConversation 错误如实上抛（与 parentCwdOf 同源）。
   */
  private parentNodeIdOrThrow(parentConversationId: number): string | undefined {
    // 宿主可能复用同一 getConversation 调用；错误语义由实现保证如实。
    return this.host.parentNodeIdOf(parentConversationId)
  }

  /**
   * 目标节点平台解析（cwd 规范化用）：本机目标 = process.platform；远端
   * 仅信节点通道上报的注册事实（NodeRegistry platform），无上报 = undefined
   * （不猜：透传不改写）。
   */
  private platformOfTarget(target: HerdrTarget): TargetPlatform | undefined {
    const nodeId = targetNodeId(target)
    if (nodeId === undefined) return targetPlatformOf(process.platform)
    const raw = this.deps.nodeChannel?.nodePlatform?.(nodeId)
    return raw !== undefined && raw !== '' ? targetPlatformOf(raw) : undefined
  }

  /** 建窗并登记（含 worktree 两步 + 中途失败回收已创建资源）。 */
  private async createManagedPane(
    request: AgentSpawnRequest,
    routing: SpawnRouting,
    target: HerdrTarget,
    cwd: string,
  ): Promise<ManagedPane> {
    const unique = `${Date.now()}-${HashShort.of(request.prompt.slice(0, 160))}-${request.parentConversationId}-${Math.random().toString(36).slice(2, 6)}`
    const agentName = buildAgentName(HashShort.of(unique))
    const safeId = `${HashShort.of(unique)}${HashShort.of(request.prompt).slice(0, 4)}`
    const ext = request.schema !== undefined ? 'json' : 'md'
    const outputFileName = buildOutputFileName(safeId, ext)
    const env = this.buildPaneEnv(request.parentConversationId, cwd, routing, target)
    const window = await this.createWindow(target, routing, request, cwd, env, agentName)
    const managed: ManagedPane = {
      target: window.target,
      paneId: window.paneId,
      tabId: window.tabId,
      ...(window.workspaceId !== undefined ? { workspaceId: window.workspaceId } : {}),
      ...(window.worktree !== undefined ? { worktree: window.worktree } : {}),
      effectiveCwd: window.effectiveCwd,
      agentName,
      routing: { kind: routing.kind, ...(routing.profileId !== undefined ? { profileId: routing.profileId } : {}) },
      parentConversationId: request.parentConversationId,
      ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
      ...(request.workflowRunId !== undefined ? { workflowRunId: request.workflowRunId } : {}),
      outcome: 'running',
      outputFileName,
      createdAt: Date.now(),
    }
    this.registry.add(managed)
    const key = this.paneKey(managed)
    this.paneEnvs.set(key, this.buildPaneEnv(request.parentConversationId, window.effectiveCwd, routing, window.target))
    this.unstartedPanes.add(key)
    return managed
  }

  /** 建窗：普通 tab.create({cwd,env,focus:false,label})；worktree 模式两步注入 env。 */
  private async createWindow(
    target: HerdrTarget,
    routing: SpawnRouting,
    request: AgentSpawnRequest,
    cwd: string,
    env: Record<string, string>,
    label: string,
  ): Promise<WindowPane & { target: HerdrTarget }> {
    if (request.isolation !== 'worktree') {
      const created = parseTabCreated(
        await this.transport.call(target, 'tab.create', { cwd, env, focus: false, label }, { signal: request.signal }),
      )
      return {
        target,
        paneId: created.rootPane.paneId,
        tabId: created.tab.tabId,
        // 普通模式：共享 workspace 绝不整体关闭，仅关自有 tab。
        workspaceId: undefined,
        effectiveCwd: cwd,
      }
    }
    const branch = `helm/wf-${HashShort.of(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)}`
    const created = parseWorktreeCreated(
      await this.transport.call(
        target,
        'worktree.create',
        { cwd, branch, focus: false, trust_repository: true },
        { signal: request.signal },
      ),
    )
    const effectiveCwd = created.worktree.path
    if (Object.keys(env).length === 0) {
      return {
        target,
        paneId: created.rootPane.paneId,
        tabId: created.tabId,
        workspaceId: created.workspaceId,
        effectiveCwd,
        worktree: created.worktree,
      }
    }
    // worktree.create 不接受 env：在该 workspace 下补建带 env 的 tab（env 按实际
    // worktree cwd 重建），关初始空 tab；任一步失败回收已创建 workspace。
    const worktreeEnv = this.buildPaneEnv(request.parentConversationId, effectiveCwd, routing, target)
    try {
      const tabbed = parseTabCreated(
        await this.transport.call(
          target,
          'tab.create',
          { workspace_id: created.workspaceId, cwd: effectiveCwd, env: worktreeEnv, focus: false, label },
          { signal: request.signal },
        ),
      )
      await assertOkResult(
        await this.transport.call(target, 'tab.close', { tab_id: created.tabId }, { signal: request.signal }),
        'tab.close',
      )
      return {
        target,
        paneId: tabbed.rootPane.paneId,
        tabId: tabbed.tab.tabId,
        workspaceId: created.workspaceId,
        effectiveCwd,
        worktree: created.worktree,
      }
    } catch (error) {
      // 两步中途失败：尽力关闭刚创建的 workspace（回收自有资源）；回收失败
      // 显式报告（附加诊断），不掩盖原始错误也不留无主窗格不报。
      try {
        await this.transport.call(target, 'workspace.close', { workspace_id: created.workspaceId }, { timeoutMs: 5_000 })
      } catch (cleanupError) {
        this.host.notify(
          'Herdr 建窗失败回收未竟',
          `worktree 建窗失败后回收 workspace ${created.workspaceId} 亦失败：${
            cleanupError instanceof Error ? this.deps.redact(cleanupError.message) : String(cleanupError)
          }（原始错误：${error instanceof Error ? this.deps.redact(error.message) : String(error)}）`,
          'error',
        )
      }
      throw error
    }
  }

  /**
   * agent.start + 就绪等待（真实启动序列）：
   * - start 成功返回可能仍是 unknown/launch_pending（seq=0）：以 startupTimeout
   *   预算 agent.wait(until idle/blocked) 等权威就绪（signal 可取消）；
   * - agent_not_ready 且权威 blocked：窗格已有 agent 等待交互，桥接审批后续等，
   *   不启动第二个 agent（其余 agent_not_ready 场景如实抛）。
   */
  private async startAgentAndWaitReady(
    target: HerdrTarget,
    paneId: string,
    routing: SpawnRouting,
    signal?: AbortSignal,
  ): Promise<HerdrAgentInfo> {
    const params: Record<string, unknown> = {
      name: this.registry.get(nodeIdOf({ target }), paneId)?.agentName ?? buildAgentName(HashShort.of(paneId)),
      kind: routing.kind,
      pane_id: paneId,
      timeout_ms: this.host.startupTimeoutMs(),
    }
    if (routing.args.length > 0) params['args'] = routing.args
    let started: HerdrAgentInfo
    try {
      started = parseAgentResult(
        await this.transport.call(target, 'agent.start', params, { signal }),
        'agent.start',
        'agent_started',
      )
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'agent_not_ready') throw error
      const probe = await this.agentGet(target, paneId, signal)
      if (probe.agentStatus !== 'blocked') throw error
      this.host.notify(
        'Herdr 窗格已存在等待中的 Agent',
        `pane ${paneId} 返回 agent_not_ready 且权威状态 blocked，桥接既有 agent 继续审批流程，不启动第二个 agent`,
        'info',
      )
      return probe
    }
    if (started.agentStatus === 'blocked') return started
    if (started.interactiveReady && (started.agentStatus === 'idle' || started.agentStatus === 'done')) return started
    // unknown（launch_pending 真实阶段）或 done（极快完成）：等权威就绪。
    const ready = await this.transport.call(
      target,
      'agent.wait',
      { target: paneId, until: ['idle', 'blocked', 'done', 'working'], timeout_ms: this.host.startupTimeoutMs() },
      { signal },
    )
    return this.waitInteractiveReady(target, paneId, parseAgentResult(ready, 'agent.wait', 'agent_info'), signal)
  }

  private async waitInteractiveReady(target: HerdrTarget, paneId: string, initial: HerdrAgentInfo, signal?: AbortSignal): Promise<HerdrAgentInfo> {
    const deadline = Date.now() + this.host.startupTimeoutMs()
    let info = initial
    while (info.agentStatus !== 'blocked' && !(info.interactiveReady && (info.agentStatus === 'idle' || info.agentStatus === 'done'))) {
      if (Date.now() >= deadline) throw new HelmError('herdr_startup_timeout', `pane ${paneId} 未在启动期限内具备 interactive_ready`, 504)
      await delay(this.pollIntervalMs, undefined, { signal })
      info = await this.agentGet(target, paneId, signal)
    }
    return info
  }

  /** 权威 agent.get（seq 唯一可信来源）。 */
  private async agentGet(target: HerdrTarget, paneId: string, signal?: AbortSignal): Promise<HerdrAgentInfo> {
    return parseAgentResult(
      await this.transport.call(target, 'agent.get', { target: paneId }, { signal, timeoutMs: 5_000 }),
      'agent.get',
      'agent_info',
    )
  }

  /**
   * 窗格 env：buildSpawnEnv(managed/stash，确切目标节点) + buildSpawnPaneEnv 合并。
   * 受管 HELM_* 由内核构造权威（Profile 不可覆盖）；远端剥本机回连变量
   * （Profile 显式有效可达 HELM_HUB_URL 或节点通道 hubUrl 除外）。
   * buildSpawnEnv 第三参始终传确切 nodeId（'local' 或远端 ID）——绝不让内核
   * 按父会话继承（父会话绑定远端时会把本机窗格误配到远端）。
   */
  private buildPaneEnv(parentConversationId: number, cwd: string, routing: SpawnRouting, target: HerdrTarget): Record<string, string> {
    const nodeId = targetNodeId(target) ?? 'local'
    const base = this.deps.buildSpawnEnv(this.host.askConversationId(parentConversationId), cwd, nodeId)
    const { env, stripped, hubUrlOverridden } = buildSpawnPaneEnv(base, routing.profileEnv, {
      remote: nodeId !== 'local',
      ...(nodeId !== 'local' ? { nodeHubUrl: this.deps.nodeChannel?.getNodeHubUrl?.(nodeId) } : {}),
    })
    if (stripped.length > 0) {
      this.host.notify(
        '远端窗格已剥除本机回连变量',
        `node ${nodeId} 无可达 HELM_HUB_URL，已剥除：${stripped.join(', ')}`,
        'info',
      )
    }
    void hubUrlOverridden
    return env
  }

  private executionInfoOf(pane: ManagedPane): AgentExecutionInfo {
    return {
      nodeId: nodeIdOf(pane) ?? 'local',
      executionId: pane.paneId,
      effectiveCwd: pane.effectiveCwd,
      // 外部执行控制引用：编排层（builtin:workflow.steer）据此动态委托本插件
      // steer 动作（零硬编码；不携带回调或策略）。
      controls: { steer: { pluginId: HERDR_STEER_CONTROLS.pluginId, actionId: HERDR_STEER_CONTROLS.actionId } },
      ...(pane.worktree !== undefined
        ? { worktree: { path: pane.worktree.path, branch: pane.worktree.branch ?? '' } }
        : {}),
    }
  }

  /** 本机冻结目标（启用时确定）。 */
  private localTargetOf(): HerdrTarget {
    return this.localTarget
  }

  // ------------------------------------------------------------------
  // 任务投递、审批桥与文件交接
  // ------------------------------------------------------------------

  private taskPrompt(request: AgentSpawnRequest, pane: ManagedPane): string {
    const fileName = pane.outputFileName!
    const prompt = redactPromptText(request.prompt, this.deps.redact)
    const attachmentBlock = this.buildAttachmentBlock(request, pane)
    const handoff =
      request.schema !== undefined
        ? [
            '',
            '--- helm 交接契约（必须遵守）---',
            `任务完成后，把最终结构化结果写入文件 ${pane.effectiveCwd}/.helm/${fileName}，`,
            '内容为满足下方 JSON Schema 的单个 JSON 值（不得包裹 Markdown 代码块外的任何文本）。',
            `JSON Schema: ${redactSchemaText(request.schema, this.deps.redact)}`,
            '写文件是你交付结果的唯一方式；未写文件视为任务失败。',
          ].join('\n')
        : [
            '',
            '--- helm 交接契约（必须遵守）---',
            `任务完成后，把最终结果（Markdown 全文）写入文件 ${pane.effectiveCwd}/.helm/${fileName}。`,
            '写文件是你交付结果的唯一方式；未写文件视为任务失败。',
          ].join('\n')
    return `${prompt}${attachmentBlock}\n${handoff}`
  }

  /**
   * 附件指引块（任务正文与交接契约之间）：
   * - 本机窗格：本机绝对路径 + helm artifacts get 拉取命令；
   * - 远端窗格：仅 id/name 与拉取命令（经远端可达 HELM_HUB_URL 的 CLI 拉取）。
   * deps.getArtifact 未注入时退化用裸 ID（单测环境；不伪造元数据）。
   */
  private buildAttachmentBlock(request: AgentSpawnRequest, pane: ManagedPane): string {
    if (request.attachments === undefined || request.attachments.length === 0) return ''
    const isRemote = nodeIdOf(pane) !== undefined
    const lines: string[] = []
    for (const id of request.attachments) {
      const meta = this.attachmentMetaCache.get(id)
      if (isRemote || meta === undefined) {
        const nameSuffix = meta !== undefined ? ` name=${meta.name} mime=${meta.mimeType} size=${meta.size} bytes` : ''
        lines.push(`- id=${id}${nameSuffix}，拉取：helm artifacts get ${id} --output ./<name>`)
      } else {
        lines.push(
          `- ${meta.name} (id=${id}, mime=${meta.mimeType}, size=${meta.size} bytes, path=${meta.absPath})，拉取：helm artifacts get ${id} --output ./${meta.name}`,
        )
      }
    }
    return `\n\n[Attached Files]\n${lines.join('\n')}`
  }

  /** 附件元数据缓存（spawn 时经 deps.getArtifact 解析一次）。容量上限防长驻
   *  泄漏：超限淘汰最旧条目（下个请求命中时会重新解析，不伪造数据）。 */
  private static readonly MAX_ATTACHMENT_META_ENTRIES = 128
  private readonly attachmentMetaCache = new Map<
    string,
    { id: string; name: string; mimeType: string; size: number; absPath: string }
  >()

  /** spawn 前解析附件元数据（存在性与授权已由内核 spawnAgent 校验；此处仅取展示字段）。 */
  private async preloadAttachmentMeta(request: AgentSpawnRequest): Promise<void> {
    if (request.attachments === undefined || this.deps.getArtifact === undefined) return
    for (const id of request.attachments) {
      const meta = await this.deps.getArtifact(id, request.parentConversationId)
      this.attachmentMetaCache.set(id, meta)
    }
    // 超限淘汰最旧（Map 迭代序即插入序）：缓存仅为展示字段优化，可随时重建。
    while (this.attachmentMetaCache.size > HerdrExecutor.MAX_ATTACHMENT_META_ENTRIES) {
      const oldest = this.attachmentMetaCache.keys().next().value
      if (oldest === undefined) break
      this.attachmentMetaCache.delete(oldest)
    }
  }

  /** 请求结算后清理本次附件缓存条目（长驻进程不累积历史 spawn 元数据）。 */
  private releaseAttachmentMeta(request: AgentSpawnRequest): void {
    if (request.attachments === undefined) return
    for (const id of request.attachments) this.attachmentMetaCache.delete(id)
  }

  /** 任务启动、首轮、自愈均在同一取消与错误收尾边界内。 */
  private async runManagedTask(request: AgentSpawnRequest, pane: ManagedPane, start?: SpawnRouting): Promise<unknown> {
    const taskKey = this.paneKey(pane)
    this.activeTasks.set(taskKey, request)
    this.panePhases.set(taskKey, 'startup')
    let cleanup: Promise<void> | undefined
    let rejectAbort!: (error: Error) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const onAbort = () => {
      cleanup ??= this.closePane(pane, 'cancelled')
      void cleanup.catch(() => {})
      rejectAbort(new HelmError('aborted', `pane ${pane.paneId} 执行已取消`, 499))
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) onAbort()
    const task = async () => {
      request.signal?.throwIfAborted()
      request.onResolved?.(this.executionInfoOf(pane))
      if (start !== undefined) {
        let info = await this.startAgentAndWaitReady(pane.target, pane.paneId, start, request.signal)
        this.unstartedPanes.delete(this.paneKey(pane))
        for (;;) {
          await this.waitUntilSettled(request, pane, info)
          info = await this.waitInteractiveReady(pane.target, pane.paneId, await this.agentGet(pane.target, pane.paneId, request.signal), request.signal)
          if (info.agentStatus !== 'blocked') break
        }
      }
      return this.driveTask(request, pane)
    }
    try {
      return await Promise.race([aborted, task()])
    } catch (error) {
      if (request.signal?.aborted || (error as { code?: string }).code === 'aborted') {
        cleanup ??= this.closePane(pane, 'cancelled')
        try { await cleanup }
        catch (cleanupError) {
          const note = this.deps.redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError))
          await this.markFailed(pane, note)
          throw new HelmError('herdr_abort_cleanup_failed', `任务已取消，但自有窗格清理失败：${note}`, 502)
        }
        throw new HelmError('aborted', `pane ${pane.paneId} 执行已取消`, 499)
      }
      await this.markFailed(pane, error instanceof Error ? error.message : String(error))
      const snapshot = await this.readDiagnostic(pane)
      const failure = error as { code?: unknown; status?: unknown }
      throw new HelmError(
        typeof failure?.code === 'string' ? failure.code : 'herdr_execution_failed',
        `${this.deps.redact(error instanceof Error ? error.message : String(error))}\n终端最后 40 行（脱敏）：\n${snapshot}`,
        error instanceof HelmError ? error.status : 502,
        { paneId: pane.paneId, snapshot },
      )
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      // 本次请求结算（成功/失败/取消）：任务阶段/在途登记/插话失败记录与
      // 附件元数据缓存同步回收，后续 steer 按「无可插话任务」拒绝。
      this.activeTasks.delete(taskKey)
      this.panePhases.delete(taskKey)
      this.steerFailures.delete(taskKey)
      this.steerRetiredFiles.delete(taskKey)
      this.releaseAttachmentMeta(request)
    }
  }

  private async driveTask(request: AgentSpawnRequest, pane: ManagedPane): Promise<unknown> {
    const key = this.paneKey(pane)
    this.panePhases.set(key, 'task')
    await this.project(pane, `run:${pane.agentName}`)
    const info = await this.promptAndWait(pane.target, pane, this.taskPrompt(request, pane), request.signal)
    await this.settleThroughSteers(request, pane, pane.outputFileName!, info)
    // 结算以 registry 现值为准：插话可能已把唯一交接文件重定向到新名字
    //（绝不沿用起始快照误读旧路径）。
    const latest = this.registry.get(nodeIdOf(pane), pane.paneId)
    if (latest?.outputFileName === undefined) {
      throw new HelmError('herdr_context_unavailable', `pane ${pane.paneId} 的交接上下文已失效`, 409)
    }
    const output = await this.readAndValidateOutput(request, latest)
    if (request.gate !== undefined) {
      this.panePhases.set(key, 'gate')
      await this.runGateFor(request, pane)
    }
    request.signal?.throwIfAborted()
    // 成功交接后清理已被插话作废的旧结果文件（失败路径保留现场）。
    await this.clearRetiredSteerOutputs(request, pane)
    this.registry.update(nodeIdOf(pane), pane.paneId, { outcome: 'keepalive', outputFileName: undefined })
    return output
  }

  /**
   * 结算等待 + 在途 steer 排空 + 权威复查 + 最新交接文件核验：
   * - 首个 idle/done 可能早于 steer 投递（文本+回车多步序列）被 agent.wait
   *   观察到——不能直接进交接。排空在途 steer（等待真实 RPC 终局，非固定
   *   延时）后以权威 agent.get 复查：working 说明插话已开启新回合（回到
   *   结算等待），blocked 交审批桥；unknown 如实失败；
   * - 不确定投递（超时/断线/坏响应）已按 pane 记失败：结算显式
   *   herdr_steer_uncertain 失败并保留现场（绝不读旧结果，也不经自愈追问
   *   冒充按最新指导的交付）；后续插话不能抹去该不确定结果；
   * - 成功插话即把唯一交接文件重定向到全新名字（旧结果天然防冒充）：
   *   idle/done 时新文件未出现则不得进交接——有界 agent.wait(until
   *   working/blocked) 等后续回合起步后复查（不宣称 idle 可证明 CLI 已
   *   消费队列）；预算耗尽仍无新文件交由 readAndValidateOutput 的一次自愈
   *   按最新文件名兑底（追问后仍缺则显式失败保留现场）；
   * - 文件核验跨 await 期间可能又有插话（重定向更新名字）或留下不确定
   *   记录：必须重新核验；终核验与切换 handoff 阶段在同一同步段完成，
   *   此后插话被阶段门禁拒绝。
   */
  private async settleThroughSteers(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    initialFileName: string,
    initial: HerdrAgentInfo,
  ): Promise<void> {
    const key = this.paneKey(pane)
    const latestName = (): string | undefined => this.registry.get(nodeIdOf(pane), pane.paneId)?.outputFileName
    const steerSettled = (): boolean => !this.activeSteers.has(key) && !this.steerFailures.has(key)
    let info = initial
    for (;;) {
      await this.waitUntilSettled(request, pane, info)
      const inFlight = this.activeSteers.get(key)
      if (inFlight !== undefined) await inFlight.catch(() => {})
      const uncertain = this.steerFailures.get(key)
      if (uncertain !== undefined) {
        throw new HelmError(
          'herdr_steer_uncertain',
          `pane ${pane.paneId} 的插话投递结果不确定（${this.deps.redact(uncertain)}）：拒绝以旧交接结果或自愈追问冒充按最新指导的交付，任务显式失败并保留现场`,
          502,
          { paneId: pane.paneId, reason: this.deps.redact(uncertain) },
        )
      }
      const authority = await this.agentGet(pane.target, pane.paneId, request.signal)
      if (authority.agentStatus === 'working' || authority.agentStatus === 'blocked') {
        info = authority
        continue
      }
      if (authority.agentStatus === 'unknown') {
        throw new HelmError('herdr_agent_unsettled', `pane ${pane.paneId} 状态 unknown，无法确认完成`, 502)
      }
      if (!steerSettled()) continue
      const currentName = latestName()
      if (currentName !== undefined && currentName !== initialFileName) {
        // 插话已重定向唯一交接文件：新文件未出现前不得进交接（旧结果冒充防线）。
        let present = false
        try {
          await this.transport.readOutput(targetOf(pane), pane.effectiveCwd, currentName, request.signal)
          present = true
        } catch (error) {
          if (!(error instanceof HelmError && error.code === 'herdr_output_missing')) throw error
        }
        if (!steerSettled() || latestName() !== currentName) continue
        if (!present) {
          // 新结果未出现：有界等待后续回合起步后复查（working/blocked 回主循环）。
          const resumed = await this.waitSteerTurnOrNone(request, pane)
          if (resumed !== undefined) {
            info = resumed
            continue
          }
          // 超时附近可能刚起步：先复查权威状态，避免向仍工作中的 CLI 提前追问。
          info = await this.agentGet(pane.target, pane.paneId, request.signal)
          if (!steerSettled() || latestName() !== currentName) continue
          if (info.agentStatus === 'working' || info.agentStatus === 'blocked') continue
          if (info.agentStatus === 'unknown') {
            throw new HelmError('herdr_agent_unsettled', `pane ${pane.paneId} 状态 unknown，无法确认完成`, 502)
          }
          // 仍 settled 时交由原单次自愈按最新文件名兑底，绝不读旧文件。
        }
      }
      // 终核验与切 handoff 同一同步段：此后插话被阶段门禁拒绝。
      if (!steerSettled() || latestName() !== currentName) continue
      request.signal?.throwIfAborted()
      this.panePhases.set(key, 'handoff')
      return
    }
  }

  /**
   * 有界等待后续回合（agent.wait until working/blocked，预算复用启动超时）：
   * 返回新回合的权威 info（working/blocked）；预算耗尽返回 undefined。
   * 超时交调用方复查状态，再按最新业务文件走原单次交接自愈。
   */
  private async waitSteerTurnOrNone(
    request: AgentSpawnRequest,
    pane: ManagedPane,
  ): Promise<HerdrAgentInfo | undefined> {
    try {
      return parseAgentResult(
        await this.transport.call(
          pane.target,
          'agent.wait',
          { target: pane.paneId, until: ['working', 'blocked'], timeout_ms: this.host.startupTimeoutMs() },
          { signal: request.signal, timeoutMs: this.host.startupTimeoutMs() + 1_000 },
        ),
        'agent.wait',
        'agent_info',
      )
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'timeout' || code === 'herdr_timeout') return undefined
      throw error
    }
  }

  /** 已结算的 blocked 水位先做短暂退避防抖；若发键后连续退避仍停留在同一 blocked seq，重开审批让人类重选。 */
  private static readonly MAX_SETTLED_BLOCKED_BACKOFFS = 2

  /** Ask 存续复核对瞬时故障（herdr_timeout/节点闪断）的最大连续容忍次数（退避重试）；超过才销单并显式失败。 */
  private static readonly MAX_ASK_POLL_TRANSIENT_FAILURES = 6
  /** abort 后循环销单的最大尝试次数（防 cancel 持续失败时重试+通知风暴；剩余兑底交给 closePane）。 */
  private static readonly MAX_ABORT_CANCEL_ATTEMPTS = 5
  private static readonly ABORT_CANCEL_BACKOFF_CAP_MS = 3_200
  /** md 交接稳定性复检的间隔（两次读一致才接受；json 有 schema 硬校验无需此检）。 */
  private static readonly MD_STABLE_RECHECK_MS = 300

  /** 已结算的 blocked 水位只退避；新水位交给同一审批桥。 */
  private async waitUntilSettled(request: AgentSpawnRequest, pane: ManagedPane, initial: HerdrAgentInfo): Promise<void> {
    let info = initial
    let attempts = 0
    while (info.agentStatus !== 'idle' && info.agentStatus !== 'done') {
      request.signal?.throwIfAborted()
      if (info.agentStatus === 'blocked') {
        const entry = this.asks.get(nodeIdOf(pane), pane.paneId, info.stateChangeSeq)
        if (entry?.phase === 'settled') {
          if (attempts >= HerdrExecutor.MAX_SETTLED_BLOCKED_BACKOFFS) {
            // 闭环逃生门：send_keys 已发但终端仍停留在同一 seq 的 blocked（按键
            // 未被接受），或条目以 keysSent=false 结算（superseded/cancelled）后
            // 终端同 seq 卡死——两者都依赖 seq 推进解环，若封顶退避后仍无进展，
            // 重开审批让人类对照快照重新选择，绝不无限退避 livelock。
            this.asks.reopenUnresolved(nodeIdOf(pane), pane.paneId, info.stateChangeSeq)
            attempts = 0
            if (!await this.bridgeBlocked(request, pane, info)) {
              throw new HelmError('aborted', `人类取消了 pane ${pane.paneId} 的审批`, 409)
            }
          } else {
            await backoffForDuplicateBlocked(signalOf(request), ++attempts, this.deps.blockedBackoffBaseMs, this.deps.blockedBackoffCapMs)
          }
        } else {
          if (!await this.bridgeBlocked(request, pane, info)) {
            throw new HelmError('aborted', `人类取消了 pane ${pane.paneId} 的审批`, 409)
          }
          attempts = 0
        }
      } else if (info.agentStatus === 'unknown') {
        throw new HelmError('herdr_agent_unsettled', `pane ${pane.paneId} 状态 unknown，无法确认完成`, 502)
      }
      info = parseAgentResult(await this.transport.call(
        pane.target, 'agent.wait', { target: pane.paneId, until: ['idle', 'done', 'blocked'] }, { signal: request.signal },
      ), 'agent.wait', 'agent_info')
    }
  }

  private paneKey(pane: ManagedPane): string {
    return JSON.stringify([pane.target, pane.paneId])
  }

  /** closePane 单飞键（与 closePane 内部完全同构：steer 门禁复用同一坐标）。 */
  private closeKey(pane: ManagedPane): string {
    return `${nodeIdOf(pane) ?? 'local'}:${pane.paneId}`
  }

  /** prompt --wait（含自愈追问共用）：blocked 也可能立即返回（审批桥接管）。 */
  private async promptAndWait(target: HerdrTarget, pane: ManagedPane, text: string, signal?: AbortSignal): Promise<HerdrAgentInfo> {
    return parseAgentResult(
      await this.transport.call(
        target,
        'agent.prompt',
        { target: pane.paneId, text, wait: { until: ['done', 'idle', 'blocked'] } },
        { signal },
      ),
      'agent.prompt',
      'agent_prompted',
    )
  }

  /**
   * blocked 桥接：权威 agent.get 取 seq -> 协调器单飞 -> createAsk（预分配 id）
   * -> 回答后复核 seq -> 带 expected_state_seq 的 CAS send_keys。返回 false 表示人类取消。
   */
  private async bridgeBlocked(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    observed: HerdrAgentInfo,
  ): Promise<boolean> {
    const target = targetOf(pane)
    const authority = await this.agentGet(target, pane.paneId, request.signal)
    for (const superseded of this.asks.observeAuthority({
      paneId: pane.paneId,
      nodeId: nodeIdOf(pane),
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })) {
      await this.cancelAskQuietly(superseded.askId, 'superseded')
    }
    if (authority.agentStatus !== 'blocked') return true // 终端已自行处理（旧快照）。

    const begin = this.asks.beginBlocked(nodeIdOf(pane), pane.paneId, authority.stateChangeSeq)
    const entry: AskEntry =
      'owner' in begin
        ? begin.owner
        : this.asks.get(nodeIdOf(pane), pane.paneId, authority.stateChangeSeq)!
    if (entry === undefined) return true
    if (entry.phase === 'settled') return true
    const existing = this.blockedTasks.get(entry.askId)
    if (existing !== undefined) return existing
    const task = Promise.resolve().then(async () => {
      await this.project(pane, `ask:${entry.askId}`)
      const { outcome, plan } = await this.createAsk(request, pane, entry, this.host.askConversationId(request.parentConversationId))
      return this.consumeAskOutcome(request, pane, entry, outcome, plan)
    }).catch(async (error: unknown) => {
      // 任务链失败时条目若仍 pending（宿主 AskDoc 已入库未结算），必须先显式
      // 销单再清条目——failCreate 只清协调器，否则宿主留下永远 pending 的
      // 孤儿审批卡。
      if (entry.phase === 'pending' && this.asks.get(nodeIdOf(pane), pane.paneId, entry.seq) === entry) {
        await this.cancelAskQuietly(entry.askId, 'cancelled')
      }
      this.asks.failCreate(entry)
      throw error
    }).finally(() => this.blockedTasks.delete(entry.askId))
    this.blockedTasks.set(entry.askId, task)
    return task
  }

  /**
   * createAsk（预分配 id，条目已先登记）：返回终态结果与本次快照生成的
   * 按键规划（plan 供 consumeAskOutcome 将 decision 映射为按键序列）。
   * - 创建前权威复核：seq 已推进/已非 blocked -> 无需再问（synthetic superseded）；
   * - 宿主返回 cancelled 且条目已被销（404 竞态确认）-> 同样 synthetic superseded
   *   回主循环，绝不留 pending；
   * - 重试 attempt（重开审批）时描述开头附「上次按键未解除阻塞」提示，
   *   终端快照用代码块围栏包裹（前端 AskDock 据此提取折叠快照）。
   */
  private async createAsk(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    entry: AskEntry,
    conversationId: number,
  ): Promise<{ outcome: CreateAskResultLike; plan: HerdrAskPromptPlan }> {
    const authority = await this.agentGet(targetOf(pane), pane.paneId, request.signal)
    for (const superseded of this.asks.observeAuthority({
      paneId: pane.paneId,
      nodeId: nodeIdOf(pane),
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })) {
      await this.cancelAskQuietly(superseded.askId, 'superseded')
    }
    if (authority.stateChangeSeq !== entry.seq || authority.agentStatus !== 'blocked') {
      this.asks.settle(entry, { keysSent: false })
      return { outcome: { id: entry.askId, status: 'superseded', answers: {} }, plan: buildHerdrAskPromptPlan('') }
    }
    const snapshot = await this.readDiagnostic(pane)
    // 混合快慢路径：正则已识别标准菜单（>= 2 项）时走 0ms 确定性快路径，
    // 绝不调 AI（省延迟、省 Token）；仅非标 TUI 快照（如横向按钮 / 快捷键提示）
    // 且配置了模型端口时，才异步解析候选按键选项。
    let aiAnalysis: BlockedSnapshotAnalysis | undefined
    let aiDiagnostic: string | undefined
    const fastItems = extractMenuItemsFromSnapshot(snapshot)
    if (fastItems.length < 2 && snapshot.trim().length > 0 && this.deps.analyzeBlockedSnapshot !== undefined) {
      try {
        const outcome = await this.deps.analyzeBlockedSnapshot({
          snapshot,
          conversationId,
          signal: request.signal,
        })
        aiAnalysis = outcome.analysis
        aiDiagnostic = outcome.diagnostic
        if (aiDiagnostic !== undefined) {
          // 增强未完成不阻塞审批主流程，但绝不静默：通知人类已回退通用选项。
          this.host.notify('阻塞快照 AI 解析未完成', this.deps.redact(aiDiagnostic), 'info')
        }
      } catch (error) {
        // 外部取消立即传播；其余情况（含注入端口直接 throw）如实通知后回退。
        // 诊断用固定安全文案，不回显上游 Error.message（可含 raw response/快照）。
        if (request.signal?.aborted) throw error
        aiAnalysis = undefined
        aiDiagnostic = '阻塞快照 AI 解析异常（请求失败），已回退通用按键选项'
        this.host.notify('阻塞快照 AI 解析未完成', aiDiagnostic, 'info')
      }
      // AI 等待期间终端可能自行推进：权威复核 seq，过期则不挂旧 AskDoc。
      const latest = await this.agentGet(targetOf(pane), pane.paneId, request.signal)
      for (const superseded of this.asks.observeAuthority({
        paneId: pane.paneId,
        nodeId: nodeIdOf(pane),
        seq: latest.stateChangeSeq,
        status: latest.agentStatus,
      })) {
        await this.cancelAskQuietly(superseded.askId, 'superseded')
      }
      if (latest.stateChangeSeq !== entry.seq || latest.agentStatus !== 'blocked') {
        this.asks.settle(entry, { keysSent: false })
        return { outcome: { id: entry.askId, status: 'superseded', answers: {} }, plan: buildHerdrAskPromptPlan('') }
      }
    }
    const plan = buildHerdrAskPromptPlan(snapshot, aiAnalysis, (t) => this.deps.redact(t))
    const retryHint =
      entry.attempt > 0 && entry.lastSentKeys && entry.lastSentKeys.length > 0
        ? `上次发送的按键 [${entry.lastSentKeys.join(', ')}] 未解除阻塞（终端仍停留在 seq ${entry.seq}），请对照快照重新选择。\n\n`
        : ''
    const aiSummaryLine = plan.summary ? `阻塞摘要：${this.deps.redact(plan.summary)}\n\n` : ''
    const aiFallbackLine = aiDiagnostic ? `${this.deps.redact(aiDiagnostic)}\n\n` : ''
    // 快照统一取尾部 1500 字符：与 AI 解析所据内容同口径，保证人类看到
    // 模型做出判断所依据的当前菜单（长快照头部往往是无关节奏输出）。
    const description = `${retryHint}${aiSummaryLine}${aiFallbackLine}终端 agent (${pane.agentName}) 在 ${pane.effectiveCwd} 等待选择。终端快照（脱敏）：\n\`\`\`\n${snapshot.slice(-1500)}\n\`\`\``
    const pending = this.host.createAsk({
      id: entry.askId,
      conversationId,
      ownerPluginId: 'builtin:herdr',
      title: `Herdr 审批：pane ${pane.paneId}`,
      description,
      fields: [
        {
          name: 'decision',
          label: '如何处理该阻塞？',
          type: 'select',
          required: true,
          options: plan.options,
        },
        {
          name: 'key',
          label: '自定义按键序列（仅 decision=custom 时使用，多键用空格或逗号分隔，如 enter / esc / down, enter）',
          type: 'text',
          required: false,
        },
      ],
      expectedStateSeq: entry.seq,
    })
    this.asks.markPending(entry)
    // createAsk 返回的是终态 promise；其入库可晚于事件销单的 404。
    // 在该 promise 结束前持续复核并销单，远端同样无需依赖本机 socket 事件。
    const monitor = new AbortController()
    const result = pending.finally(() => monitor.abort())
    const polling = (async () => {
      // 存续复核容错边界：瞬时故障（herdr_timeout/节点闪断）退避重试，超过
      // 上限才先销宿主 AskDoc 再显式失败；绝不让一次抖动击穿任务，也绝不
      // 留下永远 pending 的孤儿审批卡。
      let transientFailures = 0
      let abortCancelAttempts = 0
      while (!monitor.signal.aborted) {
        try { await delay(this.pollIntervalMs, undefined, { signal: monitor.signal }) }
        catch (error) { if (monitor.signal.aborted) return; throw error }
        if (request.signal?.aborted) {
          // abort 后销单退避有界：cancel 持续非 404 失败时不得每 100ms
          // 重试+通知风暴；超限后交由 closePane 的 paneClosed 清单兑底。
          if (abortCancelAttempts >= HerdrExecutor.MAX_ABORT_CANCEL_ATTEMPTS) return
          if (abortCancelAttempts > 0) {
            try {
              await delay(
                Math.min(this.pollIntervalMs * 2 ** abortCancelAttempts, HerdrExecutor.ABORT_CANCEL_BACKOFF_CAP_MS),
                undefined,
                { signal: monitor.signal },
              )
            } catch (error) { if (monitor.signal.aborted) return; throw error }
          }
          await this.cancelAskQuietly(entry.askId, 'cancelled')
          abortCancelAttempts += 1
          continue
        }
        let current: HerdrAgentInfo
        try {
          current = await this.agentGet(targetOf(pane), pane.paneId, monitor.signal)
          transientFailures = 0
        } catch (error) {
          if (monitor.signal.aborted) return
          if ((error as { code?: string }).code === 'herdr_aborted') throw error
          transientFailures += 1
          if (transientFailures > HerdrExecutor.MAX_ASK_POLL_TRANSIENT_FAILURES) {
            // 最终失败：异步销宿主 AskDoc 后立即上抛真实错误（不 await——
            // 等待会让宿主 cancelled 终态先赢 Promise.race，把基础设施失败
            // 伪装成「人类取消」abort 路径关掉失败现场）；兑底 cancel 由
            // 任务链 catch 的同步销单保证，绝不留 pending 孤儿审批卡。
            void this.cancelAskQuietly(entry.askId, 'cancelled')
            throw error
          }
          try {
            await delay(
              Math.min(500 * 2 ** (transientFailures - 1), 4_000),
              undefined,
              { signal: monitor.signal },
            )
          } catch (error) { if (monitor.signal.aborted) return; throw error }
          continue
        }
        if (current.stateChangeSeq !== entry.seq || current.agentStatus !== 'blocked') {
          this.asks.observeAuthority({ nodeId: nodeIdOf(pane), paneId: pane.paneId, seq: current.stateChangeSeq, status: current.agentStatus })
          await this.cancelAskQuietly(entry.askId, 'superseded')
        }
      }
    })()
    try {
      return { outcome: await Promise.race([result, polling.then(() => result)]), plan }
    } finally {
      monitor.abort()
      await polling.catch((error: unknown) => {
        if ((error as { code?: string }).code !== 'herdr_aborted') throw error
      })
    }
  }

  /** 消费终态：answered 且权威 seq 未推进 -> 能力门禁 -> 带 expected_state_seq 的 CAS send_keys（stale_state 拒绝 = 键未发送，绝不重试）；cancelled -> false。 */
  private async consumeAskOutcome(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    entry: AskEntry,
    outcome: CreateAskResultLike,
    plan: HerdrAskPromptPlan,
  ): Promise<boolean> {
    if (outcome.status !== 'answered') {
      this.asks.settle(entry, { keysSent: false })
      if (outcome.status === 'superseded') return true
      return false
    }
    const decision = outcome.answers['decision'] ?? ''
    let keys: string[] | undefined
    if (decision === 'custom') {
      const custom = parseCustomKeys(outcome.answers['key'] ?? '')
      if (custom.length === 0) {
        this.asks.settle(entry, { keysSent: false })
        return false
      }
      keys = custom
    } else {
      keys = plan.decisionKeys.get(decision)
    }
    if (keys === undefined || keys.length === 0) {
      this.asks.settle(entry, { keysSent: false })
      return false
    }
    const authority = await this.agentGet(targetOf(pane), pane.paneId, request.signal)
    for (const superseded of this.asks.observeAuthority({
      paneId: pane.paneId,
      nodeId: nodeIdOf(pane),
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })) {
      await this.cancelAskQuietly(superseded.askId, 'superseded')
    }
    if (authority.name !== pane.agentName) throw new HelmError('herdr_ownership_lost', `pane ${pane.paneId} 的 Agent 身份已变化，不能发送按键`, 409)
    if (authority.stateChangeSeq !== entry.seq || authority.agentStatus !== 'blocked') {
      this.asks.settle(entry, { keysSent: false })
      return true
    }
    // 协议级 CAS：send_keys 携带 expected_state_seq（entry.seq），彻底关闭上方
    // 权威 agent.get 与写键之间的毫秒级残窗——人类在终端直接按键推进 seq 时
    // 服务端必须以 stale_state 拒绝且不写入任何按键。
    await this.assertSendKeysCas(targetOf(pane), request.signal)
    try {
      await assertOkResult(
        await this.transport.call(
          targetOf(pane),
          'agent.send_keys',
          buildSendKeysParams({ target: pane.paneId, keys, expectedStateSeq: entry.seq }),
          { signal: request.signal },
        ),
        'agent.send_keys',
      )
    } catch (error) {
      if (!isStaleStateError(error)) throw error
      // 服务端 CAS 拒绝 = 键未发送：按「终端已先行推进」收敛（同 superseded
      // 语义回主循环等权威状态），绝不重试同一批 keys，绝不记发送成功。
      this.asks.settle(entry, { keysSent: false })
      this.host.notify(
        'Herdr 审批已过时',
        `pane ${pane.paneId} 的按键选择因终端状态已推进（stale_state）被服务端拒绝，未发送任何按键；主循环将继续按权威状态收敛`,
        'info',
      )
      return true
    }
    this.asks.settle(entry, { keysSent: true, sentKeys: keys })
    this.host.notify('Herdr 审批已发送', `pane ${pane.paneId} 已按人类选择发送按键：${keys.join(' ')}`, 'info')
    return true
  }

  /**
   * agent.send_keys 的 CAS 能力门禁（显式探测，绝不静默降级）：
   * 目标 Herdr 未在 ping capabilities 通告 SEND_KEYS_CAS_CAPABILITY 时拒绝发键
   * （herdr_cas_unsupported）——旧服务端 serde 忽略未知字段，盲发
   * expected_state_seq 会被静默当作无 CAS 写键，恰好复现本修复要关闭的残窗。
   * 探测结果在同一启用周期内按 target 冻结（Herdr 升级后重新启用插件生效）。
   */
  private readonly sendKeysCasSupport = new Map<string, boolean>()

  private async assertSendKeysCas(target: HerdrTarget, signal?: AbortSignal): Promise<void> {
    const key = JSON.stringify(target)
    const cached = this.sendKeysCasSupport.get(key)
    if (cached === true) return
    if (cached === false) throw this.casUnsupportedError(target)
    const pong = parsePong(await this.transport.call(target, 'ping', {}, { signal, timeoutMs: 5_000 }))
    this.sendKeysCasSupport.set(key, pong.sendKeysCas)
    if (!pong.sendKeysCas) throw this.casUnsupportedError(target, pong)
  }

  private casUnsupportedError(target: HerdrTarget, server?: { version: string; protocol: number }): HelmError {
    const serverLabel = server !== undefined ? `（version ${server.version}, protocol ${server.protocol}）` : ''
    return new HelmError(
      'herdr_cas_unsupported',
      `目标 Herdr${serverLabel} 未在 ping capabilities 通告 '${SEND_KEYS_CAS_CAPABILITY}'，拒绝无 CAS 的 agent.send_keys：旧服务端会静默忽略 expected_state_seq 并照常写键（复现审批桥 CAS 残窗）；请升级 Herdr 服务端至通告该能力的版本，并重新启用 herdr 插件`,
      502,
      {
        capability: SEND_KEYS_CAS_CAPABILITY,
        ...(server !== undefined ? { serverVersion: server.version, serverProtocol: server.protocol } : {}),
        target: JSON.stringify(target),
      },
    )
  }

  // ------------------------------------------------------------------
  // 运行中插话（steer）：仅 task 阶段 + agent.get 预检 + 现有 agent.prompt
  // ------------------------------------------------------------------

  /** steer 投递短超时：预检后单次投递应远小于此；超时如实报不确定，不重试。 */
  private static readonly STEER_PROMPT_TIMEOUT_MS = 5_000

  /** 服务端 admission 确定零写入的拒绝码（其余超时/断线/坏响应一律按不确定投递处理）。 */
  private static readonly STEER_ZERO_WRITE_CODES = new Set(['agent_not_ready', 'agent_blocked', 'agent_not_found'])

  /**
   * 受管窗格运行中插话（按 pane 互斥；单次投递不重试）：
   *
   * 门禁（任何一步失败确定性拒绝，绝无静默降级）：
   * 1. live 执行上下文：registry 现值 outcome=running 且阶段为 'task'
   *    （startup/handoff/gate/keepalive/failed/settled 一律拒绝）；
   * 2. run/父会话强匹配：workflowRunId 与 parentConversationId 必须与受管
   *    记录精确相等（仅限 workflow run 管理下的窗格）；
   * 3. 原 run signal 未取消（跨节点冻结 target：不重算 node/socket，不接受
   *    同 pane 不同 node——由 plugin 动作层精确 (nodeId, paneId) 定位保证）；
   * 4. agent.get 预检：name/tab/pane 身份精确相等、working 且非
   *    launch_pending；blocked 交原 Ask 审批桥（此处拒绝）；预检已
   *    idle/done/unknown 拒绝（绝不主动新建回合）；
   * 5. 预检跨 await 后复核阶段/registry/run signal；
   * 6. 投递：现有 agent.prompt {target: 受管 agentName, text}，无 wait、
   *    无附加守卫字段、显式短超时，单次调用即终局，绝不重试。预检到
   *    服务端接收之间刚转 idle 的提交交由真实 admission 裁定（允许接续
   *    新回合）；服务端确定零写入拒绝（agent_not_ready/agent_blocked/
   *    agent_not_found）不动原交接路径；超时/断线/坏响应
   *    为不确定投递——按 pane 记失败，任务结算时显式失败保留现场，
   *    绝不落回旧交接文件或自动重发。
   *
   * 诚实语义：guardLevel='preflight'——预检不是提交点原子复核（不可伪称
   * CAS）；steered=true 仅代表单次投递成功。每次成功插话把唯一交接文件
   * 重定向到全新 wf-out-* 名（旧名作废）：任务结算只接受最新名字的交付，
   * 旧结果/迟到写回天然无法冒充。
   */
  async steerPane(pane: ManagedPane, input: SteerPaneInput): Promise<{ stateChangeSeq: number }> {
    if (typeof input.text !== 'string' || input.text.trim() === '') {
      throw new HelmError('validation_error', '插话指导内容不能为空白', 400)
    }
    const key = this.paneKey(pane)
    if (this.activeSteers.has(key)) {
      throw new HelmError(
        'herdr_steer_in_flight',
        `pane ${pane.paneId} 已有在途插话，拒绝重入（按 pane 互斥）`,
        409,
        { paneId: pane.paneId },
      )
    }
    const steer = (async (): Promise<{ stateChangeSeq: number }> => {
      // 1-2) live 上下文 + 阶段 + run/父会话强匹配（以 registry 现值为准）。
      const current = this.assertSteerable(pane, input)
      // 3) 原 run signal 未取消。
      const origin = this.activeTasks.get(key)
      if (origin === undefined || origin.signal?.aborted) {
        throw new HelmError(
          'herdr_steer_task_ended',
          `pane ${pane.paneId} 的原任务已结束或正在取消，拒绝插话`,
          409,
          { paneId: pane.paneId },
        )
      }
      // 4) 预检：权威 agent.get 核验身份与工作状态（preflight，非提交点 CAS）。
      const authority = await this.agentGet(current.target, current.paneId, input.signal)
      if (
        authority.paneId !== current.paneId ||
        authority.tabId !== current.tabId ||
        authority.name !== current.agentName
      ) {
        throw new HelmError(
          'herdr_steer_identity_mismatch',
          `pane ${current.paneId} 权威身份与受管记录不一致（name=${String(authority.name)} tab=${authority.tabId}），拒绝插话`,
          409,
          { paneId: current.paneId, authorityName: authority.name, authorityTabId: authority.tabId },
        )
      }
      if (authority.launchPending === true) {
        throw new HelmError(
          'herdr_steer_not_ready',
          `pane ${current.paneId} 仍在启动（launch_pending），拒绝插话`,
          409,
          { paneId: current.paneId },
        )
      }
      if (authority.agentStatus === 'blocked') {
        throw new HelmError(
          'herdr_steer_agent_blocked',
          `pane ${current.paneId} 当前 blocked（等待审批），插话交由原审批桥负责：请先在 AskDock 完成审批`,
          409,
          { paneId: current.paneId, stateChangeSeq: authority.stateChangeSeq },
        )
      }
      if (authority.agentStatus !== 'working') {
        throw new HelmError(
          'herdr_steer_not_working',
          `pane ${current.paneId} 当前状态为 ${authority.agentStatus}，仅 working 可插话（绝不新建回合）`,
          409,
          { paneId: current.paneId, agentStatus: authority.agentStatus },
        )
      }
      // 5) 预检跨 await 复核：任务可能已结算/取消/进入新阶段。
      this.assertSteerable(pane, input)
      const originAfter = this.activeTasks.get(key)
      if (originAfter === undefined || originAfter.signal?.aborted) {
        throw new HelmError(
          'herdr_steer_task_ended',
          `pane ${pane.paneId} 插话期间原任务已结束或取消，投递中止（未发送任何输入）`,
          409,
          { paneId: pane.paneId },
        )
      }
      // 6) 单次投递：全新唯一交接文件名 + 现有 agent.prompt（无 wait/无附加字段）。
      const next = this.nextSteerOutputFileName(current)
      const text = this.steerPromptText(current, input, next)
      try {
        parseAgentResult(
          await this.transport.call(
            current.target,
            'agent.prompt',
            { target: current.agentName, text },
            { signal: input.signal, timeoutMs: HerdrExecutor.STEER_PROMPT_TIMEOUT_MS },
          ),
          'agent.prompt',
          'agent_prompted',
        )
      } catch (error) {
        const code = (error as { code?: string }).code
        if (typeof code === 'string' && HerdrExecutor.STEER_ZERO_WRITE_CODES.has(code)) {
          // 服务端 admission 确定零写入：不重定向交接文件、不记失败，
          // 原任务按自身节奏继续（前一有效路径保持不变）。
          throw error
        }
        // 超时/断线/坏响应：投递结果不确定（可能已写入）。按 pane 记失败，
        // 任务结算时显式失败保留现场；绝不静默落回旧文件或自动重发。
        if (this.activeTasks.get(key) === origin) {
          this.steerFailures.set(key, error instanceof Error ? error.message : String(error))
        }
        throw error
      }
      if (this.activeTasks.get(key) !== origin || origin.signal?.aborted || this.activeCloses.has(this.closeKey(current))) {
        throw new HelmError('herdr_steer_task_ended', `pane ${pane.paneId} 的输入已投递，但原任务已取消或关闭；请检查现场，不要重发`, 409)
      }
      // 成功投递后重定向唯一交接文件；结算排空在途 steer 时必然可见。
      this.registry.update(nodeIdOf(current), current.paneId, { outputFileName: next })
      const retired = this.steerRetiredFiles.get(key) ?? []
      if (current.outputFileName !== undefined && current.outputFileName !== '') {
        retired.push(current.outputFileName)
      }
      this.steerRetiredFiles.set(key, retired)
      return { stateChangeSeq: authority.stateChangeSeq }
    })().finally(() => this.activeSteers.delete(key))
    this.activeSteers.set(key, steer)
    return steer
  }

  /** steer 门禁前置（registry 现值复核；返回现值供后续步骤共用）。 */
  private assertSteerable(pane: ManagedPane, input: SteerPaneInput): ManagedPane {
    const current = this.registry.get(nodeIdOf(pane), pane.paneId)
    if (current === undefined || current.outcome !== 'running') {
      throw new HelmError(
        'herdr_steer_not_running',
        `pane ${pane.paneId} 不在受管运行中（outcome=${current?.outcome ?? 'unmanaged'}），拒绝插话`,
        409,
        { paneId: pane.paneId, outcome: current?.outcome ?? 'unmanaged' },
      )
    }
    // 关闭中拒绝：closePane 在入口同步登记 activeCloses，但 phase/outcome 要
    // 到若干次 await 之后才变更——非 abort 关闭过程（workflow/turn settle、
    // 对账回收）同样必须挡住 steer，不能只看 task+running 门禁。
    if (this.activeCloses.has(this.closeKey(pane))) {
      throw new HelmError(
        'herdr_steer_task_ended',
        `pane ${pane.paneId} 正在关闭（结算/取消/回收中），拒绝插话`,
        409,
        { paneId: pane.paneId },
      )
    }
    const phase = this.panePhases.get(this.paneKey(pane))
    if (phase !== 'task') {
      throw new HelmError(
        'herdr_steer_phase',
        `pane ${pane.paneId} 当前处于 ${phase ?? '无在途任务'} 阶段，仅任务执行期（task）可插话`,
        409,
        { paneId: pane.paneId, phase: phase ?? 'none' },
      )
    }
    if (current.workflowRunId !== input.workflowRunId || current.parentConversationId !== input.parentConversationId) {
      throw new HelmError(
        'herdr_steer_context_mismatch',
        `pane ${pane.paneId} 受管归属（workflow=${String(current.workflowRunId)} 父会话=${current.parentConversationId}）与插话目标（workflow=${input.workflowRunId} 父会话=${input.parentConversationId}）不一致，拒绝跨轨道插话`,
        409,
        {
          paneId: pane.paneId,
          managedWorkflowRunId: current.workflowRunId,
          managedParentConversationId: current.parentConversationId,
          requestedWorkflowRunId: input.workflowRunId,
          requestedParentConversationId: input.parentConversationId,
        },
      )
    }
    if (this.steerFailures.has(this.paneKey(pane))) {
      throw new HelmError(
        'herdr_steer_uncertain',
        `pane ${pane.paneId} 的前次插话投递结果不确定，请先检查现场，不能继续插话掩盖该结果`,
        409,
        { paneId: pane.paneId },
      )
    }
    return current
  }

  /** 插话投递文本：来源前缀 + 脱敏指导 + 交接文件重定向（旧路径作废，仅最新指导有效）。 */
  private steerPromptText(pane: ManagedPane, input: SteerPaneInput, nextFileName: string): string {
    const previous = pane.outputFileName
    if (previous === undefined || previous === '') {
      throw new HelmError(
        'herdr_context_unavailable',
        `pane ${pane.paneId} 缺少交接文件名（任务阶段异常），拒绝插话`,
        409,
        { paneId: pane.paneId },
      )
    }
    return [
      `父会话插话纠偏（后台运行 ${input.workflowRunId}）：`,
      this.deps.redact(input.text),
      '',
      '--- helm 交接契约更新（必须遵守）---',
      `按本插话的最新指导完成剩余工作后，把最终结果写入新文件 ${pane.effectiveCwd}/.helm/${nextFileName}（内容要求与原交接契约一致，仍须通过原 Schema 与 Gate）。`,
      `原交接文件 ${previous} 已作废：不要再写旧文件；helm 只接受新文件的交付，未写新文件视为任务失败。`,
    ].join('\n')
  }

  /** 本次插话的全新唯一交接文件名（与当前业务文件同扩展；复用同一白名单）。 */
  private nextSteerOutputFileName(pane: ManagedPane): string {
    const fileName = pane.outputFileName
    if (fileName === undefined || fileName === '') {
      throw new HelmError(
        'herdr_context_unavailable',
        `pane ${pane.paneId} 缺少交接文件名（任务阶段异常），拒绝插话`,
        409,
        { paneId: pane.paneId },
      )
    }
    const ext = fileName.endsWith('.json') ? 'json' : 'md'
    return buildOutputFileName(`s${randomUUID()}`, ext)
  }

  /** 成功交接后清理已被插话作废的旧结果文件（失败路径保留现场；清理失败显式通知不拖垮已验证结果）。 */
  private async clearRetiredSteerOutputs(request: AgentSpawnRequest, pane: ManagedPane): Promise<void> {
    const key = this.paneKey(pane)
    const retired = this.steerRetiredFiles.get(key)
    if (retired === undefined || retired.length === 0) return
    try {
      for (const fileName of retired) {
        await this.transport.removeOutput(targetOf(pane), pane.effectiveCwd, fileName, request.signal)
      }
    } catch (error) {
      this.host.notify(
        'Herdr 作废交接文件清理未竟',
        `插话作废的旧结果文件删除失败（结果已验证，不影响本次交付）：${error instanceof Error ? this.deps.redact(error.message) : String(error)}`,
        'error',
      )
    } finally {
      this.steerRetiredFiles.delete(key)
    }
  }

  // ------------------------------------------------------------------
  // 文件交接与 gate
  // ------------------------------------------------------------------

  private async readAndValidateOutput(request: AgentSpawnRequest, pane: ManagedPane): Promise<unknown> {
    const transport = this.transport
    const fileName = pane.outputFileName!
    const target = targetOf(pane)
    const readOnce = async (): Promise<{ ok: true; value: unknown } | { ok: false; reason: string; recoverable: boolean }> => {
      let raw: string
      try {
        raw = await transport.readOutput(target, pane.effectiveCwd, fileName, request.signal)
      } catch (error) {
        if (error instanceof HelmError && error.code === 'herdr_output_missing') {
          return { ok: false, reason: `交接文件缺失：${fileName}`, recoverable: true }
        }
        // 其它 IO/SSH/权限错误：如实抛诊断，不当缺文件自愈。
        throw error
      }
      if (request.schema === undefined) {
        if (raw.trim() === '') return { ok: false, reason: '交接文件为空', recoverable: true }
        return { ok: true, value: this.deps.redact(raw) }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        return {
          ok: false,
          reason: `交接文件不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
          recoverable: true,
        }
      }
      try {
        validateOrThrow(request.schema, parsed, '交接文件内容未通过 JSON Schema 校验', 'schema_validation_failed', 502)
        return { ok: true, value: JSON.parse(this.deps.redact(JSON.stringify(parsed))) as unknown }
      } catch (err) {
        if (err instanceof HelmError && err.code === 'schema_validation_failed') {
          return { ok: false, reason: err.message, recoverable: true }
        }
        throw err
      }
    }

    /**
     * md 交接的稳定性复检：agent 非原子多段写 + agent.wait 返回 idle 但后台
     * 仍在写时，首读可能拿到截断 Markdown——间隔短时复读一致才接受，否则
     * 按可自愈失败走追问路径（json 路径已有 parse+schema 硬校验，无需此检；
     * 残余风险：两次读间隔内恰好写完且不再变化的前缀截断仍无法区分，由
     * 自愈追问兑底）。
     */
    const readOnceStable = async (): Promise<{ ok: true; value: unknown } | { ok: false; reason: string; recoverable: boolean }> => {
      const first = await readOnce()
      if (!first.ok || request.schema !== undefined) return first
      await delay(HerdrExecutor.MD_STABLE_RECHECK_MS, undefined, { signal: request.signal })
      const second = await readOnce()
      if (!second.ok) return second
      if (second.value !== first.value) {
        return { ok: false, reason: '交接文件仍在写入（间隔复读内容不一致）', recoverable: true }
      }
      return first
    }

    let attempt = await readOnceStable()
    if (!attempt.ok) {
      this.host.notify('Herdr 交接自愈', `pane ${pane.paneId} 首次交接失败（${attempt.reason}），追问一次`, 'info')
      await this.project(pane, `heal:${pane.agentName}`)
      // 自愈追问本身也可能 blocked：同一审批桥等待真实进展后再读文件，
      // 不能读缺文件就判失败。
      await this.promptAndWaitHeal(request, pane, attempt.reason)
      attempt = await readOnceStable()
    }
    if (!attempt.ok) {
      await this.markFailed(pane, attempt.reason)
      const snapshot = await this.readDiagnostic(pane)
      throw new HelmError(
        'herdr_output_contract_violation',
        `pane ${pane.paneId} 两次交接均失败（${attempt.reason}）；窗格保留供人工排查。终端最后 40 行（脱敏）：\n${snapshot}`,
        502,
        { paneId: pane.paneId, reason: attempt.reason, snapshot },
      )
    }
    await transport.removeOutput(target, pane.effectiveCwd, fileName, request.signal)
    return attempt.value
  }

  /** 自愈追问：与首轮同形（prompt --wait + blocked 桥循环）。 */
  private async promptAndWaitHeal(request: AgentSpawnRequest, pane: ManagedPane, reason: string): Promise<void> {
    const target = targetOf(pane)
    const text =
      `你上一轮未按要求交付。${reason}。请立即将最终结果写入 ${pane.effectiveCwd}/.helm/${pane.outputFileName}` +
      (request.schema !== undefined ? `（满足 Schema 的单个 JSON 值）。\nJSON Schema: ${redactSchemaText(request.schema, this.deps.redact)}` : '（Markdown 全文）。')
    const info = await this.promptAndWait(target, pane, this.deps.redact(text), request.signal)
    await this.waitUntilSettled(request, pane, info)
  }

  /** agent.read recent_unwrapped 40 行脱敏快照（诊断专用）。 */
  private async readDiagnostic(pane: ManagedPane): Promise<string> {
    try {
      const read = parsePaneRead(
        await this.transport.call(targetOf(pane), 'agent.read', {
          target: pane.paneId,
          source: 'recent_unwrapped',
          lines: 40,
          format: 'text',
        }, { timeoutMs: 5_000 }),
      )
      return this.deps.redact(read.text).slice(-4_000)
    } catch (error) {
      return `[快照读取失败：${error instanceof Error ? this.deps.redact(error.message) : String(error)}]`
    }
  }

  /** gate：文件成功后恰好一次；本机 runLocalGate，远端 transport.runGate（同一实际 cwd 与路由 env）。 */
  private async runGateFor(request: AgentSpawnRequest, pane: ManagedPane): Promise<void> {
    const env = this.paneEnvs.get(this.paneKey(pane))
    if (env === undefined) throw new HelmError('herdr_context_unavailable', '任务环境已丢失，无法在同一环境执行 Gate', 409)
    const gate: { ok: boolean; output: string } =
      nodeIdOf(pane) === undefined
        ? await this.deps.runLocalGate(request.gate!, {
            cwd: pane.effectiveCwd,
            conversationId: this.host.askConversationId(request.parentConversationId),
            signal: request.signal,
            env,
          })
        : await this.transport.runGate(targetOf(pane), request.gate!, pane.effectiveCwd, request.signal, env)
    request.onGateResult?.({ ...gate, output: this.deps.redact(gate.output) })
    if (!gate.ok) {
      await this.markFailed(pane, `gate 失败：${request.gate}`)
      throw new HelmError(
        'gate_failed',
        `验收命令失败（exit≠0）：${request.gate}\n${this.deps.redact(gate.output).slice(-2000)}`,
        502,
        { output: this.deps.redact(gate.output).slice(-4000) },
      )
    }
  }

  // ------------------------------------------------------------------
  // resume
  // ------------------------------------------------------------------

  /**
   * 真实 resume 双入口（先识别自有记录，不依赖 request.agentType）：
   * - standalone subagent：resume = onResolved.executionId（paneId），通常无
   *   request.agentId；
   * - workflow resumeAgent：resume = 本 run 记录的 agentId，无 agentType。
   * 校验：只准同 workflow（含 undefined 轨道一致）及同父会话；拒绝 busy/
   * settled/未知/歧义；显式 kind/nodeId/cwd 不一致显式拒绝（不静默忽略）。
   * 返回 undefined 表示该 ref 非本插件记录（交还内核原生 resume）。
   */
  private async resumeInto(request: AgentSpawnRequest, candidates: ManagedPane[]): Promise<unknown> {
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
    const reqWf = request.workflowRunId
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
    this.assertAttachmentsReachable(request, targetOf(pane), resumeRouting)
    if (request.cwd !== undefined && request.cwd !== pane.effectiveCwd) {
      throw new HelmError(
        'resume_cwd_conflict',
        `resume 显式 cwd '${request.cwd}' 与窗格实际工作目录 '${pane.effectiveCwd}' 不一致；续接必须保留原 worktree cwd`,
        409,
        { resumeRef, requestCwd: request.cwd, effectiveCwd: pane.effectiveCwd },
      )
    }

    const unique = `${Date.now()}-resume-${HashShort.of(request.prompt.slice(0, 160))}-${request.parentConversationId}-${Math.random().toString(36).slice(2, 6)}`
    const safeId = `r${HashShort.of(unique)}`
    const ext = request.schema !== undefined ? 'json' : 'md'
    if (this.registry.get(nodeIdOf(pane), pane.paneId)?.outcome === 'running') {
      throw new HelmError('pane_busy', `pane ${pane.paneId} 已由另一续接占用`, 409)
    }
    const updated = this.registry.update(nodeIdOf(pane), pane.paneId, {
      outcome: 'running',
      outputFileName: buildOutputFileName(safeId, ext),
      agentId: request.agentId ?? pane.agentId,
      ...(request.workflowRunId !== undefined ? { workflowRunId: request.workflowRunId } : {}),
    })!
    request.onResolved?.(this.executionInfoOf(updated))
    // request.cwd 缺省代表沿用窗格实际 cwd（不重开窗、不重建 env tab）。
    // 续接不重跑 agent.start（窗格已有 agent）；直接进入投递-审批-交接循环。
    // env 缺失（失败窗格清理后）：按当前路由与窗格实际 cwd 重建（同构于建窗，
    // 不留机密长驻内存也能支撑 resume Gate）。
    if (!this.paneEnvs.has(this.paneKey(updated))) {
      this.paneEnvs.set(
        this.paneKey(updated),
        this.buildPaneEnv(request.parentConversationId, updated.effectiveCwd, resumeRouting, targetOf(updated)),
      )
    }
    await this.preloadAttachmentMeta(request)
    return this.runManagedTask(request, updated)
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
    const routing = await resolveSpawnRouting(request.agentType, this.deps.profiles)
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

  // ------------------------------------------------------------------
  // 清理与状态
  // ------------------------------------------------------------------

  /**
   * 关闭自有 pane（单飞 + 结算幂等）：
   * - 正在关闭：直接复用同一 close promise（abort 与 settle 双路径并发安全）；
   * - 结局判定以 registry 当前值为准（调用方快照可能过时：等待期间任务可能
   *   已 markFailed 置 failed——失败窗格保留现场，绝不能被批量清理关掉并
   *   覆盖 failureNote）；已 settled / failed 均直接返回；
   * - 仅关自有资源：普通 tab.close；worktree workspace.close（close_group 防链组）；
   * - 失败 pane 保留现场；清理失败如实通知并上抛（不空 catch）。
   */
  async closePane(
    pane: ManagedPane,
    reason: 'settled' | 'cancelled' | 'workflow-settled' | 'turn-settled',
    options: { volatileMark?: boolean } = {},
  ): Promise<void> {
    // 单飞键与 steer 门禁（assertSteerable.activeCloses 检查）共用同一坐标。
    const key = this.closeKey(pane)
    const existing = this.activeCloses.get(key)
    if (existing !== undefined) return existing
    const current = this.registry.get(nodeIdOf(pane), pane.paneId)
    const outcome = current?.outcome ?? pane.outcome
    if (outcome === 'failed' || outcome === 'settled') return
    const closing = (async () => {
      const target = targetOf(pane)
      try {
        let owned = false
        try {
          const authority = await this.agentGet(target, pane.paneId)
          owned = authority.name === pane.agentName && authority.tabId === pane.tabId
          if (authority.name === undefined && this.unstartedPanes.has(this.paneKey(pane))) owned = true
        } catch (error) {
          if ((error as { code?: string }).code !== 'agent_not_found') throw error
          owned = this.unstartedPanes.has(this.paneKey(pane))
        }
        for (const entry of this.asks.paneClosed(pane.paneId, nodeIdOf(pane))) {
          await this.cancelAskQuietly(entry.askId, 'superseded')
        }
        if (owned) {
          // Herdr 关闭最后一个 tab 时自行回收空 workspace。只关闭本插件创建的
          // tab，避免关闭后来被人类加入的 pane 或关联工作区。
          await assertOkResult(await this.transport.call(target, 'tab.close', { tab_id: pane.tabId }, { timeoutMs: 5_000 }), 'tab.close')
        } else {
          this.host.notify('Herdr 窗格归属已变化', `pane ${pane.paneId} 已不属于 ${pane.agentName}，放弃清理`, 'info')
        }
      } catch (error) {
        this.host.notify(
          'Herdr 窗格清理失败',
          `pane ${pane.paneId}（${reason}）关闭失败：${error instanceof Error ? this.deps.redact(error.message) : String(error)}`,
          'error',
        )
        throw error
      }
      if (options.volatileMark === true) {
        // 服务 stop 路径：持久 doc 句柄已随停用失效，仅内存标记（对账下周期重建）。
        this.registry.markSettledVolatile(nodeIdOf(pane), pane.paneId)
      } else {
        this.registry.update(nodeIdOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
      }
      this.projector.forget(pane.paneId, nodeIdOf(pane))
      this.paneEnvs.delete(this.paneKey(pane))
      this.unstartedPanes.delete(this.paneKey(pane))
      this.panePhases.delete(this.paneKey(pane))
      this.activeTasks.delete(this.paneKey(pane))
      this.steerFailures.delete(this.paneKey(pane))
      this.steerRetiredFiles.delete(this.paneKey(pane))
      for (const removed of this.asks.paneClosed(pane.paneId, nodeIdOf(pane))) {
        if (removed.phase === 'pending' || removed.phase === 'creating') {
          await this.cancelAskQuietly(removed.askId, 'superseded')
        }
      }
    })().finally(() => this.activeCloses.delete(key))
    this.activeCloses.set(key, closing)
    return closing
  }

  /**
   * 外部结算路径（事件 pane.closed / 启动对账 / 探针归属不符）的 executor 侧
   * 资源对齐：registry 置 settled 后 closePane 会因幂等早退，机密 paneEnvs
   * （含 HELM_TOKEN）与未启动标记必须在此显式释放，生命周期与 registry
   * outcome 对齐，绝不随人类关窗逐个驻留到停用重建。在途 steer 的阶段/
   * 任务登记同步作废（其尾读复核将确定性拒绝）。
   */
  releasePaneState(pane: ManagedPane): void {
    const key = this.paneKey(pane)
    this.paneEnvs.delete(key)
    this.unstartedPanes.delete(key)
    this.panePhases.delete(key)
    this.activeTasks.delete(key)
    this.steerFailures.delete(key)
    this.steerRetiredFiles.delete(key)
  }

  private async cancelAskQuietly(askId: string, reason: 'cancelled' | 'superseded'): Promise<void> {
    try {
      await this.host.cancelAsk(askId, reason)
    } catch (error) {
      if (error instanceof HelmError && error.status === 404) return
      this.host.notify(
        'Herdr 审批销单失败',
        `ask ${askId} cancel 失败：${error instanceof Error ? this.deps.redact(error.message) : String(error)}`,
        'error',
      )
    }
  }

  private async markFailed(pane: ManagedPane, note: string): Promise<void> {
    // 失败窗格保留终端现场供人工排查，但回连机密 env 不再需要（无后续 gate）。
    this.paneEnvs.delete(this.paneKey(pane))
    this.registry.update(nodeIdOf(pane), pane.paneId, {
      outcome: 'failed',
      failureNote: this.deps.redact(note).slice(0, 500),
      settledAt: Date.now(),
    })
    this.projector.forget(pane.paneId, nodeIdOf(pane))
    for (const removed of this.asks.paneClosed(pane.paneId, nodeIdOf(pane)) ?? []) {
      if (removed.phase === 'pending' || removed.phase === 'creating') {
        await this.cancelAskQuietly(removed.askId, 'superseded')
      }
    }
  }

  private async project(pane: ManagedPane, token: string): Promise<void> {
    await this.projector.project(nodeIdOf(pane), pane.paneId, token)
  }
}

function signalOf(request: AgentSpawnRequest): AbortSignal {
  return request.signal ?? new AbortController().signal
}

export type { PaneRouting }
