import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import type { ProviderConfig } from '@helm/protocol'
import type { ModelProviderSummary } from '@helm/protocol'
import type { HelmLocale } from '@helm/protocol/browser'
import { ensureHappyDom, typeIntoControl, waitForCondition } from './helpers/dom-harness.js'
import type { ModelDescriptor } from '../src/lib/api.js'
import { ModelCard } from '../src/models/ModelCard.js'
import { ModelCenter } from '../src/models/ModelCenter.js'
import {
  buildDefaultModelOptions,
  buildDefaultProviders,
  buildMergedProviders,
  buildProviderCategoryCounts,
  buildProviderFilterTabs,
  DEFAULT_PROVIDERS,
  filterProviders,
  sortProvidersConfiguredFirst,
  summarizeCardModels,
  summarizeProviders,
  UNSET_MODEL_VALUE,
  type ProviderItem,
} from '../src/models/model-center-model.js'
import { ModelDetailDrawer } from '../src/models/ModelDetailDrawer.js'
import { createWebTranslator } from '../src/i18n/catalog.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

ensureHappyDom()

const e = React.createElement

// Emoji range matcher for the zero-Emoji assertions
const EMOJI_REGEX =
  /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

// ---------------------------------------------------------------------------
// 1. model-center-model pure-function tests
// ---------------------------------------------------------------------------

test('model-center-model: default provider list covers the 9 mainstream presets with valid metadata', { timeout: 60_000 }, () => {
  const ids = DEFAULT_PROVIDERS.map((p) => p.id)
  const expectedIds = [
    'anthropic',
    'openai',
    'deepseek',
    'gemini',
    'ollama',
    'openrouter',
    'mistral',
    'groq',
    'custom',
  ]

  for (const expected of expectedIds) {
    assert.equal(ids.includes(expected), true, `default list must include provider ${expected}`)
  }

  const ollama = DEFAULT_PROVIDERS.find((p) => p.id === 'ollama')
  assert.equal(Boolean(ollama?.baseUrl), true)

  const anthropic = DEFAULT_PROVIDERS.find((p) => p.id === 'anthropic')
  assert.equal(anthropic?.models && anthropic.models.length > 0, true)
})

test('model-center-model: static presets hardcode zero plugin providers (plugin gateways come only from the live backend catalog)', { timeout: 60_000 }, () => {
  // Plugin providers (e.g. builtin:magpie's 'magpie') appear and disappear
  // strictly with the plugin lifecycle; static presets must not hardcode any
  // pluginId, otherwise cards linger after a plugin is disabled or fails.
  for (const p of DEFAULT_PROVIDERS) {
    assert.equal(p.pluginId, undefined, `static provider ${p.id} must not carry pluginId`)
  }
  assert.equal(DEFAULT_PROVIDERS.some((p) => p.id === 'magpie'), false)
})

