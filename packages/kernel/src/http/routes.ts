/**
 * 核心 API 路由：auth / events(SSE) / conversations / asks / profiles /
 * providers / credentials / models / skills / artifacts / search / plugins /
 * actions / workflows + 插件动态路由。
 *
 * 路由规则：方法 + 精确路径段匹配，未知路由 404。鉴权在 hub.ts 统一前置，
 * 本模块只处理已认证请求（auth 三端点除外）。
 */
import { ROOT_CONVERSATION_ID, HelmError } from '@helm/protocol'
import type {
  ActionManifest,
  ArtifactMetadata,
  ConversationStatus,
  PluginConfigFieldSchema,
  WorkflowRunSummary,
} from '@helm/protocol'
import { resolve as nodePathResolve, sep as nodePathSep } from 'node:path'
import { readFile as nodeFsReadFile } from 'node:fs/promises'
import {
  AuthAlreadyConfiguredError,
  InvalidCredentialsError,
  WeakPasswordError,
  FileNotFoundError,
} from '../services/index.js'

class AuthNotSetupError extends Error {}
import type { KernelRuntimeLike, PluginRouteInfo, WorkflowServiceLike } from './contracts.js'
import { errorResponse, jsonOk, MAX_WORKFLOW_BODY_BYTES, readJsonBody } from './http-utils.js'
import { openSse } from './sse.js'
import {
  parseActionInvokeBody,
  parseAskAnswerBody,
  parseConversationInit,
  parseConversationPatch,
  parseCredentialBody,
  parseIdParam,
  parseInputBody,
  parsePluginConfigBody,
  parseProfileBody,
  parseProvidersBody,
  parseWorkflowRunBody,
  requireIdParam,
  ValidationError,
} from './validate.js'

export interface RouterDeps {
  kernel: KernelRuntimeLike
  workflows: WorkflowServiceLike
}

/** 已解析路径（/api 前缀已剥离）。 */
interface RouteContext {
  request: Request
  method: string
  segments: string[]
  url: URL
}

