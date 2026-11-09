import { useMemo } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { matchesUiScope } from '../lib/types.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { formatBytes } from '../lib/format.js'
import {
  buildWorkbenchFooter,
  buildWorkbenchTabs,
  resolveActiveWorkbenchTab,
} from './workbench-model.js'

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

/** 右侧工作台抽屉：内置产物页签 + 插件 workbench.panel（动态排序与角标）。 */
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
  const artifactCount =
    conversationId !== undefined ? store.conversationArtifacts[conversationId]?.length ?? 0 : 0

  // 插件面板按会话 scope 过滤；内置产物页签恒在。
  const scopedPanels = useMemo(() => {
    const panels = conversation !== undefined
      ? store.groupedUi.workbenchPanels.filter((p) => matchesUiScope(conversation, p.spec.scope))
      : []
    return { workbenchPanels: panels }
  }, [conversation, store.groupedUi.workbenchPanels])

  const tabs = useMemo(
    () =>
      buildWorkbenchTabs({
        groupedUi: scopedPanels,
        pluginDocs: store.pluginDocs,
        artifactCount,
        conversationId,
      }),
    [scopedPanels, store.pluginDocs, artifactCount, conversationId],
  )
  const activeTab = resolveActiveWorkbenchTab(store.workbenchTab, tabs)
  const activePanel = tabs.find((tab) => tab.id === activeTab && tab.pluginId !== undefined)
  const footerParts = buildWorkbenchFooter(tabs)

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
            {tab.count > 0 && tab.id !== activeTab ? (
              <span className={`badge ${tab.tone === 'warn' ? 'badge-warn' : tab.tone === 'accent' ? 'badge-accent' : 'badge-neutral'} tabular-nums`}>
                {tab.count}
              </span>
            ) : null}
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
        ) : activeTab === 'artifacts' ? (
          <ArtifactsTab conversationId={conversationId} />
        ) : activePanel !== undefined && activePanel.spec !== undefined && activePanel.pluginId !== undefined ? (
          <div style={{ padding: 10 }}>
            <PluginUiView
              pluginId={activePanel.pluginId}
              spec={activePanel.spec}
              conversationId={conversationId}
              label={`工作台 ${activePanel.spec.label ?? activePanel.spec.id}`}
              slotProps={{ conversation: conversation ?? { id: conversationId } }}
            />
          </div>
        ) : (
          <div style={{ color: 'var(--fg-muted)', fontSize: 12, textAlign: 'center', padding: 16 }}>
            工作台页签不存在或对当前会话不可用
          </div>
        )}
      </div>
      {footerParts.length > 0 ? (
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', display: 'flex', gap: 6, fontSize: 11, color: 'var(--fg-muted)' }}>
          {footerParts.map((part) => (
            <span key={part} className="badge badge-neutral">{part}</span>
          ))}
        </div>
      ) : null}
    </aside>
  )
}
