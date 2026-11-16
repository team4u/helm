/**
 * model directory domain routing:/api/models(default/filter/refresh/providers/list),
 * /api/providers(PUT complete array or { providers } package wrap),/api/credentials
 * (only id/configured key, absolute without plaintext).providers/credentials change after hot reload
 * model manifest (only persist do not reload equals hot config invalid).
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

// at least provide model or thinkingLevel(anyOf required); empty string model = clear.
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

// note:provider/providers non-empty is === '' semantics (whitespace string history let through),
// do not add \S pattern, avoid tight behavior.
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
      throw new HelmError('not_implemented', 'when before runtime not provide by default model settings', 501)
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
      throw new HelmError('not_implemented', 'when before runtime not provide model disable collection settings', 501)
    }
    // empty body / {} all must validate:{ provider?: string; disabledModels: string[] }.
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
    // empty body / {} all legal (refresh all);provider single choose,providers many choose,force optional.
    const raw = await readOptionalJsonBody(ctx.request)
    const options = parseModelsRefreshBody(raw)
    if (kernel.refreshModels === undefined) {
      throw new HelmError('not_implemented', 'when before runtime not provide motion state model directory refresh', 501)
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
  return errorResponse(redactor, 404, 'not_found', 'routing missing')
}

/** POST /api/models/refresh body shape already by schema guarantee; this where only do across field merge
 * (provider single choose + providers many choose concatenate is the same targets list). */
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
    return errorResponse(redactor, 404, 'not_found', 'routing missing')
  }
  if (method === 'GET') return jsonOk(redactor, await kernel.providers.list())
  if (method === 'PUT') {
    // CLI convention send complete original array;Web end history form { providers: [...] } same
    // accept. two kinds of body all via the same schema one by one items strictly validate, do not because package wrap form put wide any field rule.
    const value = await readJsonValue(ctx.request)
    const providers = parseProvidersBodyValue(value)
    const saved = await kernel.providers.save(providers)
    await reloadModels(kernel)
    return jsonOk(redactor, saved)
  }
  return methodNotAllowed(redactor, method)
}

/** providers PUT body: complete array (CLI convention) or { providers } package wrap (Web form). */
function parseProvidersBodyValue(value: unknown): ProviderConfig[] {
  if (Array.isArray(value)) return parseProvidersBody({ providers: value })
  if (value !== null && typeof value === 'object') return parseProvidersBody(value as Record<string, unknown>)
  throw new ValidationError('body must be ProviderConfig complete array or { providers: [...] }')
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
  return errorResponse(redactor, 404, 'not_found', 'routing missing')
}

// ---------------------------------------------------------------------------
// auxiliary
// ---------------------------------------------------------------------------

/** providers/credentials change after hot reload model manifest; not provide port runtime skip. */
async function reloadModels(kernel: KernelRuntimeLike): Promise<void> {
  await kernel.reloadModels?.()
}