const CONTENT_DISPOSITION_SAFE = /^[^"\\\r\n]{1,200}$/

export async function handleApi(
  request: Request,
  kernel: KernelRuntimeLike,
  workflows: WorkflowServiceLike,
): Promise<Response> {
  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  // 剥离 api 前缀
  if (segments[0] === 'api') segments.shift()
  const ctx: RouteContext = { request, method: request.method, segments, url }

  try {
    const response = await route(ctx, kernel, workflows)
    return response
  } catch (error) {
    const mapped = mapServiceError(error)
    if (mapped !== undefined) return mapped
    throw error // 顶层 500 处理在 hub.ts
  }
}

/**
 * 服务层自定义 Error → 结构化 HTTP 错误（不能任其变成 500）。
 * - 鉴权：AuthAlreadyConfiguredError 409 / InvalidCredentialsError 401 / WeakPasswordError 400。
 * - 文件资产：FileNotFoundError 404；其他校验错误 400。
 */
function mapServiceError(error: unknown): Response | undefined {
  if (error instanceof AuthAlreadyConfiguredError) {
    return errorResponse(409, 'already_setup', error.message)
  }
  if (error instanceof InvalidCredentialsError) {
    return errorResponse(401, 'invalid_credentials', error.message)
  }
  if (error instanceof WeakPasswordError) {
    return errorResponse(400, 'weak_password', error.message)
  }
  if (error instanceof FileNotFoundError) {
    return errorResponse(404, 'not_found', error.message)
  }
  if (error instanceof AuthNotSetupError) {
    return errorResponse(409, 'not_setup', error.message)
  }
  if (error instanceof Error && error.message.includes('尚未完成 setup')) {
    return errorResponse(409, 'not_setup', error.message)
  }
  return undefined
}

async function route(ctx: RouteContext, kernel: KernelRuntimeLike, workflows: WorkflowServiceLike): Promise<Response> {
  const { method, segments } = ctx
  const head = segments[0]
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]

  if (head === undefined) return errorResponse(404, 'not_found', '路由不存在')

  // ---- auth（公开，hub.ts 前置放行）----------------------------------------
  if (head === 'auth') {
    if (second === 'status' && method === 'GET') {
      const status = await kernel.auth.status()
      return jsonOk({ configured: status.configured, authenticated: true })
    }
    if (second === 'setup' && method === 'POST') {
      const body = await readJsonBody(ctx.request)
      const password = requiredStringField(body, 'password')
      const issued = await kernel.auth.setup(password)
      return jsonOk({ token: issued.token })
    }
    if (second === 'login' && method === 'POST') {
      const body = await readJsonBody(ctx.request)
      const password = requiredStringField(body, 'password')
      const issued = await kernel.auth.login(password)
      return jsonOk({ token: issued.token })
    }
    return errorResponse(404, 'not_found', '路由不存在')
  }

  // ---- events：全局 SSE ------------------------------------------------------
  if (head === 'events' && method === 'GET' && second === undefined) {
    return kernel.events.response(ctx.request)
  }

  // ---- conversations --------------------------------------------------------
  if (head === 'conversations') {
    if (second === undefined) {
      if (method === 'GET') {
        return jsonOk(await kernel.listConversations(parseConversationFilter(ctx.url)))
      }
      if (method === 'POST') {
        const body = await readJsonBody(ctx.request)
        const init = parseConversationInit(body)
        return jsonOk(await kernel.createConversation(init), { status: 201 })
      }
      return methodNotAllowed(method)
    }
    const id = parseIdParam(second)
    if (third === undefined) {
      if (method === 'GET') return jsonOk(await kernel.getConversation(id))
      if (method === 'PATCH') {
        const body = await readJsonBody(ctx.request)
        return jsonOk(await kernel.updateConversation(id, parseConversationPatch(body)))
      }
      if (method === 'DELETE') {
        if (id === ROOT_CONVERSATION_ID) {
          throw new HelmError('root_conversation_protected', '常驻根会话 #1 不可删除', 403)
        }
        await kernel.deleteConversation(id)
        return jsonOk({ ok: true })
      }
      return methodNotAllowed(method)
    }
    if (third === 'input' && method === 'POST' && fourth === undefined) {
      const body = await readJsonBody(ctx.request)
      const { text, whenBusy, origin } = parseInputBody(body)
      await kernel.submitInput(id, text, { ...(origin !== undefined ? { origin } : {}), ...(whenBusy !== undefined ? { whenBusy } : {}) })
      return jsonOk({ ok: true })
    }
    if (third === 'abort' && method === 'POST' && fourth === undefined) {
      await kernel.abortConversation(id)
      return jsonOk({ ok: true })
    }
    if (third === 'artifacts' && method === 'GET' && fourth === undefined) {
      return jsonOk(await kernel.artifacts.list(id))
    }
    return errorResponse(404, 'not_found', '路由不存在')
  }

  // ---- asks ---------------------------------------------------------------
  if (head === 'asks') {
    if (second === undefined && method === 'GET') {
      return jsonOk(await kernel.listAsks())
    }
    const askId = requireIdParam(second ?? '', 'askId')
    if (third === 'answer' && method === 'POST' && fourth === undefined) {
      const body = await readJsonBody(ctx.request)
      const { answers, expectedStateSeq } = parseAskAnswerBody(body)
      await kernel.answerAsk(askId, answers, expectedStateSeq)
      return jsonOk({ ok: true })
    }
    if (third === 'cancel' && method === 'POST' && fourth === undefined) {
      await kernel.cancelAsk(askId)
      return jsonOk({ ok: true })
    }
    return errorResponse(404, 'not_found', '路由不存在')
  }

  // ---- profiles -------------------------------------------------------------
  if (head === 'profiles') {
    if (second === undefined) {
      if (method === 'GET') return jsonOk(await kernel.profiles.list())
      if (method === 'POST') {
        const body = await readJsonBody(ctx.request)
        const profile = parseProfileBody(body, { requireId: true })
        return jsonOk(await kernel.profiles.save(profile), { status: 201 })
      }
      return methodNotAllowed(method)
    }
    const profileId = second
    if (third === undefined) {
      if (method === 'GET') {
        const found = await kernel.profiles.get(profileId)
        if (found === undefined) throw new HelmError('not_found', `profile 不存在: ${profileId}`, 404)
        return jsonOk(found)
      }
      if (method === 'PUT') {
        const body = await readJsonBody(ctx.request)
        const profile = parseProfileBody(body, { requireId: false })
        if (profile.id !== undefined && profile.id !== profileId) {
          throw new ValidationError('body.id（若提供）需与路径参数一致')
        }
        return jsonOk(await kernel.profiles.save({ ...profile, id: profileId }))
      }
      if (method === 'DELETE') {
        await kernel.profiles.delete(profileId)
        return jsonOk({ ok: true })
      }
      return methodNotAllowed(method)
    }
    return errorResponse(404, 'not_found', '路由不存在')
  }

  // ---- providers（完整 array；无 secret 字段） -------------------------------
  if (head === 'providers' && second === undefined) {
    if (method === 'GET') return jsonOk(await kernel.providers.list())
    if (method === 'PUT') {
      const body = await readJsonBody(ctx.request)
      const providers = parseProvidersBody(body)
      return jsonOk(await kernel.providers.save(providers))
    }
    return methodNotAllowed(method)
  }

  // ---- credentials（仅 id/configured；PUT/DELETE/:id 写删） -------------------
  if (head === 'credentials') {
    if (second === undefined && method === 'GET') {
      const ids = await kernel.credentials.list()
      return jsonOk(ids.map((id) => ({ id, configured: true })))
    }
    const credId = requireIdParam(second ?? '', 'credentialId')
    if (third === undefined && method === 'PUT') {
      const body = await readJsonBody(ctx.request)
      await kernel.credentials.set(credId, parseCredentialBody(body))
      return jsonOk({ ok: true })
    }
    if (third === undefined && method === 'DELETE') {
      await kernel.credentials.delete(credId)
      return jsonOk({ ok: true })
    }
    return errorResponse(404, 'not_found', '路由不存在')
  }

  // ---- models / skills -------------------------------------------------------
  if (head === 'models' && second === undefined && method === 'GET') {
    return jsonOk(await kernel.listModels())
  }
  if (head === 'skills') {
    if (second === undefined && method === 'GET') {
      return jsonOk(await kernel.skills.list())
    }
    const skillId = second
    if (skillId === undefined) return errorResponse(404, 'not_found', '路由不存在')
    if (third === undefined && method === 'GET') {
      const path = ctx.url.searchParams.get('path') ?? undefined
      if (path !== undefined && !isSafeRelativePath(path)) {
        throw new HelmError('path_traversal', `技能文件路径越界: ${skillId}/${path}`, 400)
      }
      const text = await kernel.skills.readFile(skillId, path)
      return jsonOk({ text })
    }
    return errorResponse(404, 'not_found', '路由不存在')
  }

  // ---- artifacts -------------------------------------------------------------
  if (head === 'artifacts') {
    if (second !== undefined && third === 'content' && method === 'GET' && fourth === undefined) {
      const artifactId = requireIdParam(second, 'artifactId')
      const metadata = await kernel.artifacts.get(artifactId)
      // 从登记元数据的安全相对路径读原始字节（readContent 仅透文本，会损坏二进制）。
      const buffer = await readArtifactBytes(kernel, metadata)
      const inline = ctx.url.searchParams.get('inline') === '1'
      const headers: Record<string, string> = {
        'content-type': metadata.mimeType,
        'content-length': String(buffer.byteLength),
      }
      if (CONTENT_DISPOSITION_SAFE.test(metadata.name)) {
        headers['content-disposition'] = `${inline ? 'inline' : 'attachment'}; filename="${metadata.name}"`
      }
      return new Response(buffer as unknown as BodyInit, { headers })
    }
    return errorResponse(404, 'not_found', '路由不存在')
  }

  // ---- search ---------------------------------------------------------------
  if (head === 'search' && second === undefined && method === 'GET') {
    const q = ctx.url.searchParams.get('q') ?? ''
    if (q.trim().length === 0) throw new ValidationError('q 不能为空')
    return jsonOk(await kernel.search(q))
  }

  // ---- plugins ---------------------------------------------------------------
  if (head === 'plugins') {
    if (second === undefined && method === 'GET') {
      return jsonOk(await kernel.plugins.list())
    }
    const pluginId = second
    if (pluginId === undefined) return errorResponse(404, 'not_found', '路由不存在')
    // 核心管理面固定在第三段：enable/disable/config；其余仅剩 routes/ 动态路由。
    if (third === 'enable' && method === 'POST' && fourth === undefined) {
      await kernel.plugins.enable(pluginId)
      return jsonOk(await kernel.plugins.list())
    }
    if (third === 'disable' && method === 'POST' && fourth === undefined) {
      await kernel.plugins.disable(pluginId)
      return jsonOk(await kernel.plugins.list())
    }
    if (third === 'config' && fourth === undefined) {
      if (method === 'GET') {
        const [raw, schema] = await Promise.all([
          Promise.resolve(kernel.plugins.getConfig(pluginId)),
          Promise.resolve(kernel.plugins.getConfigSchema(pluginId)),
        ])
        // secret 字段按 schema 脱敏出站：绝不让明文离开服务端。
        const values = redactConfigValues(raw, schema)
        return jsonOk({ values, schema })
      }
      if (method === 'PUT') {
        const body = await readJsonBody(ctx.request)
        await kernel.plugins.setConfig(pluginId, parsePluginConfigBody(body))
        return jsonOk({ ok: true })
      }
      return methodNotAllowed(method)
    }
    // 插件自定义动态路由：强制命名空间 /api/plugins/:pluginId/routes/...，
    // 不允许覆盖核心路由（enable/disable/config 已在上面先匹配）。
    if (third === 'routes') {
      return dispatchPluginRoute(kernel, ctx.request, method, segments)
    }
    return errorResponse(404, 'not_found', '路由不存在')
  }

  // ---- actions ---------------------------------------------------------------
  if (head === 'actions') {
    if (second === undefined && method === 'GET') {
      return jsonOk(await kernel.plugins.listActions())
    }
    const pluginId = requireIdParam(second ?? '', 'pluginId')
    const actionId = requireIdParam(third ?? '', 'actionId')
    if (method === 'POST' && fourth === undefined) {
      const body = await readJsonBody(ctx.request)
      const { input, conversationId } = parseActionInvokeBody(body)
      const result = await kernel.plugins.invokeAction(pluginId, actionId, input, conversationId !== undefined ? { conversationId } : undefined)
      return jsonOk(result ?? { ok: true })
    }
    return errorResponse(404, 'not_found', '路由不存在')
  }

  // ---- workflows -------------------------------------------------------------
  if (head === 'workflows') {
    if (second === undefined && method === 'GET') {
      return jsonOk(await workflows.list())
    }
    if (second === 'run' && method === 'POST' && third === undefined) {
      const body = await readJsonBody(ctx.request, MAX_WORKFLOW_BODY_BYTES)
      const runRequest = parseWorkflowRunBody(body)
      const started = await workflows.run(runRequest)
      const summary =
        typeof started === 'object' && started !== null && 'status' in started
          ? (started as WorkflowRunSummary)
          : undefined
      if (summary !== undefined) {
        return jsonOk(summary, { status: 202 })
      }
      // 只拿到 runId 句柄：如实返回句柄，不伪造完整 Summary。
      return jsonOk(started, { status: 202 })
    }
    if (second === 'runs') {
      const runId = requireIdParam(third ?? '', 'runId')
      if (method === 'GET' && fourth === undefined) {
        const run = await workflows.getRun(runId)
        if (run === undefined) throw new HelmError('not_found', `工作流运行不存在: ${runId}`, 404)
        return jsonOk(run)
      }
      if (fourth === 'abort' && method === 'POST') {
        await workflows.abort(runId)
        return jsonOk({ ok: true })
      }
      return errorResponse(404, 'not_found', '路由不存在')
    }
    return errorResponse(404, 'not_found', '路由不存在')
  }

  return errorResponse(404, 'not_found', '路由不存在')
}

