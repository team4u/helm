/**
 * createHubHandler：Web Standard 请求处理器（核心路由 + 鉴权门禁 + CORS）。
 *
 * 鉴权策略：
 * - 公开端点：/api/auth/setup、/api/auth/login、/api/auth/status、
 *   插件 route({ public: true })（插件自行验签）。
 * - 其余一律 Bearer token 经 kernel.auth.verifyToken；无匿名初始化漏洞。
 *
 * public 插件路由豁免与 routes.ts 的派发共用同一完整路径匹配器
 * （route-match.ts），两处语义不会漂移；路径段非法百分号编码统一 400。
 *
 * 跨站写防护：CORS 仅不加响应头，挡不住 no-cors 的 text/plain 简单 POST。
 * 故带 Origin 的状态变更请求（POST/PUT/PATCH/DELETE）仅允许同源或
 * ALLOWED_CORS_ORIGINS 白名单（本地 3201 前端 dev），否则 403
 * origin_not_allowed；不带 Origin 的 CLI/服务端调用不受影响。
 * JSON 端点同时校验 content-type application/json（charset 可选），
 * 拒绝跨站表单/text-simple POST 冒充 JSON；插件 public 原始路由不强制
 * JSON（webhook 载荷形态由插件自定），Origin 策略同样适用。
 *
 * SSE：kernel.events.response() 由 runtime 提供；HTTP 层不做缓存/转换，
 * 断开（signal abort）由 events 实现负责取消订阅。
 */
import {
  ALLOWED_CORS_ORIGINS,
  errorResponse,
  errorToResponse,
  makeJsonRedactor,
  preflightResponse,
  withCors,
  type JsonRedactor,
} from './http-utils.js'
import { handleApi } from './routes.js'
import { decodeSegments, findPluginRoute, PathDecodeError } from './route-match.js'
import type { KernelRuntimeLike, WorkflowServiceLike } from './contracts.js'

export interface HubHandlerOptions {
  kernel: KernelRuntimeLike
  workflows: WorkflowServiceLike
}

const PUBLIC_PATHS = new Set(['/api/auth/setup', '/api/auth/login', '/api/auth/status'])

export function createHubHandler(kernel: KernelRuntimeLike, workflows: WorkflowServiceLike): (request: Request) => Promise<Response> {
  const redactor: JsonRedactor | undefined = makeRedactor(kernel)
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin')
    try {
      if (request.method === 'OPTIONS') {
        return preflightResponse(origin)
      }
      const url = new URL(request.url)

      if (!url.pathname.startsWith('/api/')) {
        return withCors(errorResponse(redactor, 404, 'not_found', '路由不存在'), origin)
      }

      // 去尾斜杠归一（/api/conversations/ 等价 /api/conversations）
      const normalized = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname

      // 跨站写防护：带 Origin 的状态变更请求仅放行同源/白名单源
      // （auth/setup|login 是最高危写入口，必须先于公开放行执行）。
      if (!originAllowed(request, origin, url)) {
        return withCors(errorResponse(redactor, 403, 'origin_not_allowed', `Origin 不受信任: ${origin}`), origin)
      }

      const segments = decodeSegments(normalized)

      if (PUBLIC_PATHS.has(normalized)) {
        // auth/setup|login 是 JSON 端点：跨站 text/plain 简单 POST 冒充被拒。
        if (request.method !== 'GET' && request.method !== 'HEAD' && !jsonContentTypeOk(request)) {
          return withCors(errorResponse(redactor, 415, 'unsupported_media_type', 'JSON 端点需 content-type: application/json'), origin)
        }
        return withCors(await handleApi(request, kernel, workflows, redactor), origin)
      }

      // 插件 public 路由豁免（其 handler 自行验签）；与派发共用匹配器。
      const isPublic = isPublicPluginRoute(kernel, request.method, segments)
      if (!isPublic && !isJsonEndpoint(request.method, normalized)) {
        // 非 JSON 端点（仅插件 public 原始路由）：不强制 JSON content-type。
      } else if (!jsonContentTypeOk(request)) {
        return withCors(errorResponse(redactor, 415, 'unsupported_media_type', 'JSON 端点需 content-type: application/json'), origin)
      }
      if (isPublic) {
        return withCors(await handleApi(request, kernel, workflows, redactor), origin)
      }

      const token = bearerToken(request)
      if (token === undefined) {
        return withCors(errorResponse(redactor, 401, 'unauthorized', '缺少 Bearer token'), origin)
      }
      const valid = await kernel.auth.verifyToken(token)
      if (valid !== true) {
        return withCors(errorResponse(redactor, 401, 'unauthorized', 'token 无效或已过期'), origin)
      }

      return withCors(await handleApi(request, kernel, workflows, redactor), origin)
    } catch (error) {
      // 非法路径编码（含 public 匹配阶段）也要给出结构化 400，而非 500。
      if (error instanceof PathDecodeError) {
        return withCors(errorResponse(redactor, 400, 'invalid_path_encoding', error.message), origin)
      }
      return withCors(errorToResponse(redactor, redactText(kernel), error), origin)
    }
  }
}

