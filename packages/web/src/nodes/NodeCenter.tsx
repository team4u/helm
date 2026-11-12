import React, { useMemo, useState } from 'react'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
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
  { key: 'all', label: '全部' },
  { key: 'local', label: '本机' },
  { key: 'remote', label: '远端' },
  { key: 'online', label: '在线' },
  { key: 'offline', label: '离线' },
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

  const selectedNodeId =
    store.primaryTarget?.kind === 'nodes' ? store.primaryTarget.nodeId : undefined

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  )

  const isDrawerOpen = Boolean(selectedNodeId && selectedNode) || isAddingNew

  const handleSelectNode = (nodeId: string) => {
    setIsAddingNew(false)
    store.openTarget({ kind: 'nodes', nodeId })
  }

  const handleCloseDrawer = () => {
    setIsAddingNew(false)
    store.openTarget({ kind: 'nodes' })
  }

  const handleOpenAddNew = () => {
    setIsAddingNew(true)
  }

  return (
    <div className={`primary-center node-center${isSplit ? ' is-split' : ''}`} data-view="node-center">
      {/* 顶栏：标题、副标题、在线与总数统计、接入节点按钮、分屏关闭按钮 */}
      <div className="primary-center-topbar">
        <div className="primary-center-title-wrap">
          <div className="primary-center-title">
            <HelmIcon name="cpu" size={16} />
            <span>计算节点中心</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleOpenAddNew}
            title="接入新的分布式计算节点"
          >
            <HelmIcon name="plus" size={13} />
            <span>接入节点</span>
          </button>

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

      {/* 工具栏：搜索输入框与分类药丸标签 */}
      <div className="primary-center-toolbar">
        <div className="primary-search-box">
          <HelmIcon name="search" size={14} />
          <input
            type="text"
            placeholder="搜索节点 ID、名称、平台架构、版本或操作系统…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索计算节点"
          />
          {query && (
            <button
              type="button"
              className="btn btn-ghost btn-sm primary-search-clear"
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => setQuery('')}
            >
              <HelmIcon name="x" size={12} />
            </button>
          )}
        </div>

        <div className="primary-category-pills" role="tablist" aria-label="计算节点分类筛选">
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

      {/* 内容区：响应式卡片网格或空状态 */}
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
            <div className="primary-center-empty-text">未找到匹配的计算节点</div>
            <div className="primary-center-empty-hint text-subtle">
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

      {/* 右侧滑出式详情与诊断抽屉 */}
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
