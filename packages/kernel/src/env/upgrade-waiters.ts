/**
 * upgrade-waiters.ts: node upgrade wait for set (self env/registry.ts split out).
 *
 * responsibility: each node at most a in-flight upgrade wait for register, terminal state compute and closure stop clean up;
 * only by match heartbeat commit resolve(upgrade succeeded confirm only can from choose itself commit
 * heartbeat,register/disconnect do not final wait for - - upgrade process itself along with old connect top replace).
 * has boundary memory promise: wait for by cancel / timeout / registry.close / match commit
 * final, never pending. behavior and split before NodeRegistry inline implement one by one character consistent.
 */
import { HelmError } from '@helm/protocol'
import type { NodeUpgradeResult } from '@helm/protocol'

/** upgrade wait for: has boundary memory promise, only by match heartbeat commit resolve. */
interface UpgradeWaiter {
  nodeId: string
  attemptId: string
  targetVersion: string
  previousVersion: string
  resolve: (result: NodeUpgradeResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** beginUpgrade return subject to control wait for handle. */
export interface UpgradeWaiterHandle {
  /** upgrade terminal state: only match heartbeat commit resolve succeeded; timeout/cancel/disconnect reject. */
  result: Promise<NodeUpgradeResult>
  /** actively cancel (clean up wait for;reason as rejection reason). */
  cancel(reason?: Error): void
}

/** same node concurrency upgrade wait for reject (caller mapping is 409). */
export class HelmUpgradeBusyError extends Error {}
/** upgrade wait timed out (not received match commit). */
export class HelmUpgradeTimeoutError extends Error {}
/** upgrade wait for by actively cancel. */
export class HelmUpgradeCancelledError extends Error {}

/**
 * upgrade wait for set.registry layer only do closed gate and forwarding; this class unaware of connection pool.
 */
export class UpgradeWaiterSet {
  readonly #waiters = new Map<string, UpgradeWaiter>()

  /**
   * create upgrade wait for: return result only by match heartbeat upgradeCommit resolve;
   * timeout / cancel() reject(original socket transfer disconnect do not final wait for - - upgrade itself then
   * along with choose top replace old connect). same node concurrency upgrade wait for explicit reject (HelmUpgradeBusyError).
   */
  begin(
    nodeId: string,
    params: { attemptId: string; targetVersion: string; previousVersion: string; timeoutMs: number },
  ): UpgradeWaiterHandle {
    if (this.#waiters.has(nodeId)) {
      throw new HelmUpgradeBusyError(`node ${nodeId} already has in-flight upgrade wait for`)
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
              `node ${nodeId} upgrade to ${params.targetVersion} not in ${params.timeoutMs}ms inside confirm`,
            ))
          }
        }, params.timeoutMs),
      }
      waiter.timer.unref?.()
      this.#waiters.set(nodeId, waiter)
    })
    // guard against not handle rejection: caller always await result, but keep risk start see swallow observer missing.
    result.catch(() => undefined)
    return {
      result,
      cancel: (reason?: Error) => {
        const w = this.#waiters.get(nodeId)
        if (w === undefined || w.attemptId !== params.attemptId) return
        clearTimeout(w.timer)
        this.#waiters.delete(nodeId)
        w.reject(reason ?? new HelmUpgradeCancelledError(`node ${nodeId} upgrade wait for cancelled`))
      },
    }
  }

  /** test inside omit: node is otherwise store in in-flight upgrade wait for. */
  has(nodeId: string): boolean {
    return this.#waiters.has(nodeId)
  }

  /**
   * upgrade heartbeat commit handle (noteHeartbeat internal invoke; already verify conn is when before connect),
   * return value i.e. heartbeat ACK:
   * - only conn.upgradeAttemptId === commit.attemptId(choose with the attempt register)
   *   and conn.version === commit.version(choose indeed run target version) only then legal;
   * - legal and store in wait for when again verify targetVersion / previousVersion fully
   *   consistent only then resolve(pid positive integer), inconsistent do not upside down pour other attempt, and ACK false
   *   (node based on this retry/rollback, never mistakenly with is Hub already confirm);
   * - legal but without wait for (such as local machine CLI upgrade after reconnect) treated as already accept (true).
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
    // when before connect must with the attempt register and already run target version (fabricate/expired commit reject).
    if (conn.upgradeAttemptId !== attemptId || conn.version !== version) {
      return false
    }
    const waiter = this.#waiters.get(nodeId)
    if (waiter === undefined) return true
    // wait for and commit must fully same source: different attempt/version late to commit do not upside down pour.
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

  /** closure stop: all wait for clean up and with unify reason reject(registry.close invoke). */
  rejectAll(reason: Error): void {
    for (const [nodeId, waiter] of [...this.#waiters]) {
      clearTimeout(waiter.timer)
      this.#waiters.delete(nodeId)
      waiter.reject(reason)
    }
  }
}