// ---------------------------------------------------------------------------
// 插件动态路由：强制 /api/plugins/:pluginId/routes/<rest...> 命名空间，
// 不允许覆盖核心路由（核心路由全部先匹配，此处仅剩 routes/ 前缀）。
// ---------------------------------------------------------------------------

function dispatchPluginRoute(kernel: KernelRuntimeLike, request: Request, method: string, segments: string[]): Response | Promise<Response> {
  // segments: ['plugins', pluginId, 'routes', ...rest]
  const pluginId = segments[1]
  if (pluginId === undefined) return errorResponse(404, 'not_found', '路由不存在')
  const rest = segments.slice(3)
  if (rest.length === 0) return errorResponse(404, 'not_found', '路由不存在')
  const decodedPluginId = safeDecode(pluginId)
  const routes = kernel.plugins.listRoutes()
  const route = routes.find((r) => {
    if (r.pluginId !== decodedPluginId || r.method !== method) return false
    return matchRoutePath(r.path, rest)
  })
  if (route === undefined) return errorResponse(404, 'route_not_found', `插件路由不存在: ${method} /${rest.map(safeDecode).join('/')}`)
  // 重写 URL 为插件声明的相对路径语义（解码后的段直接拼接，handler 自行解析）
  const url = new URL(request.url)
  url.pathname = `/${rest.map((s) => safeDecode(s)).join('/')}`
  const forwarded = new Request(url, request)
  return Promise.resolve(route.handler(forwarded))
}

