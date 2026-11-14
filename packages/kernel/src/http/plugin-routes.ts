/**
 * 插件领域路由：/api/plugins（管理面 + doctor/rescan/install + config +
 * docs（含会话文档专用 SSE）+ client.mjs + routes/ 动态路由派发）与
 * /api/actions（动作清单与调用）。
 *
 * 停用门禁双闸：派发前按插件摘要现读复查（已停用 409）；handler 执行
 * 计入 liveTasks（与 action/tool 同源 tracker，disable 闸门可见）。
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
  // 外部插件 DX 闭环（无插件 id 段的顶点路由，先于 requireIdParam）。
  if (second === 'doctor' && method === 'POST' && third === undefined) {
    if (kernel.plugins.doctorExternalPlugin === undefined) {
      return errorResponse(redactor, 501, 'not_supported', '当前内核未提供插件静态自检能力')
    }
    const body = await readJsonBody(ctx.request)
    return jsonOk(redactor, await kernel.plugins.doctorExternalPlugin(parseDoctorTarget(body)))
  }
  if (second === 'rescan' && method === 'POST' && third === undefined) {
    if (kernel.plugins.rescanExternalPlugins === undefined) {
      return errorResponse(redactor, 501, 'not_supported', '当前内核未提供插件重扫描能力')
    }
    return jsonOk(redactor, await kernel.plugins.rescanExternalPlugins())
  }
  // 受管插件包安装（POST /api/plugins/install，body { source, enable? }）。
  if (second === 'install' && method === 'POST' && third === undefined) {
    if (kernel.plugins.installPluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', '当前内核未提供插件包安装能力')
    }
    const body = await readJsonBody(ctx.request)
    assertBodySchema(PLUGIN_INSTALL_BODY_SCHEMA, body, 'plugins install body')
    const source = body.source as string
    return jsonOk(redactor, await kernel.plugins.installPluginPackage(source, body.enable === true ? { enable: true } : {}))
  }
  const pluginId = requireIdParam(second ?? '', 'pluginId')
  // 核心管理面固定在第三段：enable/disable/config；其余仅剩 routes/ 动态路由。
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
  // 外部插件受控热重载（POST /api/plugins/:id/reload）：预检失败旧实例保持不动。
  if (third === 'reload' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.reloadExternalPlugin === undefined) {
      return errorResponse(redactor, 501, 'not_supported', '当前内核未提供插件热重载能力')
    }
    return jsonOk(redactor, await kernel.plugins.reloadExternalPlugin(pluginId))
  }
  // 受管插件包更新（POST /api/plugins/:id/update，与 CLI stub 约定保持 POST）。
  if (third === 'update' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.updatePluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', '当前内核未提供插件包更新能力')
    }
    return jsonOk(redactor, await kernel.plugins.updatePluginPackage(pluginId))
  }
  // 受管插件包移除（POST /api/plugins/:id/remove；与 CLI stub 约定保持 POST）。
  if (third === 'remove' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.removePluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', '当前内核未提供插件包移除能力')
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
      // secret 字段按 schema 脱敏出站：绝不让明文离开服务端。
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
  // 插件公共文档：GET /api/plugins/:pluginId/docs/:name（私有/停用/不存在 404）
  // ?conversationId=N 切换为会话文档读取；/events 后缀为会话文档专用 SSE。
  if (third === 'docs' && method === 'GET') {
    // 专用 SSE：GET /api/plugins/:id/docs/:name/events?conversationId=N
    // 路径段总数 = plugins(1) + id(2) + docs(3) + name(4) + events(5)。
    if (fourth !== undefined && fifth === 'events' && segments.length === 5) {
      return sessionDocEventsResponse(ctx, kernel, redactor, pluginId, decodeSegment(fourth))
    }
    if (fifth !== undefined) return errorResponse(redactor, 404, 'not_found', '路由不存在')
    if (fourth === undefined) throw new ValidationError('缺少 doc name 路径段')
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
  // 插件客户端模块：GET/HEAD /api/plugins/:pluginId/client.mjs?module=<相对路径>&chunk=<chunkName>&hash=<contentHash>
  // （鉴权由 hub 统一前置；停用/未声明/编译失败返回结构化错误 JSON，绝不返回半产物）
  if (third === 'client.mjs' && (method === 'GET' || method === 'HEAD') && fourth === undefined) {
    return serveClientModule(ctx, kernel, pluginId)
  }
  // 插件自定义动态路由：强制命名空间 /api/plugins/:pluginId/routes/...，
  // 不允许覆盖核心路由（enable/disable/config 已在上面先匹配）。
  if (third === 'routes') {
    return dispatchPluginRoute(kernel, redactor, ctx.request, method, segments)
  }
  return errorResponse(redactor, 404, 'not_found', '路由不存在')
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
    // null 是合法输出原样返回；undefined 是 output 边界违约，jsonOk
    // 显式抛错（伪造 {ok:true} 等于掩盖服务缺陷）。
    return jsonOk(redactor, result)
  }
  return errorResponse(redactor, 404, 'not_found', '路由不存在')
}

// ---------------------------------------------------------------------------
// 领域内辅助：body 校验 / 文档 SSE / client.mjs / 动态路由派发
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

/** POST /api/plugins/:id/disable body：仅 force（query ?force=1 同义）。 */
function parsePluginDisableBody(body: Record<string, unknown>): { force?: boolean } {
  assertBodySchema(
    { type: 'object', properties: { force: { type: 'boolean' } }, additionalProperties: false },
    body,
    'plugins disable body',
  )
  return body.force !== undefined ? { force: body.force as boolean } : {}
}

