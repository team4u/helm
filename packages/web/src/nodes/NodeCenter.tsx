import React, { useMemo, useState } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'
import { useLocationTargets, useNodes, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { WebMessageKey } from '../i18n/catalog.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { NodeCard } from './NodeCard.js'
import { NodeDetailDrawer } from './NodeDetailDrawer.js'
import {
  buildNodeCategoryCounts,
  filterNodes,
  type NodeCategoryTab,
  type NodeInfo,
} from './node-center-model.js'

export interface NodeCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** Render the detail drawer inline (uniform assertions for tests and SSR). */
  inlineDrawer?: boolean
}

/**
 * Category pills as pure data: labels resolve through the active-locale
 * translator at render time (constant-table labels are never localized in
 * place). Shared exact-fit copy (all/online/offline) reuses `common.*`.
 */
const CATEGORY_TABS: ReadonlyArray<{ key: NodeCategoryTab; labelKey: WebMessageKey }> = [
  { key: 'all', labelKey: 'common.all' },
  { key: 'local', labelKey: 'nodes.local' },
  { key: 'remote', labelKey: 'nodes.remote' },
  { key: 'online', labelKey: 'common.online' },
  { key: 'offline', labelKey: 'common.offline' },
]

/**
 * Full-screen Compute Nodes Center primary view container:
 * - a system-level full-stage view managing local and distributed compute nodes;
 * - top toolbar: multi-dimensional search box, category pill tabs and status
 *   count badges;
 * - responsive card grid consuming NodeCard in an adaptive flow;
 * - details & diagnostics drawer: the right-side NodeDetailDrawer with node
 *   health checks, enrollment commands and capability lists;
 * - state loop: deeply integrated with the useHelmxStore() primaryTarget state
 *   and the URL hash;
 * - strictly zero Emoji and Fast Refresh compliant.
 */
export function NodeCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: NodeCenterProps): React.JSX.Element {
  const nodes = (useNodes() as NodeInfo[]) ?? []
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { openTarget, closeSplit, refreshNodes } = useStoreActions()
  const { t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<NodeCategoryTab>('all')
  const [isAddingNew, setIsAddingNew] = useState(false)

  const categoryCounts = useMemo(() => buildNodeCategoryCounts(nodes), [nodes])

  const filteredNodes = useMemo(() => {
    return filterNodes(nodes, {
      query,
      categoryTab: activeTab,
    })
  }, [nodes, query, activeTab])

  const currentTarget = isSplit ? splitTarget : primaryTarget
  const selectedNodeId =
    currentTarget?.kind === 'nodes' ? currentTarget.nodeId : undefined

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  )

  const isDrawerOpen = Boolean(selectedNodeId && selectedNode) || isAddingNew

  const handleSelectNode = (nodeId: string) => {
    setIsAddingNew(false)
    openTarget({ kind: 'nodes', nodeId }, isSplit ? { split: true } : undefined)
  }

  const handleCloseDrawer = () => {
    setIsAddingNew(false)
    openTarget({ kind: 'nodes' }, isSplit ? { split: true } : undefined)
  }

  const handleOpenAddNew = () => {
    setIsAddingNew(true)
  }

  const toggleSplit = () => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (splitTarget !== null) {
      closeSplit()
      return
    }
    openTarget({ kind: 'nodes', nodeId: selectedNodeId }, { split: true })
  }

  return (
    <div className={`primary-center node-center${isSplit ? ' is-split' : ''}`} data-view="node-center">
      {/* Top bar: title and actions */}
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmxIcon name="cpu" size={14} />
            <span>{t('nodes.title')}</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions pane-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleOpenAddNew}
            title={t('nodes.connectTitle')}
          >
            <HelmxIcon name="plus" size={12} />
            <span className="pane-action-label">{t('nodes.connect')}</span>
          </button>
          {isSplit ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton
              isSplitActive={splitTarget !== null}
              onToggleSplit={toggleSplit}
            />
          )}
        </div>
      </div>

      {/* Toolbar: search input and category pills */}
      <div className="primary-center-toolbar">
        <div className="primary-search-box">
          <HelmxIcon name="search" size={14} />
          <input
            type="text"
            placeholder={t('nodes.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('nodes.searchAria')}
          />
          {query && (
            <button
              type="button"
              className="btn btn-ghost btn-sm primary-search-clear"
              title={t('nodes.searchClear')}
              aria-label={t('nodes.searchClear')}
              onClick={() => setQuery('')}
            >
              <HelmxIcon name="x" size={12} />
            </button>
          )}
        </div>

        <div className="primary-category-pills" role="tablist" aria-label={t('nodes.filterAria')}>
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
                <span className="primary-category-pill-label">{t(tab.labelKey)}</span>
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
              <HelmxIcon name="search" size={28} />
            </div>
            <div className="primary-center-empty-text">{t('nodes.emptyTitle')}</div>
            <div className="primary-center-empty-hint text-subtle">
              {t('nodes.emptyHint')}
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
                <HelmxIcon name="rotate-ccw" size={12} />
                <span>{t('nodes.resetFilters')}</span>
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
        onRefresh={refreshNodes}
        inline={inlineDrawer}
      />
    </div>
  )
}
