/**
 * Dispatches node-side streaming output events by `execId` (WS + birpc callback from the node).
 *
 * Each `RemoteExecutionEnv.exec` registers a handler before starting the RPC; when the node calls
 * `onEnvExecOutput`, the event is routed by `execId` and unsubscribed once `exec` finishes.
 */

import type { EnvExecOutputEvent } from '@helmx/protocol'

export class ExecOutputHub {
  #handlers = new Map<string, (event: EnvExecOutputEvent) => void>()

  /** Node streaming callback entry point (wired to birpc `onEnvExecOutput`). */
  readonly onEnvExecOutput = (event: EnvExecOutputEvent): void => {
    if (event === null || typeof event !== 'object') return
    const handler = this.#handlers.get(event.execId)
    if (handler !== undefined) {
      try {
        handler(event)
      } catch {
        // A single handler failure must not disrupt dispatching to others.
      }
    }
  }

  subscribe(execId: string, handler: (event: EnvExecOutputEvent) => void): void {
    this.#handlers.set(execId, handler)
  }

  unsubscribe(execId: string): void {
    this.#handlers.delete(execId)
  }

  get size(): number {
    return this.#handlers.size
  }
}
