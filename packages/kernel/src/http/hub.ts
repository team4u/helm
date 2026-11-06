/**
 * createHubHandler：Web Standard 请求处理器（核心路由 + 鉴权门禁 + CORS）。
 *
 * 鉴权策略：
 * - 公开端点：/api/auth/setup、/api/auth/login、/api/auth/status、
 *   插件 route({ public: true })（插件自行验签）。
 * - 其余一律 Bearer token 经 kernel.auth.verifyToken；无匿名初始化漏洞。
 *
 * SSE：kernel.events.response() 由 runtime 提供；HTTP 层不做缓存/转换，
 * 断开（signal abort）由 events 实现负责取消订阅。
 */
import { errorResponse, errorToResponse, preflightResponse, withCors } from './http-utils.js'
import { handleApi } from './routes.js'
import type { KernelRuntimeLike, WorkflowServiceLike } from './contracts.js'

export interface HubHandlerOptions {
  kernel: KernelRuntimeLike
  workflows: WorkflowServiceLike
}

const PUBLIC_PATHS = new Set(['/api/auth/setup', '/api/auth/login', '/api/auth/status'])

export function createHubHandler(kernel: KernelRuntimeLike, workflows: WorkflowServiceLike): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin')
    try {
      if (request.method === 'OPTIONS') {
        return preflightResponse(origin)
      }
      const pathname = new URL(request.url).pathname

      if (!pathname.startsWith('/api/')) {
        return withCors(errorResponse(404, 'not_found', '路由不存在'), origin)
      }

      // 去尾斜杠归一（/api/conversations/ 等价 /api/conversations）
      const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname

      if (PUBLIC_PATHS.has(normalized)) {
        return withCors(await handleApi(request, kernel, workflows), origin)
      }

      // 插件 public 路由豁免（其 handler 自行验签）
      if (isPublicPluginRoute(kernel, request.method, normalized)) {
        return withCors(await handleApi(request, kernel, workflows), origin)
      }

      const token = bearerToken(request)
      if (token === undefined) {
        return withCors(errorResponse(401, 'unauthorized', '缺少 Bearer token'), origin)
      }
      const valid = await kernel.auth.verifyToken(token)
      if (valid !== true) {
        return withCors(errorResponse(401, 'unauthorized', 'token 无效或已过期'), origin)
      }

      return withCors(await handleApi(request, kernel, workflows), origin)
    } catch (error) {
      return withCors(errorToResponse(error), origin)
    }
  }
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  if (header === null) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? undefined
}

/** 判断是否命中插件声明为 public 的动态路由。 */
export function isPublicPluginRoute(kernel: KernelRuntimeLike, method: string, pathname: string): boolean {
  const segments = pathname.split('/').filter((s) => s.length > 0)
  // /api/plugins/:pluginId/routes/...
  if (segments.length < 4 || segments[0] !== 'api' || segments[1] !== 'plugins' || segments[3] !== 'routes') {
    return false
  }
  const pluginId = safeDecode(segments[2] ?? '')
  const rest = segments.slice(4)
  if (rest.length === 0) return false
  let routes
  try {
    routes = kernel.plugins.listRoutes()
  } catch {
    return false
  }
  return routes.some(
    (r) => r.public === true && r.pluginId === pluginId && r.method === method && matchDeclaredPath(r.path, rest),
  )
}

function matchDeclaredPath(declared: string, restSegments: string[]): boolean {
  const parts = declared.split('/').filter((s) => s.length > 0)
  if (parts.length !== restSegments.length) return false
  return parts.every((part, i) => (part.startsWith(':') ? true : part === safeDecode(restSegments[i] ?? '')))
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
