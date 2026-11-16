/**
 * kernel light amount diagnose channel (DiagnosticSink).
 *
 * kernel internal non- lead to life/async alert and lead to life fault log unify gather to structure event,
 * in dispatch before force through SecretStash redaction (message and error all redaction),
 * default output until console.error(stderr, do not pollute CLI stdout); single test and host can inject
 * onDiagnostic catch assertion, no longer four where scatter bare console.error.
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

/** security format any throw value (compatibility without prototype object etc., never because format itself again throw exception). */
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
 * group install redaction after diagnose event and delivery to target sink(default away defaultDiagnosticSink).
 * on report itself exception by then ground isolated, never reverse devour caller or block assert closure stop path.
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
    /* diagnose on report itself must not again throw */
  }
}

/** construct bind set fixed sink and redaction function diagnose shoot. */
export function createDiagnosticEmitter(
  options: {
    sink?: KernelDiagnosticSink
    redact?: (text: string) => string
  } = {},
): KernelDiagnosticEmitter {
  return (input) => emitDiagnostic(options.sink, options.redact, input)
}
