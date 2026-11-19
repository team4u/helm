/**
 * upgrade-waiters.ts: node upgrade waiter set (split out of `env/registry.ts`).
 *
 * Responsibilities: allows at most one in-flight upgrade waiter per node, handles terminal settlement
 * and shutdown cleanup; resolves only via a matching heartbeat commit (upgrade confirmation can only come
 * from the candidate's own commit heartbeat—registration or disconnect never settles the waiter because the
 * upgrade process restarts and replaces the old connection). Bounded in-memory promise: settled by cancel,
 * timeout, `registry.close`, or matching commit, never dangling. Matches the pre-split inline implementation.
 */
import { HelmxError } from '@helmx/protocol'
import type { NodeUpgradeResult } from '@helmx/protocol'

/** Upgrade waiter: bounded in-memory promise resolved only by a matching heartbeat commit. */
interface UpgradeWaiter {
  nodeId: string
  attemptId: string
  targetVersion: string
  previousVersion: string
  resolve: (result: NodeUpgradeResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Controllable waiter handle returned by `beginUpgrade`. */
export interface UpgradeWaiterHandle {
  /** Terminal upgrade promise: resolves only on matching heartbeat commit; rejects on timeout/cancel/shutdown. */
  result: Promise<NodeUpgradeResult>
  /** Actively cancel (cleans up waiter; `reason` becomes the rejection error). */
  cancel(reason?: Error): void
}

/** Concurrent upgrade waiter rejected on the same node (caller maps to 409). */
export class HelmxUpgradeBusyError extends Error {}
/** Upgrade wait timed out (no matching commit received). */
export class HelmxUpgradeTimeoutError extends Error {}
/** Upgrade wait was explicitly cancelled. */
export class HelmxUpgradeCancelledError extends Error {}

/**
 * Upgrade waiter set. The registry layer handles close gating and forwarding; this class is unaware of the connection pool.
 */
export class UpgradeWaiterSet {
  readonly #waiters = new Map<string, UpgradeWaiter>()

  /**
   * Create an upgrade waiter: resolves only on a matching heartbeat `upgradeCommit`;
   * rejects on timeout or `cancel()` (disconnecting the old socket does not settle the waiter because
   * the upgrade itself restarts and replaces the old connection). Rejects concurrent upgrade waiters on the same node (`HelmxUpgradeBusyError`).
   */
  begin(
    nodeId: string,
    params: { attemptId: string; targetVersion: string; previousVersion: string; timeoutMs: number },
  ): UpgradeWaiterHandle {
    if (this.#waiters.has(nodeId)) {
      throw new HelmxUpgradeBusyError(`node ${nodeId} already has an in-flight upgrade waiter`)
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
            w.reject(new HelmxUpgradeTimeoutError(
              `node ${nodeId} upgrade to ${params.targetVersion} was not confirmed within ${params.timeoutMs}ms`,
            ))
          }
        }, params.timeoutMs),
      }
      waiter.timer.unref?.()
      this.#waiters.set(nodeId, waiter)
    })
    // Guard against unhandledRejection: callers always await `result`, but prevent crashing if rejected before await.
    result.catch(() => undefined)
    return {
      result,
      cancel: (reason?: Error) => {
        const w = this.#waiters.get(nodeId)
        if (w === undefined || w.attemptId !== params.attemptId) return
        clearTimeout(w.timer)
        this.#waiters.delete(nodeId)
        w.reject(reason ?? new HelmxUpgradeCancelledError(`node ${nodeId} upgrade wait cancelled`))
      },
    }
  }

  /** Test-only helper: whether the node currently has an in-flight upgrade waiter. */
  has(nodeId: string): boolean {
    return this.#waiters.has(nodeId)
  }

  /**
   * Handle upgrade heartbeat commit (invoked inside `noteHeartbeat` after confirming `conn` is the current connection);
   * return value becomes the heartbeat ACK:
   * - valid only when `conn.upgradeAttemptId === commit.attemptId` (candidate registered for this attempt)
   *   and `conn.version === commit.version` (candidate is actually running the target version);
   * - when valid and a waiter exists, also require exact `targetVersion` / `previousVersion` match before
   *   resolving (positive integer `pid`); mismatches never spill over to other attempts and ACK `false`
   *   (so the node retries/rolls back rather than falsely assuming Hub confirmation);
   * - valid commit with no active waiter (e.g. reconnect after local CLI upgrade) counts as accepted (`true`).
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
    // Current connection must have registered for this attempt and already be running the target version (reject forged/stale commits).
    if (conn.upgradeAttemptId !== attemptId || conn.version !== version) {
      return false
    }
    const waiter = this.#waiters.get(nodeId)
    if (waiter === undefined) return true
    // Waiter and commit must share the exact same attempt and versions: late commits never cross-contaminate.
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

  /** Shutdown: clean up all waiters and reject them with a unified reason (called by `registry.close`). */
  rejectAll(reason: Error): void {
    for (const [nodeId, waiter] of [...this.#waiters]) {
      clearTimeout(waiter.timer)
      this.#waiters.delete(nodeId)
      waiter.reject(reason)
    }
  }
}
