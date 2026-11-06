/**
 * 跨端共享错误契约：零依赖、可直接 instanceof 的 Error 子类。
 * HTTP 层约定：成功返回直接实体/数组；失败返回 { error: { code, message, details? } }。
 */

/** 错误响应体（`ApiErrorBody['error']` 的内层形状）。 */
export interface HelmErrorDetail {
  code: string
  message: string
  details?: unknown
}

/**
 * 机器可读错误码 + HTTP 状态码的错误。
 * code 稳定（如 'root_conversation_protected'、'validation_error'、
 * 'plugin_has_live_tasks'），message 面向人类，details 附加诊断。
 */
export class HelmError extends Error {
  readonly code: string
  /** HTTP 状态码，默认 400。 */
  readonly status: number
  readonly details?: unknown

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message)
    this.name = 'HelmError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}