test('filterProviders: fuzzy multi-dimensional search (name, ID, description, included models; case-insensitive)', { timeout: 60_000 }, () => {
  const testProviders: ProviderItem[] = [
    {
      id: 'anthropic',
      name: 'Anthropic',
      configured: true,
      modelsCount: 2,
      description: '前沿 Claude 系列大模型',
      models: [
        { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', enabled: true },
        { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku', enabled: true },
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      configured: false,
      modelsCount: 2,
      description: 'GPT-4o 与通用基座',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', enabled: true },
        { id: 'o1', name: 'o1 Reasoning', enabled: true },
      ],
    },
  ]

  // Search by provider name
  const r1 = filterProviders(testProviders, { query: 'anthropic' })
  assert.deepEqual(r1.map((p) => p.id), ['anthropic'])

  // Search by provider ID (uppercase)
  const r2 = filterProviders(testProviders, { query: 'OPENAI' })
  assert.deepEqual(r2.map((p) => p.id), ['openai'])

  // Search by model id / name
  const r3 = filterProviders(testProviders, { query: 'sonnet' })
  assert.deepEqual(r3.map((p) => p.id), ['anthropic'])

  const r4 = filterProviders(testProviders, { query: 'Reasoning' })
  assert.deepEqual(r4.map((p) => p.id), ['openai'])

  // No match
  const r5 = filterProviders(testProviders, { query: 'not-found-xyz' })
  assert.equal(r5.length, 0)
})

test('summarizeProviders: counts total and configured providers', { timeout: 60_000 }, () => {
  const testProviders: ProviderItem[] = [
    { id: 'p1', name: 'C1', type: 'commercial', configured: true, modelsCount: 1 },
    { id: 'p2', name: 'C2', type: 'commercial', configured: false, modelsCount: 1 },
  ]
  const summary = summarizeProviders(testProviders)
  assert.equal(summary.total, 2)
  assert.equal(summary.configured, 1)
})

test('buildMergedProviders: catalog-disabled models merge unchecked; enabled decouples from availability (credentials)', { timeout: 60_000 }, () => {
  const credentials = [{ id: 'faux', configured: false }]
  const catalogModels: ModelDescriptor[] = [
    {
      id: 'faux/faux-1',
      provider: 'faux',
      modelId: 'faux-1',
      available: true,
      thinkingLevels: ['off'],
      label: 'Faux 1',
    },
    {
      id: 'faux/faux-2',
      provider: 'faux',
      modelId: 'faux-2',
      available: true,
      disabled: true,
      thinkingLevels: ['off'],
      label: 'Faux 2',
    },
    {
      id: 'faux/faux-3',
      provider: 'faux',
      modelId: 'faux-3',
      available: false,
      disabled: true,
      thinkingLevels: ['off'],
      label: 'Faux 3',
    },
    {
      id: 'faux/faux-4',
      provider: 'faux',
      modelId: 'faux-4',
      available: false,
      thinkingLevels: ['off'],
      label: 'Faux 4',
    },
  ]

  const merged = buildMergedProviders(
    [{ id: 'faux', name: 'Faux', configured: false, modelsCount: 0 }],
    credentials,
    [],
    catalogModels,
  )
  const faux = merged.find((p) => p.id === 'faux')
  assert.ok(faux)
  const byId = new Map((faux.models ?? []).map((m) => [m.id, m]))
  // Available and not disabled: checked.
  assert.equal(byId.get('faux-1')?.enabled, true)
  // Catalog disabled: true -> merged unchecked (even with working credentials).
  assert.equal(byId.get('faux-2')?.enabled, false)
  // Unavailable credentials plus disabled: also unchecked.
  assert.equal(byId.get('faux-3')?.enabled, false)
  // Credentials missing (available=false) but not user-disabled: routing stays
  // checked. The checked state means "routing enabled", not credential
  // availability — otherwise saving a key would wrongly disable every model.
  assert.equal(byId.get('faux-4')?.enabled, true)
})

test('buildMergedProviders: merges credentials, custom gateways and remote catalog models', { timeout: 60_000 }, () => {
  const credentials = [{ id: 'anthropic', configured: true }]
  const gateways: ProviderConfig[] = [
    {
      id: 'custom-vllm',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:8000/v1',
      models: ['qwen-72b'],
      enabled: true,
      label: '本地 vLLM',
    },
  ]
  const catalogModels: ModelDescriptor[] = [
    {
      id: 'anthropic/claude-3-7-sonnet',
      provider: 'anthropic',
      modelId: 'claude-3-7-sonnet',
      available: true,
      thinkingLevels: ['high'],
      label: 'Claude 3.7 Sonnet (Remote)',
    },
  ]

  const merged = buildMergedProviders(DEFAULT_PROVIDERS, credentials, gateways, catalogModels)
  const anthropic = merged.find((p) => p.id === 'anthropic')
  assert.equal(anthropic?.configured, true)
  assert.equal(anthropic?.modelsCount, 1)
  assert.equal(anthropic?.models?.[0]?.name, 'Claude 3.7 Sonnet (Remote)')

  const vllm = merged.find((p) => p.id === 'custom-vllm')
  assert.equal(vllm?.name, '本地 vLLM')
  assert.equal(vllm?.configured, true)
})

test('buildMergedProviders: known context windows produce an "N context" tag after the thinking tag; unknown windows add none', { timeout: 60_000 }, () => {
  const catalogModels: ModelDescriptor[] = [
    {
      id: 'magpie/glm-4.6',
      provider: 'magpie',
      modelId: 'glm-4.6',
      available: true,
      thinkingLevels: ['off', 'high'],
      contextWindow: 200_000,
      label: 'GLM 4.6',
    },
    {
      id: 'magpie/kimi-k2',
      provider: 'magpie',
      modelId: 'kimi-k2',
      available: true,
      thinkingLevels: ['off', 'low'],
      label: 'Kimi K2',
    },
    {
      id: 'magpie/qwen3-coder',
      provider: 'magpie',
      modelId: 'qwen3-coder',
      available: true,
      thinkingLevels: ['off'],
      contextWindow: 1_000_000,
      label: 'Qwen3 Coder',
    },
    {
      id: 'magpie/plain-mini',
      provider: 'magpie',
      modelId: 'plain-mini',
      available: true,
      thinkingLevels: ['off'],
      label: 'Plain Mini',
    },
  ]

  const merged = buildMergedProviders(
    [{ id: 'magpie', name: 'Magpie', configured: true, modelsCount: 0 }],
    [{ id: 'magpie', configured: true }],
    [],
    catalogModels,
  )
  const byId = new Map((merged.find((p) => p.id === 'magpie')?.models ?? []).map((m) => [m.id, m]))

  // Thinking + known 200k window: two tags, thinking first, compact window after
  assert.deepEqual(byId.get('glm-4.6')?.tags, ['Thinking models', '200k context'])
  // Thinking + unknown window: only the thinking tag; the window is never guessed
  assert.deepEqual(byId.get('kimi-k2')?.tags, ['Thinking models'])
  // Non-thinking + known 1M window: the window tag still appears (independent of thinking)
  assert.deepEqual(byId.get('qwen3-coder')?.tags, ['1.0M context'])
  // Neither: stays undefined (empty tags never become an empty array)
  assert.equal(byId.get('plain-mini')?.tags, undefined)
})

test('buildDefaultModelOptions: unset sentinel entry, available-model filtering and out-of-catalog retention', { timeout: 60_000 }, () => {
  const models: ModelDescriptor[] = [
    {
      id: 'anthropic/claude-3-7-sonnet',
      provider: 'anthropic',
      modelId: 'claude-3-7-sonnet',
      available: true,
      label: 'Claude 3.7 Sonnet',
      thinkingLevels: ['off', 'low', 'high'],
    },
    {
      id: 'openai/gpt-4o',
      provider: 'openai',
      modelId: 'gpt-4o',
      available: false,
      label: 'GPT-4o',
      thinkingLevels: ['off'],
    },
  ]

  // No current value: first entry is the non-empty sentinel (an empty string is
  // placeholder semantics in Radix Select); only available models are listed
  const options = buildDefaultModelOptions(models, '')
  const first = options[0]
  const second = options[1]
  assert.ok(first && second)
  assert.equal(first.value, UNSET_MODEL_VALUE)
  assert.equal(options.length, 2)
  assert.equal(second.value, 'anthropic/claude-3-7-sonnet')

  // Current value outside the available catalog: kept and annotated as out-of-catalog
  const stale = buildDefaultModelOptions(models, 'zhipu/glm-4.6')
  const last = stale[stale.length - 1]
  assert.ok(last)
  assert.equal(last.value, 'zhipu/glm-4.6')
  assert.equal(last.meta, 'Not in catalog')

  // The sentinel value itself never triggers out-of-catalog retention
  const sentinel = buildDefaultModelOptions(models, UNSET_MODEL_VALUE)
  const sentinelLast = sentinel[sentinel.length - 1]
  assert.ok(sentinelLast)
  assert.equal(sentinelLast.meta, 'anthropic')
})

test('buildDefaultModelOptions: disabled models are not regular options; a disabled current value is retained and annotated', { timeout: 60_000 }, () => {
  const models: ModelDescriptor[] = [
    {
      id: 'faux/faux-1',
      provider: 'faux',
      modelId: 'faux-1',
      available: true,
      label: 'Faux 1',
      thinkingLevels: ['off'],
    },
    {
      id: 'faux/faux-2',
      provider: 'faux',
      modelId: 'faux-2',
      available: true,
      disabled: true,
      label: 'Faux 2',
      thinkingLevels: ['off'],
    },
  ]

  // No current value: disabled models never appear as options.
  const options = buildDefaultModelOptions(models, '')
  assert.equal(options.some((o) => o.value === 'faux/faux-2'), false)
  assert.deepEqual(
    options.map((o) => o.value),
    [UNSET_MODEL_VALUE, 'faux/faux-1'],
  )

  // Current default is exactly a disabled model: kept as the current entry
  // (never silently dropped), annotated as disabled, and not duplicated.
  const withDisabled = buildDefaultModelOptions(models, 'faux/faux-2')
  const hits = withDisabled.filter((o) => o.value === 'faux/faux-2')
  assert.equal(hits.length, 1, 'a disabled model must be retained exactly once (never duplicated across options and annotations)')
  assert.equal(hits[0]?.label, 'faux/faux-2 (disabled)')
  assert.equal(hits[0]?.meta, 'Disabled')
})

test('model-center-model zh-CN: preset builders resolve descriptions, tags and option annotations through the zh translator', { timeout: 60_000 }, () => {
  const zh = createWebTranslator('zh-CN')

  // Preset provider descriptions, model tags and the custom preset name
  const providers = buildDefaultProviders(zh)
  const anthropic = providers.find((p) => p.id === 'anthropic')
  assert.equal(anthropic?.description, 'Claude 系列前沿模型，支持超长上下文窗口与深度逻辑推理。')
  assert.deepEqual(anthropic?.models?.[0]?.tags, ['混合推理', '代码', '200K'])
  const custom = providers.find((p) => p.id === 'custom')
  assert.equal(custom?.name, '自定义 OpenAI 兼容接口')

  // Filter pills reuse common.all and the domain configured label
  assert.deepEqual(
    buildProviderFilterTabs(zh).map((tab) => tab.label),
    ['全部', '已配置'],
  )
  // The untouched compatibility constants stay English
  assert.deepEqual(
    buildProviderFilterTabs().map((tab) => tab.label),
    ['All', 'Configured'],
  )

  // Default-model options annotate out-of-catalog entries in zh
  const stale = buildDefaultModelOptions([], 'zhipu/glm-4.6', zh)
  assert.equal(stale[stale.length - 1]?.meta, '目录外')

  // Merged runtime tags interpolate the zh context copy after the thinking tag
  const catalogModels: ModelDescriptor[] = [
    {
      id: 'magpie/glm-4.6',
      provider: 'magpie',
      modelId: 'glm-4.6',
      available: true,
      thinkingLevels: ['off', 'high'],
      contextWindow: 200_000,
      label: 'GLM 4.6',
    },
  ]
  const merged = buildMergedProviders(
    [{ id: 'magpie', name: 'Magpie', configured: false, modelsCount: 0 }],
    [{ id: 'magpie', configured: true }],
    [],
    catalogModels,
    undefined,
    zh,
  )
  assert.deepEqual(merged.find((p) => p.id === 'magpie')?.models?.[0]?.tags, ['思考模型', '200k 上下文'])

  // Catalog fallback descriptions localize too
  const catalog: ModelProviderSummary[] = [
    { id: 'dyn-x', name: 'DynX', modelCount: 0, dynamic: true, authMethods: [] },
  ]
  const mergedDyn = buildMergedProviders([], [], [], [], catalog, zh)
  assert.equal(mergedDyn.find((p) => p.id === 'dyn-x')?.description, '支持动态模型目录刷新的大语言模型供应商。')
})

// ---------------------------------------------------------------------------
// 2. ModelCard SSR rendering tests
// ---------------------------------------------------------------------------

test('ModelCard SSR: renders provider card header, badges, description and model-count pill with zero Emoji', { timeout: 60_000 }, () => {
  const provider: ProviderItem = {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'commercial',
    configured: true,
    modelsCount: 2,
    description: '深度求索 R1 与通用基座。',
    models: [
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', enabled: true },
      { id: 'deepseek-chat', name: 'DeepSeek V3', enabled: true },
    ],
  }

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: makeTestStore() },
      e(ModelCard, {
        provider,
        selected: false,
        onSelect: () => {},
      }),
    ),
  )

  // 1. Card class names and structure
  assert.match(html, /class="[^"]*primary-card[^"]*"/)
  assert.match(html, /class="[^"]*primary-card-header[^"]*"/)

  // 2. Provider name and ID (.mono)
  assert.match(html, /DeepSeek/)
  assert.match(html, /class="[^"]*mono[^"]*"[^>]*>deepseek<\/span>/)

  // 3. Configuration status light (configured → done tone + visible label)
  assert.match(html, /helm-status-light-done[\s\S]*?status-dot-done[\s\S]*?Configured/)

  // 4. Description
  assert.match(html, /深度求索 R1 与通用基座。/)

  // 5. Footer model count
  assert.match(html, /2 models available/)

  // 6. Zero Emoji
  assert.equal(EMOJI_REGEX.test(html), false, 'card markup must not contain any Emoji')
})

