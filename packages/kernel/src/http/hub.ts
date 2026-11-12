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
 * 跨源策略：本地个人助理场景（本机/局域网自用，无浏览器跨站防护
 * 需求），有意不做跨站限制——带 Origin 的请求一律反射其 Origin 并
 * 允许凭据（见 http-utils.ts 的 withCors），真实边界由 Bearer token
 * 鉴权承担；不带 Origin 的 CLI/服务端调用不受影响。
 * JSON 端点同时校验 content-type application/json（charset 可选），
 * 拒绝跨站表单/text-simple POST 冒充 JSON；插件 public 原始路由不强制
 * JSON（webhook 载荷形态由插件自定）。
 *
 * SSE：kernel.events.response() 由 runtime 提供；HTTP 层不做缓存/转换，
 * 断开（signal abort）由 events 实现负责取消订阅。
 */
import {
  errorResponse,
  errorToResponse,
  makeJsonRedactor,
  preflightResponse,
  withCors,
  type JsonRedactor,
} from './http-utils.js'
import { handleApi } from './routes.js'
import { decodeSegments, findPluginRoute, PathDecodeError } from './route-match.js'
import { createStaticServe, isMissingError, type StaticServe } from './static.js'
import { HelmError } from '@helm/protocol'
import type { KernelRuntimeLike } from './contracts.js'
import { fileURLToPath } from 'node:url'

export interface HubHandlerOptions {
  kernel: KernelRuntimeLike
  /**
   * 生产静态托管目录（packages/web/dist）：
   * - false：禁用静态托管（非 /api 一律 JSON 404，与既有行为一致）；
   * - 缺省：探测编译位置旁的 ../../../web/dist，仅存在 index.html 时启用，
   *   目录缺失视为未启用（回落 JSON 404），不可读则如实报错；
   * - 字符串：显式指定目录（测试 / 自定义部署用）；失效时结构化
   *   web_dist_invalid 报错，绝不静默禁用。
   */
  webDistDir?: string | false
}

const PUBLIC_PATHS = new Set(['/api/auth/setup', '/api/auth/login', '/api/auth/status'])

/** 相对 hub.ts（编译后同构）：仓库内 packages/web/dist 默认位置（跨平台安全转换，含 Windows 盘符与空格路径）。 */
const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../../../web/dist', import.meta.url))

interface StaticCacheEntry {
  dir: string
  serve: StaticServe
}

export function createHubHandler(
  kernelOrOptions: KernelRuntimeLike | HubHandlerOptions,
): (request: Request) => Promise<Response> {
  const options: HubHandlerOptions =
    kernelOrOptions instanceof Object && 'kernel' in (kernelOrOptions as HubHandlerOptions)
      ? (kernelOrOptions as HubHandlerOptions)
      : { kernel: kernelOrOptions as KernelRuntimeLike }
  const { kernel } = options
  const redactor: JsonRedactor | undefined = makeRedactor(kernel)
  const webDistDir = options.webDistDir
  // 目录解析缓存（handler 实例内，仅缓存成功结果）：dir → 服务
  let staticServeCache: StaticCacheEntry | null = null
  const resolveStaticServe = async (): Promise<StaticServe | undefined> => {
    if (webDistDir === false) return undefined
    const dir = webDistDir ?? DEFAULT_WEB_DIST_DIR
    if (staticServeCache !== null && staticServeCache.dir === dir) {
      return staticServeCache.serve
    }
    let serve: StaticServe
    try {
      serve = await createStaticServe(dir)
    } catch (err) {
      // 缺省探测：目录不存在（ENOENT/ENOTDIR）→ 未启用，回落 JSON 404；
      // 缺省探测遇到其他 IO 故障（不可读等）同样如实报错
      if (webDistDir === undefined && isMissingError(err)) return undefined
      // 显式指定失效目录：结构化诊断，绝不静默禁用（诚实性纪律）
      throw new HelmError(
        'web_dist_invalid',
        `静态托管目录不可用: ${dir}（${err instanceof Error ? err.message : String(err)}）`,
        500,
        { dir },
      )
    }
    // 缺省探测仅在存在 index.html 时启用（未构建的仓库不伪装静态站点）
    if (webDistDir === undefined && !(await serve.hasSpaEntry())) return undefined
    staticServeCache = { dir, serve }
    return serve
  }
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin')
    try {
      if (request.method === 'OPTIONS') {
        return preflightResponse(origin)
      }
      const url = new URL(request.url)

      if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
        // 生产静态托管：非 /api 的 GET/HEAD 走 webDistDir（未启用时回落 JSON 404）
        if (request.method === 'GET' || request.method === 'HEAD') {
          const serve = await resolveStaticServe()
          if (serve !== undefined) {
            return withCors(await serve.serve(request.method, url.pathname), origin)
          }
        }
        return withCors(errorResponse(redactor, 404, 'not_found', '路由不存在'), origin)
      }

      // 去尾斜杠归一（/api/conversations/ 等价 /api/conversations）
      const normalized = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname

      const segments = decodeSegments(normalized)

      if (PUBLIC_PATHS.has(normalized)) {
        // auth/setup|login 是 JSON 端点：跨站 text/plain 简单 POST 冒充被拒。
        if (request.method !== 'GET' && request.method !== 'HEAD' && !jsonContentTypeOk(request)) {
          return withCors(errorResponse(redactor, 415, 'unsupported_media_type', 'JSON 端点需 content-type: application/json'), origin)
        }
        return withCors(await handleApi(request, kernel, redactor), origin)
      }

      // 插件 public 路由豁免（其 handler 自行验签）；与派发共用匹配器。
      const isPublic = isPublicPluginRoute(kernel, request.method, segments)
      if (!isPublic && isJsonEndpoint(request.method, normalized) && !jsonContentTypeOk(request)) {
        return withCors(errorResponse(redactor, 415, 'unsupported_media_type', 'JSON 端点需 content-type: application/json'), origin)
      }
      if (isPublic) {
        return withCors(await handleApi(request, kernel, redactor), origin)
      }

      const token = bearerToken(request)
      if (token === undefined) {
        return withCors(errorResponse(redactor, 401, 'unauthorized', '缺少 Bearer token'), origin)
      }
      const valid = await kernel.auth.verifyToken(token)
      if (valid !== true) {
        return withCors(errorResponse(redactor, 401, 'unauthorized', 'token 无效或已过期'), origin)
      }

      return withCors(await handleApi(request, kernel, redactor), origin)
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

/** 是否 JSON 端点：除插件 public 原始路由与产物二进制上传外全部核心端点都是 JSON。 */
function isJsonEndpoint(method: string, pathname: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') return false
  if (!pathname.startsWith('/api/')) return false
  // 插件动态路由命名空间：public webhook 载荷形态由插件自定义。
  const segs = pathname.split('/').filter((s) => s.length > 0)
  if (segs[0] === 'api' && segs[1] === 'plugins' && segs[3] === 'routes') return false
  // 产物上传：POST /api/conversations/:id/artifacts 接受二进制流
  //（application/octet-stream；application/json 分支在路由内自行处理）。
  if (segs[0] === 'api' && segs[1] === 'conversations' && segs[3] === 'artifacts' && segs.length === 4) return false
  return true
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
