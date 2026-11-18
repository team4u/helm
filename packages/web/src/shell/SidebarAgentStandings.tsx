import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { conversationsApi } from '../lib/api.js'
import type { ConversationSummary } from '@helm/protocol/browser'
import { archiveBatchNotice, patchConversationsArchived } from './archive-ops.js'
import { HelmIcon, Checkbox } from '@helm/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { Tooltip } from '../ui/Tooltip.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import { ConfirmDialog } from '../ui/AlertDialog.js'
import {
  AGENT_SUB_LIST_PREVIEW,
  activeConversationIdsOf,
  activeProfileIdsOf,
  buildAgentStandings,
  filterAgentStandings,
  filterDeletableConversations,
  getAgentStandbyPresence,
  getConversationPresence,
  isConversationDeletable,
  openAgentStandby,
  presenceNavClassSuffix,
  shouldSkipNavRowClick,
  type AgentStanding,
  type SidebarStoreView,
} from './sidebar-model.js'
import {
  resolveStandingStatusIndicator,
  resolveStatusLight,
  resolveAgentSubListPreview,
  type ConversationBackgroundActivity,
  type ConversationBackgroundIndex,
} from './background-activity-model.js'
import {
  ConversationStatusDot,
  RemoteNodeTag,
  SidebarPaneTag,
  StandingStatusDot,
} from './SidebarPrimitives.js'

/** The agent standing's "+" button: enter the standby page to start a new topic
 * (the conversation is only created on first send); rendered for human-selectable agents only. */
function AgentNewConversationButton({
  agent,
  onCreate,
}: {
  agent: AgentStanding
  onCreate: (profileId: string) => void
}) {
  const { t } = useWebLocale()
  if (!agent.canCreateConversation) return null
  const newTopicLabel = t('shell.agents.newTopicUnder', { label: agent.label })
  return (
    <Tooltip content={newTopicLabel} side="right">
      <button
        type="button"
        className="btn btn-ghost btn-icon-xs agent-new-conv-btn"
        title={newTopicLabel}
        aria-label={newTopicLabel}
        onClick={(e) => {
          e.stopPropagation()
          onCreate(agent.profileId)
        }}
      >
        <HelmIcon name="plus" size={13} />
      </button>
    </Tooltip>
  )
}

/**
 * Agent standing row (level one, auto-expands by main/split target and filter
 * state, no fold button):
 * - Normal mode: standby lights the parent row, entering a conversation lights
 *   only the child row (the parent shows a weak branch-affinity state),
 *   clicking the name enters standby;
 * - Batch mode: clicking the row or name toggles the sub-list expansion, which
 *   renders a flat conversation list for checkbox deletion.
 */
