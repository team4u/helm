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
  { id: 'dynamic-gw', name: 'Dynamic Gateway', modelCount: 5, dynamic: true, baseUrl: 'http://127.0.0.1:9000', authMethods: [{ type: 'api_key', label: 'API Key' }] },
  { id: 'plugin-gw', name: 'Plugin Gateway', modelCount: 3, dynamic: true, pluginId: 'builtin:some-plugin', authMethods: [{ type: 'api_key', label: 'API Key' }] },
]
const models: ModelDescriptor[] = [
  { id: 'openai/gpt-5', provider: 'openai', modelId: 'gpt-5', available: true, thinkingLevels: [] },
  { id: 'deepseek/deepseek-v4', provider: 'deepseek', modelId: 'deepseek-v4', available: false, thinkingLevels: [] },
]
const gateway: ProviderConfig = { id: 'disabled-gateway', protocol: 'openai', baseUrl: 'https://example.com/v1', models: ['model'], enabled: false }

test('the provider list keeps zero-model providers, disabled gateways and unregistered credentials; configured first, auth methods never fabricated', { timeout: 60_000 }, () => {
  const entries = buildProviderEntries(catalog, [gateway], [{ id: 'deepseek', configured: true }, { id: 'saved-only', configured: true }], models)
  assert.equal(entries.length, 8)
  assert.equal(entries[0]?.id, 'deepseek')
  assert.equal(entries[1]?.id, 'openai')
  assert.equal(entries.find((entry) => entry.id === 'typesafe')?.modelCount, 0)
  assert.equal(entries.find((entry) => entry.id === 'disabled-gateway')?.custom, true)
  assert.equal(entries.find((entry) => entry.id === 'saved-only')?.hasStoredKey, true)
  assert.deepEqual(entries.find((entry) => entry.id === 'openai-codex')?.authMethods.map((method) => method.type), ['oauth'])
  assert.equal(entries.find((entry) => entry.id === 'deepseek')?.available, false, 'a stored key alone does not mean actually available')
})

test('search by provider name, ID and model ID, ignoring case and surrounding whitespace', { timeout: 60_000 }, () => {
  const entries = buildProviderEntries(catalog, [], [], models)
  assert.deepEqual(filterProviderEntries(entries, '  DEEPSEEK ', 'all', models).map((entry) => entry.id), ['deepseek'])
  assert.deepEqual(filterProviderEntries(entries, 'codex', 'all', models).map((entry) => entry.id), ['openai-codex'])
  assert.deepEqual(filterProviderEntries(entries, 'gpt-5', 'all', models).map((entry) => entry.id), ['openai'])
  assert.equal(filterProviderEntries(entries, '不存在', 'all', models).length, 0) // zh fixture query with no match
})

test('environment credentials and stored keys both count as configured; unconfigured filter composes with search', { timeout: 60_000 }, () => {
  const entries = buildProviderEntries(catalog, [], [{ id: 'deepseek', configured: true }], models)
  assert.deepEqual(filterProviderEntries(entries, '', 'configured', models).map((entry) => entry.id), ['deepseek', 'openai'])
  assert.deepEqual(filterProviderEntries(entries, 'openai', 'unconfigured', models).map((entry) => entry.id), ['openai-codex'])
  assert.deepEqual(filterProviderEntries(entries, 'gateway', 'unconfigured', models).map((entry) => entry.id).sort(), ['dynamic-gw', 'plugin-gw'])
  assert.equal(filterProviderEntries(entries, '', 'all', models).length, 6)
})

test('dynamic catalog providers pass their dynamic and baseUrl metadata through verbatim', { timeout: 60_000 }, () => {
  const entries = buildProviderEntries(catalog, [gateway], [], [])
  const dynamicEntry = entries.find((entry) => entry.id === 'dynamic-gw')
  assert.equal(dynamicEntry?.dynamic, true)
  assert.equal(dynamicEntry?.baseUrl, 'http://127.0.0.1:9000')
  assert.equal(dynamicEntry?.modelCount, 5)
  const plainEntry = entries.find((entry) => entry.id === 'openai')
  assert.equal(plainEntry?.dynamic, undefined)
  assert.equal(plainEntry?.baseUrl, undefined)
  const gatewayEntry = entries.find((entry) => entry.id === 'disabled-gateway')
  assert.equal(gatewayEntry?.dynamic, undefined)
})

test('plugin-registered providers pass the pluginId generic metadata through; non-plugin providers carry none', { timeout: 60_000 }, () => {
  const entries = buildProviderEntries(catalog, [], [], [])
  assert.equal(entries.find((entry) => entry.id === 'plugin-gw')?.pluginId, 'builtin:some-plugin')
  assert.equal(entries.find((entry) => entry.id === 'openai')?.pluginId, undefined)
  assert.equal(entries.find((entry) => entry.id === 'disabled-gateway')?.pluginId, undefined)
})

test('zero-model dynamic catalog providers stay in the list, never filtered out', { timeout: 60_000 }, () => {
  const emptyDynamic: ModelProviderSummary[] = [
    { id: 'empty-dynamic', name: 'Empty Dynamic', modelCount: 0, dynamic: true, baseUrl: 'http://127.0.0.1:9001', authMethods: [{ type: 'api_key', label: 'API Key' }] },
  ]
  const entries = buildProviderEntries(emptyDynamic, [], [], [])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.id, 'empty-dynamic')
  assert.equal(entries[0]?.dynamic, true)
  assert.equal(entries[0]?.available, false)
})
