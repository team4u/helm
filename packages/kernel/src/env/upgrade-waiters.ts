/**
 * upgrade-waiters.ts：节点升级等待器集合（自 env/registry.ts 拆出）。
 *
 * 职责：每节点至多一个在途升级等待器的登记、终态结算与关停清理；
 * 仅由匹配的心跳 commit resolve（升级成功确认只能来自候选自己的 commit
 * 心跳，register/断开不终结等待器——升级过程本身伴随旧连接顶替）。
 * 有界内存承诺：等待器由 cancel / 超时 / registry.close / 匹配 commit
 * 终结，绝不悬挂。行为与拆分前 NodeRegistry 内联实现逐字一致。
 */
import { HelmError } from '@helm/protocol'
import type { NodeUpgradeResult } from '@helm/protocol'

/** 升级等待器：有界内存承诺，仅由匹配的心跳 commit resolve。 */
interface UpgradeWaiter {
  nodeId: string
  attemptId: string
  targetVersion: string
  previousVersion: string
  resolve: (result: NodeUpgradeResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** beginUpgrade 返回的受控等待器句柄。 */
export interface UpgradeWaiterHandle {
  /** 升级终态：仅匹配心跳 commit resolve 成功；超时/取消/断开 reject。 */
  result: Promise<NodeUpgradeResult>
  /** 主动取消（清理等待器；reason 作为 rejection 原因）。 */
  cancel(reason?: Error): void
}

/** 同节点并发升级等待拒绝（调用方映射为 409）。 */
export class HelmUpgradeBusyError extends Error {}
/** 升级等待超时（未收到匹配 commit）。 */
export class HelmUpgradeTimeoutError extends Error {}
/** 升级等待被主动取消。 */
export class HelmUpgradeCancelledError extends Error {}

/**
 * 升级等待器集合。registry 层仅做 closed 门禁与转发；本类不感知连接池。
 */
export class UpgradeWaiterSet {
  readonly #waiters = new Map<string, UpgradeWaiter>()

  /**
   * 创建升级等待器：返回的 result 仅由匹配的心跳 upgradeCommit resolve；
   * 超时 / cancel() reject（原 socket 传输断开不终结等待器——升级本身就
   * 伴随候选顶替旧连接）。同节点并发升级等待显式拒绝（HelmUpgradeBusyError）。
   */
  begin(
    nodeId: string,
    params: { attemptId: string; targetVersion: string; previousVersion: string; timeoutMs: number },
  ): UpgradeWaiterHandle {
    if (this.#waiters.has(nodeId)) {
      throw new HelmUpgradeBusyError(`节点 ${nodeId} 已有在途升级等待器`)
    }
    let waiter: UpgradeWaiter | undefined
    const result = new Promise<NodeUpgradeResult>((resolve, reject) => {
      waiter = {
        nodeId,
        attemptId: params.attemptId,
        targetVersion: params.targetVersion,
        previousVersion: params.previousVersion,
        resolve,
        reject,
        timer: setTimeout(() => {
          const w = this.#waiters.get(nodeId)
          if (w !== undefined && w.attemptId === params.attemptId) {
            this.#waiters.delete(nodeId)
            w.reject(new HelmUpgradeTimeoutError(
              `节点 ${nodeId} 升级到 ${params.targetVersion} 未在 ${params.timeoutMs}ms 内确认`,
            ))
          }
        }, params.timeoutMs),
      }
      waiter.timer.unref?.()
      this.#waiters.set(nodeId, waiter)
    })
    // 防未处理 rejection：调用方始终 await result，但保险起见吞掉观察者缺位。
    result.catch(() => undefined)
    return {
      result,
      cancel: (reason?: Error) => {
        const w = this.#waiters.get(nodeId)
        if (w === undefined || w.attemptId !== params.attemptId) return
        clearTimeout(w.timer)
        this.#waiters.delete(nodeId)
        w.reject(reason ?? new HelmUpgradeCancelledError(`节点 ${nodeId} 升级等待已取消`))
      },
    }
  }

  /** 测试内省：节点是否存在在途升级等待器。 */
  has(nodeId: string): boolean {
    return this.#waiters.has(nodeId)
  }

  /**
   * 升级心跳 commit 处理（noteHeartbeat 内部调用；已验证 conn 是当前连接），
   * 返回值即心跳 ACK：
   * - 仅 conn.upgradeAttemptId === commit.attemptId（候选以该 attempt 注册）
   *   且 conn.version === commit.version（候选确实运行目标版本）才合法；
   * - 合法且存在等待器时再核实 targetVersion / previousVersion 完全
   *   一致才 resolve（pid 正整数），不一致不倒灌别的 attempt，且 ACK false
   *   （节点据此重试/回滚，绝不误以为 Hub 已确认）；
   * - 合法但无等待器（如本机 CLI 升级后重连）视为已接受（true）。
   */
  applyCommit(nodeId: string, conn: { upgradeAttemptId?: string; version?: string }, commit: unknown): boolean {
    if (commit === null || typeof commit !== 'object' || Array.isArray(commit)) {
      return false
    }
    const c = commit as Record<string, unknown>
    const { attemptId, version, previousVersion, pid } = c
    if (typeof attemptId !== 'string' || attemptId === '' || typeof version !== 'string' || version === '') {
      return false
    }
    if (typeof previousVersion !== 'string' || previousVersion === '') {
      return false
    }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return false
    }
    // 当前连接必须以该 attempt 注册且已运行目标版本（伪造/过期的 commit 拒绝）。
    if (conn.upgradeAttemptId !== attemptId || conn.version !== version) {
      return false
    }
    const waiter = this.#waiters.get(nodeId)
    if (waiter === undefined) return true
    // 等待器与 commit 必须完全同源：不同 attempt/版本的迟到 commit 不倒灌。
    if (
      waiter.attemptId !== attemptId ||
      waiter.targetVersion !== version ||
      waiter.previousVersion !== previousVersion
    ) {
      return false
    }
    clearTimeout(waiter.timer)
    this.#waiters.delete(nodeId)
    waiter.resolve({
      ok: true,
      previousVersion,
      targetVersion: version,
      upgraded: true,
      pid,
    })
    return true
  }

  /** 关停：全部等待器清理并以统一原因 reject（registry.close 调用）。 */
  rejectAll(reason: Error): void {
    for (const [nodeId, waiter] of [...this.#waiters]) {
      clearTimeout(waiter.timer)
      this.#waiters.delete(nodeId)
      waiter.reject(reason)
    }
  }
}
