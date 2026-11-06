/**
 * 模型接入：pi-ai 官方 provider（openai / anthropic）+ providers.json 兼容网关。
 * API Key 优先 credentials（宿主解析函数注入），退回环境变量；
 * 未配置模型时显式抛 model_not_configured，绝不 faux fallback 假装回答。
 */

import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  createModels,
  createProvider,
  type Models,
  type Provider,
} from '@earendil-works/pi-ai/models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import type { ProviderConfig } from '@helm/protocol'
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

/** 兼容网关的静态模型（getModels 同步返回；形状满足 Model 最小要求）。 */
/** 兼容网关的静态模型（getModels 同步返回；形状满足 pi-ai Model 最小要求）。 */
function compatModel(id: string, protocol: 'openai' | 'anthropic'): never {
  return {
    id,
    name: id,
    api: protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    reasoning: false,
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 8_192,
    provider: '',
  } as never
}

function buildCompatProvider(config: ProviderConfig, apiKey: string | undefined): Provider {
  const auth = { apiKey: staticKeyAuth(config.id, apiKey) } as never
  if (config.protocol === 'anthropic') {
    return createProvider({
      id: config.id,
      name: config.label ?? config.id,
      baseUrl: config.baseUrl,
      auth: { apiKey: auth },
      models: config.models.map((m) => compatModel(m, 'anthropic')),
      api: anthropicMessagesApi(),
    })
  }
  return createProvider({
    id: config.id,
    name: config.label ?? config.id,
    baseUrl: config.baseUrl,
    auth: { apiKey: auth },
    models: config.models.map((m) => compatModel(m, 'openai')),
    api: openAICompletionsApi(),
  })
}

/** 固定 key 的 auth（credential 已由宿主解析为值；未配置时返回未配置）。 */
interface HelmApiKeyAuth {
  name: string
  resolve(input: { credential?: { key?: string }; signal: AbortSignal }): Promise<
    { auth: { apiKey?: string }; source?: string } | undefined
  >
}

function staticKeyAuth(providerId: string, apiKey: string | undefined): HelmApiKeyAuth {
  return {
    name: `${providerId} API key`,
    resolve: async ({ signal }) => {
      signal.throwIfAborted()
      if (!apiKey) return undefined
      return { auth: { apiKey }, source: 'helm credentials' }
    },
  }
}

/**
 * 构建当前 Models 集合。providers.json / credentials 变化后由宿主重建，
 * 通过 HarnessOptions.models 的 getter 形式热生效（无需重开 harness）。
 */
export function buildModels(options: ModelGatewayOptions): Models {
  const models = createModels()
  const keys = options.apiKeys()
  const openaiKey = keys['openai'] ?? process.env['OPENAI_API_KEY']
  const anthropicKey = keys['anthropic'] ?? process.env['ANTHROPIC_API_KEY']

  const openai = openaiProvider()
  const anthropic = anthropicProvider()
  models.setProvider(
    openaiKey ? withKey(openai, openaiKey) : withEnvFallback(openai, 'OPENAI_API_KEY'),
  )
  models.setProvider(
    anthropicKey
      ? withKey(anthropic, anthropicKey)
      : withEnvFallback(anthropic, 'ANTHROPIC_API_KEY'),
  )

  for (const config of options.providers) {
    if (!config.enabled) continue
    models.setProvider(buildCompatProvider(config, keys[config.id]))
  }
  return models
}

/** 官方 provider 叠加固定 key（credential store 的 key 优先于注入值）。 */
function withKey(provider: Provider, key: string): Provider {
  return withAuth(provider, async (storedKey, signal) => {
    signal.throwIfAborted()
    const effective = storedKey ?? key
    if (!effective) return undefined
    return {
      auth: { apiKey: effective },
      source: storedKey ? 'stored credential' : 'helm credentials',
    }
  })
}

/** 无注入 key 时回退环境变量（保持官方 provider 原生语义）。 */
function withEnvFallback(provider: Provider, envVar: string): Provider {
  return withAuth(provider, async (storedKey, signal) => {
    signal.throwIfAborted()
    const effective = storedKey ?? process.env[envVar]
    if (!effective) return undefined
    return { auth: { apiKey: effective }, source: storedKey ? 'stored credential' : envVar }
  })
}

function withAuth(
  provider: Provider,
  resolve: (
    storedKey: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ auth: { apiKey?: string }; source?: string } | undefined>,
): Provider {
  const apiKey: HelmApiKeyAuth = {
    name: `${provider.name} API key`,
    resolve: (input) => resolve(input.credential?.key, input.signal),
  }
  return { ...provider, auth: { ...provider.auth, apiKey: apiKey as never } }
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

/** 列出全部模型目录（含未配置 key 的，标注 available）。 */
export async function listModelCatalog(models: Models): Promise<ModelCatalogEntry[]> {
  const out: ModelCatalogEntry[] = []
  for (const provider of models.getProviders()) {
    const auth = await models.checkAuth(provider.id).catch(() => undefined)
    for (const model of models.getModels(provider.id)) {
      out.push({ provider: provider.id, modelId: model.id, available: Boolean(auth?.source) })
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
