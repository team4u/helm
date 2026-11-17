/**
 * builtin:herdr plugin client.tsx components (component exports only, Fast
 * Refresh contract):
 * - HerdrOverviewScreen: Herdr terminal overview fullscreen view (desktop
 *   table + <=680px two-line adaptive cards).
 *
 * Ownership red line (AGENTS.md §3):
 * - Terminal panes with ownedBy === 'human' only allow read-only diagnostics
 *   and status display; never render focus, snapshot, send-keys or abort
 *   controls for them.
 * - Only panes with ownedBy === 'helm' expose the linked conversation, focus
 *   and read-only snapshot entries.
 *
 * Display copy resolves from copy.ts against the active host locale (no
 * independent language state, no localStorage); backend error messages pass
 * through unchanged.
 */
import { useMemo, useState } from 'react'
import './styles.css'
import type { CSSProperties, ReactNode } from 'react'
import type { ScreenProps } from '@helm/protocol'
import {
  Callout,
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  StatusLight,
  formatCompactTimestamp,
  Select,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
} from '@helm/plugin-client'
import {
  agentStatusTone,
  canFocusPane,
  canSnapshotPane,
  collectNodes,
  computeStats,
  filterPanes,
  filtersToParamsPatch,
  isHumanOwnedPane,
  paneCwdText,
  paneLocationText,
  paneRowKey,
  parseFilters,
  parseManagedMap,
  parseReadText,
  type OverviewDoc,
  type OverviewPaneRow,
} from './models.ts'
import {
  HDR_ACTION_FOCUS,
  HDR_ACTION_OPEN_LINKED,
  HDR_ACTION_SNAPSHOT,
  HDR_ASKS_TITLE,
  HDR_BADGE_FOCUSED,
  HDR_BADGE_PENDING_ASK,
  HDR_CLOSE,
  HDR_COL_ACTIONS,
  HDR_COL_CWD,
  HDR_COL_LOCATION,
  HDR_COL_NODE,
  HDR_COL_OUTCOME,
  HDR_COL_OWNER,
  HDR_COL_PANE,
  HDR_COL_STATUS,
  HDR_FILTER_NODE_ARIA,
  HDR_FILTER_OWNER_ARIA,
  HDR_FILTER_STATUS_ARIA,
  HDR_LINK_REFRESH_HINT,
  HDR_LOADING_DOC,
  HDR_NO_MATCH,
  HDR_PANE_LIST_ARIA,
  HDR_READ_ONLY,
  HDR_READ_ONLY_TITLE,
  HDR_REFETCH,
  HDR_REFRESH_LINKS,
  HDR_SNAPSHOT_ARIA,
  HDR_STAT_BLOCKED,
  HDR_STAT_NODES,
  HDR_STAT_PANES,
  HDR_STAT_WORKING,
  herdrActionFailed,
  herdrConversationTitle,
  herdrDegradedNotice,
  herdrNodeFilterOptions,
  herdrOutcomeLabel,
  herdrOwnerFilterOptions,
  herdrRowCount,
  herdrSnapshotTitle,
  herdrStatusFilterOptions,
} from './copy.ts'
import {
  Check,
  ChevronDown,
  Circle,
  Loader2,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Terminal,
  X,
} from 'lucide-react'

function Icon({
  name,
  size = 12,
  className,
  style,
}: {
  name: string
  size?: number
  className?: string
  style?: CSSProperties
}): ReactNode {
  const map: Record<string, typeof Terminal> = {
    check: Check,
    circle: Circle,
    'chevron-down': ChevronDown,
    loader: Loader2,
    'message-square': MessageSquare,
    'refresh-cw': RefreshCw,
    'rotate-ccw': RotateCcw,
    terminal: Terminal,
    x: X,
  }
  const Cmp = map[name] ?? Circle
  return <Cmp size={size} strokeWidth={1.75} className={className} style={style} />
}