test('ModelCard SSR: unconfigured and selected-state assertions', { timeout: 60_000 }, () => {
  const provider: ProviderItem = {
    id: 'ollama',
    name: 'Ollama',
    type: 'local',
    configured: false,
    modelsCount: 3,
    description: '本地模型运行环境。',
  }

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: makeTestStore() },
      e(ModelCard, {
        provider,
        selected: true,
        onSelect: () => {},
      }),
    ),
  )

  // Selected-state class names
  assert.match(html, /class="[^"]*is-selected[^"]*"/)
  assert.match(html, /aria-selected="true"/)

  // Unconfigured status light (neutral pending ring + visible label)
  assert.match(html, /helm-status-light-pending[\s\S]*?Not configured/)
  assert.match(html, /3 models available/)

  // Zero Emoji
  assert.equal(EMOJI_REGEX.test(html), false)
})

// ---------------------------------------------------------------------------
// 3. ModelDetailDrawer SSR rendering tests
// ---------------------------------------------------------------------------

test('ModelDetailDrawer SSR: inline={true} renders the credentials form, connectivity button and flat model chips with zero Emoji', { timeout: 60_000 }, () => {
  const provider: ProviderItem = {
    id: 'openai',
    name: 'OpenAI',
    type: 'commercial',
    configured: true,
    modelsCount: 2,
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', tags: ['Multimodal', '128K'], enabled: true },
      { id: 'o1', name: 'o1 Reasoning', tags: ['Deep reasoning'], enabled: false },
    ],
  }

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: makeTestStore() },
      e(ModelDetailDrawer, {
        provider,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )

  // 1. Drawer title and metadata
  assert.match(html, /OpenAI/)
  assert.match(html, /class="[^"]*mono[^"]*"[^>]*>openai<\/div>/)

  // 2. Form fields (API key input; built-in provider endpoint read-only, never a fake editable input)
  assert.match(html, /API key/)
  assert.match(html, /type="password"/)
  assert.match(html, /placeholder="Configured \(leave empty to keep unchanged\)"/)
  assert.match(html, /Endpoint/)
  assert.doesNotMatch(html, /id="model-drawer-base-url"/, 'built-in provider endpoint must not render an editable input')
  assert.match(html, /https:\/\/api\.openai\.com\/v1/)
  assert.match(html, /built in and cannot be changed/)

  // 3. Test connection button
  assert.match(html, /Test connection/)

  // 4. Model list and flat model chips
  assert.match(html, /Models and routing control/)
  assert.match(html, /aria-label="Select enabled models"/)
  assert.match(html, /mchips/)
  assert.match(html, /mchip/)
  assert.match(html, /role="checkbox"/)
  assert.match(html, /GPT-4o/)
  assert.match(html, /Multimodal/)
  assert.match(html, /model-drawer-tags-wrap/)
  assert.match(html, /Enable all/)
  assert.match(html, /Disable all/)

  // 5. Save configuration button
  assert.match(html, /Save configuration/)

  // 6. Zero Emoji
  assert.equal(EMOJI_REGEX.test(html), false, 'drawer markup must not contain any Emoji')
})

