import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'

/**
 * Herdr transport-layer shared primitives: error types and abort/Context helpers.
 *
 * Split out of transport.ts (behavior line-for-line equivalent to before the split): shared by
 * transport.ts (IPC core), transport-output.ts (handoff file IO) and transport-gate.ts (Gate
 * execution); the three modules stay dependency-acyclic; HerdrTransportError is still re-exported
 * by transport.ts, so existing importers (executor / rpc / tests) are unaffected.
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
