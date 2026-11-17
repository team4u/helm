/**
 * Model catalog domain routes: /api/models (default/filter/refresh/providers/list),
 * /api/providers (PUT full array or `{ providers }` wrapper), /api/credentials
 * (only id/configured key, never plaintext). Hot-reloads the model catalog after
 * providers/credentials changes (persisting without reloading leaves hot config stale).
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

// At least one of model, thinkingLevel, compactionModel, or compactionThinkingLevel is required (anyOf); empty string clears override.
const MODELS_DEFAULT_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    model: { type: 'string' },
    thinkingLevel: { type: 'string' },
    compactionModel: { type: 'string' },
    compactionThinkingLevel: { type: 'string' },
  },
  additionalProperties: false,
  anyOf: [
    { required: ['model'] },
    { required: ['thinkingLevel'] },
    { required: ['compactionModel'] },
    { required: ['compactionThinkingLevel'] },
  ],
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

// Note: provider/providers non-emptiness uses `=== ''` semantics (historically allows whitespace strings);
// do not add a `\S` pattern to avoid tightening behavior.
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
    return jsonOk(redactor, {
      defaultModel: catalog.defaultModel ?? '',
      defaultThinkingLevel: catalog.defaultThinkingLevel ?? '',
      defaultCompactionModel: catalog.defaultCompactionModel ?? '',
      defaultCompactionThinkingLevel: catalog.defaultCompactionThinkingLevel ?? '',
    })
  }
  if (second === 'default' && third === undefined && method === 'PUT') {
    if (kernel.setDefaultModel === undefined) {
      throw new HelmError('not_implemented', 'current runtime does not support setting the default model', 501)
    }
    const raw = await readOptionalJsonBody(ctx.request)
    assertBodySchema(MODELS_DEFAULT_BODY_SCHEMA, raw ?? {}, 'models default body')
    const body = (raw ?? {}) as Record<string, unknown>
    const modelArg = 'model' in body ? (body.model as string) : undefined
    const levelArg = 'thinkingLevel' in body ? (body.thinkingLevel as string) : undefined
    const compactionArg = 'compactionModel' in body ? (body.compactionModel as string) : undefined
    if ('compactionThinkingLevel' in body) {
      await kernel.setDefaultModel(modelArg, levelArg, compactionArg, body.compactionThinkingLevel as string)
    } else if ('compactionModel' in body) {
      await kernel.setDefaultModel(modelArg, levelArg, compactionArg)
    } else {
      await kernel.setDefaultModel(modelArg, levelArg)
    }
    const catalog = await kernel.listModels()
    return jsonOk(redactor, {
      ok: true,
      defaultModel: catalog.defaultModel ?? '',
      defaultThinkingLevel: catalog.defaultThinkingLevel ?? '',
      defaultCompactionModel: catalog.defaultCompactionModel ?? '',
      defaultCompactionThinkingLevel: catalog.defaultCompactionThinkingLevel ?? '',
    })
  }
  if (second === 'filter' && third === undefined && method === 'PUT') {
    if (kernel.setDisabledModels === undefined) {
      throw new HelmError('not_implemented', 'current runtime does not support configuring disabled models', 501)
    }
    // Both empty body and {} validate against `{ provider?: string; disabledModels: string[] }`.
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
    // Empty body and {} are valid (refresh all); provider (single), providers (list), and force are optional.
    const raw = await readOptionalJsonBody(ctx.request)
    const options = parseModelsRefreshBody(raw)
    if (kernel.refreshModels === undefined) {
      throw new HelmError('not_implemented', 'current runtime does not support refreshing dynamic model catalogs', 501)
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
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

/** Body shape for POST /api/models/refresh is enforced by schema; merge single `provider` and list `providers` into one target list here. */
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
    return errorResponse(redactor, 404, 'not_found', 'route not found')
  }
  if (method === 'GET') return jsonOk(redactor, await kernel.providers.list())
  if (method === 'PUT') {
    // CLI sends a raw full array; Web historically sends `{ providers: [...] }`.
    // Both forms go through the same strict per-item schema validation without relaxing field rules.
    const value = await readJsonValue(ctx.request)
    const providers = parseProvidersBodyValue(value)
    const saved = await kernel.providers.save(providers)
    await reloadModels(kernel)
    return jsonOk(redactor, saved)
  }
  return methodNotAllowed(redactor, method)
}

/** providers PUT body: full array (CLI convention) or `{ providers }` wrapper (Web form). */
function parseProvidersBodyValue(value: unknown): ProviderConfig[] {
  if (Array.isArray(value)) return parseProvidersBody({ providers: value })
  if (value !== null && typeof value === 'object') return parseProvidersBody(value as Record<string, unknown>)
  throw new ValidationError('body must be a ProviderConfig array or { providers: [...] }')
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
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hot-reload model catalog after providers/credentials change; skipped if runtime omits the port. */
async function reloadModels(kernel: KernelRuntimeLike): Promise<void> {
  await kernel.reloadModels?.()
}
