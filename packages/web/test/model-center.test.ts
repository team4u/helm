import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import React from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import type { ProviderConfig } from '@helm/protocol'
import type { ModelDescriptor } from '../src/lib/api.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
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

  // 2. 表单字段（API Key 输入框与 Base URL 输入框）
  assert.match(html, /API 密钥/)
  assert.match(html, /type="password"/)
  assert.match(html, /placeholder="已配置（留空保持不变）"/)
  assert.match(html, /服务端点/)
  assert.match(html, /value="https:\/\/api\.openai\.com\/v1"/)

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
    e(HelmStoreContext.Provider, { value: store }, e(ModelCenter, { inlineDrawer: true })),
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
    e(HelmStoreContext.Provider, { value: store }, e(ModelCenter, { inlineDrawer: true })),
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
      HelmStoreContext.Provider,
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
    e(HelmStoreContext.Provider, { value: store }, e(ModelCenter, { inlineDrawer: true })),
  )

  // Tab 表单内联呈现，不再唤出 defaults 抽屉
  assert.match(html, /全局模型规则/)
  assert.match(html, /新会话的继承链/)
  assert.match(html, /保存全局默认/)
  assert.match(html, /aria-label="全局默认模型"/)
  assert.doesNotMatch(html, /class="[^"]*primary-drawer-content[^"]*"/)
  assert.equal(EMOJI_REGEX.test(html), false)
})

test('ModelCenter SSR: 正确呈现包含 Magpie 网关在内的全量动态供应商', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    primaryTarget: { kind: 'models', providerId: 'magpie' },
  })

  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(ModelCenter, { inlineDrawer: true })),
  )

  // 包含 Magpie 卡片与抽屉
  assert.match(html, /Magpie 网关/)
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
  const stylesSource = readFileSync(join(PKG_ROOT, 'src', 'styles.css'), 'utf8')

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
  const stylesSource = readFileSync(join(PKG_ROOT, 'src', 'styles.css'), 'utf8')

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