/**
 * POST /api/plugins/doctor body：目标择一——path / dir（目录绝对路径，dir 为
 * path 的兼容别名，等价）或 id（已注册插件，服务端解析其源目录）。
 * 非空/未知字段等机械形状由 schema 保证；绝对路径、别名一致性与
 * id 互斥等跨字段语义手写。目录存在性/入口合法性由 doctor 检查链真实判定。
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
    if (!v.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(v) && !v.startsWith('\\\\')) {
      throw new ValidationError(`${field} 需为绝对路径（以 / 或盘符开头）`)
    }
    return v
  }
  const pathDir = dirLike(body.path, 'path')
  const dirDir = dirLike(body.dir, 'dir')
  if (pathDir !== undefined && dirDir !== undefined && pathDir !== dirDir) {
    throw new ValidationError('path 与 dir 同时提供且不一致（两者为兼容别名，请只传其一）')
  }
  if (body.id !== undefined) {
    if (pathDir !== undefined || dirDir !== undefined) {
      throw new ValidationError('id 与 path/dir 互斥（择一提供）')
    }
    return { id: body.id as string }
  }
  const resolved = pathDir ?? dirDir
  if (resolved === undefined) {
    throw new ValidationError('需提供目标：path/dir（目录绝对路径）或 id（已注册插件）')
  }
  return { dir: resolved }
}

/** ?conversationId=N 查询参数：正整数会话 ID；非正整数/非数字 400。 */
function parseConversationIdQuery(url: URL): number | undefined {
  const raw = url.searchParams.get('conversationId')
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError('conversationId 需为正整数')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError('conversationId 需为正整数')
  }
  return value
}

/**
 * 会话文档专用 SSE：GET /api/plugins/:id/docs/:name/events?conversationId=N。
 * - 鉴权与 GET 同源（hub 统一前置，无 public 豁免；未授权返回结构化 JSON 401）；
 * - 传给端口的是同步快照 provider（而非预先取好的快照）：枢纽先建缓冲订阅
 *   再调 provider，消除「先快照后订阅」的丢帧窗口；provider 内完成
 *   插件启用 + 文档 public + 会话存在三重校验（失败抛 404/400，建连前即拒）；
 * - 插件停用/会话删除由 kernel 侧事件驱动关流（plugin.changed /
 *   conversation.deleted），HTTP 层不轮询；
 * - kernel 未提供 sessionDocEvents 端口时 501（禁内存降级）。
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
    throw new ValidationError('会话文档订阅必须携带 ?conversationId=<正整数>')
  }
  const port = kernel.sessionDocEvents
  if (port === undefined) {
    throw new HelmError(
      'not_implemented',
      '当前 runtime 未提供会话文档事件流（sessionDocEvents 端口缺失）',
      501,
    )
  }
  const target = { pluginId, name, conversationId }
  // 同步快照 provider：读取同时完成三重校验（404 语义），出错同步抛给
  // 上层（hub 转结构化 JSON 错误，客户端据此停止重试）；建连 race 由
  // provider 在订阅建立后再次校验兑底。
  const snapshot = () => {
    const doc = snapshotDocOf(kernel, pluginId, name, conversationId)
    return { seq: port.seq, doc }
  }
  void redactor
  return port.response(ctx.request, { snapshot, target })
}

/** 快照读取的同步包装：getPublicSessionDoc 同步返回时直接使用，异步时拒绝。 */
function snapshotDocOf(
  kernel: KernelRuntimeLike,
  pluginId: string,
  name: string,
  conversationId: number,
): PublicPluginSessionDoc {
  const result = kernel.plugins.getPublicSessionDoc(pluginId, name, conversationId)
  if (result instanceof Promise) {
    // 端口契约要求同步快照（专用流订阅与快照同一原子窗口）；异步实现
    // 属于契约违约，显式拒绝而不是等待后伪造同步性。
    throw new HelmError(
      'not_implemented',
      '当前 runtime 的 getPublicSessionDoc 为异步实现，无法提供同步会话文档快照',
      501,
    )
  }
  return result
}

