import { useEffect, useMemo } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { Tabs, TabsList, TabsTrigger } from '../ui/Tabs.js'
import { formatBytes } from '../lib/format.js'
import {
  buildWorkbenchFooter,
  resolveActiveWorkbenchTab,
} from './workbench-model.js'
import { useWorkbenchTabs } from './workbench-hooks.js'

function ArtifactsTab({ conversationId }: { conversationId: number }) {
  const store = useHelmStore()
  const artifacts = store.conversationArtifacts[conversationId] ?? []

  if (artifacts.length === 0) {
    return (
      <div className="empty-state empty-state-compact">
        <p className="empty-state-title">当前会话暂无产物</p>
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
  /** 仅传 ID 时从 store 读取会话。 */
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
  const tabs = useWorkbenchTabs(conversationId, conversation)
  const activeTab = resolveActiveWorkbenchTab(store.workbenchTab, tabs)
  const activePanel = tabs.find((tab) => tab.id === activeTab && tab.pluginId !== undefined)
  const footerParts = buildWorkbenchFooter(tabs)
  const { sseConnected, workbenchTab, setWorkbenchTab } = store
  useEffect(() => {
    // 首帧 UI 贡献和会话尚未返回时保留深链；确认不可用后才规范化 URL。
    if (sseConnected && conversation !== undefined && activeTab !== workbenchTab) setWorkbenchTab(activeTab)
  }, [sseConnected, conversation, activeTab, workbenchTab, setWorkbenchTab])

  return (
    <aside className="helm-workbench">
      <Tabs
        value={activeTab}
        onValueChange={(val) => store.setWorkbenchTab(val)}
        variant="underline"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <TabsList asChild>
          <div className="tabs-bar">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                className={`tab-btn${tab.id === activeTab ? ' tab-btn-active' : ''}`}
              >
                {tab.label}
                {tab.count > 0 && tab.id !== activeTab ? (
                  <span className={`badge ${tab.tone === 'warn' ? 'badge-warn' : tab.tone === 'accent' ? 'badge-accent' : 'badge-neutral'} tabular-nums`}>
                    {tab.count}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn-ghost btn-icon-sm workbench-close-btn"
              aria-label="关闭工作台"
              title="关闭工作台"
              onClick={() => store.setWorkbenchOpen(false)}
            >
              <HelmIcon name="x" size={14} />
            </button>
          </div>
        </TabsList>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {conversationId === undefined ? (
            <div className="empty-state empty-state-compact">
              <p className="empty-state-title">无活跃会话上下文</p>
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
            <div className="empty-state empty-state-compact">
              <p className="empty-state-title">工作台页签不存在或对当前会话不可用</p>
            </div>
          )}
        </div>
      </Tabs>
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
