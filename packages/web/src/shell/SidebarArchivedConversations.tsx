/**
 * Sidebar "Archived" group (Web host policy, not a plugin sidebar.section):
 *
 * - Shows only human-owned root conversations carrying the host archive tag
 *   (same exposure rule as agent standings: conversations with a parent chain,
 *   bot/helm ownership, or taken over by a plugin section never enter);
 * - Collapsed by default; once expanded, rows are identified by owning agent +
 *   title; single-row restore goes through the inline "more actions" menu
 *   (which automatically offers restore for archived conversations), or use
 *   bulk restore;
 * - Restore uses the existing conversation PATCH (archive-ops); failures
 *   produce explicit notices and are never silently swallowed;
 * - An empty group renders nothing at all — zero visual residue.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Checkbox, HelmIcon } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import type { HelmStoreValue } from '../lib/types.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { Tooltip } from '../ui/Tooltip.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import {
  activeConversationIdsOf,
  buildArchivedConversationList,
  getConversationPresence,
  presenceNavClassSuffix,
} from './sidebar-model.js'
import type { ArchivedConversationListItem } from './sidebar-model.js'
import { archiveBatchNotice, patchConversationsArchived } from './archive-ops.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'
import { ConversationStatusDot, SidebarPaneTag } from './SidebarPrimitives.js'

/** One conversation row in the archived group: leading status light + title + owning-agent badge + actions menu. */
function ArchivedConversationRow({
  item,
  store,
  background,
  onNavigate,
  batchMode,
  selected,
  onToggleSelect,
}: {
  item: ArchivedConversationListItem
  store: HelmStoreValue
  background: ConversationBackgroundIndex
  onNavigate?: () => void
  batchMode?: boolean
  selected?: boolean
  onToggleSelect?: (id: number) => void
}): ReactNode {
  const { t } = useWebLocale()
  const conv = item.conv
  const presence = getConversationPresence(store, conv.id)

  return (
    <div
      className={`nav-item nav-item-sub${presenceNavClassSuffix(presence)}`}
      onClick={() => {
        if (batchMode) onToggleSelect?.(conv.id)
      }}
    >
      {batchMode && (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            className="sidebar-batch-checkbox"
            checked={Boolean(selected)}
            onChange={() => onToggleSelect?.(conv.id)}
          />
        </span>
      )}
      <button
        type="button"
        className="nav-item-main nav-open"
        onClick={(e) => {
          if (batchMode) {
            e.stopPropagation()
            onToggleSelect?.(conv.id)
            return
          }
          store.openTarget({ kind: 'conversation', conversationId: conv.id })
          onNavigate?.()
        }}
        aria-current={presence.active ? 'page' : undefined}
      >
        <span className="nav-status-slot">
          <ConversationStatusDot conv={conv} background={background.get(conv.id)} />
        </span>
        <span className="nav-item-label">{conv.title || t('shell.conversationFallback', { id: conv.id })}</span>
      </button>
      <span className="nav-item-meta">
        <SidebarPaneTag paneTag={presence.paneTag} />
        <span
          className="badge badge-neutral archived-profile-label"
          title={t('shell.archived.owningAgent', { label: item.profileLabel })}
        >
          {item.profileLabel}
        </span>
        <span className="tabular-nums">#{conv.id}</span>
        <span className="nav-item-row-actions">
          <ConversationRowActionsMenu conversation={conv} />
        </span>
      </span>
    </div>
  )
}

