import { useMemo, useState } from 'react'
import type { ConversationSummary, WorkflowNodeState, WorkflowRunSummary } from '@helm/protocol'
import { workflowsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { matchesUiScope } from '../lib/types.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { formatBytes, formatDurationMs } from './timeline-model.js'

const NODE_STATUS_META: Record<string, { label: string; badge: string; icon: string }> = {
  pending: { label: '待执行', badge: 'badge-neutral', icon: 'circle' },
  running: { label: '运行中', badge: 'badge-accent', icon: 'loader' },
  done: { label: '完成', badge: 'badge-ok', icon: 'check' },
  failed: { label: '失败', badge: 'badge-err', icon: 'x' },
  skipped: { label: '跳过', badge: 'badge-neutral', icon: 'corner-down-right' },
}

const RUN_STATUS_META: Record<string, { label: string; badge: string }> = {
  running: { label: '运行中', badge: 'badge-accent' },
  completed: { label: '已完成', badge: 'badge-ok' },
  failed: { label: '失败', badge: 'badge-err' },
  aborted: { label: '已中止', badge: 'badge-warn' },
}

function PhaseBar({ run }: { run: WorkflowRunSummary }) {
  const phases = useMemo(() => {
    const declared = (run.progress ?? []).filter((p) => p.kind === 'phase')
    if (declared.length > 0) return declared.map((p) => (p.kind === 'phase' ? p.title : ''))
    const titles = new Set<string>()
    for (const node of run.nodes ?? []) {
      if (node.phaseTitle !== undefined) titles.add(node.phaseTitle)
    }
    return [...titles]
  }, [run])

  if (phases.length === 0) return null
  const activeTitle = useMemo(() => {
    for (let i = (run.nodes ?? []).length - 1; i >= 0; i--) {
      const node = run.nodes![i]!
      if (node.status === 'running' && node.phaseTitle !== undefined) return node.phaseTitle
    }
    return undefined
  }, [run])

  return (
    <div className="phase-bar">
      {phases.map((title, idx) => (
        <span
          key={`${idx}:${title}`}
          className={`phase-segment${title === activeTitle ? ' phase-segment-active' : ''}`}
          title={title}
        >
          {idx + 1}. {title}
        </span>
      ))}
    </div>
  )
}

function NodeDetailRows({ node }: { node: WorkflowNodeState }) {
  const rows: Array<[string, string]> = []
  if (node.agentType !== undefined) rows.push(['执行后端', node.agentType])
  if (node.conversationId !== undefined) rows.push(['子会话', `#${node.conversationId}`])
  if (node.executionId !== undefined) rows.push(['外部执行', node.executionId])
  if (node.effectiveCwd !== undefined) rows.push(['工作目录', node.effectiveCwd])
  if (node.worktree !== undefined) rows.push(['Worktree', `${node.worktree.branch} @ ${node.worktree.path}`])
  if (node.durationMs !== undefined) rows.push(['耗时', formatDurationMs(node.durationMs)])
  if (node.tokens !== undefined && node.tokens > 0) rows.push(['Token', String(node.tokens)])
  if (node.error !== undefined) rows.push(['错误', node.error])

  const [open, setOpen] = useState(false)
  const hasLong = node.prompt !== undefined || node.output !== undefined || node.gate !== undefined

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {rows.length > 0 ? (
        <div className="jr-kv-list">
          {rows.map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
              <span className="jr-kv-key">{k}</span>
              <span className="jr-kv-val mono">{v}</span>
            </span>
          ))}
        </div>
      ) : null}
      {hasLong ? (
        <button type="button" className="btn btn-ghost btn-sm" style={{ width: 'fit-content' }} onClick={() => setOpen((v) => !v)}>
          <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          {open ? '收起详情' : '展开 Prompt / Output / Gate'}
        </button>
      ) : null}
      {open ? (
        <div className="trace-expanded-body selectable" style={{ marginLeft: 0 }}>
          {node.prompt !== undefined ? (
            <div>
              <div className="trace-section-label">Prompt</div>
              <pre className="code-block-pre" style={{ padding: 0 }}>
                <code>{node.prompt}</code>
              </pre>
            </div>
          ) : null}
          {node.gate !== undefined ? (
            <div>
              <div className="trace-section-label">Gate</div>
              <pre className="code-block-pre" style={{ padding: 0 }}>
                <code>{JSON.stringify(node.gate, null, 2)}</code>
              </pre>
            </div>
          ) : null}
          {node.output !== undefined ? (
            <div>
              <div className="trace-section-label">Output</div>
              <pre className="code-block-pre" style={{ padding: 0 }}>
                <code>{JSON.stringify(node.output, null, 2)}</code>
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function WorkflowRunCard({ run }: { run: WorkflowRunSummary }) {
  const store = useHelmStore()
  const [open, setOpen] = useState(run.status === 'running')
  const [aborting, setAborting] = useState(false)
  const meta = RUN_STATUS_META[run.status] ?? { label: run.status, badge: 'badge-neutral' }

  const abort = async (): Promise<void> => {
    setAborting(true)
    try {
      await workflowsApi.abort(run.id)
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '中止工作流失败',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setAborting(false)
    }
  }

  const nodes = run.nodes ?? []
  const totalTokens = nodes.reduce((sum, n) => sum + (n.tokens ?? 0), 0)

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpen((v) => !v)}
          title={open ? '收起' : '展开'}
        >
          <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        </button>
        <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
          {run.name}
        </span>
        <span className={`badge ${meta.badge}`}>{meta.label}</span>
        {run.replayedFrom !== undefined ? (
          <span className="badge badge-warn" title={`从 journal 前缀重放恢复（源 run ${run.replayedFrom}）`}>
            cached 重放
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {run.status === 'running' ? (
          <button type="button" className="btn btn-sm btn-danger" disabled={aborting} onClick={() => void abort()}>
            <HelmIcon name="square" size={11} />
            中止
          </button>
        ) : null}
      </div>
      <PhaseBar run={run} />
      {open ? (
        <div className="list" style={{ display: 'flex', flexDirection: 'column' }}>
          {nodes.map((node) => {
            const sm = NODE_STATUS_META[node.status] ?? NODE_STATUS_META.pending!
            return (
              <div key={node.id} className="row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                  <HelmIcon name={sm.icon} size={12} className={node.status === 'running' ? 'spin-slow' : undefined} />
                  <span className="mono" style={{ fontSize: 11.5, fontWeight: 500 }}>
                    {node.label ?? node.id}
                  </span>
                  <span className={`badge ${sm.badge}`}>{sm.label}</span>
                  {node.cached === true ? <span className="badge badge-warn">cached</span> : null}
                  <span style={{ flex: 1 }} />
                  {node.conversationId !== undefined ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      title={`在右屏分屏打开子会话 #${node.conversationId}`}
                      onClick={() => {
                        store.openTarget(
                          { kind: 'conversation', conversationId: node.conversationId! },
                          { split: true },
                        )
                        maybeCollapseWorkbench(store)
                      }}
                    >
                      <HelmIcon name="panel-right" size={11} />
                      #{node.conversationId}
                    </button>
                  ) : null}
                </div>
                <NodeDetailRows node={node} />
              </div>
            )
          })}
          {nodes.length === 0 ? (
            <div className="row" style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
              暂无节点状态
            </div>
          ) : null}
          {totalTokens > 0 ? (
            <div className="row" style={{ color: 'var(--fg-muted)', fontSize: 11.5 }}>
              合计 Token <span className="mono tabular-nums">{totalTokens.toLocaleString()}</span>
            </div>
          ) : null}
          {run.error !== undefined ? (
            <div className="jr-callout jr-callout-err" style={{ margin: 8 }}>
              <HelmIcon name="alert-circle" size={12} />
              <span style={{ wordBreak: 'break-all' }}>{run.error}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 窄屏抽屉覆盖模式（<=1200px）下点击导航类按钮后自动收起抽屉，避免遮挡背后视图。 */
function maybeCollapseWorkbench(store: { setWorkbenchOpen: (open: boolean) => void }): void {
  if (typeof window === 'undefined' || !window.matchMedia) return
  if (window.matchMedia('(max-width: 1200px)').matches) store.setWorkbenchOpen(false)
}

function WorkflowInspector({ conversationId }: { conversationId: number }) {
  const store = useHelmStore()
  const runs = useMemo(
    () => store.workflowRuns.filter((r) => r.conversationId === conversationId),
    [store.workflowRuns, conversationId],
  )
  const children = store.conversations.filter((conversation) => conversation.parentConversationId === conversationId)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
      {children.length > 0 && <div className="list">{children.map((child) => <div className="row" key={child.id}>
        <span><strong>#{child.id}</strong> {child.title}</span>
        <span style={{ display: 'inline-flex', gap: 6, flexShrink: 0 }}>
          <button className="btn btn-sm" title="在主屏打开该子会话" onClick={() => {
            store.openTarget({ kind: 'conversation', conversationId: child.id })
            maybeCollapseWorkbench(store)
          }}>打开</button>
          <button className="btn btn-sm workbench-split-btn" title="在分屏并排打开该子会话" onClick={() => {
            store.openTarget({ kind: 'conversation', conversationId: child.id }, { split: true })
            maybeCollapseWorkbench(store)
          }}>并排查看</button>
        </span>
      </div>)}</div>}
      {runs.length === 0 && children.length === 0 && <p style={{ color: 'var(--fg-muted)' }}>当前会话暂无工作流或子代理。</p>}
      {runs.map((run) => (
        <WorkflowRunCard key={run.id} run={run} />
      ))}
    </div>
  )
}

function ArtifactsTab({ conversationId }: { conversationId: number }) {
  const store = useHelmStore()
  const artifacts = store.conversationArtifacts[conversationId] ?? []

  if (artifacts.length === 0) {
    return (
      <div style={{ padding: '20px 14px', color: 'var(--fg-muted)', fontSize: 12, textAlign: 'center' }}>
        当前会话暂无产物
      </div>
    )
  }
  return (
    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="list">
        {artifacts.map((a) => (
          <div key={a.id} className="row">
            <button
              type="button"
              className="row-main"
              style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
              title={`预览 ${a.name}`}
              onClick={() => store.setActiveModal({ kind: 'artifact-preview', artifactId: a.id, conversationId })}
            >
              <HelmIcon name={a.mimeType.startsWith('image/') ? 'eye' : 'file-text'} size={13} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              <span className="badge badge-neutral mono">{a.mimeType}</span>
            </button>
            <span className="mono tabular-nums" style={{ fontSize: 11, color: 'var(--fg-muted)', flexShrink: 0 }}>
              {formatBytes(a.size)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export interface WorkbenchDrawerProps {
  conversation?: ConversationSummary
  /** 兼容旧调用：传 conversationId 时从 store 自行解析会话。 */
  conversationId?: number
}

/** 右侧工作台抽屉：工作流与子代理 / 会话产物 / 插件 workbench.panel。 */
export function WorkbenchDrawer(props: WorkbenchDrawerProps) {
  const store = useHelmStore()
  const conversationId =
    props.conversation?.id ??
    props.conversationId ??
    (store.primaryTarget.kind === 'conversation'
      ? store.primaryTarget.conversationId
      : store.splitTarget?.kind === 'conversation'
        ? store.splitTarget.conversationId
        : undefined)
  const conversation = useMemo(() => {
    if (props.conversation !== undefined) return props.conversation
    if (conversationId === undefined) return undefined
    return (
      store.conversations.find((c) => c.id === conversationId) ?? store.conversationDetails[conversationId]
    )
  }, [props.conversation, conversationId, store.conversations, store.conversationDetails])
  const artifacts = conversationId !== undefined ? store.conversationArtifacts[conversationId] ?? [] : []
  const runs =
    conversationId !== undefined
      ? store.workflowRuns.filter((r) => r.conversationId === conversationId)
      : []
  const panels = conversation !== undefined ? store.groupedUi.workbenchPanels.filter((p) => matchesUiScope(conversation, p.spec.scope)) : []

  const tabs = useMemo(() => {
    const list: Array<{ id: string; label: string }> = [{ id: 'tasks', label: '工作流与子代理' }]
    list.push({ id: 'artifacts', label: `会话产物 (${artifacts.length})` })
    for (const p of panels) {
      list.push({ id: `plugin:${p.pluginId}/${p.spec.id}`, label: p.spec.label ?? p.spec.id })
    }
    return list
  }, [artifacts.length, panels])

  const activeTab = store.workbenchTab

  return (
    <aside className="helm-workbench">
      <div className="tabs-bar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab-btn${tab.id === activeTab ? ' tab-btn-active' : ''}`}
            onClick={() => store.setWorkbenchTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-ghost btn-sm workbench-close-btn"
          aria-label="关闭工作台"
          title="关闭工作台"
          style={{ width: 26, height: 26, padding: 0, flexShrink: 0 }}
          onClick={() => store.setWorkbenchOpen(false)}
        >
          <HelmIcon name="x" size={14} />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {conversationId === undefined ? (
          <div style={{ padding: '20px 14px', color: 'var(--fg-muted)', fontSize: 12, textAlign: 'center' }}>
            无活跃会话上下文
          </div>
        ) : activeTab === 'tasks' ? (
          <WorkflowInspector conversationId={conversationId} />
        ) : activeTab === 'artifacts' ? (
          <ArtifactsTab conversationId={conversationId} />
        ) : (
          <div style={{ padding: 10 }}>
            {(() => {
              const pluginTab = activeTab.slice('plugin:'.length)
              const matched = panels.find((p) => `${p.pluginId}/${p.spec.id}` === pluginTab)
              if (matched === undefined) {
                return (
                  <div style={{ color: 'var(--fg-muted)', fontSize: 12, textAlign: 'center', padding: 16 }}>
                    工作台页签不存在或对当前会话不可用
                  </div>
                )
              }
              return (
                <PluginUiView
                  pluginId={matched.pluginId}
                  spec={matched.spec}
                  conversationId={conversationId}
                  label={`面板 ${matched.spec.id}`}
                  slotProps={{ conversation: store.conversationDetails[conversationId] ?? store.conversations.find((c) => c.id === conversationId) }}
                />
              )
            })()}
          </div>
        )}
      </div>
      {(runs.length > 0 || artifacts.length > 0) && conversation !== undefined ? (
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', display: 'flex', gap: 6, fontSize: 11, color: 'var(--fg-muted)' }}>
          <span className="badge badge-neutral">工作流 {runs.length}</span>
          <span className="badge badge-neutral">产物 {artifacts.length}</span>
        </div>
      ) : null}
    </aside>
  )
}
