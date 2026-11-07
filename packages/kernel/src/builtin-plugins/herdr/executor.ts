/**
 * Herdr 执行行：两步建窗 -> agent.start -> prompt --wait -> blocked 审批桥 ->
 * 文件交接（含一次自愈）-> gate -> 双轨保活清理。
 *
 * 诚实性纪律（不静默降级）：
 * - 文件缺失/坏 JSON/schema 不合格仅在自愈一次后显式 herdr_output_contract_violation
 *   （附 agent.read recent_unwrapped 40 行脱敏快照），绝不截终端脏文本冒充结果；
 * - transport IO/SSH/权限错误如实抛诊断（herdr_output_missing 404 是唯一可自愈
 *   边界码），绝不把其它错误当缺文件重投任务；
 * - agent_not_ready 且 agent.get 证实 blocked：窗格已有 agent 等待交互，桥接
 *   审批后续等，不启动第二个 agent。
 */

import { HelmError, type AgentExecutionInfo, type AgentSpawnRequest } from '@helm/protocol'
import type { HerdrPluginDependencies, HerdrTarget } from './contracts.js'
import { validateOrThrow } from '../../plugins/schema.js'
import { AskCoordinator, backoffForDuplicateBlocked, type AskEntry } from './asks.js'
import { MetadataProjector } from './metadata.js'
import { PaneRegistry, type ManagedPane } from './panes.js'
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
  buildRemoteSpawnEnv,
  HashShort,
  resolveCwd,
  resolveSpawnRouting,
  type SpawnRouting,
} from './spawn-rules.js'

export interface ExecutorHost {
  /** 父会话 cwd 解析（宿主 getConversation 桥）。 */
  parentCwdOf(parentConversationId: number): string | undefined
  /** AskDoc 目标会话（缺省父会话）。 */
  askConversationId(parentConversationId: number): number
  /** 非机密通知（自愈过程、事件路径失败等）。 */
  notify(title: string, body: string, level: 'info' | 'error'): void
  /** agent.start 启动超时（config.startupTimeoutMs；3001..300000）。 */
  startupTimeoutMs(): number
  /** ctx.host.cancelAsk 桥（404 等竞态静默，其余显式通知）。 */
  cancelAskQuietly(askId: string): Promise<void>
  /** ctx.host.createAsk 桥（AskService 终态语义）。 */
  createAsk(spec: {
    id: string
    conversationId: number
    ownerPluginId: string
    title: string
    description?: string
    fields: Array<{
      name: string
      label: string
      type: 'text' | 'select' | 'confirm'
      options?: Array<{ label: string; value: string }>
      required?: boolean
    }>
    expectedStateSeq?: number
  }): Promise<AskOutcome>
}

interface WindowPane {
  paneId: string
  tabId: string
  /** 仅 worktree 模式（专属 workspace）；普通 tab 模式缺省（只关 tab）。 */
  workspaceId?: string
  effectiveCwd: string
  worktree?: { path: string; branch?: string }
}

export class HerdrExecutor {
  constructor(
    private readonly deps: HerdrPluginDependencies,
    private readonly registry: PaneRegistry,
    private readonly asks: AskCoordinator,
    private readonly projector: MetadataProjector,
    private readonly host: ExecutorHost,
  ) {}

  private get transport(): NonNullable<HerdrPluginDependencies['transport']> {
    if (this.deps.transport === undefined) {
      throw new HelmError('herdr_unavailable', 'Herdr 传输层未注入（插件停用或宿主未连接）', 503)
    }
    return this.deps.transport
  }

  /**
   * agent_spawn 拦截主流程。返回 true 表示已接管（handled）；false 表示
   * 非 Herdr 目标（放行内核默认执行行）。Profile 错误不吞（resolveSpawnRouting
   * 内显式抛）；非 Herdr Profile 原样放行。
   */
  async handle(request: AgentSpawnRequest): Promise<boolean> {
    const routing = await resolveSpawnRouting(request.agentType, this.deps.profiles)
    if (routing === undefined) return false
    assertNoUnsupportedOverrides(request.model, request.effort)

    if (request.signal?.aborted) {
      throw new HelmError('aborted', 'herdr spawn 请求在创建前已取消', 409)
    }

    const parentCwd = this.host.parentCwdOf(request.parentConversationId)
    const cwd = resolveCwd(request.cwd, routing, parentCwd) || this.deps.defaultCwd
    if (request.resume !== undefined) return this.resumeInto(request, routing, cwd)
    return this.spawnNew(request, routing, cwd)
  }

