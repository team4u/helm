import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readHostStyles } from './helpers/host-styles.js'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import React from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import type { ProviderConfig } from '@helm/protocol'
import type { ModelProviderSummary } from '@helm/protocol'
import type { ModelDescriptor } from '../src/lib/api.js'
import { ModelCard } from '../src/models/ModelCard.js'
import { ModelCenter } from '../src/models/ModelCenter.js'
import {
  buildDefaultModelOptions,
  buildMergedProviders,
  DEFAULT_PROVIDERS,
  filterProviders,
  summarizeProviders,
  UNSET_MODEL_VALUE,
  type ProviderItem,
} from '../src/models/model-center-model.js'
import { ModelDetailDrawer } from '../src/models/ModelDetailDrawer.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

const e = React.createElement
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))

// Emoji 正则范围匹配
const EMOJI_REGEX =
  /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

// ---------------------------------------------------------------------------
// 1. model-center-model 纯函数模型测试
// ---------------------------------------------------------------------------

test('model-center-model: 默认供应商列表包含指定的 9 大主流供应商且具备有效元数据', { timeout: 60_000 }, () => {
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
    assert.equal(ids.includes(expected), true, `默认列表应包含供应商 ${expected}`)
  }

  const ollama = DEFAULT_PROVIDERS.find((p) => p.id === 'ollama')
  assert.equal(Boolean(ollama?.baseUrl), true)

  const anthropic = DEFAULT_PROVIDERS.find((p) => p.id === 'anthropic')
  assert.equal(anthropic?.models && anthropic.models.length > 0, true)
})

test('model-center-model: 静态预设零插件供应商硬编码（插件网关仅来自后端实时目录）', { timeout: 60_000 }, () => {
  // 插件供应商（如 builtin:magpie 的 'magpie'）的呈现与消失完全跟随插件启停；
  // 前端静态预设不硬编码任何 pluginId，否则插件停用/启动失败后卡片残留。
  for (const p of DEFAULT_PROVIDERS) {
    assert.equal(p.pluginId, undefined, `静态供应商 ${p.id} 不得携带 pluginId`)
  }
  assert.equal(DEFAULT_PROVIDERS.some((p) => p.id === 'magpie'), false)
})

test('filterProviders: 模糊多维检索（支持名称、ID、描述及所包含的模型搜索，忽略大小写）', { timeout: 60_000 }, () => {
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

  // 按供应商名称搜索
  const r1 = filterProviders(testProviders, { query: 'anthropic' })
  assert.deepEqual(r1.map((p) => p.id), ['anthropic'])

  // 按供应商 ID 搜索（大写）
  const r2 = filterProviders(testProviders, { query: 'OPENAI' })
  assert.deepEqual(r2.map((p) => p.id), ['openai'])

  // 按模型 ID / 名称搜索
  const r3 = filterProviders(testProviders, { query: 'sonnet' })
  assert.deepEqual(r3.map((p) => p.id), ['anthropic'])

  const r4 = filterProviders(testProviders, { query: 'Reasoning' })
  assert.deepEqual(r4.map((p) => p.id), ['openai'])

  // 不存在项
  const r5 = filterProviders(testProviders, { query: 'not-found-xyz' })
  assert.equal(r5.length, 0)
})

test('summarizeProviders: 正确统计供应商总数与已配置数', { timeout: 60_000 }, () => {
  const testProviders: ProviderItem[] = [
    { id: 'p1', name: 'C1', type: 'commercial', configured: true, modelsCount: 1 },
    { id: 'p2', name: 'C2', type: 'commercial', configured: false, modelsCount: 1 },
  ]
  const summary = summarizeProviders(testProviders)
  assert.equal(summary.total, 2)
  assert.equal(summary.configured, 1)
})

test('buildMergedProviders: 目录中 disabled 的模型融合后显示为未勾选，enabled 与 available（凭据可用性）解耦', { timeout: 60_000 }, () => {
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
  // 可用且未禁用：勾选。
  assert.equal(byId.get('faux-1')?.enabled, true)
  // 目录 disabled: true -> 融合后未勾选（即使凭据可用）。
  assert.equal(byId.get('faux-2')?.enabled, false)
  // 凭据不可用叠加禁用：同样未勾选。
  assert.equal(byId.get('faux-3')?.enabled, false)
  // 凭据未配置（available=false）但未被用户禁用：路由仍勾选。
  // 勾选态是「路由启用」而非凭据可用性，否则填写密钥保存会误禁全部模型。
  assert.equal(byId.get('faux-4')?.enabled, true)
})

