/**
 * createHubHandler:Web Standard request handle (core routing + authentication gate + CORS).
 *
 * authentication policy:
 * - public end point:/api/auth/setup,/api/auth/login,/api/auth/status,
 *   plugin route({ public: true })(plugin self row signature verification).
 * - the rest one rule Bearer token via kernel.auth.verifyToken; without anonymous initialize loophole.
 *
 * public plugin routing exemption and routes.ts dispatch shared use the same complete path match
 * (route-match.ts), two where semantics will not drift; path segment illegal hundred number encode unify 400.
 *
 * across source policy: local person assist scenario (local machine/scoped domain network self use, without browser across station protect
 * requirement), has intent does not across station restrict - - carries Origin request one rule reflection its Origin and
 * allows credentials (see http-utils.ts  withCors), real boundary by Bearer token
 * authentication bear bear; do not carries Origin  CLI/server side invoke do not subject to affect.
 * JSON end point also validate content-type application/json(charset optional),
 * reject across station table single/text-simple POST smoke fill JSON; plugin public original routing do not force
 * JSON(webhook payload form by plugin self set).
 *
 * SSE:kernel.events.response() by runtime provide;HTTP layer does not cache/convert,
 * do not compress (gzip only override application/json, see gzip.ts);
 * disconnect (signal abort) by events implement negative duty cancel subscribe.
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
import { createStaticServe, type StaticServe } from './static.js'
import { acceptsGzip, gzipJsonResponse } from './gzip.js'
import { HelmError } from '@helm/protocol'
import type { KernelRuntimeLike } from './contracts.js'

export interface HubHandlerOptions {
  kernel: KernelRuntimeLike
  /**
   * produce static hosting directory (produce product policy, by combine layer/hub entry explicit provide):
   * - string: explicit designate directory; expires when structure web_dist_invalid errors, never static default disable;
   * - false / default: does not enable static hosting (non- /api one rule JSON 404, pure API form).
   * kernel does not any by default directory probe (do not hard encode Web package location; embed style Kernel  HTTP
   * by default behavior do not follow warehouse beside is otherwise store in web dist change).
   */
  webDistDir?: string | false
}

const PUBLIC_PATHS = new Set(['/api/auth/setup', '/api/auth/login', '/api/auth/status'])

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
  // directory parse cache (handler instance inside, only cache succeeded result):dir → service
  let staticServeCache: StaticCacheEntry | null = null
  const resolveStaticServe = async (): Promise<StaticServe | undefined> => {
    if (webDistDir === false || webDistDir === undefined) return undefined
    const dir = webDistDir
    if (staticServeCache !== null && staticServeCache.dir === dir) {
      return staticServeCache.serve
    }
    let serve: StaticServe
    try {
      serve = await createStaticServe(dir)
    } catch (err) {
      // explicit designate expires directory: structure diagnose, never static default disable (honest discipline)
      throw new HelmError(
        'web_dist_invalid',
        `static hosting directory unavailable: ${dir}(${err instanceof Error ? err.message : String(err)})`,
        500,
        { dir },
      )
    }
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
        // produce static hosting: non- /api  GET/HEAD away webDistDir(not enabled when back JSON 404)
        if (request.method === 'GET' || request.method === 'HEAD') {
          const serve = await resolveStaticServe()
          if (serve !== undefined) {
            return gzipJsonResponse(request, withCors(await serve.serve(request.method, url.pathname, { acceptGzip: acceptsGzip(request) }), origin))
          }
        }
        return gzipJsonResponse(request, withCors(errorResponse(redactor, 404, 'not_found', 'routing missing'), origin))
      }

      // remove tail slash archive one (/api/conversations/ etc. price /api/conversations)
      const normalized = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname

      const segments = decodeSegments(normalized)

      if (PUBLIC_PATHS.has(normalized)) {
        // auth/setup|login is JSON end point: across station text/plain simple POST smoke fill by refuse.
        if (request.method !== 'GET' && request.method !== 'HEAD' && !jsonContentTypeOk(request)) {
          return gzipJsonResponse(request, withCors(errorResponse(redactor, 415, 'unsupported_media_type', 'JSON end point must content-type: application/json'), origin))
        }
        return gzipJsonResponse(request, withCors(await handleApi(request, kernel, redactor), origin))
      }

      // plugin public routing exemption (its handler self row signature verification); and dispatch shared use match.
      const isPublic = isPublicPluginRoute(kernel, request.method, segments)
      if (!isPublic && isJsonEndpoint(request.method, normalized) && !jsonContentTypeOk(request)) {
        return gzipJsonResponse(request, withCors(errorResponse(redactor, 415, 'unsupported_media_type', 'JSON end point must content-type: application/json'), origin))
      }
      if (isPublic) {
        return gzipJsonResponse(request, withCors(await handleApi(request, kernel, redactor), origin))
      }

      const token = bearerToken(request)
      if (token === undefined) {
        return gzipJsonResponse(request, withCors(errorResponse(redactor, 401, 'unauthorized', 'missing Bearer token'), origin))
      }
      const valid = await kernel.auth.verifyToken(token)
      if (valid !== true) {
        return gzipJsonResponse(request, withCors(errorResponse(redactor, 401, 'unauthorized', 'token invalid or expired'), origin))
      }

      return gzipJsonResponse(request, withCors(await handleApi(request, kernel, redactor), origin))
    } catch (error) {
      // illegal path encode (contains public match phase) also want to out structure 400, while non- 500.
      if (error instanceof PathDecodeError) {
        return gzipJsonResponse(request, withCors(errorResponse(redactor, 400, 'invalid_path_encoding', error.message), origin))
      }
      return gzipJsonResponse(request, withCors(errorToResponse(redactor, redactText(kernel), error), origin))
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

/** is otherwise JSON end point: except plugin public original routing and artifact two enter system upload outside all core end point all is JSON. */
function isJsonEndpoint(method: string, pathname: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') return false
  if (!pathname.startsWith('/api/')) return false
  // plugin motion state routing naming empty between:public webhook payload form by plugin self define.
  const segs = pathname.split('/').filter((s) => s.length > 0)
  if (segs[0] === 'api' && segs[1] === 'plugins' && segs[3] === 'routes') return false
  // artifact upload:POST /api/conversations/:id/artifacts accept two enter system stream
  //(application/octet-stream;application/json branch in routing inside self row handle).
  if (segs[0] === 'api' && segs[1] === 'conversations' && segs[3] === 'artifacts' && segs.length === 4) return false
  return true
}

/** request is otherwise carry body(chunked or content-length > 0). */
function requestHasBody(request: Request): boolean {
  if (request.headers.get('transfer-encoding') !== null) return true
  const cl = request.headers.get('content-length')
  return cl !== null && Number(cl) > 0
}

/**
 * content-type validate:application/json(charset parameter optional).
 * without body request (POST abort etc.) allows default content-type; carries body yet missing
 * or non- JSON(across station table single text/plain) one rule reject.
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

/** decide is otherwise hit plugin declaration is public motion state routing (segments already decode). */
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
