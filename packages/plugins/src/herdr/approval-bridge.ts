/**
 * Herdr 审批桥：blocked 状态的 Ask 创建（createAsk）与终态消费（consumeAskOutcome）。
 *
 * 从 executor.ts 拆出的两段审批桥职责（行为与拆分前逐行等价），依赖经
 * ApprovalBridgePort 注入（executor 持有 agent.get / 终端快照 / 销单与宿主
 * AskDoc 端口）：
 * - createAsk（预分配 id，条目已先登记）：返回终态结果与本次快照生成的
 *   按键规划（plan 供 consumeAskOutcome 将 decision 映射为按键序列）。
 *   - 创建前权威复核：seq 已推进/已非 blocked -> 无需再问（synthetic superseded）；
 *   - 宿主返回 cancelled 且条目已被销（404 竞态确认）-> 同样 synthetic superseded
 *     回主循环，绝不留 pending；
 *   - 混合快慢路径：正则已识别标准菜单（>= 2 项）时走 0ms 确定性快路径，
 *     绝不调 AI；仅非标 TUI 快照且配置了模型端口时才异步解析候选按键选项；
 *   - Ask 存续复核：createAsk 返回的是终态 promise，其入库可晚于事件销单的
 *     404；在该 promise 结束前持续复核并销单，远端同样无需依赖本机 socket
 *     事件；瞬时故障退避重试，超上限先销宿主 AskDoc 再显式失败，绝不留
 *     永远 pending 的孤儿审批卡；
 *   - 重试 attempt（重开审批）时描述开头附「上次按键未解除阻塞」提示，
 *     终端快照用代码块围栏包裹（前端 AskDock 据此提取折叠快照）。
 * - consumeAskOutcome：answered 且权威 seq 未推进 -> CAS 能力门禁 -> 带
 *   expected_state_seq 的 CAS send_keys（stale_state 拒绝 = 键未发送，绝不
 *   重试）；cancelled/superseded -> 按语义收敛。
 *
 * agent.send_keys 的 CAS 能力门禁（显式探测，绝不静默降级）：
 * 目标 Herdr 未在 ping capabilities 通告 SEND_KEYS_CAS_CAPABILITY 时拒绝发键
 * （herdr_cas_unsupported）——旧服务端 serde 忽略未知字段，盲发
 * expected_state_seq 会被静默当作无 CAS 写键，恰好复现本修复要关闭的残窗。
 * 探测结果在同一启用周期内按 target 冻结（Herdr 升级后重新启用插件生效）。
 */

import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, type AgentSpawnRequest } from '@helm/protocol'
import type {
  CreateAskResultLike,
  CreateAskSpecLike,
  HerdrPluginDependencies,
  HerdrTarget,
} from './contracts.js'
import type { AskCoordinator, AskEntry } from './asks.js'
import {
  buildHerdrAskPromptPlan,
  extractMenuItemsFromSnapshot,
  parseCustomKeys,
  type BlockedSnapshotAnalysis,
  type HerdrAskPromptPlan,
} from './prompt-options.js'
import { nodeIdOf, targetOf, type ManagedPane } from './panes.js'
import {
  assertOkResult,
  buildSendKeysParams,
  isStaleStateError,
  parsePong,
  SEND_KEYS_CAS_CAPABILITY,
  type HerdrAgentInfo,
} from './rpc.js'

/** 审批桥对执行器（executor）与宿主的最小依赖面。 */
export interface ApprovalBridgePort {
  asks: AskCoordinator
  transport: NonNullable<HerdrPluginDependencies['transport']>
  host: {
    notify(title: string, body: string, level: 'info' | 'error'): void
    createAsk(spec: CreateAskSpecLike): Promise<CreateAskResultLike>
  }
  redact(text: string): string
  analyzeBlockedSnapshot?: HerdrPluginDependencies['analyzeBlockedSnapshot']
  /** 权威 agent.get（seq 唯一可信来源；executor 持有）。 */
  agentGet(target: HerdrTarget, paneId: string, signal?: AbortSignal): Promise<HerdrAgentInfo>
  /** agent.read recent_unwrapped 40 行脱敏快照（诊断专用；executor 持有）。 */
  readDiagnostic(pane: ManagedPane): Promise<string>
  /** 宿主销单（404 = 已结算，调用方据此清条目；其余错误如实上抛）。 */
  cancelAskQuietly(askId: string, reason: 'cancelled' | 'superseded'): Promise<void>
  /** 轮询间隔（测试可缩短；生产缺省 100ms）。用于 AskDoc 存续复核。 */
  pollIntervalMs: number
  /** Ask 存续轮询瞬时故障退避基数与上限（测试可缩短；生产缺省 500ms / 4000ms）。 */
  askPollTransientBackoffBaseMs?: number
  askPollTransientBackoffCapMs?: number
  /** abort 后销单退避上限（测试可缩短；生产缺省 3200ms）。 */
  abortCancelBackoffCapMs?: number
}