  // ------------------------------------------------------------------
  // 建窗与启动
  // ------------------------------------------------------------------

  private async spawnNew(request: AgentSpawnRequest, routing: SpawnRouting, cwd: string): Promise<true> {
    const unique = `${Date.now()}-${HashShort.of(request.prompt.slice(0, 160))}-${request.parentConversationId}-${Math.random().toString(36).slice(2, 6)}`
    const agentName = buildAgentName(HashShort.of(unique))
    const safeId = `${HashShort.of(unique)}${HashShort.of(request.prompt).slice(0, 4)}`
    const ext = request.schema !== undefined ? 'json' : 'md'
    const outputFileName = buildOutputFileName(safeId, ext)
    const env = this.buildEnv(request.parentConversationId, cwd, routing)

    const pane = await this.createWindow(routing, request.isolation, cwd, env, agentName)
    const managed: ManagedPane = {
      machine: routing.machine,
      paneId: pane.paneId,
      tabId: pane.tabId,
      workspaceId: pane.workspaceId,
      ...(pane.worktree !== undefined ? { worktree: pane.worktree } : {}),
      effectiveCwd: pane.effectiveCwd,
      agentName,
      parentConversationId: request.parentConversationId,
      ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
      ...(request.workflowRunId !== undefined ? { workflowRunId: request.workflowRunId } : {}),
      outcome: 'running',
      outputFileName,
      createdAt: Date.now(),
    }
    this.registry.add(managed)
    request.onResolved?.(this.executionInfoOf(managed))

    await this.startAgent(routing, pane.paneId, agentName)
    const output = await this.driveTask(request, routing, managed)
    ;(request as { __herdrResult?: unknown }).__herdrResult = output
    return true
  }

  /** 建窗：普通 tab.create({cwd,env,focus:false,label})；worktree 模式两步注入 env。 */
  private async createWindow(
    routing: SpawnRouting,
    isolation: 'worktree' | undefined,
    cwd: string,
    env: Record<string, string>,
    label: string,
  ): Promise<WindowPane> {
    const target: HerdrTarget = routing.machine === undefined ? {} : { machine: routing.machine }
    const transport = this.transport
    if (isolation !== 'worktree') {
      const created = parseTabCreated(
        await transport.call(target, 'tab.create', { cwd, env, focus: false, label }),
      )
      return {
        paneId: created.rootPane.paneId,
        tabId: created.tab.tabId,
        // 普通模式：workspaceId 缺省（共享默认 workspace 绝不整体关闭，仅关 tab）。
        workspaceId: undefined,
        effectiveCwd: cwd,
      }
    }
    const branch = `helm/wf-${HashShort.of(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)}`
    const created = parseWorktreeCreated(
      await transport.call(target, 'worktree.create', {
        cwd,
        branch,
        focus: false,
        trust_repository: true,
      }),
    )
    const effectiveCwd = created.worktree.path
    if (Object.keys(env).length === 0) {
      return {
        paneId: created.rootPane.paneId,
        tabId: created.tabId,
        workspaceId: created.workspaceId,
        effectiveCwd,
        worktree: created.worktree,
      }
    }
    // worktree.create 不接受 env：在该 workspace 下补建带 env 的 tab，关初始空 tab。
    const tabbed = parseTabCreated(
      await transport.call(target, 'tab.create', {
        workspace_id: created.workspaceId,
        cwd: effectiveCwd,
        env,
        focus: false,
        label,
      }),
    )
    assertOkResult(await transport.call(target, 'tab.close', { tab_id: created.tabId }), 'tab.close')
    return {
      paneId: tabbed.rootPane.paneId,
      tabId: tabbed.tab.tabId,
      workspaceId: created.workspaceId,
      effectiveCwd,
      worktree: created.worktree,
    }
  }

