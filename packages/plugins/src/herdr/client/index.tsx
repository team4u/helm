/**
 * builtin:herdr 插件 client.tsx 组件（只导出组件，保 Fast Refresh 契约）：
 * - HerdrOverviewScreen：Herdr 终端总览全屏视图（桌面表格 + <=680px 双行卡片自适应）。
 *
 * 归属红线（AGENTS.md §3）：
 * - ownedBy === 'human' 的人类直连终端窗格仅允许只读诊断与状态展示，
 *   绝不渲染聚焦、快照、发送按键或中止类破坏性操作控件。
 * - 仅 ownedBy === 'helm' 的受管窗格开放关联会话、聚焦与只读快照入口。
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
  formatCompactTimestamp,
  Select,
  usePluginContext,
  usePluginDoc,
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
  outcomeLabel,
  OWNER_FILTER_OPTIONS,
  paneCwdText,
  paneLocationText,
  paneRowKey,
  parseFilters,
  parseManagedMap,
  parseReadText,
  STATUS_FILTER_OPTIONS,
  type OverviewDoc,
  type OverviewPaneRow,
} from './models.ts'
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

/** 宿主 Radix Select 筛选器（复用 @helm/plugin-client 共享原语；零原生 <select>）。 */
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
  const doc = usePluginDoc<OverviewDoc>('overview')

  const filters = useMemo(() => parseFilters(params), [params])
  const [busyPane, setBusyPane] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<{ title: string; text: string } | null>(null)
  const [managedMap, setManagedMap] = useState<Record<string, number>>({})

  const panes = doc?.panes ?? []
  const nodes = useMemo(() => collectNodes(panes), [panes])
  const nodeFilterOptions = useMemo<ReadonlyArray<{ value: string; label: string }>>(
    () => [
      { value: 'all', label: '全部节点' },
      ...nodes.map((m) => ({ value: m, label: m === 'local' ? '本机 (local)' : m })),
    ],
    [nodes],
  )

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
        `Herdr 操作失败：${error instanceof Error ? error.message : String(error)}`,
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

  /** 受管 pane 的 parentConversationId 经 list 动作一次性拉取（显式操作，不逐行轮询）。 */
  const loadManagedMap = () =>
    invokeWithGuard('list', async () => {
      setManagedMap(parseManagedMap(await ctx.callAction('list', {})))
    })

  const renderManagedActions = (row: OverviewPaneRow, key: string, parentConversationId: number | undefined): ReactNode => {
    if (isHumanOwnedPane(row)) {
      return (
        <span className="badge badge-neutral" title="人类直连终端仅支持只读诊断与状态展示">
          只读
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
            聚焦
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
            快照
          </button>
        ) : null}
        {showConversation ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={parentConversationId === undefined}
            title={parentConversationId !== undefined ? `会话 #${parentConversationId}` : '点「刷新关联」获取受管窗格的关联会话'}
            onClick={() => {
              if (parentConversationId === undefined) return
              if (isSplit) ctx.openConversationDrawer(parentConversationId)
              else ctx.openScreen(`conversation:${parentConversationId}`)
            }}
          >
            <Icon name="message-square" size={11} />
            打开关联会话
          </button>
        ) : null}
      </>
    )
  }

  return (
    <div className="herdr-overview">
      <div className="herdr-overview-toolbar">
        <div className="herdr-toolbar-stats">
          <span className="badge badge-neutral">窗格 {stats.total}</span>
          <span className="badge badge-accent">工作中 {stats.working}</span>
          <span className="badge badge-warn">待确认 {stats.blocked}</span>
          <span className="badge badge-neutral">节点 {stats.nodes}</span>
        </div>
        <div className="herdr-toolbar-actions">
          <button type="button" className="btn btn-sm" onClick={() => void loadManagedMap()}>
            <Icon name="refresh-cw" size={12} />
            刷新关联
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={doc === undefined}
            onClick={() => void ctx.getPluginDoc('overview')}
          >
            <Icon name="rotate-ccw" size={12} />
            重取
          </button>
        </div>
      </div>

      {(doc?.stale === true || doc?.error !== undefined) && (
        <div className="herdr-overview-stale">
          <Callout tone="warn">
            Herdr 连接降级或不可达：{doc?.error ?? '未知错误'}（以下为最后已知快照，时间 {formatCompactTimestamp(doc?.updatedAt ?? 0)}）
          </Callout>
        </div>
      )}

      <div className="herdr-overview-filters">
        <FilterSelect
          value={filters.node}
          options={nodeFilterOptions}
          ariaLabel="节点筛选"
          onChange={(next) => updateFilter('node', next)}
        />
        <FilterSelect
          value={filters.owner}
          options={OWNER_FILTER_OPTIONS}
          ariaLabel="归属筛选"
          onChange={(next) => updateFilter('owner', next)}
        />
        <FilterSelect
          value={filters.status}
          options={STATUS_FILTER_OPTIONS}
          ariaLabel="状态筛选"
          onChange={(next) => updateFilter('status', next)}
        />
        <span className="text-subtle tabular-nums herdr-metric-label">
          {filtered.length}/{panes.length} 行
        </span>
      </div>

      <div className="herdr-overview-content">
        <div className="herdr-content-inner">
          <div className="helm-table-wrap herdr-desktop-table">
            <table className="helm-table">
              <thead>
                <tr>
                  <th className="herdr-col-node">节点</th>
                  <th className="herdr-col-pane">窗格</th>
                  <th className="herdr-col-loc">位置</th>
                  <th className="herdr-col-owner">归属</th>
                  <th className="herdr-col-status">状态</th>
                  <th className="herdr-col-cli">CLI</th>
                  <th>工作目录</th>
                  <th className="herdr-col-outcome">终态</th>
                  <th className="herdr-col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {doc === undefined ? (
                  <tr>
                    <td colSpan={9} className="herdr-muted">
                      正在加载 overview 文档...
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="herdr-muted">
                      没有匹配的窗格
                    </td>
                  </tr>
                ) : (
                  filtered.map((row) => {
                    const key = paneRowKey(row)
                    const statusTone = agentStatusTone(row.agentStatus)
                    const outcomeMeta = outcomeLabel(row.outcome)
                    const parentConversationId = managedMap[key]
                    const locText = paneLocationText(row)
                    const cwdText = paneCwdText(row)
                    return (
                      <tr key={key}>
                        <td className="mono">{row.nodeId}</td>
                        <td className="mono">
                          {row.paneId}
                          {row.focused === true ? <span className="badge badge-accent herdr-badge-inline">聚焦</span> : null}
                          {row.pendingAsk === true ? <span className="badge badge-warn herdr-badge-inline">待审批</span> : null}
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
                          <span className={`badge badge-${statusTone}`}>{row.agentStatus}</span>
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

          <div className="herdr-mobile-cards" aria-label="窗格列表（移动视图）">
            {doc === undefined ? (
              <div className="herdr-mobile-empty">正在加载 overview 文档...</div>
            ) : filtered.length === 0 ? (
              <div className="herdr-mobile-empty">没有匹配的窗格</div>
            ) : (
              filtered.map((row) => {
                const key = paneRowKey(row)
                const statusTone = agentStatusTone(row.agentStatus)
                const outcomeMeta = outcomeLabel(row.outcome)
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
                      <span className={`badge ${row.ownedBy === 'helm' ? 'badge-accent' : 'badge-neutral'}`}>
                        {row.ownedBy === 'helm' ? 'helm' : 'human'}
                      </span>
                      <span className={`badge badge-${statusTone}`}>{row.agentStatus}</span>
                      {outcomeMeta !== undefined ? (
                        <span className={`badge badge-${outcomeMeta.tone}`}>{outcomeMeta.label}</span>
                      ) : null}
                      {row.focused === true ? <span className="badge badge-accent">聚焦</span> : null}
                      {row.pendingAsk === true ? <span className="badge badge-warn">待审批</span> : null}
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
              <div className="herdr-asks-title">待审批（asks）</div>
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
              <DialogContent className="modal herdr-snapshot-modal" aria-label="终端快照">
                <div className="modal-header">
                  <DialogTitle className="modal-title mono">终端快照：{snapshot.title}</DialogTitle>
                  <DialogClose asChild>
                    <button type="button" className="btn btn-sm btn-ghost">
                      <Icon name="x" size={12} />
                      关闭
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
