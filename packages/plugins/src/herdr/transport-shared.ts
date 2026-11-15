import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'

/**
 * Herdr 传输层共享基元：错误类型与 abort/Context 助手。
 *
 * 从 transport.ts 拆出（行为与拆分前逐行等价）：transport.ts（IPC 核心）、
 * transport-output.ts（交接文件 IO）与 transport-gate.ts（Gate 执行）共用，
 * 三个模块间保持依赖无环；HerdrTransportError 仍由 transport.ts re-export，
 * 既有导入方（executor / rpc / 测试）不受拆分影响。
 */

export class HerdrTransportError extends Error {
  readonly code: string
  readonly target: string

  constructor(code: string, message: string, target: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HerdrTransportError'
    this.code = code
    this.target = target
  }
}

export function checkAborted(signal: AbortSignal | undefined, target: string): void {
  if (signal?.aborted) throw new HerdrTransportError('herdr_aborted', 'operation aborted', target)
}

export function contextOf(signal: AbortSignal | undefined, target: string): Context {
  checkAborted(signal, target)
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
}
