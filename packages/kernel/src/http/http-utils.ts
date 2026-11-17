/**
 * HTTP boundary primitives: error envelopes, CORS, body reading, and size limits.
 *
 * - Success: raw entity or array (not wrapped in `{ data }`).
 * - Failure: `{ error: { code, message, details? } }`; HelmError carries status and code.
 * - Unexpected 500: never leaks stack traces or internal secrets to clients.
 * - Outbound JSON is redacted value-by-value through redactJsonValue (preserving stash markers and
 *   preventing secrets with quotes/newlines from escaping via serialization) before stringifying.
 */
import { HelmError } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'

// BodyError/readBody are consolidated in @helm/protocol (single shared implementation for kernel and plugins);
// imported here for internal kernel use and re-exported to keep existing relative imports stable.
import { BodyError, readBody } from '@helm/protocol'

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024 // 1 MiB

/** Identity redactor used when no secret stash is attached: values are already safe. */
const identityRedact = (text: string): string => text

/**
 * Recursively omit undefined properties on plain objects (matching JSON.stringify object semantics:
 * omitted optional fields). undefined array elements are NOT exempted here and are still explicitly
 * rejected by redactJsonValue as a contract violation.
 */
function omitUndefinedProperties(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value // cycle detection is handled by redactJsonValue
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => omitUndefinedProperties(item, seen))
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = omitUndefinedProperties(item, seen)
  }
  return out
}

export function makeJsonRedactor(redact?: (text: string) => string): JsonRedactor {
  if (redact === undefined) {
    return (value: unknown): string => JSON.stringify(redactJsonValue(omitUndefinedProperties(value, new WeakSet()), identityRedact))
  }
  return (value: unknown): string => JSON.stringify(redactJsonValue(omitUndefinedProperties(value, new WeakSet()), redact))
}

/** Outbound JSON redactor: recursively processes string values before serialization; rejects invalid JSON values (cycles/undefined/NaN/sparse arrays/non-plain objects) via redactJsonValue. */
export interface JsonRedactor {
  (value: unknown): string
}

export function jsonOk(redact: JsonRedactor | undefined, body: unknown, init?: ResponseInit): Response {
  // Valid null is returned as-is; undefined violates the output contract (must not fabricate success)
  // and fails explicitly with 500 for upstream diagnosis. Cycles and non-JSON values are also rejected by redactJsonValue.
  if (body === undefined) {
    throw new HelmError('invalid_output', 'service returned undefined; refusing to serialize as a success response', 500)
  }
  const serialize = redact ?? makeJsonRedactor()
  return new Response(serialize(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  })
}

export function errorResponse(
  redact: JsonRedactor | undefined,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const serialize = redact ?? makeJsonRedactor()
  const envelope: Record<string, unknown> = { code, message }
  if (details !== undefined) envelope.details = details
  return new Response(serialize({ error: envelope }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** HelmError -> Response; all other exceptions become 500 internal_error without leaking stack traces. */
export function errorToResponse(redactor: JsonRedactor | undefined, redactText: (text: string) => string, error: unknown): Response {
  if (error instanceof HelmError) {
    // details may contain internal values (including secrets), so serialize through redaction too.
    return errorResponse(redactor, error.status, error.code, error.message, error.details)
  }
  // Honest without leaking: preserve redacted diagnostics in server logs while sending only a stable envelope to clients.
  console.error('[hub] unhandled error:', redactText(describeError(error)))
  return errorResponse(undefined, 500, 'internal_error', 'internal server error')
}

/** Printable error summary: name + message + stack for Error instances, String() otherwise. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// CORS: unrestricted origin—reflect Origin and allow credentials on requests carrying Origin
// ---------------------------------------------------------------------------

export function corsHeaders(origin: string | null): Record<string, string> {
  if (origin === null) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-artifact-filename,x-artifact-mime-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

export function withCors(response: Response, origin: string | null): Response {
  const headers = corsHeaders(origin)
  if (Object.keys(headers).length === 0) return response
  for (const [k, v] of Object.entries(headers)) {
    if (k !== 'vary') response.headers.set(k, v)
  }
  const vary = new Set((response.headers.get('vary') ?? '').split(',').map((token) => token.trim()).filter(Boolean))
  if (![...vary].some((token) => token.toLowerCase() === '*')) {
    if (![...vary].some((token) => token.toLowerCase() === 'origin')) vary.add('Origin')
    response.headers.set('vary', [...vary].join(', '))
  }
  return response
}

export function preflightResponse(origin: string | null): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

// ---------------------------------------------------------------------------
// Body parsing: reject invalid JSON, oversized payloads, and bad encodings uniformly
// ---------------------------------------------------------------------------

/** Read any JSON value (object, array, scalar, or null). */
export async function readJsonValue(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const raw = await readBody(request, maxBytes)
  if (raw.length === 0) {
    throw new BodyError('invalid_json', 'request body cannot be empty')
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new BodyError('invalid_json', 'request body is not valid JSON')
  }
}

export async function readJsonBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const parsed = await readJsonValue(request, maxBytes)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BodyError('invalid_json', 'request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Read binary upload body (cross-platform artifact uploads, etc.): content-length preflight + streaming
 * byte counter; cancels the reader immediately on overflow and throws 413 artifact_too_large.
 */
export async function readBinaryBodyWithLimit(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredHeader = request.headers.get('content-length')
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HelmError('artifact_too_large', `request body exceeds ${maxBytes} byte limit`, 413, { maxBytes })
    }
  }
  const reader = request.body?.getReader()
  if (reader === undefined) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new HelmError('artifact_too_large', `request body exceeds ${maxBytes} byte limit`, 413, { maxBytes })
      }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export { BodyError, readBody }
