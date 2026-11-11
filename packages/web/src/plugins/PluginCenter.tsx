import React, { useEffect, useMemo, useState } from 'react'
import type { PluginSummary } from '@helm/protocol'
import { ApiClientError, pluginsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { PluginCard } from './PluginCard.js'
import { PluginDetailDrawer } from './PluginDetailDrawer.js'
import {
  buildCategoryCounts,
  filterPlugins,
  summarizePlugins,
  type PluginCategoryTab,
} from './plugin-center-model.js'

export interface PluginCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** 显式指定详情抽屉是否内联渲染（便于测试与 SSR 统一断言） */
  inlineDrawer?: boolean
}

const CATEGORY_TABS: Array<{ key: PluginCategoryTab; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'runtime', label: '运行时' },
  { key: 'tools', label: '工具与能力' },
  { key: 'orchestration', label: '编排与流程' },
  { key: 'system', label: '系统与辅助' },
  { key: 'enabled', label: '已启用' },
]

/**
 * 全屏插件中心（Plugin Center）主视图容器：
 * - 升格为系统一级主舞台视图，彻底淘汰旧的居中模态小弹窗；
 * - 顶部工具栏：多维检索搜索框、分类药丸标签栏与分类数量统计徽章；
 * - 响应式卡片网格：消费 PluginCard 自适应流式呈现；
 * - 详情与配置抽屉：右侧联动滑出 PluginDetailDrawer，深链与 URL Hash 闭环同步；
 * - 快捷启停与通知：安全调用 pluginsApi，提供在途任务冲突提示；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function PluginCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: PluginCenterProps): React.JSX.Element {
  const store = useHelmStore()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<PluginCategoryTab>('all')
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const plugins = store.plugins ?? []
  const categoryCounts = useMemo(() => buildCategoryCounts(plugins), [plugins])
  const summaryStats = useMemo(() => summarizePlugins(plugins), [plugins])

  const filteredPlugins = useMemo(() => {
    return filterPlugins(plugins, {
      query,
      categoryTab: activeTab,
    })
  }, [plugins, query, activeTab])

  const selectedPluginId =
    store.primaryTarget.kind === 'plugins' ? store.primaryTarget.pluginId : undefined

  const selectedPlugin = useMemo(
    () => plugins.find((p) => p.id === selectedPluginId) ?? null,
    [plugins, selectedPluginId],
  )

  const isDrawerOpen = Boolean(selectedPluginId && selectedPlugin)

  const handleSelectPlugin = (pluginId: string) => {
    store.openTarget({ kind: 'plugins', pluginId })
  }

  const handleCloseDrawer = () => {
    store.openTarget({ kind: 'plugins' })
  }

  const handleTogglePlugin = async (plugin: PluginSummary, targetEnabled?: boolean) => {
    if (plugin.locked || togglingId === plugin.id) return
    setTogglingId(plugin.id)
    const nextEnabled = targetEnabled !== undefined ? targetEnabled : !plugin.enabled
    try {
      if (nextEnabled) {
        await pluginsApi.enable(plugin.id)
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: '插件已启用',
          body: `${plugin.name || plugin.id} 已成功启用`,
        })
      } else {
        await pluginsApi.disable(plugin.id)
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: '插件已停用',
          body: `${plugin.name || plugin.id} 已成功停用`,
        })
      }
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: nextEnabled ? '启用插件失败' : '停用插件失败',
        body:
          err instanceof ApiClientError && err.status === 409
            ? `操作失败：插件存在在途任务（${err.code}）`
            : (err instanceof Error ? err.message : String(err)),
      })
      throw err
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <div className={`plugin-center${isSplit ? ' is-split' : ''}`} data-view="plugin-center">
      {/* 顶栏：标题、分屏操作与统计徽章 */}
      <div className="plugin-center-topbar">
        <div className="plugin-center-title-wrap">
          <div className="plugin-center-title">
            <HelmIcon name="puzzle" size={16} />
            <span>插件中心</span>
          </div>
          <span className="plugin-center-subtitle text-subtle">
            管理系统核心内置、协同编排与三方扩展插件
          </span>
        </div>

        <div className="plugin-center-topbar-actions">
          <div className="plugin-center-stats text-subtle">
            {`共 ${summaryStats.total} 个插件 · ${summaryStats.enabled} 个已启用`}
          </div>
          {isSplit && onCloseSplit && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="关闭分屏"
              aria-label="关闭分屏"
              onClick={onCloseSplit}
            >
              <HelmIcon name="x" size={14} />
            </button>
          )}
        </div>
      </div>

      {/* 检索与分类标签栏 */}
      <div className="plugin-center-toolbar">
        <div className="plugin-search-box">
          <HelmIcon name="search" size={14} />
          <input
            type="text"
            className="input"
            placeholder="搜索插件名称、ID、Tool 或 Action…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索插件"
          />
          {query && (
            <button
              type="button"
              className="btn btn-ghost btn-sm plugin-search-clear"
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => setQuery('')}
            >
              <HelmIcon name="x" size={12} />
            </button>
          )}
        </div>

        <div className="plugin-category-pills" role="tablist" aria-label="插件分类筛选">
          {CATEGORY_TABS.map((tab) => {
            const count = categoryCounts[tab.key] ?? 0
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`plugin-category-pill${isActive ? ' is-active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span className="plugin-category-pill-label">{tab.label}</span>
                <span className="badge tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 主视口：自适应响应式卡片网格或空状态 */}
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
            <div className="plugin-center-empty-text">未找到匹配的插件</div>
            <div className="plugin-center-empty-hint text-subtle">
              请尝试调整搜索关键字或切换分类标签。
            </div>
            {(query || activeTab !== 'all') && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setQuery('')
                  setActiveTab('all')
                }}
              >
                <HelmIcon name="rotate-ccw" size={12} />
                <span>重置筛选条件</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* 右侧滑出式详情与配置抽屉 */}
      <PluginDetailDrawer
        plugin={selectedPlugin}
        open={isDrawerOpen}
        onClose={handleCloseDrawer}
        onToggleEnabled={(plugin) => handleTogglePlugin(plugin)}
        toggling={togglingId === selectedPlugin?.id}
        inline={inlineDrawer}
      />
    </div>
  )
}
