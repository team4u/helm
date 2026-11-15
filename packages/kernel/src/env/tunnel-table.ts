/**
 * tunnel-table.ts：节点透传隧道的登记表（自 env/registry.ts 拆出）。
 *
 * 职责：在途隧道（pending，openTunnel 发起后等待独立网关首帧认证）与已建立
 * 隧道（active，Duplex 生命周期与登记项同步销毁）两张表的存储与终结；
 * 节点换代（evict/替换）与 registry.close 经 finalize 批量终结（pending 拒绝、
 * active 摘除并销毁 duplex）。等待/认证/epoch 复查流程仍归 NodeRegistry
 * （openTunnel / acceptTunnel / grantTunnel），本表只管登记与销毁。
 * 行为与拆分前 NodeRegistry 内联实现逐字一致。
 */
import type { Duplex } from 'node:stream'
import { HelmError } from '@helm/protocol'

/** 在途隧道登记（openTunnel 建立后等待独立网关首帧认证）。 */
export interface PendingTunnel {
  tunnelId: string
  nodeId: string
  /** 发起时的撤销 epoch；节点换代（evict/替换）后 pending 立即失效。 */
  epoch: number
  timeoutMs: number
  timer: NodeJS.Timeout
  /** 认证通过后由网关交棒 Duplex（grant 填入流并结算 pending）。 */
  grant: (duplex: Duplex) => void
  reject: (error: HelmError) => void
  settled: boolean
}

/** 已建立隧道：Duplex 由登记表持有并在节点换代/关停时主动销毁。 */
export interface ActiveTunnel {
  tunnelId: string
  nodeId: string
  duplex: Duplex
}

/**
 * 节点侧隧道 RPC 显式失败结果的错误归一：result.error.code → HelmError 的
 * code/status（timeout 504 / aborted 499 / node_draining 503 / 其余 502）。
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

/** 终结批次的错误工厂（pending 与 active 的措辞/字段不同，由调用方给定）。 */
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

  /** 摘除在途登记（pending 定格失败路径；无条件删除，同拆分前语义）。 */
  dropPending(tunnelId: string): void {
    this.#pending.delete(tunnelId)
  }

  /** 结算成功路径：摘 pending、登记 active，并在 duplex 关闭时摘除登记。 */
  activate(tunnelId: string, nodeId: string, duplex: Duplex): void {
    this.#pending.delete(tunnelId)
    this.#active.set(tunnelId, { tunnelId, nodeId, duplex })
    duplex.once('close', () => {
      if (this.#active.get(tunnelId)?.duplex === duplex) {
        this.#active.delete(tunnelId)
      }
    })
  }

  /** 网关交棒 Duplex：认证已过（acceptTunnel true 后调用）；pending 已定格失败则销毁交来的流（不泄漏）。 */
  grant(tunnelId: string, duplex: Duplex): void {
    this.#pending.get(tunnelId)?.grant(duplex)
  }

  /**
   * 批量终结：先拒绝全部命中的 pending，再销毁全部命中的 active duplex。
   * active 的 duplex.destroy(error) 避免把断开伪装成正常 EOF（消费方在
   * error/close 中感知断开并以 node_tunnel_closed 收尾）。
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

  /** 测试内省：在途/已建立隧道计数。 */
  counts(): { pending: number; active: number } {
    return { pending: this.#pending.size, active: this.#active.size }
  }
}
