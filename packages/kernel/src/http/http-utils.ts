/**
 * HTTP 边界基础设施：错误信封、CORS、body 读取与限制。
 *
 * - 成功：直接实体/数组（不包 data）。
 * - 失败：{ error: { code, message, details? } }；HelmError 携带 status/code。
 * - unexpected 500：绝不把异常堆栈/内部秘密返回客户端。
 */
import { HelmError } from '@helm/protocol'

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024 // 1 MiB
/** 超大 workflow 脚本上限（另行验证）。 */
export const MAX_WORKFLOW_BODY_BYTES = 512 * 1024 // 512 KiB

/** 允许携带凭据的前端开发源（Vite dev 3201；不通配凭据）。 */
export const ALLOWED_CORS_ORIGINS = [
  'http://localhost:3201',
  'http://127.0.0.1:3201',
]

export function jsonOk(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body === undefined ? null : body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  })
}

export function errorResponse(status: number, code: string, message: string, details?: unknown): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  )
}

/** HelmError -> Response；其他异常一律 500 internal 且不泄漏堆栈。 */
export function errorToResponse(error: unknown): Response {
  if (error instanceof HelmError) {
    return errorResponse(error.status, error.code, error.message, error.details)
  }
  // 诚实但不泄密：服务端日志保留完整错误，客户端只收稳定信封。
  console.error('[hub] unhandled error:', error)
  return errorResponse(500, 'internal_error', '服务器内部错误')
}

// ---------------------------------------------------------------------------
// CORS：默认同源；仅显式允许 3201 前端 dev 源，凭据不通配
// ---------------------------------------------------------------------------

export function corsHeaders(origin: string | null): Record<string, string> {
  if (origin === null || !ALLOWED_CORS_ORIGINS.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
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

export async function readJsonBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const raw = await readBody(request, maxBytes)
  if (raw.length === 0) {
    throw new BodyError('invalid_json', '请求体不能为空')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new BodyError('invalid_json', '请求体不是合法 JSON')
  }
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
