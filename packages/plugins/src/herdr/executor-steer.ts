/**
 * Herdr 执行器子模块：运行中插话（steer）投递与唯一交接文件轮转。
 *
 * 从 executor.ts 拆出（行为与拆分前逐行等价）；依赖经 SteerDispatcherPort
 * 注入（executor 持有 registry / transport / 权威 agent.get / 阶段与任务登记）：
 * - steerPane：受管窗格运行中插话（按 pane 互斥；单次投递不重试）；
 * - settleThroughSteers：任务结算前的在途 steer 排空、权威复查与最新交接
 *   文件核验（成功插话即把唯一交接文件重定向到全新名字，旧结果天然防冒充）；
 * - 状态登记（在途 steer / 不确定投递失败 / 作废旧文件名单）归本模块自管，
 * executor 在任务结算、closePane 与 releasePaneState 时经 forget() 作废。
 *
 * 诚实语义：guardLevel='preflight'——预检不是提交点原子复核（不可伪称
 * CAS）；steered=true 仅代表单次投递成功。
 */

import { randomUUID } from 'node:crypto'
import { HelmError, type AgentSpawnRequest } from '@helm/protocol'
import type { HerdrPluginDependencies, HerdrTarget } from './contracts.js'
import { nodeIdOf, paneStateKey, targetOf, type ManagedPane, type PaneRegistry } from './panes.js'
import { parseAgentResult, type HerdrAgentInfo } from './rpc.js'
import { buildOutputFileName } from './spawn-rules.js'
import type { SteerPaneInput } from './executor.js'

/** 受管任务生命周期阶段（与 executor 内部登记一致；仅 'task' 可插话）。 */
export type SteerPhase = 'startup' | 'task' | 'handoff' | 'gate'

/** SteerDispatcher 对执行器（executor）的最小依赖面。 */
export interface SteerDispatcherPort {
  registry: PaneRegistry
  transport: NonNullable<HerdrPluginDependencies['transport']>
  redact(text: string): string
  notify(title: string, body: string, level: 'info' | 'error'): void
  /** 权威 agent.get（seq 唯一可信来源；executor 持有）。 */
  agentGet(target: HerdrTarget, paneId: string, signal?: AbortSignal): Promise<HerdrAgentInfo>
  /** 结算等待 + blocked 审批桥循环（executor 持有）。 */
  waitUntilSettled(request: AgentSpawnRequest, pane: ManagedPane, initial: HerdrAgentInfo): Promise<void>
  /** agent.start 启动超时（config.startupTimeoutMs；预算复用口径见各调用点）。 */
  startupTimeoutMs(): number
  /** 插话后等待后续回合起步的预算（测试可缩短；缺省复用 startupTimeoutMs()）。 */
  steerWaitBudgetMs?: number
  /** 在途受管任务请求（steer 门禁复核原 run signal）。 */
  activeTaskOf(key: string): AgentSpawnRequest | undefined
  /** 在途任务当前阶段（startup/task/handoff/gate；无任务 undefined）。 */
  phaseOf(key: string): SteerPhase | undefined
  /** 更新在途任务阶段（结算核验终段切 handoff，此后插话被阶段门禁拒绝）。 */
  setPhase(key: string, phase: SteerPhase): void
  /** pane 是否正在关闭（closePane 单飞登记；关闭中拒绝插话）。 */
  isClosingPane(pane: ManagedPane): boolean
}

export class SteerDispatcher {
  /** steer 投递短超时：预检后单次投递应远小于此；超时如实报不确定，不重试。 */
  private static readonly STEER_PROMPT_TIMEOUT_MS = 5_000

  /** 服务端 admission 确定零写入的拒绝码（其余超时/断线/坏响应一律按不确定投递处理）。 */
  private static readonly STEER_ZERO_WRITE_CODES = new Set(['agent_not_ready', 'agent_blocked', 'agent_not_found'])

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

  constructor(private readonly port: SteerDispatcherPort) {}

  hasInFlight(key: string): boolean {
    return this.activeSteers.has(key)
  }

  inFlightOf(key: string): Promise<{ stateChangeSeq: number }> | undefined {
    return this.activeSteers.get(key)
  }

  hasUncertain(key: string): boolean {
    return this.steerFailures.has(key)
  }

  uncertainOf(key: string): string | undefined {
    return this.steerFailures.get(key)
  }

