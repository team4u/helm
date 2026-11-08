/**
 * 核心 API 路由：auth / events(SSE) / conversations / asks / profiles /
 * providers / credentials / models / skills / artifacts / search / plugins /
 * actions / workflows + 插件动态路由。
 *
 * 路由规则：方法 + 精确路径段匹配（段数必须完全一致，多余段一律 404，
 * 绝不让 /auth/status/foo 之类落入操作分支）；段值经严格百分号解码
 * （非法编码 400）。鉴权在 hub.ts 统一前置，本模块只处理已认证请求
 * （auth 三端点除外）。
 *
 * 出站 JSON 一律经 redactor 脱敏（kernel.stash 存在时）；插件动作结果
 * 原样返回（null 就是 null，undefined 是 output 边界违约，显式 500）。
 */
import { ROOT_CONVERSATION_ID, HelmError } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'
import type {
  EnvExecStreamFrame,
  ArtifactMetadata,
  ConversationStatus,
  PluginConfigFieldSchema,
  Profile,
  WorkflowRunSummary,
} from '@helm/protocol'
import { realpath as nodeFsRealpath, readFile as nodeFsReadFile } from 'node:fs/promises'
import { join as joinPath, sep as PATH_SEP } from 'node:path'
import {
  AuthAlreadyConfiguredError,
  InvalidCredentialsError,
  WeakPasswordError,
  FileNotFoundError,
} from '../services/index.js'
import { MAX_ARTIFACT_BYTES } from '../services/artifacts.js'

class AuthNotSetupError extends Error {}
import type { KernelRuntimeLike, PluginRouteInfo, WorkflowServiceLike } from './contracts.js'
import {
  errorResponse,
  jsonOk,
  MAX_WORKFLOW_BODY_BYTES,
  readBinaryBodyWithLimit,
  readBody,
  readJsonBody,
  readJsonValue,
  DEFAULT_MAX_BODY_BYTES,
  type JsonRedactor,
} from './http-utils.js'
import { decodeSegment, findPluginRoute } from './route-match.js'
import { isAbsoluteTargetPath } from '../runtime/tools.js'
import {
  parseActionInvokeBody,
  parseAskAnswerBody,
  parseConversationCompactBody,
  parseConversationForkBody,
  parseConversationInit,
  parseConversationPatch,
  parseConversationResetBody,
  parseConversationWithdrawBody,
  parseCredentialBody,
  parseDetailPagination,
  parseDocNameParam,
  parseIdParam,
  parseInputBody,
  parsePluginConfigBody,
  parseProfileBody,
  parseProvidersBody,
  parseWorkflowRunBody,
  parseWorktreeCleanupBody,
  requireIdParam,
  ValidationError,
  rejectUnknownKeys,
} from './validate.js'

export interface RouterDeps {
  kernel: KernelRuntimeLike
  workflows: WorkflowServiceLike
}

/** 已解析路径（/api 前缀已剥离，段已解码）。 */
interface RouteContext {
  request: Request
  method: string
  segments: string[]
  url: URL
}


export async function handleApi(
  request: Request,
  kernel: KernelRuntimeLike,
  workflows: WorkflowServiceLike,
  redactor?: JsonRedactor,
): Promise<Response> {
  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  // 剥离 api 前缀
  if (segments[0] === 'api') segments.shift()
  const ctx: RouteContext = { request, method: request.method, segments, url }

  try {
    const response = await route(ctx, kernel, workflows, redactor)
    return response
  } catch (error) {
    const mapped = mapServiceError(redactor, error)
    if (mapped !== undefined) return mapped
    throw error // 顶层 500 处理在 hub.ts
  }
}

/**
 * 服务层自定义 Error → 结构化 HTTP 错误（不能任其变成 500）。
 * - 鉴权：AuthAlreadyConfiguredError 409 / InvalidCredentialsError 401 / WeakPasswordError 400。
 * - 文件资产：FileNotFoundError 404；其他校验错误 400。
 */
function mapServiceError(redactor: JsonRedactor | undefined, error: unknown): Response | undefined {
  if (error instanceof AuthAlreadyConfiguredError) {
    return errorResponse(redactor, 409, 'already_setup', error.message)
  }
  if (error instanceof InvalidCredentialsError) {
    return errorResponse(redactor, 401, 'invalid_credentials', error.message)
  }
  if (error instanceof WeakPasswordError) {
    return errorResponse(redactor, 400, 'weak_password', error.message)
  }
  if (error instanceof FileNotFoundError) {
    return errorResponse(redactor, 404, 'not_found', error.message)
  }
  if (error instanceof AuthNotSetupError) {
    return errorResponse(redactor, 409, 'not_setup', error.message)
  }
  if (error instanceof Error && error.message.includes('尚未完成 setup')) {
    return errorResponse(redactor, 409, 'not_setup', error.message)
  }
  return undefined
}

