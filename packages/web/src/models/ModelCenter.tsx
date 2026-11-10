import React, { useEffect, useMemo, useState } from 'react'
import type { ModelProviderSummary } from '@helm/protocol'
import { assetsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { ModelCard } from './ModelCard.js'
import { ModelDetailDrawer } from './ModelDetailDrawer.js'
import {
  buildMergedProviders,
  buildProviderCategoryCounts,
  DEFAULT_PROVIDERS,
  filterProviders,
  PROVIDER_CATEGORY_TABS,
  summarizeProviders,
  type ProviderCategoryTab,
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
 * - 顶部全局默认模型横幅：醒目展示当前生效的全局模型规则与思考档位，直达默认模型抽屉；
 * - 动态目录加载：实时拉取后端 PI 原生供应商与 Magpie 等插件网关，支持全量展示与一键刷新；
 * - 顶部工具栏：多维模糊搜索框、分类药丸标签栏与分类数量统计徽章；
 * - 响应式卡片网格：消费 ModelCard 呈现已配置与待配置大模型供应商；
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
  const [activeTab, setActiveTab] = useState<ProviderCategoryTab>('all')

  // 动态目录与全局默认模型状态
  const [catalog, setCatalog] = useState<ModelProviderSummary[]>([])
  const [defaultModelInfo, setDefaultModelInfo] = useState<{
    defaultModel: string
    defaultThinkingLevel: string
  } | null>(null)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)

  // 挂载时拉取全量后端供应商目录与全局默认模型配置
  useEffect(() => {
    let cancelled = false
    const fetchRemote = async () => {
      try {
        const [cat, def] = await Promise.all([
          assetsApi.listModelProviders().catch(() => []),
          assetsApi.getDefaultModel().catch(() => null),
        ])
        if (!cancelled) {
          if (Array.isArray(cat)) {
            setCatalog(cat)
          }
          if (def && typeof def === 'object') {
            setDefaultModelInfo(def)
          }
        }
      } catch {
        // ignore
      }
    }
    void fetchRemote()
    return () => {
      cancelled = true
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

  // 分类计数与总量统计
  const categoryCounts = useMemo(() => buildProviderCategoryCounts(providers), [providers])
  const summaryStats = useMemo(() => summarizeProviders(providers), [providers])

  // 综合过滤（Tab 类别 + 关键词）
  const filteredProviders = useMemo(() => {
    return filterProviders(providers, {
      query,
      categoryTab: activeTab,
    })
  }, [providers, query, activeTab])

  // 路由与抽屉联动：支持主屏和分屏下的 providerId
  const currentTarget =
    isSplit && store.splitTarget?.kind === 'models'
      ? store.splitTarget
      : store.primaryTarget
  const selectedProviderId =
    currentTarget.kind === 'models' ? currentTarget.providerId : undefined

  // 针对全局默认模型的虚拟 ProviderItem
  const defaultsProviderItem: ProviderItem = useMemo(
    () => ({
      id: 'defaults',
      name: '全局默认模型',
      type: 'commercial',
      configured: Boolean(defaultModelInfo?.defaultModel),
      modelsCount: store.models.filter((m) => m.available).length,
      description:
        '新会话的继承链：会话临时覆盖 > Profile 模型 > 此处全局默认。切换后对所有未显式覆盖模型的会话即时生效。',
    }),
    [defaultModelInfo?.defaultModel, store.models],
  )

  const selectedProvider = useMemo(() => {
    if (!selectedProviderId) return null
    if (selectedProviderId === 'defaults') return defaultsProviderItem
    return providers.find((p) => p.id === selectedProviderId) ?? null
  }, [providers, selectedProviderId, defaultsProviderItem])

  const isDrawerOpen = Boolean(selectedProviderId && selectedProvider)

  const handleSelectProvider = (providerId: string) => {
    store.openTarget({ kind: 'models', providerId }, isSplit ? { split: true } : undefined)
  }

  const handleCloseDrawer = () => {
    store.openTarget({ kind: 'models' }, isSplit ? { split: true } : undefined)
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

  // 凭证与模型配置保存
  const handleSave = async (
    providerId: string,
    data: { apiKey?: string; baseUrl?: string; models?: ProviderModelItem[] },
  ) => {
    if (onSaveProvider) {
      await onSaveProvider(providerId, data)
      return
    }

    try {
      if (data.apiKey) {
        await assetsApi.setCredential(providerId, data.apiKey)
      }
      store.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: '供应商配置已更新',
        body: `${providerId} 凭证配置已成功持久化。`,
      })
      if (store.refreshAssets) {
        void store.refreshAssets()
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
          <div className="primary-center-subtitle">
            管理大语言模型供应商、API 凭证与模型路由配置
          </div>
        </div>

        <div className="primary-center-topbar-actions">
          <div className="primary-center-stats">
            {`已配置 ${summaryStats.configured} / 共 ${summaryStats.total} 个供应商`}
          </div>
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

      {/* 全局默认模型状态横幅 */}
      <div className="model-global-banner">
        <div className="model-global-banner-left">
          <div className="model-global-banner-icon">
            <HelmIcon name="sliders" size={16} />
          </div>
          <div className="model-global-banner-info">
            <div className="model-global-banner-title">
              <span>全局默认模型</span>
              <span
                className={`badge ${defaultModelInfo?.defaultModel ? 'badge-ok' : 'badge-neutral'}`}
              >
                {defaultModelInfo?.defaultModel ? '已配置' : '未设置'}
              </span>
            </div>
            <div className="model-global-banner-desc">
              {defaultModelInfo?.defaultModel ? (
                <span>
                  当前生效：<strong className="mono">{defaultModelInfo.defaultModel}</strong>
                  {defaultModelInfo.defaultThinkingLevel &&
                    defaultModelInfo.defaultThinkingLevel !== 'off' && (
                      <span className="text-subtle" style={{ marginLeft: 6 }}>
                        （思考档位：{defaultModelInfo.defaultThinkingLevel}）
                      </span>
                    )}
                </span>
              ) : (
                <span>未设置全局默认模型，未单独指定模型的会话将无法正常回复。</span>
              )}
              <span className="text-subtle" style={{ marginLeft: 8 }}>
                继承链：临时覆盖 &gt; Profile 模型 &gt; 全局默认
              </span>
            </div>
          </div>
        </div>
        <div className="model-global-banner-actions">
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
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => handleSelectProvider('defaults')}
          >
            <HelmIcon name="sliders" size={13} />
            <span>配置全局默认</span>
          </button>
        </div>
      </div>

      {/* 工具栏：搜索框与分类药丸 */}
      <div className="primary-center-toolbar">
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

        <div className="primary-category-pills" role="tablist">
          {PROVIDER_CATEGORY_TABS.map((tab) => {
            const count = categoryCounts[tab.key]
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`primary-category-pill ${isActive ? 'is-active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span>{tab.label}</span>
                <span className="badge badge-neutral mono" style={{ fontSize: 10 }}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 主体卡片网格或空状态 */}
      <div className="primary-center-content">
        {filteredProviders.length === 0 ? (
          <div className="primary-center-empty">
            <div className="primary-center-empty-icon">
              <HelmIcon name="search" size={22} />
            </div>
            <div className="primary-center-empty-text">未找到匹配的供应商</div>
            <div className="primary-center-empty-hint">
              没有符合检索条件的大语言模型供应商，请尝试更换关键词或筛选类别。
            </div>
            {(query || activeTab !== 'all') && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setQuery('')
                  setActiveTab('all')
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
      </div>

      {/* 供应商详情与凭据配置抽屉 */}
      <ModelDetailDrawer
        provider={selectedProvider}
        open={isDrawerOpen}
        onClose={handleCloseDrawer}
        inline={inlineDrawer}
        defaultModelInfo={defaultModelInfo}
        onSave={handleSave}
        onTestConnection={onTestConnection}
        onDefaultModelSaved={(info) => setDefaultModelInfo(info)}
      />
    </div>
  )
}