/** GET/HEAD /api/plugins/:id/client.mjs：模块引用边界校验 + ETag/304 + gzip。 */
async function serveClientModule(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  pluginId: string,
): Promise<Response> {
  const { request, method, url } = ctx
  const moduleRef = url.searchParams.get('module')
  if (moduleRef === null || moduleRef.length === 0) {
    throw new ValidationError('缺少 module 查询参数（相对 clientRoot 的 .ts/.tsx 路径）')
  }
  if (moduleRef.length > 256 || moduleRef.includes('..') || moduleRef.startsWith('/') || moduleRef.includes('\\')) {
    throw new ValidationError('module 需为 clientRoot 内相对 .ts/.tsx 路径（禁止绝对路径/..越根）')
  }
  const chunk = url.searchParams.get('chunk') ?? undefined
  const hash = url.searchParams.get('hash') ?? undefined
  if (chunk !== undefined) {
    if (!/^[A-Za-z0-9._-]+\.js$/.test(chunk) || chunk.includes('..')) {
      throw new HelmError('invalid_client_module', 'chunk 名称非法（需匹配 /^[A-Za-z0-9._-]+\\.js$/ 且不含 ..）', 400)
    }
  }
  const compiled = await kernel.plugins.getClientModule(pluginId, moduleRef, {
    ...(chunk !== undefined ? { chunk } : {}),
    ...(hash !== undefined ? { hash } : {}),
  })
  const etag = chunk !== undefined ? `"${compiled.contentHash}:${chunk}"` : `"${compiled.contentHash}"`
  const isImmutable = chunk !== undefined && hash !== undefined && hash === compiled.contentHash
  const cacheControl = isImmutable ? 'private, max-age=31536000, immutable' : 'private, no-cache'

  const ifNoneMatch = request.headers.get('if-none-match')
  // chunk 请求只接受完整 chunk ETag（hash:chunk）匹配——裸 contentHash 会把同 hash 下
  // 其他 chunk 的缓存误判为命中；主模块请求保留强 ETag / 裸 hash / W/ 三形态兼容。
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
 * 插件路由声明携带完整路径（PluginHost 强制 /api/plugins/<id>/ 前缀）。
 * 此处以完整声明路径与完整请求路径做同一匹配器的比对；与 hub.ts 的
 * public 豁免判定共用 findPluginRoute，语义不漂移。
 * handler 收到原始 Request/URL（不解码重写 pathname，不破坏签名语义）。
 */
async function dispatchPluginRoute(
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
  request: Request,
  method: string,
  segments: string[],
): Promise<Response> {
  // 入参 segments 已剥离 'api' 前缀（['plugins', id, 'routes', ...rest]）；
  // findPluginRoute 匹配完整声明路径，补回前缀段统一语义。
  const routes = kernel.plugins.listRoutes()
  const found = findPluginRoute(routes, method, ['api', ...segments])
  if (found === undefined) {
    const rest = segments.slice(4).join('/')
    return errorResponse(redactor, 404, 'route_not_found', `插件路由不存在: ${method} /${rest}`)
  }
  // 停用门禁 a)——摘要复查：listRoutes 只按 enabled 过滤，且快照取自派发
  // 前，可能与停用完成交错；派发前按插件摘要现读复核，已停用即 409 拒绝
  // （不把请求派发给已拆毁的插件半执行）。
  const summary = kernel.plugins.get?.(found.pluginId)
  if (summary !== undefined && summary.enabled !== true) {
    throw new HelmError('plugin_disabled', `插件 ${found.pluginId} 已停用，路由不可用`, 409, {
      pluginId: found.pluginId,
    })
  }
  // 停用门禁 b)——在途跟踪：handler 执行计入 liveTasks（与 action/tool
  // 同源 tracker，见 capability-registry 的 invokeAction/executeTool 包装），
  // 使 disable 的 assertNoLiveTasks 闸门对在途 route 请求可见。
  // 残余窗口（如实声明）：公开摘要不含 lifecycle phase，disable 进入
  // teardown 后（enabled 仍真）新到请求仍会被派发——彻底闭合需要
  // PluginHost 公开 phase 感知的派发门禁（lifecycle-helpers 的
  // getActiveEnabledPluginIds 不查 phase，需跨组修改 plugins/）。
  const invokeHandler = (): Promise<Response> => Promise.resolve(found.route.handler(request))
  const response = await (kernel.plugins.withTask !== undefined
    ? kernel.plugins.withTask(found.pluginId, `route:${found.route.method} ${found.route.path}`, invokeHandler)
    : invokeHandler())
  if (!(response instanceof Response)) {
    throw new HelmError('invalid_route_handler_output', '插件路由 handler 必须返回 Response', 500)
  }
  return response
}

/**
 * 插件配置脱敏：schema 中 secret: true 的字段值替换为 '******'（已配置）或
 * 隐藏（未配置）；只公开 Schema 声明的配置，动态插件凭据不属于配置接口。
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
