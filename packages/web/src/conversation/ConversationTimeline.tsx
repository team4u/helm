import React, { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AskSpec,
  ConversationAttachmentRef,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  WorkflowRunSummary,
} from '@helm/protocol'
import { artifactsApi, conversationsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { CopyButton } from './CopyButton.js'
import { WorkflowRunCard } from './WorkflowRunCard.js'
import { MarkdownView } from './MarkdownView.js'
import {
  buildTimelineItems,
  toolSummaryText,
  type AssistantTurn,
  type DividerItem,
  type EditRequestTarget,
  type FoldableStep,
  type HumanInputItem,
  type PluginCardItem,
  type ToolTrace,
} from './timeline-model.js'
import {
  collectLatestSubagentToolKeys,
  isAssistantTurnBusy,
  resolveSubagentConversationId,
  resolveSubagentExecutionMeta,
  resolveWorkflowRunForTool,
} from './subagent-model.js'
import { formatBytes, formatDurationMs } from '../lib/format.js'
import { SubagentLiveCard } from './SubagentLiveCard.js'
import { subagentBadge } from './subagent-live-model.js'

export interface ConversationTimelineProps {
  conversation: ConversationSummary
  detailEntries: ReadonlyArray<ConversationEntry>
  live?: ConversationLive
  /** 发送请求在途且服务端尚未 working/blocked（轻量等待行，与 working 行互斥）。 */
  sendingPending?: boolean
  /** 请求将文本回填 Composer 并聚焦（编辑并重发；可携带历史 entryId 与附件）。 */
  onRequestEdit: (target: EditRequestTarget) => void
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

const QUEUED_MODE_LABEL: Record<'steer' | 'followUp', { icon: string; text: string }> = {
  steer: { icon: 'corner-down-right', text: '插话引导 · 待当前步骤后注入' },
  followUp: { icon: 'clock', text: '排队中 · 待当前回合结束后发送' },
}

function HumanMessage({
  item,
  conversation,
  onRequestEdit,
}: {
  item: HumanInputItem
  conversation: ConversationSummary
  onRequestEdit: (target: EditRequestTarget) => void
}) {
  const store = useHelmStore()
  const [forking, setForking] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)

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
      <span className="msg-hover-bar">
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
  latestSubagentToolKeys,
}: {
  tool: ToolTrace
  conversationId: number
  defaultOpen: boolean
  /** 同一子会话仅最后一次 subagent 调用挂载实时卡；前序续接调用只留单行。 */
  latestSubagentToolKeys?: ReadonlyMap<number, string>
}) {
  const [open, setOpen] = useState(defaultOpen)
  const store = useHelmStore()

  // background: true 的 subagent 与 SubagentWorkflow 工具行状态必须跟随关联 run 的真实状态，
  // 绝不提前显示“完成”或把失败显示为成功。
  const isSubagent = tool.toolName === 'subagent'
  const { run: bgRun, worktree: bgWorktree } = isSubagent
    ? resolveSubagentExecutionMeta(tool, conversationId, store.workflowRuns)
    : {}
  const workflow = resolveWorkflowRunForTool(tool, conversationId, store.workflowRuns)
  const bgRunning = isSubagent && bgRun?.status === 'running'
  const bgFailed = isSubagent && (bgRun?.status === 'failed' || bgRun?.status === 'aborted')
  const wfRunning = workflow?.status === 'running'
  const wfFailed = workflow?.status === 'failed' || workflow?.status === 'aborted'
  const rowFailed = Boolean(tool.isError || bgFailed || wfFailed)

  const right = bgRunning
    ? '后台运行中'
    : wfRunning || tool.status === 'running'
      ? '运行中'
      : rowFailed && tool.durationMs === undefined
        ? workflow?.status === 'aborted' || bgRun?.status === 'aborted'
          ? '已中止'
          : '失败'
        : tool.durationMs !== undefined
          ? formatDurationMs(tool.durationMs)
          : tool.status === 'done'
            ? '完成'
            : ''
  const rowIcon = bgRunning || wfRunning ? 'loader' : rowFailed ? 'alert-circle' : toolStatusIcon(tool)

  const inputJson = useMemo(() => {
    if (tool.input === undefined) return undefined
    try {
      return JSON.stringify(tool.input, null, 2)
    } catch {
      return String(tool.input)
    }
  }, [tool.input])

  const subagentId = resolveSubagentConversationId(tool, conversationId, store.conversations)
  const subagentIdNum = subagentId !== undefined ? Number(subagentId) : undefined
  // 同一子会话被多次 resume：仅最后一次调用挂实时卡，前序调用降级为单行 + 续接标识。
  const isSupersededSubagent =
    subagentIdNum !== undefined &&
    latestSubagentToolKeys !== undefined &&
    latestSubagentToolKeys.get(subagentIdNum) !== undefined &&
    latestSubagentToolKeys.get(subagentIdNum) !== tool.key
  const hasLiveSubagentCard = subagentIdNum !== undefined && !isSupersededSubagent
  // 双横条去冗余：胶囊卡已承载工具行信息时不再重复渲染底部 trace-row；
  // 被续接的历史前序调用 / 无原生子会话的调用（外部卡 / 普通工具）仍保留单行。
  const hideToolRow = (hasLiveSubagentCard || workflow !== undefined) && tool.toolView === undefined

  return (
    <div className={`trace-entry${rowFailed ? ' trace-entry-error' : ''}`}>
      {workflow && <WorkflowRunCard run={workflow} toolCall={tool} />}
      {hasLiveSubagentCard ? (
        <SubagentLiveCard
          childConversationId={subagentIdNum!}
          toolStatus={tool.status}
          backgroundRun={bgRun}
          worktree={bgWorktree}
          toolCall={tool}
          toolSummary={{
            prompt: toolSummaryText(tool.toolName, tool.input),
            ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
            ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
            ...(tool.resultText !== undefined ? { resultText: tool.resultText } : {}),
            ...(rowFailed ? { isError: true } : {}),
          }}
        />
      ) : null}
      {subagentIdNum === undefined && (bgRun !== undefined || bgWorktree !== undefined) ? (
        <ExternalSubagentCard
          run={bgRun}
          worktree={bgWorktree}
          tool={tool}
        />
      ) : null}
      {!hideToolRow ? (
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
              className={bgRunning || tool.status === 'running' ? 'spin-slow' : undefined}
            />
            <span className="trace-tool-name">{tool.toolName}</span>
            <span className="trace-tool-summary">{toolSummaryText(tool.toolName, tool.input)}</span>
            {isSupersededSubagent && subagentIdNum !== undefined ? (
              <span className="badge badge-neutral">#{subagentIdNum} · 已在下文续接</span>
            ) : null}
          </span>
          <span className="trace-row-right">{right}</span>
        </div>
      ) : null}
      {tool.toolView !== undefined && <div className="trace-toolview"><PluginUiView
        pluginId={tool.toolView.pluginId}
        spec={tool.toolView.spec}
        conversationId={conversationId}
        label={`工具卡 ${tool.toolName}`}
        slotProps={{ callId: tool.callId, toolName: tool.toolName, input: tool.input, status: tool.status, result: tool.resultText, conversationId }}
      /></div>}
      {open && !hideToolRow ? (
        <div className="trace-expanded-body selectable">
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

/**
 * 外部运行时（如 Herdr 窗格）的后台任务摘要卡：无子会话时仍如实展示
 * 后台 run 节点/工作树/错误，不只更新工具图标而无卡片；绝不假造子会话。
 */
function ExternalSubagentCard({
  run,
  worktree,
  tool,
}: {
  run?: WorkflowRunSummary
  worktree?: { path: string; branch: string }
  tool: ToolTrace
}) {
  const nodes = run?.nodes ?? []
  const running = nodes.filter((n) => n.status === 'running').length
  const failed = nodes.find((n) => n.status === 'failed')
  const runError = run?.status === 'failed' || run?.status === 'aborted' ? (run.error ?? '后台执行失败') : undefined
  const badge = subagentBadge(undefined, run?.status === 'completed' ? 'done' : tool.status, run?.status)
  const active = badge.status === 'working'
  const failedState = badge.status === 'error'
  return (
    <div className="subagent-live-card subagent-external-card">
      <div className="subagent-live-header">
        <HelmIcon
          name={failedState ? 'alert-circle' : active ? 'loader' : 'bot'}
          size={13}
          className={active ? 'spin-slow' : undefined}
        />
        <span className="subagent-live-title">外部执行</span>
        {worktree !== undefined ? (
          <span className="badge badge-neutral subagent-worktree-badge" title={`隔离工作树：${worktree.path}`}>
            <HelmIcon name="git-branch" size={11} />
            {worktree.branch}
          </span>
        ) : null}
        <span className={`badge ${badge.badge}`}>{badge.label}</span>
      </div>
      <div className="subagent-live-stream subagent-external-body">
        {nodes.length > 0 ? (
          <div className="workflow-node-list">
            {nodes.map((n) => (
              <div key={n.id} className="workflow-node-line">
                <HelmIcon
                  name={n.status === 'running' ? 'loader' : n.status === 'failed' ? 'x' : n.status === 'done' ? 'check' : 'circle'}
                  size={11}
                  className={n.status === 'running' ? 'spin-slow' : undefined}
                />
                <span className="workflow-node-label">{n.label ?? n.id}</span>
                {n.executionId !== undefined ? <span className="subagent-external-exec">{n.executionId}</span> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="subagent-stream-line subagent-stream-empty">
            {run === undefined ? `外部执行${active ? '进行中' : failedState ? '异常' : '已结束'}（无子会话）` : `后台任务 ${run.id}`}
          </div>
        )}
        {runError !== undefined ? (
          <div className="subagent-stream-line subagent-stream-error subagent-bg-error" title={runError}>
            <HelmIcon name="alert-circle" size={11} />
            <span className="subagent-stream-body">后台执行失败：{runError}</span>
          </div>
        ) : null}
        {failed !== undefined && failed.error !== undefined ? (
          <div className="subagent-stream-line subagent-stream-error subagent-bg-error" title={failed.error}>
            <HelmIcon name="alert-circle" size={11} />
            <span className="subagent-stream-body">节点失败：{failed.error}</span>
          </div>
        ) : null}
        {running > 0 ? <div className="subagent-stream-line subagent-stream-empty">{running} 个节点执行中</div> : null}
      </div>
    </div>
  )
}

function StepGroup({
  steps,
  active,
  conversationId,
  latestSubagentToolKeys,
}: {
  steps: FoldableStep[]
  active: boolean
  conversationId: number
  latestSubagentToolKeys?: ReadonlyMap<number, string>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 8 }}>
          {steps.map((step, idx) =>
            step.kind === 'thinking' ? (
              <ThinkingRow key={`think:${idx}`} text={step.thinking.text} />
            ) : (
              <TraceRow
                key={step.tool.key}
                tool={step.tool}
                conversationId={conversationId}
                defaultOpen={false}
                latestSubagentToolKeys={latestSubagentToolKeys}
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
      <PluginUiView
        pluginId={item.renderer.pluginId}
        spec={item.renderer.spec}
        conversationId={conversationId}
        label="时间线卡片"
        slotProps={{ entry: item.entry, conversationId }}
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

function AssistantTurnView({
  turn,
  conversation,
  latestSubagentToolKeys,
  isLatestTurn = false,
}: {
  turn: AssistantTurn
  conversation: ConversationSummary
  latestSubagentToolKeys?: ReadonlyMap<number, string>
  isLatestTurn?: boolean
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

  const isBusy = isAssistantTurnBusy(turn, conversation, {
    isLatestTurn,
    workflowRuns: store.workflowRuns,
    conversations: store.conversations,
  })

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
              latestSubagentToolKeys={latestSubagentToolKeys}
            />
          )
        }
        return (
          <TraceRow
            key={seg.key}
            tool={seg.tool}
            conversationId={conversation.id}
            defaultOpen={false}
            latestSubagentToolKeys={latestSubagentToolKeys}
          />
        )
      })}
      {turn.live ? (
        <span className="msg-origin-tag">
          <HelmIcon name="loader" size={11} className="spin-slow" />
          正在等待响应…
        </span>
      ) : null}
      {!isBusy && (lastText !== '' || turn.entryIds.length > 0) ? (
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
      ) : null}
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

  const hasLiveTurn = items.some((item) => item.kind === 'assistant' && item.live)
  const resolvedAsks = store.resolvedAsksByConv[conversation.id] ?? []

  // 同一子会话被多次 resume：仅最后一次 subagent 调用挂实时卡，前序降级单行（已在下文续接）。
  const latestSubagentToolKeys = useMemo(
    () => collectLatestSubagentToolKeys(items, conversation.id, store.conversations),
    [items, conversation.id, store.conversations],
  )

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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '48px 0', color: 'var(--fg-muted)', fontSize: 12 }}>
          <HelmIcon name="loader" size={14} className="spin-slow" />
          正在加载会话…
        </div>
      ) : null}
      {!loading && !sendingPending && !isWorking && items.length === 0 && resolvedAsks.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '64px 0', color: 'var(--fg-muted)', fontSize: 12 }}>
          <HelmIcon name="message-square" size={22} />
          <span>向助理描述目标，或从左侧选择会话开始</span>
        </div>
      ) : null}
      <div ref={innerRef} className="timeline-inner">
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
              <AssistantTurnView
                turn={item}
                conversation={conversation}
                latestSubagentToolKeys={latestSubagentToolKeys}
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
      </div>
      <div ref={bottomRef} style={{ height: 2 }} />
    </div>
  )
}
