/**
 * domain routing sharing request context and small tool (without business semantics).
 *
 * RouteContext.segments is already strictly decode path segment ('api' prefix already strip, illegal
 * hundred number encode in enter domain handler before already by routes.ts unify decode is 400). each
 * domain handler only match itself prefix or fewer segment: method + precise path segment match, segment count
 * must fully consistent, redundant segment one rule return domain inside 404, never operation branch.
 */
import { HelmError } from '@helm/protocol'
import { errorResponse, readBinaryBodyWithLimit, readBody, DEFAULT_MAX_BODY_BYTES, type JsonRedactor } from './http-utils.js'
import { ValidationError } from './validate.js'

export interface RouteContext {
  request: Request
  method: string
  /** already decode path segment ('api' prefix already strip). */
  segments: string[]
  url: URL
}

export function methodNotAllowed(redactor: JsonRedactor | undefined, method: string): Response {
  return errorResponse(redactor, 405, 'method_not_allowed', `method disallows: ${method}`)
}

/** ?flag=1/true/0/false query parameter: other value 400(do not guess true value). */
export function parseOptionalBooleanFlag(url: URL, param: string): boolean | undefined {
  const raw = url.searchParams.get(param)
  if (raw === null) return undefined
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  throw new ValidationError(`${param} must be 1/0 or true/false`)
}

/** read optional JSON body: empty body return undefined(legal not designate), illegal JSON still 400. */
export async function readOptionalJsonBody(request: Request): Promise<unknown> {
  const raw = await readBody(request, DEFAULT_MAX_BODY_BYTES)
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw))
  } catch {
    throw new HelmError('invalid_input', 'request body is not legal JSON', 400)
  }
}

/**
 * optional JSON object body: empty body treated as {} away parse(and original implement consistent, by parse
 * decide empty object is otherwise legal); non-empty then must is JSON object (array/mark amount reject) again away parse.
 */
export async function parseOptionalJsonObjectBody<T>(
  request: Request,
  parse: (body: Record<string, unknown>) => T,
): Promise<T> {
  const raw = await readBinaryBodyWithLimit(request, 1024 * 1024)
  if (raw.length === 0) return parse({})
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new ValidationError('request body is not legal JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('request body must be JSON object')
  }
  return parse(parsed as Record<string, unknown>)
}
