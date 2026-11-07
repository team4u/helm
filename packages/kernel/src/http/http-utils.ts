/**
 * HTTP 边界基础设施：错误信封、CORS、body 读取与限制。
 *
 * - 成功：直接实体/数组（不包 data）。
 * - 失败：{ error: { code, message, details? } }；HelmError 携带 status/code。
 * - unexpected 500：绝不把异常堆栈/内部秘密返回客户端。
 * - 出站 JSON 一律先经 redactJsonValue 按值脱敏（stash marker 保持脱敏，
 *   含引号/换行的 secret 也不会因序列化转义而漏出），再序列化。
 */
import { HelmError } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024 // 1 MiB
/** 超大 workflow 脚本上限（另行验证）。 */
export const MAX_WORKFLOW_BODY_BYTES = 512 * 1024 // 512 KiB

/** 允许携带凭据的前端开发源（不限制任何来源）。 */
export const ALLOWED_CORS_ORIGINS = ['*']

/** 无 stash（未接机密服务）时的恒等脱敏：值本身已是安全产物。 */
const identityRedact = (text: string): string => text

/**
 * 深度丢弃对象上的 undefined 属性（与 JSON.stringify 的对象语义一致：
 * 可选字段缺省即省略）。数组元素中的 undefined 不在此豁免（仍由
 * redactJsonValue 显式拒绝——那是真正的违约输出，不是缺省字段）。
 */
function omitUndefinedProperties(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value // 环结构交由 redactJsonValue 判定
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

/** 出站 JSON 脱敏器：递归处理字符串值后序列化；非法 JSON 值（循环/
 *  undefined/NaN/稀疏数组/非 JSON 对象）由 redactJsonValue 显式抛错。 */
export interface JsonRedactor {
  (value: unknown): string
}

export function jsonOk(redact: JsonRedactor | undefined, body: unknown, init?: ResponseInit): Response {
  // 合法 null 原样返回；undefined 是 output 边界违约（伪造成功即造假），
  // 显式 500 交由上层定位。循环/非 JSON 值同理由 redactJsonValue 拒绝。
  if (body === undefined) {
    throw new HelmError('invalid_output', '服务返回 undefined，拒绝序列化为成功响应', 500)
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

/** HelmError -> Response；其他异常一律 500 internal 且不泄漏堆栈。 */
export function errorToResponse(redactor: JsonRedactor | undefined, redactText: (text: string) => string, error: unknown): Response {
  if (error instanceof HelmError) {
    // details 可能携带内部值（含 secret），同样经脱敏序列化。
    return errorResponse(redactor, error.status, error.code, error.message, error.details)
  }
  // 诚实但不泄密：服务端日志保留可诊断信息（经 stash 脱敏），
  // 客户端只收稳定信封，绝不回传堆栈。
  console.error('[hub] unhandled error:', redactText(describeError(error)))
  return errorResponse(undefined, 500, 'internal_error', '服务器内部错误')
}

/** 错误可打印形态：Error 取 name+message+stack，其他取 String()。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// CORS：不限制任何来源，带 Origin 请求均反射并允许凭据
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
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v)
  return response
}

export function preflightResponse(origin: string | null): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

// ---------------------------------------------------------------------------
// Body：非法 JSON / 超限 / 编码统一拒绝
// ---------------------------------------------------------------------------

export class BodyError extends HelmError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status)
  }
}

/** 读取任意 JSON 值（对象/数组/标量/null 均可）。 */
export async function readJsonValue(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const raw = await readBody(request, maxBytes)
  if (raw.length === 0) {
    throw new BodyError('invalid_json', '请求体不能为空')
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new BodyError('invalid_json', '请求体不是合法 JSON')
  }
}

export async function readJsonBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const parsed = await readJsonValue(request, maxBytes)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BodyError('invalid_json', '请求体需为 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyError('body_too_large', `请求体超过上限 ${maxBytes} 字节`, 413)
  }
  const reader = request.body?.getReader()
  if (reader === undefined) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      total += value.byteLength
      if (total > maxBytes) {
        // 必须取消 reader，否则连接悬挂。
        await reader.cancel().catch(() => {})
        throw new BodyError('body_too_large', `请求体超过上限 ${maxBytes} 字节`, 413)
      }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * 二进制上传体读取（产物上传等跨平台场景）：content-length 预检 + 流式累加，
 * 超限立即取消 reader 并抛 413 artifact_too_large（错误码与产物语义对齐）。
 */
export async function readBinaryBodyWithLimit(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredHeader = request.headers.get('content-length')
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HelmError('artifact_too_large', `请求体超过 ${maxBytes} 字节上限`, 413, { maxBytes })
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
        throw new HelmError('artifact_too_large', `请求体超过 ${maxBytes} 字节上限`, 413, { maxBytes })
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
