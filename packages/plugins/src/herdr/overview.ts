/**
 * Herdr 总览投射（设计 §4.2「overview 实时展示本机所有 Herdr 窗格」）。
 *
 * 数据模型：权威来源 = 本机 session.snapshot 的 panes[]（全部窗格，含人类
 * shell）；AgentInfo 按 paneId join 只补真实五态与 state_change_seq（无
 * Agent 绝不造 seq）。registry 只作归属 overlay：本机记录 + 冻结 target
 * 精确相同 + pane.tabId / AgentInfo.name / Agent join 全一致才算 helm 受管；
 * 否则一律 human（远端同 ID 记录、pane 重建、agent 重启都不认领），human
 * 行不携带 outcome / pendingAsk 等任何管理信息。
 *
 * 生命周期纪律（均为诚实性要求）：
 * - 单飞合并：并发 refresh 以 dirty 并入同一在途循环，返回 promise 等待
 *   全部补刷轮结束（不做 fire-and-forget 重启）；
 * - close：置关闭 + abort 在途 fetch 并等待收尾，此后零写入零通知；
 * - 采集失败：redact + 通知 + stale，保留最后成功数据与 updatedAt（仅
 *   成功采集推进时间戳），重复同错误去重通知；
 * - 订阅健康与采集失败分离：成功 fetch 不清除 streamError，仅真实订阅
 *   ACK（markSubscriptionReady）恢复；
 * - evict 水位：pane 关闭后，「事件前开始的旧快照」不得复活该行，只有
 *   evict 之后新起一轮的快照才可重建；
 * - 机密：所有外部字符串（cwd/foregroundCwd/label/title/agent/agentName）
 *   redact 后落 doc（doc 直接落 state.sqlite，传输端脱敏不足）。
 */

import type { HerdrTarget } from './contracts.js'
import type { ManagedPane, PaneRegistry } from './panes.js'
import type { AskCoordinator } from './asks.js'
import type { HerdrAgentInfo, HerdrAgentStatus, HerdrPaneSnapshotInfo, SessionSnapshotData } from './rpc.js'

/** 总览单行：全本机窗格为基表；管理字段仅 helm 受管行携带。 */
export interface OverviewPaneRow {
  nodeId: string
  paneId: string
  tabId: string
  workspaceId: string
  ownedBy: 'helm' | 'human'
  /** 真实五态：AgentInfo join 或 PaneInfo.agent_status（shell 官方为 unknown）。 */
  agentStatus: HerdrAgentStatus
  /** 仅 Agent 终端存在；无 Agent 省略，绝不伪造。 */
  stateChangeSeq?: number
  cwd?: string
  /** Agent 前台真实目录（redact 只清机密，保留目录语义）。 */
  foregroundCwd?: string
  label?: string
  title?: string
  agent?: string
  /** AgentInfo.name（redact 后展示；归属核对用原始值，仅在内存完成）。 */
  agentName?: string
  focused?: boolean
  /** 仅受管行：Helm 任务生命周期（非 Herdr 窗格状态）。 */
  outcome?: string
  /** 仅受管行：存在未决审批。 */
  pendingAsk?: boolean
}

export interface OverviewDoc {
  version: 2
  /** 最后一次成功采集时间（采集/订阅故障期间保留）。 */
  updatedAt: number
  /** 采集或订阅故障为 true：panes 是最后成功数据。 */
  stale: boolean
  /** 故障诊断（redact 后）；健康时省略。 */
  error?: string
  panes: OverviewPaneRow[]
  asks: Array<{ paneId: string; nodeId: string; seq: number; phase: string }>
}

export interface OverviewDependencies {
  redact: (text: string) => string
  notify(title: string, body: string, level: 'info' | 'error'): void
}

/** 由宿主提供：读 snapshot（经 AbortSignal 可中断），边界校验由宿主完成。 */
export type SnapshotFetcher = (target: HerdrTarget, signal: AbortSignal) => Promise<SessionSnapshotData>

const PENDING_ASK_PHASES = new Set(['pending', 'creating'])

interface SnapshotCache {
  panes: HerdrPaneSnapshotInfo[]
  agentsByPane: Map<string, HerdrAgentInfo>
}

