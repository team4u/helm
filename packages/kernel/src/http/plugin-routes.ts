/**
 * Plugin HTTP routes: `/api/plugins` (management, doctor/rescan/install, config,
 * docs including dedicated sessionDoc SSE, `client.mjs`, and dynamic `routes/` dispatch)
 * and `/api/actions` (action manifest and invocation).
 *
 * Disable double-gate: re-checks plugin enabled status via summary before dispatch (409 if disabled)
 * and tracks handler execution in `liveTasks` (shared with actions/tools for disable blocking).
 */
import { HelmError } from '@helm/protocol'
import type { JsonSchema, PluginConfigFieldSchema, PublicPluginSessionDoc } from '@helm/protocol'
import { gzipSync } from 'node:zlib'
import { errorResponse, jsonOk, readJsonBody, type JsonRedactor } from './http-utils.js'
import { decodeSegment, findPluginRoute } from './route-match.js'
import type { KernelRuntimeLike } from './contracts.js'
import {
  assertBodySchema,
  parseActionInvokeBody,
  parseDocNameParam,
  parsePluginConfigBody,
  requireIdParam,
  ValidationError,
} from './validate.js'
import { parseOptionalBooleanFlag, parseOptionalJsonObjectBody, type RouteContext } from './route-context.js'
import { methodNotAllowed } from './route-context.js'
import { assertDoctorTargetDir } from '../plugins/doctor-target.js'