test('buildMergedProviders: 正确与凭证、自定义网关及远程目录模型融合', { timeout: 60_000 }, () => {
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

test('buildMergedProviders: 真实已知窗口生成「N 上下文」标签且思考标签在前，未知窗口不加', { timeout: 60_000 }, () => {
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

  // 思考 + 已知 200k 窗口：两个标签，思考在前、紧凑窗口在后
  assert.deepEqual(byId.get('glm-4.6')?.tags, ['思考模型', '200k 上下文'])
  // 思考 + 窗口未知：只有思考标签，绝不推测窗口
  assert.deepEqual(byId.get('kimi-k2')?.tags, ['思考模型'])
  // 非思考模型 + 已知 1M 窗口：仍有窗口标签（与是否思考无关）
  assert.deepEqual(byId.get('qwen3-coder')?.tags, ['1.0M 上下文'])
  // 两者皆无：保持 undefined（空 tags 不产生空数组语义）
  assert.equal(byId.get('plain-mini')?.tags, undefined)
})

test('buildDefaultModelOptions: 哨兵空值项、可用模型过滤与目录外保留', { timeout: 60_000 }, () => {
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

  // 未设置当前值：首项为非空哨兵（Radix Select 空串是 placeholder 语义），仅列可用模型
  const options = buildDefaultModelOptions(models, '')
  const first = options[0]
  const second = options[1]
  assert.ok(first && second)
  assert.equal(first.value, UNSET_MODEL_VALUE)
  assert.equal(options.length, 2)
  assert.equal(second.value, 'anthropic/claude-3-7-sonnet')

  // 当前值不在可用目录：保留并标注目录外
  const stale = buildDefaultModelOptions(models, 'zhipu/glm-4.6')
  const last = stale[stale.length - 1]
  assert.ok(last)
  assert.equal(last.value, 'zhipu/glm-4.6')
  assert.equal(last.meta, '目录外')

  // 哨兵值本身不触发目录外保留
  const sentinel = buildDefaultModelOptions(models, UNSET_MODEL_VALUE)
  const sentinelLast = sentinel[sentinel.length - 1]
  assert.ok(sentinelLast)
  assert.equal(sentinelLast.meta, 'anthropic')
})

test('buildDefaultModelOptions: 已禁用模型不作为正常可选项；当前值恰为禁用模型时保留并标注已禁用', { timeout: 60_000 }, () => {
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

  // 无当前值：禁用模型不出现在可选项中。
  const options = buildDefaultModelOptions(models, '')
  assert.equal(options.some((o) => o.value === 'faux/faux-2'), false)
  assert.deepEqual(
    options.map((o) => o.value),
    [UNSET_MODEL_VALUE, 'faux/faux-1'],
  )

  // 当前默认模型恰为禁用模型：保留为当前配置项（不静默丢失）并标注已禁用，且不重复。
  const withDisabled = buildDefaultModelOptions(models, 'faux/faux-2')
  const hits = withDisabled.filter((o) => o.value === 'faux/faux-2')
  assert.equal(hits.length, 1, '禁用模型只应保留一项（不得既在可选项又在标注项重复出现）')
  assert.equal(hits[0]?.label, 'faux/faux-2（已禁用）')
  assert.equal(hits[0]?.meta, '已禁用')
})

// ---------------------------------------------------------------------------
// 2. ModelCard SSR 渲染测试
// ---------------------------------------------------------------------------

test('ModelCard SSR: 正确渲染供应商卡片头部、徽章、描述与模型数量胶囊，且绝对零 Emoji', { timeout: 60_000 }, () => {
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
    e(ModelCard, {
      provider,
      selected: false,
      onSelect: () => {},
    }),
  )

  // 1. 卡片类名与结构
  assert.match(html, /class="[^"]*primary-card[^"]*"/)
  assert.match(html, /class="[^"]*primary-card-header[^"]*"/)

  // 2. 供应商名称与 ID（.mono）
  assert.match(html, /DeepSeek/)
  assert.match(html, /class="[^"]*mono[^"]*"[^>]*>deepseek<\/span>/)

  // 3. 配置状态徽章（已配置高亮）
  assert.match(html, /class="badge badge-ok"[^>]*>已配置<\/span>/)

  // 4. 描述
  assert.match(html, /深度求索 R1 与通用基座。/)

  // 5. 底部模型数量
  assert.match(html, /2 个模型可用/)

  // 6. 零 Emoji
  assert.equal(EMOJI_REGEX.test(html), false, '卡片渲染不得包含任何 Emoji')
})

test('ModelCard SSR: 未配置与选中态渲染断言', { timeout: 60_000 }, () => {
  const provider: ProviderItem = {
    id: 'ollama',
    name: 'Ollama',
    type: 'local',
    configured: false,
    modelsCount: 3,
    description: '本地模型运行环境。',
  }

  const html = renderToStaticMarkup(
    e(ModelCard, {
      provider,
      selected: true,
      onSelect: () => {},
    }),
  )

  // 选中态类名
  assert.match(html, /class="[^"]*is-selected[^"]*"/)
  assert.match(html, /aria-selected="true"/)

  // 未配置徽章
  assert.match(html, /class="badge badge-neutral"[^>]*>未配置<\/span>/)
  assert.match(html, /3 个模型可用/)

  // 零 Emoji
  assert.equal(EMOJI_REGEX.test(html), false)
})

// ---------------------------------------------------------------------------
// 3. ModelDetailDrawer SSR 渲染测试
// ---------------------------------------------------------------------------

test('ModelDetailDrawer SSR: inline={true} 渲染凭据表单、连通性按钮与平铺模型药丸胶囊群，且绝对零 Emoji', { timeout: 60_000 }, () => {
  const provider: ProviderItem = {
    id: 'openai',
    name: 'OpenAI',
    type: 'commercial',
    configured: true,
    modelsCount: 2,
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', tags: ['多模态', '128K'], enabled: true },
      { id: 'o1', name: 'o1 Reasoning', tags: ['深度推理'], enabled: false },
    ],
  }

  const html = renderToStaticMarkup(
    e(ModelDetailDrawer, {
      provider,
      open: true,
      inline: true,
      onClose: () => {},
    }),
  )

  // 1. 抽屉标题与元信息
  assert.match(html, /OpenAI/)
  assert.match(html, /class="[^"]*mono[^"]*"[^>]*>openai<\/div>/)

  // 2. 表单字段（API Key 输入框；内置供应商服务端点只读展示，不可假编辑）
  assert.match(html, /API 密钥/)
  assert.match(html, /type="password"/)
  assert.match(html, /placeholder="已配置（留空保持不变）"/)
  assert.match(html, /服务端点/)
  assert.doesNotMatch(html, /id="model-drawer-base-url"/, '内置供应商端点不得渲染可编辑输入框')
  assert.match(html, /https:\/\/api\.openai\.com\/v1/)
  assert.match(html, /内置固定值/)

  // 3. 测试连接按钮
  assert.match(html, /测试连接/)

  // 4. 模型清单与平铺模型药丸胶囊群
  assert.match(html, /模型清单与路由控制/)
  assert.match(html, /aria-label="选择启用的模型"/)
  assert.match(html, /mchips/)
  assert.match(html, /mchip/)
  assert.match(html, /role="checkbox"/)
  assert.match(html, /GPT-4o/)
  assert.match(html, /多模态/)
  assert.match(html, /model-drawer-tags-wrap/)
  assert.match(html, /全部启用/)
  assert.match(html, /全部停用/)

  // 5. 保存配置按钮
  assert.match(html, /保存配置/)

  // 6. 零 Emoji
  assert.equal(EMOJI_REGEX.test(html), false, '抽屉渲染不得包含任何 Emoji')
})

