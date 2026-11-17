/**
 * Lightweight kernel diagnostic channel (DiagnosticSink).
 *
 * Non-fatal/async warnings and fatal error logs inside the kernel are funneled into structured events,
 * forcibly scrubbed through SecretStash redaction before dispatch (redacting both message and error),
 * and written to console.error by default (stderr, avoiding polluting CLI stdout); unit tests and hosts can inject
 * onDiagnostic to capture and assert events instead of scattering bare console.error calls.
 */

export type KernelDiagnosticLevel = 'error' | 'warn' | 'info'

export interface KernelDiagnosticEvent {
  readonly level: KernelDiagnosticLevel
  readonly source: string
  readonly message: string
  readonly error?: string
  readonly conversationId?: number
}

export type KernelDiagnosticSink = (event: KernelDiagnosticEvent) => void

export interface KernelDiagnosticInput {
  readonly level?: KernelDiagnosticLevel
  readonly source: string
  readonly message: string
  readonly error?: unknown
  readonly conversationId?: number
}

export type KernelDiagnosticEmitter = (input: KernelDiagnosticInput) => void

/** Safely format any thrown value (supports null-prototype objects, etc., and never throws during formatting). */
export function formatDiagnosticError(error: unknown): string {
  if (error instanceof Error) {
    const header = `${error.name}: ${error.message}`
    if (typeof error.stack === 'string' && error.stack !== '') {
      return error.stack.startsWith(header) ? error.stack : `${header}\n${error.stack}`
    }
    return header
  }
  try {
    return String(error)
  } catch {
    return '[unprintable error]'
  }
}

export const defaultDiagnosticSink: KernelDiagnosticSink = (event) => {
  const prefix = `[helm] [${event.source}]`
  const conv = event.conversationId !== undefined ? ` (conversation ${event.conversationId})` : ''
  if (event.error !== undefined) {
    console.error(`${prefix}${conv} ${event.message}:`, event.error)
  } else {
    console.error(`${prefix}${conv} ${event.message}`)
  }
}

/**
 * Assemble a redacted diagnostic event and deliver it to the target sink (defaults to defaultDiagnosticSink).
 * Reporting exceptions are isolated locally and never thrown back to callers or block abort/shutdown paths.
 */
export function emitDiagnostic(
  sink: KernelDiagnosticSink | undefined,
  redact: ((text: string) => string) | undefined,
  input: KernelDiagnosticInput,
): void {
  const safeRedact = redact ?? ((text: string) => text)
  const event: KernelDiagnosticEvent = {
    level: input.level ?? 'error',
    source: input.source,
    message: safeRedact(input.message),
    ...(input.error !== undefined ? { error: safeRedact(formatDiagnosticError(input.error)) } : {}),
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
  }
  try {
    ;(sink ?? defaultDiagnosticSink)(event)
  } catch {
    /* diagnostic reporting itself must never throw */
  }
}

/** Construct a diagnostic emitter bound to a fixed sink and redaction function. */
export function createDiagnosticEmitter(
  options: {
    sink?: KernelDiagnosticSink
    redact?: (text: string) => string
  } = {},
): KernelDiagnosticEmitter {
  return (input) => emitDiagnostic(options.sink, options.redact, input)
}
