/**
 * $helm status token projector (pane.report_metadata).
 *
 * Anti self-excitation loop (from a real incident): report_metadata itself produces pane.updated events;
 * unconditionally re-projecting after every event would loop forever. Therefore:
 * - dedup signature = the business status token string (e.g. 'ask:herdr:local:p1:3' or 'run:wf_x'),
 *   never the pane revision which metadata itself advances;
 * - project only when the token changes or the TTL heartbeat expires (refresh at half of the default 30s);
 * - the bounded heartbeat timer follows the service lifecycle: projector.start() starts it / stop() cleans it. The heartbeat only
 *   re-projects registered tokens (adding no state, touching no new panes); long-task sidebar tokens never go missing.
 */

import type { HerdrTarget } from './contracts.js'
import { assertOkResult } from './rpc.js'

const SOURCE = 'helm'
const TOKEN_TTL_MS = 30_000
/** Refresh at half the TTL (the renewal heartbeat before the sidebar token expires). */
const REFRESH_AFTER_MS = Math.floor(TOKEN_TTL_MS / 2)
/** Heartbeat period = refresh window (renews on expiry; decoupled from business events). */
const HEARTBEAT_MS = REFRESH_AFTER_MS

interface ProjectionState {
  nodeId: string | undefined
  paneId: string
  lastToken: string
  lastSeq: number
  lastProjectedAt: number
  inFlight: boolean
  /** New tokens arriving during inFlight (latest semantics): re-projected after completion, never silently dropped. */
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
   * Project a status token: skipped when the token is unchanged and the refresh window hasn't arrived (idempotent dedup).
   * Projection failures are reported explicitly (not swallowed) but do not interrupt the main flow -- the token is a
   * situational-awareness enhancement whose failure does not affect execution correctness; the same token's failures are not retried to death (retry next window).
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
      // The latest token during single-flight is queued for re-projection (latest semantics): when an ask/run token switch
      // coincides with an in-flight projection, the new token still reaches the screen within the cycle.
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
      // Failures are reported honestly; lastToken is not rolled back (the same token retries next window).
      this.onError(paneId, error)
    } finally {
      cur.inFlight = false
      const next = cur.pendingToken
      cur.pendingToken = undefined
      if (next !== undefined && next !== cur.lastToken) {
        // A newer token arrived meanwhile: re-project immediately (at most one re-projection per completion; no self-excitation loop).
        void this.project(cur.nodeId, cur.paneId, next)
      }
    }
  }

  /**
   * Service-level heartbeat (started/stopped with the service): re-projects the current token for registered panes.
   * It only renews (idempotently re-projecting the same token) and produces no new state -- never self-excited by metadata events.
   */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      this.timer?.unref?.()
      for (const state of this.states.values()) {
        // The heartbeat only renews without adding state: panes in flight are skipped, preventing an old lastToken
        // from overriding the newer pendingToken queued for re-projection (latest semantics).
        if (state.lastToken === '' || state.inFlight) continue
        void this.project(state.nodeId, state.paneId, state.lastToken)
      }
    }, HEARTBEAT_MS)
    this.timer.unref?.()
  }

  /** Clean up local state after a pane closes/settles (no more heartbeat; seq counts are reclaimed with the pane, preventing unbounded growth). */
  forget(paneId: string, nodeId?: string): void {
    const key = `${nodeId ?? 'local'}:${paneId}`
    this.states.delete(key)
    this.seqCounters.delete(key)
  }

  /** Service stop: clean up the heartbeat timer. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Monotonically increasing seq per (paneId, source): restarting from 1 across restarts is fine (short TTL). */
  private nextSeq(key: string): number {
    const next = (this.seqCounters.get(key) ?? 0) + 1
    this.seqCounters.set(key, next)
    return next
  }
}