test('ModelDetailDrawer SSR: unconfigured provider shows the right placeholder', { timeout: 60_000 }, () => {
  const provider: ProviderItem = {
    id: 'groq',
    name: 'Groq',
    type: 'commercial',
    configured: false,
    modelsCount: 1,
    models: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', enabled: true }],
  }

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: makeTestStore() },
      e(ModelDetailDrawer, {
        provider,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )

  assert.match(html, /placeholder="Enter API key"/)
  assert.match(html, /Not configured/)
  assert.equal(EMOJI_REGEX.test(html), false)
})

// ---------------------------------------------------------------------------
// 4. ModelCenter SSR rendering tests
// ---------------------------------------------------------------------------

test('ModelCenter SSR: renders the top bar, tabs, search box, category pills and grid flow with zero Emoji', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    primaryTarget: { kind: 'models' },
    credentials: [
      { id: 'anthropic', configured: true },
      { id: 'deepseek', configured: true },
    ],
  })

  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true })),
  )

  // 1. Top bar title and subtitle
  assert.match(html, /class="[^"]*primary-center-title[^"]*"/)
  assert.match(html, /Models &amp; Credentials Center/)

  // 2. Summary counts, top tabs and the global-default status row
  assert.match(html, /Providers<\/span>/)
  assert.match(html, /Global default/)

  // 3. Search box and placeholder
  assert.match(html, /class="[^"]*primary-search-box[^"]*"/)
  assert.match(html, /placeholder="Search provider name, ID or included models\.\.\."/)

  // 4. Card grid flow
  assert.match(html, /class="[^"]*primary-center-grid[^"]*"/)
  assert.match(html, /Anthropic/)
  assert.match(html, /OpenAI/)
  assert.match(html, /DeepSeek/)
  assert.match(html, /Ollama/)

  // 6. Zero Emoji
  assert.equal(EMOJI_REGEX.test(html), false, 'model center markup must not contain any Emoji')
})