test('ModelDetailDrawer SSR: 未配置凭证供应商 placeholder 正确显示', { timeout: 60_000 }, () => {
  const provider: ProviderItem = {
    id: 'groq',
    name: 'Groq',
    type: 'commercial',
    configured: false,
    modelsCount: 1,
    models: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', enabled: true }],
  }

  const html = renderToStaticMarkup(
    e(ModelDetailDrawer, {
      provider,
      open: true,
      inline: true,
      onClose: () => {},
    }),
  )

  assert.match(html, /placeholder="请输入 API 密钥"/)
  assert.match(html, /未配置/)
  assert.equal(EMOJI_REGEX.test(html), false)
})

// ---------------------------------------------------------------------------
// 4. ModelCenter SSR 渲染测试
// ---------------------------------------------------------------------------

test('ModelCenter SSR: 完整渲染顶栏、Tab 栏、检索框、分类药丸与网格流，且绝对零 Emoji', { timeout: 60_000 }, () => {
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

  // 1. 顶栏标题与副标题
  assert.match(html, /class="[^"]*primary-center-title[^"]*"/)
  assert.match(html, /模型与凭证中心/)

  // 2. 统计摘要、顶部 Tab 与全局默认状态行
  assert.match(html, /供应商<\/span>/)
  assert.match(html, /全局默认/)

  // 3. 搜索框与占位符
  assert.match(html, /class="[^"]*primary-search-box[^"]*"/)
  assert.match(html, /placeholder="搜索供应商名称、ID 或包含的模型\.\.\."/)

  // 4. 卡片网格流
  assert.match(html, /class="[^"]*primary-center-grid[^"]*"/)
  assert.match(html, /Anthropic/)
  assert.match(html, /OpenAI/)
  assert.match(html, /DeepSeek/)
  assert.match(html, /Ollama/)

  // 6. 零 Emoji
  assert.equal(EMOJI_REGEX.test(html), false, '模型中心渲染不得包含任何 Emoji')
})

