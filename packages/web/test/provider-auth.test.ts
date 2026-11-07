import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelProviderSummary, ProviderConfig } from '@helm/protocol'
import type { ModelDescriptor } from '../src/lib/api.js'
import { buildProviderEntries, filterProviderEntries } from '../src/modals/provider-auth-model.js'

const catalog: ModelProviderSummary[] = [
  { id: 'openai', name: 'OpenAI', modelCount: 2, authMethods: [{ type: 'api_key', label: 'API Key' }] },
  { id: 'deepseek', name: 'DeepSeek', modelCount: 2, authMethods: [{ type: 'api_key', label: 'API Key' }] },
  { id: 'openai-codex', name: 'OpenAI Codex', modelCount: 8, authMethods: [{ type: 'oauth', label: 'ChatGPT' }] },
  { id: 'typesafe', name: 'Typesafe', modelCount: 0, authMethods: [{ type: 'api_key', label: 'API Key' }] },
]
const models: ModelDescriptor[] = [
  { id: 'openai/gpt-5', provider: 'openai', modelId: 'gpt-5', available: true },
  { id: 'deepseek/deepseek-v4', provider: 'deepseek', modelId: 'deepseek-v4', available: false },
]
const gateway: ProviderConfig = { id: 'disabled-gateway', protocol: 'openai', baseUrl: 'https://example.com/v1', models: ['model'], enabled: false }

test('供应商列表保留零模型供应商、停用网关与未登记凭据；已配置优先且不伪造认证方式', { timeout: 60_000 }, () => {
  const entries = buildProviderEntries(catalog, [gateway], [{ id: 'deepseek', configured: true }, { id: 'saved-only', configured: true }], models)
  assert.equal(entries.length, 6)
  assert.equal(entries[0]?.id, 'deepseek')
  assert.equal(entries[1]?.id, 'openai')
  assert.equal(entries.find((entry) => entry.id === 'typesafe')?.modelCount, 0)
  assert.equal(entries.find((entry) => entry.id === 'disabled-gateway')?.custom, true)
  assert.equal(entries.find((entry) => entry.id === 'saved-only')?.hasStoredKey, true)
  assert.deepEqual(entries.find((entry) => entry.id === 'openai-codex')?.authMethods.map((method) => method.type), ['oauth'])
  assert.equal(entries.find((entry) => entry.id === 'deepseek')?.available, false, '仅存了密钥不等于真实可用')
})

test('按供应商名称、ID 和模型 ID 搜索，忽略大小写与首尾空白', { timeout: 60_000 }, () => {
  const entries = buildProviderEntries(catalog, [], [], models)
  assert.deepEqual(filterProviderEntries(entries, '  DEEPSEEK ', 'all', models).map((entry) => entry.id), ['deepseek'])
  assert.deepEqual(filterProviderEntries(entries, 'codex', 'all', models).map((entry) => entry.id), ['openai-codex'])
  assert.deepEqual(filterProviderEntries(entries, 'gpt-5', 'all', models).map((entry) => entry.id), ['openai'])
  assert.equal(filterProviderEntries(entries, '不存在', 'all', models).length, 0)
})

test('环境凭据与已存密钥均计入已配置；待配置筛选与搜索可组合', { timeout: 60_000 }, () => {
  const entries = buildProviderEntries(catalog, [], [{ id: 'deepseek', configured: true }], models)
  assert.deepEqual(filterProviderEntries(entries, '', 'configured', models).map((entry) => entry.id), ['deepseek', 'openai'])
  assert.deepEqual(filterProviderEntries(entries, 'openai', 'unconfigured', models).map((entry) => entry.id), ['openai-codex'])
  assert.equal(filterProviderEntries(entries, '', 'all', models).length, 4)
})
