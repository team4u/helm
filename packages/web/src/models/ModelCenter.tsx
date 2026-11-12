import React, { useEffect, useMemo, useState } from 'react'
import type { ModelProviderSummary } from '@helm/protocol'
import { assetsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/Tabs.js'
import { GlobalDefaultsPanel } from './GlobalDefaultsPanel.js'
import { ModelCard } from './ModelCard.js'
import { ModelDetailDrawer } from './ModelDetailDrawer.js'
import {
  buildMergedProviders,
  DEFAULT_PROVIDERS,
  filterProviders,
  summarizeProviders,
  type ProviderItem,
  type ProviderModelItem,
} from './model-center-model.js'

export interface ModelCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  inlineDrawer?: boolean
  providers?: ProviderItem[]
  onSaveProvider?: (
    providerId: string,
    data: { apiKey?: string; baseUrl?: string; models?: ProviderModelItem[] },
  ) => Promise<void> | void
  onTestConnection?: (
    providerId: string,
    baseUrl?: string,
  ) => Promise<{ success: boolean; latencyMs?: number; message?: string }>
}

/**
 * 全屏模型与供应商中心（Model Center）主视图容器：
 * - 系统一级主舞台全屏视图，彻底淘汰传统模态弹窗；
 * - 顶部 Tab 切换：「供应商」（检索 + 分类药丸 + 卡片网格）与「全局默认」（内联默认模型表单），
 *   Tab 状态经 URL Hash（#/models?tab=defaults）持久化，历史深链 id=defaults 自动升级；
 * - 动态目录加载：实时拉取后端 PI 原生供应商与插件网关，支持全量展示与一键刷新；
 * - 详情与凭证抽屉：右侧联动滑出 ModelDetailDrawer，与 URL Hash 深链（#/models?id=xxx）双向同步；
 * - 绝对零 Emoji 铁律，遵循 Fast Refresh 与 WAI-ARIA 规范。
 */