export class ApprovalBridge {
  /** abort 后循环销单的最大尝试次数（防 cancel 持续失败时重试+通知风暴；剩余兑底交给 closePane）。 */
  private static readonly MAX_ABORT_CANCEL_ATTEMPTS = 5
  private static readonly DEFAULT_ABORT_CANCEL_BACKOFF_CAP_MS = 3_200
  /** Ask 存续复核对瞬时故障（herdr_timeout/节点闪断）的最大连续容忍次数（退避重试）；超过才销单并显式失败。 */
  private static readonly MAX_ASK_POLL_TRANSIENT_FAILURES = 6
  private static readonly DEFAULT_ASK_POLL_TRANSIENT_BACKOFF_BASE_MS = 500
  private static readonly DEFAULT_ASK_POLL_TRANSIENT_BACKOFF_CAP_MS = 4_000
  /** 跨重启同 seq AskDoc ID 冲突（ask_id_conflict）推进 :r<N> 的最大重试上限。 */
  private static readonly MAX_ASK_CONFLICT_RETRIES = 20

  /** send_keys CAS 能力探测结果（同一启用周期内按 target 冻结）。 */
  private readonly sendKeysCasSupport = new Map<string, boolean>()

  constructor(private readonly port: ApprovalBridgePort) {}

  private async cancelSuperseded(pane: ManagedPane, authority: HerdrAgentInfo): Promise<void> {
    for (const superseded of this.port.asks.observeAuthority({
      paneId: pane.paneId,
      nodeId: nodeIdOf(pane),
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })) {
      await this.port.cancelAskQuietly(superseded.askId, 'superseded')
    }
  }

  private async settleSuperseded(entry: AskEntry): Promise<{ outcome: CreateAskResultLike; plan: HerdrAskPromptPlan }> {
    this.port.asks.settle(entry, { keysSent: false })
    return { outcome: { id: entry.askId, status: 'superseded', answers: {} }, plan: buildHerdrAskPromptPlan('') }
  }

