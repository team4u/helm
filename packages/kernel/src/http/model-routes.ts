/**
 * 模型目录领域路由：/api/models（default/filter/refresh/providers/list）、
 * /api/providers（PUT 完整数组或 { providers } 包裹）、/api/credentials
 * （仅 id/configured 键，绝无明文）。providers/credentials 变更后热重载
 * 模型清单（仅持久化不重载等于热配置无效）。
 */
import type { JsonSchema, ProviderConfig } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { errorResponse, jsonOk, readJsonBody, readJsonValue, type JsonRedactor } from './http-utils.js'
import type { KernelRuntimeLike } from './contracts.js'
import { assertBodySchema, parseCredentialBody, parseProvidersBody, requireIdParam, ValidationError } from './validate.js'
import { methodNotAllowed, readOptionalJsonBody, type RouteContext } from './route-context.js'

// ---------------------------------------------------------------------------
// /api/models
// ---------------------------------------------------------------------------

// 至少提供 model 或 thinkingLevel（anyOf required）；空串 model = 清除。
const MODELS_DEFAULT_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    model: { type: 'string' },
    thinkingLevel: { type: 'string' },
  },
  additionalProperties: false,
  anyOf: [{ required: ['model'] }, { required: ['thinkingLevel'] }],
}

const MODELS_FILTER_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    provider: { type: 'string' },
    disabledModels: { type: 'array', items: { type: 'string' } },
  },
  required: ['disabledModels'],
  additionalProperties: false,
}

// 注意：provider/providers 的「非空」是 === '' 语义（空白串历史放行），
// 不加 \S pattern，避免收紧行为。
const MODELS_REFRESH_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    provider: { type: 'string', minLength: 1 },
    providers: { type: 'array', items: { type: 'string', minLength: 1 } },
    force: { type: 'boolean' },
  },
  additionalProperties: false,
}

export async function handleModelsDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  if (second === 'default' && third === undefined && method === 'GET') {
    const catalog = await kernel.listModels()
    return jsonOk(redactor, { defaultModel: catalog.defaultModel ?? '', defaultThinkingLevel: catalog.defaultThinkingLevel ?? '' })
  }
  if (second === 'default' && third === undefined && method === 'PUT') {
    if (kernel.setDefaultModel === undefined) {
      throw new HelmError('not_implemented', '当前 runtime 未提供默认模型设置', 501)
    }
    const raw = await readOptionalJsonBody(ctx.request)
    assertBodySchema(MODELS_DEFAULT_BODY_SCHEMA, raw ?? {}, 'models default body')
    const body = (raw ?? {}) as Record<string, unknown>
    await kernel.setDefaultModel(
      'model' in body ? (body.model as string) : undefined,
      'thinkingLevel' in body ? (body.thinkingLevel as string) : undefined,
    )
    const catalog = await kernel.listModels()
    return jsonOk(redactor, { ok: true, defaultModel: catalog.defaultModel ?? '', defaultThinkingLevel: catalog.defaultThinkingLevel ?? '' })
  }
  if (second === 'filter' && third === undefined && method === 'PUT') {
    if (kernel.setDisabledModels === undefined) {
      throw new HelmError('not_implemented', '当前 runtime 未提供模型禁用集设置', 501)
    }
    // 空 body / {} 均需校验：{ provider?: string; disabledModels: string[] }。
    const raw = await readOptionalJsonBody(ctx.request)
    assertBodySchema(MODELS_FILTER_BODY_SCHEMA, raw ?? {}, 'models filter body')
    const body = (raw ?? {}) as Record<string, unknown>
    const catalog = await kernel.setDisabledModels(
      body.provider as string | undefined,
      body.disabledModels as string[],
    )
    return jsonOk(redactor, { ok: true, catalog })
  }
  if (second === 'refresh' && third === undefined && method === 'POST') {
    // 空 body / {} 均合法（刷新全部）；provider 单选、providers 多选、force 可选。
    const raw = await readOptionalJsonBody(ctx.request)
    const options = parseModelsRefreshBody(raw)
    if (kernel.refreshModels === undefined) {
      throw new HelmError('not_implemented', '当前 runtime 未提供动态模型目录刷新', 501)
    }
    const result = await kernel.refreshModels(options)
    return jsonOk(redactor, result)
  }
  if (second === 'providers' && third === undefined && method === 'GET') {
    return jsonOk(redactor, await kernel.listModelProviders())
  }
  if (second === undefined && method === 'GET') {
    return jsonOk(redactor, await kernel.listModels())
  }
  return errorResponse(redactor, 404, 'not_found', '路由不存在')
}

/** POST /api/models/refresh body 形状已由 schema 保证；此处只做跨字段合并
 * （provider 单选 + providers 多选拼接为同一 targets 列表）。 */
function parseModelsRefreshBody(raw: unknown): { providers?: string[]; force?: boolean } {
  assertBodySchema(MODELS_REFRESH_BODY_SCHEMA, raw ?? {}, 'models refresh body')
  const body = (raw ?? {}) as Record<string, unknown>
  let providers: string[] | undefined
  if (body.provider !== undefined) providers = [body.provider as string]
  if (body.providers !== undefined) {
    providers = providers !== undefined
      ? [...providers, ...(body.providers as string[])]
      : [...(body.providers as string[])]
  }
  return { ...(providers !== undefined ? { providers } : {}), ...(body.force !== undefined ? { force: body.force as boolean } : {}) }
}

// ---------------------------------------------------------------------------
// /api/providers
// ---------------------------------------------------------------------------

export async function handleProvidersDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  if (segments[1] !== undefined) {
    return errorResponse(redactor, 404, 'not_found', '路由不存在')
  }
  if (method === 'GET') return jsonOk(redactor, await kernel.providers.list())
  if (method === 'PUT') {
    // CLI 约定发送完整原始数组；Web 端历史形态 { providers: [...] } 同样
    // 接受。两种 body 都经同一 schema 逐项严格校验，不因包裹形态放宽任何字段规则。
    const value = await readJsonValue(ctx.request)
    const providers = parseProvidersBodyValue(value)
    const saved = await kernel.providers.save(providers)
    await reloadModels(kernel)
    return jsonOk(redactor, saved)
  }
  return methodNotAllowed(redactor, method)
}

/** providers PUT body：完整数组（CLI 约定）或 { providers } 包裹（Web 形态）。 */
function parseProvidersBodyValue(value: unknown): ProviderConfig[] {
  if (Array.isArray(value)) return parseProvidersBody({ providers: value })
  if (value !== null && typeof value === 'object') return parseProvidersBody(value as Record<string, unknown>)
  throw new ValidationError('body 需为 ProviderConfig 完整数组或 { providers: [...] }')
}

// ---------------------------------------------------------------------------
// /api/credentials
// ---------------------------------------------------------------------------

export async function handleCredentialsDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
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

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** providers/credentials 变更后热重载模型清单；未提供端口的 runtime 跳过。 */
async function reloadModels(kernel: KernelRuntimeLike): Promise<void> {
  await kernel.reloadModels?.()
}
