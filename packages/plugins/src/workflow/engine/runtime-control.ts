/**
 * runtime-control.ts -- run-level coordination primitives: the concurrency semaphore and the pause/skip/retry control board.
 *
 * Split out of runtime.ts (semantics preserved line by line):
 * - Semaphore: global agent concurrency permits (release hands the permit directly to the next
 *   waiter, so a wave of releases never admits over-limit concurrency; drain wakes all waiters
 *   at run termination).
 * - RuntimeControl: the explicit class-ization of the pause gates (pauseGate / actionPauseGate),
 *   pauseWaiters and the liveAgents table formerly scattered in the runWorkflow closure. The host
 *   (abortAgent) and the "run already stopped" predicate (aborted || settled) are injected via
 */

import type { WorkflowControl, WorkflowHost } from './runtime-types.js'

export class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    // Hand the permit directly to the next waiter; decrement-then-increment would let one release wave admit over-limit concurrency.
    if (next) next()
    else this.active--
  }

  drain(): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.()
    }
  }
}

/** The control-plane state of one in-flight agent call (skip/retry intent and pause wake handles). */
export interface LiveAgent {
  agentId: string
  started: boolean
  intent?: 'skip' | 'retry'
  wake?: () => void
}

/**
 * The pause / skip / retry control board. All operations are idempotent best-effort, line-for-line
 * matching the former closure implementation:
 * - after pause, new acquire loops hang on the gate; resume / run termination wake uniformly;
 * - skip only sets intent for un-started calls (consumed before start), and aborts the host agent for started calls;
 */
export class RuntimeControl {
  private paused = false
  private readonly pauseWaiters = new Set<() => void>()
  readonly liveAgents = new Map<number, LiveAgent>()

  constructor(
    private readonly host: Pick<WorkflowHost, 'abortAgent'>,
    /** Once the run reaches a terminal state (aborted || settled), the pause gate hangs no new waiters. */
    private readonly isStopped: () => boolean,
  ) {}

  isPaused(): boolean {
    return this.paused
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.releasePause()
  }

  /** Wake all paused waiters (shared by run termination / resume). */
  releasePause(): void {
    for (const wake of [...this.pauseWaiters]) wake()
    this.pauseWaiters.clear()
  }

  pauseGate(live: LiveAgent): Promise<void> {
    if (!this.paused || this.isStopped()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = () => {
        this.pauseWaiters.delete(wake)
        live.wake = undefined
        resolve()
      }
      live.wake = wake
      this.pauseWaiters.add(wake)
    })
  }

  actionPauseGate(): Promise<void> {
    if (!this.paused || this.isStopped()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = () => {
        this.pauseWaiters.delete(wake)
        resolve()
      }
      this.pauseWaiters.add(wake)
    })
  }

  skip(index: number): boolean {
    const live = this.liveAgents.get(index)
    if (live === undefined || live.intent !== undefined) return false
    live.intent = 'skip'
    if (live.started) this.host.abortAgent(live.agentId)
    else live.wake?.()
    return true
  }

  retry(index: number): boolean {
    const live = this.liveAgents.get(index)
    if (live === undefined || !live.started || live.intent !== undefined) return false
    live.intent = 'retry'
    this.host.abortAgent(live.agentId)
    return true
  }

  /** The public control plane exposed to onControl (idempotent best-effort). */
  toControl(): WorkflowControl {
    return {
      pause: () => this.pause(),
      resume: () => this.resume(),
      isPaused: () => this.isPaused(),
      skip: (index) => this.skip(index),
      retry: (index) => this.retry(index),
    }
  }
}