export class OverviewProjector {
  private closed = false
  private readonly abort = new AbortController()
  private dirty = false
  private inFlight: Promise<void> | undefined
  /** 快照轮次（每轮 fetch 开始前推进）；evict 水位与之比较。 */
  private round = 0
  private readonly evictWatermark = new Map<string, number>()
  private cache: SnapshotCache | undefined
  /** 最新 registry/asks/target：订阅健康标记与轻量重投都从它们重算。 */
  private registry: PaneRegistry | undefined
  private asks: AskCoordinator | undefined
  private target: HerdrTarget | undefined
  private updatedAt = 0
  private fetchError: string | undefined
  private streamError: string | undefined
  private lastDoc: OverviewDoc | undefined

  constructor(
    private readonly deps: OverviewDependencies,
    private readonly write: (doc: OverviewDoc) => void,
    private readonly fetchSnapshot: SnapshotFetcher,
    private readonly isUsable: () => boolean,
  ) {}

  /** 启动/事件重取：单飞合并，返回 promise 等待全部补刷轮结束。 */
  refresh(registry: PaneRegistry, asks: AskCoordinator, target: HerdrTarget): Promise<void> {
    this.registry = registry
    this.asks = asks
    this.target = target
    if (this.closed || !this.isUsable()) return Promise.resolve()
    this.dirty = true
    if (this.inFlight !== undefined) return this.inFlight
    this.inFlight = this.drain()
    return this.inFlight
  }

  /** 停用：置关闭 + abort 在途 fetch，等待全部在途收尾；此后零写入零通知。 */
  async close(): Promise<void> {
    this.closed = true
    this.abort.abort()
    const inflight = this.inFlight
    if (inflight !== undefined) await inflight
  }

  /** 轻量重投（Ask 相位等）：只从缓存重算 doc，不发 RPC，不伪造采集时间。 */
  republish(registry: PaneRegistry, asks: AskCoordinator): void {
    this.registry = registry
    this.asks = asks
    this.publish()
  }

  /**
   * pane 关闭/退出：立即移除缓存行并标脏；水位记在当前轮次上，使「事件前
   * 开始的旧快照」无法再次发布该 pane——只有 evict 之后新起一轮的快照
   * （round > 水位）才可重建行。
   */
  evictPane(paneId: string): void {
    this.evictWatermark.set(paneId, this.round)
    this.dirty = true
    const cache = this.cache
    if (cache !== undefined) {
      const agentsByPane = new Map(cache.agentsByPane)
      agentsByPane.delete(paneId)
      this.cache = { panes: cache.panes.filter((p) => p.paneId !== paneId), agentsByPane }
    }
    // 立即反映消失（下一轮重取前总览不再显示已关窗格）。
    this.publish()
  }

  /** 事件流故障：记录 streamError 并发布 stale/error（成功 fetch 不清除）。 */
  markSubscriptionFailed(error: unknown): void {
    this.streamError = this.deps.redact(messageOf(error))
    this.publish()
  }

