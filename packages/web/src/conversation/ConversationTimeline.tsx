import React, { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AskSpec,
  ConversationAttachmentRef,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  ProfileStarterPrompt,
  ToolViewSpec,
} from '@helm/protocol'
import { artifactsApi, conversationsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { ToolActivityContext } from '../lib/tool-activity.js'
import { ToolActivityProvider } from './ToolActivityProvider.js'
import { CopyButton } from './CopyButton.js'
import { MarkdownView } from './MarkdownView.js'
import {
  buildTimelineItems,
  collectSiblingCalls,
  filterRewoundEntries,
  isAssistantTurnBusy,
  lastEditableHumanInput,
  toolSummaryText,
  type AssistantTurn,
  type DividerItem,
  type EditRequestTarget,
  type FoldableStep,
  type HumanInputItem,
  type PluginCardItem,
  type ToolTrace,
} from './timeline-model.js'
import { matchTimelineEntryActions, timelineEntryActionContextOf } from './action-model.js'
import { PluginMicroAction } from '../ui/PluginMicroAction.js'
import { Tooltip } from '../ui/Tooltip.js'
import { formatBytes, formatDurationMs, formatFullTimestamp, formatMessageTime } from '../lib/format.js'

export interface ConversationTimelineProps {
  conversation: ConversationSummary
  detailEntries: ReadonlyArray<ConversationEntry>
  live?: ConversationLive
  /** 发送请求在途且服务端尚未 working/blocked（轻量等待行，与 working 行互斥）。 */
  sendingPending?: boolean
  /** 请求将文本回填 Composer 并聚焦（编辑并重发；可携带历史 entryId 与附件）。 */
  onRequestEdit: (target: EditRequestTarget) => void
  /** 点击空白会话引导词：仅请求回填草稿，不是历史编辑。 */
  onRequestStarter?: (text: string) => void
  /** 当前会话 Profile 的引导词列表（空列表/未定义不渲染按钮）。 */
  starters?: ProfileStarterPrompt[]
}

// ---------------------------------------------------------------------------
// 附件渲染（图片缩略图 + 非图片芯片）
// ---------------------------------------------------------------------------

function AttachmentImage({ att, conversationId }: { att: ConversationAttachmentRef; conversationId: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const store = useHelmStore()

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    void artifactsApi
      .fetchBlob(att.id)
      .then((blob) => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
    return () => {
      active = false
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
    <span className="msg-attachments-wrap">
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

const QUEUED_MODE_LABEL: Record<'steer' | 'followUp', { icon: string; text: string }> = {
  steer: { icon: 'corner-down-right', text: '插话引导 · 待当前步骤后注入' },
  followUp: { icon: 'clock', text: '排队中 · 待当前回合结束后发送' },
}

function HumanMessage({
  item,
  conversation,
  anchorEntry,
  onRequestEdit,
}: {
  item: HumanInputItem
  conversation: ConversationSummary
  /** item.entryId 对应的真实持久化条目；queued（无持久锚点）时 undefined。 */
  anchorEntry?: ConversationEntry
  onRequestEdit: (target: EditRequestTarget) => void
}) {
  const store = useHelmStore()
  const [forking, setForking] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  // 插件微插槽 timeline.entry.action：按当前会话 scope + 真实 entry 的 kind/role 过滤；
  // queued（无持久锚点）或 id 不在当前详情集合内（分页窗口外）不渲染，绝不编造占位 entry。
  const entryActions =
    anchorEntry !== undefined
      ? matchTimelineEntryActions(
          store.groupedUi.timelineEntryActions,
          conversation,
          timelineEntryActionContextOf(anchorEntry),
        )
      : []

  const humanTime = formatMessageTime(item.createdAt)
  const humanFullTime = formatFullTimestamp(item.createdAt)
  const hasHumanTime = item.createdAt !== undefined && humanTime !== ''

  const editRequest = async (): Promise<void> => {
    // 仅人类输入可原地编辑：agent 汇报 / trigger 注入不是人类编辑对象（铅笔已收起，双重防御）
    if (item.origin !== 'human') return
    const attachments =
      item.attachments !== undefined && item.attachments.length > 0 ? { attachments: item.attachments } : {}
    if (item.queuedMode === undefined) {
      // 已落库历史消息：进入原地编辑；entryId 必须是合法正整数，
      // 非法锚点绝不静默降级为新消息（否则会把「编辑」错发成普通追加）。
      const numericId = Number(item.entryId)
      if (!Number.isSafeInteger(numericId) || numericId <= 0) {
        store.pushNotice({
          type: 'notification',
          level: 'error',
          title: '无法编辑该消息',
          body: `消息锚点无效（entryId=${item.entryId}），已取消编辑。`,
          conversationId: conversation.id,
        })
        return
      }
      onRequestEdit({ text: item.text, entryId: numericId, ...attachments })
      return
    }
    // 排队中消息：先撤回（若刚被置入执行则无缝衔接历史编辑）
    const subId = item.entryId.startsWith('queued:') ? item.entryId.slice('queued:'.length) : item.entryId
    setWithdrawing(true)
    try {
      const res = await conversationsApi.withdraw(conversation.id, subId)
      if (res.status === 'withdrawn') {
        onRequestEdit({ text: item.text, ...attachments })
      } else if ((res.status === 'already_placed' || res.status === 'settled') && res.entryId !== undefined) {
        onRequestEdit({ text: item.text, entryId: res.entryId, ...attachments })
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: '无法撤回排队消息',
          body: `提交已进入执行（status=${res.status}）`,
          conversationId: conversation.id,
        })
      }
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '撤回排队消息失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setWithdrawing(false)
    }
  }

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
    <div className="msg-human-row" tabIndex={0}>
      {item.queuedMode !== undefined ? (
        <span className="msg-origin-tag" role="status">
          <HelmIcon name={QUEUED_MODE_LABEL[item.queuedMode].icon} size={11} />
          {QUEUED_MODE_LABEL[item.queuedMode].text}
        </span>
      ) : item.origin !== 'human' ? (
        <span className="msg-origin-tag">
          <HelmIcon name={item.origin === 'trigger' ? 'webhook' : 'bot'} size={11} />
          {ORIGIN_LABEL[item.origin] ?? item.origin}
        </span>
      ) : null}
      <div className={`msg-human-pill selectable${item.queuedMode !== undefined ? ' msg-human-pill-queued' : ''}`}>
        {item.text}
      </div>
      {item.attachments !== undefined && item.attachments.length > 0 ? (
        <AttachmentChips attachments={item.attachments} conversationId={conversation.id} />
      ) : null}
      <div className="msg-human-footer">
        <span className="msg-hover-bar">
          {anchorEntry !== undefined
            ? entryActions.map((action) => (
                <PluginMicroAction
                  key={`entry:${action.pluginId}/${action.spec.id}`}
                  action={action}
                  variant="hover"
                  conversationId={conversation.id}
                  entryId={anchorEntry.id}
                  slotProps={{ conversationId: conversation.id, entry: anchorEntry }}
                />
              ))
            : null}
          <CopyButton text={item.text} />
          {item.origin === 'human' ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={item.queuedMode !== undefined ? '撤回排队并编辑' : '编辑并重发'}
              aria-label={item.queuedMode !== undefined ? '撤回排队并编辑' : '编辑并重发'}
              disabled={withdrawing}
              onClick={() => void editRequest()}
            >
              <HelmIcon name={withdrawing ? 'loader' : 'edit'} size={12} className={withdrawing ? 'spin-slow' : undefined} />
            </button>
          ) : null}
          {item.queuedMode === undefined ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="从此消息分叉新会话"
              disabled={forking}
              onClick={() => void forkFromHere()}
            >
              <HelmIcon name={forking ? 'loader' : 'git-fork'} size={12} />
            </button>
          ) : null}
        </span>
        {hasHumanTime ? (
          <Tooltip content={`发送于 ${humanFullTime}`}>
            <span className="msg-time-meta" title={`发送于 ${humanFullTime}`}>{humanTime}</span>
          </Tooltip>
        ) : null}
      </div>
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

/** tool.view 完整标准 Props 构造（含 siblingCalls，供插件组件去重/续接计算）。 */
function buildToolViewProps(
  tool: ToolTrace,
  conversationId: number,
  siblingCalls: ReadonlyArray<import('@helm/protocol').ToolViewSiblingCall>,
): Record<string, unknown> {
  return {
    callId: tool.callId ?? '',
    toolName: tool.toolName,
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    status: tool.status === 'running' ? 'running' : tool.status === 'error' ? 'error' : 'done',
    ...(tool.resultText !== undefined ? { result: tool.resultText } : {}),
    ...(tool.structuredOutput !== undefined ? { structuredOutput: tool.structuredOutput } : {}),
    isError: tool.isError,
    ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
    ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
    ...(tool.artifactRef !== undefined ? { artifactRef: tool.artifactRef } : {}),
    conversationId,
    siblingCalls,
  }
}

function TraceRow({
  tool,
  conversationId,
  defaultOpen,
  siblingCalls,
}: {
  tool: ToolTrace
  conversationId: number
  defaultOpen: boolean
  /** 当前时间线内全部工具调用轻量摘要（透传给 tool.view 插件组件）。 */
  siblingCalls: ReadonlyArray<import('@helm/protocol').ToolViewSiblingCall>
}) {
  const [open, setOpen] = useState(defaultOpen)
  const store = useHelmStore()

  const rowFailed = Boolean(tool.isError)
  const right =
    tool.status === 'running'
      ? '运行中'
      : rowFailed && tool.durationMs === undefined
        ? '失败'
        : tool.durationMs !== undefined
          ? formatDurationMs(tool.durationMs)
          : tool.status === 'done'
            ? '完成'
            : ''
  const rowIcon = toolStatusIcon(tool)

  const inputJson = useMemo(() => {
    if (tool.input === undefined) return undefined
    try {
      return JSON.stringify(tool.input, null, 2)
    } catch {
      return String(tool.input)
    }
  }, [tool.input])

  // 命中插件 tool.view：replaceRow=true 时插件组件完全替换默认工具行；
  // 未设置时保持外层 trace-row + 下方 trace-toolview 的默认双栏形态。
  const toolView = tool.toolView
  const replaceRow = toolView !== undefined && (toolView.spec as ToolViewSpec).replaceRow === true

  return (
    <div className={`trace-entry${rowFailed ? ' trace-entry-error' : ''}`}>
      {toolView !== undefined && replaceRow ? (
        <div className="trace-block">
          <PluginUiView
            pluginId={toolView.pluginId}
            spec={toolView.spec}
            conversationId={conversationId}
            label={`工具视图 ${tool.toolName}`}
            slotProps={buildToolViewProps(tool, conversationId, siblingCalls)}
          />
        </div>
      ) : (
        <>
          <div
            className={`trace-row${rowFailed ? ' trace-row-error' : ''}`}
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
                name={rowIcon}
                size={12}
                className={tool.status === 'running' ? 'spin-slow' : undefined}
              />
              <span className="trace-tool-name">{tool.toolName}</span>
              <span className="trace-tool-summary">{toolSummaryText(tool.toolName, tool.input)}</span>
            </span>
            <span className="trace-row-right">{right}</span>
          </div>
          {toolView !== undefined ? (
            <div className="trace-toolview">
              <PluginUiView
                pluginId={toolView.pluginId}
                spec={toolView.spec}
                conversationId={conversationId}
                label={`工具视图 ${tool.toolName}`}
                slotProps={buildToolViewProps(tool, conversationId, siblingCalls)}
              />
            </div>
          ) : null}
          {open ? (
            <div className="trace-expanded-body selectable">
              {inputJson !== undefined ? (
                <div>
                  <div className="trace-section-label">入参</div>
                  <pre className="code-block-pre code-block-pre-flush">
                    <code>{inputJson}</code>
                  </pre>
                </div>
              ) : null}
              {tool.resultText !== undefined ? (
                <div>
                  <div className="trace-section-label">输出</div>
                  <pre className="code-block-pre code-block-pre-flush">
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
        </>
      )}
    </div>
  )
}

function StepGroup({
  steps,
  active,
  conversationId,
  siblingCalls,
}: {
  steps: FoldableStep[]
  active: boolean
  conversationId: number
  siblingCalls: ReadonlyArray<import('@helm/protocol').ToolViewSiblingCall>
}) {
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const prevActiveRef = useRef(active)
  if (prevActiveRef.current !== active) {
    prevActiveRef.current = active
    if (!active && userOverride !== null) {
      setUserOverride(null)
    }
  }
  const open = userOverride ?? active

  return (
    <div className="trace-group">
      <button
        type="button"
        className="trace-group-summary"
        onClick={() => setUserOverride(!open)}
        title="展开 / 收起思考与执行过程"
      >
        <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        {active ? <HelmIcon name="loader" size={11} className="spin-slow" /> : null}
        {active ? `正在思考与执行 (${steps.length} 步)…` : `思考与执行过程 (${steps.length} 步)`}
      </button>
      {open ? (
        <div className="trace-group-steps">
          {steps.map((step, idx) =>
            step.kind === 'thinking' ? (
              <ThinkingRow key={`think:${idx}`} text={step.thinking.text} />
            ) : (
              <TraceRow
                key={step.tool.key}
                tool={step.tool}
                conversationId={conversationId}
                defaultOpen={false}
                siblingCalls={siblingCalls}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(true)
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
          <pre className="code-block-pre code-block-pre-flush">
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
    <div className="context-divider-wrap">
      <div className="context-divider">
        <span className="context-divider-label">
          <HelmIcon name={item.divider === 'reset' ? 'rotate-ccw' : 'archive'} size={11} />
          {item.divider === 'reset' ? '上下文已重置' : '上下文已精简'}
        </span>
      </div>
      {item.handoff !== undefined ? (
        <button
          type="button"
          className="trace-group-summary context-divider-handoff-btn"
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
    <div className="trace-expanded-body selectable trace-expanded-body-flush">
      <div className="trace-section-label">交接摘要</div>
      <pre className="code-block-pre code-block-pre-flush">
        <code>{item.handoff}</code>
      </pre>
    </div>
  )
}

function PluginCard({ item, conversationId }: { item: PluginCardItem; conversationId: number }) {
  const store = useHelmStore()
  const conversation = store.conversations.find((c) => c.id === conversationId)
  // timeline.renderer 自定义条目同样消费 timeline.entry.action：真实 entry kind 匹配；
  // 自定义 kind 无 user/assistant 角色，声明 roles 的动作不命中。
  const entryActions =
    conversation !== undefined
      ? matchTimelineEntryActions(
          store.groupedUi.timelineEntryActions,
          conversation,
          timelineEntryActionContextOf(item.entry),
        )
      : []
  return (
    <div className="plugin-card">
      <PluginUiView
        pluginId={item.renderer.pluginId}
        spec={item.renderer.spec}
        conversationId={conversationId}
        label="时间线卡片"
        slotProps={{ entry: item.entry, conversationId }}
      />
      {entryActions.length > 0 ? (
        <span className="plugin-card-hover-bar">
          {entryActions.map((action) => (
            <PluginMicroAction
              key={`entry:${action.pluginId}/${action.spec.id}`}
              action={action}
              variant="hover"
              conversationId={conversationId}
              entryId={item.entry.id}
              slotProps={{ conversationId, entry: item.entry }}
            />
          ))}
        </span>
      ) : null}
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
          <HelmIcon name="check-circle" size={12} />
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
// timeline.entry.action 真实锚点解析：从 detailEntries（props 实参）按
// 归一化 item 的 entryId / entryIds 定位真实 ConversationEntry，不查 store、
// 不编造占位。
// ---------------------------------------------------------------------------

function buildActiveEntryIndex(entries: ReadonlyArray<ConversationEntry>): Map<string, ConversationEntry> {
  const index = new Map<string, ConversationEntry>()
  for (const entry of filterRewoundEntries(entries)) index.set(entry.id, entry)
  return index
}

function hasAssistantText(entry: ConversationEntry): boolean {
  if (!Array.isArray(entry.model)) return false
  for (const msg of entry.model) {
    if ((msg as { role?: unknown } | null)?.role !== 'assistant') continue
    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        (block as { type?: unknown } | null)?.type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string' &&
        (block as { text: string }).text !== ''
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * assistant 回合 action 锚点：优先取最后一个携带 assistant 正文文本块的
 * pi.assistant 条目（与 hover 条复制语义同载体）；全无则退回最后一个
 * pi.assistant（含纯 toolCall 载体）；回合仅有工具条目（live 起步）时
 * undefined——绝不拿 pi.tool-result 伪造。
 */
function resolveAssistantAnchorEntry(
  entryIds: ReadonlyArray<string>,
  entriesById: ReadonlyMap<string, ConversationEntry>,
): ConversationEntry | undefined {
  let lastAssistant: ConversationEntry | undefined
  let lastTextEntry: ConversationEntry | undefined
  for (const id of entryIds) {
    const entry = entriesById.get(id)
    if (entry === undefined || entry.kind !== 'pi.assistant') continue
    lastAssistant = entry
    if (hasAssistantText(entry)) lastTextEntry = entry
  }
  return lastTextEntry ?? lastAssistant
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
  useEffect(() => { if (h === null) lastHandledRef.current = null }, [h])
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

interface AssistantTurnViewProps {
  turn: AssistantTurn
  conversation: ConversationSummary
  siblingCalls: ReadonlyArray<import('@helm/protocol').ToolViewSiblingCall>
  isLatestTurn?: boolean
  /** 回合锚点对应的真实持久化 pi.assistant 条目（见 resolveAssistantAnchorEntry）。 */
  anchorEntry?: ConversationEntry
}

function AssistantTurnView(props: AssistantTurnViewProps) {
  return <ToolActivityProvider><AssistantTurnContent {...props} /></ToolActivityProvider>
}

function AssistantTurnContent({ turn, conversation, siblingCalls, isLatestTurn = false, anchorEntry }: AssistantTurnViewProps) {
  const store = useHelmStore()
  const activeToolCallIds = useContext(ToolActivityContext)?.activeToolCallIds
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

  const isBusy = isAssistantTurnBusy(turn, conversation, { isLatestTurn, activeToolCallIds })
  // 插件微插槽 timeline.entry.action：锚点必须是真实持久化 pi.assistant 条目；
  // live 回合（尚无落库锚点）不渲染，绝不拿 pi.tool-result 或 key 伪造。
  const entryActions =
    !isBusy && anchorEntry !== undefined
      ? matchTimelineEntryActions(
          store.groupedUi.timelineEntryActions,
          conversation,
          timelineEntryActionContextOf(anchorEntry),
        )
      : []

  const timeMs = turn.settledAt ?? turn.startedAt
  const displayTime = formatMessageTime(timeMs)
  const durationText = turn.durationMs !== undefined && turn.durationMs > 0 ? formatDurationMs(turn.durationMs) : ''
  const hasTimeInfo = !isBusy && (displayTime !== '' || durationText !== '')
  const fullTimestamp = formatFullTimestamp(timeMs)
  let tooltipText = ''
  if (fullTimestamp !== '' && durationText !== '') {
    tooltipText = `完成于 ${fullTimestamp} · 耗时 ${durationText}`
  } else if (fullTimestamp !== '') {
    tooltipText = `完成于 ${fullTimestamp}`
  } else if (durationText !== '') {
    tooltipText = `耗时 ${durationText}`
  }

  const showHoverBar = !isBusy && (lastText !== '' || turn.entryIds.length > 0)

  return (
    <div className="msg-ai-block" tabIndex={0}>
      {turn.segments.map((seg) => {
        if (seg.kind === 'text') {
          return <MarkdownView key={seg.key} text={seg.text} conversationId={conversation.id} />
        }
        if (seg.kind === 'step-group') {
          return (
            <StepGroup
              key={seg.key}
              steps={seg.steps}
              active={seg.active === true}
              conversationId={conversation.id}
              siblingCalls={siblingCalls}
            />
          )
        }
        return (
          <TraceRow
            key={seg.key}
            tool={seg.tool}
            conversationId={conversation.id}
            defaultOpen={false}
            siblingCalls={siblingCalls}
          />
        )
      })}
      {turn.live ? (
        <span className="msg-origin-tag">
          <HelmIcon name="loader" size={11} className="spin-slow" />
          正在等待响应…
        </span>
      ) : null}
      {hasTimeInfo || showHoverBar ? (
        <div className="msg-ai-footer">
          {hasTimeInfo ? (
            <Tooltip content={tooltipText}>
              <span className="msg-time-meta" title={tooltipText}>
                {displayTime !== '' ? <span>{displayTime}</span> : null}
                {displayTime !== '' && durationText !== '' ? <span className="msg-time-sep">·</span> : null}
                {durationText !== '' ? <span>耗时 {durationText}</span> : null}
              </span>
            </Tooltip>
          ) : null}
          {showHoverBar ? (
            <span className="msg-hover-bar">
              {anchorEntry !== undefined
                ? entryActions.map((action) => (
                    <PluginMicroAction
                      key={`entry:${action.pluginId}/${action.spec.id}`}
                      action={action}
                      variant="hover"
                      conversationId={conversation.id}
                      entryId={anchorEntry.id}
                      slotProps={{ conversationId: conversation.id, entry: anchorEntry }}
                    />
                  ))
                : null}
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
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 回合失败诊断（当前未清除失败的内联展示；随下一回合开始自动消失）
// ---------------------------------------------------------------------------

/** 失败回合内联诊断块：内容来自 ConversationSummary.lastError（同一权威状态源），
 * 不新增持久化 timeline item；lastError 空缺时只给明确通用文案，绝不编造详情。 */
function TurnErrorNotice({
  conversation,
  detailEntries,
  onRequestEdit,
}: {
  conversation: ConversationSummary
  detailEntries: ReadonlyArray<ConversationEntry>
  onRequestEdit: (target: EditRequestTarget) => void
}) {
  // 最近一条可编辑的人类输入：复用与 Composer ↑ 相同的安全解析（校验 entryId、
  // 不跨 reset 边界、复用已有 attachments）；无法可靠定位则不提供快捷操作，
  // 绝不误编辑旧消息。
  const editTarget = useMemo(() => lastEditableHumanInput(detailEntries), [detailEntries])
  return (
    <div className="jr-callout jr-callout-err" role="alert" aria-label="本回合失败">
      <HelmIcon name="alert-triangle" size={12} />
      <span className="callout-text">
        本回合失败：{conversation.lastError?.trim() || '模型或服务请求未成功，未产生回答。'}
        {editTarget !== undefined ? (
          <>
            {' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="编辑并重发最近一条消息"
              aria-label="编辑并重发最近一条消息"
              onClick={() => onRequestEdit(editTarget)}
            >
              <HelmIcon name="edit" size={12} />
              编辑并重发
            </button>
          </>
        ) : null}
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
  sendingPending = false,
  onRequestEdit,
  onRequestStarter,
  starters,
}: ConversationTimelineProps) {
  const store = useHelmStore()
  const [loadingOlder, setLoadingOlder] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const lastHumanKeyRef = useRef<string | undefined>(undefined)
  const highlightScrollRef = useHighlightScroll(conversation.id)
  const highlightClass = useEntryHighlight(conversation.id)

  const isWorking = conversation.status === 'working'
  const items = useMemo(
    () =>
      buildTimelineItems(detailEntries, {
        ...(live !== undefined ? { live } : {}),
        working: isWorking,
        timelineRenderers: store.groupedUi.timelineRenderers,
        toolViews: store.groupedUi.toolViews,
      }),
    [detailEntries, live, isWorking, store.groupedUi.timelineRenderers, store.groupedUi.toolViews],
  )

  // timeline.entry.action 锚点索引：以 props 传入的 detailEntries（经 rewind
  // 覆盖过滤，与渲染层同口径）定位真实 ConversationEntry。
  const activeEntriesById = useMemo(() => buildActiveEntryIndex(detailEntries), [detailEntries])

  const hasLiveTurn = items.some((item) => item.kind === 'assistant' && item.live)
  const resolvedAsks = store.resolvedAsksByConv[conversation.id] ?? []

  // 全量工具调用轻量摘要：一次性收集，透传给每个 tool.view 插件组件
  //（siblingCalls 供其自行计算同目标多次调用折叠 / resume 续接关系）。
  const siblingCalls = useMemo(() => collectSiblingCalls(items), [items])

  const lastAssistantKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === 'assistant') return items[i]!.key
    }
    return undefined
  }, [items])

  // 贴底吸附：仅当用户主动上滚时脱离贴底（内容增长导致 scrollHeight 变大不得误判为脱离）。
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onScroll = (): void => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      if (el.scrollTop < lastScrollTopRef.current - 4 && distanceFromBottom > 80) {
        stickToBottomRef.current = false
      } else if (distanceFromBottom <= 80) {
        stickToBottomRef.current = true
      }
      lastScrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 监听内部容器高度变化（思考流式增长、命令追加、分组自动展开/收起），贴底状态下实时跟随到底部。
  useEffect(() => {
    const inner = innerRef.current
    if (inner === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current
      if (el === null || !stickToBottomRef.current) return
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (store.highlightedEntry?.conversationId === conversation.id) stickToBottomRef.current = false
  }, [store.highlightedEntry, conversation.id])

  const lastHumanKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === 'human') return items[i]!.key
    }
    return undefined
  }, [items])

  const lastTurnSummary = useMemo(() => {
    const last = items[items.length - 1]
    if (last?.kind !== 'assistant') return ''
    return last.segments
      .map((s) => (s.kind === 'step-group' ? `g:${s.stepCount}:${s.active ? 1 : 0}` : s.kind === 'tool' ? `t:${s.tool.key}:${s.tool.status}` : `x:${s.text.length}`))
      .join(',')
  }, [items])

  const contentFingerprint = `${items.length}:${detailEntries.length}:${conversation.status}:${lastTurnSummary}:${live?.updatedAt ?? 0}:${live?.thinking?.length ?? 0}:${live?.text.length ?? 0}:${live?.queuedInputs?.map((q) => `${q.id}:${q.mode}`).join(',') ?? ''}:${resolvedAsks.length}`
  useEffect(() => {
    if (lastHumanKey !== undefined && lastHumanKey !== lastHumanKeyRef.current) {
      lastHumanKeyRef.current = lastHumanKey
      stickToBottomRef.current = true
    }
    const el = scrollRef.current
    if (el !== null && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
    }
  }, [contentFingerprint, lastHumanKey])

  const loading = store.conversationDetails[conversation.id] === undefined

  // 引导词仅出现在「确实空白」的会话：历史已加载完且无更早分页、无在途
  // 发送/运行、无排队输入与待审批。任一不满足都不渲染，避免误判。
  const conversationDetail = store.conversationDetails[conversation.id]
  const startersVisible =
    starters !== undefined &&
    starters.length > 0 &&
    onRequestStarter !== undefined &&
    !loading &&
    conversationDetail?.nextCursor === undefined &&
    !isWorking &&
    conversation.status !== 'blocked' &&
    !sendingPending &&
    (live?.queuedInputs?.length ?? 0) === 0 &&
    items.length === 0 &&
    resolvedAsks.length === 0

  return (
    <div ref={scrollRef} className="timeline-scroll">
      {store.conversationDetails[conversation.id]?.nextCursor && (
        <button className="btn btn-ghost btn-sm" disabled={loadingOlder} onClick={() => {
          stickToBottomRef.current = false
          const height = scrollRef.current?.scrollHeight ?? 0
          const top = scrollRef.current?.scrollTop ?? 0
          setLoadingOlder(true)
          void store.loadEarlierEntries(conversation.id).finally(() => {
            setLoadingOlder(false)
            requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = top + scrollRef.current.scrollHeight - height })
          })
        }}>{loadingOlder ? '正在加载历史…' : '加载更早的消息'}</button>
      )}
      {store.loadErrors[`history:${conversation.id}`] && <p className="jr-callout jr-callout-err" role="alert">{store.loadErrors[`history:${conversation.id}`]}</p>}
      {loading ? (
        <div className="timeline-loading-state">
          <HelmIcon name="loader" size={14} className="spin-slow" />
          正在加载会话…
        </div>
      ) : null}
      {!loading && !sendingPending && !isWorking && items.length === 0 && resolvedAsks.length === 0 ? (
        <div className="timeline-empty-state">
          <HelmIcon name="message-square" size={22} />
          <span>向助理描述目标，或从左侧选择会话开始</span>
        </div>
      ) : null}
      {startersVisible ? (
        <div className="timeline-starters">
          {starters.map((starter, index) => (
            <button
              key={`starter-${index}-${starter.label}`}
              type="button"
              className="timeline-starter-btn"
              title={starter.prompt}
              onClick={() => onRequestStarter?.(starter.prompt)}
            >
              <HelmIcon name="corner-down-right" size={11} />
              <span className="timeline-starter-label">{starter.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div ref={innerRef} className="timeline-inner">
        {items.map((item) => {
          if (item.kind === 'human') {
            return (
              <div
                key={item.key}
                className={`timeline-human-wrap ${highlightClass(item.entryId)}`}
                ref={highlightScrollRef}
                data-entry-id={item.entryId}
              >
                <HumanMessage
                  item={item}
                  conversation={conversation}
                  anchorEntry={activeEntriesById.get(item.entryId)}
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
              <AssistantTurnView
                turn={item}
                conversation={conversation}
                siblingCalls={siblingCalls}
                anchorEntry={resolveAssistantAnchorEntry(item.entryIds, activeEntriesById)}
                isLatestTurn={item.key === lastAssistantKey}
              />
            </div>
          )
        })}
        {(isWorking && !hasLiveTurn) || (sendingPending && !isWorking) ? (
          <div className="msg-ai-block" role="status" aria-live="polite">
            <span className="msg-origin-tag">
              <HelmIcon name="loader" size={11} className="spin-slow" />
              正在等待响应…
            </span>
          </div>
        ) : null}
        {resolvedAsks.map(({ ask, status }) => (
          <ResolvedAskRow key={`ask:${ask.id}`} ask={ask} status={status} />
        ))}
        {conversation.status === 'error' ? (
          <TurnErrorNotice conversation={conversation} detailEntries={detailEntries} onRequestEdit={onRequestEdit} />
        ) : null}
      </div>
      <div ref={bottomRef} className="timeline-scroll-anchor" />
    </div>
  )
}
