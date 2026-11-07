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

import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, type AgentExecutionInfo, type AgentSpawnRequest } from '@helm/protocol'
import type { CreateAskResultLike, CreateAskSpecLike, HerdrPluginDependencies, HerdrTarget } from './contracts.js'
import { validateOrThrow } from '../../plugins/schema.js'
import { AskCoordinator, backoffForDuplicateBlocked, type AskEntry } from './asks.js'
import { MetadataProjector } from './metadata.js'
import { PaneRegistry, machineOf, targetOf, type ManagedPane, type PaneRouting } from './panes.js'
import {
  assertOkResult,
  parseAgentResult,
  parsePaneRead,
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
  redactPromptText,
  redactSchemaText,
  resolveCwd,
  resolveSpawnRouting,
  type SpawnRouting,
} from './spawn-rules.js'

export interface ExecutorHost {
  /** 父会话 cwd 解析（宿主 getConversation 桥；错误如实上抛）。 */
  parentCwdOf(parentConversationId: number): string | undefined
  /** AskDoc 目标会话（缺省父会话）。 */
  askConversationId(parentConversationId: number): number
  /** 非机密通知。 */
  notify(title: string, body: string, level: 'info' | 'error'): void
  /** agent.start 启动超时（config.startupTimeoutMs；3001..300000）。 */
  startupTimeoutMs(): number
  /** 宿主 createAsk（预分配 id；ask.id 形如 herdr:<machine>:<pane>:<seq>）。 */
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

export class HerdrExecutor {
  /** pane scopeKey -> 进行中的 closePane promise（abort 双路径单飞）。 */
  private readonly activeCloses = new Map<string, Promise<void>>()

  /** env 只留在内存；Gate 与续接复用建窗时的实际环境，绝不持久化机密。 */
  private readonly paneEnvs = new Map<string, Record<string, string>>()
  private readonly blockedTasks = new Map<string, Promise<boolean>>()
  private readonly unstartedPanes = new Set<string>()
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
  ) {
    this.localTarget = localTarget
  }