export function ModelCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
  providers: customProviders,
  onSaveProvider,
  onTestConnection,
}: ModelCenterProps): React.JSX.Element {
  const store = useHelmStore()
  const [query, setQuery] = useState('')

  // 动态目录与全局默认模型状态
  const [catalog, setCatalog] = useState<ModelProviderSummary[]>([])
  const [defaultModelInfo, setDefaultModelInfo] = useState<{
    defaultModel: string
    defaultThinkingLevel: string
  } | null>(null)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)

  // 挂载时拉取全量后端供应商目录与全局默认模型配置（代数竞争保护：依赖变化时旧响应不覆盖）
  useEffect(() => {
    const generation = { cancelled: false }
    const fetchRemote = async () => {
      try {
        const [cat, def] = await Promise.all([
          assetsApi.listModelProviders().catch(() => []),
          assetsApi.getDefaultModel().catch(() => null),
        ])
        if (generation.cancelled) return
        if (Array.isArray(cat)) {
          setCatalog(cat)
        }
        if (def && typeof def === 'object') {
          setDefaultModelInfo(def)
        }
      } catch {
        // ignore
      }
    }
    void fetchRemote()
    return () => {
      generation.cancelled = true
    }
  }, [store.models, store.credentials])

  // 将预设主流供应商与 store 中的凭据、网关、模型目录及后端全量 catalog 实时融合
  const providers = useMemo(() => {
    if (customProviders) return customProviders
    return buildMergedProviders(
      DEFAULT_PROVIDERS,
      store.credentials,
      store.providers,
      store.models,
      catalog,
    )
  }, [customProviders, store.credentials, store.providers, store.models, catalog])

  // 总量统计

  // 综合过滤（按关键词）
  const filteredProviders = useMemo(() => {
    return filterProviders(providers, { query })
  }, [providers, query])

  // 路由与抽屉联动：支持主屏和分屏下的 providerId 与 tab
  const currentTarget =
    isSplit && store.splitTarget?.kind === 'models'
      ? store.splitTarget
      : store.primaryTarget
  const selectedProviderId =
    currentTarget.kind === 'models' ? currentTarget.providerId : undefined
  const centerTab = currentTarget.kind === 'models' ? currentTarget.tab ?? 'providers' : 'providers'

  const selectedProvider = useMemo(() => {
    if (!selectedProviderId) return null
    return providers.find((p) => p.id === selectedProviderId) ?? null
  }, [providers, selectedProviderId])

  const isDrawerOpen = Boolean(selectedProviderId && selectedProvider)

  const handleSelectProvider = (providerId: string) => {
    store.openTarget({ kind: 'models', providerId }, isSplit ? { split: true } : undefined)
  }

  const handleCloseDrawer = () => {
    store.openTarget({ kind: 'models' }, isSplit ? { split: true } : undefined)
  }

  // Tab 切换写回 URL：进入「全局默认」时清除 providerId（抽屉不与之共存）
  const handleTabChange = (tab: string) => {
    if (tab === centerTab) return
    if (tab === 'defaults') {
      store.openTarget({ kind: 'models', tab: 'defaults' }, isSplit ? { split: true } : undefined)
    } else {
      store.openTarget({ kind: 'models' }, isSplit ? { split: true } : undefined)
    }
  }

  // 刷新全量模型目录
  const handleRefreshAll = async () => {
    setRefreshingCatalog(true)
    try {
      await assetsApi.refreshModels()
      const [cat, def] = await Promise.all([
        assetsApi.listModelProviders().catch(() => []),
        assetsApi.getDefaultModel().catch(() => null),
      ])
      if (Array.isArray(cat)) setCatalog(cat)
      if (def && typeof def === 'object') setDefaultModelInfo(def)
      if (store.refreshAssets) {
        await store.refreshAssets()
      }
      store.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: '模型目录已刷新',
        body: '已从所有启用的供应商重新同步可用模型清单。',
      })
    } catch (err) {
      store.pushNotice?.({
        type: 'notification',
        level: 'error',
        title: '刷新模型目录失败',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRefreshingCatalog(false)
    }
  }

  // 凭证与模型配置保存：凭据与模型启停（全量替换语义）分两次提交；
  // 后端目录不存在的静态预设供应商跳过 filter 写入（目录无从标注，写了也无意义）。
  const handleSave = async (
    providerId: string,
    data: { apiKey?: string; baseUrl?: string; models?: ProviderModelItem[] },
  ) => {
    if (onSaveProvider) {
      await onSaveProvider(providerId, data)
      return
    }

    const provider = providers.find((p) => p.id === providerId)
    const filterEligible = Boolean(provider && (provider.dynamic || provider.custom || provider.pluginId || provider.baseUrl))

    try {
      if (data.apiKey) {
        await assetsApi.setCredential(providerId, data.apiKey)
      }
      if (data.models && filterEligible) {
        // 全量替换：当前未勾选的模型 id 即该 provider 的完整禁用集（与后端语义一致）。
        const disabledModels = data.models.filter((m) => !m.enabled).map((m) => m.id)
        await assetsApi.setModelFilter({ provider: providerId, disabledModels })
      }
      store.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: '供应商配置已更新',
        body: `${providerId} 凭证与模型清单配置已成功持久化。`,
      })
      if (store.refreshAssets) {
        await store.refreshAssets()
      }
    } catch (err) {
      store.pushNotice?.({
        type: 'notification',
        level: 'error',
        title: '保存失败',
        body: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  return (
    <div className="primary-center">
      {/* 顶栏 */}
      <div className="primary-center-topbar">
        <div className="primary-center-title-wrap">
          <div className="primary-center-title">
            <HelmIcon name="cpu" size={16} />
            <span>模型与凭证中心</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions">
          {isSplit && onCloseSplit && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onCloseSplit}
              aria-label="关闭分屏"
              title="关闭分屏"
            >
              <HelmIcon name="x" size={14} />
            </button>
          )}
        </div>
      </div>

      {/* 顶部 Tab：供应商 / 全局默认 */}
      <Tabs value={centerTab} onValueChange={handleTabChange} className="model-center-tabs">
        <TabsList aria-label="模型中心视图">
          <TabsTrigger value="providers" className="model-center-tab-btn">
            <HelmIcon name="layers" size={13} />
            <span>供应商</span>
          </TabsTrigger>
          <TabsTrigger value="defaults" className="model-center-tab-btn">
            <HelmIcon name="sliders" size={13} />
            <span>全局默认</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* 全局默认模型精简状态行 */}
      <div className="model-defaults-status">
        <HelmIcon name="sliders" size={13} />
        <span
          className={`badge ${defaultModelInfo?.defaultModel ? 'badge-ok' : 'badge-neutral'}`}
        >
          {defaultModelInfo?.defaultModel ? '已配置' : '未设置'}
        </span>
        {defaultModelInfo?.defaultModel ? (
          <span>
            当前生效：<strong className="mono">{defaultModelInfo.defaultModel}</strong>
            {defaultModelInfo.defaultThinkingLevel &&
              defaultModelInfo.defaultThinkingLevel !== 'off' &&
              `（思考档位：${defaultModelInfo.defaultThinkingLevel}）`}
          </span>
        ) : (
          <span>未设置全局默认模型，未单独指定模型的会话将无法正常回复。</span>
        )}
        <span className="text-subtle">继承链：临时覆盖 &gt; Profile 模型 &gt; 全局默认</span>
      </div>

      <Tabs value={centerTab} onValueChange={handleTabChange} className="model-center-main-tabs">
        {/* 供应商 Tab */}
        <TabsContent value="providers" className="primary-center-content">
          {/* 工具栏：搜索框、分类药丸与刷新目录 */}
          <div className="primary-center-toolbar model-toolbar-inline">
            <div className="primary-search-box">
              <HelmIcon name="search" size={14} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索供应商名称、ID 或包含的模型..."
                aria-label="搜索供应商"
              />
              {query && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm primary-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="清除搜索"
                  title="清除搜索"
                >
                  <HelmIcon name="x" size={12} />
                </button>
              )}
            </div>

            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={handleRefreshAll}
              disabled={refreshingCatalog}
              title="刷新全部模型目录"
            >
              <HelmIcon
                name="refresh-cw"
                size={13}
                className={refreshingCatalog ? 'spin' : ''}
              />
              <span>{refreshingCatalog ? '正在刷新...' : '刷新模型目录'}</span>
            </button>
          </div>

          {/* 主体卡片网格或空状态 */}
          {filteredProviders.length === 0 ? (
            <div className="primary-center-empty">
              <div className="primary-center-empty-icon">
                <HelmIcon name="search" size={22} />
              </div>
              <div className="primary-center-empty-text">未找到匹配的供应商</div>
              <div className="primary-center-empty-hint">
                没有符合检索条件的大语言模型供应商，请尝试更换关键词。
              </div>
              {query && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setQuery('')
                  }}
                >
                  重置筛选条件
                </button>
              )}
            </div>
          ) : (
            <div className="primary-center-grid">
              {filteredProviders.map((provider) => (
                <ModelCard
                  key={provider.id}
                  provider={provider}
                  selected={selectedProviderId === provider.id}
                  onSelect={() => handleSelectProvider(provider.id)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* 全局默认 Tab */}
        <TabsContent value="defaults" className="primary-center-content">
          <GlobalDefaultsPanel
            defaultModelInfo={defaultModelInfo}
            onSaved={setDefaultModelInfo}
          />
        </TabsContent>
      </Tabs>

      {/* 供应商详情与凭据配置抽屉 */}
      <ModelDetailDrawer
        provider={selectedProvider}
        open={isDrawerOpen}
        onClose={handleCloseDrawer}
        inline={inlineDrawer}
        onSave={handleSave}
        onTestConnection={onTestConnection}
      />
    </div>
  )
}