export async function handlePluginsDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]
  const fifth = segments[4]

  if (second === undefined && method === 'GET') {
    return jsonOk(redactor, await kernel.plugins.list())
  }
  // External plugin DX loop (top-level routes without plugin ID segment; matched before requireIdParam).
  if (second === 'doctor' && method === 'POST' && third === undefined) {
    if (kernel.plugins.doctorExternalPlugin === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin static doctor checks')
    }
    const body = await readJsonBody(ctx.request)
    return jsonOk(redactor, await kernel.plugins.doctorExternalPlugin(parseDoctorTarget(body)))
  }
  if (second === 'rescan' && method === 'POST' && third === undefined) {
    if (kernel.plugins.rescanExternalPlugins === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin rescan')
    }
    return jsonOk(redactor, await kernel.plugins.rescanExternalPlugins())
  }
  // Managed plugin package installation (POST /api/plugins/install, body { source, enable? }).
  if (second === 'install' && method === 'POST' && third === undefined) {
    if (kernel.plugins.installPluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin package installation')
    }
    const body = await readJsonBody(ctx.request)
    assertBodySchema(PLUGIN_INSTALL_BODY_SCHEMA, body, 'plugins install body')
    const source = body.source as string
    return jsonOk(redactor, await kernel.plugins.installPluginPackage(source, body.enable === true ? { enable: true } : {}))
  }
  const pluginId = requireIdParam(second ?? '', 'pluginId')
  // Reserved core management segments in position 3: enable/disable/config; dynamic routes live under routes/.
  if (third === 'enable' && method === 'POST' && fourth === undefined) {
    await kernel.plugins.enable(pluginId)
    return jsonOk(redactor, await kernel.plugins.list())
  }
  if (third === 'disable' && method === 'POST' && fourth === undefined) {
    const opts = await parseOptionalJsonObjectBody(ctx.request, parsePluginDisableBody)
    const queryForce = parseOptionalBooleanFlag(ctx.url, 'force')
    const force = opts.force === true || queryForce === true
    await kernel.plugins.disable(pluginId, force ? { force: true } : undefined)
    return jsonOk(redactor, await kernel.plugins.list())
  }
  // External plugin controlled hot reload (POST /api/plugins/:id/reload): leaves current instance untouched on preflight failure.
  if (third === 'reload' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.reloadExternalPlugin === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin hot reload')
    }
    return jsonOk(redactor, await kernel.plugins.reloadExternalPlugin(pluginId))
  }
  // Managed plugin package update (POST /api/plugins/:id/update).
  if (third === 'update' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.updatePluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin package updates')
    }
    return jsonOk(redactor, await kernel.plugins.updatePluginPackage(pluginId))
  }
  // Managed plugin package removal (POST /api/plugins/:id/remove).
  if (third === 'remove' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.removePluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin package removal')
    }
    return jsonOk(redactor, await kernel.plugins.removePluginPackage(pluginId))
  }
  if (third === 'config' && fourth === undefined) {
    if (method === 'GET') {
      const [raw, schema, sources] = await Promise.all([
        Promise.resolve(kernel.plugins.getConfig(pluginId)),
        Promise.resolve(kernel.plugins.getConfigSchema(pluginId)),
        Promise.resolve(
          kernel.plugins.getConfigSources !== undefined
            ? kernel.plugins.getConfigSources(pluginId)
            : undefined,
        ),
      ])
      // Redact secret fields per schema before leaving the server.
      const values = redactConfigValues(raw, schema)
      return jsonOk(redactor, {
        values,
        schema,
        ...(sources !== undefined ? { sources } : {}),
      })
    }
    if (method === 'PUT') {
      const body = await readJsonBody(ctx.request)
      await kernel.plugins.setConfig(pluginId, parsePluginConfigBody(body))
      return jsonOk(redactor, { ok: true })
    }
    return methodNotAllowed(redactor, method)
  }
  // Plugin public document: GET /api/plugins/:pluginId/docs/:name (404 if private, disabled, or missing).
  // ?conversationId=N selects sessionDoc snapshot; `/events` opens the dedicated sessionDoc SSE stream.
  if (third === 'docs' && method === 'GET') {
    // Dedicated SSE: GET /api/plugins/:id/docs/:name/events?conversationId=N
    // Total segments = plugins(1) + id(2) + docs(3) + name(4) + events(5).
    if (fourth !== undefined && fifth === 'events' && segments.length === 5) {
      return sessionDocEventsResponse(ctx, kernel, redactor, pluginId, decodeSegment(fourth))
    }
    if (fifth !== undefined) return errorResponse(redactor, 404, 'not_found', 'route not found')
    if (fourth === undefined) throw new ValidationError('missing doc name path segment')
    const name = parseDocNameParam(decodeSegment(fourth))
    const conversationId = parseConversationIdQuery(ctx.url)
    if (conversationId === undefined) {
      return jsonOk(redactor, await kernel.plugins.getPublicDoc(pluginId, name))
    }
    return jsonOk(
      redactor,
      await kernel.plugins.getPublicSessionDoc(pluginId, name, conversationId),
    )
  }
  // Plugin client module: GET/HEAD /api/plugins/:pluginId/client.mjs?module=<relativePath>&chunk=<chunkName>&hash=<contentHash>
  if (third === 'client.mjs' && (method === 'GET' || method === 'HEAD') && fourth === undefined) {
    return serveClientModule(ctx, kernel, pluginId)
  }
  // Plugin dynamic routes: scoped under /api/plugins/:pluginId/routes/... so core management paths cannot be shadowed.
  if (third === 'routes') {
    return dispatchPluginRoute(kernel, redactor, ctx.request, method, segments)
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// /api/actions
// ---------------------------------------------------------------------------

export async function handleActionsDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]
  if (second === undefined && method === 'GET') {
    return jsonOk(redactor, await kernel.plugins.listActions())
  }
  const pluginId = requireIdParam(second ?? '', 'pluginId')
  const actionId = requireIdParam(third ?? '', 'actionId')
  if (method === 'POST' && fourth === undefined) {
    const body = await readJsonBody(ctx.request)
    const { input, conversationId } = parseActionInvokeBody(body)
    const result = await kernel.plugins.invokeAction(pluginId, actionId, input, conversationId !== undefined ? { conversationId } : undefined)
    // Null is a valid action output; undefined violates the output contract so reject it explicitly.
    return jsonOk(redactor, result)
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// Internal helpers: body validation / doc SSE / client.mjs / dynamic route dispatch
// ---------------------------------------------------------------------------

const PLUGIN_INSTALL_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    source: { type: 'string', pattern: '\\S' },
    enable: { type: 'boolean' },
  },
  required: ['source'],
  additionalProperties: false,
}

/** POST /api/plugins/:id/disable body: only force(query ?force=1 same meaning). */
function parsePluginDisableBody(body: Record<string, unknown>): { force?: boolean } {
  assertBodySchema(
    { type: 'object', properties: { force: { type: 'boolean' } }, additionalProperties: false },
    body,
    'plugins disable body',
  )
  return body.force !== undefined ? { force: body.force as boolean } : {}
}

/**
 * `POST /api/plugins/doctor` body: accepts `path` / `dir` (aliases for an absolute directory path)
 * or `id` (a registered plugin whose source directory is resolved server-side).
 */