/** Host Radix Select filter (reuses the @helm/plugin-client shared primitive; zero native <select>). */
function FilterSelect({
  value,
  options,
  ariaLabel,
  onChange,
}: {
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  ariaLabel: string
  onChange: (next: string) => void
}): ReactNode {
  return (
    <Select
      size="sm"
      className="herdr-filter-select"
      value={value}
      options={options}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function HerdrOverviewScreen(props: ScreenProps): ReactNode {
  const { isSplit, params, setParams } = props
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const doc = usePluginDoc<OverviewDoc>('overview')

  const filters = useMemo(() => parseFilters(params), [params])
  const [busyPane, setBusyPane] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<{ title: string; text: string } | null>(null)
  const [managedMap, setManagedMap] = useState<Record<string, number>>({})

  const panes = doc?.panes ?? []
  const nodes = useMemo(() => collectNodes(panes), [panes])
  const nodeFilterOptions = useMemo(
    () => herdrNodeFilterOptions(nodes, locale),
    [nodes, locale],
  )
  const ownerFilterOptions = useMemo(() => herdrOwnerFilterOptions(locale), [locale])
  const statusFilterOptions = useMemo(() => herdrStatusFilterOptions(locale), [locale])

  const filtered = useMemo(() => filterPanes(panes, filters), [panes, filters])
  const stats = useMemo(() => computeStats(panes, nodes), [panes, nodes])

  const updateFilter = (key: 'node' | 'owner' | 'status', next: string) => {
    setParams(filtersToParamsPatch({ ...filters, [key]: next }))
  }

  const invokeWithGuard = async (paneKey: string, fn: () => Promise<void>) => {
    if (busyPane !== null) return
    setBusyPane(paneKey)
    try {
      await fn()
    } catch (error) {
      ctx.notify(
        herdrActionFailed(error instanceof Error ? error.message : String(error), locale),
        'error',
      )
    } finally {
      setBusyPane(null)
    }
  }

  const focusPane = (row: OverviewPaneRow) => {
    if (isHumanOwnedPane(row)) return
    return invokeWithGuard(`focus:${paneRowKey(row)}`, async () => {
      await ctx.callAction('focus', {
        paneId: row.paneId,
        ...(row.nodeId !== 'local' ? { nodeId: row.nodeId } : {}),
      })
    })
  }

  const readPane = (row: OverviewPaneRow) => {
    if (isHumanOwnedPane(row)) return
    return invokeWithGuard(`read:${paneRowKey(row)}`, async () => {
      const result = await ctx.callAction('read', {
        paneId: row.paneId,
        lines: 40,
        ...(row.nodeId !== 'local' ? { nodeId: row.nodeId } : {}),
      })
      setSnapshot({
        title: `${row.paneId}@${row.nodeId}${row.agentName !== undefined ? ` (${row.agentName})` : ''}`,
        text: parseReadText(result),
      })
    })
  }

  /** parentConversationId of managed panes, fetched once via the list action (explicit action, no per-row polling). */
  const loadManagedMap = () =>
    invokeWithGuard('list', async () => {
      setManagedMap(parseManagedMap(await ctx.callAction('list', {})))
    })

  const renderManagedActions = (row: OverviewPaneRow, key: string, parentConversationId: number | undefined): ReactNode => {
    if (isHumanOwnedPane(row)) {
      return (
        <span className="badge badge-neutral" title={t(HDR_READ_ONLY_TITLE)}>
          {t(HDR_READ_ONLY)}
        </span>
      )
    }
    const showFocus = canFocusPane(row)
    const showRead = canSnapshotPane(row)
    const showConversation = row.ownedBy === 'helm' && (row.pendingAsk === true || parentConversationId !== undefined)
    if (!showFocus && !showRead && !showConversation) {
      return <span className="herdr-subtle">—</span>
    }
    return (
      <>
        {showFocus ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busyPane !== null}
            onClick={() => void focusPane(row)}
          >
            {busyPane === `focus:${key}` ? <Icon name="loader" size={11} /> : null}
            {t(HDR_ACTION_FOCUS)}
          </button>
        ) : null}
        {showRead ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busyPane !== null}
            onClick={() => void readPane(row)}
          >
            {busyPane === `read:${key}` ? <Icon name="loader" size={11} /> : null}
            {t(HDR_ACTION_SNAPSHOT)}
          </button>
        ) : null}
        {showConversation ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={parentConversationId === undefined}
            title={parentConversationId !== undefined ? herdrConversationTitle(parentConversationId, locale) : t(HDR_LINK_REFRESH_HINT)}
            onClick={() => {
              if (parentConversationId === undefined) return
              if (isSplit) ctx.openConversationDrawer(parentConversationId)
              else ctx.openScreen(`conversation:${parentConversationId}`)
            }}
          >
            <Icon name="message-square" size={11} />
            {t(HDR_ACTION_OPEN_LINKED)}
          </button>
        ) : null}
      </>
    )
  }

  return (
    <div className="herdr-overview">
      <div className="herdr-overview-toolbar">
        <div className="herdr-toolbar-stats">
          <span className="badge badge-neutral">{t(HDR_STAT_PANES)} {stats.total}</span>
          <span className="badge badge-accent">{t(HDR_STAT_WORKING)} {stats.working}</span>
          <span className="badge badge-warn">{t(HDR_STAT_BLOCKED)} {stats.blocked}</span>
          <span className="badge badge-neutral">{t(HDR_STAT_NODES)} {stats.nodes}</span>
        </div>
        <div className="herdr-toolbar-actions">
          <button type="button" className="btn btn-sm" onClick={() => void loadManagedMap()}>
            <Icon name="refresh-cw" size={12} />
            {t(HDR_REFRESH_LINKS)}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={doc === undefined}
            onClick={() => void ctx.getPluginDoc('overview')}
          >
            <Icon name="rotate-ccw" size={12} />
            {t(HDR_REFETCH)}
          </button>
        </div>
      </div>

      {(doc?.stale === true || doc?.error !== undefined) && (
        <div className="herdr-overview-stale">
          <Callout tone="warn">
            {herdrDegradedNotice(doc?.error, formatCompactTimestamp(doc?.updatedAt ?? 0), locale)}
          </Callout>
        </div>
      )}

      <div className="herdr-overview-filters">
        <FilterSelect
          value={filters.node}
          options={nodeFilterOptions}
          ariaLabel={t(HDR_FILTER_NODE_ARIA)}
          onChange={(next) => updateFilter('node', next)}
        />
        <FilterSelect
          value={filters.owner}
          options={ownerFilterOptions}
          ariaLabel={t(HDR_FILTER_OWNER_ARIA)}
          onChange={(next) => updateFilter('owner', next)}
        />
        <FilterSelect
          value={filters.status}
          options={statusFilterOptions}
          ariaLabel={t(HDR_FILTER_STATUS_ARIA)}
          onChange={(next) => updateFilter('status', next)}
        />
        <span className="text-subtle tabular-nums herdr-metric-label">
          {herdrRowCount(filtered.length, panes.length, locale)}
        </span>
      </div>

      <div className="herdr-overview-content">
        <div className="herdr-content-inner">
          <div className="helm-table-wrap herdr-desktop-table">
            <table className="helm-table">
              <thead>
                <tr>
                  <th className="herdr-col-node">{t(HDR_COL_NODE)}</th>
                  <th className="herdr-col-pane">{t(HDR_COL_PANE)}</th>
                  <th className="herdr-col-loc">{t(HDR_COL_LOCATION)}</th>
                  <th className="herdr-col-owner">{t(HDR_COL_OWNER)}</th>
                  <th className="herdr-col-status">{t(HDR_COL_STATUS)}</th>
                  <th className="herdr-col-cli">CLI</th>
                  <th>{t(HDR_COL_CWD)}</th>
                  <th className="herdr-col-outcome">{t(HDR_COL_OUTCOME)}</th>
                  <th className="herdr-col-actions">{t(HDR_COL_ACTIONS)}</th>
                </tr>
              </thead>
              <tbody>
                {doc === undefined ? (
                  <tr>
                    <td colSpan={9} className="herdr-muted">
                      {t(HDR_LOADING_DOC)}
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="herdr-muted">
                      {t(HDR_NO_MATCH)}
                    </td>
                  </tr>
                ) : (
                  filtered.map((row) => {
                    const key = paneRowKey(row)
                    const outcomeMeta = herdrOutcomeLabel(row.outcome, locale)
                    const parentConversationId = managedMap[key]
                    const locText = paneLocationText(row)
                    const cwdText = paneCwdText(row)
                    return (
                      <tr key={key}>
                        <td className="mono">{row.nodeId}</td>
                        <td className="mono">
                          {row.paneId}
                          {row.focused === true ? <span className="badge badge-accent herdr-badge-inline">{t(HDR_BADGE_FOCUSED)}</span> : null}
                          {row.pendingAsk === true ? <span className="badge badge-warn herdr-badge-inline">{t(HDR_BADGE_PENDING_ASK)}</span> : null}
                        </td>
                        <td className="herdr-cell-truncate" title={locText}>
                          {locText}
                        </td>
                        <td>
                          <span className={`badge ${row.ownedBy === 'helm' ? 'badge-accent' : 'badge-neutral'}`}>
                            {row.ownedBy === 'helm' ? 'helm' : 'human'}
                          </span>
                        </td>
                        <td>
                          {/* 表格保留可见状态文字（列语义不依赖列标题或颜色解释） */}
                          <span className={`badge badge-${agentStatusTone(row.agentStatus)}`}>{row.agentStatus}</span>
                        </td>
                        <td className="mono">{row.agentName ?? row.agent ?? '—'}</td>
                        <td className="mono herdr-cell-truncate" title={row.foregroundCwd ?? row.cwd ?? ''}>
                          {cwdText}
                        </td>
                        <td>
                          {outcomeMeta !== undefined ? (
                            <span className={`badge badge-${outcomeMeta.tone}`}>{outcomeMeta.label}</span>
                          ) : (
                            <span className="herdr-subtle">—</span>
                          )}
                        </td>
                        <td className="herdr-actions-cell">
                          <div className="stack-row herdr-actions-stack">
                            {renderManagedActions(row, key, parentConversationId)}
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="herdr-mobile-cards" aria-label={t(HDR_PANE_LIST_ARIA)}>
            {doc === undefined ? (
              <div className="herdr-mobile-empty">{t(HDR_LOADING_DOC)}</div>
            ) : filtered.length === 0 ? (
              <div className="herdr-mobile-empty">{t(HDR_NO_MATCH)}</div>
            ) : (
              filtered.map((row) => {
                const key = paneRowKey(row)
                const outcomeMeta = herdrOutcomeLabel(row.outcome, locale)
                const parentConversationId = managedMap[key]
                const humanOnly = isHumanOwnedPane(row)
                const locText = paneLocationText(row)
                const cwdText = paneCwdText(row)
                return (
                  <article
                    key={key}
                    className={`herdr-pane-card${humanOnly ? ' herdr-pane-card-human' : ''}`}
                    data-owned-by={humanOnly ? 'human' : 'helm'}
                  >
                    <div className="herdr-pane-card-top">
                      <span className="mono herdr-pane-card-id">{`${row.paneId}@${row.nodeId}`}</span>
                      <span className="herdr-pane-card-owner">{row.ownedBy === 'helm' ? 'helm' : 'human'}</span>
                      <StatusLight status={row.agentStatus} label={row.agentStatus} />
                      {outcomeMeta !== undefined ? (
                        <span className={`badge badge-${outcomeMeta.tone}`}>{outcomeMeta.label}</span>
                      ) : null}
                      {row.focused === true ? <span className="badge badge-accent">{t(HDR_BADGE_FOCUSED)}</span> : null}
                      {row.pendingAsk === true ? <span className="badge badge-warn">{t(HDR_BADGE_PENDING_ASK)}</span> : null}
                    </div>
                    <div className="herdr-pane-card-meta">
                      <span className="mono">{row.agentName ?? row.agent ?? '—'}</span>
                      {locText !== undefined && locText !== '' ? <span>{locText}</span> : null}
                    </div>
                    <div className="mono herdr-pane-card-cwd">{cwdText}</div>
                    <div className="herdr-pane-card-actions">
                      {renderManagedActions(row, key, parentConversationId)}
                    </div>
                  </article>
                )
              })
            )}
          </div>

          {doc !== undefined && doc.asks.length > 0 && (
            <div className="card herdr-asks-card">
              <div className="herdr-asks-title">{t(HDR_ASKS_TITLE)}</div>
              <div className="herdr-ask-list">
                {doc.asks.map((ask, i) => (
                  <div key={i} className="stack-row herdr-ask-row">
                    <span className="mono herdr-ask-target">
                      {ask.paneId}@{ask.nodeId}
                    </span>
                    <span className="badge badge-warn">
                      seq {ask.seq} / {ask.phase}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {snapshot !== null && (
        <Dialog open onOpenChange={(open) => { if (!open) setSnapshot(null) }}>
          <DialogPortal>
            <DialogOverlay className="modal-backdrop">
              <DialogContent className="modal herdr-snapshot-modal" aria-label={t(HDR_SNAPSHOT_ARIA)}>
                <div className="modal-header">
                  <DialogTitle className="modal-title mono">{herdrSnapshotTitle(snapshot.title, locale)}</DialogTitle>
                  <DialogClose asChild>
                    <button type="button" className="btn btn-sm btn-ghost">
                      <Icon name="x" size={12} />
                      {t(HDR_CLOSE)}
                    </button>
                  </DialogClose>
                </div>
                <div className="modal-body">
                  <pre className="code-block-pre selectable">{snapshot.text}</pre>
                </div>
              </DialogContent>
            </DialogOverlay>
          </DialogPortal>
        </Dialog>
      )}
    </div>
  )
}
