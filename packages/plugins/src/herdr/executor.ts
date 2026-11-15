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
 *
 * 超时安全边界（TimeoutError 中止，区别于普通 AbortError 取消）：
 * - 无安全 stop/CAS 手段停止底层 CLI——超时只保存诊断并保留 pane（标 failed，
 *   不关窗、不发键），绝不把保留 pane 包装成可无条件续接；
 * - 后续 resume 在任何 prompt 发送前经 assertResumeAgentConfirmed 权威确认：
 *   仅 idle/done 可续接；working/blocked/unknown/无法确认一律显式拒绝
 *   （不新建、不按键中止）；启动期超时（agent.start 完成与否不确定）同样
 *   先安全确认，绝不盲目重发 agent.start；
 * - 普通 AbortError 取消仍按现状关闭自有 pane（已授权路径不变）。
 */

import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, targetPlatformOf, type AgentExecutionInfo, type AgentSpawnRequest, type TargetPlatform } from '@helm/protocol'
import { parseWorkflowSpawnMeta, workflowExecutionMeta } from '../contracts.js'
import type { CreateAskResultLike, CreateAskSpecLike, HerdrPluginDependencies, HerdrTarget } from './contracts.js'
import { targetNodeId } from './contracts.js'
import { AskCoordinator, backoffForDuplicateBlocked, type AskEntry } from './asks.js'
import { ApprovalBridge } from './approval-bridge.js'
import { MetadataProjector } from './metadata.js'
import { PaneRegistry, nodeIdOf, paneCloseKey, paneStateKey, targetOf, type ManagedPane, type PaneRouting } from './panes.js'
import { SteerDispatcher } from './executor-steer.js'
import { PaneHandoff } from './executor-handoff.js'
import { ResumeCoordinator } from './executor-resume.js'
import {
  assertOkResult,
  parseAgentResult,
  parseTabCreated,
  parseWorktreeCreated,
  type HerdrAgentInfo,
} from './rpc.js'
import {
  assertNoUnsupportedOverrides,
  buildAgentName,
  buildOutputFileName,
  buildSpawnPaneEnv,
  HashShort,
  MANAGED_ENV_KEYS,
  redactPromptText,
  redactSchemaText,
  resolveCwd,
  resolveSpawnRouting,
  type SpawnRouting,
} from './spawn-rules.js'
import { HERDR_STEER_CONTROLS } from './contracts.js'

/**
 * 窗格环境里由基线权威固定的受管键（MANAGED_ENV_KEYS + 回连/节点身份）：
 * applyPaneSecrets 授予叠加后重申基线值，授予名不得劫持。
 */
const PANE_MANAGED_LOCK_KEYS: readonly string[] = [...MANAGED_ENV_KEYS, 'HELM_HUB_URL', 'HELM_NODE_ID']

/** 受管键大写集：授予值（secretNames 命中的 stash 键）的大小写变体同样不得劫持。 */
const PANE_MANAGED_LOCK_UPPER: ReadonlySet<string> = new Set(
  PANE_MANAGED_LOCK_KEYS.map((key) => key.toUpperCase()),
)

/**
 * 授予 env 与基线受管锁定合并（纯函数，applyPaneSecrets 唯一实现）：
 * - 授予值叠加到基线之上（同名覆盖）；
 * - 受管键（含大小写变体别名，如 helm_execution_scope / Helm_Cwd）一律剥除
 *   后重申基线 canonical 值——Windows env 名大小写不敏感，别名可在子进程
 *   读取时劫持回连/身份/作用域变量（与内核 buildManagedEnv 固定覆盖同构）。
 */
export function mergeGrantedEnvWithManagedLocks(
  baseline: Record<string, string>,
  granted: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = { ...baseline, ...granted }
  for (const key of Object.keys(env)) {
    if (PANE_MANAGED_LOCK_UPPER.has(key.toUpperCase()) && !PANE_MANAGED_LOCK_KEYS.includes(key)) {
      delete env[key]
    }
  }
  for (const key of PANE_MANAGED_LOCK_KEYS) {
    if (key in baseline) env[key] = baseline[key]!
  }
  return env
}

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

/** steerPane 入参（与 plugins 包 ExternalSteerRequest 对齐；signal 为调用上下文取消）。 */
export interface SteerPaneInput {
  workflowRunId: string
  parentConversationId: number
  text: string
  signal?: AbortSignal
}

export class HerdrExecutor {
  /** pane scopeKey -> 进行中的 closePane promise（abort 双路径单飞）。 */
  private readonly activeCloses = new Map<string, Promise<void>>()