function parseDoctorTarget(body: Record<string, unknown>): { dir?: string; id?: string } {
  assertBodySchema(
    {
      type: 'object',
      properties: {
        path: { type: 'string', pattern: '\\S' },
        dir: { type: 'string', pattern: '\\S' },
        id: { type: 'string', pattern: '\\S' },
      },
      additionalProperties: false,
    },
    body,
    'plugins doctor body',
  )
  const dirLike = (v: unknown, field: string): string | undefined => {
    if (typeof v !== 'string') return undefined
    // Validate cross-platform absolute paths without `..` before running doctor checks.
    assertDoctorTargetDir(v, field)
    return v
  }
  const pathDir = dirLike(body.path, 'path')
  const dirDir = dirLike(body.dir, 'dir')
  if (pathDir !== undefined && dirDir !== undefined && pathDir !== dirDir) {
    throw new ValidationError('path and dir conflict; provide only one of them (dir is a compatibility alias for path)')
  }
  if (body.id !== undefined) {
    if (pathDir !== undefined || dirDir !== undefined) {
      throw new ValidationError('id and path/dir are mutually exclusive; provide only one')
    }
    return { id: body.id as string }
  }
  const resolved = pathDir ?? dirDir
  if (resolved === undefined) {
    throw new ValidationError('must provide either path/dir (absolute directory path) or id (registered plugin)')
  }
  return { dir: resolved }
}

/** Parses `?conversationId=N` query param as a positive safe integer (400 otherwise). */
function parseConversationIdQuery(url: URL): number | undefined {
  const raw = url.searchParams.get('conversationId')
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError('conversationId must be a positive integer')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError('conversationId must be a positive integer')
  }
  return value
}

/**
 * Dedicated sessionDoc SSE: `GET /api/plugins/:id/docs/:name/events?conversationId=N`.
 * - Auth shares hub middleware; returns structured JSON 401 when unauthorized;
 * - Sync snapshot provider runs after registering the buffered subscription to prevent missed frames;
 * - Stream closes cleanly on `plugin.changed` (`enabled=false`) or `conversation.deleted` events;
 * - Returns 501 if `sessionDocEvents` port is unavailable (no polling/in-memory fallback).
 */
async function sessionDocEventsResponse(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
  pluginId: string,
  rawName: string,
): Promise<Response> {
  const name = parseDocNameParam(rawName)
  const conversationId = parseConversationIdQuery(ctx.url)
  if (conversationId === undefined) {
    throw new ValidationError('sessionDoc subscription requires ?conversationId=<positive integer>')
  }
  const port = kernel.sessionDocEvents
  if (port === undefined) {
    throw new HelmError(
      'not_implemented',
      'Current runtime does not support sessionDoc event streams (sessionDocEvents port missing)',
      501,
    )
  }
  const target = { pluginId, name, conversationId }
  const snapshot = () => {
    const doc = snapshotDocOf(kernel, pluginId, name, conversationId)
    return { seq: port.seq, doc }
  }
  void redactor
  return port.response(ctx.request, { snapshot, target })
}

/** Ensures `getPublicSessionDoc` returns synchronously for atomic snapshot-after-subscribe semantics. */
function snapshotDocOf(
  kernel: KernelRuntimeLike,
  pluginId: string,
  name: string,
  conversationId: number,
): PublicPluginSessionDoc {
  const result = kernel.plugins.getPublicSessionDoc(pluginId, name, conversationId)
  if (result instanceof Promise) {
    throw new HelmError(
      'not_implemented',
      'Current runtime getPublicSessionDoc is async and cannot provide synchronous sessionDoc snapshots',
      501,
    )
  }
  return result
}

