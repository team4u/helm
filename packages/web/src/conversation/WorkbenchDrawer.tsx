import { useEffect, useId, useMemo, useState } from 'react'
import type { ArtifactMetadata, ConversationSummary } from '@helm/protocol'
import { HelmIcon, Dialog, DialogContent, DialogOverlay, DialogPortal, DialogTitle, Tabs, TabsList, TabsTrigger } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { Tooltip } from '../ui/Tooltip.js'
import { artifactsApi } from '../lib/api.js'
import { formatBytes, formatFullTimestamp, formatMessageTime } from '../lib/format.js'
import {
  artifactFormatLabel,
  artifactIconName,
  artifactKindLabel,
  buildWorkbenchFooter,
  isImageArtifact,
  partitionArtifactsByKind,
  resolveActiveWorkbenchTab,
} from './workbench-model.js'
import { useWorkbenchTabs } from './workbench-hooks.js'

function ArtifactThumb({ artifactId, filename }: { artifactId: string; filename: string }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)

  useEffect(() => {
    if (
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function' ||
      typeof URL.revokeObjectURL !== 'function'
    ) {
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    void artifactsApi.fetchBlob(artifactId, true)
      .then((blob) => {
        if (cancelled || !blob || blob.size === 0) return
        objectUrl = URL.createObjectURL(blob)
        setThumbUrl(objectUrl)
      })
      .catch(() => {
        /* 缩略图加载失败时保留默认图标占位 */
      })
    return () => {
      cancelled = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [artifactId])

  if (thumbUrl !== null) {
    return <img src={thumbUrl} alt={filename} className="artifact-card-img" loading="lazy" />
  }
  return <HelmIcon name="file" size={16} />
}

interface ArtifactCardProps {
  artifact: ArtifactMetadata
  compact?: boolean
  isDownloading: boolean
  onPreview: (artifact: ArtifactMetadata) => void
  onDownload: (artifact: ArtifactMetadata) => void
}

function ArtifactCard({
  artifact,
  compact = false,
  isDownloading,
  onPreview,
  onDownload,
}: ArtifactCardProps) {
  const formatLabel = artifactFormatLabel(artifact.mimeType, artifact.name)
  const timestamp = artifact.createdAt > 0 ? formatMessageTime(artifact.createdAt) : ''

  return (
    <div
      className={compact ? 'artifact-card artifact-card-compact' : 'artifact-card'}
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
    >
      <div className="artifact-card-thumb" aria-hidden="true">
        {!compact && isImageArtifact(artifact.mimeType) ? (
          <ArtifactThumb artifactId={artifact.id} filename={artifact.name} />
        ) : (
          <HelmIcon name={artifactIconName(artifact.mimeType, artifact.kind)} size={compact ? 14 : 16} />
        )}
      </div>
      <div className="artifact-card-main">
        <button
          type="button"
          className="artifact-card-title-btn"
          title={`预览 ${artifact.name}`}
          onClick={() => onPreview(artifact)}
        >
          <span className="artifact-card-name">{artifact.name}</span>
        </button>
        <div className="artifact-card-meta">
          <span className={artifact.kind === 'registered' ? 'badge badge-accent' : 'badge badge-neutral'}>
            {artifactKindLabel(artifact.kind)}
          </span>
          <span className="artifact-card-format">{formatLabel}</span>
          <span className="mono artifact-card-mime" title={artifact.mimeType}>{artifact.mimeType}</span>
          <span className="mono tabular-nums artifact-card-size">{formatBytes(artifact.size)}</span>
          {timestamp !== '' ? (
            <span className="artifact-card-time" title={formatFullTimestamp(artifact.createdAt)}>
              {timestamp}
            </span>
          ) : null}
        </div>
      </div>
      <div className="artifact-card-actions">
        <button
          type="button"
          className="btn btn-ghost btn-xs artifact-action-btn"
          aria-label={`预览 ${artifact.name}`}
          title="预览"
          onClick={() => onPreview(artifact)}
        >
          <HelmIcon name="eye" size={12} />
          <span>预览</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-xs artifact-action-btn"
          aria-label={`下载 ${artifact.name}`}
          title="下载"
          disabled={isDownloading}
          onClick={() => onDownload(artifact)}
        >
          <HelmIcon name={isDownloading ? 'loader' : 'download'} size={12} />
          <span>{isDownloading ? '下载中' : '下载'}</span>
        </button>
      </div>
    </div>
  )
}

function ArtifactsTab({ conversationId }: { conversationId: number }) {
  const store = useHelmStore()
  const rawArtifacts = store.conversationArtifacts[conversationId]
  const artifacts = useMemo(() => (Array.isArray(rawArtifacts) ? rawArtifacts : []), [rawArtifacts])
  const { deliverables, spills } = useMemo(() => partitionArtifactsByKind(artifacts), [artifacts])
  const [spillExpanded, setSpillExpanded] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const spillPanelId = useId()

  const handlePreview = (artifact: ArtifactMetadata) => {
    store.setActiveModal({ kind: 'artifact-preview', artifactId: artifact.id, conversationId })
  }

  const handleDownload = (artifact: ArtifactMetadata) => {
    setDownloadingId(artifact.id)
    void artifactsApi.downloadToBrowser(artifact.id, artifact.name)
      .catch((err) => {
        store.pushNotice({
          type: 'notification',
          level: 'error',
          title: '下载产物失败',
          body: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        setDownloadingId((current) => (current === artifact.id ? null : current))
      })
  }

  if (artifacts.length === 0) {
    return (
      <div className="empty-state empty-state-compact">
        <p className="empty-state-title">当前会话暂无产物</p>
      </div>
    )
  }

  return (
    <div className="workbench-artifacts-body">
      <section className="artifact-section" aria-label="正式产物">
        <div className="artifact-section-head">
          <span className="artifact-section-title">交付产物</span>
          <span className="badge badge-neutral tabular-nums">{deliverables.length}</span>
        </div>
        {deliverables.length === 0 ? (
          <div className="artifact-empty-hint">暂无注册产物或上传附件</div>
        ) : (
          <div className="artifact-card-list">
            {deliverables.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                isDownloading={downloadingId === artifact.id}
                onPreview={handlePreview}
                onDownload={handleDownload}
              />
            ))}
          </div>
        )}
      </section>

      {spills.length > 0 ? (
        <section className="artifact-spill-section" aria-label="超长工具输出快照">
          <button
            type="button"
            className="artifact-spill-toggle"
            aria-expanded={spillExpanded}
            aria-controls={spillPanelId}
            onClick={() => setSpillExpanded((v) => !v)}
          >
            <HelmIcon name={spillExpanded ? 'chevron-down' : 'chevron-right'} size={13} />
            <span className="artifact-spill-title">超长工具输出快照</span>
            <span className="badge badge-neutral tabular-nums">{spills.length}</span>
            <span className="artifact-spill-hint">{spillExpanded ? '收起' : '点击展开'}</span>
          </button>
          {spillExpanded ? (
            <div id={spillPanelId} className="artifact-spill-list">
              {spills.map((artifact) => (
                <ArtifactCard
                  key={artifact.id}
                  artifact={artifact}
                  compact
                  isDownloading={downloadingId === artifact.id}
                  onPreview={handlePreview}
                  onDownload={handleDownload}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

export interface WorkbenchDrawerProps {
  conversation?: ConversationSummary
  /** 仅传 ID 时从 store 读取会话。 */
  conversationId?: number
  /** 测试用内联渲染；生产环境默认 Portal 到 body，脱离主壳层叠上下文。 */
  inline?: boolean
}

/** 右侧工作台抽屉：内置产物页签 + 插件 workbench.panel（动态排序与角标）。 */
export function WorkbenchDrawer(props: WorkbenchDrawerProps) {
  const inline = props.inline ?? false
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
  const { sseConnected, workbenchTab, setWorkbenchTab, setWorkbenchOpen } = store
  useEffect(() => {
    // 首帧 UI 贡献和会话尚未返回时保留深链；确认不可用后才规范化 URL。
    if (sseConnected && conversation !== undefined && activeTab !== workbenchTab) setWorkbenchTab(activeTab)
  }, [sseConnected, conversation, activeTab, workbenchTab, setWorkbenchTab])

  return (
    <Dialog open inline={inline} onOpenChange={(open) => { if (!open) setWorkbenchOpen(false) }}>
      <DialogPortal inline={inline}>
        <DialogOverlay className="workbench-backdrop" aria-label="关闭工作台">
          <DialogContent className="helm-workbench" aria-label="工作台抽屉">
            <DialogTitle style={{ display: 'none' }}>工作台</DialogTitle>
            <Tabs
        value={activeTab}
        onValueChange={(val) => store.setWorkbenchTab(val)}
        variant="underline"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <TabsList asChild>
          <div className="tabs-bar">
            <div className="workbench-tabs-scroll">
              {tabs.map((tab) => (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  className={`tab-btn${tab.id === activeTab ? ' tab-btn-active' : ''}`}
                >
                  <span>{tab.label}</span>
                  {tab.count > 0 ? (
                    <span className={`badge ${tab.tone === 'warn' ? 'badge-warn' : tab.tone === 'accent' ? 'badge-accent' : 'badge-neutral'} tabular-nums`}>
                      {tab.count}
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </div>
            <Tooltip content="关闭工作台" side="left">
              <button
                type="button"
                className="btn btn-ghost btn-icon-sm workbench-close-btn"
                aria-label="关闭工作台"
                title="关闭工作台"
                onClick={() => store.setWorkbenchOpen(false)}
              >
                <HelmIcon name="x" size={14} />
              </button>
            </Tooltip>
          </div>
        </TabsList>
        <div className="workbench-body">
          {conversationId === undefined ? (
            <div className="empty-state empty-state-compact">
              <p className="empty-state-title">无活跃会话上下文</p>
            </div>
          ) : activeTab === 'artifacts' ? (
            <ArtifactsTab key={conversationId} conversationId={conversationId} />
          ) : activePanel !== undefined && activePanel.spec !== undefined && activePanel.pluginId !== undefined ? (
            <div className="workbench-plugin-body">
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
              <div className="workbench-footer">
                {footerParts.map((part) => (
                  <span key={part} className="badge badge-neutral">{part}</span>
                ))}
              </div>
            ) : null}
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
