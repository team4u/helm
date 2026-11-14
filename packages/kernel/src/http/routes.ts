/**
 * 核心 API 路由分发（薄层）：剥离 /api 前缀、严格解码路径段，按首段
 * 静态分派到领域路由模块（auth / conversations / asks / search /
 * profiles / models / providers / credentials / skills / artifacts /
 * plugins / actions / nodes / env）。领域 handler 内部才是具体端点。
 *
 * 路由规则：方法 + 精确路径段匹配（段数必须完全一致，多余段一律 404，
 * 绝不让 /auth/status/foo 之类落入操作分支）；段值经严格百分号解码
 * （非法编码 400，PathDecodeError 由 hub.ts 兜底映射）。鉴权在 hub.ts
 * 统一前置，本模块只处理已认证请求（auth 三端点除外）。
 *
 * 出站 JSON 一律经 redactor 脱敏（kernel.stash 存在时）；插件动作结果
 * 原样返回（null 就是 null，undefined 是 output 边界违约，显式 500）。
 */
import { HelmError } from '@helm/protocol'
import type { KernelRuntimeLike } from './contracts.js'
import { errorResponse, type JsonRedactor } from './http-utils.js'
import { decodeSegment } from './route-match.js'
import type { RouteContext } from './route-context.js'
import {
  AuthAlreadyConfiguredError,
  InvalidCredentialsError,
  WeakPasswordError,
  FileNotFoundError,
} from '../services/index.js'

import { handleAuthDomain } from './auth-routes.js'
import {
  handleAsksDomain,
  handleConversationsDomain,
  handleSearchDomain,
} from './conversation-routes.js'
import { handleProfilesDomain } from './profile-routes.js'
import {
  handleCredentialsDomain,
  handleModelsDomain,
  handleProvidersDomain,
} from './model-routes.js'
import { handleNodeDomain, handleEnvExecDomain } from './node-routes.js'
import { handlePluginsDomain, handleActionsDomain } from './plugin-routes.js'
import { handleArtifactsDomain, handleSkillsDomain } from './asset-routes.js'

export async function handleApi(
  request: Request,
  kernel: KernelRuntimeLike,
  redactor?: JsonRedactor,
): Promise<Response> {
  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  // 剥离 api 前缀
  if (segments[0] === 'api') segments.shift()
  // 统一严格解码每个路径段（hub.ts 已对整路径做过一次；此处对已剥离
  // api 前缀的段再解一次是幂等的——已解码段不含 '%' 时直接原样返回）。
  const ctx: RouteContext = {
    request,
    method: request.method,
    segments: segments.map((s) => decodeSegment(s)),
    url,
  }

  try {
    return await dispatch(ctx, kernel, redactor)
  } catch (error) {
    const mapped = mapServiceError(redactor, error)
    if (mapped !== undefined) return mapped
    throw error // 顶层 500 处理在 hub.ts
  }
}

/** 首段 → 领域 handler 的静态分派表（无通配、无优先级规则）。 */
const DOMAIN_HANDLERS: Readonly<
  Record<string, (ctx: RouteContext, kernel: KernelRuntimeLike, redactor: JsonRedactor | undefined) => Promise<Response>>
> = {
  auth: handleAuthDomain,
  conversations: handleConversationsDomain,
  asks: handleAsksDomain,
  search: handleSearchDomain,
  profiles: handleProfilesDomain,
  models: handleModelsDomain,
  providers: handleProvidersDomain,
  credentials: handleCredentialsDomain,
  skills: handleSkillsDomain,
  artifacts: handleArtifactsDomain,
  plugins: handlePluginsDomain,
  actions: handleActionsDomain,
  nodes: handleNodeDomain,
  env: handleEnvExecDomain,
}

async function dispatch(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const head = ctx.segments[0]
  if (head === undefined) return errorResponse(redactor, 404, 'not_found', '路由不存在')

  // ---- events：全局 SSE（唯一不归领域的顶层端点）--------------------------
  if (head === 'events') {
    if (ctx.method === 'GET' && ctx.segments[1] === undefined) {
      return kernel.events.response(ctx.request)
    }
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }

  const handler = DOMAIN_HANDLERS[head]
  if (handler === undefined) return errorResponse(redactor, 404, 'not_found', '路由不存在')
  return handler(ctx, kernel, redactor)
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
  if (error instanceof HelmError && error.code === 'auth_not_setup') {
    return errorResponse(redactor, 409, 'not_setup', error.message)
  }
  return undefined
}
