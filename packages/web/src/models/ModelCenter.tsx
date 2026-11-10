import React, { useMemo, useState } from 'react'
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
 * - 顶部工具栏：多维模糊搜索框、分类药丸标签栏与分类数量统计徽章；
 * - 响应式卡片网格：消费 ModelCard 呈现已配置与待配置大模型供应商；
 * - 详情与凭证抽屉：右侧联动滑出 ModelDetailDrawer，与 URL Hash 深链双向同步；
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

  // 将预设主流供应商与 store 中的凭据、网关及模型目录实时融合
  const providers = useMemo(() => {
    if (customProviders) return customProviders
    return buildMergedProviders(
      DEFAULT_PROVIDERS,
      store.credentials,
      store.providers,
      store.models,
    )
  }, [customProviders, store.credentials, store.providers, store.models])

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

  const selectedProvider = useMemo(
    () => (selectedProviderId ? providers.find((p) => p.id === selectedProviderId) ?? null : null),
    [providers, selectedProviderId],
  )

  const isDrawerOpen = Boolean(selectedProviderId && selectedProvider)

  const handleSelectProvider = (providerId: string) => {
    store.openTarget({ kind: 'models', providerId }, isSplit ? { split: true } : undefined)
  }

  const handleCloseDrawer = () => {
    store.openTarget({ kind: 'models' }, isSplit ? { split: true } : undefined)
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
        onSave={handleSave}
        onTestConnection={onTestConnection}
      />
    </div>
  )
}
