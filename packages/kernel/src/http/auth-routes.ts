/**
 * 鉴权领域路由：GET /api/auth/status、POST /api/auth/setup、
 * POST /api/auth/login（三端点公开，hub.ts 前置放行；其余 auth 子路径 404）。
 */
import type { JsonSchema } from '@helm/protocol'
import { jsonOk, errorResponse, readJsonBody, type JsonRedactor } from './http-utils.js'
import type { KernelRuntimeLike } from './contracts.js'
import { assertBodySchema } from './validate.js'
import type { RouteContext } from './route-context.js'

// setup/login 历史上接受多余字段（未做 unknown-key 拒绝），schema 保持同一
// 宽容度：只约束 password 本身的形状。
const AUTH_PASSWORD_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { password: { type: 'string', minLength: 1 } },
  required: ['password'],
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  if (header === null) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? undefined
}

export async function handleAuthDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  if (second === 'status' && method === 'GET' && third === undefined) {
    const status = await kernel.auth.status()
    // authenticated 如实反映本次请求的 Bearer token 校验结果；
    // 未配置 / 无 token / 错误 token 一律 false，configured 独立汇报。
    const token = bearerToken(ctx.request)
    const authenticated = token !== undefined && (await kernel.auth.verifyToken(token)) === true
    return jsonOk(redactor, { configured: status.configured, authenticated })
  }
  if (second === 'setup' && method === 'POST' && third === undefined) {
    const body = await readJsonBody(ctx.request)
    assertBodySchema(AUTH_PASSWORD_BODY_SCHEMA, body, 'auth setup body')
    const issued = await kernel.auth.setup(body.password as string)
    return jsonOk(redactor, { token: issued.token })
  }
  if (second === 'login' && method === 'POST' && third === undefined) {
    const body = await readJsonBody(ctx.request)
    assertBodySchema(AUTH_PASSWORD_BODY_SCHEMA, body, 'auth login body')
    const issued = await kernel.auth.login(body.password as string)
    return jsonOk(redactor, { token: issued.token })
  }
  return errorResponse(redactor, 404, 'not_found', '路由不存在')
}