  /**
   * createAsk（预分配 id，条目已先登记）：返回终态结果与本次快照生成的
   * 按键规划（plan 供 consumeAskOutcome 将 decision 映射为按键序列）。
   */
  async createAsk(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    entry: AskEntry,
    conversationId: number,
  ): Promise<{ outcome: CreateAskResultLike; plan: HerdrAskPromptPlan }> {
    const authority = await this.port.agentGet(targetOf(pane), pane.paneId, request.signal)
    await this.cancelSuperseded(pane, authority)
    if (authority.stateChangeSeq !== entry.seq || authority.agentStatus !== 'blocked') {
      return this.settleSuperseded(entry)
    }
    const snapshot = await this.port.readDiagnostic(pane)
    // 混合快慢路径：正则已识别标准菜单（>= 2 项）时走 0ms 确定性快路径，
    // 绝不调 AI（省延迟、省 Token）；仅非标 TUI 快照（如横向按钮 / 快捷键提示）
    // 且配置了模型端口时，才异步解析候选按键选项。
    let aiAnalysis: BlockedSnapshotAnalysis | undefined
    let aiDiagnostic: string | undefined
    const fastItems = extractMenuItemsFromSnapshot(snapshot)
    if (fastItems.length < 2 && snapshot.trim().length > 0 && this.port.analyzeBlockedSnapshot !== undefined) {
      try {
        const outcome = await this.port.analyzeBlockedSnapshot({
          snapshot,
          conversationId,
          signal: request.signal,
        })
        aiAnalysis = outcome.analysis
        aiDiagnostic = outcome.diagnostic
        if (aiDiagnostic !== undefined) {
          // 增强未完成不阻塞审批主流程，但绝不静默：通知人类已回退通用选项。
          this.port.host.notify('阻塞快照 AI 解析未完成', this.port.redact(aiDiagnostic), 'info')
        }
      } catch (error) {
        // 外部取消立即传播；其余情况（含注入端口直接 throw）如实通知后回退。
        // 诊断用固定安全文案，不回显上游 Error.message（可含 raw response/快照）。
        if (request.signal?.aborted) throw error
        aiAnalysis = undefined
        aiDiagnostic = '阻塞快照 AI 解析异常（请求失败），已回退通用按键选项'
        this.port.host.notify('阻塞快照 AI 解析未完成', aiDiagnostic, 'info')
      }
      // AI 等待期间终端可能自行推进：权威复核 seq，过期则不挂旧 AskDoc。
      const latest = await this.port.agentGet(targetOf(pane), pane.paneId, request.signal)
      await this.cancelSuperseded(pane, latest)
      if (latest.stateChangeSeq !== entry.seq || latest.agentStatus !== 'blocked') {
        return this.settleSuperseded(entry)
      }
    }
    const plan = buildHerdrAskPromptPlan(snapshot, aiAnalysis, (t) => this.port.redact(t))
    const retryHint =
      entry.attempt > 0 && entry.lastSentKeys && entry.lastSentKeys.length > 0
        ? `上次发送的按键 [${entry.lastSentKeys.join(', ')}] 未解除阻塞（终端仍停留在 seq ${entry.seq}），请对照快照重新选择。\n\n`
        : ''
    const aiSummaryLine = plan.summary ? `阻塞摘要：${this.port.redact(plan.summary)}\n\n` : ''
    const aiFallbackLine = aiDiagnostic ? `${this.port.redact(aiDiagnostic)}\n\n` : ''
    // 快照统一取尾部 1500 字符：与 AI 解析所据内容同口径，保证人类看到
    // 模型做出判断所依据的当前菜单（长快照头部往往是无关节奏输出）。
    const description = `${retryHint}${aiSummaryLine}${aiFallbackLine}终端 agent (${pane.agentName}) 在 ${pane.effectiveCwd} 等待选择。终端快照（脱敏）：\n\`\`\`\n${snapshot.slice(-1500)}\n\`\`\``
    for (let conflict = 0; ; conflict += 1) {
      const pending = this.port.host.createAsk({
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
      this.port.asks.markPending(entry)
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
          try { await delay(this.port.pollIntervalMs, undefined, { signal: monitor.signal }) }
          catch (error) { if (monitor.signal.aborted) return; throw error }
          if (request.signal?.aborted) {
            // abort 后销单退避有界：cancel 持续非 404 失败时不得每 100ms
            // 重试+通知风暴；超限后交由 closePane 的 paneClosed 清单兑底。
            if (abortCancelAttempts >= ApprovalBridge.MAX_ABORT_CANCEL_ATTEMPTS) return
            if (abortCancelAttempts > 0) {
              try {
                const abortCancelBackoffCapMs =
                  this.port.abortCancelBackoffCapMs ?? ApprovalBridge.DEFAULT_ABORT_CANCEL_BACKOFF_CAP_MS
                await delay(
                  Math.min(this.port.pollIntervalMs * 2 ** abortCancelAttempts, abortCancelBackoffCapMs),
                  undefined,
                  { signal: monitor.signal },
                )
              } catch (error) { if (monitor.signal.aborted) return; throw error }
            }
            await this.port.cancelAskQuietly(entry.askId, 'cancelled')
            abortCancelAttempts += 1
            continue
          }
          let current: HerdrAgentInfo
          try {
            current = await this.port.agentGet(targetOf(pane), pane.paneId, monitor.signal)
            transientFailures = 0
          } catch (error) {
            if (monitor.signal.aborted) return
            if ((error as { code?: string }).code === 'herdr_aborted') throw error
            transientFailures += 1
            if (transientFailures > ApprovalBridge.MAX_ASK_POLL_TRANSIENT_FAILURES) {
              // 最终失败：异步销宿主 AskDoc 后立即上抛真实错误（不 await——
              // 等待会让宿主 cancelled 终态先赢 Promise.race，把基础设施失败
              // 伪装成「人类取消」abort 路径关掉失败现场）；兑底 cancel 由
              // 任务链 catch 的同步销单保证，绝不留 pending 孤儿审批卡。
              void this.port.cancelAskQuietly(entry.askId, 'cancelled')
              throw error
            }
            try {
              const backoffBaseMs =
                this.port.askPollTransientBackoffBaseMs ?? ApprovalBridge.DEFAULT_ASK_POLL_TRANSIENT_BACKOFF_BASE_MS
              const backoffCapMs =
                this.port.askPollTransientBackoffCapMs ?? ApprovalBridge.DEFAULT_ASK_POLL_TRANSIENT_BACKOFF_CAP_MS
              await delay(
                Math.min(backoffBaseMs * 2 ** (transientFailures - 1), backoffCapMs),
                undefined,
                { signal: monitor.signal },
              )
            } catch (error) { if (monitor.signal.aborted) return; throw error }
            continue
          }
          if (current.stateChangeSeq !== entry.seq || current.agentStatus !== 'blocked') {
            this.port.asks.observeAuthority({ nodeId: nodeIdOf(pane), paneId: pane.paneId, seq: current.stateChangeSeq, status: current.agentStatus })
            await this.port.cancelAskQuietly(entry.askId, 'superseded')
          }
        }
      })()
      try {
        return { outcome: await Promise.race([result, polling.then(() => result)]), plan }
      } catch (error) {
        const isIdConflict = error instanceof HelmError && error.code === 'ask_id_conflict'
        if (!isIdConflict || conflict >= ApprovalBridge.MAX_ASK_CONFLICT_RETRIES) {
          throw error
        }
        const existingStatus = (error.details as { existingStatus?: unknown } | undefined)?.existingStatus
        if (existingStatus === 'pending') {
          await this.port.cancelAskQuietly(entry.askId, 'superseded')
        }
        const latest = await this.port.agentGet(targetOf(pane), pane.paneId, request.signal)
        await this.cancelSuperseded(pane, latest)
        if (latest.stateChangeSeq !== entry.seq || latest.agentStatus !== 'blocked') {
          return this.settleSuperseded(entry)
        }
        this.port.asks.advanceRetryOnConflict(entry)
      } finally {
        monitor.abort()
        await polling.catch((error: unknown) => {
          if ((error as { code?: string }).code !== 'herdr_aborted') throw error
        })
      }
    }
  }

  /** 消费终态：answered 且权威 seq 未推进 -> 能力门禁 -> 带 expected_state_seq 的 CAS send_keys（stale_state 拒绝 = 键未发送，绝不重试）；cancelled -> false。 */
  async consumeAskOutcome(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    entry: AskEntry,
    outcome: CreateAskResultLike,
    plan: HerdrAskPromptPlan,
  ): Promise<boolean> {
    if (outcome.status !== 'answered') {
      this.port.asks.settle(entry, { keysSent: false })
      if (outcome.status === 'superseded') return true
      return false
    }
    const decision = outcome.answers['decision'] ?? ''
    let keys: string[] | undefined
    if (decision === 'custom') {
      const custom = parseCustomKeys(outcome.answers['key'] ?? '')
      if (custom.length === 0) {
        this.port.asks.settle(entry, { keysSent: false })
        return false
      }
      keys = custom
    } else {
      keys = plan.decisionKeys.get(decision)
    }
    if (keys === undefined || keys.length === 0) {
      this.port.asks.settle(entry, { keysSent: false })
      return false
    }
    const authority = await this.port.agentGet(targetOf(pane), pane.paneId, request.signal)
    await this.cancelSuperseded(pane, authority)
    if (authority.name !== pane.agentName) throw new HelmError('herdr_ownership_lost', `pane ${pane.paneId} 的 Agent 身份已变化，不能发送按键`, 409)
    if (authority.stateChangeSeq !== entry.seq || authority.agentStatus !== 'blocked') {
      this.port.asks.settle(entry, { keysSent: false })
      return true
    }
    // 协议级 CAS：send_keys 携带 expected_state_seq（entry.seq），彻底关闭上方
    // 权威 agent.get 与写键之间的毫秒级残窗——人类在终端直接按键推进 seq 时
    // 服务端必须以 stale_state 拒绝且不写入任何按键。
    await this.assertSendKeysCas(targetOf(pane), request.signal)
    try {
      await assertOkResult(
        await this.port.transport.call(
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
      this.port.asks.settle(entry, { keysSent: false })
      this.port.host.notify(
        'Herdr 审批已过时',
        `pane ${pane.paneId} 的按键选择因终端状态已推进（stale_state）被服务端拒绝，未发送任何按键；主循环将继续按权威状态收敛`,
        'info',
      )
      return true
    }
    this.port.asks.settle(entry, { keysSent: true, sentKeys: keys })
    this.port.host.notify('Herdr 审批已发送', `pane ${pane.paneId} 已按人类选择发送按键：${keys.join(' ')}`, 'info')
    return true
  }

  private async assertSendKeysCas(target: HerdrTarget, signal?: AbortSignal): Promise<void> {
    const key = JSON.stringify(target)
    const cached = this.sendKeysCasSupport.get(key)
    if (cached === true) return
    if (cached === false) throw this.casUnsupportedError(target)
    const pong = parsePong(await this.port.transport.call(target, 'ping', {}, { signal, timeoutMs: 5_000 }))
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
}
