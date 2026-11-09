/**
 * Herdr 终端总览全屏视图（builtin:herdr/overview）。
 *
 * 数据：usePluginDoc('builtin:herdr', 'overview') 实时订阅 OverviewDoc
 * （version 2：panes 全量基表 + asks，行以 nodeId 标识目标节点；stale/error 诚实告警）。
 * 交互：focus / read 为用户显式操作（read 弹窗展示脱敏终端尾部 40 行）；
 * 归属红线：human 行不携带任何管理字段，界面上也不提供管理动作。
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { HelmIcon } from '../lib/icons.js'
import { formatCompactTimestamp } from '../lib/format.js'
import { useHelmStore, usePluginDoc } from '../lib/store-context.js'
import { formatSpecText } from '../ui/spec-normalize.js'

export interface HerdrOverviewScreenProps {
  isSplit?: boolean
  onCloseSplit?: () => void
}

interface OverviewPaneRow {
  nodeId: string
  paneId: string
  tabId: string
  workspaceId: string
  ownedBy: 'helm' | 'human'
  agentStatus: string
  cwd?: string
  foregroundCwd?: string
  label?: string
  title?: string
  agent?: string
  agentName?: string
  focused?: boolean
  outcome?: string
  pendingAsk?: boolean
}

interface OverviewDoc {
  version: 2
  updatedAt: number
  stale: boolean
  error?: string
  panes: OverviewPaneRow[]
  asks: Array<{ paneId: string; nodeId: string; seq: number; phase: string }>
}

const AGENT_STATUS_TONE: Record<string, string> = {
  idle: 'neutral',
  working: 'accent',
  blocked: 'warn',
  done: 'ok',
  unknown: 'neutral',
}

const OUTCOME_LABEL: Record<string, { label: string; tone: string }> = {
  running: { label: '运行中', tone: 'accent' },
  keepalive: { label: '保活', tone: 'neutral' },
  failed: { label: '失败', tone: 'err' },
  settled: { label: '已收尾', tone: 'ok' },
}

export function HerdrOverviewScreen({ isSplit, onCloseSplit }: HerdrOverviewScreenProps): ReactNode {
  const store = useHelmStore()
  const doc = usePluginDoc<OverviewDoc>('builtin:herdr', 'overview')

  const [nodeFilter, setNodeFilter] = useState('all')
  const [ownerFilter, setOwnerFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [busyPane, setBusyPane] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<{ title: string; text: string } | null>(null)

  const panes = doc?.panes ?? []
  const nodes = useMemo(() => Array.from(new Set(panes.map((p) => p.nodeId))).sort(), [panes])

  const filtered = useMemo(
    () =>
      panes.filter((p) => {
        if (nodeFilter !== 'all' && p.nodeId !== nodeFilter) return false
        if (ownerFilter !== 'all' && p.ownedBy !== ownerFilter) return false
        if (statusFilter !== 'all' && p.agentStatus !== statusFilter) return false
        return true
      }),
    [panes, nodeFilter, ownerFilter, statusFilter],
  )

  const stats = useMemo(
    () => ({
      total: panes.length,
      working: panes.filter((p) => p.agentStatus === 'working').length,
      blocked: panes.filter((p) => p.agentStatus === 'blocked').length,
      nodes: nodes.length,
    }),
    [panes, nodes],
  )

  const invokeWithGuard = async (paneKey: string, fn: () => Promise<void>) => {
    if (busyPane !== null) return
    setBusyPane(paneKey)
    try {
      await fn()
    } catch (error) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: 'Herdr 操作失败',
        body: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusyPane(null)
    }
  }

  const focusPane = (row: OverviewPaneRow) =>
    invokeWithGuard(`focus:${row.nodeId}:${row.paneId}`, async () => {
      await store.invokePluginAction('builtin:herdr', 'focus', {
        paneId: row.paneId,
        ...(row.nodeId !== 'local' ? { nodeId: row.nodeId } : {}),
      })
    })

  const readPane = (row: OverviewPaneRow) =>
    invokeWithGuard(`read:${row.nodeId}:${row.paneId}`, async () => {
      const result = (await store.invokePluginAction('builtin:herdr', 'read', {
        paneId: row.paneId,
        lines: 40,
        ...(row.nodeId !== 'local' ? { nodeId: row.nodeId } : {}),
      })) as { text?: unknown } | undefined
      const text = result !== null && typeof result === 'object' && 'text' in result ? String(result.text) : formatSpecText(result)
      setSnapshot({ title: `${row.paneId}@${row.nodeId}${row.agentName !== undefined ? ` (${row.agentName})` : ''}`, text })
    })

  // 受管行的关联会话：由 herdr 插件的 list 动作补充（overview doc 行不含
  // conversationId；只有 registry 才有 parentConversationId）。这里用 invokes
  // 是显式操作；但为避免每行一次调用，打开关联会话仅在行上存在
  // parentConversationId（未来 doc 版本扩展）或经 asks 关联时可用。
  // 现实写法：受管 pane 的 parentConversationId 经 list 动作一次性拉取。
  const [managedMap, setManagedMap] = useState<Record<string, number>>({})
  const loadManagedMap = () =>
    invokeWithGuard('list', async () => {
      const result = (await store.invokePluginAction('builtin:herdr', 'list', {})) as {
        panes?: Array<Record<string, unknown>>
      } | undefined
      const map: Record<string, number> = {}
      if (result !== null && typeof result === 'object' && Array.isArray(result.panes)) {
        for (const p of result.panes) {
          const paneId = typeof p['paneId'] === 'string' ? p['paneId'] : undefined
          const nodeId = typeof p['nodeId'] === 'string' ? p['nodeId'] : 'local'
          const parent = p['parentConversationId']
          if (paneId !== undefined && typeof parent === 'number') map[`${nodeId}:${paneId}`] = parent
        }
      }
      setManagedMap(map)
    })

  return (
    <div className="helm-pane">
      <div className="pane-topbar">
        <div className="pane-title-group">
          <HelmIcon name="terminal" size={14} />
          <span className="pane-title">Herdr 终端总览</span>
        </div>
        <div className="pane-actions">
          <span className="badge badge-neutral">窗格 {stats.total}</span>
          <span className="badge badge-accent">工作中 {stats.working}</span>
          <span className="badge badge-warn">待确认 {stats.blocked}</span>
          <span className="badge badge-neutral">节点 {stats.nodes}</span>
          <button type="button" className="btn btn-sm" onClick={() => void loadManagedMap()}>
            <HelmIcon name="refresh-cw" size={12} />
            刷新关联
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={doc === undefined}
            onClick={() => void store.ensurePluginDoc('builtin:herdr', 'overview')}
          >
            <HelmIcon name="rotate-ccw" size={12} />
            重取
          </button>
          {isSplit && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onCloseSplit}>
              <HelmIcon name="x" size={12} />
              关闭分屏
            </button>
          )}
        </div>
      </div>

      {(doc?.stale === true || doc?.error !== undefined) && (
        <div className="jr-callout jr-callout-warn" style={{ margin: '10px 16px 0' }}>
          <HelmIcon name="alert-triangle" size={13} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            Herdr 连接降级或不可达：{doc?.error ?? '未知错误'}（以下为最后已知快照，时间 {formatCompactTimestamp(doc?.updatedAt ?? 0)}）
          </span>
        </div>
      )}

      <div className="pane-actions" style={{ padding: '10px 16px 0', justifyContent: 'flex-start' }}>
        <select className="select" style={{ width: 140 }} value={nodeFilter} onChange={(e) => setNodeFilter(e.target.value)}>
          <option value="all">全部节点</option>
          {nodes.map((m) => (
            <option key={m} value={m}>
              {m === 'local' ? '本机 (local)' : m}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 140 }} value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
          <option value="all">全部归属</option>
          <option value="helm">helm 受管</option>
          <option value="human">human 直连</option>
        </select>
        <select className="select" style={{ width: 140 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">全部状态</option>
          <option value="working">working</option>
          <option value="idle">idle</option>
          <option value="blocked">blocked</option>
          <option value="done">done</option>
          <option value="unknown">unknown</option>
        </select>
        <span className="jr-metric-label">
          {filtered.length}/{panes.length} 行
        </span>
      </div>

      <div className="timeline-scroll">
        <div style={{ width: '100%', maxWidth: 1100, margin: '0 auto' }}>
          <div className="jr-table-wrap">
            <table className="jr-table">
              <thead>
                <tr>
                  <th>节点</th>
                  <th>窗格</th>
                  <th>位置</th>
                  <th>归属</th>
                  <th>状态</th>
                  <th>CLI</th>
                  <th>工作目录</th>
                  <th>终态</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
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
                  const key = `${row.nodeId}:${row.paneId}`
                  const statusTone = AGENT_STATUS_TONE[row.agentStatus] ?? 'neutral'
                  const outcomeMeta = row.outcome !== undefined ? OUTCOME_LABEL[row.outcome] : undefined
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
                      <td style={{ textAlign: 'right' }}>
                        <div className="jr-stack-row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busyPane !== null}
                            onClick={() => void focusPane(row)}
                          >
                            {busyPane === `focus:${key}` && <HelmIcon name="loader" size={11} />}
                            聚焦
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busyPane !== null}
                            onClick={() => void readPane(row)}
                          >
                            {busyPane === `read:${key}` && <HelmIcon name="loader" size={11} />}
                            快照
                          </button>
                          {(row.pendingAsk === true || parentConversationId !== undefined) && (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              disabled={parentConversationId === undefined}
                              title={parentConversationId !== undefined ? `会话 #${parentConversationId}` : '点「刷新关联」获取受管窗格的关联会话'}
                              onClick={() => {
                                if (parentConversationId === undefined) return
                                store.openTarget(`conversation:${parentConversationId}`, { split: isSplit !== true })
                              }}
                            >
                              <HelmIcon name="message-square" size={11} />
                              打开关联会话
                            </button>
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
              <div className="jr-stack" style={{ gap: 4 }}>
                {doc.asks.map((ask, i) => (
                  <div key={i} className="jr-stack-row" style={{ justifyContent: 'space-between' }}>
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
        <div className="modal-backdrop" onClick={() => setSnapshot(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860 }}>
            <div className="modal-header">
              <div className="modal-title mono">终端快照：{snapshot.title}</div>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSnapshot(null)}>
                <HelmIcon name="x" size={12} />
                关闭
              </button>
            </div>
            <div className="modal-body">
              <pre className="code-block-pre selectable" style={{ background: 'var(--bg-subtle)', borderRadius: 'var(--radius-sm)', margin: 0 }}>
                {snapshot.text}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
