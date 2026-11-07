/**
 * 按 execId 分发节点侧流式输出事件（WS+birpc 回调的另一端）。
 *
 * 每个 RemoteExecutionEnv.exec 在发起 RPC 前注册 handler；节点回调
 * onEnvExecOutput 时按 execId 命中分发，exec 结束后 unsubscribe。
 */

import type { EnvExecOutputEvent } from '@helm/protocol'

export class ExecOutputHub {
  #handlers = new Map<string, (event: EnvExecOutputEvent) => void>()

  /** 节点流式回调入口（挂到 birpc 连接的 onEnvExecOutput 上）。 */
  readonly onEnvExecOutput = (event: EnvExecOutputEvent): void => {
    if (event === null || typeof event !== 'object') return
    const handler = this.#handlers.get(event.execId)
    if (handler !== undefined) {
      try {
        handler(event)
      } catch {
        // 单个 handler 故障不影响其他分发。
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
