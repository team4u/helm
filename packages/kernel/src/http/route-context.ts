/**
 * 领域路由共享的请求上下文与小工具（无业务语义）。
 *
 * RouteContext.segments 是已严格解码的路径段（'api' 前缀已剥离，非法
 * 百分号编码在进入领域 handler 前已由 routes.ts 统一解码为 400）。各
 * 领域 handler 只匹配自己前缀以下的段：方法 + 精确路径段匹配，段数
 * 必须完全一致，多余段一律返回领域内 404，绝不落入操作分支。
 */
import { HelmError } from '@helm/protocol'
import { errorResponse, readBinaryBodyWithLimit, readBody, DEFAULT_MAX_BODY_BYTES, type JsonRedactor } from './http-utils.js'
import { ValidationError } from './validate.js'

export interface RouteContext {
  request: Request
  method: string
  /** 已解码路径段（'api' 前缀已剥离）。 */
  segments: string[]
  url: URL
}

export function methodNotAllowed(redactor: JsonRedactor | undefined, method: string): Response {
  return errorResponse(redactor, 405, 'method_not_allowed', `方法不允许: ${method}`)
}

/** ?flag=1/true/0/false 查询参数：其他值 400（不猜测真值）。 */
export function parseOptionalBooleanFlag(url: URL, param: string): boolean | undefined {
  const raw = url.searchParams.get(param)
  if (raw === null) return undefined
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  throw new ValidationError(`${param} 需为 1/0 或 true/false`)
}

/** 读取可选 JSON body：空 body 返回 undefined（合法未指定），非法 JSON 仍 400。 */
export async function readOptionalJsonBody(request: Request): Promise<unknown> {
  const raw = await readBody(request, DEFAULT_MAX_BODY_BYTES)
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw))
  } catch {
    throw new HelmError('invalid_input', '请求体不是合法 JSON', 400)
  }
}

/**
 * 可选 JSON 对象 body：空 body 视为 {} 走 parse（与原实现一致，由 parse
 * 决定空对象是否合法）；非空则须为 JSON 对象（数组/标量拒绝）再走 parse。
 */
export async function parseOptionalJsonObjectBody<T>(
  request: Request,
  parse: (body: Record<string, unknown>) => T,
): Promise<T> {
  const raw = await readBinaryBodyWithLimit(request, 1024 * 1024)
  if (raw.length === 0) return {} as T
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new ValidationError('请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('请求体需为 JSON 对象')
  }
  return parse(parsed as Record<string, unknown>)
}
