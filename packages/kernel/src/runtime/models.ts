/**
 * 模型接入：pi-ai 全量内置 provider + providers.json 兼容网关。
 *
 * 事实依据（@earendil-works/pi-ai 1.5.0 实测源码）：
 * - `createProvider({ auth })` 的 auth 即 `ProviderAuth`（`apiKey?: ApiKeyAuth` +
 *   `oauth?: OAuthAuth`），ApiKeyAuth.resolve 输入 `{ ctx, credential?, signal }`，
 *   返回 `AuthResult | undefined`（undefined = 该渠道未配置，是合法状态）。
 * - `Model` 必填 `provider`（须等于注册的 provider id，请求分发按它查 provider）
 *   与 `baseUrl`（openai-completions 直接对它做字符串探测）；`cost` 四费率必填。
 * - 内置 provider 自行处理凭据、环境变量与供应商特有配置；helm 只将已存 key
 *   注入原生 ApiKeyAuth 的 credential，不替换原生认证判断或 oauth 策略。
 *
 * providers.json 的 `models: string[]` 只有静态模型 ID，不含能力元数据；
 * 未探测到的能力（contextWindow 等）以显式标记的保守缺省给出，绝不冒充真实探测值。
 * 未配置模型时显式抛 model_not_configured，绝不 faux fallback 假装回答。
 */

import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  createModels,
  createProvider,
  type ApiKeyAuth,
  type AuthResult,
  type Model,
  type ModelInputModality,
  type Models,
  type Provider,
} from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ModelProviderSummary, ProviderConfig } from '@helm/protocol'
import { HelmError } from '@helm/protocol'

export interface ModelGatewayOptions {
  /** providers.json 条目。 */
  providers: ProviderConfig[]
  /** providerId -> API Key（宿主 credentials 解析结果）。 */
  apiKeys: () => Record<string, string>
}

export interface ModelCatalogEntry {
  provider: string
  modelId: string
  available: boolean
}

/**
 * 兼容网关静态模型的保守缺省。providers.json 只给模型 ID（string[]），
 * pi-ai 的 Model 契约要求 contextWindow / maxTokens / cost 为必填数字——
 * 这些是「让请求能发出去」的最小缺省，不是探测到的真实能力：
 * 真实能力只能来自上游目录（如 /v1/models 探测），helm 目前不做探测。
 */
const COMPAT_MODEL_DEFAULTS = {
  contextWindow: 128_000,
  maxTokens: 8_192,
  /** 费率未知记 0：pi-ai 用它计算 usage.cost，未知费率按 0 计价并如实标注。 */
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const

/** 兼容网关的静态模型（真实 Model 类型，无任何 as 断言）。 */
function compatModel(
  id: string,
  config: ProviderConfig,
): Model<'openai-completions'> | Model<'anthropic-messages'> {
  const shared = {
    id,
    name: id,
    provider: config.id,
    baseUrl: config.baseUrl,
    input: ['text'] as ModelInputModality[],
    ...COMPAT_MODEL_DEFAULTS,
  }
  return config.protocol === 'anthropic'
    ? { ...shared, api: 'anthropic-messages', reasoning: false }
    : { ...shared, api: 'openai-completions', reasoning: false }
}

/** 兼容网关的 ApiKeyAuth：credential key（宿主解析注入）优先，未配置返回 undefined。 */
function compatApiKeyAuth(providerId: string, apiKey: string | undefined): ApiKeyAuth {
  return {
    name: `${providerId} API key`,
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted()
      const effective = credential?.key ?? apiKey
      if (!effective) return undefined
      const result: AuthResult = {
        auth: { apiKey: effective },
        source: credential?.key ? 'stored credential' : 'helm providers.json credentials',
      }
      return result
    },
  }
}

function buildCompatProvider(config: ProviderConfig, apiKey: string | undefined): Provider {
  return createProvider({
    id: config.id,
    name: config.label ?? config.id,
    baseUrl: config.baseUrl,
    auth: { apiKey: compatApiKeyAuth(config.id, apiKey) },
    models: config.models.map((m) => compatModel(m, config)),
    api: config.protocol === 'anthropic' ? anthropicMessagesApi() : openAICompletionsApi(),
  })
}

/**
 * 构建当前 Models 集合。providers.json / credentials 变化后由宿主重建，
 * 通过 HarnessOptions.models 的 getter 形式热生效（无需重开 harness）。
 */
export function buildModels(options: ModelGatewayOptions): Models {
  const models = createModels()
  const keys = options.apiKeys()

  for (const provider of builtinProviders()) {
    models.setProvider(withInjectedKey(provider, keys[provider.id]))
  }

  for (const config of options.providers) {
    if (!config.enabled) continue
    models.setProvider(buildCompatProvider(config, keys[config.id]))
  }
  return models
}

/** 保留供应商原生认证逻辑；OAuth-only 供应商不得被注入伪造的 API Key 方式。 */
function withInjectedKey(provider: Provider, injectedKey: string | undefined): Provider {
  const base = provider.auth.apiKey
  if (!injectedKey || !base) return provider
  const injectCredential = (input: Parameters<ApiKeyAuth['resolve']>[0]) => ({
    ...input,
    credential: { ...input.credential, type: 'api_key' as const, key: input.credential?.key ?? injectedKey },
  })
  const apiKey: ApiKeyAuth = {
    ...base,
    ...(base.check ? { check: (input) => base.check!(injectCredential(input)) } : {}),
    resolve: (input) => base.resolve(injectCredential(input)),
  }
  return { ...provider, auth: { ...provider.auth, apiKey } }
}

/** 显式投影公开元数据，绝不序列化 SDK provider 内的 headers 或认证回调。 */
export function listModelProviders(models: Models): ModelProviderSummary[] {
  return models.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    modelCount: models.getModels(provider.id).length,
    authMethods: [
      ...(provider.auth.apiKey ? [{ type: 'api_key' as const, label: provider.auth.apiKey.name }] : []),
      ...(provider.auth.oauth ? [{ type: 'oauth' as const, label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name }] : []),
    ],
  })).sort((a, b) => a.name.localeCompare(b.name))
}

export interface ModelRefParts {
  provider: string
  modelId: string
}

export function parseModelRef(ref: string): ModelRefParts {
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash >= ref.length - 1) {
    throw new HelmError('validation_error', `模型引用格式应为 'provider/model'：${ref}`)
  }
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

/**
 * 列出全部模型目录（含未配置 key 的，标注 available）。
 * checkAuth 语义：undefined = 合法的「未配置凭据」；仅此情况记 available=false。
 * 读取错误 / 协议错误（ModelsError code auth 等）向上抛出诊断，绝不静默吞掉。
 */
export async function listModelCatalog(models: Models): Promise<ModelCatalogEntry[]> {
  const out: ModelCatalogEntry[] = []
  for (const provider of models.getProviders()) {
    const auth = await models.checkAuth(provider.id)
    for (const model of models.getModels(provider.id)) {
      out.push({ provider: provider.id, modelId: model.id, available: auth !== undefined })
    }
  }
  return out
}

/** 解析默认模型引用；任何缺失都显式报错（不假造模型）。 */
export function requireModelRef(ref: string | undefined): ModelRefParts {
  if (!ref || ref.trim() === '') {
    throw new HelmError(
      'model_not_configured',
      '未配置任何模型：请在 providers.json / profile 中配置，或设置 HELM_MODEL 环境变量',
      503,
    )
  }
  return parseModelRef(ref)
}
