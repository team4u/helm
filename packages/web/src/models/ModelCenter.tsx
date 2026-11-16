import React, { useEffect, useMemo, useState } from 'react'
import type { ModelProviderSummary } from '@helm/protocol/browser'
import { assetsApi } from '../lib/api.js'
import { HelmIcon, Tabs, TabsContent, TabsList, TabsTrigger } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import type { ModelsCenterTab } from '../lib/types.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { GlobalDefaultsPanel } from './GlobalDefaultsPanel.js'
import { ModelCard } from './ModelCard.js'
import { ModelDetailDrawer } from './ModelDetailDrawer.js'
import {
  buildMergedProviders,
  buildProviderCategoryCounts,
  DEFAULT_PROVIDERS,
  filterProviders,
  PROVIDER_FILTER_TABS,
  sortProvidersConfiguredFirst,
  type ProviderFilterTab,
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
 *   Tab 状态经 URL Hash（#/settings/models/defaults）持久化，defaults 为路径保留段（全局默认 Tab）；
 * - 动态目录加载：实时拉取后端 PI 原生供应商与插件网关，支持全量展示与一键刷新；
 * - 详情与凭证抽屉：右侧联动滑出 ModelDetailDrawer，与 URL Hash 深链（#/settings/models/<providerId>）双向同步；
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
  const [statusTab, setStatusTab] = useState<ProviderFilterTab>('all')

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
    if (customProviders) return sortProvidersConfiguredFirst(customProviders)
    return buildMergedProviders(
      DEFAULT_PROVIDERS,
      store.credentials,
      store.providers,
      store.models,
      catalog,
    )
  }, [customProviders, store.credentials, store.providers, store.models, catalog])

  const statusCounts = useMemo(() => buildProviderCategoryCounts(providers), [providers])

  // 综合过滤（按配置状态标签与关键词）
  const filteredProviders = useMemo(() => {
    return filterProviders(providers, { query, statusTab })
  }, [providers, query, statusTab])

  // 路由与抽屉联动：支持主屏和分屏下的 providerId 与 tab
  const currentTarget =
    isSplit && store.splitTarget?.kind === 'models'
      ? store.splitTarget
      : store.primaryTarget
  const selectedProviderId =
    currentTarget.kind === 'models' ? currentTarget.providerId : undefined
  const centerTab: ModelsCenterTab = currentTarget.kind === 'models' ? currentTarget.tab ?? 'providers' : 'providers'

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
        title: 'Model catalog refreshed',
        body: 'Available model list re-synced from all enabled providers.',
      })
    } catch (err) {
      store.pushNotice?.({
        type: 'notification',
        level: 'error',
        title: 'Failed to refresh model catalog',
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
      // 自定义网关（providers.json）服务端点变更：全量替换语义下只改该条
      // baseUrl，其余网关与字段原样保留；插件网关（如 magpie）端点由所属
      // 插件配置管理，不归模型层写，绝不在此假装已保存。
      if (provider?.custom === true && data.baseUrl !== undefined && data.baseUrl !== '') {
        const gateways = store.providers ?? []
        const gateway = gateways.find((g) => g.id === providerId)
        if (gateway === undefined) {
          throw new Error(`Custom gateway ${providerId} not found in providers.json; cannot update the endpoint`)
        }
        if (data.baseUrl !== gateway.baseUrl) {
          await assetsApi.saveProviders(
            gateways.map((g) => (g.id === providerId ? { ...g, baseUrl: data.baseUrl! } : g)),
          )
        }
      }
      if (data.models && filterEligible) {
        // 全量替换：当前未勾选的模型 id 即该 provider 的完整禁用集（与后端语义一致）。
        const disabledModels = data.models.filter((m) => !m.enabled).map((m) => m.id)
        await assetsApi.setModelFilter({ provider: providerId, disabledModels })
      }
      store.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: 'Provider configuration updated',
        body: `${providerId} configuration saved successfully.`,
      })
      if (store.refreshAssets) {
        await store.refreshAssets()
      }
    } catch (err) {
      store.pushNotice?.({
        type: 'notification',
        level: 'error',
        title: 'Save failed',
        body: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  const toggleSplit = () => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (store.splitTarget !== null) {
      store.closeSplit()
      return
    }
    store.openTarget(
      { kind: 'models', providerId: selectedProviderId, tab: centerTab },
      { split: true },
    )
  }

  return (
    <div className={`primary-center${isSplit ? ' is-split' : ''}`} data-view="model-center">
      {/* Top bar */}
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmIcon name="cpu" size={14} />
            <span>Models & Credentials Center</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions pane-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleRefreshAll}
            disabled={refreshingCatalog}
            title="Pull the latest model catalog from all providers again"
          >
            <HelmIcon name="refresh-cw" size={12} className={refreshingCatalog ? 'spin' : undefined} />
            <span className="pane-action-label">Refresh catalog</span>
          </button>
          {isSplit ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton
              isSplitActive={store.splitTarget !== null}
              onToggleSplit={toggleSplit}
            />
          )}
        </div>
      </div>

      {/* Top tabs: providers / global defaults */}
      <Tabs value={centerTab} onValueChange={handleTabChange} className="model-center-tabs">
        <TabsList aria-label="Model center views">
          <TabsTrigger value="providers" className="model-center-tab-btn">
            <HelmIcon name="layers" size={13} />
            <span>Providers</span>
          </TabsTrigger>
          <TabsTrigger value="defaults" className="model-center-tab-btn">
            <HelmIcon name="sliders" size={13} />
            <span>Global default</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Global default model compact status row */}
      <div className="model-defaults-status">
        <HelmIcon name="sliders" size={13} />
        <span
          className={`badge ${defaultModelInfo?.defaultModel ? 'badge-ok' : 'badge-neutral'}`}
        >
          {defaultModelInfo?.defaultModel ? 'Configured' : 'Not set'}
        </span>
        {defaultModelInfo?.defaultModel ? (
          <span>
            Current: <strong className="mono">{defaultModelInfo.defaultModel}</strong>
            {defaultModelInfo.defaultThinkingLevel &&
              defaultModelInfo.defaultThinkingLevel !== 'off' &&
              `(thinking level: ${defaultModelInfo.defaultThinkingLevel})`}
          </span>
        ) : (
          <span>No global default model set; conversations without an explicit model cannot reply properly.</span>
        )}
        <span className="text-subtle">Inheritance chain: session override &gt; Profile model &gt; global default</span>
      </div>

      <Tabs value={centerTab} onValueChange={handleTabChange} className="model-center-main-tabs">
        {/* Providers tab */}
        <TabsContent value="providers" className="primary-center-content">
          {/* Toolbar: search box, category pills and catalog refresh */}
          <div className="primary-center-toolbar model-toolbar-inline">
            <div className="primary-search-box">
              <HelmIcon name="search" size={14} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search provider name, ID or included models..."
                aria-label="Search providers"
              />
              {query && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm primary-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  title="Clear search"
                >
                  <HelmIcon name="x" size={12} />
                </button>
              )}
            </div>

            <div
              className="primary-category-pills"
              role="tablist"
              aria-label="Filter by provider configuration status"
            >
              {PROVIDER_FILTER_TABS.map((tab) => {
                const count = statusCounts[tab.key] ?? 0
                const isActive = statusTab === tab.key
                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`primary-category-pill${isActive ? ' is-active' : ''}`}
                    onClick={() => setStatusTab(tab.key)}
                  >
                    <span>{tab.label}</span>
                    <span className="badge tabular-nums">{count}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Main card grid or empty state */}
          {filteredProviders.length === 0 ? (
            <div className="primary-center-empty">
              <div className="primary-center-empty-icon">
                <HelmIcon name="search" size={22} />
              </div>
              <div className="primary-center-empty-text">No matching providers</div>
              <div className="primary-center-empty-hint">
                No LLM providers match the search; try different keywords or switch the filter.
              </div>
              {(query || statusTab !== 'all') && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setQuery('')
                    setStatusTab('all')
                  }}
                >
                  Reset filters
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

        {/* Global defaults tab */}
        <TabsContent value="defaults" className="primary-center-content">
          <GlobalDefaultsPanel
            defaultModelInfo={defaultModelInfo}
            onSaved={setDefaultModelInfo}
          />
        </TabsContent>
      </Tabs>

      {/* Provider details and credentials drawer */}
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
