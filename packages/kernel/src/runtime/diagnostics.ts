/**
 * 内核轻量诊断通道（DiagnosticSink）。
 *
 * 将内核内部非致命/异步告警与致命故障日志统一收拢到结构化事件，
 * 在分发前强制经过 SecretStash 脱敏（message 与 error 均脱敏），
 * 缺省输出至 console.error（stderr，不污染 CLI stdout）；单测与宿主可注入
 * onDiagnostic 捕获断言，不再四处散落裸 console.error。
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

/** 安全格式化任意抛出值（兼容无原型对象等，绝不因格式化本身再抛异常）。 */
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
 * 组装脱敏后的诊断事件并投递给目标 sink（缺省走 defaultDiagnosticSink）。
 * 上报自身异常被就地隔离，绝不反噬调用方或阻断关停路径。
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
    /* 诊断上报自身不得再抛 */
  }
}

/** 构造绑定了固定 sink 与脱敏函数的诊断发射器。 */
export function createDiagnosticEmitter(
  options: {
    sink?: KernelDiagnosticSink
    redact?: (text: string) => string
  } = {},
): KernelDiagnosticEmitter {
  return (input) => emitDiagnostic(options.sink, options.redact, input)
}