function AgentStandingItem({
  agent,
  store,
  background,
  activeProfileIds,
  activeConversationIds,
  searching,
  onCreate,
  onNavigate,
  batchMode,
  selectedIds,
  onToggleSelect,
}: {
  agent: AgentStanding
  store: SidebarStoreView
  background: ConversationBackgroundIndex
  activeProfileIds: ReadonlySet<string>
  activeConversationIds: ReadonlySet<number>
  searching: boolean
  onCreate: (profileId: string) => void
  onNavigate?: () => void
  batchMode?: boolean
  selectedIds?: Set<number>
  onToggleSelect?: (id: number) => void
}) {
  // Batch mode: whenever the agent has conversations (length > 0), expand the
  // sub-list to show conversation rows for checkbox deletion; the bot's main
  // standing row always represents the profile itself and never carries a
  // checkbox, so users cannot accidentally select a bot.
  const hasSubList = agent.conversations.length > 0
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)

  const standbyPresence = getAgentStandbyPresence(store, agent.profileId)
  const hasActiveChild = agent.conversations.some((c) => {
    const p = getConversationPresence(store, c.id)
    return p.inPrimary || p.inSplit
  })
  // Weak branch-affinity state: when a child conversation is open in the
  // main/split view and the parent standing is not in standby, only brighten
  // the bold text — never steal the child row's highlight.
  const isBranchActive = !standbyPresence.active && !standbyPresence.splitSecondary && hasActiveChild
  // Collapsed standing indicator: aggregates every conversation under the agent
  // (base-status priority + background in-flight), not just primaryConversation —
  // non-primary conversations with active background work surface too.
  const standingIndicator = useMemo(
    () => resolveStandingStatusIndicator(agent.conversations, background),
    [agent.conversations, background],
  )
  // No fold button: expansion derives from the filter state or the current
  // main/split targets (supporting collaborative expansion of two split agents).
  const isOpen = batchMode
    ? hasSubList && expanded
    : hasSubList && (searching || activeProfileIds.has(agent.profileId))
  const hasStandingLight =
    !isOpen &&
    standingIndicator !== null &&
    resolveStatusLight(standingIndicator.representative.status, standingIndicator.backgroundActive).dotClass !== null

  const openPrimary = (keepDrawerOpen: boolean) => {
    if (batchMode) {
      if (hasSubList) setExpanded((v) => !v)
      return
    }
    const navigateCallback = keepDrawerOpen ? undefined : onNavigate
    // The name is the stable standby entry: human-selectable agents always
    // enter standby (the conversation is only persisted on first send) and
    // never auto-jump into an old conversation; only managed singletons
    // without create rights open their real conversation.
    if (agent.canCreateConversation) {
      openAgentStandby(store, agent.profileId, navigateCallback)
      return
    }
    const primary = agent.primaryConversation
    if (primary) {
      store.openTarget({ kind: 'conversation', conversationId: primary.id })
      navigateCallback?.()
    }
  }

  // Collapsed standing rows with a conversation sub-list expand in place on first
  // tap so mobile drawer users can inspect and choose from the revealed topics.
  const keepDrawerOpenOnExpand = !batchMode && !isOpen && hasSubList
  const canOpenStanding = batchMode || agent.primaryConversation !== null || agent.canCreateConversation

  const handleStandingActivate = (e: MouseEvent): void => {
    if (batchMode) {
      e.stopPropagation()
      if (hasSubList) setExpanded((v) => !v)
      return
    }
    if (!canOpenStanding) return
    if (keepDrawerOpenOnExpand) {
      e.stopPropagation()
    }
    openPrimary(keepDrawerOpenOnExpand)
  }

  return (
    <div className={`agent-standing${isOpen ? ' agent-standing-open' : ''}`}>
      <div
        className={`nav-item agent-standing-row${presenceNavClassSuffix(standbyPresence)}${isBranchActive ? ' agent-standing-row-branch' : ''}`}
        onClick={(e) => {
          if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
          handleStandingActivate(e)
        }}
      >
        <button
          type="button"
          className="nav-item-main nav-open"
          onClick={handleStandingActivate}
          disabled={!canOpenStanding}
          aria-current={standbyPresence.active ? 'page' : undefined}
        >
          <span className="nav-status-slot">
            {hasStandingLight && standingIndicator !== null ? (
              <StandingStatusDot indicator={standingIndicator} />
            ) : (
              <HelmIcon
                name={isOpen ? 'chevron-down' : hasSubList ? 'chevron-right' : 'bot'}
                size={12}
                className="agent-standing-chevron"
              />
            )}
          </span>
          <span className="nav-item-label">{agent.label}</span>
        </button>
        <span className="nav-item-meta">
          {!isOpen && agent.primaryConversation?.nodeId && agent.primaryConversation.nodeId !== 'local' && (
            <RemoteNodeTag nodeId={agent.primaryConversation.nodeId} />
          )}
          {agent.conversations.length > 1 && (
            <span className="agent-standing-count tabular-nums">{agent.conversations.length}</span>
          )}
          <SidebarPaneTag paneTag={standbyPresence.paneTag} />
          {!batchMode && (
            <AgentNewConversationButton agent={agent} onCreate={onCreate} />
          )}
        </span>
      </div>
      {isOpen && (
        <AgentConversationsList
          agent={agent}
          store={store}
          background={background}
          activeConversationIds={activeConversationIds}
          searching={searching}
          showAll={showAll}
          onToggleShowAll={() => setShowAll((v) => !v)}
          batchMode={batchMode}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
        />
      )}
    </div>
  )
}

/** Flat conversation list under an agent: first 5 by default, expandable
 * beyond that; searched or split-present conversations are never hidden by folding. */
