/**
 * Model center display copy (ModelCenter / ModelCard / ModelDetailDrawer /
 * GlobalDefaultsPanel plus the model-center-model pure builders).
 * Owner: the models-nodes partition. Chinese copy is backfilled verbatim from
 * the en/zh translation baseline (b4a611a65); interpolation uses `{param}`.
 */
import type { MessageTable } from '../messages.js'

export const modelsMessages = {
  // Center chrome
  'models.title': { en: 'Models & Credentials Center', 'zh-CN': '模型与凭证中心' },
  'models.refreshCatalog': { en: 'Refresh catalog', 'zh-CN': '刷新目录' },
  'models.refreshCatalogTitle': {
    en: 'Pull the latest model catalog from all providers again',
    'zh-CN': '重新从所有供应商拉取最新模型目录',
  },
  'models.refreshing': { en: 'Refreshing...', 'zh-CN': '刷新中...' },
  'models.viewsAria': { en: 'Model center views', 'zh-CN': '模型中心视图' },
  'models.tab.providers': { en: 'Providers', 'zh-CN': '供应商' },
  'models.tab.defaults': { en: 'Global default', 'zh-CN': '全局默认' },

  // Shared provider status badges and card copy
  'models.configured': { en: 'Configured', 'zh-CN': '已配置' },
  'models.notConfigured': { en: 'Not configured', 'zh-CN': '未配置' },
  'models.dynamicBadge': { en: 'Dynamic', 'zh-CN': '动态' },
  'models.customBadge': { en: 'Custom', 'zh-CN': '自定义' },
  'models.dynamicSyncBadge': { en: 'Dynamic sync', 'zh-CN': '动态同步' },
  'models.cardAria': { en: '{name} provider card', 'zh-CN': '{name} 供应商卡片' },
  'models.cardFallbackDescription': {
    en: 'LLM provider with standard API access.',
    'zh-CN': '支持标准接口调用的大语言模型供应商。',
  },
  'models.moreModels': { en: '{count} more models available', 'zh-CN': '另有 {count} 个可用模型' },
  'models.modelsAvailable': { en: '{count} models available', 'zh-CN': '{count} 个模型可用' },

  // Provider search / filtering / empty state
  'models.searchPlaceholder': {
    en: 'Search provider name, ID or included models...',
    'zh-CN': '搜索供应商名称、ID 或包含的模型...',
  },
  'models.searchAria': { en: 'Search providers', 'zh-CN': '搜索供应商' },
  'models.searchClear': { en: 'Clear search', 'zh-CN': '清除搜索' },
  'models.filterAria': {
    en: 'Filter by provider configuration status',
    'zh-CN': '供应商配置状态筛选',
  },
  'models.emptyTitle': { en: 'No matching providers', 'zh-CN': '未找到匹配的供应商' },
  'models.emptyHint': {
    en: 'No LLM providers match the search; try different keywords or switch the filter.',
    'zh-CN': '没有符合检索条件的大语言模型供应商，请尝试更换关键词或切换筛选状态。',
  },
  'models.resetFilters': { en: 'Reset filters', 'zh-CN': '重置筛选条件' },

  // Notifications (titles/bodies are display copy; raw error text is interpolated)
  'models.notice.catalogRefreshed': { en: 'Model catalog refreshed', 'zh-CN': '模型目录已刷新' },
  'models.notice.catalogRefreshedBody': {
    en: 'Available model list re-synced from all enabled providers.',
    'zh-CN': '已从所有启用的供应商重新同步可用模型清单。',
  },
  'models.notice.catalogRefreshFailed': {
    en: 'Failed to refresh model catalog',
    'zh-CN': '刷新模型目录失败',
  },
  'models.notice.catalogResynced': {
    en: '{name} re-synced the latest model catalog.',
    'zh-CN': '{name} 已重新同步最新模型目录。',
  },
  'models.notice.providerUpdated': {
    en: 'Provider configuration updated',
    'zh-CN': '供应商配置已更新',
  },
  'models.notice.providerUpdatedBody': {
    en: '{providerId} configuration saved successfully.',
    'zh-CN': '{providerId} 配置已成功保存。',
  },
  'models.notice.saveFailed': { en: 'Save failed', 'zh-CN': '保存失败' },
  'models.notice.secretDeleted': { en: 'Secret deleted', 'zh-CN': '密钥已删除' },
  'models.notice.secretDeletedBody': {
    en: 'Local credentials of {name} removed successfully.',
    'zh-CN': '{name} 的本地凭证已成功移除。',
  },

  // Global default model status row (compact header strip)
  'models.defaults.notSet': { en: 'Not set', 'zh-CN': '未设置' },
  'models.defaults.currentPrefix': { en: 'Current:', 'zh-CN': '当前生效：' },
  'models.defaults.thinkingLevelSuffix': {
    en: '(thinking level: {level})',
    'zh-CN': '（思考档位：{level}）',
  },
  'models.defaults.compactionCurrentPrefix': {
    en: 'Compaction:',
    'zh-CN': '压缩模型：',
  },
  'models.defaults.unsetHint': {
    en: 'No global default model set; conversations without an explicit model cannot reply properly.',
    'zh-CN': '未设置全局默认模型，未单独指定模型的会话将无法正常回复。',
  },
  'models.defaults.inheritanceChain': {
    en: 'Inheritance chain: session override > Profile model > global default',
    'zh-CN': '继承链：临时覆盖 > Profile 模型 > 全局默认',
  },

  // Detail drawer chrome
  'models.drawer.ariaSelected': {
    en: '{name} details and credentials',
    'zh-CN': '{name} 详情与凭证设置',
  },
  'models.drawer.ariaDefault': {
    en: 'Provider details and credentials',
    'zh-CN': '供应商详情与凭证设置',
  },
  'models.drawer.titleFallback': { en: 'Provider details', 'zh-CN': '供应商详情' },
  'models.drawer.noSelection': { en: 'No provider selected', 'zh-CN': '未选择供应商' },
  'models.drawer.credentialsSection': {
    en: 'Credentials and connection settings',
    'zh-CN': '凭证与连接设置',
  },
  'models.drawer.resyncTitle': {
    en: 'Re-sync the dynamic model catalog of this provider',
    'zh-CN': '重新同步该供应商的动态模型目录',
  },

  // API key field
  'models.apiKey': { en: 'API key', 'zh-CN': 'API 密钥' },
  'models.apiKey.pluginKeyTitle': { en: 'Plugin gateway key', 'zh-CN': '插件网关密钥' },
  'models.apiKey.pluginManaged': {
    en: 'Managed by the configuration of plugin {pluginId}',
    'zh-CN': '由插件 {pluginId} 的配置管理',
  },
  'models.apiKey.pluginManagedHint': {
    en: 'This key is set in the plugin configuration in the plugin center, not stored in the kernel credential vault; filling it in here has no effect.',
    'zh-CN': '该密钥经插件中心对应插件的配置项设置，不存入内核凭据库；在此填写不会生效。',
  },
  'models.apiKey.placeholderConfigured': {
    en: 'Configured (leave empty to keep unchanged)',
    'zh-CN': '已配置（留空保持不变）',
  },
  'models.apiKey.placeholderEnter': { en: 'Enter API key', 'zh-CN': '请输入 API 密钥' },
  'models.apiKey.secretHint': {
    en: 'The secret is stored encrypted in the system secret stash and injected automatically by the kernel on calls; never exposed to the model.',
    'zh-CN': '密钥密文将安全存储于系统保密箱中，调用时由内核自动注入，不向模型泄露。',
  },

  // Endpoint field
  'models.endpoint': { en: 'Endpoint', 'zh-CN': '服务端点' },
  'models.endpoint.defaultUrlPlaceholder': {
    en: 'https://api.example.com/v1 (empty for default URL)',
    'zh-CN': 'https://api.example.com/v1（留空使用默认地址）',
  },
  'models.endpoint.readOnlyTitle': { en: 'Read-only endpoint', 'zh-CN': '只读端点' },
  'models.endpoint.hintCustom': {
    en: 'For reverse proxies, intranet forwarding endpoints or local inference services.',
    'zh-CN': '用于反向代理、内网转发端点或本地推理服务接口。',
  },
  'models.endpoint.hintPlugin': {
    en: 'This endpoint is managed by the configuration of plugin {pluginId}; change it in that plugin configuration in the plugin center.',
    'zh-CN': '该端点由插件 {pluginId} 的配置管理，请前往插件中心对应插件的配置项修改。',
  },
  'models.endpoint.hintBuiltIn': {
    en: 'This provider endpoint is built in and cannot be changed here.',
    'zh-CN': '该供应商端点为内置固定值，不支持在此修改。',
  },

  // Connectivity test
  'models.test.action': { en: 'Test connection', 'zh-CN': '测试连接' },
  'models.test.testing': { en: 'Testing connection...', 'zh-CN': '正在测试连接...' },
  'models.test.ok': {
    en: 'Provider endpoint reachable and model catalog synced.',
    'zh-CN': '供应商端点连通正常，模型目录同步成功。',
  },
  'models.test.noKey': {
    en: 'No API key configured; enter the key before testing the connection.',
    'zh-CN': '未配置 API 密钥，请先输入密钥后再测试连接。',
  },
  'models.test.validated': {
    en: 'Endpoint and credential format validated.',
    'zh-CN': '端点与凭证格式校验正常。',
  },
  'models.test.failed': { en: 'Connection failed: {error}', 'zh-CN': '连接失败: {error}' },
  'models.test.latency': { en: '(latency {ms}ms)', 'zh-CN': '（延迟 {ms}ms）' },
  'models.credentials.delete': { en: 'Delete credentials', 'zh-CN': '删除凭证' },
  'models.refresh.cancelled': {
    en: 'Model catalog refresh was cancelled; retry.',
    'zh-CN': '模型目录刷新已取消，请重试。',
  },

  // Model list section (chips interactions)
  'models.models.section': { en: 'Models and routing control', 'zh-CN': '模型清单与路由控制' },
  'models.models.countBadge': {
    en: '{enabled} enabled / {total} models in total',
    'zh-CN': '已启用 {enabled} / 共 {total} 个模型',
  },
  'models.models.hint': {
    en: 'Click a pill to toggle a model; disabled models are marked in the catalog and cannot be picked in conversations.',
    'zh-CN': '点击胶囊药丸切换模型启用状态，未启用的模型将在目录中标记停用，且会话无法选用。',
  },
  'models.models.emptyDynamic': {
    en: 'This dynamic provider can fetch available models via Refresh catalog above.',
    'zh-CN': '该动态供应商可通过上方「刷新目录」拉取可用模型。',
  },
  'models.models.emptyStatic': {
    en: 'This provider has no preset models; the catalog syncs automatically after saving the endpoint.',
    'zh-CN': '该供应商暂未登记预置模型，保存端点配置后将自动同步目录。',
  },
  'models.models.filterPlaceholder': { en: 'Filter models...', 'zh-CN': '过滤模型...' },
  'models.models.filterAria': { en: 'Filter models', 'zh-CN': '过滤模型' },
  'models.models.enableAll': { en: 'Enable all', 'zh-CN': '全部启用' },
  'models.models.enableMatches': { en: 'Enable matches ({count})', 'zh-CN': '启用匹配项（{count}）' },
  'models.models.enableMatchesTitle': {
    en: 'Enable models matching the current filter',
    'zh-CN': '启用当前过滤匹配的模型',
  },
  'models.models.disableAll': { en: 'Disable all', 'zh-CN': '全部停用' },
  'models.models.disableMatches': { en: 'Disable matches ({count})', 'zh-CN': '停用匹配项（{count}）' },
  'models.models.disableMatchesTitle': {
    en: 'Disable models matching the current filter',
    'zh-CN': '停用当前过滤匹配的模型',
  },
  'models.models.selectAria': { en: 'Select enabled models', 'zh-CN': '选择启用的模型' },
  'models.models.noMatches': { en: 'No matching models', 'zh-CN': '未找到匹配的模型' },
  'models.models.chipTitleEnable': {
    en: '{name} ({id}) - click to Enable',
    'zh-CN': '{name} ({id}) - 点击启用',
  },
  'models.models.chipTitleDisable': {
    en: '{name} ({id}) - click to Disable',
    'zh-CN': '{name} ({id}) - 点击停用',
  },
  'models.models.collapseList': { en: 'Collapse list', 'zh-CN': '折叠列表' },
  'models.models.expandAll': { en: 'Expand all', 'zh-CN': '展开全部' },
  'models.models.expandAllHidden': {
    en: 'Expand all ({count} hidden)',
    'zh-CN': '展开全部（省略 {count} 个）',
  },

  // Drawer footer
  'models.saveSuccess': { en: 'Configuration saved', 'zh-CN': '配置已成功保存' },
  'models.saving': { en: 'Saving...', 'zh-CN': '保存中...' },
  'models.saveConfig': { en: 'Save configuration', 'zh-CN': '保存配置' },
  'models.errors.customGatewayEndpointEmpty': {
    en: 'The custom gateway endpoint cannot be empty.',
    'zh-CN': '自定义网关的服务端点不能为空。',
  },

  // Delete-credentials confirmation dialog
  'models.confirm.title': { en: 'Confirm credential deletion', 'zh-CN': '确认删除凭证' },
  'models.confirm.body': {
    en: 'Delete the local credentials of {name}? Conversations without another configured key will lose access to this provider.',
    'zh-CN': '确定要删除 {name} 的本地密钥凭据吗？删除后未单独配置其他密钥的会话将无法访问此供应商。',
  },
  'models.confirm.thisProvider': { en: 'This provider', 'zh-CN': '该供应商' },
  'models.confirm.confirm': { en: 'Confirm deletion', 'zh-CN': '确认删除' },

  // Global defaults panel form
  'models.defaults.section': { en: 'Global model rules', 'zh-CN': '全局模型规则' },
  'models.defaults.inheritanceHelp': {
    en: 'The inheritance chain for new conversations: session override > Profile model > this global default. Switching applies immediately to every conversation without an explicit model override.',
    'zh-CN': '新会话的继承链：会话临时覆盖 > Profile 模型 > 此处全局默认。切换后对所有未显式覆盖模型的会话即时生效。',
  },
  'models.defaults.modelLabel': { en: 'Default model', 'zh-CN': '默认模型' },
  'models.defaults.modelAria': { en: 'Global default model', 'zh-CN': '全局默认模型' },
  'models.defaults.modelHint': {
    en: 'Selectable models come from the catalogs of all configured and available providers.',
    'zh-CN': '可供选择的模型来自所有已配置且可用的供应商目录。',
  },
  'models.defaults.levelLabel': { en: 'Default thinking level', 'zh-CN': '默认思考档位' },
  'models.defaults.levelAria': {
    en: 'Global default thinking level',
    'zh-CN': '全局默认思考档位',
  },
  'models.defaults.levelUnsupported': {
    en: 'The selected model does not support thinking levels.',
    'zh-CN': '所选模型不支持思考档位。',
  },
  'models.defaults.levelFollowSdk': { en: 'Follow SDK default', 'zh-CN': '跟随 SDK 缺省' },
  'models.defaults.levelCurrent': { en: '{level} (current)', 'zh-CN': '{level}（当前值）' },
  'models.defaults.compactionLabel': { en: 'Compaction model', 'zh-CN': '压缩模型' },
  'models.defaults.compactionAria': { en: 'Global compaction model', 'zh-CN': '全局压缩模型' },
  'models.defaults.compactionHint': {
    en: 'Model used for context compaction summaries. If unset, uses the conversation\'s current model.',
    'zh-CN': '用于上下文压缩摘要的模型；未设置时使用当前会话的模型。',
  },
  'models.defaults.compactionOptionUnset': {
    en: 'Not set (use current conversation model)',
    'zh-CN': '未设置（使用当前会话模型）',
  },
  'models.defaults.save': { en: 'Save global defaults', 'zh-CN': '保存全局默认' },
  'models.defaults.reset': { en: 'Reset', 'zh-CN': '重置' },
  'models.defaults.noticeUpdated': {
    en: 'Global default model updated',
    'zh-CN': '全局默认模型已更新',
  },
  'models.defaults.noticeSetTo': { en: 'Set to {model}', 'zh-CN': '已设置为 {model}' },
  'models.defaults.noticeCompactionSetTo': {
    en: 'Compaction model set to {model}',
    'zh-CN': '压缩模型已设置为 {model}',
  },
  'models.defaults.noticeCleared': {
    en: 'Global default model cleared',
    'zh-CN': '已清除全局默认模型',
  },

  // Default-model select options (buildDefaultModelOptions)
  'models.defaults.optionUnset': {
    en: 'Not set (inherits system baseline)',
    'zh-CN': '未设置（继承系统基线）',
  },
  'models.defaults.optionDisabled': { en: '{model} (disabled)', 'zh-CN': '{model}（已禁用）' },
  'models.defaults.optionCurrent': { en: '{model} (current)', 'zh-CN': '{model}（当前配置）' },
  'models.defaults.metaDisabled': { en: 'Disabled', 'zh-CN': '已禁用' },
  'models.defaults.metaNotInCatalog': { en: 'Not in catalog', 'zh-CN': '目录外' },

  // Merged-provider runtime copy (buildMergedProviders)
  'models.catalog.dynamicDescription': {
    en: 'LLM provider with dynamic model catalog refresh.',
    'zh-CN': '支持动态模型目录刷新的大语言模型供应商。',
  },
  'models.catalog.providerDescription': {
    en: '{name} model provider.',
    'zh-CN': '{name} 模型供应商。',
  },
  'models.gatewayDynamicDescription': {
    en: 'Model gateway registered dynamically at runtime.',
    'zh-CN': '运行时动态注册的模型网关。',
  },

  // Runtime model tags (buildMergedProviders + preset tables)
  'models.tag.thinking': { en: 'Thinking models', 'zh-CN': '思考模型' },
  'models.tag.context': { en: '{size} context', 'zh-CN': '{size} 上下文' },
  'models.tag.hybridReasoning': { en: 'Hybrid reasoning', 'zh-CN': '混合推理' },
  'models.tag.code': { en: 'Code', 'zh-CN': '代码' },
  'models.tag.generalFoundation': { en: 'General-purpose foundation', 'zh-CN': '全能基座' },
  'models.tag.fastResponse': { en: 'Fast response', 'zh-CN': '极速响应' },
  'models.tag.lightweight': { en: 'Lightweight', 'zh-CN': '轻量' },
  'models.tag.multimodal': { en: 'Multimodal', 'zh-CN': '多模态' },
  'models.tag.highIntelligence': { en: 'High intelligence', 'zh-CN': '高智能' },
  'models.tag.greatValue': { en: 'Great value', 'zh-CN': '高性价比' },
  'models.tag.fast': { en: 'Fast', 'zh-CN': '极速' },
  'models.tag.deepReasoning': { en: 'Deep reasoning', 'zh-CN': '深度推理' },
  'models.tag.mathLogic': { en: 'Math and logic', 'zh-CN': '数学逻辑' },
  'models.tag.lightweightReasoning': { en: 'Lightweight reasoning', 'zh-CN': '轻量推理' },
  'models.tag.deepThinking': { en: 'Deep thinking', 'zh-CN': '深度思考' },
  'models.tag.reinforcementLearning': {
    en: 'Reinforcement learning',
    'zh-CN': '强化学习',
  },
  'models.tag.generalConversation': { en: 'General conversation', 'zh-CN': '通用对话' },
  'models.tag.veryLongContext': { en: 'Very long context', 'zh-CN': '超长上下文' },
  'models.tag.lowLatency': { en: 'Low latency', 'zh-CN': '低延迟' },
  'models.tag.flagshipFoundation': { en: 'Flagship foundation', 'zh-CN': '旗舰基座' },
  'models.tag.codeGeneration': { en: 'Code generation', 'zh-CN': '代码生成' },
  'models.tag.edgeFast': { en: 'Edge-fast', 'zh-CN': '端侧极速' },
  'models.tag.ultraLowLatency': { en: 'Ultra-low latency', 'zh-CN': '超低延迟' },
  'models.tag.fastInference': { en: 'Fast inference', 'zh-CN': '极速推理' },
  'models.tag.customCompatible': { en: 'Custom compatible', 'zh-CN': '自定义兼容' },

  // Static preset provider metadata (buildDefaultProviders)
  'models.preset.anthropic.description': {
    en: 'Frontier Claude models with very long context windows and deep reasoning.',
    'zh-CN': 'Claude 系列前沿模型，支持超长上下文窗口与深度逻辑推理。',
  },
  'models.preset.openai.description': {
    en: 'GPT-4o and o1/o3 deep reasoning models with top-tier general-purpose capabilities.',
    'zh-CN': 'GPT-4o 与 o1/o3 深度推理大模型，行业顶级通用基座能力。',
  },
  'models.preset.deepseek.description': {
    en: 'DeepSeek foundation models and the full-strength R1 reinforcement learning reasoner at extreme value.',
    'zh-CN': '深度求索通用基座与 R1 满血强化学习推理大模型，极致高性价比。',
  },
  'models.preset.gemini.description': {
    en: 'Native multimodal models with million-token context and native tool calling.',
    'zh-CN': '原生多模态大模型，支持百万级超长上下文与原生工具调用。',
  },
  'models.preset.ollama.description': {
    en: 'Self-hosted local model platform providing zero-dependency inference through a local daemon.',
    'zh-CN': '本地私有化大模型运行平台，通过本地守护进程提供零外部依赖推理服务。',
  },
  'models.preset.openrouter.description': {
    en: 'Unified gateway aggregating hundreds of global model providers with smart routing and elastic scheduling.',
    'zh-CN': '聚合全球数百家模型供应商的统一网关，支持智能路由与模型弹性调度。',
  },
  'models.preset.mistral.description': {
    en: 'Top European open-source and commercial model series with strong multilingual and reasoning skills.',
    'zh-CN': '欧洲顶级开源与商业大模型系列，兼具优秀的多语言与逻辑推理能力。',
  },
  'models.preset.groq.description': {
    en: 'Ultra-high-throughput inference on proprietary LPU chips, hundreds of tokens per second at very low latency.',
    'zh-CN': '基于自研 LPU 芯片的超高吞吐推理加速平台，数百 Token/s 极低延迟响应。',
  },
  'models.preset.custom.description': {
    en: 'Connect to self-hosted vLLM, SGLang, OneAPI or any third-party OpenAI-compatible endpoint.',
    'zh-CN': '连接自建 vLLM、SGLang、OneAPI 或第三方兼容 OpenAI 协议的自定义端点。',
  },
  'models.preset.custom.name': {
    en: 'Custom OpenAI-compatible endpoint',
    'zh-CN': '自定义 OpenAI 兼容接口',
  },
} satisfies MessageTable
