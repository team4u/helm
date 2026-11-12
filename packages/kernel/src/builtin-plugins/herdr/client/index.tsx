/**
 * builtin:herdr 插件 client.tsx 组件（只导出组件，保 Fast Refresh 契约）：
 * - HerdrOverviewScreen：Herdr 终端总览全屏视图（原 @helm/web 同构迁移）。
 *
 * 数据经 @helm/plugin-client 共享 hooks（usePluginDoc / usePluginContext）
 * 从宿主 store 响应式读取；focus / read / list 动作经 ctx.callAction 走
 * POST /api/actions/builtin:herdr/<actionId>，无任何宿主私有 store 依赖。
 * 归属红线：human 行不携带任何管理字段，界面上也不提供管理动作。
 * node / owner / status 筛选经 ScreenProps.params / setParams 深链可恢复。
 */
import { useMemo, useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
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
  outcomeLabel,
  paneRowKey,
  parseFilters,
  parseManagedMap,
  parseReadText,
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

function Icon({ name, size = 12, className, style }: { name: string; size?: number; className?: string; style?: React.CSSProperties }): ReactNode {
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
  width,
}: {
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  ariaLabel: string
  onChange: (next: string) => void
  width?: number
}): ReactNode {
  return (
    <Select
      size="sm"
      className="herdr-filter-select"
      style={{ width }}
      value={value}
      options={options}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

const OWNER_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: '全部归属' },
  { value: 'helm', label: 'helm 受管' },
  { value: 'human', label: 'human 直连' },
]

const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'working', label: 'working' },
  { value: 'idle', label: 'idle' },
  { value: 'blocked', label: 'blocked' },
  { value: 'done', label: 'done' },
  { value: 'unknown', label: 'unknown' },
]

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

  const focusPane = (row: OverviewPaneRow) =>
    invokeWithGuard(`focus:${paneRowKey(row)}`, async () => {
      await ctx.callAction('focus', {
        paneId: row.paneId,
        ...(row.nodeId !== 'local' ? { nodeId: row.nodeId } : {}),
      })
    })

  const readPane = (row: OverviewPaneRow) =>
    invokeWithGuard(`read:${paneRowKey(row)}`, async () => {
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

  /** 受管 pane 的 parentConversationId 经 list 动作一次性拉取（显式操作，不逐行轮询）。 */
  const loadManagedMap = () =>
    invokeWithGuard('list', async () => {
      setManagedMap(parseManagedMap(await ctx.callAction('list', {})))
    })

  return (
    <div className="herdr-overview">
      <div className="herdr-overview-toolbar">
        <div className="pane-actions">
          <span className="badge badge-neutral">窗格 {stats.total}</span>
          <span className="badge badge-accent">工作中 {stats.working}</span>
          <span className="badge badge-warn">待确认 {stats.blocked}</span>
          <span className="badge badge-neutral">节点 {stats.nodes}</span>
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
        <div style={{ margin: '10px 16px 0' }}>
          <Callout tone="warn">
            Herdr 连接降级或不可达：{doc?.error ?? '未知错误'}（以下为最后已知快照，时间 {formatCompactTimestamp(doc?.updatedAt ?? 0)}）
          </Callout>
        </div>
      )}

      <div className="pane-actions herdr-overview-filters">
        <FilterSelect
          width={140}
          value={filters.node}
          options={nodeFilterOptions}
          ariaLabel="节点筛选"
          onChange={(next) => updateFilter('node', next)}
        />
        <FilterSelect
          width={140}
          value={filters.owner}
          options={OWNER_FILTER_OPTIONS}
          ariaLabel="归属筛选"
          onChange={(next) => updateFilter('owner', next)}
        />
        <FilterSelect
          width={140}
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
        <div style={{ width: '100%', maxWidth: 1100, margin: '0 auto' }}>
          <div className="helm-table-wrap">
            <table className="helm-table">
              <thead>
                <tr>
                  <th style={{ width: 75 }}>节点</th>
                  <th style={{ width: 110 }}>窗格</th>
                  <th style={{ width: 140 }}>位置</th>
                  <th style={{ width: 65 }}>归属</th>
                  <th style={{ width: 75 }}>状态</th>
                  <th style={{ width: 85 }}>CLI</th>
                  <th>工作目录</th>
                  <th style={{ width: 75 }}>终态</th>
                  <th style={{ width: 120, textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {doc === undefined && (
                  <tr>
                    <td colSpan={9} style={{ color: 'var(--fg-muted)' }}>
                      正在加载 overview 文档...
                    </td>
                  </tr>
                )}
                {doc !== undefined && filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ color: 'var(--fg-muted)' }}>
                      没有匹配的窗格
                    </td>
                  </tr>
                )}
                {filtered.map((row) => {
                  const key = paneRowKey(row)
                  const statusTone = agentStatusTone(row.agentStatus)
                  const outcomeMeta = outcomeLabel(row.outcome)
                  const parentConversationId = managedMap[key]
                  return (
                    <tr key={key}>
                      <td className="mono">{row.nodeId}</td>
                      <td className="mono">
                        {row.paneId}
                        {row.focused === true && <span className="badge badge-accent" style={{ marginLeft: 6 }}>聚焦</span>}
                        {row.pendingAsk === true && <span className="badge badge-warn" style={{ marginLeft: 6 }}>待审批</span>}
                      </td>
                      <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.title ?? row.label ?? row.workspaceId}
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
                      <td
                        className="mono"
                        style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={row.foregroundCwd ?? row.cwd ?? ''}
                      >
                        {row.foregroundCwd ?? row.cwd ?? '—'}
                      </td>
                      <td>
                        {outcomeMeta !== undefined ? (
                          <span className={`badge badge-${outcomeMeta.tone}`}>{outcomeMeta.label}</span>
                        ) : (
                          <span style={{ color: 'var(--fg-subtle)' }}>—</span>
                        )}
                      </td>
                      <td className="herdr-actions-cell" style={{ textAlign: 'right' }}>
                        <div className="stack-row" style={{ justifyContent: 'flex-end' }}>
                          {canFocusPane(row) && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busyPane !== null}
                              onClick={() => void focusPane(row)}
                            >
                              {busyPane === `focus:${key}` && <Icon name="loader" size={11} />}
                              聚焦
                            </button>
                          )}
                          {canSnapshotPane(row) && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busyPane !== null}
                              onClick={() => void readPane(row)}
                            >
                              {busyPane === `read:${key}` && <Icon name="loader" size={11} />}
                              快照
                            </button>
                          )}
                          {row.ownedBy === 'helm' && (row.pendingAsk === true || parentConversationId !== undefined) && (
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
                          )}
                          {!canFocusPane(row) && !canSnapshotPane(row) && !(row.ownedBy === 'helm' && (row.pendingAsk === true || parentConversationId !== undefined)) && (
                            <span style={{ color: 'var(--fg-subtle)' }}>—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {doc !== undefined && doc.asks.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>待审批（asks）</div>
              <div className="herdr-ask-list">
                {doc.asks.map((ask, i) => (
                  <div key={i} className="stack-row" style={{ justifyContent: 'space-between', width: '100%' }}>
                    <span className="mono" style={{ fontSize: 12 }}>
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
