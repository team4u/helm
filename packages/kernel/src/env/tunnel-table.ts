/**
 * tunnel-table.ts: node passthrough tunnel registration table (split out of `env/registry.ts`).
 *
 * Responsibilities: stores and settles two maps—in-flight tunnels (`pending`, opened by `openTunnel`
 * awaiting auth hello on the dedicated gateway) and established tunnels (`active`, syncing Duplex
 * lifetime with entry cleanup); settles matching tunnels in bulk on node eviction/replacement or
 * `registry.close` (rejecting pending, unregistering and destroying active duplexes). Waiting,
 * auth, and epoch re-checks remain in `NodeRegistry` (`openTunnel` / `acceptTunnel` / `grantTunnel`),
 * while this table manages registration and destruction with identical character-by-character behavior.
 */
import type { Duplex } from 'node:stream'
import { HelmError } from '@helm/protocol'

/** In-flight tunnel registration (created by `openTunnel`, awaiting dedicated gateway first-frame auth). */
export interface PendingTunnel {
  tunnelId: string
  nodeId: string
  /** Undo epoch at creation; invalidated immediately if the node is evicted or replaced. */
  epoch: number
  timeoutMs: number
  timer: NodeJS.Timeout
  /** Called by gateway after auth succeeds to hand off the Duplex (fills stream and settles pending). */
  grant: (duplex: Duplex) => void
  reject: (error: HelmError) => void
  settled: boolean
}

/** Established tunnel: Duplex held by the registry and actively destroyed on node replacement or shutdown. */
export interface ActiveTunnel {
  tunnelId: string
  nodeId: string
  duplex: Duplex
}

/**
 * Normalize explicit failure from node-side tunnel RPC: maps `result.error.code` -> HelmError
 * code/status (`timeout` 504 / `aborted` 499 / `node_draining` 503 / all others 502).
 */
export function tunnelRpcFailureOf(errorCode: string): { code: string; status: number } {
  switch (errorCode) {
    case 'timeout':
      return { code: 'node_tunnel_timeout', status: 504 }
    case 'aborted':
      return { code: 'aborted', status: 499 }
    case 'node_draining':
      return { code: 'node_draining', status: 503 }
    default:
      return { code: 'node_tunnel_connect_failed', status: 502 }
  }
}

/** Factory for bulk-settlement errors (pending and active differ in wording/context, supplied by caller). */
interface TunnelFinalizeErrors {
  pending: (nodeId: string, tunnelId: string) => HelmError
  active: (nodeId: string, tunnelId: string) => HelmError
}

export class TunnelTable {
  readonly #pending = new Map<string, PendingTunnel>()
  readonly #active = new Map<string, ActiveTunnel>()

  addPending(pending: PendingTunnel): void {
    this.#pending.set(pending.tunnelId, pending)
  }

  getPending(tunnelId: string): PendingTunnel | undefined {
    return this.#pending.get(tunnelId)
  }

  /** Remove an in-flight entry (pending settlement failure path; unconditional delete matching pre-split semantics). */
  dropPending(tunnelId: string): void {
    this.#pending.delete(tunnelId)
  }

  /** Success settlement path: remove from pending, register active, and unregister on duplex close. */
  activate(tunnelId: string, nodeId: string, duplex: Duplex): void {
    this.#pending.delete(tunnelId)
    this.#active.set(tunnelId, { tunnelId, nodeId, duplex })
    duplex.once('close', () => {
      if (this.#active.get(tunnelId)?.duplex === duplex) {
        this.#active.delete(tunnelId)
      }
    })
  }

  /** Gateway Duplex handoff: auth already succeeded (`acceptTunnel` returned true); if pending already failed to settle, `grant` destroys the incoming stream without leaking. */
  grant(tunnelId: string, duplex: Duplex): void {
    this.#pending.get(tunnelId)?.grant(duplex)
  }

  /**
   * Bulk settle matching entries: reject all matching pending first, then destroy all matching active duplexes.
   * Calling `duplex.destroy(error)` on active tunnels prevents disconnect from masquerading as clean EOF
   * (consumers detect disconnect in error/close handlers and wrap with `node_tunnel_closed`).
   */
  finalize(match: (nodeId: string) => boolean, errors: TunnelFinalizeErrors): void {
    for (const [tunnelId, pending] of [...this.#pending]) {
      if (!match(pending.nodeId)) continue
      this.#pending.delete(tunnelId)
      pending.reject(errors.pending(pending.nodeId, tunnelId))
    }
    for (const [tunnelId, active] of [...this.#active]) {
      if (!match(active.nodeId)) continue
      this.#active.delete(tunnelId)
      active.duplex.destroy(errors.active(active.nodeId, tunnelId))
    }
  }

  /** Test-only helper: in-flight and active tunnel counts. */
  counts(): { pending: number; active: number } {
    return { pending: this.#pending.size, active: this.#active.size }
  }
}
