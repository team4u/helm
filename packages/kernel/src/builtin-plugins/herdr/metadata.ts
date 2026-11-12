/**
 * $helm 状态 Token 投射器（pane.report_metadata）。
 *
 * 防自激环（真实事故反馈）：report_metadata 本身产生 pane.updated 事件；
 * 若每次事件后无条件再投射会无限循环。因此：
 * - 去重签名 = 业务状态 token 字符串（如 'ask:herdr:local:p1:3' 或 'run:wf_x'），
 *   绝不使用被 metadata 自身推进的 pane revision；
 * - 仅在 token 变化或 TTL 心跳到期（默认 30s 的一半刷新）时投射；
 * - 有界心跳定时器随服务启停：projector.start() 起播 / stop() 清理。心跳只
 *   重投射已登记 token（不新增状态、不接触新窗格），长任务侧栏 token 不失踪。
 */

import type { HerdrTarget } from './contracts.js'
import { assertOkResult } from './rpc.js'

const SOURCE = 'helm'
const TOKEN_TTL_MS = 30_000
/** TTL 过半即刷新（侧栏 token 过期前的续命心跳）。 */
const REFRESH_AFTER_MS = Math.floor(TOKEN_TTL_MS / 2)
/** 心跳周期 = 刷新窗口（到期即续命；不与业务事件耦合）。 */
const HEARTBEAT_MS = REFRESH_AFTER_MS

interface ProjectionState {
  nodeId: string | undefined
  paneId: string
  lastToken: string
  lastSeq: number
  lastProjectedAt: number
  inFlight: boolean
  /** inFlight 期间到达的新 token（latest 语义）：完成后补投射，绝不静默丢弃。 */
  pendingToken?: string
}

export class MetadataProjector {
  private readonly states = new Map<string, ProjectionState>()
  private seqCounters = new Map<string, number>()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly call: (
      target: HerdrTarget,
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
    private readonly onError: (paneId: string, error: unknown) => void,
  ) {}

  /**
   * 投射状态 token：token 未变且未到刷新窗口时跳过（幂等去重）。
   * 投射失败显式上报（不吞），但不中断主流程——token 是态势感知增强，
   * 失败不影响执行正确性；同一 token 的失败也不重试到死（下个窗口再试）。
   */
  async project(nodeId: string | undefined, paneId: string, token: string): Promise<void> {
    const key = `${nodeId ?? 'local'}:${paneId}`
    const state = this.states.get(key)
    const now = Date.now()
    if (
      state &&
      !state.inFlight &&
      state.lastToken === token &&
      now - state.lastProjectedAt < REFRESH_AFTER_MS
    ) {
      return
    }
    if (!state) {
      this.states.set(key, { nodeId, paneId, lastToken: '', lastSeq: 0, lastProjectedAt: 0, inFlight: false })
    }
    const cur = this.states.get(key)!
    if (cur.inFlight) {
      // 单飞期间的最新 token 记待补投射（latest 语义）：ask/run token 切换
      // 恰逢投射在途时，新 token 不致整周期不上屏。
      cur.pendingToken = token
      return
    }
    cur.inFlight = true
    cur.lastToken = token
    cur.lastProjectedAt = now
    cur.lastSeq = this.nextSeq(key)
    try {
      const target: HerdrTarget = nodeId === undefined ? {} : { nodeId }
      const result = await this.call(target, 'pane.report_metadata', {
        pane_id: paneId,
        source: SOURCE,
        tokens: { helm: token },
        seq: cur.lastSeq,
        ttl_ms: TOKEN_TTL_MS,
      })
      assertOkResult(result, 'pane.report_metadata')
    } catch (error) {
      // 失败如实上报；不回滚 lastToken（下个窗口重试同一 token）。
      this.onError(paneId, error)
    } finally {
      cur.inFlight = false
      const next = cur.pendingToken
      cur.pendingToken = undefined
      if (next !== undefined && next !== cur.lastToken) {
        // 期间有更新的 token：立即补投射（每次完成至多补一次，不会自激循环）。
        void this.project(cur.nodeId, cur.paneId, next)
      }
    }
  }

  /**
   * 服务级心跳（随 service start/stop 启停）：对已登记窗格重投射当前 token。
   * 只续命（幂等投射同一 token），不产生新状态——绝不由 metadata 事件自激。
   */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      this.timer?.unref?.()
      for (const state of this.states.values()) {
        // 心跳只续命不新增状态：inFlight 中的窗格跳过，避免旧 lastToken
        // 覆盖待补投射的更新 pendingToken（latest 语义）。
        if (state.lastToken === '' || state.inFlight) continue
        void this.project(state.nodeId, state.paneId, state.lastToken)
      }
    }, HEARTBEAT_MS)
    this.timer.unref?.()
  }

  /** pane 关闭/结算后清理本地状态（不再心跳；seq 计数随 pane 一并回收，防无界增长）。 */
  forget(paneId: string, nodeId?: string): void {
    const key = `${nodeId ?? 'local'}:${paneId}`
    this.states.delete(key)
    this.seqCounters.delete(key)
  }

  /** 服务停止：清理心跳定时器。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 同一 (paneId, source) 单调递增 seq：跨重启从 1 重新开始亦可（TTL 短）。 */
  private nextSeq(key: string): number {
    const next = (this.seqCounters.get(key) ?? 0) + 1
    this.seqCounters.set(key, next)
    return next
  }
}