test('ModelCenter SSR: target with providerId opens the matching detail drawer', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    primaryTarget: { kind: 'models', providerId: 'anthropic' },
    credentials: [{ id: 'anthropic', configured: true }],
  })

  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true })),
  )

  // Drawer open with Anthropic details
  assert.match(html, /class="[^"]*primary-drawer-content[^"]*"/)
  assert.match(html, /Claude 3\.7 Sonnet/)
  assert.match(html, /Hybrid reasoning/)
  assert.match(html, /API key/)
  assert.match(html, /Test connection/)

  // Zero Emoji
  assert.equal(EMOJI_REGEX.test(html), false)
})

test('ModelCenter SSR: empty state and split mode', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    primaryTarget: { kind: 'models' },
  })

  // Empty provider list triggers the empty state
  const htmlEmpty = renderToString(
    e(
      HostStoreProviders,
      { value: store },
      e(ModelCenter, {
        providers: [],
        isSplit: true,
        onCloseSplit: () => {},
        inlineDrawer: true,
      }),
    ),
  )

  assert.match(htmlEmpty, /No matching providers/)
  assert.match(htmlEmpty, /aria-label="Close split view"/)
  assert.equal(EMOJI_REGEX.test(htmlEmpty), false)
})

test('ModelCenter SSR: target with tab=defaults inlines the global-default form', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    primaryTarget: { kind: 'models', tab: 'defaults' },
    models: [
      { id: 'anthropic/claude-3-7-sonnet', provider: 'anthropic', modelId: 'claude-3-7-sonnet', available: true, thinkingLevels: ['off', 'low', 'high'] },
      { id: 'openai/gpt-4o', provider: 'openai', modelId: 'gpt-4o', available: true, thinkingLevels: ['off'] },
    ],
  })

  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true })),
  )

  // The tab form renders inline using shared ModelPickerControl rows; the defaults drawer never opens
  assert.match(html, /Global model rules/)
  assert.match(html, /The inheritance chain for new conversations/)
  assert.match(html, /Save global defaults/)
  assert.match(html, /aria-label="Global default model"/)
  assert.match(html, /aria-label="Global compaction model"/)
  assert.match(html, /Not set \(inherits system baseline\)/)
  assert.match(html, /Not set \(use current conversation model\)/)
  assert.match(html, /composer-model-button/)
  assert.doesNotMatch(html, /class="[^"]*primary-drawer-content[^"]*"/)
  assert.equal(EMOJI_REGEX.test(html), false)
})

