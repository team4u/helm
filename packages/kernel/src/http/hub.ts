/**
 * createHubHandler: Web Standard request handler (core routing + authentication gate + CORS).
 *
 * Authentication policy:
 * - Public endpoints: /api/auth/setup, /api/auth/login, /api/auth/status,
 *   and plugin route({ public: true }) (signature verification handled by the plugin itself).
 * - Everything else requires a Bearer token verified via `kernel.auth.verifyToken` (no anonymous init loophole).
 *
 * Public plugin route exemption and `routes.ts` dispatch share the exact same full-path matcher
 * (`route-match.ts`) so semantics never drift; invalid percent-encoding in path segments always returns 400.
 *
 * Cross-origin policy: designed for local personal assistant usage (localhost/LAN, no browser CSRF boundary
 * needed), so requests carrying `Origin` always reflect `Origin` and allow credentials (see `withCors` in
 * `http-utils.ts`), with `Bearer` token auth as the real boundary; CLI/server callers without `Origin` are
 * unaffected. JSON endpoints also require `content-type: application/json` (charset optional), rejecting
 * cross-site form/text-plain simple POSTs disguised as JSON; public plugin raw routes do not require JSON
 * (webhook payload formats are defined by plugins).
 *
 * SSE: `kernel.events.response()` is provided by the runtime; the HTTP layer does not buffer, transform,
 * or compress it (gzip only applies to `application/json`, see `gzip.ts`); disconnect (`signal` abort) cancels
 * subscriptions inside the events implementation.
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
import { HelmxError } from '@helmx/protocol'
import type { KernelRuntimeLike } from './contracts.js'

export interface HubHandlerOptions {
  kernel: KernelRuntimeLike
  /**
   * Production static hosting directory (built by the product/composer layer):
   * - string: explicit directory; fails with `web_dist_invalid` if invalid rather than silently disabling;
   * - false / omitted: static hosting disabled (non-`/api` requests return JSON 404, pure API mode).
   * The kernel performs no default directory probing (never hardcodes the Web package path so embedded
   * Kernel HTTP behavior does not vary based on adjacent `web/dist` files).
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
  // Directory resolution cache (per handler instance, caches successful resolutions only): dir -> StaticServe
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
      // Explicit invalid directory: throw structured diagnostic rather than silently disabling (honest discipline)
      throw new HelmxError(
        'web_dist_invalid',
        `static hosting directory unavailable: ${dir} (${err instanceof Error ? err.message : String(err)})`,
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
        // Production static hosting: non-`/api` GET/HEAD served via `webDistDir` (returns JSON 404 when disabled)
        if (request.method === 'GET' || request.method === 'HEAD') {
          const serve = await resolveStaticServe()
          if (serve !== undefined) {
            return gzipJsonResponse(request, withCors(await serve.serve(request.method, url.pathname, { acceptGzip: acceptsGzip(request) }), origin))
          }
        }
        return gzipJsonResponse(request, withCors(errorResponse(redactor, 404, 'not_found', 'route not found'), origin))
      }

      // Strip trailing slash for consistency (`/api/conversations/` == `/api/conversations`)
      const normalized = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname

      const segments = decodeSegments(normalized)

      if (PUBLIC_PATHS.has(normalized)) {
        // auth/setup|login are JSON endpoints: reject cross-site text/plain simple POSTs disguised as JSON.
        if (request.method !== 'GET' && request.method !== 'HEAD' && !jsonContentTypeOk(request)) {
          return gzipJsonResponse(request, withCors(errorResponse(redactor, 415, 'unsupported_media_type', 'JSON endpoint requires content-type: application/json'), origin))
        }
        return gzipJsonResponse(request, withCors(await handleApi(request, kernel, redactor), origin))
      }

      // Public plugin route exemption (handler performs its own signature verification); shares matcher with dispatch.
      const isPublic = isPublicPluginRoute(kernel, request.method, segments)
      if (!isPublic && isJsonEndpoint(request.method, normalized) && !jsonContentTypeOk(request)) {
        return gzipJsonResponse(request, withCors(errorResponse(redactor, 415, 'unsupported_media_type', 'JSON endpoint requires content-type: application/json'), origin))
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
        return gzipJsonResponse(request, withCors(errorResponse(redactor, 401, 'unauthorized', 'invalid or expired token'), origin))
      }

      return gzipJsonResponse(request, withCors(await handleApi(request, kernel, redactor), origin))
    } catch (error) {
      // Invalid path encoding (including during public route matching) must return structured 400 instead of 500.
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

/** Whether endpoint expects JSON: all core endpoints except public/raw plugin routes and binary artifact uploads. */
function isJsonEndpoint(method: string, pathname: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') return false
  if (!pathname.startsWith('/api/')) return false
  // Plugin dynamic route namespace: public webhook payload formats are plugin-defined.
  const segs = pathname.split('/').filter((s) => s.length > 0)
  if (segs[0] === 'api' && segs[1] === 'plugins' && segs[3] === 'routes') return false
  // Artifact upload: POST /api/conversations/:id/artifacts accepts binary streams
  // (application/octet-stream; application/json branch is handled inside the route).
  if (segs[0] === 'api' && segs[1] === 'conversations' && segs[3] === 'artifacts' && segs.length === 4) return false
  return true
}

/** Whether the request carries a body (chunked or content-length > 0). */
function requestHasBody(request: Request): boolean {
  if (request.headers.get('transfer-encoding') !== null) return true
  const cl = request.headers.get('content-length')
  return cl !== null && Number(cl) > 0
}

/**
 * Validate content-type is application/json (charset param optional).
 * Bodyless requests (e.g. POST abort) may omit content-type; requests with a body but missing or
 * non-JSON content-type (such as cross-site form text/plain) are always rejected.
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

/** Check whether the decoded segments match a plugin route declared as public. */
function isPublicPluginRoute(kernel: KernelRuntimeLike, method: string, segments: string[]): boolean {
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