async function route(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  workflows: WorkflowServiceLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  // 统一严格解码每个路径段（hub.ts 已对整路径做过一次；此处对已剥离
  // api 前缀的段再解一次是幂等的——已解码段不含 '%' 时直接原样返回）。
  const seg = segments.map((s) => decodeSegment(s))
  const head = seg[0]
  const second = seg[1]
  const third = seg[2]
  const fourth = seg[3]
  const fifth = seg[4]

  if (head === undefined) return errorResponse(redactor, 404, 'not_found', '路由不存在')

  // ---- auth（公开，hub.ts 前置放行）----------------------------------------
  if (head === 'auth') {
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
      const password = requiredStringField(body, 'password')
      const issued = await kernel.auth.setup(password)
      return jsonOk(redactor, { token: issued.token })
    }
    if (second === 'login' && method === 'POST' && third === undefined) {
      const body = await readJsonBody(ctx.request)
      const password = requiredStringField(body, 'password')
      const issued = await kernel.auth.login(password)
      return jsonOk(redactor, { token: issued.token })
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }

  // ---- events：全局 SSE ------------------------------------------------------
  if (head === 'events' && method === 'GET' && second === undefined) {
    return kernel.events.response(ctx.request)
  }

  // ---- nodes（跨平台节点管理）----------------------------------------------
  if (head === 'nodes') {
    if (second === undefined && method === 'GET') {
      return jsonOk(redactor, await kernel.listNodes())
    }
    if (second === 'issue' && method === 'POST' && third === undefined) {
      const body = await readJsonBody(ctx.request)
      const nodeId = requiredStringField(body, 'nodeId')
      rejectUnknownKeys(body, new Set(['nodeId']))
      const issued = await kernel.issueNodeToken(nodeId)
      // 明文 token 仅本次响应一次性返回（此后任何 JSON 输出都不可再见明文：
      // token 已入出站脱敏登记）。此处不能经统一 redactor（会把 token 换成
      // [REDACTED]）：手写响应体，只透出契约字段。
      return new Response(
        JSON.stringify({ nodeId: issued.nodeId, token: issued.token, createdAt: issued.createdAt }),
        {
          status: 201,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        },
      )
    }
    if (second !== undefined && third === undefined && method === 'DELETE') {
      const nodeId = requireNodeSegment(second)
      await kernel.removeNode(nodeId)
      return jsonOk(redactor, { ok: true })
    }
    // ---- 节点升级：GET /:id/upgrade/check、POST /:id/upgrade -----------------
    if (second !== undefined && third === 'upgrade') {
      const nodeId = requireNodeSegment(second)
      if (fourth === 'check' && method === 'GET') {
        if (fifth !== undefined) return errorResponse(redactor, 404, 'not_found', '路由不存在')
        if (kernel.checkNodeUpgrade === undefined) {
          throw new HelmError('not_implemented', '当前 runtime 未提供节点升级检查', 501)
        }
        return jsonOk(redactor, await kernel.checkNodeUpgrade(nodeId, parseNodeUpgradeCheckQuery(ctx.url)))
      }
      if (fourth === undefined && method === 'POST') {
        if (kernel.upgradeNode === undefined) {
          throw new HelmError('not_implemented', '当前 runtime 未提供节点升级', 501)
        }
        const body = await parseOptionalJsonObjectBody(ctx.request, parseNodeUpgradeBody)
        return jsonOk(redactor, await kernel.upgradeNode(nodeId, body))
      }
      return errorResponse(redactor, 404, 'not_found', '路由不存在')
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }

  // ---- env exec（跨节点命令执行）--------------------------------------------
  if (head === 'env' && second === 'exec' && method === 'POST' && third === undefined) {
    return postEnvExec(ctx, kernel, redactor)
  }

  // ---- conversations --------------------------------------------------------
  if (head === 'conversations') {
    if (second === undefined) {
      if (method === 'GET') {
        return jsonOk(redactor, await kernel.listConversations(parseConversationFilter(ctx.url)))
      }
      if (method === 'POST') {
        const body = await readJsonBody(ctx.request)
        const init = parseConversationInit(body)
        return jsonOk(redactor, await kernel.createConversation(init), { status: 201 })
      }
      return methodNotAllowed(redactor, method)
    }
    const id = parseIdParam(second)
    if (third === undefined) {
      if (method === 'GET') {
        return jsonOk(redactor, await kernel.getConversationDetail(id, parseDetailPagination(ctx.url)))
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(ctx.request)
        return jsonOk(redactor, await kernel.updateConversation(id, parseConversationPatch(body)))
      }
      if (method === 'DELETE') {
        if (id === ROOT_CONVERSATION_ID) {
          throw new HelmError('root_conversation_protected', '常驻根会话 #1 不可删除', 403)
        }
        await kernel.deleteConversation(id)
        return jsonOk(redactor, { ok: true })
      }
      return methodNotAllowed(redactor, method)
    }
    if (third === 'input' && method === 'POST' && fourth === undefined) {
      const body = await readJsonBody(ctx.request)
      const { text, whenBusy, origin, meta, attachments, replaceFromEntryId } = parseInputBody(body)
      const wait = parseWaitFlag(ctx.url)
      const { submissionId } = await kernel.submitInput(id, text, {
        ...(origin !== undefined ? { origin } : {}),
        ...(whenBusy !== undefined ? { whenBusy } : {}),
        ...(meta !== undefined ? { meta } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
        ...(replaceFromEntryId !== undefined ? { replaceFromEntryId } : {}),
      })
      if (!wait) return jsonOk(redactor, { submissionId }, { status: 202 })
      return jsonOk(redactor, await kernel.waitForInput(id, submissionId))
    }
    if (third === 'withdraw' && method === 'POST' && fourth === undefined) {
      if (kernel.withdrawQueuedInput === undefined) {
        throw new HelmError('not_implemented', '当前 runtime 未提供排队输入撤回', 501)
      }
      const body = await readJsonBody(ctx.request)
      const parsed = parseConversationWithdrawBody(body)
      return jsonOk(redactor, await kernel.withdrawQueuedInput(id, parsed))
    }
    if (third === 'abort' && method === 'POST' && fourth === undefined) {
      await kernel.abortConversation(id)
      return jsonOk(redactor, { ok: true })
    }
    if (third === 'reset' && method === 'POST' && fourth === undefined) {
      const opts = await parseOptionalJsonObjectBody(ctx.request, parseConversationResetBody)
      return jsonOk(redactor, await kernel.resetConversation(id, opts))
    }
    if (third === 'compact' && method === 'POST' && fourth === undefined) {
      const opts = await parseOptionalJsonObjectBody(ctx.request, parseConversationCompactBody)
      return jsonOk(redactor, await kernel.compactConversation(id, opts), { status: 202 })
    }
    if (third === 'fork' && method === 'POST' && fourth === undefined) {
      const body = await readJsonBody(ctx.request)
      return jsonOk(redactor, await kernel.forkConversation(id, parseConversationForkBody(body)), { status: 201 })
    }
    if (third === 'artifacts' && method === 'GET' && fourth === undefined) {
      return jsonOk(redactor, await kernel.artifacts.list(id))
    }
    if (third === 'artifacts' && method === 'POST' && fourth === undefined) {
      return postConversationArtifact(ctx, kernel, id, redactor)
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }

  // ---- asks ---------------------------------------------------------------
  if (head === 'asks') {
    if (second === undefined && method === 'GET') {
      return jsonOk(redactor, await kernel.listAsks())
    }
    const askId = requireIdParam(second ?? '', 'askId')
    if (third === 'answer' && method === 'POST' && fourth === undefined) {
      const body = await readJsonBody(ctx.request)
      const { answers, expectedStateSeq } = parseAskAnswerBody(body)
      await kernel.answerAsk(askId, answers, expectedStateSeq)
      return jsonOk(redactor, { ok: true })
    }
    if (third === 'cancel' && method === 'POST' && fourth === undefined) {
      await kernel.cancelAsk(askId)
      return jsonOk(redactor, { ok: true })
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }

  // ---- profiles -------------------------------------------------------------
  if (head === 'profiles') {
    const enrichProfile = async (profile: Profile): Promise<Profile> => {
      const [system, memory] = await Promise.all([
        kernel.profiles.getSystem(profile.id),
        kernel.profiles.getMemory(profile.id),
      ])
      return { ...profile, system, memory }
    }
    if (second === undefined) {
      if (method === 'GET') return jsonOk(redactor, await kernel.profiles.list())
      if (method === 'POST') {
        const body = await readJsonBody(ctx.request)
        const profile = parseProfileBody(body, { requireId: true })
        const saved = await kernel.profiles.save(profile)
        await kernel.alignProfileConversations?.(saved.id)
        return jsonOk(redactor, await enrichProfile(saved), { status: 201 })
      }
      return methodNotAllowed(redactor, method)
    }
    const profileId = requireIdParam(second, 'profileId')
    if (third === undefined) {
      if (method === 'GET') {
        const found = await kernel.profiles.get(profileId)
        if (found === undefined) throw new HelmError('not_found', `profile 不存在: ${profileId}`, 404)
        return jsonOk(redactor, await enrichProfile(found))
      }
      if (method === 'PUT') {
        const body = await readJsonBody(ctx.request)
        const profile = parseProfileBody(body, { requireId: false })
        if (profile.id !== undefined && profile.id !== profileId) {
          throw new ValidationError('body.id（若提供）需与路径参数一致')
        }
        const saved = await kernel.profiles.save({ ...profile, id: profileId })
        await kernel.alignProfileConversations?.(saved.id)
        return jsonOk(redactor, await enrichProfile(saved))
      }
      if (method === 'DELETE') {
        // 仍被任何会话绑定的 profile 拒绝删除：否则下一轮 before_turn 找
        // 不到文件，会话将带病运行。assistant 默认服务同理受锁保护（403）。
        const inUse = (await kernel.listConversations()).some((c) => c.profileId === profileId)
        if (inUse) {
          throw new HelmError('profile_in_use', `profile ${profileId} 仍被会话绑定，先解绑再删除`, 409)
        }
        await kernel.profiles.delete(profileId)
        return jsonOk(redactor, { ok: true })
      }
      return methodNotAllowed(redactor, method)
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }

  // ---- providers（PUT 接受完整原始 array 或 { providers } 包裹；无 secret 字段）---
  if (head === 'providers' && second === undefined) {
    if (method === 'GET') return jsonOk(redactor, await kernel.providers.list())
    if (method === 'PUT') {
      // CLI 约定发送完整原始数组；Web 端历史形态 { providers: [...] } 同样
      // 接受。两种 body 都逐项严格校验，不因包裹形态放宽任何字段规则。
      const value = await readJsonValue(ctx.request)
      const providers = parseProvidersBodyValue(value)
      const saved = await kernel.providers.save(providers)
      await reloadModels(kernel)
      return jsonOk(redactor, saved)
    }
    return methodNotAllowed(redactor, method)
  }

  // ---- credentials（仅 id/configured；PUT/DELETE/:id 写删） -------------------
  if (head === 'credentials') {
    if (second === undefined && method === 'GET') {
      const ids = await kernel.credentials.list()
      return jsonOk(redactor, ids.map((id) => ({ id, configured: true })))
    }
    const credId = requireIdParam(second ?? '', 'credentialId')
    if (third === undefined && method === 'PUT') {
      const body = await readJsonBody(ctx.request)
      await kernel.credentials.set(credId, parseCredentialBody(body))
      await reloadModels(kernel)
      return jsonOk(redactor, { ok: true })
    }
    if (third === undefined && method === 'DELETE') {
      await kernel.credentials.delete(credId)
      await reloadModels(kernel)
      return jsonOk(redactor, { ok: true })
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }

  // ---- models / skills -------------------------------------------------------
  if (head === 'models' && second === 'default' && third === undefined && method === 'GET') {
    const catalog = await kernel.listModels()
    return jsonOk(redactor, { defaultModel: catalog.defaultModel ?? '', defaultThinkingLevel: catalog.defaultThinkingLevel ?? '' })
  }
  if (head === 'models' && second === 'default' && third === undefined && method === 'PUT') {
    if (kernel.setDefaultModel === undefined) {
      throw new HelmError('not_implemented', '当前 runtime 未提供默认模型设置', 501)
    }
    const raw = await readOptionalJsonBody(ctx.request)
    if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
      throw new HelmError('validation_error', '请求体需为 JSON 对象 { model?: string; thinkingLevel?: string }', 400)
    }
    const body = (raw ?? {}) as Record<string, unknown>
    rejectUnknownKeys(body, new Set(['model', 'thinkingLevel']))
    const hasModel = 'model' in body
    const hasLevel = 'thinkingLevel' in body
    if (!hasModel && !hasLevel) throw new HelmError('validation_error', '至少提供 model 或 thinkingLevel 字段', 400)
    const model = body['model']
    if (hasModel && typeof model !== 'string') throw new HelmError('validation_error', 'model 必须为字符串（provider/model 或空串清除）', 400)
    const level = body['thinkingLevel']
    if (hasLevel && typeof level !== 'string') throw new HelmError('validation_error', 'thinkingLevel 必须为字符串', 400)
    await kernel.setDefaultModel(hasModel ? model as string : undefined, hasLevel ? level as string : undefined)
    const catalog = await kernel.listModels()
    return jsonOk(redactor, { ok: true, defaultModel: catalog.defaultModel ?? '', defaultThinkingLevel: catalog.defaultThinkingLevel ?? '' })
  }
  if (head === 'models' && second === 'refresh' && third === undefined && method === 'POST') {
    // 空 body / {} 均合法（刷新全部）；provider 单选、providers 多选、force 可选。
    const raw = await readOptionalJsonBody(ctx.request)
    const options = parseModelsRefreshBody(raw)
    if (kernel.refreshModels === undefined) {
      throw new HelmError('not_implemented', '当前 runtime 未提供动态模型目录刷新', 501)
    }
    const result = await kernel.refreshModels(options)
    return jsonOk(redactor, result)
  }
  if (head === 'models' && second === 'providers' && third === undefined && method === 'GET') {
    return jsonOk(redactor, await kernel.listModelProviders())
  }
  if (head === 'models' && second === undefined && method === 'GET') {
    return jsonOk(redactor, await kernel.listModels())
  }
  if (head === 'skills') {
    if (second === undefined && method === 'GET') {
      return jsonOk(redactor, await kernel.skills.list())
    }
    const skillId = requireIdParam(second ?? '', 'skillId')
    if (third === undefined && method === 'GET') {
      const path = ctx.url.searchParams.get('path') ?? undefined
      if (path !== undefined && !isSafeRelativePath(path)) {
        throw new HelmError('path_traversal', `技能文件路径越界: ${skillId}/${path}`, 400)
      }
      const text = await kernel.skills.readFile(skillId, path)
      return jsonOk(redactor, { text })
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }

  // ---- artifacts -------------------------------------------------------------
  if (head === 'artifacts') {
    if (second !== undefined && third === 'content' && method === 'GET' && fourth === undefined) {
      const artifactId = requireIdParam(second, 'artifactId')
      const metadata = await kernel.artifacts.get(artifactId)
      assertArtifactMetadataShape(metadata)
      const buffer = await readArtifactBytes(kernel, metadata)
      const inline = ctx.url.searchParams.get('inline') === '1'
      const headers: Record<string, string> = {
        'content-type': metadata.mimeType,
        'content-length': String(buffer.byteLength),
      }
      const disposition = inline ? 'inline' : 'attachment'
      const fallbackName = metadata.name.replace(/[^\x20-\x7e]|["\\]/g, '_')
      const encodedName = encodeURIComponent(metadata.name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
      headers['content-disposition'] = `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`
      // 原始字节直传（二进制不转字符串，不做 JSON 脱敏缓冲）。
      return new Response(buffer as unknown as BodyInit, { headers })
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }

  // ---- search ---------------------------------------------------------------
  if (head === 'search' && second === undefined && method === 'GET') {
    const q = ctx.url.searchParams.get('q') ?? ''
    if (q.trim().length === 0) throw new ValidationError('q 不能为空')
    return jsonOk(redactor, await kernel.search(q))
  }

  // ---- plugins ---------------------------------------------------------------
  if (head === 'plugins') {
    if (second === undefined && method === 'GET') {
      return jsonOk(redactor, await kernel.plugins.list())
    }
    const pluginId = requireIdParam(second ?? '', 'pluginId')
    // 核心管理面固定在第三段：enable/disable/config；其余仅剩 routes/ 动态路由。
    if (third === 'enable' && method === 'POST' && fourth === undefined) {
      await kernel.plugins.enable(pluginId)
      return jsonOk(redactor, await kernel.plugins.list())
    }
    if (third === 'disable' && method === 'POST' && fourth === undefined) {
      await kernel.plugins.disable(pluginId)
      return jsonOk(redactor, await kernel.plugins.list())
    }
    if (third === 'config' && fourth === undefined) {
      if (method === 'GET') {
        const [raw, schema] = await Promise.all([
          Promise.resolve(kernel.plugins.getConfig(pluginId)),
          Promise.resolve(kernel.plugins.getConfigSchema(pluginId)),
        ])
        // secret 字段按 schema 脱敏出站：绝不让明文离开服务端。
        const values = redactConfigValues(raw, schema)
        return jsonOk(redactor, { values, schema })
      }
      if (method === 'PUT') {
        const body = await readJsonBody(ctx.request)
        await kernel.plugins.setConfig(pluginId, parsePluginConfigBody(body))
        return jsonOk(redactor, { ok: true })
      }
      return methodNotAllowed(redactor, method)
    }
    // 插件公共文档：GET /api/plugins/:pluginId/docs/:name（私有/停用/不存在 404）
    if (third === 'docs' && method === 'GET' && fifth === undefined) {
      if (fourth === undefined) throw new ValidationError('缺少 doc name 路径段')
      const name = parseDocNameParam(decodeSegment(fourth))
      return jsonOk(redactor, await kernel.plugins.getPublicDoc(pluginId, name))
    }
    // 插件客户端模块：GET /api/plugins/:pluginId/client.mjs?module=<相对路径>
    // （鉴权由 hub 统一前置；停用/未声明/编译失败返回结构化错误 JSON，绝不返回半产物）
    if (third === 'client.mjs' && method === 'GET' && fourth === undefined) {
      const moduleRef = ctx.url.searchParams.get('module')
      if (moduleRef === null || moduleRef.length === 0) {
        throw new ValidationError('缺少 module 查询参数（相对 clientRoot 的 .ts/.tsx 路径）')
      }
      if (moduleRef.length > 256 || moduleRef.includes('..') || moduleRef.startsWith('/') || moduleRef.includes('\\')) {
        throw new ValidationError('module 需为 clientRoot 内相对 .ts/.tsx 路径（禁止绝对路径/..越根）')
      }
      const compiled = await kernel.plugins.getClientModule(pluginId, moduleRef)
      return new Response(compiled.code, {
        status: 200,
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'x-helm-client-hash': compiled.contentHash,
          'cache-control': 'private, max-age=60',
        },
      })
    }
    // 插件自定义动态路由：强制命名空间 /api/plugins/:pluginId/routes/...，
    // 不允许覆盖核心路由（enable/disable/config 已在上面先匹配）。
    if (third === 'routes') {
      return dispatchPluginRoute(kernel, redactor, ctx.request, method, seg)
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }

  // ---- actions ---------------------------------------------------------------
  if (head === 'actions') {
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

  // ---- managed worktrees -----------------------------------------------------
  if (head === 'worktrees' && second === 'cleanup' && third === undefined && method === 'POST') {
    const input = parseWorktreeCleanupBody(await readJsonBody(ctx.request))
    if (kernel.cleanupWorktree === undefined) throw new HelmError('unsupported_runtime', '内核未提供受管工作树清理', 501)
    return jsonOk(redactor, await kernel.cleanupWorktree(input, ctx.request.signal))
  }

  // ---- workflows -------------------------------------------------------------
  if (head === 'workflows') {
    if (second === undefined && method === 'GET') {
      return jsonOk(redactor, await workflows.list())
    }
    if (second === 'run' && method === 'POST' && third === undefined) {
      const body = await readJsonBody(ctx.request, MAX_WORKFLOW_BODY_BYTES)
      const wait = parseWaitFlag(ctx.url)
      const runRequest = parseWorkflowRunBody(body)
      const started = await workflows.run(runRequest)
      const summary =
        typeof started === 'object' && started !== null && 'status' in started
          ? (started as WorkflowRunSummary)
          : undefined
      if (summary !== undefined) {
        // wait=1：真实异步等待终态（不轮询），失败/中止终态如实返回错误信封。
        if (wait) {
          await workflows.wait(summary.id)
          const terminal = await workflows.getRun(summary.id)
          if (terminal !== undefined && (terminal.status === 'failed' || terminal.status === 'aborted')) {
            throw new HelmError(
              `workflow_${terminal.status}`,
              terminal.error ?? `工作流运行 ${summary.id} 终态为 ${terminal.status}`,
              500,
              { runId: summary.id, status: terminal.status },
            )
          }
          return jsonOk(redactor, terminal ?? summary)
        }
        return jsonOk(redactor, summary, { status: 202 })
      }
      // 只拿到 runId 句柄：如实返回句柄，不伪造完整 Summary。
      return jsonOk(redactor, started, { status: 202 })
    }
    if (second === 'runs') {
      // GET /api/workflows/runs：全部 run 摘要（可按 conversationId 过滤）。
      if (method === 'GET' && third === undefined) {
        const filterRaw = ctx.url.searchParams.get('conversationId')
        let conversationId: number | undefined
        if (filterRaw !== null) {
          if (!/^\d+$/.test(filterRaw) || Number(filterRaw) < 1) {
            throw new ValidationError('conversationId 需为正整数')
          }
          conversationId = Number(filterRaw)
        }
        const runs = await workflows.listRuns()
        const filtered = conversationId === undefined ? runs : runs.filter((r) => r.conversationId === conversationId)
        return jsonOk(redactor, filtered)
      }
      const runId = requireIdParam(third ?? '', 'runId')
      if (method === 'GET' && fourth === undefined && fifth === undefined) {
        const run = await workflows.getRun(runId)
        if (run === undefined) throw new HelmError('not_found', `工作流运行不存在: ${runId}`, 404)
        return jsonOk(redactor, run)
      }
      if (fourth === 'abort' && method === 'POST' && fifth === undefined) {
        await workflows.abort(runId)
        return jsonOk(redactor, { ok: true })
      }
      return errorResponse(redactor, 404, 'not_found', '路由不存在')
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }

  return errorResponse(redactor, 404, 'not_found', '路由不存在')
}

// ---------------------------------------------------------------------------
// 插件动态路由：强制 /api/plugins/:pluginId/routes/<rest...> 命名空间，
// 不允许覆盖核心路由（核心路由全部先匹配，此处仅剩 routes/ 前缀）。
// ---------------------------------------------------------------------------

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
  const response = await found.route.handler(request)
  if (!(response instanceof Response)) {
    throw new HelmError('invalid_route_handler_output', '插件路由 handler 必须返回 Response', 500)
  }
  return response
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** providers/credentials 变更后热重载模型清单；未提供端口的 runtime 跳过。 */
/** POST /api/models/refresh body：空/{} 合法；provider 单选、providers 多选、force 可选。 */
function parseModelsRefreshBody(raw: unknown): { providers?: string[]; force?: boolean } {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('models refresh 请求体需为 JSON 对象（可为空）')
  }
  const body = raw as Record<string, unknown>
  rejectUnknownKeys(body, new Set(['provider', 'providers', 'force']))
  let providers: string[] | undefined
  const single = body['provider']
  if (single !== undefined) {
    if (typeof single !== 'string' || single === '') {
      throw new ValidationError('provider 需为非空字符串')
    }
    providers = [single]
  }
  const multi = body['providers']
  if (multi !== undefined) {
    if (!Array.isArray(multi) || multi.some((p) => typeof p !== 'string' || p === '')) {
      throw new ValidationError('providers 需为非空字符串数组')
    }
    providers = providers !== undefined ? [...providers, ...(multi as string[])] : [...(multi as string[])]
  }
  let force: boolean | undefined
  const rawForce = body['force']
  if (rawForce !== undefined) {
    if (typeof rawForce !== 'boolean') throw new ValidationError('force 需为 boolean')
    force = rawForce
  }
  return { ...(providers !== undefined ? { providers } : {}), ...(force !== undefined ? { force } : {}) }
}

/** 读取可选 JSON body：空 body 返回 undefined（合法未指定），非法 JSON 仍 400。 */
async function readOptionalJsonBody(request: Request): Promise<unknown> {
  const raw = await readBody(request, DEFAULT_MAX_BODY_BYTES)
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw))
  } catch {
    throw new HelmError('invalid_input', '请求体不是合法 JSON', 400)
  }
}

async function reloadModels(kernel: KernelRuntimeLike): Promise<void> {  await kernel.reloadModels?.()
}

/** 节点 ID 路径段：字母数字开头，可含 . _ -（与 issue 校验同一规则）。 */
function requireNodeSegment(raw: string): string {
  const decoded = decodeSegment(raw)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(decoded)) {
    throw new ValidationError('nodeId 需匹配 /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/（字母数字开头，可含 . _ -）')
  }
  return decoded
}

/** http(s) URL 校验：协议限定 + 可解析 + 含 hostname。 */
function requireHttpUrl(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw new ValidationError(`${field} 需为 http(s) URL 字符串`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ValidationError(`${field} 需为合法 http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${field} 需为 http(s) URL`)
  }
  if (parsed.hostname === '' || /^\s+$/.test(parsed.hostname)) {
    throw new ValidationError(`${field} 需含主机名`)
  }
  return raw
}

/** 严格 SemVer（与 runtime 同一规则）。 */
const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

/** 边界校验目标版本：trim 后允许单个 v/V 前缀，余下必须严格 SemVer。 */
function requireVersionField(raw: string): string {
  const trimmed = raw.trim()
  const bare = trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed
  if (!STRICT_SEMVER_RE.test(bare)) {
    throw new ValidationError('targetVersion 需为严格 SemVer（可带单个 v 前缀，如 1.2.3 / v1.2.3）')
  }
  return raw
}

/** GET /api/nodes/:id/upgrade/check 查询参数：仅 registryUrl。 */
function parseNodeUpgradeCheckQuery(url: URL): { registryUrl?: string } {
  const raw = url.searchParams.get('registryUrl')
  return raw === null ? {} : { registryUrl: requireHttpUrl(raw, 'registryUrl') }
}

/**
 * POST /api/nodes/:id/upgrade body：可选 targetVersion / registryUrl / force，
 * 严格拒未知字段（attemptId 属服务端内部，绝不接受用户控制）。
 */
function parseNodeUpgradeBody(body: Record<string, unknown>): { targetVersion?: string; registryUrl?: string; force?: boolean } {
  const out: { targetVersion?: string; registryUrl?: string; force?: boolean } = {}
  const target = body['targetVersion']
  // 显式 null 与缺省不同：进入下方字符串校验并 400（不当作缺省静默忽略）。
  if (target !== undefined) {
    if (typeof target !== 'string' || target.length > 64) {
      throw new ValidationError('targetVersion 需为字符串（长度 <= 64）')
    }
    if (target.trim() === '') throw new ValidationError('targetVersion 需为非空版本（留空表示升级到 latest）')
    out.targetVersion = requireVersionField(target)
  }
  const registryUrl = body['registryUrl']
  // 同上：显式 null 进原字符串校验并 400，而非当成缺省。
  if (registryUrl !== undefined) {
    out.registryUrl = requireHttpUrl(registryUrl, 'registryUrl')
  }
  const force = body['force']
  if (force !== undefined) {
    if (typeof force !== 'boolean') throw new ValidationError('force 需为 boolean')
    out.force = force
  }
  rejectUnknownKeys(body, new Set(['targetVersion', 'registryUrl', 'force']))
  return out
}

/**
 * POST /api/env/exec：
 * - stream=true：application/x-ndjson 流式；每行 {"type":"output","stream":...,"text":...}
 *   （text 经 StreamingRedactor 跨 chunk 脱敏），结束行 {"type":"exit",...}；
 * - 否则 JSON 一次性返回 EnvExecResponse（全文聚合后统一脱敏）。
 */
async function postEnvExec(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const body = await readJsonBody(ctx.request)
  const command = body['command']
  if (typeof command !== 'string' && !Array.isArray(command)) {
    throw new ValidationError('command 需为字符串或字符串数组')
  }
  if ((typeof command === 'string' && command.trim() === '') || (Array.isArray(command) && command.length === 0)) {
    throw new ValidationError('command 不得为空')
  }
  if (Array.isArray(command) && command.some((c) => typeof c !== 'string')) {
    throw new ValidationError('command 数组项需为字符串')
  }
  const nodeIdRaw = body['nodeId']
  if (nodeIdRaw !== undefined && (typeof nodeIdRaw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeIdRaw))) {
    throw new ValidationError('nodeId 需为非空字符串')
  }
  const cwdRaw = body['cwd']
  // cwd 绝对性按目标形状判定：POSIX / 与 Windows 盘符绝对/UNC 均合法；
  // 盘符相对（C:relative）与相对路径拒绝（与 CLI 字符串 cwd 同一规则）。
  if (cwdRaw !== undefined && (typeof cwdRaw !== 'string' || !isAbsoluteTargetPath(cwdRaw))) {
    throw new ValidationError(
      'cwd 需为绝对路径（POSIX / 开头或 Windows 盘符/UNC；拒绝盘符相对与相对路径）',
    )
  }
  const conversationIdRaw = body['conversationId']
  if (
    conversationIdRaw !== undefined &&
    (!Number.isInteger(conversationIdRaw) || (conversationIdRaw as number) <= 0)
  ) {
    throw new ValidationError('conversationId 需为正整数')
  }
  const envRaw = body['env']
  if (envRaw !== undefined) {
    if (typeof envRaw !== 'object' || envRaw === null || Array.isArray(envRaw)) {
      throw new ValidationError('env 需为字符串映射对象')
    }
    for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ValidationError('env 键需为合法环境变量名')
      if (typeof value !== 'string' || value.includes('\u0000')) throw new ValidationError(`env.${key} 需为不含 NUL 的字符串`)
    }
  }
  const timeoutRaw = body['timeoutMs']
  if (timeoutRaw !== undefined && (!Number.isInteger(timeoutRaw) || (timeoutRaw as number) <= 0 || (timeoutRaw as number) > 600_000)) {
    throw new ValidationError('timeoutMs 需为 1..600000 的整数')
  }
  const stream = body['stream']
  if (stream !== undefined && typeof stream !== 'boolean') {
    throw new ValidationError('stream 需为 boolean')
  }
  rejectUnknownKeys(
    body,
    new Set(['command', 'nodeId', 'cwd', 'conversationId', 'env', 'timeoutMs', 'stream']),
  )
  const request = {
    command: command as string | string[],
    ...(nodeIdRaw !== undefined ? { nodeId: nodeIdRaw as string } : {}),
    ...(cwdRaw !== undefined ? { cwd: cwdRaw as string } : {}),
    ...(conversationIdRaw !== undefined ? { conversationId: conversationIdRaw as number } : {}),
    ...(envRaw !== undefined ? { env: envRaw as Record<string, string> } : {}),
    ...(timeoutRaw !== undefined ? { timeoutMs: timeoutRaw as number } : {}),
    ...(stream !== undefined ? { stream: stream as boolean } : {}),
  }
  const redactText = (text: string): string =>
    kernel.stash !== undefined ? kernel.stash.redact(text) : text

  if (stream === true) {
    // 流式：StreamingRedactor 保尾部防跨 chunk 拆分泄漏；结束 flush。
    // 帧协议与 @helm/protocol EnvExecStreamFrame 对齐（最终集成统一类型引用）：
    // - 逐块 {type:'output',stream,text}（text 经跨 chunk 脱敏）；
    // - 成功终帧 {type:'exit',ok,exitCode,timedOut}（必在尾部 redaction flush 之后）；
    // - 中途异常 {type:'error',error:{code,message,details?}}（绝不伪造 exit）。
    const encoder = new TextEncoder()
    let buffered = ''
    const streamRedactor = kernel.stash?.createStreamingRedactor?.() ?? {
      push(text: string) { buffered += text; return '' },
      flush() { const safe = redactText(buffered); buffered = ''; return safe },
    }
    const streamAbort = new AbortController()
    const executionSignal = AbortSignal.any([ctx.request.signal, streamAbort.signal])
    // 命名 readableStream：避免遮蔽外层布尔变量 stream（请求体里的 stream 标志）。
    const readableStream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
        const write = (payload: EnvExecStreamFrame): void => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
          } catch {
            streamAbort.abort()
          }
        }
        try {
          const result = await kernel.execEnv(request, (chunk) => {
            const safe = streamRedactor.push(chunk.text)
            if (safe !== '') write({ type: 'output', stream: chunk.stream, text: safe })
          }, executionSignal)
          // 终帧必在尾部 flush 之后：拼接后的 NDJSON text 仍无 stash/token。
          const tail = streamRedactor.flush()
          if (tail !== '') {
            write({ type: 'output', stream: 'stdout' as const, text: tail })
          }
          write({
            type: 'exit',
            ok: result.ok,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          })
        } catch (error) {
          // 中途异常：error 帧如实携带错误码与消息（经脱敏），不伪造 exit。
          if (error instanceof HelmError) {
            write({
              type: 'error',
              error: {
                code: error.code,
                message: redactText(error.message),
                ...(error.details !== undefined ? { details: redactJsonValue(error.details, redactText) } : {}),
              },
            })
          } else {
            const message = error instanceof Error ? error.message : String(error)
            write({ type: 'error', error: { code: 'internal_error', message: redactText(message) } })
          }
        } finally {
          try {
            controller.close()
          } catch {
            /* 已关 */
          }
        }
        })()
      },
      cancel() { streamAbort.abort() },
    })
    return new Response(readableStream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache',
      },
    })
  }
  return jsonOk(redactor, await kernel.execEnv(request, undefined, ctx.request.signal))
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  if (header === null) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? undefined
}

function requiredStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 需为非空字符串`)
  }
  return value
}

function parseConversationFilter(url: URL): { profileId?: string; tag?: string; status?: ConversationStatus } {
  const profileId = url.searchParams.get('profileId') ?? undefined
  const tag = url.searchParams.get('tag') ?? undefined
  const status = url.searchParams.get('status') ?? undefined
  if (status !== undefined && !['working', 'blocked', 'done', 'idle', 'error'].includes(status)) {
    throw new ValidationError('status 需为 working|blocked|done|idle|error')
  }
  return {
    ...(profileId !== undefined ? { profileId } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(status !== undefined ? { status: status as ConversationStatus } : {}),
  }
}

/** ?wait=1 查询参数：仅接受字面 '1'（true 同义）；其他值 400。 */
function parseWaitFlag(url: URL): boolean {
  const raw = url.searchParams.get('wait')
  if (raw === null) return false
  if (raw === '1' || raw === 'true') return true
  throw new ValidationError('wait 需为 1（如 ?wait=1）')
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false
  if (path.startsWith('/') || path.includes('\\')) return false
  const parts = path.split('/')
  return parts.every((p) => p.length > 0 && p !== '.' && p !== '..')
}

function methodNotAllowed(redactor: JsonRedactor | undefined, method: string): Response {
  return errorResponse(redactor, 405, 'method_not_allowed', `方法不允许: ${method}`)
}

/** 可选 JSON 对象 body：空 body 返回 {}；非空则须为 JSON 对象并走 parse。 */
async function parseOptionalJsonObjectBody<T>(
  request: Request,
  parse: (body: Record<string, unknown>) => T,
): Promise<T> {
  const raw = await readBinaryBodyWithLimit(request, 1024 * 1024)
  if (raw.length === 0) return {} as T
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new ValidationError('请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('请求体需为 JSON 对象')
  }
  return parse(parsed as Record<string, unknown>)
}

/** 严格 base64（标准/URL-safe 均拒绝填充镕shape；空串允许 = 0 字节）。 */
function decodeBase64Strict(value: string): Uint8Array {
  if (value === '') return new Uint8Array(0)
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new ValidationError('contentBase64 不是合法 base64')
  }
  const buffer = Buffer.from(normalized, 'base64')
  // 回读长度一致才可信（Buffer 宽容忽略尾部残缺字符，不能用）。
  const recheck = buffer.toString('base64').replaceAll('=', '')
  if (recheck !== normalized.replaceAll('=', '')) {
    throw new ValidationError('contentBase64 不是合法 base64')
  }
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
}

/**
 * POST /api/conversations/:id/artifacts：跨平台产物上传。
 * - application/json：{ name, contentBase64, mimeType? }（Web 前端/base64 场景）；
 * - 其他（application/octet-stream 等二进制流）：文件名经
 *   x-artifact-filename 头（含 % 时严格解码）或 ?name= 查询参数；
 * 体积上限统一 MAX_ARTIFACT_BYTES（15 MiB）；成功 201 返回产物元数据。
 */
async function postConversationArtifact(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  id: number,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  // 会话存在性校验（不存在自动 404，不留孤儿产物）。
  await kernel.getConversationDetail(id, { limit: 1 })
  const contentType = (ctx.request.headers.get('content-type') ?? '').toLowerCase()
  let name: string
  let bytes: Uint8Array
  let mimeType: string | undefined
  if (contentType.includes('application/json')) {
    // base64 膨胀系数 ~1.37 + 16KiB 余量；超限映射为 413 artifact_too_large。
    const jsonMaxBytes = Math.ceil(MAX_ARTIFACT_BYTES * 1.37) + 16 * 1024
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(ctx.request, jsonMaxBytes)
    } catch (error) {
      if (error instanceof HelmError && error.code === 'body_too_large') {
        throw new HelmError('artifact_too_large', `请求体超过 ${jsonMaxBytes} 字节上限`, 413, {
          maxBytes: jsonMaxBytes,
        })
      }
      throw error
    }
    const rawName = body.name
    if (typeof rawName !== 'string' || rawName.length === 0) {
      throw new ValidationError('name 需为非空字符串')
    }
    name = rawName
    const rawContent = body.contentBase64
    if (typeof rawContent !== 'string') {
      throw new ValidationError('contentBase64 需为字符串')
    }
    bytes = decodeBase64Strict(rawContent)
    const rawMime = body.mimeType
    if (rawMime !== undefined && typeof rawMime !== 'string') {
      throw new ValidationError('mimeType 需为字符串')
    }
    mimeType = rawMime
    const unknown = Object.keys(body).filter((k) => !['name', 'contentBase64', 'mimeType'].includes(k))
    if (unknown.length > 0) throw new ValidationError(`不支持的字段: ${unknown.join(', ')}`)
  } else {
    const headerName = ctx.request.headers.get('x-artifact-filename')
    const rawName =
      headerName !== null
        ? headerName.includes('%')
          ? decodeSegment(headerName)
          : headerName
        : ctx.url.searchParams.get('name')
    if (rawName === null || rawName.trim() === '') {
      throw new ValidationError('缺少文件名（请提供 x-artifact-filename 请求头或 ?name= 查询参数）')
    }
    name = rawName
    const headerMime = ctx.request.headers.get('x-artifact-mime-type')
    mimeType =
      headerMime !== null && headerMime.trim() !== ''
        ? headerMime
        : (() => {
            const q = ctx.url.searchParams.get('mimeType')
            return q !== null && q.trim() !== '' ? q : undefined
          })()
    bytes = await readBinaryBodyWithLimit(ctx.request, MAX_ARTIFACT_BYTES)
  }
  const metadata = await kernel.artifacts.writeUploaded(id, {
    name,
    bytes,
    ...(mimeType !== undefined ? { mimeType } : {}),
  })
  return jsonOk(redactor, metadata, { status: 201 })
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

/** providers PUT body：完整数组（CLI 约定）或 { providers } 包裹（Web 形态）。 */
function parseProvidersBodyValue(value: unknown): ReturnType<typeof parseProvidersBody> {
  if (Array.isArray(value)) return parseProvidersBody({ providers: value })
  if (value !== null && typeof value === 'object') return parseProvidersBody(value as Record<string, unknown>)
  throw new ValidationError('body 需为 ProviderConfig 完整数组或 { providers: [...] }')
}

/**
 * 产物元数据形状门禁：path 必须形如 artifacts/<positiveConvId>/<file>，
 * 且 conversationId 为正整数。仓库（内存 Map/sqlite）不是可信边界，
 * 手改 DB 的伪造 meta 不得让 HTTP 层读任意文件。
 */
function assertArtifactMetadataShape(metadata: ArtifactMetadata): void {
  if (
    !Number.isInteger(metadata.conversationId) ||
    metadata.conversationId <= 0 ||
    typeof metadata.path !== 'string'
  ) {
    throw new HelmError('artifact_metadata_illegal', `产物元数据非法: ${metadata.id}`, 500)
  }
  const parts = metadata.path.split('/')
  if (
    parts.length !== 3 ||
    parts[0] !== 'artifacts' ||
    !/^[1-9]\d*$/.test(parts[1] ?? '') ||
    parts[2] === undefined || parts[2].length === 0 ||
    parts[2] === '.' || parts[2] === '..'
  ) {
    throw new HelmError('artifact_metadata_illegal', `产物登记路径非法: ${metadata.path}`, 500)
  }
}

/**
 * 按登记元数据读取产物原始字节（realpath 防符号链接越界）。
 * - metadata.path 经 assertArtifactMetadataShape 已限定为
 *   artifacts/<convId>/<file>；
 * - 三层 realpath（artifacts 根 / 会话目录 / 目标文件）后必须满足：
 *   会话目录仍在真实 artifacts 根内（防 artifacts/<convId> 本身是逃逸
 *   软链），目标文件仍在会话目录内（防文件名段是逃逸软链）；
 * - ENOENT 如实 404；其他读失败（EACCES 等）原样上抛交顶层定性，
 *   绝不统一伪称 missing。
 */
async function readArtifactBytes(kernel: KernelRuntimeLike, metadata: ArtifactMetadata): Promise<Uint8Array> {
  const artifactsRootReal = await nodeFsRealpath(joinPath(kernel.dataDir, 'artifacts'))
  const convRootReal = await nodeFsRealpath(joinPath(artifactsRootReal, String(metadata.conversationId)))
  // 会话目录本身不得是逃出 artifacts 根的符号链接。
  if (!convRootReal.startsWith(artifactsRootReal + PATH_SEP)) {
    throw new HelmError('artifact_path_illegal', '产物会话目录越出 artifacts 根，拒绝读取', 500)
  }
  const target = joinPath(convRootReal, metadata.path.split('/')[2]!)
  const targetReal = await nodeFsRealpath(target)
  if (targetReal !== convRootReal && !targetReal.startsWith(convRootReal + PATH_SEP)) {
    throw new HelmError('artifact_path_illegal', '产物登记路径越界', 500)
  }
  try {
    const buffer = await nodeFsReadFile(targetReal)
    return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HelmError('artifact_file_missing', `产物文件缺失: ${metadata.id}`, 404)
    }
    throw error
  }
}
