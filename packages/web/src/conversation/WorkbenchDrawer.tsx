import { useMemo } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { matchesUiScope } from '../lib/types.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { formatBytes } from '../lib/format.js'
import { WorkflowRunCard } from './WorkflowRunCard.js'
import { SubagentLiveCard } from './SubagentLiveCard.js'
import { buildWorkbenchSubagentItems, summarizeWorkbenchTasks } from './workflow-card-model.js'

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
  // 子代理统一列表：单子代理后台 run 认领的子会话与独立子会话合并去重（Active-First），
  // 有子会话的后台单不再套进三层嵌套 WorkflowRunCard；无子会话的外部 run 仍由卡片渲染。
  const subagentItems = useMemo(
    () => buildWorkbenchSubagentItems(store.conversations, conversationId, runs),
    [store.conversations, conversationId, runs],
  )
  const taskSummary = useMemo(
    () => summarizeWorkbenchTasks(store.conversations, conversationId, runs),
    [store.conversations, conversationId, runs],
  )
  const workflowRuns = runs.filter((r) => r.kind !== 'subagent')
  const externalSubagentRuns = runs.filter(
    (r) => r.kind === 'subagent' && !(r.nodes ?? []).some((n) => n.conversationId !== undefined),
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
      {taskSummary.totalCount > 0 ? (
        <div className="workbench-fleet-bar tabular-nums">
          {taskSummary.activeCount > 0 ? <span className="workbench-fleet-item">{`${taskSummary.activeCount} 执行中`}</span> : null}
          {taskSummary.blockedCount > 0 ? <span className="workbench-fleet-item workbench-fleet-warn">{`${taskSummary.blockedCount} 等待审批`}</span> : null}
          {taskSummary.errorCount > 0 ? <span className="workbench-fleet-item workbench-fleet-err">{`${taskSummary.errorCount} 异常`}</span> : null}
          {taskSummary.doneCount > 0 ? <span className="workbench-fleet-item workbench-fleet-done">{`${taskSummary.doneCount} 已完成`}</span> : null}
        </div>
      ) : null}
      {workflowRuns.length > 0 ? <div className="trace-section-label">工作流运行</div> : null}
      {workflowRuns.map((run) => (
        <WorkflowRunCard key={run.id} run={run} inWorkbench onNavigate={() => maybeCollapseWorkbench(store)} />
      ))}
      {externalSubagentRuns.length > 0 ? <div className="trace-section-label">外部后台任务</div> : null}
      {externalSubagentRuns.map((run) => (
        <WorkflowRunCard key={run.id} run={run} inWorkbench onNavigate={() => maybeCollapseWorkbench(store)} />
      ))}
      {subagentItems.length > 0 ? (
        <>
          <div className="trace-section-label">子代理会话</div>
          {subagentItems.map((item) => (
            <SubagentLiveCard
              key={item.conversationId}
              childConversationId={item.conversationId}
              toolStatus={item.summary?.status === 'working' ? 'running' : item.summary?.status === 'error' ? 'error' : item.backgroundRun?.status === 'running' ? 'running' : item.backgroundRun?.status === 'failed' || item.backgroundRun?.status === 'aborted' ? 'error' : 'done'}
              backgroundRun={item.backgroundRun}
              onNavigate={() => maybeCollapseWorkbench(store)}
            />
          ))}
        </>
      ) : null}
      {runs.length === 0 && subagentItems.length === 0 ? (
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
  const taskSummary = useMemo(
    () =>
      conversationId !== undefined
        ? summarizeWorkbenchTasks(store.conversations, conversationId, runs)
        : { workflowCount: 0, subagentCount: 0, totalCount: 0, activeCount: 0, blockedCount: 0, errorCount: 0, doneCount: 0 },
    [store.conversations, conversationId, runs],
  )
  const panels = conversation !== undefined ? store.groupedUi.workbenchPanels.filter((p) => matchesUiScope(conversation, p.spec.scope)) : []

  const tabs = useMemo(() => {
    const list: Array<{ id: string; label: string }> = [{ id: 'tasks', label: `工作流与子代理 (${taskSummary.totalCount})` }]
    list.push({ id: 'artifacts', label: `会话产物 (${artifacts.length})` })
    for (const p of panels) {
      list.push({ id: `plugin:${p.pluginId}/${p.spec.id}`, label: p.spec.label ?? p.spec.id })
    }
    return list
  }, [artifacts.length, panels, taskSummary.totalCount])

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
      {(taskSummary.totalCount > 0 || artifacts.length > 0) && conversation !== undefined ? (
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', display: 'flex', gap: 6, fontSize: 11, color: 'var(--fg-muted)' }}>
          <span className="badge badge-neutral">{`工作流 ${taskSummary.workflowCount}`}</span>
          <span className="badge badge-neutral">{`子代理 ${taskSummary.subagentCount}`}</span>
          <span className="badge badge-neutral">{`产物 ${artifacts.length}`}</span>
        </div>
      ) : null}
    </aside>
  )
}
