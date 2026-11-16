/**
 * by execId dispatch node side streaming output event (WS+birpc call back another end).
 *
 * each RemoteExecutionEnv.exec in start RPC before register handler; node call back
 * onEnvExecOutput when by execId hit dispatch,exec after end unsubscribe.
 */

import type { EnvExecOutputEvent } from '@helm/protocol'

export class ExecOutputHub {
  #handlers = new Map<string, (event: EnvExecOutputEvent) => void>()

  /** node streaming call back entry (hang to birpc connect onEnvExecOutput on). */
  readonly onEnvExecOutput = (event: EnvExecOutputEvent): void => {
    if (event === null || typeof event !== 'object') return
    const handler = this.#handlers.get(event.execId)
    if (handler !== undefined) {
      try {
        handler(event)
      } catch {
        // single handler fault does not affect other dispatch.
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