function makeRedactor(kernel: KernelRuntimeLike): JsonRedactor | undefined {
  const stash = kernel.stash
  if (stash === undefined) return undefined
  return makeJsonRedactor((text: string) => stash.redact(text))
}

function redactText(kernel: KernelRuntimeLike): (text: string) => string {
  const stash = kernel.stash
  if (stash === undefined) return (text: string) => text
  return (text: string) => stash.redact(text)
}

/** 同源判定：Origin 与请求目标同 scheme/host/port。 */
function isSameOrigin(origin: string, url: URL): boolean {
  try {
    return new URL(origin).origin === url.origin
  } catch {
    return false
  }
}

/**
 * 状态变更请求的 Origin 门禁：
 * - 不带 Origin（CLI / curl / 服务端 fetch）直接放行；
 * - 带 Origin：同源或 CORS 白名单（3201 dev 前端）放行，其余 403。
 * GET/HEAD/OPTIONS 只读不拦（CORS 响应头已限制读取面）。
 */
function originAllowed(request: Request, origin: string | null, url: URL): boolean {
  if (origin === null) return true
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return true
  return isSameOrigin(origin, url) || ALLOWED_CORS_ORIGINS.includes(origin)
}

/** 是否 JSON 端点：除插件 public 原始路由外全部核心端点都是 JSON。 */
function isJsonEndpoint(method: string, pathname: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') return false
  if (!pathname.startsWith('/api/')) return false
  // 插件动态路由命名空间：public webhook 载荷形态由插件自定义。
  const segs = pathname.split('/').filter((s) => s.length > 0)
  return !(segs[0] === 'api' && segs[1] === 'plugins' && segs[3] === 'routes')
}

/** 请求是否携带 body（chunked 或 content-length > 0）。 */
function requestHasBody(request: Request): boolean {
  if (request.headers.get('transfer-encoding') !== null) return true
  const cl = request.headers.get('content-length')
  return cl !== null && Number(cl) > 0
}

/**
 * content-type 校验：application/json（charset 参数可选）。
 * 无 body 的请求（POST abort 等）允许缺省 content-type；带 body 却缺失
 * 或非 JSON（跨站表单 text/plain）一律拒绝。
 */
function jsonContentTypeOk(request: Request): boolean {
  const raw = request.headers.get('content-type')
  if (raw === null) return !requestHasBody(request)
  return raw.split(';')[0]!.trim().toLowerCase() === 'application/json'
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  if (header === null) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? undefined
}

/** 判断是否命中插件声明为 public 的动态路由（segments 已解码）。 */
export function isPublicPluginRoute(kernel: KernelRuntimeLike, method: string, segments: string[]): boolean {
  if (segments.length === 0 || segments[0] !== 'api') return false
  let routes
  try {
    routes = kernel.plugins.listRoutes()
  } catch {
    return false
  }
  const found = findPluginRoute(routes, method, segments)
  return found !== undefined && found.route.public === true
}
