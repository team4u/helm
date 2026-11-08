import { useMemo } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { matchesUiScope } from '../lib/types.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { formatBytes } from './timeline-model.js'
import { WorkflowRunCard } from './WorkflowRunCard.js'
import { conversationStatusLabel } from '../shell/sidebar-model.js'
import { filterStandaloneSubagents } from './workflow-card-model.js'

/** 窄屏抽屉覆盖模式（<=1200px）下点击导航类按钮后自动收起抽屉，避免遮挡背后视图。 */
function maybeCollapseWorkbench(store: { setWorkbenchOpen: (open: boolean) => void }): void {
  if (typeof window === 'undefined' || !window.matchMedia) return
  if (window.matchMedia('(max-width: 1200px)').matches) store.setWorkbenchOpen(false)
}

/** 子会话状态徽章样式（与 Sidebar 同语义）。 */
function conversationStatusBadge(status: ConversationSummary['status']): string {
  if (status === 'working') return 'badge-accent'
  if (status === 'blocked') return 'badge-warn'
  if (status === 'error') return 'badge-err'
  if (status === 'done') return 'badge-ok'
  return 'badge-neutral'
}

function WorkflowInspector({ conversationId }: { conversationId: number }) {
  const store = useHelmStore()
  const runs = useMemo(
    () => store.workflowRuns.filter((r) => r.conversationId === conversationId),
    [store.workflowRuns, conversationId],
  )
  // 独立子会话：未被任何 run 节点卡片认领（claimed）的子会话才在此列出，避免与卡片内 SubagentLiveCard 重复。
  const standaloneChildren = useMemo(
    () => filterStandaloneSubagents(store.conversations, conversationId, runs),
    [store.conversations, conversationId, runs],
  )
  const workflowRuns = runs.filter((r) => r.kind !== 'subagent')
  const subagentRuns = runs.filter((r) => r.kind === 'subagent')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
      {workflowRuns.length > 0 ? <div className="trace-section-label">工作流运行</div> : null}
      {workflowRuns.map((run) => (
        <WorkflowRunCard key={run.id} run={run} inWorkbench />
      ))}
      {subagentRuns.length > 0 ? <div className="trace-section-label">后台子代理任务</div> : null}
      {subagentRuns.map((run) => (
        <WorkflowRunCard key={run.id} run={run} inWorkbench />
      ))}
      {standaloneChildren.length > 0 ? (
        <>
          <div className="trace-section-label">独立子会话</div>
          <div className="list">
            {standaloneChildren.map((child) => (
              <div className="row" key={child.id}>
                <span>
                  <strong>{`#${child.id}`}</strong> {child.title}
                </span>
                <span className={`badge ${conversationStatusBadge(child.status)}`}>{conversationStatusLabel(child.status)}</span>
                <span style={{ display: 'inline-flex', gap: 6, flexShrink: 0 }}>
                  <button
                    className="btn btn-sm"
                    title="在主屏打开该子会话"
                    onClick={() => {
                      store.openTarget({ kind: 'conversation', conversationId: child.id })
                      maybeCollapseWorkbench(store)
                    }}
                  >
                    打开
                  </button>
                  <button
                    className="btn btn-sm workbench-split-btn"
                    title="在分屏并排打开该子会话"
                    onClick={() => {
                      store.openTarget({ kind: 'conversation', conversationId: child.id }, { split: true })
                      maybeCollapseWorkbench(store)
                    }}
                  >
                    并排查看
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {runs.length === 0 && standaloneChildren.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)' }}>当前会话暂无工作流或子代理。</p>
      ) : null}
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
