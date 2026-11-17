import React, { useEffect, useMemo, useState } from 'react'
import type { PluginSummary } from '@helm/protocol/browser'
import { resolveLocalizedText } from '@helm/protocol/browser'
import { ApiClientError, pluginsApi } from '../lib/api.js'
import { HelmIcon } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { PluginCard } from './PluginCard.js'
import { PluginDetailDrawer } from './PluginDetailDrawer.js'
import { PluginInstallModal } from './PluginInstallModal.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import {
  filterPlugins,
  pluginStatusTabLabel,
  summarizePlugins,
  type PluginStatusFilter,
} from './plugin-center-model.js'

const PLUGIN_STATUS_TABS: PluginStatusFilter[] = ['all', 'enabled', 'disabled']

export interface PluginCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** 显式指定详情抽屉与弹窗是否内联渲染（便于测试与 SSR 统一断言） */
  inlineDrawer?: boolean
}

/**
 * 全屏插件中心（Plugin Center）主视图容器：
 * - 升格为系统一级主舞台视图，彻底淘汰旧的居中模态小弹窗；
 * - 顶部工具栏：关键字检索搜索框；
 * - 响应式卡片网格：消费 PluginCard 自适应流式呈现；
 * - 详情与配置抽屉：右侧联动滑出 PluginDetailDrawer，与 URL Hash 深链（#/settings/plugins/<pluginId>）闭环同步；
 * - 快捷启停与通知：安全调用 pluginsApi，提供在途任务冲突提示；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function PluginCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: PluginCenterProps): React.JSX.Element {
  const store = useHelmStore()
  const { locale, t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<PluginStatusFilter>('all')
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  // 刷新代数：安装/更新/卸载后拉取列表；SSE plugin.changed 到达时避免重复拉取覆盖当前 target
  const [refreshTick, setRefreshTick] = useState(0)
  const refreshGeneration = React.useRef(0)

  const plugins = store.plugins ?? []
  const statusSummary = useMemo(() => summarizePlugins(plugins), [plugins])

  const filteredPlugins = useMemo(() => {
    return filterPlugins(plugins, { query, status: statusFilter }, locale)
  }, [plugins, query, statusFilter, locale])

  const currentTarget = isSplit ? store.splitTarget : store.primaryTarget
  const selectedPluginId =
    currentTarget?.kind === 'plugins' ? currentTarget.pluginId : undefined

  const selectedPlugin = useMemo(
    () => plugins.find((p) => p.id === selectedPluginId) ?? null,
    [plugins, selectedPluginId],
  )

  const isDrawerOpen = Boolean(selectedPluginId && selectedPlugin)

  /** 拉取全量插件清单并写入 store（插件列表以 SSE 为增量真相，此处仅按需全量校准）。 */
  const refreshPlugins = async () => {
    const generation = ++refreshGeneration.current
    try {
      const list = await pluginsApi.list()
      // 迟到的旧响应不得覆盖新状态（代数竞争保护）
      if (generation !== refreshGeneration.current) return
      store.syncPlugins?.(list)
    } catch {
      // 静默失败：SSE 快照仍是权威数据源，无需打断用户
    }
  }

  // 包操作（安装/更新/卸载）后请求一次全量刷新
  const handlePackageChanged = () => {
    setRefreshTick((t) => t + 1)
  }

  useEffect(() => {
    if (refreshTick === 0) return
    void refreshPlugins()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick])

  const openPluginTarget = (pluginId?: string) => {
    store.openTarget(
      pluginId !== undefined ? { kind: 'plugins', pluginId } : { kind: 'plugins' },
      isSplit ? { split: true } : undefined,
    )
  }

  const handleSelectPlugin = (pluginId: string) => {
    openPluginTarget(pluginId)
  }

  const handleCloseDrawer = () => {
    openPluginTarget(undefined)
  }

  // 安装成功：刷新列表并导航至新插件详情抽屉（HTTP 结果先到，SSE 随后 upsert，两者幂等）。
  // enable=true 但启用失败时，安装仍成功；必须显式提示，不把 disabled 状态伪装成已启用。
  const handleInstalled = (pluginId: string, enableError?: { code: string; message: string }) => {
    openPluginTarget(pluginId)
    handlePackageChanged()
    if (enableError !== undefined) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: t('plugins.notice.installEnableFailedTitle'),
        body: `${enableError.code}: ${enableError.message}`,
      })
    }
  }

  // 卸载成功：关闭抽屉并刷新列表（列表已无该插件，抽屉必须先收起）
  const handleRemoved = () => {
    openPluginTarget(undefined)
  }

  const handleTogglePlugin = async (
    plugin: PluginSummary,
    targetEnabled?: boolean,
    options?: { force?: boolean },
  ) => {
    if (plugin.locked || togglingId === plugin.id) return
    setTogglingId(plugin.id)
    const nextEnabled = targetEnabled !== undefined ? targetEnabled : !plugin.enabled
    const displayName = resolveLocalizedText(plugin.name, locale) || plugin.id
    try {
      if (nextEnabled) {
        await pluginsApi.enable(plugin.id)
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: t('plugins.notice.enabledTitle'),
          body: t('plugins.notice.enabledBody', { name: displayName }),
        })
      } else {
        await pluginsApi.disable(plugin.id, options)
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: t('plugins.notice.disabledTitle'),
          body: t('plugins.notice.disabledBody', { name: displayName }),
        })
      }
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: nextEnabled ? t('plugins.notice.enableFailedTitle') : t('plugins.notice.disableFailedTitle'),
        body:
          err instanceof ApiClientError && err.status === 409
            ? t('plugins.notice.liveTasksError', { code: err.code })
            : (err instanceof Error ? err.message : String(err)),
      })
      throw err
    } finally {
      setTogglingId(null)
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
    store.openTarget({ kind: 'plugins', pluginId: selectedPluginId }, { split: true })
  }

  return (
    <div className={`plugin-center${isSplit ? ' is-split' : ''}`} data-view="plugin-center">
      {/* Top bar: title and actions */}
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmIcon name="puzzle" size={14} />
            <span>{t('plugins.center.title')}</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions pane-actions">
          <button
            type="button"
            className="btn btn-sm"
            title={t('plugins.center.installTitle')}
            aria-label={t('plugins.installPlugin')}
            onClick={() => setInstallOpen(true)}
          >
            <HelmIcon name="download" size={12} />
            <span className="pane-action-label">{t('plugins.installPlugin')}</span>
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

      {/* Search toolbar */}
      <div className="plugin-center-toolbar">
        <div className="plugin-search-box">
          <HelmIcon name="search" size={14} />
          <input
            type="text"
            placeholder={t('plugins.center.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('plugins.center.searchAria')}
          />
          {query && (
            <button
              type="button"
              className="btn btn-ghost btn-sm plugin-search-clear"
              title={t('plugins.center.clearSearch')}
              aria-label={t('plugins.center.clearSearch')}
              onClick={() => setQuery('')}
            >
              <HelmIcon name="x" size={12} />
            </button>
          )}
        </div>

        <div
          className="primary-category-pills"
          role="tablist"
          aria-label={t('plugins.center.filterAria')}
        >
          {PLUGIN_STATUS_TABS.map((statusKey) => {
            const count =
              statusKey === 'all'
                ? statusSummary.total
                : statusKey === 'enabled'
                  ? statusSummary.enabled
                  : statusSummary.disabled
            const isActive = statusFilter === statusKey
            return (
              <button
                key={statusKey}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`primary-category-pill${isActive ? ' is-active' : ''}`}
                onClick={() => setStatusFilter(statusKey)}
              >
                <span>{pluginStatusTabLabel(statusKey, t)}</span>
                <span className="badge tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Main viewport: responsive card grid or empty state */}
      <div className="plugin-center-content">
        {filteredPlugins.length > 0 ? (
          <div className="plugin-center-grid">
            {filteredPlugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                selected={selectedPluginId === plugin.id}
                onSelect={() => handleSelectPlugin(plugin.id)}
                onToggle={(enabled) => handleTogglePlugin(plugin, enabled)}
                toggling={togglingId === plugin.id}
              />
            ))}
          </div>
        ) : (
          <div className="plugin-center-empty">
            <div className="plugin-center-empty-icon">
              <HelmIcon name="search" size={28} />
            </div>
            <div className="plugin-center-empty-text">{t('plugins.center.emptyTitle')}</div>
            <div className="plugin-center-empty-hint text-subtle">
              {t('plugins.center.emptyHint')}
            </div>
            {(query || statusFilter !== 'all') && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setQuery('')
                  setStatusFilter('all')
                }}
              >
                <HelmIcon name="rotate-ccw" size={12} />
                <span>{t('plugins.center.resetSearch')}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right slide-over detail and configuration drawer */}
      <PluginDetailDrawer
        plugin={selectedPlugin}
        open={isDrawerOpen}
        onClose={handleCloseDrawer}
        onToggleEnabled={(
          plugin: PluginSummary,
          targetEnabled?: boolean,
          options?: { force?: boolean },
        ) => handleTogglePlugin(plugin, targetEnabled, options)}
        toggling={togglingId === selectedPlugin?.id}
        onPackageChanged={handlePackageChanged}
        onRemoved={handleRemoved}
        inline={inlineDrawer}
      />

      {/* Lightweight install modal: npm / git / local path; navigates to the new plugin drawer on success */}
      <PluginInstallModal
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        onInstalled={handleInstalled}
        inline={inlineDrawer}
      />
    </div>
  )
}