test('ModelCenter: GlobalDefaultsPanel reuses ModelPickerControl (model · level) and saves compactionModel + compactionThinkingLevel via PUT /api/models/default', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const store = makeTestStore({
    primaryTarget: { kind: 'models', tab: 'defaults' },
    models: [
      { id: 'anthropic/claude-3-7-sonnet', provider: 'anthropic', modelId: 'claude-3-7-sonnet', available: true, thinkingLevels: ['off', 'low', 'high'] },
      { id: 'openai/gpt-4o-mini', provider: 'openai', modelId: 'gpt-4o-mini', available: true, thinkingLevels: ['off', 'low', 'medium'] },
    ],
  })

  const putBodies: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : (input as URL).toString()
    if (path === '/api/models/providers') return new Response(JSON.stringify([]), { status: 200 })
    // 真实 refreshAssets 会重拉资产端点：数组响应保持目录切片形状合法
    if (
      path === '/api/credentials' || path === '/api/skills' || path === '/api/profiles' ||
      path === '/api/models' || path === '/api/providers' || path === '/api/actions'
    ) {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (path === '/api/actions') return new Response(JSON.stringify([]), { status: 200 })
    if (path === '/api/models/default' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      putBodies.push(body)
      return new Response(
        JSON.stringify({
          ok: true,
          defaultModel: (body.model as string) ?? '',
          defaultThinkingLevel: (body.thinkingLevel as string) ?? '',
          modelThinkingLevels: (body.modelThinkingLevels as Record<string, string>) ?? {},
          defaultCompactionModel: (body.compactionModel as string) ?? '',
          defaultCompactionThinkingLevel: (body.compactionThinkingLevel as string) ?? '',
        }),
        { status: 200 },
      )
    }
    if (path === '/api/models/default') {
      return new Response(
        JSON.stringify({
          defaultModel: 'anthropic/claude-3-7-sonnet',
          defaultThinkingLevel: 'high',
          defaultCompactionModel: 'openai/gpt-4o-mini',
          defaultCompactionThinkingLevel: 'low',
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true })))
    })

    // Status row and single-row picker buttons show model · thinkingLevel
    assert.match(container.textContent ?? '', /Compaction:/)
    assert.match(container.textContent ?? '', /openai\/gpt-4o-mini/)
    const defaultBtn = container.querySelector('#model-defaults-model') as HTMLButtonElement
    const compactionBtn = container.querySelector('#model-defaults-compaction-model') as HTMLButtonElement
    assert.ok(defaultBtn && compactionBtn, 'both rows must reuse ModelPickerControl trigger buttons')
    assert.match(defaultBtn.textContent ?? '', /claude-3-7-sonnet/)
    assert.match(defaultBtn.textContent ?? '', /high/)
    assert.match(compactionBtn.textContent ?? '', /gpt-4o-mini/)
    assert.match(compactionBtn.textContent ?? '', /low/)

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Save global defaults'),
    )!
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(putBodies.length, 1)
    assert.deepEqual(putBodies[0], {
      model: 'anthropic/claude-3-7-sonnet',
      thinkingLevel: 'high',
      compactionModel: 'openai/gpt-4o-mini',
      compactionThinkingLevel: 'low',
      modelThinkingLevels: {},
    })
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('ModelCenter SSR: backend catalog plugin gateways render as dynamic provider cards and drawer', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    primaryTarget: { kind: 'models', providerId: 'magpie' },
  })

  // Plugin gateways (e.g. builtin:magpie) come only from the live backend
  // catalog: the entry exists there only while the plugin is enabled; static
  // presets hardcode no plugin provider (cards must vanish when disabled).
  const catalog: ModelProviderSummary[] = [
    {
      id: 'magpie',
      name: 'Magpie',
      modelCount: 5,
      dynamic: true,
      baseUrl: 'http://127.0.0.1:3425/v1',
      pluginId: 'builtin:magpie',
      authMethods: [{ type: 'api_key', label: 'Magpie gateway' }],
    },
  ]

  // Before listModelProviders resolves nothing renders (initial catalog is an empty array)
  const htmlInitial = renderToString(
    e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true })),
  )
  assert.doesNotMatch(htmlInitial, /Magpie/)

  // After merging the backend catalog the card appears and the drawer follows
  // (the "Dynamic sync" badge and refresh button)
  const merged = buildMergedProviders(DEFAULT_PROVIDERS, [], [], [], catalog)
  const magpie = merged.find((p) => p.id === 'magpie')
  assert.equal(magpie?.pluginId, 'builtin:magpie')
  assert.equal(magpie?.dynamic, true)
  assert.equal(magpie?.modelsCount, 5)

  const html = renderToString(
    e(
      HostStoreProviders,
      { value: store },
      e(ModelCenter, { providers: merged, inlineDrawer: true }),
    ),
  )
  assert.match(html, /Magpie/)
  assert.match(html, /Dynamic sync/)
  assert.match(html, /Refresh catalog/)
  assert.equal(EMOJI_REGEX.test(html), false)
})

// ---------------------------------------------------------------------------
// 4b. Custom gateway endpoint persistence (fix: endpoint edits from the model
//     UI used to be silently dropped)
// ---------------------------------------------------------------------------