function matchRoutePath(declared: string, restSegments: string[]): boolean {
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

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function requiredStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 需为非空字符串`)
  }
  return value
}

function parseConversationFilter(url: URL): { tag?: string; status?: ConversationStatus } {
  const tag = url.searchParams.get('tag') ?? undefined
  const status = url.searchParams.get('status') ?? undefined
  if (status !== undefined && !['working', 'blocked', 'done', 'idle', 'error'].includes(status)) {
    throw new ValidationError('status 需为 working|blocked|done|idle|error')
  }
  return { ...(tag !== undefined ? { tag } : {}), ...(status !== undefined ? { status: status as ConversationStatus } : {}) }
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false
  if (path.startsWith('/') || path.includes('\\')) return false
  const parts = path.split('/')
  return parts.every((p) => p.length > 0 && p !== '.' && p !== '..')
}

function methodNotAllowed(method: string): Response {
  return errorResponse(405, 'method_not_allowed', `方法不允许: ${method}`)
}

/**
 * 插件配置脱敏：schema 中 secret: true 的字段值替换为 '******'（已配置）或
 * 隐藏（未配置）；其余字段原样。绝不让 secret 明文出站。
 */
function redactConfigValues(
  raw: Record<string, unknown>,
  schema: Record<string, PluginConfigFieldSchema>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (schema[key]?.secret === true) {
      out[key] = typeof value === 'string' && value.length > 0 ? '******' : ''
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * 按登记元数据读取产物原始字节。
 * metadata.path 是相对 dataDir 的登记路径（artifacts/<convId>/<stored>），
 * 此处再做一层包含校验：绝不接受任意路径读。
 */
async function readArtifactBytes(kernel: KernelRuntimeLike, metadata: ArtifactMetadata): Promise<Uint8Array> {
  const rel = metadata.path
  if (typeof rel !== 'string' || rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) {
    throw new HelmError('artifact_path_illegal', '产物登记路径非法', 500)
  }
  const abs = nodePathResolve(kernel.dataDir, rel)
  const dataDirAbs = nodePathResolve(kernel.dataDir)
  if (abs !== dataDirAbs && !abs.startsWith(dataDirAbs + nodePathSep)) {
    throw new HelmError('artifact_path_illegal', '产物登记路径越界', 500)
  }
  try {
    const buffer = await nodeFsReadFile(abs)
    return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
  } catch {
    throw new HelmError('artifact_file_missing', `产物文件缺失: ${metadata.id}`, 404)
  }
}
