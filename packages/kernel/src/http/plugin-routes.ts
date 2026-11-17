/**
 * plugin domain routing:/api/plugins(manage side + doctor/rescan/install + config +
 * docs(contains conversation document dedicated use SSE)+ client.mjs + routes/ motion state routing dispatch) and
 * /api/actions(action manifest and invoke).
 *
 * deactivate gate double gate: dispatch before by plugin summary now read re- inspect (deactivated 409);handler execute
 * count liveTasks(and action/tool same source tracker,disable gate visible).
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
  // external plugin DX closed ring (without plugin id segment top point routing, first at requireIdParam).
  if (second === 'doctor' && method === 'POST' && third === undefined) {
    if (kernel.plugins.doctorExternalPlugin === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'when before kernel not provide plugin static self inspect capability')
    }
    const body = await readJsonBody(ctx.request)
    return jsonOk(redactor, await kernel.plugins.doctorExternalPlugin(parseDoctorTarget(body)))
  }
  if (second === 'rescan' && method === 'POST' && third === undefined) {
    if (kernel.plugins.rescanExternalPlugins === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'when before kernel not provide plugin heavy scan capability')
    }
    return jsonOk(redactor, await kernel.plugins.rescanExternalPlugins())
  }
  // managed plugin package install (POST /api/plugins/install,body { source, enable? }).
  if (second === 'install' && method === 'POST' && third === undefined) {
    if (kernel.plugins.installPluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'when before kernel not provide plugin package install capability')
    }
    const body = await readJsonBody(ctx.request)
    assertBodySchema(PLUGIN_INSTALL_BODY_SCHEMA, body, 'plugins install body')
    const source = body.source as string
    return jsonOk(redactor, await kernel.plugins.installPluginPackage(source, body.enable === true ? { enable: true } : {}))
  }
  const pluginId = requireIdParam(second ?? '', 'pluginId')
  // core manage side fixed in third segment:enable/disable/config; the rest only remain routes/ motion state routing.
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
  // external plugin subject to control hot reload (POST /api/plugins/:id/reload): preflight failed old instance keep do not motion.
  if (third === 'reload' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.reloadExternalPlugin === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'when before kernel not provide plugin hot reload capability')
    }
    return jsonOk(redactor, await kernel.plugins.reloadExternalPlugin(pluginId))
  }
  // managed plugin package update (POST /api/plugins/:id/update, and CLI stub convention keep POST).
  if (third === 'update' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.updatePluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'when before kernel not provide plugin package update capability')
    }
    return jsonOk(redactor, await kernel.plugins.updatePluginPackage(pluginId))
  }
  // managed plugin package remove (POST /api/plugins/:id/remove; and CLI stub convention keep POST).
  if (third === 'remove' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.removePluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'when before kernel not provide plugin package remove capability')
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
      // secret field by schema redaction out station: never let plaintext leave server side.
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
  // plugin public document:GET /api/plugins/:pluginId/docs/:name(private/deactivate/missing 404)
  // ?conversationId=N switch is conversation document read;/events suffix is conversation document dedicated use SSE.
  if (third === 'docs' && method === 'GET') {
    // dedicated use SSE:GET /api/plugins/:id/docs/:name/events?conversationId=N
    // path segment total count = plugins(1) + id(2) + docs(3) + name(4) + events(5).
    if (fourth !== undefined && fifth === 'events' && segments.length === 5) {
      return sessionDocEventsResponse(ctx, kernel, redactor, pluginId, decodeSegment(fourth))
    }
    if (fifth !== undefined) return errorResponse(redactor, 404, 'not_found', 'routing missing')
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
  // plugin client module:GET/HEAD /api/plugins/:pluginId/client.mjs?module=<relative path>&chunk=<chunkName>&hash=<contentHash>
  // (authentication by hub unify pre-; deactivate/not declaration/failed to compile return structure error JSON, never return half artifact)
  if (third === 'client.mjs' && (method === 'GET' || method === 'HEAD') && fourth === undefined) {
    return serveClientModule(ctx, kernel, pluginId)
  }
  // plugin self define motion state routing: force naming empty between /api/plugins/:pluginId/routes/...,
  // disallows override core routing (enable/disable/config already in on side first match).
  if (third === 'routes') {
    return dispatchPluginRoute(kernel, redactor, ctx.request, method, segments)
  }
  return errorResponse(redactor, 404, 'not_found', 'routing missing')
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
    // null is legal output original return;undefined is output boundary violate about,jsonOk
    // explicit throws (fabricate {ok:true} equals mask service defect).
    return jsonOk(redactor, result)
  }
  return errorResponse(redactor, 404, 'not_found', 'routing missing')
}

// ---------------------------------------------------------------------------
// domain inside auxiliary:body validate / document SSE / client.mjs / motion state routing dispatch
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
 * POST /api/plugins/doctor body: target choose one - -path / dir(directory absolute path,dir is
 * path compatibility alias, etc. price) or id(registered plugin, server side parse its source directory).
 * non-empty/unknown field etc. mechanical shape by schema guarantee; absolute path, alias consistency and
 * id mutual exclusion etc. across field semantics manually write. directory store in/entry legal by doctor check chain real decide.
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
    // absolute path and .. through exceeds segment unify rule (and PluginHost.doctorExternalPlugin the same
    // implement, see plugins/doctor-target.ts):HTTP boundary early refuse, does not enter doctor check chain.
    assertDoctorTargetDir(v, field)
    return v
  }
  const pathDir = dirLike(body.path, 'path')
  const dirDir = dirLike(body.dir, 'dir')
  if (pathDir !== undefined && dirDir !== undefined && pathDir !== dirDir) {
    throw new ValidationError('path and dir also provide and inconsistent (two is compatibility alias, please only pass its one)')
  }
  if (body.id !== undefined) {
    if (pathDir !== undefined || dirDir !== undefined) {
      throw new ValidationError('id and path/dir mutual exclusion (choose one provide)')
    }
    return { id: body.id as string }
  }
  const resolved = pathDir ?? dirDir
  if (resolved === undefined) {
    throw new ValidationError('must provide target:path/dir(directory absolute path) or id(registered plugin)')
  }
  return { dir: resolved }
}

/** ?conversationId=N query parameter: positive integer conversation ID; non- positive integer/non- number 400. */
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
 * conversation document dedicated use SSE:GET /api/plugins/:id/docs/:name/events?conversationId=N.
 * - authentication and GET same source (hub unify pre-, without public exemption; unauthorized return structure JSON 401);
 * - pass to port is sync snapshot provider(while non- pre- first take well snapshot): hub first create buffer subscribe
 *   again tune provider, eliminate first snapshot after subscribe lose frame window;provider inside complete
 *   plugin enable + document public + conversation store in three heavy validate (failed throw 404/400, create connect before i.e. refuse);
 * - plugin deactivate/conversation delete by kernel side event drive closure stream (plugin.changed /
 *   conversation.deleted),HTTP layer do not polling;
 * - kernel not provide sessionDocEvents port when 501(forbid memory fall back).
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
    throw new ValidationError('conversation document subscribe must carry ?conversationId=<positive integer>')
  }
  const port = kernel.sessionDocEvents
  if (port === undefined) {
    throw new HelmError(
      'not_implemented',
      'when before runtime not provide conversation document event stream (sessionDocEvents port missing)',
      501,
    )
  }
  const target = { pluginId, name, conversationId }
  // sync snapshot provider: read also complete three heavy validate (404 semantics), fails sync throw to
  // on layer (hub rotate structure JSON error, client based on this stop retry); create connect race by
  // provider in subscribe establish after again validate honor bottom.
  const snapshot = () => {
    const doc = snapshotDocOf(kernel, pluginId, name, conversationId)
    return { seq: port.seq, doc }
  }
  void redactor
  return port.response(ctx.request, { snapshot, target })
}

