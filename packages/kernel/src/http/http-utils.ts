/**
 * HTTP boundary basis set apply: error message seal,CORS,body read and restrict.
 *
 * - succeeded: directly entity/array (do not package data).
 * - failed:{ error: { code, message, details? } };HelmError carry status/code.
 * - unexpected 500: never exception stack/internal secret return client.
 * - out station JSON one rule first via redactJsonValue by value redaction (stash marker keep redaction,
 *   contains quotes/newline secret also will not because serialization escaping while leak out), again serialization.
 */
import { HelmError } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'

// BodyError/readBody already consolidate @helm/protocol(kernel and plugin sharing unique implement);
// this where import kernel inside use, and by this module again export supply since has relative path reference keep stable.
import { BodyError, readBody } from '@helm/protocol'

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024 // 1 MiB

/** without stash(not connect secret service) when constant etc. redaction: value itself already is security artifact. */
const identityRedact = (text: string): string => text

/**
 * deep discard object on undefined property (and JSON.stringify object semantics consistent:
 * optional field default i.e. omit). array element in undefined do not in this exemption (still by
 * redactJsonValue explicit reject - - that is truly violate about output, is not default field).
 */
function omitUndefinedProperties(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value // ring structure hand over by redactJsonValue decide
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

/** out station JSON redaction: recursion handle string value after serialization; illegal JSON value (loop/
 *  undefined/NaN/sparse array/non- JSON object) by redactJsonValue explicit throws. */
export interface JsonRedactor {
  (value: unknown): string
}

export function jsonOk(redact: JsonRedactor | undefined, body: unknown, init?: ResponseInit): Response {
  // legal null original return;undefined is output boundary violate about (fabricate succeeded i.e. build false),
  // explicit 500 hand over by on layer locate. loop/non- JSON value same by redactJsonValue reject.
  if (body === undefined) {
    throw new HelmError('invalid_output', 'service return undefined, reject serialization is succeeded response', 500)
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

/** HelmError -> Response; other exception one rule 500 internal and without leaking stack. */
export function errorToResponse(redactor: JsonRedactor | undefined, redactText: (text: string) => string, error: unknown): Response {
  if (error instanceof HelmError) {
    // details may carry internal value (contains secret), same via redaction serialization.
    return errorResponse(redactor, error.status, error.code, error.message, error.details)
  }
  // honest but do not leak: server side log keep can diagnose information (via stash redaction),
  // client only stable message seal, never back pass stack.
  console.error('[hub] unhandled error:', redactText(describeError(error)))
  return errorResponse(undefined, 500, 'internal_error', 'server internal error')
}

/** error can print form:Error take name+message+stack, other take String(). */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// CORS: do not restrict any source, carries Origin request all reflection and allows credentials
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
// Body: illegal JSON / over limit / encode unify reject
// ---------------------------------------------------------------------------

/** read any JSON value (object/array/mark amount/null all can). */
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
    throw new BodyError('invalid_json', 'request body is not legal JSON')
  }
}

export async function readJsonBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const parsed = await readJsonValue(request, maxBytes)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BodyError('invalid_json', 'request body must be JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * two enter system upload body read (artifact upload etc. across platform scenario):content-length preflight + streaming accumulate add,
 * over limit immediately cancel reader and throw 413 artifact_too_large(error code and artifact semantics align).
 */
export async function readBinaryBodyWithLimit(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredHeader = request.headers.get('content-length')
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HelmError('artifact_too_large', `request body exceeds ${maxBytes} byte cap`, 413, { maxBytes })
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
        throw new HelmError('artifact_too_large', `request body exceeds ${maxBytes} byte cap`, 413, { maxBytes })
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

/** RFC 5987 / ASCII fallback content-disposition header for binary/file downloads. */
export function buildContentDisposition(name: string, inline: boolean): string {
  const disposition = inline ? 'inline' : 'attachment'
  const fallbackName = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encodedName = encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`
}

export { BodyError, readBody }
