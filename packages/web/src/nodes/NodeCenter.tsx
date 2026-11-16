import React, { useMemo, useState } from 'react'
import { HelmIcon } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { NodeCard } from './NodeCard.js'
import { NodeDetailDrawer } from './NodeDetailDrawer.js'
import {
  buildNodeCategoryCounts,
  filterNodes,
  summarizeNodes,
  type NodeCategoryTab,
  type NodeInfo,
} from './node-center-model.js'

export interface NodeCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** 显式指定详情抽屉是否内联渲染（便于测试与 SSR 统一断言） */
  inlineDrawer?: boolean
}

const CATEGORY_TABS: Array<{ key: NodeCategoryTab; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'local', label: 'Local' },
  { key: 'remote', label: 'Remote' },
  { key: 'online', label: 'Online' },
  { key: 'offline', label: 'Offline' },
]

/**
 * 全屏计算节点中心（NodeCenter）主视图容器：
 * - 升格为系统一级主舞台全屏视图，统一管理本机与分布式计算节点；
 * - 顶部工具栏：多维检索搜索框、分类药丸标签栏与各状态数量统计徽章；
 * - 响应式卡片网格：消费 NodeCard 自适应流式呈现；
 * - 详情与诊断抽屉：右侧联动滑出 NodeDetailDrawer，支持节点健康体检、接入指令与能力清单；
 * - 状态闭环：深度联动 useHelmStore() primaryTarget 状态与 URL Hash；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function NodeCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: NodeCenterProps): React.JSX.Element {
  const store = useHelmStore()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<NodeCategoryTab>('all')
  const [isAddingNew, setIsAddingNew] = useState(false)

  const nodes: NodeInfo[] = (store.nodes as NodeInfo[]) ?? []
  const categoryCounts = useMemo(() => buildNodeCategoryCounts(nodes), [nodes])

  const filteredNodes = useMemo(() => {
    return filterNodes(nodes, {
      query,
      categoryTab: activeTab,
    })
  }, [nodes, query, activeTab])

  const currentTarget = isSplit ? store.splitTarget : store.primaryTarget
  const selectedNodeId =
    currentTarget?.kind === 'nodes' ? currentTarget.nodeId : undefined

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  )

  const isDrawerOpen = Boolean(selectedNodeId && selectedNode) || isAddingNew

  const handleSelectNode = (nodeId: string) => {
    setIsAddingNew(false)
    store.openTarget({ kind: 'nodes', nodeId }, isSplit ? { split: true } : undefined)
  }

  const handleCloseDrawer = () => {
    setIsAddingNew(false)
    store.openTarget({ kind: 'nodes' }, isSplit ? { split: true } : undefined)
  }

  const handleOpenAddNew = () => {
    setIsAddingNew(true)
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
    store.openTarget({ kind: 'nodes', nodeId: selectedNodeId }, { split: true })
  }

  return (
    <div className={`primary-center node-center${isSplit ? ' is-split' : ''}`} data-view="node-center">
      {/* Top bar: title and actions */}
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmIcon name="cpu" size={14} />
            <span>Compute Nodes Center</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions pane-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleOpenAddNew}
            title="Connect new distributed compute nodes"
          >
            <HelmIcon name="plus" size={12} />
            <span className="pane-action-label">Connect node</span>
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

      {/* Toolbar: search input and category pills */}
      <div className="primary-center-toolbar">
        <div className="primary-search-box">
          <HelmIcon name="search" size={14} />
          <input
            type="text"
            placeholder="Search node ID, name, platform, version or OS…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search compute nodes"
          />
          {query && (
            <button
              type="button"
              className="btn btn-ghost btn-sm primary-search-clear"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              <HelmIcon name="x" size={12} />
            </button>
          )}
        </div>

        <div className="primary-category-pills" role="tablist" aria-label="Filter by compute node category">
          {CATEGORY_TABS.map((tab) => {
            const count = categoryCounts[tab.key] ?? 0
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`primary-category-pill${isActive ? ' is-active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span className="primary-category-pill-label">{tab.label}</span>
                <span className="badge tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Content: responsive card grid or empty state */}
      <div className="primary-center-content">
        {filteredNodes.length > 0 ? (
          <div className="primary-center-grid">
            {filteredNodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                selected={selectedNodeId === node.id}
                onSelect={() => handleSelectNode(node.id)}
              />
            ))}
          </div>
        ) : (
          <div className="primary-center-empty">
            <div className="primary-center-empty-icon">
              <HelmIcon name="search" size={28} />
            </div>
            <div className="primary-center-empty-text">No matching compute nodes</div>
            <div className="primary-center-empty-hint text-subtle">
              Try adjusting the search keywords or switching category tabs.
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
                <span>Reset filters</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right slide-over details and diagnostics drawer */}
      <NodeDetailDrawer
        node={isAddingNew ? null : selectedNode}
        open={isDrawerOpen}
        isNew={isAddingNew}
        onClose={handleCloseDrawer}
        onRefresh={store.refreshNodes}
        inline={inlineDrawer}
      />
    </div>
  )
}