/** snapshot read sync wrap:getPublicSessionDoc sync return when directly use, async when reject. */
function snapshotDocOf(
  kernel: KernelRuntimeLike,
  pluginId: string,
  name: string,
  conversationId: number,
): PublicPluginSessionDoc {
  const result = kernel.plugins.getPublicSessionDoc(pluginId, name, conversationId)
  if (result instanceof Promise) {
    // port contract want seek sync snapshot (dedicated use stream subscribe and snapshot the same atomic window); async implement
    // belongs to contract violate about, explicit reject while is not wait for after fabricate sync.
    throw new HelmError(
      'not_implemented',
      'when before runtime  getPublicSessionDoc is async implement, cannot provide sync conversation document snapshot',
      501,
    )
  }
  return result
}

/** GET/HEAD /api/plugins/:id/client.mjs: module reference boundary validate + ETag/304 + gzip. */
async function serveClientModule(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  pluginId: string,
): Promise<Response> {
  const { request, method, url } = ctx
  const moduleRef = url.searchParams.get('module')
  if (moduleRef === null || moduleRef.length === 0) {
    throw new ValidationError('missing module query parameter (each other for clientRoot  .ts/.tsx path)')
  }
  if (moduleRef.length > 256 || moduleRef.includes('..') || moduleRef.startsWith('/') || moduleRef.includes('\\')) {
    throw new ValidationError('module must be clientRoot inside each other for .ts/.tsx path (forbidden absolute path/..exceeds)')
  }
  const chunk = url.searchParams.get('chunk') ?? undefined
  const hash = url.searchParams.get('hash') ?? undefined
  if (chunk !== undefined) {
    if (!/^[A-Za-z0-9._-]+\.js$/.test(chunk) || chunk.includes('..')) {
      throw new HelmError('invalid_client_module', 'chunk name illegal (must match /^[A-Za-z0-9._-]+\\.js$/ and excludes ..)', 400)
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
 * plugin routing declaration carry complete path (PluginHost force /api/plugins/<id>/ prefix).
 * this where with complete declaration path and complete request path do the same match than for; and hub.ts 
 * public exemption decide shared use findPluginRoute, semantics do not drift.
 * handler receives original Request/URL(do not decode heavy write pathname, do not break signature semantics).
 */
async function dispatchPluginRoute(
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
  request: Request,
  method: string,
  segments: string[],
): Promise<Response> {
  // reference segments already strip 'api' prefix (['plugins', id, 'routes', ...rest]);
  // findPluginRoute match complete declaration path, patch back prefix segment unify semantics.
  const routes = kernel.plugins.listRoutes()
  const found = findPluginRoute(routes, method, ['api', ...segments])
  if (found === undefined) {
    const rest = segments.slice(4).join('/')
    return errorResponse(redactor, 404, 'route_not_found', `plugin routing missing: ${method} /${rest}`)
  }
  // deactivate gate a)- - summary re- inspect:listRoutes only by enabled filter, and snapshot take self dispatch
  // before, may and deactivate complete hand over wrong; dispatch before by plugin summary now read re-check, deactivated i.e. 409 reject
  // (does not request dispatch to already split destroy plugin half execute).
  const summary = kernel.plugins.get?.(found.pluginId)
  if (summary !== undefined && summary.enabled !== true) {
    throw new HelmError('plugin_disabled', `plugin ${found.pluginId} deactivated, routing unavailable`, 409, {
      pluginId: found.pluginId,
    })
  }
  // deactivate gate b)- - in-flight trace:handler execute count liveTasks(and action/tool
  // same source tracker, see capability-registry  invokeAction/executeTool wrap),
  // make disable  assertNoLiveTasks gate for in-flight route request visible.
  // leftover remaining window (such as declaration): public summary excludes lifecycle phase,disable enter
  // teardown after (enabled still true) new to request still will by dispatch - - completely closed together need to
  // PluginHost public phase aware dispatch gate (lifecycle-helpers 
  // getActiveEnabledPluginIds do not inspect phase, must across group modify plugins/).
  const invokeHandler = (): Promise<Response> => Promise.resolve(found.route.handler(request))
  const response = await (kernel.plugins.withTask !== undefined
    ? kernel.plugins.withTask(found.pluginId, `route:${found.route.method} ${found.route.path}`, invokeHandler)
    : invokeHandler())
  if (!(response instanceof Response)) {
    throw new HelmError('invalid_route_handler_output', 'plugin routing handler must return Response', 500)
  }
  return response
}

/**
 * plugin config redaction:schema in secret: true field value replace is '******'(already config) or
 * hide (not config); only public Schema declaration config, motion state plugin credentials do not belongs to config interface.
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