function AgentConversationsList({
  agent,
  store,
  background,
  activeConversationIds,
  searching,
  showAll,
  onToggleShowAll,
  batchMode,
  selectedIds,
  onToggleSelect,
}: {
  agent: AgentStanding
  store: SidebarStoreView
  background: ConversationBackgroundIndex
  activeConversationIds: ReadonlySet<number>
  searching: boolean
  showAll: boolean
  onToggleShowAll: () => void
  batchMode?: boolean
  selectedIds?: Set<number>
  onToggleSelect?: (id: number) => void
}) {
  const { t } = useWebLocale()
  const convs = agent.conversations
  const primaryActiveId = convs.find((c) => getConversationPresence(store, c.id).active)?.id ?? null
  // Collapsed-preview slice (pure function): first 5 by default, but active /
  // split / working / blocked / background in-flight / search-hit conversations
  // never disappear behind the fold; archived conversations were already
  // filtered upstream by buildAgentStandings and cannot appear here.
  const { visible, hiddenCount } = resolveAgentSubListPreview({
    conversations: convs,
    showAll: showAll || searching,
    activeId: primaryActiveId,
    activeIds: activeConversationIds,
    background,
  })
  const hidden = hiddenCount

  return (
    <div className="agent-conversations-list">
      {visible.map((conv) => (
        <AgentConversationRow
          key={conv.id}
          conv={conv}
          store={store}
          background={background.get(conv.id)}
          batchMode={batchMode}
          selected={selectedIds?.has(conv.id)}
          onToggleSelect={onToggleSelect}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-sm agent-list-toggle"
          onClick={onToggleShowAll}
        >
          {t('shell.agents.showMore', { count: hidden })}
        </button>
      )}
      {hidden === 0 && !searching && showAll && convs.length > AGENT_SUB_LIST_PREVIEW && (
        <button
          type="button"
          className="btn btn-ghost btn-sm agent-list-toggle"
          onClick={onToggleShowAll}
        >
          {t('common.collapse')}
        </button>
      )}
    </div>
  )
}

/** One historical conversation row under an agent (indented rendering + checkbox in batch mode).
 * The status light sits in the fixed leading slot; the split entry converges
 * into the conversation detail top bar — conversation rows carry no split button. */
function AgentConversationRow({
  conv,
  store,
  background,
  batchMode,
  selected,
  onToggleSelect,
}: {
  conv: ConversationSummary
  store: SidebarStoreView
  background?: ConversationBackgroundActivity
  batchMode?: boolean
  selected?: boolean
  onToggleSelect?: (id: number) => void
}) {
  const { t } = useWebLocale()
  const presence = getConversationPresence(store, conv.id)
  const deletable = isConversationDeletable(conv)

  const handleRowActivate = (e: MouseEvent): void => {
    if (batchMode) {
      e.stopPropagation()
      if (deletable) onToggleSelect?.(conv.id)
      return
    }
    store.openTarget({ kind: 'conversation', conversationId: conv.id })
  }

  return (
    <div
      className={`nav-item nav-item-sub${presenceNavClassSuffix(presence)}`}
      onClick={(e) => {
        if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
        handleRowActivate(e)
      }}
    >
      {batchMode && (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            className="sidebar-batch-checkbox"
            checked={Boolean(selected)}
            disabled={!deletable}
            title={deletable ? undefined : t('shell.agents.protectedTitle')}
            onChange={() => {
              if (deletable) onToggleSelect?.(conv.id)
            }}
          />
        </span>
      )}
      <button
        type="button"
        className="nav-item-main nav-open"
        onClick={handleRowActivate}
        aria-current={presence.active ? 'page' : undefined}
      >
        <span className="nav-status-slot">
          <ConversationStatusDot conv={conv} background={background} />
        </span>
        <span className="nav-item-label">{conv.title || t('shell.conversationFallback', { id: conv.id })}</span>
      </button>
      <span className="nav-item-meta">
        <span className="tabular-nums">#{conv.id}</span>
        {conv.nodeId && conv.nodeId !== 'local' && <RemoteNodeTag nodeId={conv.nodeId} />}
        <SidebarPaneTag paneTag={presence.paneTag} />
        {!batchMode && (
          <span className="nav-item-row-actions">
            <ConversationRowActionsMenu conversation={conv} />
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * The "Agents" group (single expansion, no fold button):
 * - All visible agents tile stably (only the one owning the current target
 *   expands to show its topic sub-list);
 * - Batch management expands the flat conversation list for checkbox deletion.
 */
export function AgentStandingsGroup({
  store,
  background,
  onNavigate,
}: {
  store: SidebarStoreView
  background: ConversationBackgroundIndex
  onNavigate?: () => void
}) {
  const { t } = useWebLocale()
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const filterOpen = searchOpen || search !== ''
  const searching = search.trim() !== ''

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
    }
  }, [searchOpen])

  const activeProfileIds = useMemo(
    () => activeProfileIdsOf(store),
    [store.primaryTarget, store.splitTarget, store.conversations],
  )
  const activeConversationIds = useMemo(
    () => activeConversationIdsOf(store),
    [store.primaryTarget, store.splitTarget],
  )

  const agentStandings = useMemo(
    () =>
      buildAgentStandings({
        profiles: store.profiles,
        conversations: store.conversations,
        plugins: store.plugins,
        sidebarItems: store.groupedUi.sidebarItems,
        sidebarSections: store.groupedUi.sidebarSections,
        locale: store.locale,
      }),
    [store.profiles, store.conversations, store.plugins, store.groupedUi.sidebarItems, store.groupedUi.sidebarSections, store.locale],
  )

  const visibleStandings = useMemo(
    () => filterAgentStandings(agentStandings, search),
    [agentStandings, search],
  )
  const openStandby = useCallback(
    (profileId: string) => openAgentStandby(store, profileId, onNavigate),
    [store, onNavigate],
  )

  const allDeletableIds = useMemo(() => {
    const allConvs = agentStandings.flatMap((a) => a.conversations)
    return filterDeletableConversations(allConvs).map((c) => c.id)
  }, [agentStandings])

  const isAllSelected = allDeletableIds.length > 0 && allDeletableIds.every((id) => selectedIds.has(id))

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  /**
   * Batch archive: per-conversation PATCH of the host archive tag + allSettled
   * aggregation (partial failures never mask successes); archiving does not
   * delete the conversation and the current target stays valid — the list
   * updates purely via conversation.upsert. Unlike deletion's SSE fallback
   * pipeline, no navigation happens here.
   */
  const executeBatchArchive = async () => {
    if (selectedIds.size === 0 || archiving || deleting) return
    setArchiving(true)
    try {
      const convs = agentStandings
        .flatMap((agent) => agent.conversations)
        .filter((conversation) => selectedIds.has(conversation.id))
      const outcome = await patchConversationsArchived(convs, true)
      store.pushNotice(archiveBatchNotice(true, outcome, t))
      setSelectedIds(new Set())
      setBatchMode(false)
    } finally {
      setArchiving(false)
    }
  }

  const executeBatchDelete = async () => {
    const count = selectedIds.size
    if (count === 0 || deleting) return
    setBatchDeleteConfirmOpen(false)
    setDeleting(true)
    try {
      const ids = Array.from(selectedIds)
      const results = await Promise.allSettled(ids.map((id) => conversationsApi.remove(id)))
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length
      const rejected = results.filter((r) => r.status === 'rejected').length

      if (rejected === 0) {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: t('shell.batch.bulkDeleteCompleted'),
          body: t('shell.batch.bulkDeleteCompletedBody', { count: fulfilled }),
        })
      } else if (fulfilled === 0) {
        store.pushNotice({
          type: 'notification',
          level: 'error',
          title: t('shell.batch.bulkDeleteFailed'),
          body: t('shell.batch.bulkDeleteFailedBody', { count: rejected }),
        })
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('shell.batch.bulkDeletePartial'),
          body: t('shell.batch.bulkDeletePartialBody', { fulfilled, rejected }),
        })
      }

      // No navigation here: rely solely on each successful deletion's
      // conversation.deleted SSE event; the Provider conditionally falls back
      // by current targets (avoiding stale-snapshot/selectedIds double jumps
      // that would hurt failed items and fresh navigations).

      setSelectedIds(new Set())
      setBatchMode(false)
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: t('shell.batch.bulkDeleteError'),
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="sidebar-group agent-standing-group">
      <div className="sidebar-group-header">
        <span>{t('shell.agents.groupTitle')}</span>
        <div className="sidebar-group-header-actions">
          <Tooltip content={filterOpen ? t('shell.agents.collapseFilters') : t('shell.agents.filter')} side="top">
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs"
              style={{
                color: filterOpen ? 'var(--accent)' : undefined,
              }}
              title={filterOpen ? t('shell.agents.collapseFilters') : t('shell.agents.filter')}
              aria-label={t('shell.agents.filter')}
              aria-pressed={filterOpen}
              onClick={() => {
                if (filterOpen) {
                  setSearch('')
                  setSearchOpen(false)
                } else {
                  setSearchOpen(true)
                }
              }}
            >
              <HelmIcon name="list-filter" size={12} />
            </button>
          </Tooltip>
          <Tooltip content={batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')} side="top">
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs"
              style={{
                color: batchMode ? 'var(--accent)' : undefined,
              }}
              title={batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')}
              aria-label={batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')}
              onClick={() => {
                setBatchMode((v) => {
                  if (v) {
                    setSelectedIds(new Set())
                  }
                  return !v
                })
              }}
            >
              <HelmIcon name="check-square" size={12} />
            </button>
          </Tooltip>
        </div>
      </div>
      {filterOpen && (
        <div className="sidebar-search">
          <HelmIcon name="search" size={12} />
          <input
            ref={searchInputRef}
            type="text"
            className="sidebar-search-input"
            value={search}
            placeholder={t('shell.agents.filterPlaceholder')}
            aria-label={t('shell.agents.filter')}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                if (search !== '') setSearch('')
                else setSearchOpen(false)
              }
            }}
          />
          {search !== '' && (
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs sidebar-search-clear"
              title={t('shell.agents.clearFilter')}
              aria-label={t('shell.agents.clearFilter')}
              onClick={() => {
                setSearch('')
                searchInputRef.current?.focus()
              }}
            >
              <HelmIcon name="x" size={11} />
            </button>
          )}
        </div>
      )}
      {batchMode && (
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
              title={t('shell.agents.exitBulk')}
            >
              {t('shell.batch.exit')}
            </button>
          </div>
          <div className="sidebar-batch-bar-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={allDeletableIds.length === 0 || deleting}
              onClick={() => {
                if (isAllSelected) {
                  setSelectedIds(new Set())
                } else {
                  setSelectedIds(new Set(allDeletableIds))
                }
              }}
            >
              {isAllSelected ? t('shell.batch.clear') : t('shell.batch.selectAll')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={selectedIds.size === 0 || deleting || archiving}
              onClick={() => void executeBatchArchive()}
            >
              {archiving ? t('shell.agents.archiving') : t('shell.agents.archiveCount', { count: selectedIds.size })}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger-sm"
              disabled={selectedIds.size === 0 || deleting || archiving}
              onClick={() => setBatchDeleteConfirmOpen(true)}
            >
              {deleting ? t('shell.batch.deleting') : t('shell.batch.deleteCount', { count: selectedIds.size })}
            </button>
          </div>
        </div>
      )}
      {visibleStandings.length === 0 ? (
        <div className="sidebar-search-empty">{t('shell.agents.noMatch')}</div>
      ) : (
        visibleStandings.map((agent) => (
          <AgentStandingItem
            key={agent.profileId}
            agent={agent}
            store={store}
            background={background}
            activeProfileIds={activeProfileIds}
            activeConversationIds={activeConversationIds}
            searching={searching}
            onCreate={openStandby}
            onNavigate={onNavigate}
            batchMode={batchMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
          />
        ))
      )}
      <ConfirmDialog
        open={batchDeleteConfirmOpen}
        onOpenChange={setBatchDeleteConfirmOpen}
        title={t('shell.batch.deleteConfirmTitle', { count: selectedIds.size })}
        description={t('shell.batch.deleteConfirmDesc')}
        confirmText={t('shell.batch.deleteConfirmButton')}
        danger
        onConfirm={() => {
          void executeBatchDelete()
        }}
        onCancel={() => setBatchDeleteConfirmOpen(false)}
      />
    </div>
  )
}
