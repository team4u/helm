import type { ModelProviderSummary, ProviderConfig } from '@helm/protocol'
import type { CredentialStatus, ModelDescriptor } from '../lib/api.js'

export interface ProviderEntry extends ModelProviderSummary {
  hasStoredKey: boolean
  available: boolean
  custom: boolean
}

export type ProviderFilter = 'all' | 'configured' | 'unconfigured'

/** 注册目录为主；保留停用网关与遗留凭据的管理入口，不推断不存在的供应商能力。 */
export function buildProviderEntries(
  catalog: ModelProviderSummary[],
  gateways: ProviderConfig[],
  credentials: CredentialStatus[],
  models: ModelDescriptor[],
): ProviderEntry[] {
  const configured = new Set(credentials.filter((item) => item.configured).map((item) => item.id))
  const available = new Set(models.filter((item) => item.available).map((item) => item.provider))
  const customIds = new Set(gateways.map((item) => item.id))
  const entries = new Map(catalog.map((provider) => [provider.id, provider]))
  for (const gateway of gateways) {
    if (!entries.has(gateway.id)) entries.set(gateway.id, {
      id: gateway.id,
      name: gateway.label ?? gateway.id,
      modelCount: gateway.models.length,
      authMethods: [{ type: 'api_key', label: 'API Key' }],
    })
  }
  for (const credential of credentials) {
    if (!entries.has(credential.id)) entries.set(credential.id, {
      id: credential.id,
      name: credential.id,
      modelCount: 0,
      authMethods: [{ type: 'api_key', label: 'API Key' }],
    })
  }
  return [...entries.values()].map((provider) => ({
    ...provider,
    hasStoredKey: configured.has(provider.id),
    available: available.has(provider.id),
    custom: customIds.has(provider.id),
  })).sort((a, b) => Number(b.available || b.hasStoredKey) - Number(a.available || a.hasStoredKey) || a.name.localeCompare(b.name))
}

export function filterProviderEntries(
  providers: ProviderEntry[],
  query: string,
  filter: ProviderFilter,
  models: ModelDescriptor[],
): ProviderEntry[] {
  const term = query.trim().toLowerCase()
  const matchedModelProviders = new Set(term
    ? models.filter((model) => model.modelId.toLowerCase().includes(term)).map((model) => model.provider)
    : [])
  return providers.filter((provider) => {
    const configured = provider.available || provider.hasStoredKey
    if (filter === 'configured' && !configured) return false
    if (filter === 'unconfigured' && configured) return false
    return !term || `${provider.id} ${provider.name}`.toLowerCase().includes(term) || matchedModelProviders.has(provider.id)
  })
}
