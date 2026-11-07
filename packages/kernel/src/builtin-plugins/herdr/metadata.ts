/**
 * $helm 状态 Token 投射器（pane.report_metadata）。
 *
 * 防自激环（真实事故反馈）：report_metadata 本身产生 pane.updated 事件；
 * 若每次事件后无条件再投射会无限循环。因此：
 * - 去重签名 = 业务状态 token 字符串（如 'ask:herdr:local:p1:3' 或 'run:wf_x'），
 *   绝不使用被 metadata 自身推进的 pane revision；
 * - 仅在 token 变化或 TTL 心跳到期（默认 30s 的一半刷新）时投射；
 * - metadata seq 在同一 (paneId, source='helm') 上单调递增。
 */

import type { HerdrTarget } from './contracts.js'
import { assertOkResult } from './rpc.js'

const SOURCE = 'helm'
const TOKEN_TTL_MS = 30_000
/** TTL 过半即刷新（侧栏 token 过期前的续命心跳）。 */
const REFRESH_AFTER_MS = Math.floor(TOKEN_TTL_MS / 2)

interface ProjectionState {
  lastToken: string
  lastSeq: number
  lastProjectedAt: number
  inFlight: boolean
}

export class MetadataProjector {
  private readonly states = new Map<string, ProjectionState>()
  private seqCounters = new Map<string, number>()

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
  async project(machine: string | undefined, paneId: string, token: string): Promise<void> {
    const key = `${machine ?? 'local'}:${paneId}`
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
      this.states.set(key, { lastToken: '', lastSeq: 0, lastProjectedAt: 0, inFlight: false })
    }
    const cur = this.states.get(key)!
    if (cur.inFlight) return
    cur.inFlight = true
    cur.lastToken = token
    cur.lastProjectedAt = now
    cur.lastSeq = this.nextSeq(key)
    try {
      const target: HerdrTarget = machine === undefined ? {} : { machine }
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
    }
  }

  /** pane 关闭/结算后清理本地状态（不再心跳）。 */
  forget(paneId: string, machine?: string): void {
    this.states.delete(`${machine ?? 'local'}:${paneId}`)
  }

  /** 同一 (paneId, source) 单调递增 seq：跨重启从 1 重新开始亦可（TTL 短）。 */
  private nextSeq(key: string): number {
    const next = (this.seqCounters.get(key) ?? 0) + 1
    this.seqCounters.set(key, next)
    return next
  }
}
