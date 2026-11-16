/**
 * tunnel-table.ts: node pass-through tunnel register table (self env/registry.ts split out).
 *
 * responsibility: in-flight tunnel (pending,openTunnel start after wait for independent gateway first frame recognize verify) and already establish
 * tunnel (active,Duplex lifecycle and register items sync destroy) two spread table store and final;
 * node swap proxy (evict/replace) and registry.close via finalize batch amount final (pending reject,
 * active excerpt except and destroy duplex). wait for/recognize verify/epoch re- inspect stream process still archive NodeRegistry
 * (openTunnel / acceptTunnel / grantTunnel), this table only manage register and destroy.
 * behavior and split before NodeRegistry inline implement one by one character consistent.
 */
import type { Duplex } from 'node:stream'
import { HelmError } from '@helm/protocol'

/** in-flight tunnel register (openTunnel establish after wait for independent gateway first frame recognize verify). */
export interface PendingTunnel {
  tunnelId: string
  nodeId: string
  /** start when undo epoch; node swap proxy (evict/replace) after pending immediately expires. */
  epoch: number
  timeoutMs: number
  timer: NodeJS.Timeout
  /** recognize verify via after by gateway hand over fine Duplex(grant fill stream and compute pending). */
  grant: (duplex: Duplex) => void
  reject: (error: HelmError) => void
  settled: boolean
}

/** already establish tunnel:Duplex by register table hold has and in node swap proxy/closure stop when actively destroy. */
export interface ActiveTunnel {
  tunnelId: string
  nodeId: string
  duplex: Duplex
}

/**
 * node side tunnel RPC explicit failed result error archive one:result.error.code → HelmError 
 * code/status(timeout 504 / aborted 499 / node_draining 503 / the rest 502).
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

/** final batch error work vendor (pending and active wording/field different, by caller to set). */
export interface TunnelFinalizeErrors {
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

  /** excerpt except in-flight register (pending set format failed path; without condition delete, same split before semantics). */
  dropPending(tunnelId: string): void {
    this.#pending.delete(tunnelId)
  }

  /** compute succeeded path: excerpt pending, register active, and in duplex on shutdown excerpt except register. */
  activate(tunnelId: string, nodeId: string, duplex: Duplex): void {
    this.#pending.delete(tunnelId)
    this.#active.set(tunnelId, { tunnelId, nodeId, duplex })
    duplex.once('close', () => {
      if (this.#active.get(tunnelId)?.duplex === duplex) {
        this.#active.delete(tunnelId)
      }
    })
  }

  /** gateway hand over fine Duplex: recognize verify already (acceptTunnel true after invoke);pending already set format failed then destroy hand over come stream (without leaking). */
  grant(tunnelId: string, duplex: Duplex): void {
    this.#pending.get(tunnelId)?.grant(duplex)
  }

  /**
   * batch amount final: first reject all hit pending, again destroy all hit active duplex.
   * active  duplex.destroy(error) avoid disconnect disguise into normal EOF(consumer in
   * error/close in aware disconnect and with node_tunnel_closed wrap-up).
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

  /** test inside omit: in-flight/already establish tunnel counter. */
  counts(): { pending: number; active: number } {
    return { pending: this.#pending.size, active: this.#active.size }
  }
}