  /**
   * agent_spawn 拦截主流程。
   * - resume：先按自有记录识别（agentId/paneId 双键），不依赖 request.agentType
   *   （真实 standalone resume 无 agentId、workflow resume 无 agentType）；
   * - 新建：resolveSpawnRouting 双入口解析，非 Herdr 目标放行。
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
    const result = await this.spawnNew(request, routing)
    return { action: 'handled', result }
  }

  // ------------------------------------------------------------------
  // 建窗与启动
  // ------------------------------------------------------------------

  private async spawnNew(request: AgentSpawnRequest, routing: SpawnRouting, existing?: ManagedPane): Promise<unknown> {
    if (existing === undefined) {
      // 新窗格：cwd 解析链 request.cwd > profile.workspace > 父 cwd > default。
      const parentCwd = this.parentCwdOrThrow(request.parentConversationId)
      const cwd = resolveCwd(request.cwd, routing, parentCwd) || this.deps.defaultCwd
      existing = await this.createManagedPane(request, routing, this.localTargetOf(), cwd)
    }
    const pane = existing
    this.registry.update(machineOf(pane), pane.paneId, {
      routing: { kind: routing.kind, ...(routing.profileId !== undefined ? { profileId: routing.profileId } : {}) },
    })
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

  /** 建窗并登记（含 worktree 两步 + 中途失败回收已创建资源）。 */
  private async createManagedPane(
    request: AgentSpawnRequest,
    routing: SpawnRouting,
    localTarget: HerdrTarget,
    cwd: string,
  ): Promise<ManagedPane> {
    const unique = `${Date.now()}-${HashShort.of(request.prompt.slice(0, 160))}-${request.parentConversationId}-${Math.random().toString(36).slice(2, 6)}`
    const agentName = buildAgentName(HashShort.of(unique))
    const safeId = `${HashShort.of(unique)}${HashShort.of(request.prompt).slice(0, 4)}`
    const ext = request.schema !== undefined ? 'json' : 'md'
    const outputFileName = buildOutputFileName(safeId, ext)
    const env = this.buildPaneEnv(request.parentConversationId, cwd, routing, paneTargetOf(routing, localTarget))
    const window = await this.createWindow(paneTargetOf(routing, localTarget), routing, request, cwd, env, agentName)
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
      name: this.registry.get(machineOf({ target }), paneId)?.agentName ?? buildAgentName(HashShort.of(paneId)),
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
      await delay(100, undefined, { signal })
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
   * 窗格 env：buildSpawnEnv(managed/stash) + buildSpawnPaneEnv 合并。
   * 受管 HELM_* 由内核构造权威（Profile 不可覆盖）；远端剥本机回连变量
   * （Profile 显式有效可达 HELM_HUB_URL 除外）。
   */
  private buildPaneEnv(parentConversationId: number, cwd: string, routing: SpawnRouting, target: HerdrTarget): Record<string, string> {
    const base = this.deps.buildSpawnEnv(this.host.askConversationId(parentConversationId), cwd)
    const { env, stripped, hubUrlOverridden } = buildSpawnPaneEnv(base, routing.profileEnv, {
      remote: target.machine !== undefined,
    })
    if (stripped.length > 0) {
      this.host.notify(
        '远端窗格已剥除本机回连变量',
        `machine ${target.machine} 未配置远端可达 HELM_HUB_URL，已剥除：${stripped.join(', ')}`,
        'info',
      )
    }
    void hubUrlOverridden
    return env
  }

  private executionInfoOf(pane: ManagedPane): AgentExecutionInfo {
    return {
      executionId: pane.paneId,
      effectiveCwd: pane.effectiveCwd,
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
    return `${prompt}\n${handoff}`
  }

  /** 任务启动、首轮、自愈均在同一取消与错误收尾边界内。 */
  private async runManagedTask(request: AgentSpawnRequest, pane: ManagedPane, start?: SpawnRouting): Promise<unknown> {
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
        await cleanup
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
    }
  }

  private async driveTask(request: AgentSpawnRequest, pane: ManagedPane): Promise<unknown> {
    await this.project(pane, `run:${pane.agentName}`)
    const info = await this.promptAndWait(pane.target, pane, this.taskPrompt(request, pane), request.signal)
    await this.waitUntilSettled(request, pane, info)
    const output = await this.readAndValidateOutput(request, pane)
    if (request.gate !== undefined) await this.runGateFor(request, pane)
    request.signal?.throwIfAborted()
    this.registry.update(machineOf(pane), pane.paneId, { outcome: 'keepalive', outputFileName: undefined })
    return output
  }

  /** 已结算的 blocked 水位只退避；新水位交给同一审批桥。 */
  private async waitUntilSettled(request: AgentSpawnRequest, pane: ManagedPane, initial: HerdrAgentInfo): Promise<void> {
    let info = initial
    let attempts = 0
    while (info.agentStatus !== 'idle' && info.agentStatus !== 'done') {
      request.signal?.throwIfAborted()
      if (info.agentStatus === 'blocked') {
        const entry = this.asks.get(machineOf(pane), pane.paneId, info.stateChangeSeq)
        if (entry?.phase === 'settled') {
          await backoffForDuplicateBlocked(signalOf(request), ++attempts)
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
   * -> 回答后复核 seq -> 一次性 send_keys。返回 false 表示人类取消。
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
      machine: machineOf(pane),
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })) {
      await this.cancelAskQuietly(superseded.askId, 'superseded')
    }
    if (authority.agentStatus !== 'blocked') return true // 终端已自行处理（旧快照）。

    const begin = this.asks.beginBlocked(machineOf(pane), pane.paneId, authority.stateChangeSeq)
    const entry: AskEntry =
      'owner' in begin
        ? begin.owner
        : this.asks.get(machineOf(pane), pane.paneId, authority.stateChangeSeq)!
    if (entry === undefined) return true
    if (entry.phase === 'settled') return true
    const existing = this.blockedTasks.get(entry.askId)
    if (existing !== undefined) return existing
    const task = Promise.resolve().then(async () => {
      await this.project(pane, `ask:${entry.askId}`)
      const result = await this.createAsk(request, pane, entry, this.host.askConversationId(request.parentConversationId))
      return this.consumeAskOutcome(request, pane, entry, result)
    }).catch((error: unknown) => {
      this.asks.failCreate(entry)
      throw error
    }).finally(() => this.blockedTasks.delete(entry.askId))
    this.blockedTasks.set(entry.askId, task)
    return task
  }

  /**
   * createAsk（预分配 id，条目已先登记）：
   * - 创建前权威复核：seq 已推进/已非 blocked -> 无需再问（synthetic superseded）；
   * - 宿主返回 cancelled 且条目已被销（404 竞态确认）-> 同样 synthetic superseded
   *   回主循环，绝不留 pending。
   */
  private async createAsk(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    entry: AskEntry,
    conversationId: number,
  ): Promise<CreateAskResultLike> {
    const authority = await this.agentGet(targetOf(pane), pane.paneId, request.signal)
    for (const superseded of this.asks.observeAuthority({
      paneId: pane.paneId,
      machine: machineOf(pane),
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })) {
      await this.cancelAskQuietly(superseded.askId, 'superseded')
    }
    if (authority.stateChangeSeq !== entry.seq || authority.agentStatus !== 'blocked') {
      this.asks.settle(entry, { keysSent: false })
      return { id: entry.askId, status: 'superseded', answers: {} }
    }
    const snapshot = await this.readDiagnostic(pane)
    const pending = this.host.createAsk({
      id: entry.askId,
      conversationId,
      ownerPluginId: 'builtin:herdr',
      title: `Herdr 审批：pane ${pane.paneId}`,
      description: `终端 agent (${pane.agentName}) 在 ${pane.effectiveCwd} 等待选择。终端快照（脱敏）：\n${snapshot.slice(0, 1500)}`,
      fields: [
        {
          name: 'decision',
          label: '如何处理该阻塞？',
          type: 'select',
          required: true,
          options: [
            { label: '允许一次（发送 y）', value: 'allow-y' },
            { label: '拒绝（发送 n）', value: 'deny-n' },
            { label: '自定义按键（在 key 字段填写）', value: 'custom' },
          ],
        },
        {
          name: 'key',
          label: '自定义 logical key（仅 decision=custom 时使用，如 enter / esc / 1）',
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
      while (!monitor.signal.aborted) {
        try { await delay(100, undefined, { signal: monitor.signal }) }
        catch (error) { if (monitor.signal.aborted) return; throw error }
        if (request.signal?.aborted) {
          await this.cancelAskQuietly(entry.askId, 'cancelled')
          continue
        }
        const current = await this.agentGet(targetOf(pane), pane.paneId, monitor.signal)
        if (current.stateChangeSeq !== entry.seq || current.agentStatus !== 'blocked') {
          this.asks.observeAuthority({ machine: machineOf(pane), paneId: pane.paneId, seq: current.stateChangeSeq, status: current.agentStatus })
          await this.cancelAskQuietly(entry.askId, 'superseded')
        }
      }
    })()
    try {
      return await Promise.race([result, polling.then(() => result)])
    } finally {
      monitor.abort()
      await polling.catch((error: unknown) => {
        if ((error as { code?: string }).code !== 'herdr_aborted') throw error
      })
    }
  }

  /** 消费终态：answered 且权威 seq 未推进 -> 复核 -> 一次性 send_keys；cancelled -> false。 */
  private async consumeAskOutcome(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    entry: AskEntry,
    outcome: CreateAskResultLike,
  ): Promise<boolean> {
    if (outcome.status !== 'answered') {
      this.asks.settle(entry, { keysSent: false })
      if (outcome.status === 'superseded') return true
      return false
    }
    const decision = outcome.answers['decision'] ?? ''
    let keys: string[]
    if (decision === 'allow-y') keys = ['y']
    else if (decision === 'deny-n') keys = ['n']
    else if (decision === 'custom') {
      const custom = (outcome.answers['key'] ?? '').trim()
      if (custom === '') {
        this.asks.settle(entry, { keysSent: false })
        return false
      }
      keys = [custom]
    } else {
      this.asks.settle(entry, { keysSent: false })
      return false
    }
    const authority = await this.agentGet(targetOf(pane), pane.paneId, request.signal)
    for (const superseded of this.asks.observeAuthority({
      paneId: pane.paneId,
      machine: machineOf(pane),
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })) {
      await this.cancelAskQuietly(superseded.askId, 'superseded')
    }
    if (authority.stateChangeSeq !== entry.seq || authority.agentStatus !== 'blocked') {
      this.asks.settle(entry, { keysSent: false })
      return true
    }
    await assertOkResult(
      await this.transport.call(
        targetOf(pane),
        'agent.send_keys',
        { target: pane.paneId, keys },
        { signal: request.signal },
      ),
      'agent.send_keys',
    )
    this.asks.settle(entry, { keysSent: true })
    this.host.notify('Herdr 审批已发送', `pane ${pane.paneId} 已按人类选择发送按键：${keys.join(' ')}`, 'info')
    return true
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

    let attempt = await readOnce()
    if (!attempt.ok) {
      this.host.notify('Herdr 交接自愈', `pane ${pane.paneId} 首次交接失败（${attempt.reason}），追问一次`, 'info')
      await this.project(pane, `heal:${pane.agentName}`)
      // 自愈追问本身也可能 blocked：同一审批桥等待真实进展后再读文件，
      // 不能读缺文件就判失败。
      await this.promptAndWaitHeal(request, pane, attempt.reason)
      attempt = await readOnce()
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
      machineOf(pane) === undefined
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
   * settled/未知/歧义；显式 kind/machine/cwd 不一致显式拒绝（不静默忽略）。
   * 返回 undefined 表示该 ref 非本插件记录（交还内核原生 resume）。
   */
  private async resumeInto(request: AgentSpawnRequest, candidates: ManagedPane[]): Promise<unknown> {
    const resumeRef = request.resume!
    if (candidates.length > 1) {
      throw new HelmError(
        'resume_ambiguous',
        `resume ref '${resumeRef}' 命中 ${candidates.length} 个窗格（跨机器 paneId 撞号），请用稳定 agentId 消歧`,
        409,
        { resumeRef, panes: candidates.map((p) => `${machineOf(p) ?? 'local'}:${p.paneId}`) },
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
    await this.resolveResumeRouting(request, pane)
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
    const updated = this.registry.update(machineOf(pane), pane.paneId, {
      outcome: 'running',
      outputFileName: buildOutputFileName(safeId, ext),
      agentId: request.agentId ?? pane.agentId,
      ...(request.workflowRunId !== undefined ? { workflowRunId: request.workflowRunId } : {}),
    })!
    request.onResolved?.(this.executionInfoOf(updated))
    // request.cwd 缺省代表沿用窗格实际 cwd（不重开窗、不重建 env tab）。
    // 续接不重跑 agent.start（窗格已有 agent）；直接进入投递-审批-交接循环。
    return this.runManagedTask(request, updated)
  }

  /** resume 路由解析：显式 agentType 校验 kind 一致；缺省沿用 pane.routing。 */
  private async resolveResumeRouting(request: AgentSpawnRequest, pane: ManagedPane): Promise<SpawnRouting> {
    if (request.agentType === undefined || request.agentType === '') {
      const routing = pane.routing
      return {
        kind: routing.kind,
        ...(pane.routing.profileId !== undefined ? { profileId: pane.routing.profileId } : {}),
        args: [],
        profileEnv: {},
        ...(machineOf(pane) !== undefined ? { machine: machineOf(pane) } : {}),
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
    if (routing.machine !== machineOf(pane)) {
      throw new HelmError(
        'resume_machine_conflict',
        `resume 显式 machine '${routing.machine}' 与窗格目标机 '${machineOf(pane)}' 不一致，拒绝跨机续接`,
        409,
        { resume: request.resume, requestMachine: routing.machine, paneMachine: machineOf(pane) },
      )
    }
    // 沿用窗格冻结目标（routing.machine 仅作一致性校验，不热换连接）。
    return routing
  }

  // ------------------------------------------------------------------
  // 清理与状态
  // ------------------------------------------------------------------

  /**
   * 关闭自有 pane（单飞 + settled 幂等）：
   * - 已 settled / 正在关闭：直接返回（abort 与 settle 双路径并发安全）；
   * - 仅关自有资源：普通 tab.close；worktree workspace.close（close_group 防链组）；
   * - 失败 pane 保留现场；清理失败如实通知并上抛（不空 catch）。
   */
  async closePane(
    pane: ManagedPane,
    reason: 'settled' | 'cancelled' | 'workflow-settled' | 'turn-settled',
    options: { volatileMark?: boolean } = {},
  ): Promise<void> {
    if (pane.outcome === 'failed') return
    const key = `${machineOf(pane) ?? 'local'}:${pane.paneId}`
    const existing = this.activeCloses.get(key)
    if (existing !== undefined) return existing
    const current = this.registry.get(machineOf(pane), pane.paneId)
    if (current !== undefined && current.outcome === 'settled') return
    const closing = (async () => {
      const target = targetOf(pane)
      try {
        let owned = false
        try {
          const authority = await this.agentGet(target, pane.paneId)
          owned = authority.name === pane.agentName
          if (authority.name === undefined && this.unstartedPanes.has(this.paneKey(pane))) owned = true
        } catch (error) {
          if ((error as { code?: string }).code !== 'agent_not_found') throw error
          owned = this.unstartedPanes.has(this.paneKey(pane))
        }
        for (const entry of this.asks.paneClosed(pane.paneId, machineOf(pane))) {
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
        this.registry.markSettledVolatile(machineOf(pane), pane.paneId)
      } else {
        this.registry.update(machineOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
      }
      this.projector.forget(pane.paneId, machineOf(pane))
      this.paneEnvs.delete(this.paneKey(pane))
      this.unstartedPanes.delete(this.paneKey(pane))
      for (const removed of this.asks.paneClosed(pane.paneId, machineOf(pane))) {
        if (removed.phase === 'pending' || removed.phase === 'creating') {
          await this.cancelAskQuietly(removed.askId, 'superseded')
        }
      }
    })().finally(() => this.activeCloses.delete(key))
    this.activeCloses.set(key, closing)
    return closing
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
    this.registry.update(machineOf(pane), pane.paneId, {
      outcome: 'failed',
      failureNote: this.deps.redact(note).slice(0, 500),
      settledAt: Date.now(),
    })
    this.projector.forget(pane.paneId, machineOf(pane))
    for (const removed of this.asks.paneClosed(pane.paneId, machineOf(pane)) ?? []) {
      if (removed.phase === 'pending' || removed.phase === 'creating') {
        await this.cancelAskQuietly(removed.askId, 'superseded')
      }
    }
  }

  private async project(pane: ManagedPane, token: string): Promise<void> {
    await this.projector.project(machineOf(pane), pane.paneId, token)
  }
}

function signalOf(request: AgentSpawnRequest): AbortSignal {
  return request.signal ?? new AbortController().signal
}

function paneTargetOf(routing: SpawnRouting, localTarget: HerdrTarget): HerdrTarget {
  return routing.machine === undefined ? localTarget : { machine: routing.machine }
}

export type { PaneRouting }