test('ModelCenter SSR: 目标携带 providerId 时自动唤出对应详情抽屉', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    primaryTarget: { kind: 'models', providerId: 'anthropic' },
    credentials: [{ id: 'anthropic', configured: true }],
  })

  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true })),
  )

  // 抽屉展开且含有 Anthropic 详情
  assert.match(html, /class="[^"]*primary-drawer-content[^"]*"/)
  assert.match(html, /Claude 3\.7 Sonnet/)
  assert.match(html, /混合推理/)
  assert.match(html, /API 密钥/)
  assert.match(html, /测试连接/)

  // 零 Emoji
  assert.equal(EMOJI_REGEX.test(html), false)
})

test('ModelCenter SSR: 空状态与分屏模式渲染', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    primaryTarget: { kind: 'models' },
  })

  // 传入空列表触发空状态
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

  assert.match(htmlEmpty, /未找到匹配的供应商/)
  assert.match(htmlEmpty, /aria-label="关闭分屏"/)
  assert.equal(EMOJI_REGEX.test(htmlEmpty), false)
})

test('ModelCenter SSR: 目标携带 tab=defaults 时内联全局默认配置表单', { timeout: 60_000 }, () => {
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

  // Tab 表单内联呈现，不再唤出 defaults 抽屉
  assert.match(html, /全局模型规则/)
  assert.match(html, /新会话的继承链/)
  assert.match(html, /保存全局默认/)
  assert.match(html, /aria-label="全局默认模型"/)
  assert.doesNotMatch(html, /class="[^"]*primary-drawer-content[^"]*"/)
  assert.equal(EMOJI_REGEX.test(html), false)
})

test('ModelCenter SSR: 后端目录返回插件网关时呈现动态供应商卡片与抽屉', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    primaryTarget: { kind: 'models', providerId: 'magpie' },
  })

  // 插件网关（如 builtin:magpie）仅来自后端实时目录：插件启用时 catalog
  // 才包含该条目；静态预设不硬编码任何插件供应商（停用后卡片必须消失）。
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

  // listModelProviders 尚未返回前不渲染（初始 catalog 为空数组）
  const htmlInitial = renderToString(
    e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true })),
  )
  assert.doesNotMatch(htmlInitial, /Magpie/)

  // 融合后端目录后卡片出现，抽屉联动（“动态同步”章节与刷新按钮）
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
  assert.match(html, /动态同步/)
  assert.match(html, /刷新目录/)
  assert.equal(EMOJI_REGEX.test(html), false)
})

// ---------------------------------------------------------------------------
// 5. 源码静态零 Emoji 扫描测试
// ---------------------------------------------------------------------------

test('静态代码扫描: packages/web/src/models/ 全目录零 Emoji 铁律', { timeout: 60_000 }, () => {
  const files = [
    'model-center-model.ts',
    'ModelCard.tsx',
    'ModelDetailDrawer.tsx',
    'ModelCenter.tsx',
    'GlobalDefaultsPanel.tsx',
  ]

  for (const file of files) {
    const fullPath = join(PKG_ROOT, 'src', 'models', file)
    const content = readFileSync(fullPath, 'utf-8')
    const match = content.match(EMOJI_REGEX)
    assert.equal(
      match,
      null,
      `文件 ${file} 中发现非法 Emoji 字符: ${match ? match[0] : ''}，必须符合零 Emoji 规范！`,
    )
  }
})

test('静态代码扫描: 模型选择场景消费加宽下拉面板与哨兵空值', { timeout: 60_000 }, () => {
  const panelSource = readFileSync(join(PKG_ROOT, 'src', 'models', 'GlobalDefaultsPanel.tsx'), 'utf8')
  const profileDrawerSource = readFileSync(
    join(PKG_ROOT, 'src', 'profiles', 'ProfileDetailDrawer.tsx'),
    'utf8',
  )
  const stylesSource = readHostStyles()

  // 全局默认 Tab 与 Profile 角色抽屉的模型 Select 均接入加宽浮层
  assert.match(panelSource, /popoverClassName="helm-select-popover-wide"/)
  assert.match(profileDrawerSource, /popoverClassName="helm-select-popover-wide"/)
  assert.match(stylesSource, /\.helm-select-popover-wide\s*\{[^}]*max-width:\s*520px/)

  // 哨兵空值：模型下拉选项不含空字符串 value（Radix Select placeholder 语义兼容）
  assert.match(panelSource, /UNSET_MODEL_VALUE/)
  assert.doesNotMatch(panelSource, /value: ''/) 
})