test('ModelCenter: custom gateway endpoint save goes through PUT /api/providers and changes only that baseUrl (other gateways untouched)', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const gateways: ProviderConfig[] = [
    {
      id: 'my-gateway',
      protocol: 'openai',
      baseUrl: 'http://10.0.0.8:8000/v1',
      models: ['gw-model'],
      label: 'My Gateway',
      enabled: true,
    },
    {
      id: 'other-gateway',
      protocol: 'anthropic',
      baseUrl: 'https://other.example.com/v1',
      models: ['other-model'],
      enabled: true,
    },
  ]

  // Deep link straight into the custom gateway drawer; the real handleSave
  // chain (save -> saveProviders -> PUT)
  const store = makeTestStore({
    providers: gateways,
    primaryTarget: { kind: 'models', providerId: 'my-gateway' },
  })

  const putBodies: Array<unknown> = []
  const mountFetches = new Set<string>()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : (input as URL).toString()
    if (init?.method === 'PUT' && path === '/api/providers') {
      putBodies.push(JSON.parse(String(init.body)))
    }
    if (path === '/api/models/providers') {
      mountFetches.add(path)
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (path === '/api/models/default' && init?.method !== 'PUT') mountFetches.add(path)
    // 真实 refreshAssets 会重拉资产端点：数组响应保持目录切片形状合法
    if (
      path === '/api/credentials' || path === '/api/skills' || path === '/api/profiles' ||
      path === '/api/models' || path === '/api/providers' || path === '/api/actions'
    ) {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (path === '/api/actions') return new Response(JSON.stringify([]), { status: 200 })
    if (path === '/api/models/default') return new Response(JSON.stringify({}), { status: 200 })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true })))
    })

    // 挂载期的远端目录/默认模型请求先行落地，避免其迟到回包在编辑后重置抽屉草稿
    await waitForCondition(() => mountFetches.has('/api/models/providers') && mountFetches.has('/api/models/default'))
    await act(async () => {})
    // Custom gateway merged from store.providers: endpoint editable
    const endpointInput = container.querySelector('input#model-drawer-base-url') as HTMLInputElement
    assert.ok(endpointInput, 'custom gateway must render an editable endpoint input')
    assert.equal(endpointInput.value, 'http://10.0.0.8:8000/v1')

    // Change the endpoint and save: goes through the real ModelCenter.handleSave -> assetsApi.saveProviders
    typeIntoControl(endpointInput, 'http://192.168.1.5:9000/v1')
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Save configuration'),
    )!
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(putBodies.length, 1, 'the endpoint change must trigger exactly one PUT /api/providers')
    const body = putBodies[0] as { providers: ProviderConfig[] }
    const updated = body.providers.find((g) => g.id === 'my-gateway')
    const untouched = body.providers.find((g) => g.id === 'other-gateway')
    assert.equal(updated?.baseUrl, 'http://192.168.1.5:9000/v1')
    assert.equal(updated?.protocol, 'openai', 'other fields of this gateway stay untouched')
    assert.equal(untouched?.baseUrl, 'https://other.example.com/v1', 'other gateways baseUrl must not be affected')
    assert.equal(untouched?.protocol, 'anthropic')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('ModelCenter: plugin gateway save triggers zero providers writes (endpoints are owned by the plugin configuration)', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const catalog: ModelProviderSummary[] = [
    {
      id: 'magpie',
      name: 'Magpie',
      modelCount: 3,
      dynamic: true,
      baseUrl: 'http://127.0.0.1:3425/v1',
      pluginId: 'builtin:magpie',
      authMethods: [{ type: 'api_key', label: 'Magpie gateway' }],
    },
  ]
  const store = makeTestStore({
    primaryTarget: { kind: 'models', providerId: 'magpie' },
  })
  const merged = buildMergedProviders(DEFAULT_PROVIDERS, [], [], [], catalog)
  const magpie = merged.find((p) => p.id === 'magpie')
  assert.equal(magpie?.pluginId, 'builtin:magpie')

  const writes: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : (input as URL).toString()
    if (init?.method === 'PUT' || init?.method === 'POST') writes.push(`${init.method} ${path}`)
    if (path === '/api/models/providers') return new Response(JSON.stringify(catalog), { status: 200 })
    if (path === '/api/models/default') return new Response(JSON.stringify({}), { status: 200 })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e(ModelCenter, { providers: merged, inlineDrawer: true }),
        ),
      )
    })

    // Plugin gateway endpoint read-only: no editable input, saving produces no
    // providers write (the model-filter write is legitimate and unrelated)
    assert.ok(container.querySelector('input#model-drawer-base-url') === null)
    assert.match(container.textContent ?? '', /This endpoint is managed by the configuration of plugin builtin:magpie/)
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Save configuration'),
    )!
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(
      writes.filter((w) => w.includes('/api/providers')).length,
      0,
      'plugin gateway save must not produce any providers write request',
    )
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('ModelCenter: All/Configured filter pills, configured-card first-3 model preview and unified callout', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')

  const customList: ProviderItem[] = [
    {
      id: 'unconfigured-first',
      name: 'Beta 未配置',
      configured: false,
      modelsCount: 1,
      models: [{ id: 'beta-1', name: 'Beta 1', enabled: true }],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      configured: true,
      modelsCount: 4,
      models: [
        { id: 'anthropic/claude-opus-4', name: 'anthropic/claude-opus-4', enabled: true },
        { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', enabled: true },
        { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku', enabled: true },
        { id: 'claude-3-opus', name: 'Claude 3 Opus', enabled: true },
      ],
    },
  ]

  assert.deepEqual(buildProviderCategoryCounts(customList), { all: 2, configured: 1 })
  assert.deepEqual(
    filterProviders(customList, { statusTab: 'configured' }).map((p) => p.id),
    ['anthropic'],
  )
  assert.deepEqual(summarizeCardModels(customList[1]!, 3), {
    previewNames: ['claude-opus-4', 'Claude 3.7 Sonnet', 'Claude 3.5 Haiku'],
    remainingCount: 1,
  })
  assert.equal(sortProvidersConfiguredFirst(customList)[0]?.id, 'anthropic', 'configured providers must sort first')

  // ModelCard renders the first 3 model short names + +1 and no inline style
  const cardHtml = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: makeTestStore() },
      e(ModelCard, { provider: customList[1]!, onSelect: () => {} }),
    ),
  )
  assert.match(cardHtml, /claude-opus-4/)
  assert.match(cardHtml, /Claude 3\.7 Sonnet/)
  assert.match(cardHtml, /Claude 3\.5 Haiku/)
  assert.doesNotMatch(cardHtml, /Claude 3 Opus/)
  assert.match(cardHtml, /\+1/)
  assert.ok(!cardHtml.includes('style='), 'ModelCard must not keep inline styles')

  // ModelCenter interaction: click the Configured filter pill
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch
  const store = makeTestStore({ primaryTarget: { kind: 'models' } })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        e(HostStoreProviders, { value: store }, e(ModelCenter, { providers: customList, inlineDrawer: true })),
      )
    })

    const cardsBefore = Array.from(container.querySelectorAll('.primary-card'))
    assert.equal(cardsBefore.length, 2)
    assert.match(cardsBefore[0]?.textContent ?? '', /Anthropic/, 'configured cards render first')

    const configuredTab = Array.from(container.querySelectorAll('[role="tab"]')).find((el) =>
      el.textContent?.includes('Configured'),
    ) as HTMLElement | undefined
    assert.ok(configuredTab, 'ModelCenter must render the Configured filter pill')

    await act(async () => {
      configuredTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const cardsAfter = Array.from(container.querySelectorAll('.primary-card'))
    assert.equal(cardsAfter.length, 1)
    assert.match(cardsAfter[0]?.textContent ?? '', /Anthropic/)

    // Verify ModelDetailDrawer uses the unified .callout-error and .btn-icon-sm
    const drawerHtml = renderToStaticMarkup(
      e(
        HostStoreProviders,
        { value: store },
        e(ModelDetailDrawer, {
          provider: customList[1]!,
          open: true,
          inline: true,
          onClose: () => {},
        }),
      ),
    )
    assert.match(drawerHtml, /btn btn-ghost btn-icon-sm/)
    assert.ok(!drawerHtml.includes('callout--'), 'ModelDetailDrawer must not keep legacy callout--* classes')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 5. zh-CN locale rendering and live locale switching
// ---------------------------------------------------------------------------

test('ModelCenter zh-CN: renders center chrome, preset cards, drawer copy and interpolated counts in Chinese', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    locale: 'zh-CN',
    primaryTarget: { kind: 'models', providerId: 'anthropic' },
    credentials: [{ id: 'anthropic', configured: true }],
  })

  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true })),
  )

  // Center chrome and tabs
  assert.match(html, /模型与凭证中心/)
  assert.match(html, /供应商<\/span>/)
  assert.match(html, /全局默认/)
  assert.match(html, /刷新目录/)

  // Card badges with interpolated model counts (anthropic preset: 3 models)
  assert.match(html, /已配置/)
  assert.match(html, /未配置/)
  assert.match(html, /3 个模型可用/)

  // Preset description and model tags resolve through the zh table
  assert.match(html, /Claude 系列前沿模型，支持超长上下文窗口与深度逻辑推理。/)
  assert.match(html, /混合推理/)

  // Detail drawer copy localized
  assert.match(html, /凭证与连接设置/)
  assert.match(html, /测试连接/)
  assert.match(html, /模型清单与路由控制/)

  assert.equal(EMOJI_REGEX.test(html), false)
})

test('ModelCenter locale switch: setLocale re-renders en -> zh-CN -> en in place', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')

  // 真实 store.setLocale 驱动 prefs 领域订阅：消费方原位切换（与生产同链路）。
  const store = makeTestStore({ locale: 'en', primaryTarget: { kind: 'models' } })
  function LocaleSwitchHarness(): React.JSX.Element {
    return e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true }))
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(e(LocaleSwitchHarness))
    })
    assert.match(container.textContent ?? '', /Models & Credentials Center/)
    assert.match(container.textContent ?? '', /Global default/)

    await act(async () => {
      store.setLocale('zh-CN')
    })
    assert.match(container.textContent ?? '', /模型与凭证中心/, 'consumers re-render in Chinese immediately')
    assert.match(container.textContent ?? '', /全局默认/)

    await act(async () => {
      store.setLocale('en')
    })
    assert.match(container.textContent ?? '', /Models & Credentials Center/, 'switching back to en restores English immediately')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
