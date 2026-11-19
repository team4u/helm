/**
 * Cross-runtime shared error contract: dependency-free Error subclasses that support direct instanceof checks.
 * HTTP layer convention: success returns the entity/array directly; failure returns { error: { code, message, details? } }.
 */

/** Error response body (the inner shape of `ApiErrorBody['error']`). */
export interface HelmxErrorDetail {
  code: string
  message: string
  details?: unknown
}

/**
 * Machine-readable error code + HTTP status error.
 * `code` is stable (e.g. 'validation_error', 'not_found',
 * 'plugin_has_live_tasks'); `message` is human-facing; `details` carries extra diagnostics.
 */
export class HelmxError extends Error {
  readonly code: string
  /** HTTP status code, defaults to 400. */
  readonly status: number
  readonly details?: unknown

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message)
    this.name = 'HelmxError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}