test('契约：ModelCenter 主 Tab 容器接入 model-center-main-tabs 保持视口高度约束与内容区可滚动', { timeout: 60_000 }, () => {
  const modelCenterSource = readFileSync(join(PKG_ROOT, 'src', 'models', 'ModelCenter.tsx'), 'utf8')
  const stylesSource = readHostStyles()

  // 1. ModelCenter 主 Tabs 节点显式携带 model-center-main-tabs
  assert.match(
    modelCenterSource,
    /<Tabs\s+value=\{centerTab\}\s+onValueChange=\{handleTabChange\}\s+className="model-center-main-tabs">/,
    'ModelCenter 内部承载 TabsContent 的根容器必须声明 model-center-main-tabs 类名',
  )

  // 2. styles.css 为 .model-center-main-tabs 提供 flex: 1 与 min-height: 0 视口约束
  assert.match(
    stylesSource,
    /\.model-center-main-tabs\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/,
    'model-center-main-tabs 必须具备 flex: 1 与 min-height: 0 视口约束',
  )

  // 3. 激活状态的内容区必须声明 flex: 1 与 overflow-y: auto 原生滚动
  assert.match(
    stylesSource,
    /\.model-center-main-tabs\s*>\s*\.primary-center-content\[data-state=['"]active['"]\]\s*\{[\s\S]*?overflow-y:\s*auto;/,
    '激活的 primary-center-content 必须具备 overflow-y: auto 原生滚动',
  )
})


// ---------------------------------------------------------------------------
// 4b. 自定义网关服务端点真实持久化（修复：模型界面的端点编辑此前被静默丢弃）
// ---------------------------------------------------------------------------

test('ModelCenter: 自定义网关端点保存经 PUT /api/providers 只改该条 baseUrl（其余网关原样保留）', { timeout: 60_000 }, async () => {
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

  // 深链直达自定义网关抽屉；真实 handleSave 链路（保存 → saveProviders → PUT）
  const store = makeTestStore({
    providers: gateways,
    primaryTarget: { kind: 'models', providerId: 'my-gateway' },
  })

  const putBodies: Array<unknown> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : (input as URL).toString()
    if (init?.method === 'PUT' && path === '/api/providers') {
      putBodies.push(JSON.parse(String(init.body)))
    }
    if (path === '/api/models/providers') return new Response(JSON.stringify([]), { status: 200 })
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

    // 融合自 store.providers 的自定义网关：端点可编辑
    const endpointInput = container.querySelector('input#model-drawer-base-url') as HTMLInputElement
    assert.ok(endpointInput, '自定义网关应渲染可编辑端点输入框')
    assert.equal(endpointInput.value, 'http://10.0.0.8:8000/v1')

    // 修改端点并保存：真实走 ModelCenter.handleSave → assetsApi.saveProviders
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(endpointInput, 'http://192.168.1.5:9000/v1')
    endpointInput.dispatchEvent(new Event('input', { bubbles: true }))
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('保存配置'),
    )!
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(putBodies.length, 1, '端点变更应恰好触发一次 PUT /api/providers')
    const body = putBodies[0] as { providers: ProviderConfig[] }
    const updated = body.providers.find((g) => g.id === 'my-gateway')
    const untouched = body.providers.find((g) => g.id === 'other-gateway')
    assert.equal(updated?.baseUrl, 'http://192.168.1.5:9000/v1')
    assert.equal(updated?.protocol, 'openai', '本网关其余字段原样保留')
    assert.equal(untouched?.baseUrl, 'https://other.example.com/v1', '其它网关 baseUrl 不得被波及')
    assert.equal(untouched?.protocol, 'anthropic')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('ModelCenter: 插件网关端点保存不触发任何 providers 写入（端点归插件配置管理）', { timeout: 60_000 }, async () => {
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

    // 插件网关端点只读：没有可编辑输入框，保存不产生 providers 写入
    // （模型清单的 filter 写入合法存在，与端点无关）
    assert.ok(container.querySelector('input#model-drawer-base-url') === null)
    assert.match(container.textContent ?? '', /该端点由插件 builtin:magpie 的配置管理/)
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('保存配置'),
    )!
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(
      writes.filter((w) => w.includes('/api/providers')).length,
      0,
      '插件网关保存不得产生任何 providers 写请求',
    )
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