  /** 任务结算/窗格关闭/外部释放时作废插话登记（在途 steer promise 自行退出）。 */
  forget(key: string): void {
    this.steerFailures.delete(key)
    this.steerRetiredFiles.delete(key)
  }

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
    const key = paneStateKey(pane)
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
      const origin = this.port.activeTaskOf(key)
      if (origin === undefined || origin.signal?.aborted) {
        throw new HelmError(
          'herdr_steer_task_ended',
          `pane ${pane.paneId} 的原任务已结束或正在取消，拒绝插话`,
          409,
          { paneId: pane.paneId },
        )
      }
      // 4) 预检：权威 agent.get 核验身份与工作状态（preflight，非提交点 CAS）。
      const authority = await this.port.agentGet(current.target, current.paneId, input.signal)
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
      const originAfter = this.port.activeTaskOf(key)
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
          await this.port.transport.call(
            current.target,
            'agent.prompt',
            { target: current.agentName, text },
            { signal: input.signal, timeoutMs: SteerDispatcher.STEER_PROMPT_TIMEOUT_MS },
          ),
          'agent.prompt',
          'agent_prompted',
        )
      } catch (error) {
        const code = (error as { code?: string }).code
        if (typeof code === 'string' && SteerDispatcher.STEER_ZERO_WRITE_CODES.has(code)) {
          // 服务端 admission 确定零写入：不重定向交接文件、不记失败，
          // 原任务按自身节奏继续（前一有效路径保持不变）。
          throw error
        }
        // 超时/断线/坏响应：投递结果不确定（可能已写入）。按 pane 记失败，
        // 任务结算时显式失败保留现场；绝不静默落回旧文件或自动重发。
        if (this.port.activeTaskOf(key) === origin) {
          this.steerFailures.set(key, error instanceof Error ? error.message : String(error))
        }
        throw error
      }
      if (this.port.activeTaskOf(key) !== origin || origin.signal?.aborted || this.port.isClosingPane(current)) {
        throw new HelmError('herdr_steer_task_ended', `pane ${pane.paneId} 的输入已投递，但原任务已取消或关闭；请检查现场，不要重发`, 409)
      }
      // 成功投递后重定向唯一交接文件并冲刷持久化；结算排空在途 steer 时必然可见。
      this.port.registry.update(nodeIdOf(current), current.paneId, { outputFileName: next })
      const retired = this.steerRetiredFiles.get(key) ?? []
      if (current.outputFileName !== undefined && current.outputFileName !== '') {
        retired.push(current.outputFileName)
      }
      this.steerRetiredFiles.set(key, retired)
      await this.port.registry.flushDisk()
      return { stateChangeSeq: authority.stateChangeSeq }
    })().finally(() => this.activeSteers.delete(key))
    this.activeSteers.set(key, steer)
    return steer
  }

  /** steer 门禁前置（registry 现值复核；返回现值供后续步骤共用）。 */
  private assertSteerable(pane: ManagedPane, input: SteerPaneInput): ManagedPane {
    const current = this.port.registry.get(nodeIdOf(pane), pane.paneId)
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
    if (this.port.isClosingPane(pane)) {
      throw new HelmError(
        'herdr_steer_task_ended',
        `pane ${pane.paneId} 正在关闭（结算/取消/回收中），拒绝插话`,
        409,
        { paneId: pane.paneId },
      )
    }
    const phase = this.port.phaseOf(paneStateKey(pane))
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
    if (this.steerFailures.has(paneStateKey(pane))) {
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
      this.port.redact(input.text),
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
  async clearRetiredOutputs(request: AgentSpawnRequest, pane: ManagedPane): Promise<void> {
    const key = paneStateKey(pane)
    const retired = this.steerRetiredFiles.get(key)
    if (retired === undefined || retired.length === 0) return
    try {
      for (const fileName of retired) {
        await this.port.transport.removeOutput(targetOf(pane), pane.effectiveCwd, fileName, request.signal)
      }
    } catch (error) {
      this.port.notify(
        'Herdr 作废交接文件清理未竟',
        `插话作废的旧结果文件删除失败（结果已验证，不影响本次交付）：${error instanceof Error ? this.port.redact(error.message) : String(error)}`,
        'error',
      )
    } finally {
      this.steerRetiredFiles.delete(key)
    }
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
  async settleThroughSteers(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    initialFileName: string,
    initial: HerdrAgentInfo,
  ): Promise<void> {
    const key = paneStateKey(pane)
    const latestName = (): string | undefined => this.port.registry.get(nodeIdOf(pane), pane.paneId)?.outputFileName
    const steerSettled = (): boolean => !this.hasInFlight(key) && !this.hasUncertain(key)
    let info = initial
    for (;;) {
      await this.port.waitUntilSettled(request, pane, info)
      const inFlight = this.inFlightOf(key)
      if (inFlight !== undefined) await inFlight.catch(() => {})
      const uncertain = this.uncertainOf(key)
      if (uncertain !== undefined) {
        throw new HelmError(
          'herdr_steer_uncertain',
          `pane ${pane.paneId} 的插话投递结果不确定（${this.port.redact(uncertain)}）：拒绝以旧交接结果或自愈追问冒充按最新指导的交付，任务显式失败并保留现场`,
          502,
          { paneId: pane.paneId, reason: this.port.redact(uncertain) },
        )
      }
      const authority = await this.port.agentGet(pane.target, pane.paneId, request.signal)
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
          await this.port.transport.readOutput(targetOf(pane), pane.effectiveCwd, currentName, request.signal)
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
          info = await this.port.agentGet(pane.target, pane.paneId, request.signal)
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
      this.port.setPhase(key, 'handoff')
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
    const budgetMs = this.port.steerWaitBudgetMs ?? this.port.startupTimeoutMs()
    try {
      return parseAgentResult(
        await this.port.transport.call(
          pane.target,
          'agent.wait',
          { target: pane.paneId, until: ['working', 'blocked'], timeout_ms: budgetMs },
          { signal: request.signal, timeoutMs: budgetMs + 1_000 },
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
}