/** The "Archived" group: collapsed by default; expanded rows restore individually or in bulk. */
export function ArchivedConversationsGroup({
  background,
  onNavigate,
}: {
  background: ConversationBackgroundIndex
  onNavigate?: () => void
}): ReactNode {
  const store = useHelmStore()
  const { t } = useWebLocale()
  const items = useMemo(
    () =>
      buildArchivedConversationList({
        conversations: store.conversations,
        profiles: store.profiles,
        plugins: store.plugins,
        sidebarSections: store.groupedUi.sidebarSections,
      }),
    [store.conversations, store.profiles, store.plugins, store.groupedUi.sidebarSections],
  )

  const activeConversationIds = activeConversationIdsOf(store)
  const hasActiveArchived = items.some((item) => activeConversationIds.has(item.conv.id))
  const [open, setOpen] = useState(hasActiveArchived)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    if (hasActiveArchived) setOpen(true)
  }, [hasActiveArchived, store.primaryTarget, store.splitTarget])

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isAllSelected = items.length > 0 && items.every((item) => selectedIds.has(item.conv.id))

  /** Bulk restore: per-conversation PATCH + allSettled aggregation (partial
   *  failures never mask successes); single-row restore goes through the inline
   *  "more actions" menu (ConversationRowActionsMenu offers restore for
   *  archived conversations automatically). */
  const executeBatchRestore = async () => {
    if (selectedIds.size === 0 || restoring) return
    setRestoring(true)
    try {
      const convs = items
        .filter((item) => selectedIds.has(item.conv.id))
        .map((item) => item.conv)
      const outcome = await patchConversationsArchived(convs, false)
      store.pushNotice(archiveBatchNotice(false, outcome, t))
      setSelectedIds(new Set())
      setBatchMode(false)
    } finally {
      setRestoring(false)
    }
  }

  if (items.length === 0) return null

  return (
    <div className="sidebar-group archived-conversations-group">
      <div className="sidebar-group-header">
        <button
          type="button"
          className="sidebar-group-header-toggle"
          title={open ? t('shell.archived.collapseGroup') : t('shell.archived.expandGroup')}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            <HelmIcon name="archive" size={12} />
            <span className="nav-item-label">{t('shell.archived.groupTitle')}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span className="badge badge-neutral tabular-nums">{items.length}</span>
            <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </span>
        </button>
        {open && (
          <Tooltip content={batchMode ? t('shell.archived.exitBulkRestore') : t('shell.archived.bulkRestore')} side="top">
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs"
              style={{ color: batchMode ? 'var(--accent)' : undefined }}
              title={batchMode ? t('shell.archived.exitBulkRestore') : t('shell.archived.bulkRestore')}
              aria-label={batchMode ? t('shell.archived.exitBulkRestore') : t('shell.archived.bulkRestore')}
              onClick={() => {
                setBatchMode((v) => {
                  if (v) setSelectedIds(new Set())
                  return !v
                })
              }}
            >
              <HelmIcon name="check-square" size={12} />
            </button>
          </Tooltip>
        )}
      </div>
      {open && batchMode && (
        <div className="sidebar-batch-bar">
          <div className="sidebar-batch-bar-header">
            <span style={{ fontWeight: 500, color: 'var(--fg-secondary)' }}>
              {t('shell.batch.selected', { count: selectedIds.size })}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setBatchMode(false)
                setSelectedIds(new Set())
              }}
              title={t('shell.archived.exitBulkRestore')}
            >
              {t('shell.batch.exit')}
            </button>
          </div>
          <div className="sidebar-batch-bar-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={items.length === 0 || restoring}
              onClick={() => {
                setSelectedIds(isAllSelected ? new Set() : new Set(items.map((item) => item.conv.id)))
              }}
            >
              {isAllSelected ? t('shell.batch.clear') : t('shell.batch.selectAll')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={selectedIds.size === 0 || restoring}
              onClick={() => void executeBatchRestore()}
            >
              {restoring ? t('shell.archived.restoring') : t('shell.archived.restoreCount', { count: selectedIds.size })}
            </button>
          </div>
        </div>
      )}
      {open &&
        items.map((item) => (
          <ArchivedConversationRow
            key={item.conv.id}
            item={item}
            store={store}
            background={background}
            onNavigate={onNavigate}
            batchMode={batchMode}
            selected={selectedIds.has(item.conv.id)}
            onToggleSelect={toggleSelect}
          />
        ))}
    </div>
  )
}