  /** agent.start；agent_not_ready 且权威状态 blocked 时桥接既有 agent。 */
  private async startAgent(routing: SpawnRouting, paneId: string, agentName: string): Promise<HerdrAgentInfo> {
    const target: HerdrTarget = routing.machine === undefined ? {} : { machine: routing.machine }
    const params: Record<string, unknown> = {
      name: agentName,
      kind: routing.kind,
      pane_id: paneId,
      timeout_ms: this.host.startupTimeoutMs(),
    }
    if (routing.args.length > 0) params['args'] = routing.args
    try {
      return parseAgentResult(await this.transport.call(target, 'agent.start', params), 'agent.start', 'agent_started')
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'agent_not_ready') throw error
      const info = parseAgentResult(
        await this.transport.call(target, 'agent.get', { target: paneId }),
        'agent.get',
        'agent_info',
      )
      if (info.agentStatus !== 'blocked') throw error
      this.host.notify(
        'Herdr 窗格已存在等待中的 Agent',
        `pane ${paneId} 返回 agent_not_ready 且权威状态 blocked，桥接既有 agent 继续审批流程，不启动第二个 agent`,
        'info',
      )
      return info
    }
  }

  /** 窗格 env：buildSpawnEnv（会话 stash + 受管变量）+ Profile 非机密 env；远端剥 loopback。 */
  private buildEnv(parentConversationId: number, cwd: string, routing: SpawnRouting): Record<string, string> {
    const base = this.deps.buildSpawnEnv(this.host.askConversationId(parentConversationId), cwd)
    if (routing.machine === undefined) return { ...base, ...routing.profileEnv }
    const { env, stripped } = buildRemoteSpawnEnv(base, routing.profileEnv)
    if (stripped.length > 0) {
      this.host.notify(
        '远端窗格已剥除本机回连变量',
        `machine ${routing.machine} 未配置远端可达 HELM_HUB_URL，已剥除：${stripped.join(', ')}`,
        'info',
      )
    }
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

  // ------------------------------------------------------------------
  // 任务投递、审批桥与文件交接
  // ------------------------------------------------------------------

  private taskPrompt(request: AgentSpawnRequest, pane: ManagedPane): string {
    const fileName = pane.outputFileName!
    const handoff =
      request.schema !== undefined
        ? [
            '',
            '--- helm 交接契约（必须遵守）---',
            `任务完成后，把最终结构化结果写入文件 ${pane.effectiveCwd}/.helm/${fileName}，`,
            '内容为满足下方 JSON Schema 的单个 JSON 值（不得包裹 Markdown 代码块外的任何文本）。',
            `JSON Schema: ${JSON.stringify(request.schema)}`,
            '写文件是你交付结果的唯一方式；未写文件视为任务失败。',
          ].join('\n')
        : [
            '',
            '--- helm 交接契约（必须遵守）---',
            `任务完成后，把最终结果（Markdown 全文）写入文件 ${pane.effectiveCwd}/.helm/${fileName}。`,
            '写文件是你交付结果的唯一方式；未写文件视为任务失败。',
          ].join('\n')
    return `${request.prompt}\n${handoff}`
  }

  private async driveTask(request: AgentSpawnRequest, routing: SpawnRouting, pane: ManagedPane): Promise<unknown> {
    const target: HerdrTarget = routing.machine === undefined ? {} : { machine: routing.machine }
    const transport = this.transport
    const signal = signalOf(request)
    const paneId = pane.paneId
    /** abort 即触发：销单关联 Ask（协调器条目）并尽力关闭自有 PTY。 */
    const abortCleanup = new Promise<never>((_, reject) => {
      const onAbort = () => {
        reject(new HelmError('aborted', `pane ${paneId} 执行被取消（request.signal abort）`, 499, { paneId }))
        void this.abortCleanup(pane)
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    const waitAbort = <T>(p: Promise<T>): Promise<T> => Promise.race([p, abortCleanup])

    // 元数据投射：任务开始 token。
    await this.project(pane, `run:${pane.agentName}`)

    // 首轮 prompt --wait until done/idle/blocked。
    let info = await waitAbort(this.promptAndWait(request, pane, this.taskPrompt(request, pane)))
    let duplicateBlockedAttempts = 0

    // blocked 审批桥循环。
    while (info.agentStatus === 'blocked') {
      const handled = await waitAbort(this.bridgeBlocked(request, routing, pane, info))
      if (!handled) {
        // 人类取消：关闭本插件自有 pane 并中止（不批准）。
        await this.closePaneQuietly(pane, 'cancelled')
        throw new HelmError('aborted', `人类取消了 pane ${paneId} 的审批（AskDoc cancelled）`, 409, { paneId })
      }
      // 答复后终端状态可能延迟推进：agent.wait 同 seq blocked 时退避等待真实进展。
      for (;;) {
        info = parseAgentResult(
          await waitAbort(
            transport.call(target, 'agent.wait', {
              target: paneId,
              until: ['done', 'idle', 'blocked'],
            }),
          ),
          'agent.wait',
          'agent_info',
        )
        if (info.agentStatus !== 'blocked') break
        const latestSeq = (await waitAbort(this.knownSeq(paneId, routing))) ?? 0
        if (info.stateChangeSeq > latestSeq) break
        duplicateBlockedAttempts += 1
        await waitAbort(backoffForDuplicateBlocked(signal, duplicateBlockedAttempts))
      }
      if (info.agentStatus === 'blocked') continue
      break
    }

    if (info.agentStatus !== 'done' && info.agentStatus !== 'idle') {
      // working 卡死/unknown：显式失败，保留现场。
      await this.markFailed(pane, `agent 终态异常：${info.agentStatus}`)
      throw new HelmError(
        'herdr_agent_unsettled',
        `pane ${paneId} 未到达 done/idle（当前 ${info.agentStatus}），窗格保留供排查`,
        502,
        { paneId, agentStatus: info.agentStatus },
      )
    }

    // ---- 文件交接（含一次自愈）----
    const output = await waitAbort(this.readAndValidateOutput(request, pane, info))

    // ---- gate（文件成功后恰好一次）----
    if (request.gate !== undefined) await waitAbort(this.runGate(request, pane))

    // ---- 成功：保活登记（workflowRunId 由 onWorkflowSettled 关；否则父回合关）----
    this.registry.update(pane.machine, paneId, { outcome: 'keepalive', outputFileName: undefined })
    return output
  }

  /** abort 清理：销单本 pane 全部在途 Ask + 尽力关闭自有 PTY；失败仅通知。 */
  private async abortCleanup(pane: ManagedPane): Promise<void> {
    const removed = this.asks.paneClosed(pane.paneId, pane.machine)
    for (const entry of removed) {
      if (entry.phase === 'pending' || entry.phase === 'creating') {
        await this.host.cancelAskQuietly(entry.askId)
      }
    }
    await this.closePaneQuietly(pane, 'cancelled')
  }

  /** abort/取消路径的尽力清理：清理失败只通知（不掩盖原始错误）。 */
  private async closePaneQuietly(pane: ManagedPane, reason: 'settled' | 'cancelled' | 'workflow-settled' | 'turn-settled'): Promise<void> {
    try {
      await this.closePane(pane, reason)
    } catch {
      // closePane 已 notify；此处不掩盖取消/中断语义。
    }
  }

  /** prompt --wait；blocked 由 wait 返回值与 socket 事件双路进入协调器。 */
  private async promptAndWait(request: AgentSpawnRequest, pane: ManagedPane, text: string): Promise<HerdrAgentInfo> {
    const target: HerdrTarget = pane.machine === undefined ? {} : { machine: pane.machine }
    void request
    return parseAgentResult(
      await this.transport.call(target, 'agent.prompt', {
        target: pane.paneId,
        text,
        wait: { until: ['done', 'idle', 'blocked'] },
      }),
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
    routing: SpawnRouting,
    pane: ManagedPane,
    observed: HerdrAgentInfo,
  ): Promise<boolean> {
    const target: HerdrTarget = routing.machine === undefined ? {} : { machine: routing.machine }
    const transport = this.transport
    // 权威状态：不信任 wait 返回值里的 seq（事件无 seq，必须 agent.get）。
    const authority = parseAgentResult(
      await transport.call(target, 'agent.get', { target: pane.paneId }),
      'agent.get',
      'agent_info',
    )
    this.asks.observeAuthority({
      paneId: pane.paneId,
      machine: pane.machine,
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })
    if (authority.agentStatus !== 'blocked') return true // 终端已自行处理（旧 wait 快照）。

    const begin = this.asks.beginBlocked(pane.machine, pane.paneId, authority.stateChangeSeq)
    const entry = 'owner' in begin ? begin.owner : this.asks.get(pane.machine, pane.paneId, authority.stateChangeSeq)
    if (entry === undefined) return true
    // owner（无论哪个路径先 begin）：绑定结算通道并负责 createAsk + 消费；
    // 等待方路径不会到达这里（spawn 路径总是消费者）。
    const settlement = this.asks.bindSettlement(entry)

    await this.project(pane, `ask:${entry.askId}`)
    const conversationId = this.host.askConversationId(request.parentConversationId)
    let askResult: AskOutcome
    try {
      askResult = await this.createAsk(request, pane, entry, conversationId)
    } catch (error) {
      this.asks.failCreate(entry)
      settlement.settle({ status: 'superseded', answers: {} })
      throw error
    }
    this.asks.markPending(entry)
    const handled = await this.consumeAskOutcome(request, pane, entry, askResult)
    settlement.settle(askResult)
    return handled
  }

  /**
   * createAsk（预分配 id，条目已先登记）：终态三态均 resolve；cancelAsk 对
   * 已被事件路径销单的条目可能 404——此时返回 superseded 形态由调用方复核
   * 权威 seq，绝不留永不结算的旧审批。
   */
  private async createAsk(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    entry: AskEntry,
    conversationId: number,
  ): Promise<AskOutcome> {
    const authority = parseAgentResult(
      await this.transport.call(targetOf(pane), 'agent.get', { target: pane.paneId }),
      'agent.get',
      'agent_info',
    )
    this.asks.observeAuthority({
      paneId: pane.paneId,
      machine: pane.machine,
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })
    if (authority.stateChangeSeq > entry.seq || authority.agentStatus !== 'blocked') {
      // 创建前终端已推进：无需再问（返回 synthetic superseded）。
      this.asks.settle(entry, { keysSent: false })
      return { id: entry.askId, status: 'superseded', answers: {} }
    }
    const snapshot = await this.readDiagnostic(pane)
    const result = await this.host.createAsk({
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
    void request
    return result
  }

  /** 消费终态：answered 且权威 seq 未推进 -> 复核 -> 一次性 send_keys；cancelled -> false。 */
  private async consumeAskOutcome(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    entry: AskEntry,
    outcome: AskOutcome,
  ): Promise<boolean> {
    if (outcome.status !== 'answered') {
      this.asks.settle(entry, { keysSent: false })
      if (outcome.status === 'superseded') {
        // 终端先处理：回到主循环重读权威状态。
        return true
      }
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
    // 发送前再次 agent.get 校验 seq（CAS 复核：终端可能已先处理）。
    const authority = parseAgentResult(
      await this.transport.call(targetOf(pane), 'agent.get', { target: pane.paneId }),
      'agent.get',
      'agent_info',
    )
    this.asks.observeAuthority({
      paneId: pane.paneId,
      machine: pane.machine,
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })
    if (authority.stateChangeSeq !== entry.seq || authority.agentStatus !== 'blocked') {
      this.asks.settle(entry, { keysSent: false })
      return true
    }
    // 一次性 send_keys（herdr 键名：单字符 / enter / esc / 数字等 logical key）。
    assertOkResult(
      await this.transport.call(targetOf(pane), 'agent.send_keys', {
        target: pane.paneId,
        keys,
      }),
      'agent.send_keys',
    )
    this.asks.settle(entry, { keysSent: true })
    this.host.notify(
      'Herdr 审批已发送',
      `pane ${pane.paneId} 已按人类选择发送按键：${keys.join(' ')}`,
      'info',
    )
    void request
    return true
  }

  private async knownSeq(paneId: string, routing: SpawnRouting): Promise<number | undefined> {
    const target: HerdrTarget = routing.machine === undefined ? {} : { machine: routing.machine }
    const info = parseAgentResult(
      await this.transport.call(target, 'agent.get', { target: paneId }),
      'agent.get',
      'agent_info',
    )
    this.asks.observeAuthority({
      paneId,
      machine: routing.machine,
      seq: info.stateChangeSeq,
      status: info.agentStatus,
    })
    return info.stateChangeSeq
  }

  // ------------------------------------------------------------------
  // 文件交接与 gate
  // ------------------------------------------------------------------

  private async readAndValidateOutput(request: AgentSpawnRequest, pane: ManagedPane, info: HerdrAgentInfo): Promise<unknown> {
    void info
    const transport = this.transport
    const fileName = pane.outputFileName!
    const readOnce = async (): Promise<{ ok: true; value: unknown } | { ok: false; reason: string; recoverable: boolean }> => {
      let raw: string
      try {
        raw = await transport.readOutput(targetOf(pane), pane.effectiveCwd, fileName, request.signal)
      } catch (error) {
        if (error instanceof HelmError && error.code === 'herdr_output_missing') {
          return { ok: false, reason: `交接文件缺失：${fileName}`, recoverable: true }
        }
        // 其它 IO/SSH/权限错误：如实抛诊断，不当缺文件自愈。
        throw error
      }
      if (request.schema === undefined) {
        if (raw.trim() === '') return { ok: false, reason: '交接文件为空', recoverable: true }
        return { ok: true, value: raw }
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
        return { ok: true, value: parsed }
      } catch (err) {
        if (err instanceof HelmError && err.code === 'schema_validation_failed') {
          return { ok: false, reason: err.message, recoverable: true }
        }
        throw err
      }
    }

    let attempt = await readOnce()
    if (!attempt.ok) {
      // 自愈一次：原 pane 追问重写（仅缺文件/坏 JSON/schema 不合格三类）。
      this.host.notify('Herdr 交接自愈', `pane ${pane.paneId} 首次交接失败（${attempt.reason}），追问一次`, 'info')
      await this.project(pane, `heal:${pane.agentName}`)
      await this.promptAndWait(
        request,
        pane,
        `你上一轮未按要求交付。${attempt.reason}。请立即将最终结果写入 ${pane.effectiveCwd}/.helm/${fileName}` +
          (request.schema !== undefined ? `（满足 Schema 的单个 JSON 值）。\nJSON Schema: ${JSON.stringify(request.schema)}` : '（Markdown 全文）。'),
      )
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
    // 读取成功后清理交接文件（removeOutput 缺失幂等）。
    await transport.removeOutput(targetOf(pane), pane.effectiveCwd, fileName, request.signal)
    return attempt.value
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
        }),
      )
      return this.deps.redact(read.text).slice(-4_000)
    } catch (error) {
      return `[快照读取失败：${error instanceof Error ? this.deps.redact(error.message) : String(error)}]`
    }
  }

  /** gate：文件成功后恰好一次；本机 runLocalGate(env)，远端 transport.runGate(env)。 */
  private async runGate(request: AgentSpawnRequest, pane: ManagedPane): Promise<void> {
    const env = this.buildEnv(request.parentConversationId, pane.effectiveCwd, {
      kind: '',
      args: [],
      profileEnv: {},
      ...(pane.machine !== undefined ? { machine: pane.machine } : {}),
    })
    const gate: { ok: boolean; output: string } = pane.machine === undefined
      ? await this.deps.runLocalGate(request.gate!, {
          cwd: pane.effectiveCwd,
          conversationId: this.host.askConversationId(request.parentConversationId),
          signal: request.signal,
          env,
        })
      : await this.transport.runGate({ machine: pane.machine }, request.gate!, pane.effectiveCwd, request.signal, env)
    request.onGateResult?.(gate)
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
  // resume、清理与状态
  // ------------------------------------------------------------------

  private async resumeInto(request: AgentSpawnRequest, routing: SpawnRouting, cwd: string): Promise<true> {
    const resumeRef = request.resume!
    // resume ref 语义与原生 spawn 对齐：本插件 agentId（native 形如 <runId>:<agentId>）。
    const pane = this.registry.findByAgentId(resumeRef)
    if (pane === undefined) {
      throw new HelmError(
        'not_found',
        `resume ref '${resumeRef}' 不存在（非本插件登记的 herdr agentId）：绝不静默新建续接窗格`,
        404,
        { resumeRef },
      )
    }
    if (pane.parentConversationId !== request.parentConversationId) {
      throw new HelmError(
        'cross_parent_resume_rejected',
        `resume ref '${resumeRef}' 属于父会话 ${pane.parentConversationId}，当前父会话 ${request.parentConversationId} 无权续接`,
        409,
        { resumeRef, ownerParent: pane.parentConversationId, requesterParent: request.parentConversationId },
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
    // 同 workflow / 同父回合 resume：新建唯一交接文件，重新投递任务。
    const unique = `${Date.now()}-resume-${HashShort.of(request.prompt.slice(0, 160))}-${request.parentConversationId}-${Math.random().toString(36).slice(2, 6)}`
    const safeId = `r${HashShort.of(unique)}`
    const ext = request.schema !== undefined ? 'json' : 'md'
    const updated = this.registry.update(pane.machine, pane.paneId, {
      outcome: 'running',
      outputFileName: buildOutputFileName(safeId, ext),
      agentId: request.agentId ?? pane.agentId,
      ...(request.workflowRunId !== undefined ? { workflowRunId: request.workflowRunId } : {}),
    })!
    request.onResolved?.(this.executionInfoOf(updated))
    void cwd
    const output = await this.driveTask(request, { ...routing, machine: pane.machine }, updated)
    ;(request as { __herdrResult?: unknown }).__herdrResult = output
    return true
  }

  /** 关闭自有 pane：普通 tab.close；worktree workspace.close（保留磁盘分支）。失败 pane 保留现场。 */
  async closePane(pane: ManagedPane, reason: 'settled' | 'cancelled' | 'workflow-settled' | 'turn-settled'): Promise<void> {
    if (pane.outcome === 'failed') return
    const target: HerdrTarget = pane.machine === undefined ? {} : { machine: pane.machine }
    try {
      if (pane.workspaceId !== undefined) {
        assertOkResult(
          await this.transport.call(target, 'workspace.close', { workspace_id: pane.workspaceId }),
          'workspace.close',
        )
      } else {
        assertOkResult(await this.transport.call(target, 'tab.close', { tab_id: pane.tabId }), 'tab.close')
      }
      this.registry.update(pane.machine, pane.paneId, { outcome: 'settled', settledAt: Date.now() })
      this.projector.forget(pane.paneId, pane.machine)
      this.asks.paneClosed(pane.paneId, pane.machine)
    } catch (error) {
      // 清理失败显式诊断，不吞（pane 状态保留原样供人工处理）。
      this.host.notify(
        'Herdr 窗格清理失败',
        `pane ${pane.paneId}（${reason}）关闭失败：${error instanceof Error ? this.deps.redact(error.message) : String(error)}`,
        'error',
      )
      throw error
    }
  }

  private async markFailed(pane: ManagedPane, note: string): Promise<void> {
    this.registry.update(pane.machine, pane.paneId, {
      outcome: 'failed',
      failureNote: this.deps.redact(note).slice(0, 500),
      settledAt: Date.now(),
    })
    this.projector.forget(pane.paneId, pane.machine)
    this.asks.paneClosed(pane.paneId, pane.machine)
  }

  private async project(pane: ManagedPane, token: string): Promise<void> {
    await this.projector.project(pane.machine, pane.paneId, token)
  }
}

function signalOf(request: AgentSpawnRequest): AbortSignal {
  return request.signal ?? new AbortController().signal
}

function targetOf(pane: { machine?: string }): HerdrTarget {
  return pane.machine === undefined ? {} : { machine: pane.machine }
}

type AskOutcome = { id: string; status: 'answered' | 'cancelled' | 'superseded'; answers: Record<string, string> }

export type { AskOutcome }