  /** 订阅真实 ACK：仅此处清除 streamError。 */
  markSubscriptionReady(): void {
    this.streamError = undefined
    this.publish()
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty && !this.closed && this.isUsable()) {
        this.dirty = false
        const round = ++this.round
        let snapshot: SessionSnapshotData
        try {
          snapshot = await this.fetchSnapshot(this.target!, this.abort.signal)
        } catch (error) {
          // close 的 abort 不是采集失败：静默收尾，不通知不写入。
          if (this.closed || this.abort.signal.aborted) return
          const previous = this.fetchError
          this.fetchError = this.deps.redact(messageOf(error))
          if (this.fetchError !== previous && this.isUsable()) {
            this.deps.notify('Herdr 总览刷新失败', `session.snapshot 读取失败，总览保持最后成功数据：${this.fetchError}`, 'error')
          }
          this.publish()
          continue
        }
        if (this.closed) return
        this.fetchError = undefined
        this.updatedAt = Date.now()
        this.cache = {
          panes: snapshot.panes.filter((p) => this.allowsPane(p.paneId, round)),
          agentsByPane: new Map(snapshot.agents.map((a) => [a.paneId, a])),
        }
        // 本轮已越过的水位失效（pane 已重建或确认消失），防止 Map 无界增长。
        for (const [paneId, watermark] of [...this.evictWatermark]) {
          if (round > watermark) this.evictWatermark.delete(paneId)
        }
        // 成功采集强制发布：updatedAt 必须如实推进（去重不吞成功刷新时间）。
        this.publish(true)
      }
    } finally {
      this.inFlight = undefined
    }
  }

  /** evict 水位判别：仅 evict 之后新起一轮的快照可重建该 pane 行。 */
  private allowsPane(paneId: string, round: number): boolean {
    const watermark = this.evictWatermark.get(paneId)
    return watermark === undefined || round > watermark
  }

  /** 缓存 + registry overlay + Ask 相位 → doc（force 仅供成功采集推进 updatedAt）。 */
  private publish(force = false): void {
    if (this.closed || !this.isUsable()) return
    const error = this.fetchError ?? this.streamError
    const pendingAsks = new Set(
      (this.asks?.entries() ?? [])
        .filter((e) => PENDING_ASK_PHASES.has(e.phase))
        .map((e) => `${e.nodeId ?? 'local'}:${e.paneId}`),
    )
    const cache = this.cache
    const panes: OverviewPaneRow[] = []
    if (cache !== undefined) {
      for (const pane of cache.panes) {
        panes.push(this.buildRow(pane, cache.agentsByPane.get(pane.paneId), pendingAsks))
      }
    }
    const next: OverviewDoc = {
      version: 2,
      updatedAt: this.updatedAt,
      stale: cache === undefined || error !== undefined,
      ...(error !== undefined ? { error } : {}),
      panes,
      asks: this.asks?.describe() ?? [],
    }
    if (!force && sameDoc(next, this.lastDoc)) return
    this.lastDoc = next
    this.write(next)
  }

  private buildRow(
    pane: HerdrPaneSnapshotInfo,
    agent: HerdrAgentInfo | undefined,
    pendingAsks: Set<string>,
  ): OverviewPaneRow {
    const redact = this.deps.redact
    const record = this.owns(pane, agent)
    const foregroundCwd = agent?.foregroundCwd ?? pane.foregroundCwd
    const row: OverviewPaneRow = {
      nodeId: 'local',
      paneId: pane.paneId,
      tabId: pane.tabId,
      workspaceId: pane.workspaceId,
      ownedBy: record !== undefined ? 'helm' : 'human',
      agentStatus: agent?.agentStatus ?? pane.agentStatus,
      ...(agent !== undefined ? { stateChangeSeq: agent.stateChangeSeq } : {}),
      ...(pane.cwd !== undefined ? { cwd: redact(pane.cwd) } : {}),
      ...(foregroundCwd !== undefined ? { foregroundCwd: redact(foregroundCwd) } : {}),
      ...(pane.label !== undefined ? { label: redact(pane.label) } : {}),
      ...(pane.title !== undefined ? { title: redact(pane.title) } : {}),
      ...(pane.agent !== undefined ? { agent: redact(pane.agent) } : {}),
      ...(agent?.name !== undefined ? { agentName: redact(agent.name) } : {}),
      ...(pane.focused !== undefined ? { focused: pane.focused } : {}),
    }
    if (record !== undefined) {
      row.outcome = record.outcome
      if (pendingAsks.has(`local:${pane.paneId}`)) row.pendingAsk = true
    }
    return row
  }

  /**
   * 受管归属：registry 本机记录（scoped get，远端同 ID 记录不可能命中）+
   * 精确冻结 target 相同 + pane.tabId 一致 + AgentInfo.name 精确等于记录
   * agentName + Agent join 的 tab/workspace 与 pane 一致；任一不符即 human。
   */
  private owns(pane: HerdrPaneSnapshotInfo, agent: HerdrAgentInfo | undefined): ManagedPane | undefined {
    if (agent?.name === undefined || this.target === undefined) return undefined
    const record = this.registry?.get(undefined, pane.paneId)
    if (record === undefined) return undefined
    if (JSON.stringify(record.target) !== JSON.stringify(this.target)) return undefined
    if (pane.tabId !== record.tabId) return undefined
    if (agent.name !== record.agentName) return undefined
    if (agent.tabId !== pane.tabId || agent.workspaceId !== pane.workspaceId) return undefined
    return record
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** updatedAt 不参与比较（载荷变化才发布，防抖动与 SSE 噪声）。 */
function sameDoc(a: OverviewDoc, b: OverviewDoc | undefined): boolean {
  if (b === undefined) return false
  return (
    a.stale === b.stale &&
    a.error === b.error &&
    a.panes.length === b.panes.length &&
    a.panes.every((p, i) => JSON.stringify(p) === JSON.stringify(b.panes[i])) &&
    a.asks.length === b.asks.length &&
    a.asks.every((q, i) => JSON.stringify(q) === JSON.stringify(b.asks[i]))
  )
}
