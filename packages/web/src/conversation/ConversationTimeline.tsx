import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AskSpec,
  ConversationAttachmentRef,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
} from '@helm/protocol'
import { artifactsApi, conversationsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { HelmSpecView } from '../ui/HelmSpecView.js'
import { CopyButton } from './CopyButton.js'
import { MarkdownView } from './MarkdownView.js'
import {
  buildTimelineItems,
  formatBytes,
  formatDurationMs,
  toolSummaryText,
  type AssistantTurn,
  type DividerItem,
  type FoldableStep,
  type HumanInputItem,
  type PluginCardItem,
  type ToolTrace,
} from './timeline-model.js'

export interface ConversationTimelineProps {
  conversation: ConversationSummary
  detailEntries: ReadonlyArray<ConversationEntry>
  live?: ConversationLive
  /** 请求将文本回填 Composer 并聚焦（编辑并重发）。 */
  onRequestEdit: (text: string) => void
}

// ---------------------------------------------------------------------------
// 附件渲染（图片缩略图 + 非图片芯片）
// ---------------------------------------------------------------------------

function AttachmentImage({ att, conversationId }: { att: ConversationAttachmentRef; conversationId: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const store = useHelmStore()

  useEffect(() => {
    let objectUrl: string | null = null
    void artifactsApi
      .fetchBlob(att.id)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
    return () => {
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [att.id])

  if (failed !== null) {
    return (
      <span className="attachment-chip" title={`图片加载失败：${failed}`}>
        <HelmIcon name="alert-triangle" size={11} />
        {att.name}
      </span>
    )
  }
  if (url === null) {
    return (
      <span className="attachment-chip">
        <HelmIcon name="loader" size={11} />
        {att.name}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="attachment-image-thumb"
      title={`点击放大：${att.name}`}
      onClick={() =>
        store.setActiveModal({ kind: 'artifact-preview', artifactId: att.id, conversationId })
      }
    >
      <img src={url} alt={att.name} loading="lazy" />
    </button>
  )
}

function AttachmentChips({
  attachments,
  conversationId,
}: {
  attachments: ConversationAttachmentRef[]
  conversationId: number
}) {
  const store = useHelmStore()
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
      {attachments.map((att) =>
        att.mimeType.startsWith('image/') ? (
          <AttachmentImage key={att.id} att={att} conversationId={conversationId} />
        ) : (
          <button
            key={att.id}
            type="button"
            className="attachment-chip"
            title={`预览 ${att.name}`}
            onClick={() =>
              store.setActiveModal({ kind: 'artifact-preview', artifactId: att.id, conversationId })
            }
          >
            <HelmIcon name="file-text" size={11} />
            <span>{att.name}</span>
            <span className="mono tabular-nums">{formatBytes(att.size)}</span>
          </button>
        ),
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// 人类消息胶囊
// ---------------------------------------------------------------------------

const ORIGIN_LABEL: Record<string, string> = {
  agent: '来自智能体汇报',
  trigger: '来自触发器',
}

function HumanMessage({
  item,
  conversation,
  onRequestEdit,
}: {
  item: HumanInputItem
  conversation: ConversationSummary
  onRequestEdit: (text: string) => void
}) {
  const store = useHelmStore()
  const [forking, setForking] = useState(false)

  const forkFromHere = async (): Promise<void> => {
    setForking(true)
    try {
      const forked = await conversationsApi.fork(conversation.id, item.entryId)
      store.openTarget({ kind: 'conversation', conversationId: forked.id }, { split: store.splitTarget === null })
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: '已创建分叉会话',
        body: `#${forked.id} ${forked.title}`,
        conversationId: forked.id,
      })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '分叉失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setForking(false)
    }
  }

  return (
    <div className="msg-human-row">
      {item.origin !== 'human' ? (
        <span className="msg-origin-tag">
          <HelmIcon name={item.origin === 'trigger' ? 'webhook' : 'bot'} size={11} />
          {ORIGIN_LABEL[item.origin] ?? item.origin}
        </span>
      ) : null}
      <div className="msg-human-pill selectable">{item.text}</div>
      {item.attachments !== undefined && item.attachments.length > 0 ? (
        <AttachmentChips attachments={item.attachments} conversationId={conversation.id} />
      ) : null}
      <span className="msg-hover-bar">
        <CopyButton text={item.text} />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title="编辑并重发"
          onClick={() => onRequestEdit(item.text)}
        >
          <HelmIcon name="edit" size={12} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title="从此消息分叉新会话"
          disabled={forking}
          onClick={() => void forkFromHere()}
        >
          <HelmIcon name={forking ? 'loader' : 'git-fork'} size={12} />
        </button>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 工具单行轨迹
// ---------------------------------------------------------------------------

function toolStatusIcon(tool: ToolTrace): string {
  if (tool.status === 'running') return 'loader'
  if (tool.isError) return 'x'
  if (tool.status === 'done') return 'check'
  return 'circle'
}

function TraceRow({
  tool,
  conversationId,
  defaultOpen,
}: {
  tool: ToolTrace
  conversationId: number
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const store = useHelmStore()

  const right =
    tool.status === 'running'
      ? '运行中'
      : tool.durationMs !== undefined
        ? formatDurationMs(tool.durationMs)
        : tool.isError
          ? '失败'
          : tool.status === 'done'
            ? '完成'
            : ''

  const inputJson = useMemo(() => {
    if (tool.input === undefined) return undefined
    try {
      return JSON.stringify(tool.input, null, 2)
    } catch {
      return String(tool.input)
    }
  }, [tool.input])

  return (
    <div className={`trace-entry${tool.isError ? ' trace-entry-error' : ''}`}>
      <div
        className={`trace-row${tool.isError ? ' trace-row-error' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((v) => !v)
          }
        }}
      >
        <span className="trace-row-left">
          <HelmIcon
            name={toolStatusIcon(tool)}
            size={13}
            className={tool.status === 'running' ? 'spin-slow' : undefined}
          />
          <span className="trace-tool-name">{tool.toolName}</span>
          <span className="trace-tool-summary">{toolSummaryText(tool.toolName, tool.input)}</span>
        </span>
        <span className="trace-row-right">{right}</span>
      </div>
      {open ? (
        <div className="trace-expanded-body selectable">
          {tool.toolView !== undefined ? (
            <div className="trace-toolview">
              <HelmSpecView
                pluginId={tool.toolView.pluginId}
                spec={tool.toolView.spec.json}
                docs={tool.toolView.spec.docs}
                conversationId={conversationId}
              />
            </div>
          ) : null}
          {inputJson !== undefined ? (
            <div>
              <div className="trace-section-label">入参</div>
              <pre className="code-block-pre" style={{ padding: 0 }}>
                <code>{inputJson}</code>
              </pre>
            </div>
          ) : null}
          {tool.resultText !== undefined ? (
            <div>
              <div className="trace-section-label">输出</div>
              <pre className="code-block-pre" style={{ padding: 0 }}>
                <code>{tool.resultText}</code>
              </pre>
            </div>
          ) : null}
          {tool.artifactRef !== undefined ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() =>
                store.setActiveModal({
                  kind: 'artifact-preview',
                  artifactId: tool.artifactRef!,
                  conversationId,
                })
              }
            >
              <HelmIcon name="external-link" size={12} />
              打开完整产物 #{tool.artifactRef}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function StepGroup({ steps, conversationId }: { steps: FoldableStep[]; conversationId: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="trace-group">
      <button
        type="button"
        className="trace-group-summary"
        onClick={() => setOpen((v) => !v)}
        title="展开 / 收起思考与执行过程"
      >
        <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        思考与执行过程 ({steps.length} 步)
      </button>
      {open ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 8 }}>
          {steps.map((step) =>
            step.kind === 'thinking' ? (
              <ThinkingRow key={step.thinking.key} text={step.thinking.text} />
            ) : (
              <TraceRow key={step.tool.key} tool={step.tool} conversationId={conversationId} defaultOpen={false} />
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="trace-group">
      <button
        type="button"
        className="trace-group-summary"
        onClick={() => setOpen((v) => !v)}
        title="展开 / 收起思考过程"
      >
        <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        思考过程
      </button>
      {open ? (
        <div className="trace-expanded-body selectable">
          <pre className="code-block-pre" style={{ padding: 0 }}>
            <code>{text}</code>
          </pre>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 分割线 / 插件卡片 / 历史审批
// ---------------------------------------------------------------------------

function ContextDivider({ item }: { item: DividerItem }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div className="context-divider">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <HelmIcon name={item.divider === 'reset' ? 'rotate-ccw' : 'archive'} size={11} />
          {item.divider === 'reset' ? '上下文已重置' : '上下文已精简'}
        </span>
      </div>
      {item.handoff !== undefined ? (
        <button
          type="button"
          className="trace-group-summary"
          style={{ margin: '0 auto', display: 'flex' }}
          onClick={() => setOpen((v) => !v)}
        >
          <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          {open ? '收起交接摘要' : '展开交接摘要'}
        </button>
      ) : null}
      {open && item.handoff !== undefined ? <ResetHandoffBody item={item} /> : null}
    </div>
  )
}

function ResetHandoffBody({ item }: { item: DividerItem }) {
  if (item.handoff === undefined) return null
  return (
    <div className="trace-expanded-body selectable" style={{ marginLeft: 0 }}>
      <div className="trace-section-label">交接摘要</div>
      <pre className="code-block-pre" style={{ padding: 0 }}>
        <code>{item.handoff}</code>
      </pre>
    </div>
  )
}

function PluginCard({ item, conversationId }: { item: PluginCardItem; conversationId: number }) {
  return (
    <div className="plugin-card">
      <HelmSpecView
        pluginId={item.renderer.pluginId}
        spec={item.renderer.spec.json}
        docs={item.renderer.spec.docs}
        conversationId={conversationId}
      />
    </div>
  )
}

const RESOLVED_ASK_LABEL: Record<string, string> = {
  answered: '已批准',
  cancelled: '已取消',
  superseded: '已由终端处理 (superseded)',
}

function ResolvedAskRow({ ask, status }: { ask: AskSpec; status: 'answered' | 'cancelled' | 'superseded' }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="trace-entry">
      <div className="trace-row" role="button" tabIndex={0} onClick={() => setOpen((v) => !v)}>
        <span className="trace-row-left">
          <HelmIcon name="check-circle" size={13} />
          <span className="trace-tool-name">审批</span>
          <span className="trace-tool-summary">{ask.title}</span>
        </span>
        <span className="trace-row-right">{RESOLVED_ASK_LABEL[status] ?? status}</span>
      </div>
      {open ? (
        <div className="trace-expanded-body selectable">
          {ask.description !== undefined ? <span>{ask.description}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 高亮定位
// ---------------------------------------------------------------------------

function useEntryHighlight(conversationId: number): (entryId: string) => string {
  const store = useHelmStore()
  return (entryId: string): string => {
    const h = store.highlightedEntry
    return h !== null && h.conversationId === conversationId && h.entryId === entryId
      ? ' entry-highlighted'
      : ''
  }
}

function useHighlightScroll(conversationId: number): (node: HTMLDivElement | null) => void {
  const store = useHelmStore()
  const h = store.highlightedEntry
  const lastHandledRef = useRef<string | null>(null)
  return (node: HTMLDivElement | null): void => {
    if (node === null || h === null) return
    if (h.conversationId !== conversationId) return
    const entryId = node.dataset.entryId
    if (entryId !== h.entryId) return
    const token = `${h.conversationId}:${h.entryId}`
    if (lastHandledRef.current === token) return
    lastHandledRef.current = token
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

// ---------------------------------------------------------------------------
// Assistant 回合
// ---------------------------------------------------------------------------

function AssistantTurnView({
  turn,
  conversation,
}: {
  turn: AssistantTurn
  conversation: ConversationSummary
}) {
  const store = useHelmStore()
  const [forking, setForking] = useState(false)
  const lastText = useMemo(() => {
    const texts = turn.segments.filter((s) => s.kind === 'text') as Array<{ kind: 'text'; text: string }>
    return texts.map((t) => t.text).join('\n\n')
  }, [turn.segments])

  const forkFromHere = async (): Promise<void> => {
    const entryId = turn.entryIds.length > 0 ? turn.entryIds[turn.entryIds.length - 1]! : undefined
    if (entryId === undefined) return
    setForking(true)
    try {
      const forked = await conversationsApi.fork(conversation.id, entryId)
      store.openTarget({ kind: 'conversation', conversationId: forked.id }, { split: store.splitTarget === null })
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: '已创建分叉会话',
        body: `#${forked.id} ${forked.title}`,
        conversationId: forked.id,
      })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '分叉失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setForking(false)
    }
  }

  return (
    <div className="msg-ai-block">
      {turn.segments.map((seg) => {
        if (seg.kind === 'text') {
          return <MarkdownView key={seg.key} text={seg.text} conversationId={conversation.id} />
        }
        if (seg.kind === 'step-group') {
          return <StepGroup key={seg.key} steps={seg.steps} conversationId={conversation.id} />
        }
        return <TraceRow key={seg.key} tool={seg.tool} conversationId={conversation.id} defaultOpen={false} />
      })}
      {turn.live ? (
        <span className="msg-origin-tag">
          <HelmIcon name="loader" size={11} className="spin-slow" />
          正在进行…
        </span>
      ) : null}
      <span className="msg-hover-bar">
        {lastText !== '' ? <CopyButton text={lastText} /> : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title="从此处分叉新会话"
          disabled={forking || turn.entryIds.length === 0}
          onClick={() => void forkFromHere()}
        >
          <HelmIcon name={forking ? 'loader' : 'git-fork'} size={12} />
        </button>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 主时间线
// ---------------------------------------------------------------------------

export function ConversationTimeline({
  conversation,
  detailEntries,
  live,
  onRequestEdit,
}: ConversationTimelineProps) {
  const store = useHelmStore()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const highlightScrollRef = useHighlightScroll(conversation.id)
  const highlightClass = useEntryHighlight(conversation.id)

  const items = useMemo(
    () =>
      buildTimelineItems(detailEntries, {
        ...(live !== undefined ? { live } : {}),
        timelineRenderers: store.groupedUi.timelineRenderers,
        toolViews: store.groupedUi.toolViews,
      }),
    [detailEntries, live, store.groupedUi.timelineRenderers, store.groupedUi.toolViews],
  )

  const resolvedAsks = store.resolvedAsksByConv[conversation.id] ?? []

  // 贴底吸附：用户上滚即脱离，新内容到达时仅在贴底状态自动跟随。
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onScroll = (): void => {
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const contentFingerprint = `${items.length}:${detailEntries.length}:${live?.updatedAt ?? 0}:${resolvedAsks.length}`
  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [contentFingerprint])

  const loading = store.conversationDetails[conversation.id] === undefined

  return (
    <div ref={scrollRef} className="timeline-scroll">
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '48px 0', color: 'var(--fg-muted)', fontSize: 12 }}>
          <HelmIcon name="loader" size={14} className="spin-slow" />
          正在加载会话…
        </div>
      ) : null}
      {!loading && items.length === 0 && resolvedAsks.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '64px 0', color: 'var(--fg-muted)', fontSize: 12 }}>
          <HelmIcon name="message-square" size={22} />
          <span>向助理描述目标，或从左侧选择会话开始</span>
        </div>
      ) : null}
      <div className="timeline-inner">
        {items.map((item) => {
          if (item.kind === 'human') {
            return (
              <div
                key={item.key}
                className={highlightClass(item.entryId)}
                ref={highlightScrollRef}
                data-entry-id={item.entryId}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}
              >
                <HumanMessage
                  item={item}
                  conversation={conversation}
                  onRequestEdit={onRequestEdit}
                />
              </div>
            )
          }
          if (item.kind === 'divider') {
            return (
              <div
                key={item.key}
                className={highlightClass(item.entryId)}
                ref={highlightScrollRef}
                data-entry-id={item.entryId}
              >
                <ContextDivider item={item} />
              </div>
            )
          }
          if (item.kind === 'plugin-card') {
            return (
              <div
                key={item.key}
                className={highlightClass(item.entryId)}
                ref={highlightScrollRef}
                data-entry-id={item.entryId}
              >
                <PluginCard item={item} conversationId={conversation.id} />
              </div>
            )
          }
          const anchorId = item.entryIds[0] ?? item.key
          return (
            <div
              key={item.key}
              className={highlightClass(anchorId)}
              ref={highlightScrollRef}
              data-entry-id={anchorId}
            >
              <AssistantTurnView turn={item} conversation={conversation} />
            </div>
          )
        })}
        {resolvedAsks.map(({ ask, status }) => (
          <ResolvedAskRow key={`ask:${ask.id}`} ask={ask} status={status} />
        ))}
      </div>
      <div ref={bottomRef} style={{ height: 2 }} />
    </div>
  )
}