  /**
   * pane scopeKey -> 窗格环境基线（受管 HELM_* + Profile 合并，**不含任何 stash
   * 机密**）。只留在内存；Gate/续接每次从基线出发，按当次请求 secretNames 从
   * 当前 stash 重新授权取值——绝不缓存机密明文供后续子进程复用（TTL/回合
   * 结束后不再注入旧值）。
   */
  private readonly paneEnvs = new Map<string, Record<string, string>>()
  private readonly blockedTasks = new Map<string, Promise<boolean>>()
  private readonly unstartedPanes = new Set<string>()
  /** 在途受管任务的生命周期阶段与原始 spawn 请求（steer 门禁与尾读复核用）。 */
  private readonly panePhases = new Map<string, PaneTaskPhase>()
  private readonly activeTasks = new Map<string, AgentSpawnRequest>()
  /** 本机冻结连接目标（启用时注入）。 */
  private readonly localTarget: HerdrTarget

  /** 审批桥（blocked Ask 创建与终态消费；依赖经端口注入，见 approval-bridge.ts）。 */
  private readonly approvalBridge: ApprovalBridge
  /** steer 投递与交接文件轮转（在途/不确定/作废登记归其自管，见 executor-steer.ts）。 */
  private readonly steerDispatcher: SteerDispatcher
  /** 文件交接校验、原地追问自愈与 Gate（见 executor-handoff.ts）。 */
  private readonly paneHandoff: PaneHandoff
  /** resume 权威确认与路由恢复（见 executor-resume.ts）。 */
  private readonly resumeCoordinator: ResumeCoordinator

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
    this.approvalBridge = new ApprovalBridge({
      asks,
      transport: this.transport,
      host: { notify: host.notify, createAsk: host.createAsk },
      redact: deps.redact,
      analyzeBlockedSnapshot: deps.analyzeBlockedSnapshot,
      agentGet: (target, paneId, signal) => this.agentGet(target, paneId, signal),
      readDiagnostic: (pane) => this.paneHandoff.readDiagnostic(pane),
      cancelAskQuietly: (askId, reason) => this.cancelAskQuietly(askId, reason),
      pollIntervalMs: this.pollIntervalMs,
    })
    this.steerDispatcher = new SteerDispatcher({
      registry: this.registry,
      transport: this.transport,
      redact: deps.redact,
      notify: host.notify,
      agentGet: (target, paneId, signal) => this.agentGet(target, paneId, signal),
      waitUntilSettled: (request, pane, initial) => this.waitUntilSettled(request, pane, initial),
      startupTimeoutMs: () => host.startupTimeoutMs(),
      activeTaskOf: (key) => this.activeTasks.get(key),
      phaseOf: (key) => this.panePhases.get(key),
      setPhase: (key, phase) => {
        this.panePhases.set(key, phase)
      },
      isClosingPane: (pane) => this.activeCloses.has(this.closeKey(pane)),
    })
    this.paneHandoff = new PaneHandoff({
      transport: this.transport,
      redact: deps.redact,
      notify: host.notify,
      askConversationId: host.askConversationId,
      paneEnvOf: (key) => this.paneEnvs.get(key),
      applyPaneSecrets: (baseline, parentConversationId, cwd, target, secretNames) =>
        this.applyPaneSecrets(baseline, parentConversationId, cwd, target, secretNames),
      promptAndWait: (target, pane, text, signal) => this.promptAndWait(target, pane, text, signal),
      waitUntilSettled: (request, pane, initial) => this.waitUntilSettled(request, pane, initial),
      project: (pane, token) => this.project(pane, token),
      markFailed: (pane, note) => this.markFailed(pane, note),
      runLocalGate: deps.runLocalGate,
    })
    this.resumeCoordinator = new ResumeCoordinator({
      registry: this.registry,
      profiles: deps.profiles,
      redact: deps.redact,
      agentGet: (target, paneId, signal) => this.agentGet(target, paneId, signal),
      assertAttachmentsReachable: (request, target, routing) => this.assertAttachmentsReachable(request, target, routing),
      executionInfoOf: (pane) => this.executionInfoOf(pane),
      hasPaneEnv: (key) => this.paneEnvs.has(key),
      setPaneEnv: (key, env) => {
        this.paneEnvs.set(key, env)
      },
      buildPaneBaselineEnv: (parentConversationId, cwd, routing, target) =>
        this.buildPaneBaselineEnv(parentConversationId, cwd, routing, target),
      preloadAttachmentMeta: (request) => this.preloadAttachmentMeta(request),
      runManagedTask: (request, pane) => this.runManagedTask(request, pane),
    })
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
   *   （remote_hub_unreachable_for_artifacts，零远端副作用）；
   * - gateTimeoutMs：仅对已识别为 Herdr 处理路径（herdr 运行时新建 / 已登记
   *   resume）显式拒绝；原生 passthrough 不受影响。
   */
  async handle(request: AgentSpawnRequest): Promise<HandleOutcome> {
    if (request.resume !== undefined) {
      const candidates = this.registry.findByResumeRef(request.resume)
      if (candidates.length === 0) {
        // 非本插件记录：原生 resume（conversationId）交还内核——原生
        // passthrough 不受 Herdr 的 gateTimeoutMs 限制影响；显式 herdr
        // 运行时的 resume 绝不静默新建续接窗格。
        const routing = await resolveSpawnRouting(request.agentType, this.deps.profiles)
        if (routing === undefined) return { action: 'continue' }
        this.assertNoGateTimeout(request)
        throw new HelmError(
          'not_found',
          `resume ref '${request.resume}' 不存在（非本插件登记的 herdr agentId/paneId）`,
          404,
          { resumeRef: request.resume },
        )
      }
      // 已登记的 Herdr 窗格续接：先识别为受管 resume 再拒绝 gateTimeoutMs。
      this.assertNoGateTimeout(request)
      const outcome = await this.resumeInto(request, candidates)
      return { action: 'handled', result: outcome }
    }
    const routing = await resolveSpawnRouting(request.agentType, this.deps.profiles)
    if (routing === undefined) return { action: 'continue' }
    this.assertNoGateTimeout(request)
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
   * Herdr 运行时的 gateTimeoutMs 显式拒绝（仅在请求已识别为 Herdr 处理路径
   * 后调用：herdr 运行时新建 / 已登记 resume；原生 passthrough 不经此处，
   * 不受影响）。契约事实：本机依赖 runLocalGate 的 options 未暴露门禁超时
   * 参数、远端 transport.runGate 无超时通道——接受该选项等于静默丢弃外部
   * 超时语义，因此如实拒绝并给出替代方案（见 docs/workflows/worktree-
   * and-gate.md 的 Gate 章节）。
   */
  private assertNoGateTimeout(request: AgentSpawnRequest): void {
    if (request.gateTimeoutMs === undefined) return
    throw new HelmError(
      'unsupported_runtime',
      'Herdr 运行时不支持 gateTimeoutMs（本机依赖契约 runLocalGate 与远端 transport.runGate 均未暴露门禁超时参数，无法如实兑现超时语义）；请在 gate 命令内自行实现超时（如用 timeout 包装命令），或移除该选项',
      400,
      { gateTimeoutMs: request.gateTimeoutMs },
    )
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
    const env = this.buildPaneEnv(request.parentConversationId, cwd, routing, target, request.secretNames)
    const window = await this.createWindow(target, routing, request, cwd, env, agentName)
    // 编排命名空间业务值在边界校验（内核 envelope 只保证 JSON-safe）。
    const spawnRunId = parseWorkflowSpawnMeta(request.meta).runId
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
      ...(spawnRunId !== undefined ? { workflowRunId: spawnRunId } : {}),
      outcome: 'running',
      outputFileName,
      createdAt: Date.now(),
    }
    this.registry.add(managed)
    const key = this.paneKey(managed)
    this.paneEnvs.set(key, this.buildPaneBaselineEnv(request.parentConversationId, window.effectiveCwd, routing, window.target))
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
    const worktreeEnv = this.buildPaneEnv(request.parentConversationId, effectiveCwd, routing, target, request.secretNames)
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
   * - 新建 PTY 的 shell 可能尚未就绪；仅对服务端明确未启动的
   *   agent_pane_busy 在启动预算内等待再试，不重试任何不确定投递；
   * - agent_not_ready 且权威 blocked：桥接已有 agent，不启动第二个。
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
    const shellDeadline = Date.now() + this.host.startupTimeoutMs()
    let started: HerdrAgentInfo
    for (;;) {
      signal?.throwIfAborted()
      try {
        started = parseAgentResult(
          await this.transport.call(target, 'agent.start', params, { signal }),
          'agent.start',
          'agent_started',
        )
        break
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'agent_pane_busy') {
          const remaining = shellDeadline - Date.now()
          if (remaining <= 0) {
            throw new HelmError('herdr_startup_timeout', `pane ${paneId} 的 shell 未在启动期限内就绪（agent_pane_busy）`, 504)
          }
          await delay(Math.min(this.pollIntervalMs, remaining), undefined, { signal })
          continue
        }
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
   * 窗格环境基线：buildSpawnEnv（受管 HELM_*，确切目标节点，**零 stash 机密**）
   * + buildSpawnPaneEnv（Profile 合并、远端回连语义）。建窗、Gate 与续接共用；
   * 受管 HELM_* 由内核构造权威（Profile 不可覆盖）；远端剥本机回连变量
   * （Profile 显式有效可达 HELM_HUB_URL 或节点通道 hubUrl 除外）。
   * buildSpawnEnv 第三参始终传确切 nodeId（'local' 或远端 ID）——绝不让内核
   * 按父会话继承（父会话绑定远端时会把本机窗格误配到远端）。
   */
  private buildPaneBaselineEnv(
    parentConversationId: number,
    cwd: string,
    routing: SpawnRouting,
    target: HerdrTarget,
  ): Record<string, string> {
    const nodeId = targetNodeId(target) ?? 'local'
    const base = this.deps.buildSpawnEnv(this.host.askConversationId(parentConversationId), cwd, nodeId)
    const { env, stripped } = buildSpawnPaneEnv(base, routing.profileEnv, {
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
    return env
  }

  /**
   * 建窗时刻的完整窗格 env：基线 + 按当次 secretNames 授予的机密（从当前
   * stash 现取；缺失在内核边界显式报错，绝不静默降级为空注入）。已建窗的
   * 外部 CLI 进程 env 无法撤回（如实边界）；后续 Gate 不复用此刻机密值，
   * 每次从基线重新授权。
   */
  private buildPaneEnv(
    parentConversationId: number,
    cwd: string,
    routing: SpawnRouting,
    target: HerdrTarget,
    secretNames?: string[],
  ): Record<string, string> {
    const baseline = this.buildPaneBaselineEnv(parentConversationId, cwd, routing, target)
    if (secretNames === undefined || secretNames.length === 0) return baseline
    return this.applyPaneSecrets(baseline, parentConversationId, cwd, target, secretNames)
  }

  /**
   * 从当前 stash 重新授权取值叠加到基线：每次实际使用（建窗/Gate/续接）前现取，
   * 不经任何缓存；缺失/过期/已结算名字在内核边界显式 404。受管 HELM_* 基线
   * 权威：授予名不得劫持回连/身份变量（与内核 buildManagedEnv 固定覆盖同构）。
   */
  private applyPaneSecrets(
    baseline: Record<string, string>,
    parentConversationId: number,
    cwd: string,
    target: HerdrTarget,
    secretNames: string[],
  ): Record<string, string> {
    if (secretNames.length === 0) return { ...baseline }
    const nodeId = targetNodeId(target) ?? 'local'
    const granted = this.deps.buildSpawnEnv(this.host.askConversationId(parentConversationId), cwd, nodeId, {
      secretNames,
    })
    const selected = Object.fromEntries(
      secretNames.filter((name) => Object.hasOwn(granted, name)).map((name) => [name, granted[name]!]),
    )
    return mergeGrantedEnvWithManagedLocks(baseline, selected)
  }

  private executionInfoOf(pane: ManagedPane): AgentExecutionInfo {
    return {
      nodeId: nodeIdOf(pane) ?? 'local',
      executionId: pane.paneId,
      effectiveCwd: pane.effectiveCwd,
      // 业务扩展经编排命名空间 meta 携带（内核 envelope 不解释）：控制引用供
      // 编排层（builtin:workflow.steer）动态委托本插件 steer 动作（零硬编码；
      // 不携带回调或策略）；worktree 供隔离层登记租约。
      meta: workflowExecutionMeta({
        controls: { steer: { pluginId: HERDR_STEER_CONTROLS.pluginId, actionId: HERDR_STEER_CONTROLS.actionId } },
        ...(pane.worktree !== undefined
          ? { worktree: { path: pane.worktree.path, branch: pane.worktree.branch ?? '' } }
          : {}),
      }),
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
      if (isTimeoutSignal(request.signal)) {
        rejectAbort(new HelmError('agent_timeout', `pane ${pane.paneId} 执行超时，保留窗格与诊断（resume 前将权威确认底层 CLI 状态）`, 408))
        return
      }
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
      if (isTimeoutSignal(request.signal)) {
        await this.markFailed(pane, error instanceof Error ? error.message : 'execution timed out')
        const snapshot = await this.paneHandoff.readDiagnostic(pane)
        throw new HelmError(
          'agent_timeout',
          `pane ${pane.paneId} 执行超时，窗格已保留（底层 CLI 可能仍在执行；resume 前将权威确认，仅 idle/done 可续接，绝不代发按键中止）\n终端最后 40 行（脱敏）：\n${snapshot}`,
          408,
          { paneId: pane.paneId, snapshot },
        )
      }
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
      const snapshot = await this.paneHandoff.readDiagnostic(pane)
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
      this.steerDispatcher.forget(taskKey)
      this.releaseAttachmentMeta(request)
    }
  }

  private async driveTask(request: AgentSpawnRequest, pane: ManagedPane): Promise<unknown> {
    const key = this.paneKey(pane)
    this.panePhases.set(key, 'task')
    await this.project(pane, `run:${pane.agentName}`)
    const info = await this.promptAndWait(pane.target, pane, this.taskPrompt(request, pane), request.signal)
    await this.steerDispatcher.settleThroughSteers(request, pane, pane.outputFileName!, info)
    // 结算以 registry 现值为准：插话可能已把唯一交接文件重定向到新名字
    //（绝不沿用起始快照误读旧路径）。
    const latest = this.registry.get(nodeIdOf(pane), pane.paneId)
    if (latest?.outputFileName === undefined) {
      throw new HelmError('herdr_context_unavailable', `pane ${pane.paneId} 的交接上下文已失效`, 409)
    }
    const output = await this.paneHandoff.readAndValidateOutput(request, latest)
    if (request.gate !== undefined) {
      this.panePhases.set(key, 'gate')
      await this.paneHandoff.runGateFor(request, pane)
    }
    request.signal?.throwIfAborted()
    // 成功交接后清理已被插话作废的旧结果文件（失败路径保留现场）。
    await this.steerDispatcher.clearRetiredOutputs(request, pane)
    this.registry.update(nodeIdOf(pane), pane.paneId, { outcome: 'keepalive', outputFileName: undefined })
    return output
  }

  /** 已结算的 blocked 水位先做短暂退避防抖；若发键后连续退避仍停留在同一 blocked seq，重开审批让人类重选。 */
  private static readonly MAX_SETTLED_BLOCKED_BACKOFFS = 2

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
    return paneStateKey(pane)
  }

  /** closePane 单飞键（与 closePane 内部完全同构：steer 门禁复用同一坐标）。 */
  private closeKey(pane: ManagedPane): string {
    return paneCloseKey(pane)
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
      const { outcome, plan } = await this.approvalBridge.createAsk(request, pane, entry, this.host.askConversationId(request.parentConversationId))
      return this.approvalBridge.consumeAskOutcome(request, pane, entry, outcome, plan)
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

  // ------------------------------------------------------------------
  // 运行中插话（steer）：仅 task 阶段 + agent.get 预检 + 现有 agent.prompt
  // （投递、门禁、结算排空与作废文件清理见 executor-steer.ts）
  // ------------------------------------------------------------------

  /** 受管窗格运行中插话（公共入口；门禁与单次投递语义见 SteerDispatcher.steerPane）。 */
  async steerPane(pane: ManagedPane, input: SteerPaneInput): Promise<{ stateChangeSeq: number }> {
    return this.steerDispatcher.steerPane(pane, input)
  }

  // ------------------------------------------------------------------
  // resume（权威确认与路由恢复实现见 executor-resume.ts）
  // ------------------------------------------------------------------

  private async resumeInto(request: AgentSpawnRequest, candidates: ManagedPane[]): Promise<unknown> {
    return this.resumeCoordinator.resumeInto(request, candidates)
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
      this.steerDispatcher.forget(this.paneKey(pane))
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
   * 资源对齐：registry 置 settled 后 closePane 会因幂等早退，环境基线 paneEnvs
   * （含受管 HELM_TOKEN，不含 stash 机密）与未启动标记必须在此显式释放，生命周期
   * 与 registry outcome 对齐，绝不随人类关窗逐个驻留到停用重建。在途 steer 的
   * 阶段/任务登记同步作废（其尾读复核将确定性拒绝）。
   */
  releasePaneState(pane: ManagedPane): void {
    const key = this.paneKey(pane)
    this.paneEnvs.delete(key)
    this.unstartedPanes.delete(key)
    this.panePhases.delete(key)
    this.activeTasks.delete(key)
    this.steerDispatcher.forget(key)
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

function isTimeoutSignal(signal: AbortSignal | undefined): boolean {
  const reason = signal?.reason
  return reason instanceof Error && reason.name === 'TimeoutError'
}

function signalOf(request: AgentSpawnRequest): AbortSignal {
  return request.signal ?? new AbortController().signal
}

export type { PaneRouting }
