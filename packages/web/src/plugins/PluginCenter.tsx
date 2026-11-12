import React, { useEffect, useMemo, useState } from 'react'
import type { PluginSummary } from '@helm/protocol'
import { ApiClientError, pluginsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { PluginCard } from './PluginCard.js'
import { PluginDetailDrawer } from './PluginDetailDrawer.js'
import { PluginInstallModal } from './PluginInstallModal.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import {
  filterPlugins,
  summarizePlugins,
} from './plugin-center-model.js'

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
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  // 刷新代数：安装/更新/卸载后拉取列表；SSE plugin.changed 到达时避免重复拉取覆盖当前 target
  const [refreshTick, setRefreshTick] = useState(0)
  const refreshGeneration = React.useRef(0)

  const plugins = store.plugins ?? []

  const filteredPlugins = useMemo(() => {
    return filterPlugins(plugins, { query })
  }, [plugins, query])

  const selectedPluginId =
    store.primaryTarget.kind === 'plugins' ? store.primaryTarget.pluginId : undefined

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

  const handleSelectPlugin = (pluginId: string) => {
    store.openTarget({ kind: 'plugins', pluginId })
  }

  const handleCloseDrawer = () => {
    store.openTarget({ kind: 'plugins' })
  }

  // 安装成功：刷新列表并导航至新插件详情抽屉（HTTP 结果先到，SSE 随后 upsert，两者幂等）。
  // enable=true 但启用失败时，安装仍成功；必须显式提示，不把 disabled 状态伪装成已启用。
  const handleInstalled = (pluginId: string, enableError?: { code: string; message: string }) => {
    store.openTarget({ kind: 'plugins', pluginId })
    handlePackageChanged()
    if (enableError !== undefined) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '插件已安装，但启用失败',
        body: `${enableError.code}: ${enableError.message}`,
      })
    }
  }

  // 卸载成功：关闭抽屉并刷新列表（列表已无该插件，抽屉必须先收起）
  const handleRemoved = () => {
    store.openTarget({ kind: 'plugins' })
  }

  const handleTogglePlugin = async (
    plugin: PluginSummary,
    targetEnabled?: boolean,
    options?: { force?: boolean },
  ) => {
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
        await pluginsApi.disable(plugin.id, options)
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
      {/* 顶栏：标题与操作 */}
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmIcon name="puzzle" size={14} />
            <span>扩展插件中心</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions pane-actions">
          <button
            type="button"
            className="btn btn-sm"
            title="从 npm、Git 或本地路径安装外部插件"
            aria-label="安装插件"
            onClick={() => setInstallOpen(true)}
          >
            <HelmIcon name="download" size={12} />
            <span className="pane-action-label">安装插件</span>
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

      {/* 检索工具栏 */}
      <div className="plugin-center-toolbar">
        <div className="plugin-search-box">
          <HelmIcon name="search" size={14} />
          <input
            type="text"
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
              请尝试调整搜索关键字。
            </div>
            {query && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setQuery('')
                }}
              >
                <HelmIcon name="rotate-ccw" size={12} />
                <span>重置搜索条件</span>
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

      {/* 安装插件轻量模态：npm / git / 本地路径，成功后导航至新插件详情抽屉 */}
      <PluginInstallModal
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        onInstalled={handleInstalled}
        inline={inlineDrawer}
      />
    </div>
  )
}