/** GET/HEAD `/api/plugins/:id/client.mjs`: validates module/chunk/hash params and handles ETag/304 + gzip. */
async function serveClientModule(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  pluginId: string,
): Promise<Response> {
  const { request, method, url } = ctx
  const moduleRef = url.searchParams.get('module')
  if (moduleRef === null || moduleRef.length === 0) {
    throw new ValidationError('missing module query parameter (relative .ts/.tsx path under clientRoot)')
  }
  if (moduleRef.length > 256 || moduleRef.includes('..') || moduleRef.startsWith('/') || moduleRef.includes('\\')) {
    throw new ValidationError('module must be a relative .ts/.tsx path inside clientRoot (absolute paths and .. are disallowed)')
  }
  const chunk = url.searchParams.get('chunk') ?? undefined
  const hash = url.searchParams.get('hash') ?? undefined
  if (chunk !== undefined) {
    if (!/^[A-Za-z0-9._-]+\.js$/.test(chunk) || chunk.includes('..')) {
      throw new HelmError('invalid_client_module', 'Invalid chunk name (must match /^[A-Za-z0-9._-]+\\.js$/ without ..)', 400)
    }
  }
  const compiled = await kernel.plugins.getClientModule(pluginId, moduleRef, {
    ...(chunk !== undefined ? { chunk } : {}),
    ...(hash !== undefined ? { hash } : {}),
  })
  if (hash !== undefined && (hash.length === 0 || hash !== compiled.contentHash)) {
    throw new HelmError(
      chunk !== undefined ? 'client_chunk_stale' : 'client_module_stale',
      `plugin ${pluginId} client module ${moduleRef} hash (${hash}) does not match current artifact hash (${compiled.contentHash})`,
      409,
      {
        pluginId,
        module: moduleRef,
        ...(chunk !== undefined ? { chunk } : {}),
        hash,
        currentHash: compiled.contentHash,
      },
    )
  }
  const etag = chunk !== undefined ? `"${compiled.contentHash}:${chunk}"` : `"${compiled.contentHash}"`
  const isImmutable = hash !== undefined && hash.length > 0 && hash === compiled.contentHash
  const cacheControl = isImmutable ? 'private, max-age=31536000, immutable' : 'private, no-cache'

  const ifNoneMatch = request.headers.get('if-none-match')
  // chunk request only accept complete chunk ETag(hash:chunk) match - - bare contentHash will same hash under
  // other chunk cache mistakenly judge is hit; main module request keep strong ETag / bare hash / W/ three form compatibility.
  const etagMatched = chunk !== undefined
    ? ifNoneMatch === etag || ifNoneMatch === `W/${etag}`
    : ifNoneMatch === etag || ifNoneMatch === compiled.contentHash || ifNoneMatch === `W/${etag}`
  if (ifNoneMatch && etagMatched) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        'x-helm-client-hash': compiled.contentHash,
        'cache-control': cacheControl,
        vary: 'Accept-Encoding',
      },
    })
  }

  const headers: Record<string, string> = {
    'content-type': 'text/javascript; charset=utf-8',
    'x-helm-client-hash': compiled.contentHash,
    etag,
    'cache-control': cacheControl,
    vary: 'Accept-Encoding',
  }

  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers })
  }

  const acceptEncoding = request.headers.get('accept-encoding') ?? ''
  if (/\bgzip\b/i.test(acceptEncoding)) {
    headers['content-encoding'] = 'gzip'
    const gzBuffer = compiled.gzipped ?? gzipSync(Buffer.from(compiled.code, 'utf8'))
    return new Response(gzBuffer as unknown as BodyInit, {
      status: 200,
      headers,
    })
  }

  return new Response(compiled.code, {
    status: 200,
    headers,
  })
}

/**
 * Dispatches dynamic plugin routes (`/api/plugins/<id>/routes/...`) using `findPluginRoute`.
 * Re-checks plugin enabled state via summary (409 if disabled) and tracks handler execution in `liveTasks`.
 */
async function dispatchPluginRoute(
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
  request: Request,
  method: string,
  segments: string[],
): Promise<Response> {
  const routes = kernel.plugins.listRoutes()
  const found = findPluginRoute(routes, method, ['api', ...segments])
  if (found === undefined) {
    const rest = segments.slice(4).join('/')
    return errorResponse(redactor, 404, 'route_not_found', `Plugin route not found: ${method} /${rest}`)
  }
  const summary = kernel.plugins.get?.(found.pluginId)
  if (summary !== undefined && summary.enabled !== true) {
    throw new HelmError('plugin_disabled', `Plugin ${found.pluginId} is disabled; route unavailable`, 409, {
      pluginId: found.pluginId,
    })
  }
  const invokeHandler = (): Promise<Response> => Promise.resolve(found.route.handler(request))
  const response = await (kernel.plugins.withTask !== undefined
    ? kernel.plugins.withTask(found.pluginId, `route:${found.route.method} ${found.route.path}`, invokeHandler)
    : invokeHandler())
  if (!(response instanceof Response)) {
    throw new HelmError('invalid_route_handler_output', 'Plugin route handler must return a Response', 500)
  }
  return response
}

/**
 * Redacts `secret: true` config fields before leaving the server (`'******'` when set, `''` otherwise).
 */
function redactConfigValues(
  raw: Record<string, unknown>,
  schema: Record<string, PluginConfigFieldSchema>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(schema, key)) continue
    if (schema[key]?.secret === true) {
      out[key] = typeof value === 'string' && value.length > 0 ? '******' : ''
    } else {
      out[key] = value
    }
  }
  return out
}
