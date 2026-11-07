/**
 * SuperAgent 记忆与订阅图谱全屏视图（builtin:superagent/recall-graph）。
 *
 * 数据：recall-graph（记忆节点）、subscriptions（ThreadKey 订阅路由）、
 * index（中枢/看门狗会话与 Worker 表）三个公开 doc 实时订阅。
 * 交互：主屏/右屏并排打开对应会话；归档 Worker 调用 archive_worker 动作。
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore, usePluginDoc } from '../lib/store-context.js'

export interface RecallGraphScreenProps {
  isSplit?: boolean
  onCloseSplit?: () => void
}

interface RecallNode {
  id: string
  conversationId: number
  profileId: string
  completionSeq: number
  outcome: string
  summary: string
  keywords: string[]
  createdAt: number
}

interface IndexDoc {
  version: 1
  routerConversationId?: number
  watchdogConversationId?: number
  workers: Array<{ conversationId: number; parentConversationId: number; profileId: string; createdAt: number }>
}

interface SubscriptionsDoc {
  version: 1
  subscriptions: Array<{ threadKey: string; workerConversationId: number; createdAt: number }>
}

const OUTCOME_TONE: Record<string, string> = {
  completed: 'ok',
  failed: 'err',
  aborted: 'warn',
}

function formatTime(ms: number): string {
  if (!ms) return '—'
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function RecallGraphScreen({ isSplit, onCloseSplit }: RecallGraphScreenProps): ReactNode {
  const store = useHelmStore()
  const recallDoc = usePluginDoc<{ nodes: RecallNode[] }>('builtin:superagent', 'recall-graph')
  const subsDoc = usePluginDoc<SubscriptionsDoc>('builtin:superagent', 'subscriptions')
  const indexDoc = usePluginDoc<IndexDoc>('builtin:superagent', 'index')

  const [query, setQuery] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const nodes = recallDoc?.nodes ?? []
  const subscriptions = subsDoc?.subscriptions ?? []
  const workers = indexDoc?.workers ?? []

  const filteredNodes = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return nodes
    return nodes.filter(
      (n) =>
        n.summary.toLowerCase().includes(q) ||
        n.profileId.toLowerCase().includes(q) ||
        n.outcome.toLowerCase().includes(q) ||
        n.keywords.some((k) => k.toLowerCase().includes(q)) ||
        String(n.conversationId).includes(q),
    )
  }, [nodes, query])

  const activeWorkerIds = new Set(workers.map((w) => w.conversationId))

  const archiveWorker = (conversationId: number) => {
    if (busyKey !== null) return
    setBusyKey(`archive:${conversationId}`)
    void store
      .invokePluginAction('builtin:superagent', 'archive_worker', { workerConversationId: conversationId })
      .then(() => setBusyKey(null))
      .catch((error: unknown) => {
        setBusyKey(null)
        store.pushNotice({
          type: 'notification',
          level: 'error',
          title: '归档 Worker 失败',
          body: error instanceof Error ? error.message : String(error),
        })
      })
  }

  return (
    <div className="helm-pane">
      <div className="pane-topbar">
        <div className="pane-title-group">
          <HelmIcon name="git-fork" size={14} />
          <span className="pane-title">RecallGraph 记忆图谱</span>
        </div>
        <div className="pane-actions">
          {isSplit && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onCloseSplit}>
              <HelmIcon name="x" size={12} />
              关闭分屏
            </button>
          )}
        </div>
      </div>

      <div className="timeline-scroll">
        <div className="timeline-inner" style={{ maxWidth: 1100 }}>
          <div className="jr-metric-grid">
            <div className="jr-metric-card">
              <div className="jr-metric-label">中枢会话</div>
              <div className="jr-metric-value">{indexDoc?.routerConversationId !== undefined ? `#${indexDoc.routerConversationId}` : '—'}</div>
            </div>
            <div className="jr-metric-card">
              <div className="jr-metric-label">看门狗会话</div>
              <div className="jr-metric-value">{indexDoc?.watchdogConversationId !== undefined ? `#${indexDoc.watchdogConversationId}` : '—'}</div>
            </div>
            <div className="jr-metric-card">
              <div className="jr-metric-label">活跃 Worker</div>
              <div className="jr-metric-value">{workers.length}</div>
            </div>
            <div className="jr-metric-card">
              <div className="jr-metric-label">记忆节点</div>
              <div className="jr-metric-value">{nodes.length}</div>
            </div>
            <div className="jr-metric-card">
              <div className="jr-metric-label">ThreadKey 订阅</div>
              <div className="jr-metric-value">{subscriptions.length}</div>
            </div>
          </div>

          <div className="jr-stack-row" style={{ justifyContent: 'space-between' }}>
            <span className="tab-btn tab-btn-active" style={{ cursor: 'default', padding: '7px 0' }}>
              历史记忆节点（{filteredNodes.length}/{nodes.length}）
            </span>
            <input
              className="input"
              style={{ width: 280 }}
              placeholder="按 summary / keywords / profileId / outcome / #id 过滤"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="jr-stack">
            {recallDoc === undefined && (
              <div className="jr-callout">
                <HelmIcon name="loader" size={13} />
                <span>正在加载 recall-graph 文档...</span>
              </div>
            )}
            {recallDoc !== undefined && filteredNodes.length === 0 && (
              <div className="jr-callout">
                <HelmIcon name="search" size={13} />
                <span>没有匹配的记忆节点</span>
              </div>
            )}
            {filteredNodes.map((node) => {
              const key = `node:${node.id}`
              const tone = OUTCOME_TONE[node.outcome] ?? 'neutral'
              return (
                <div key={key} className="card">
                  <div className="jr-stack-row" style={{ justifyContent: 'space-between' }}>
                    <div className="jr-stack-row">
                      <span className="badge badge-neutral mono">#{node.conversationId}</span>
                      <span className="badge badge-accent">{node.profileId}</span>
                      <span className={`badge badge-${tone}`}>{node.outcome}</span>
                      <span className="jr-metric-label tabular-nums">{formatTime(node.createdAt)}</span>
                    </div>
                    <div className="jr-stack-row">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => store.openTarget(`conversation:${node.conversationId}`)}
                      >
                        <HelmIcon name="external-link" size={11} />
                        主屏打开
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => store.openTarget(`conversation:${node.conversationId}`, { split: true })}
                      >
                        <HelmIcon name="columns" size={11} />
                        右屏并排
                      </button>
                      {activeWorkerIds.has(node.conversationId) && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busyKey !== null}
                          onClick={() => archiveWorker(node.conversationId)}
                        >
                          {(busyKey === `archive:${node.conversationId}`) && <HelmIcon name="loader" size={11} />}
                          归档 Worker
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: 13 }}>{node.summary}</div>
                  {node.keywords.length > 0 && (
                    <div className="jr-stack-row">
                      {node.keywords.map((kw, i) => (
                        <span key={i} className="badge badge-neutral">
                          {kw}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="jr-stack-row" style={{ justifyContent: 'space-between' }}>
            <span className="tab-btn tab-btn-active" style={{ cursor: 'default', padding: '7px 0' }}>
              事件订阅路由表（ThreadSubscriptions，{subscriptions.length} 条）
            </span>
          </div>
          <div className="jr-table-wrap">
            <table className="jr-table">
              <thead>
                <tr>
                  <th>ThreadKey</th>
                  <th>Worker</th>
                  <th>创建时间</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {subsDoc !== undefined && subscriptions.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ color: 'var(--fg-muted)' }}>
                      暂无活跃订阅
                    </td>
                  </tr>
                )}
                {subscriptions.map((sub, i) => (
                  <tr key={i}>
                    <td className="mono">{sub.threadKey}</td>
                    <td className="mono">#{sub.workerConversationId}</td>
                    <td className="tabular-nums">{formatTime(sub.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="jr-stack-row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => store.openTarget(`conversation:${sub.workerConversationId}`)}
                        >
                          <HelmIcon name="external-link" size={11} />
                          打开 Worker
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => store.openTarget(`conversation:${sub.workerConversationId}`, { split: true })}
                        >
                          <HelmIcon name="columns" size={11} />
                          右屏并排
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
