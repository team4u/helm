/**
 * builtin:workflow 插件 client.tsx 组件（只导出组件，保 Fast Refresh 契约）：
 * - SubagentToolView：时间线内 subagent 工具调用的双层胶囊实时卡
 *   （多次 resume 折叠：仅同目标最后一次调用挂载实时流）；
 * - WorkflowToolView：时间线内 SubagentWorkflow 工具调用的工作流运行卡；
 * - WorkflowWorkbenchPanel：工作台面板（当前会话工作流运行 + 子代理列表）。
 *
 * 全部数据经 @helm/plugin-client 共享 hooks（usePluginDoc / useConversations /
 * useConversation）从宿主 store 响应式读取；动作经 ctx.callAction 走
 * POST /api/actions/builtin:workflow/<actionId>，无任何宿主私有依赖。
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps, WorkbenchPanelProps, WorkflowNodeState, WorkflowRunSummary } from '@helm/protocol'
import { usePluginContext, useConversation, useConversations, useToolActivity } from '@helm/plugin-client'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import {
  buildSubagentStatSegments,
  buildSubagentStreamLines,
  buildWorkbenchSubagentItems,
  buildWorkflowPhaseSections,
  canResumeWorkflowRun,
  extractWorkflowLogs,
  formatNodeOutputPreview,
  formatDurationMs,
  hasNodeExtraDetail,
  formatWorkflowNodeStats,
  isLatestSubagentCallForTarget,
  parentToolSummaryOf,
  resolveNodeSummaryText,
  resolveSubagentConversationId,
  resolveSubagentExecutionMeta,
  resolveSubagentHeaderSnippet,
  resolveSubagentTaskTitle,
  resolveWorkflowRunForTool,
  subagentBadge,
  toolResultPreviewTruncated,
} from './models.ts'
import { usePluginDoc, useStreamFollow, useElapsedNowMs } from './hooks.ts'
import { SPIN, RUN_LABEL, RUN_BADGE, NODE_LABEL, NODE_BADGE, PHASE_ICON } from './presentation.ts'

// ---------------------------------------------------------------------------
// 图标（lucide-react 线性矢量，与宿主共享同一实例；无 Emoji）
// ---------------------------------------------------------------------------

import { Bot, Check, ChevronDown, ChevronRight, Circle, Clock, CornerDownRight, ExternalLink, GitBranch, Loader2, RotateCw, Square, Terminal, X } from 'lucide-react'

function Icon({ name, size = 12, className }: { name: string; size?: number; className?: string }): ReactNode {
  const map: Record<string, typeof Bot> = {
    bot: Bot,
    check: Check,
    'check-circle': Check,
    'chevron-down': ChevronDown,
    'chevron-right': ChevronRight,
    circle: Circle,
    clock: Clock,
    'corner-down-right': CornerDownRight,
    'external-link': ExternalLink,
    'git-branch': GitBranch,
    loader: Loader2,
    'rotate-cw': RotateCw,
    square: Square,
    terminal: Terminal,
    x: X,
  }
  const Cmp = map[name] ?? Circle
  return <Cmp size={size} className={className} />
}

// ---------------------------------------------------------------------------
// 子代理双层胶囊卡（原 SubagentLiveCard 语义）
// ---------------------------------------------------------------------------

export function SubagentLiveCard(props: {
  childConversationId: number
  toolStatus: 'running' | 'done' | 'error' | 'unknown'
  backgroundRun?: WorkflowRunSummary
  worktree?: { path: string; branch: string }
  toolSummary?: { prompt?: string; startedAt?: number; durationMs?: number; resultText?: string; isError?: boolean }
  startedAt?: number
  /** 是否为缓存/历史重放任务。 */
  cached?: boolean
  /** 额外统计尾注（如工作流节点的模型与 token 统计）。 */
  extraStats?: string
  /** 展开态展示实时流与底部调用详情。 */
  expanded?: boolean
  callDetails?: Pick<ToolViewProps, 'input' | 'result' | 'artifactRef'>
}) {
  const ctx = usePluginContext()
  const { childConversationId, toolStatus, backgroundRun, worktree, toolSummary, startedAt } = props
  const conv = useConversation(childConversationId)
  const summary = conv.summary
  const detail = conv.detail
  const live = conv.live
  const pendingAsk = conv.pendingAsks[0]
  const detailError = conv.loadError

  const badge = subagentBadge(summary?.status, toolStatus, backgroundRun?.status)
  const isWorking = badge.status === 'working'

  // 运行中秒表：SSR 首帧不启动时钟（确定性渲染）。
  const nowMs = useElapsedNowMs(isWorking)

  const taskTitle = resolveSubagentTaskTitle(summary, childConversationId, toolSummary, backgroundRun)
  const statSegments = useMemo(
    () =>
      buildSubagentStatSegments({
        ...(summary !== undefined ? { summary } : {}),
        ...(detail?.entries !== undefined ? { entries: detail.entries } : {}),
        ...(live !== undefined ? { live } : {}),
        ...(backgroundRun !== undefined ? { backgroundRun } : {}),
        ...(toolSummary !== undefined ? { toolSummary } : {}),
        isWorking,
        startedAt,
        nowMs,
      }),
    [summary, detail?.entries, live, backgroundRun, toolSummary, isWorking, startedAt, nowMs],
  )
  const snippet = useMemo(
    () =>
      resolveSubagentHeaderSnippet({
        badgeStatus: badge.status,
        ...(summary !== undefined ? { summary } : {}),
        ...(live !== undefined ? { live } : {}),
        ...(detail?.entries !== undefined ? { entries: detail.entries } : {}),
        ...(pendingAsk !== undefined ? { pendingAsk } : {}),
        ...(backgroundRun !== undefined ? { backgroundRun } : {}),
        ...(toolSummary !== undefined ? { toolSummary } : {}),
        ...(detailError !== undefined ? { detailError } : {}),
      }),
    [badge.status, summary, live, detail?.entries, pendingAsk, backgroundRun, toolSummary, detailError],
  )

  // 隔离工作树：显式入参优先，其次回退后台 run 首个节点的 worktree。
  const wt = worktree ?? backgroundRun?.nodes?.find((n) => n.worktree !== undefined)?.worktree
  const streamLines = useMemo(
    () => (props.expanded === true && detail?.entries !== undefined ? buildSubagentStreamLines(detail.entries, live, badge.status === 'working') : []),
    [props.expanded, detail?.entries, live, badge.status],
  )

  const stream = useStreamFollow(streamLines)

  const cardClass = `subagent-live-card${badge.status === 'blocked' ? ' subagent-live-card-warn' : badge.status === 'error' || detailError !== undefined ? ' subagent-live-card-error' : ''}${props.expanded === true ? ' subagent-live-card-expanded' : ''}`

  const openChild = (): void => {
    ctx.openConversationDrawer(childConversationId)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`${cardClass} subagent-card-clickable`}
      aria-label={`打开子会话 #${childConversationId} 抽屉`}
      title={[taskTitle, summary?.profileId, wt?.branch, statSegments.join(' · '), '点击打开子会话抽屉'].filter(Boolean).join('\n')}
      onClick={openChild}
      onKeyDown={(e) => {
        // 内嵌动作、details/summary 的键盘激活属于控件本身，而非卡片导航。
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openChild()
        }
      }}
    >
      <div className="subagent-live-header">
        <div className="subagent-live-trigger">
          <Icon
            name={detailError !== undefined ? 'x' : badge.status === 'working' ? 'loader' : badge.status === 'error' ? 'x' : 'bot'}
            size={13}
            className={badge.status === 'working' && detailError === undefined ? SPIN : undefined}
          />
          <span className="subagent-live-title" title={taskTitle}>
            <span className="subagent-live-id">子会话 #{childConversationId}</span>
            {summary?.profileId !== undefined && summary.profileId !== '' ? (
              <span className="badge badge-neutral">{summary.profileId}</span>
            ) : null}
            {taskTitle !== undefined ? <span className="subagent-live-title-text">{taskTitle}</span> : null}
          </span>
          {wt !== undefined ? (
            <span className="badge badge-neutral subagent-worktree-badge" title={`隔离工作树：${wt.path}`}>
              <Icon name="git-branch" size={11} />
              {wt.branch}
            </span>
          ) : null}
          {props.cached === true ? <span className="badge badge-warn">cached</span> : null}
          <span className={`badge ${badge.badge}`}>{badge.label}</span>
          {props.extraStats !== undefined && props.extraStats !== '' ? (
            <span className="subagent-live-stats workflow-node-stats tabular-nums">{props.extraStats}</span>
          ) : null}
          {statSegments.length > 0 ? (
            <span className="subagent-live-stats workflow-node-duration tabular-nums">{statSegments.join(' · ')}</span>
          ) : null}
        </div>
        <span className="subagent-live-actions" onClick={(e) => e.stopPropagation()}>
          {backgroundRun?.status === 'running' ? (
            <button
              type="button"
              className="btn btn-xs btn-danger"
              title="中止该后台子代理任务"
              aria-label="中止该后台子代理任务"
              onClick={(e) => {
                e.stopPropagation()
                void ctx
                  .callAction('abort', { runId: backgroundRun.id })
                  .catch((err: unknown) => ctx.notify(`中止后台子代理失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
              }}
            >
              <Icon name="square" size={11} />
              <span className="subagent-action-label">中止</span>
            </button>
          ) : null}
          {wt !== undefined ? (
            <button
              type="button"
              className="btn btn-xs"
              title="清理隔离工作树"
              aria-label="清理隔离工作树"
              onClick={(e) => {
                e.stopPropagation()
                void ctx
                  .callAction('cleanup_worktree', { path: wt.path })
                  .catch((err: unknown) => ctx.notify(`清理工作树失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
              }}
            >
              <Icon name="rotate-cw" size={11} />
              <span className="subagent-action-label">清理工作树</span>
            </button>
          ) : null}
          {detailError !== undefined ? (
            <button
              type="button"
              className="btn btn-xs"
              title="重新加载子会话详情"
              aria-label="重新加载子会话详情"
              onClick={(e) => {
                e.stopPropagation()
                conv.reload()
              }}
            >
              <Icon name="rotate-cw" size={11} />
              <span className="subagent-action-label">重试</span>
            </button>
          ) : null}
        </span>
      </div>
      {snippet !== undefined ? (
        <div className={`subagent-live-subline subagent-live-subline-${snippet.kind}`} title={snippet.text}>
          <Icon name="corner-down-right" size={11} />
          {snippet.tag !== undefined ? <span className="subagent-live-subline-tag">{snippet.tag}</span> : null}
          <span className="subagent-live-subline-text">{snippet.text}</span>
        </div>
      ) : null}
      {props.expanded === true && streamLines.length > 0 ? (
        <div className="subagent-live-stream" ref={stream.ref} onScroll={stream.onScroll}>
          {streamLines.slice(-30).map((line) =>
            line.kind === 'prompt' ? (
              <div key={line.key} className="subagent-stream-line subagent-stream-prompt">
                <span className="subagent-stream-tag">指令</span>
                <span className="subagent-stream-body">{line.text}</span>
              </div>
            ) : line.kind === 'thinking' ? (
              <div key={line.key} className="subagent-stream-line subagent-stream-thinking">
                <span className="subagent-stream-tag">思考</span>
                <span className="subagent-stream-body">{line.text}</span>
              </div>
            ) : line.kind === 'tool' ? (
              <div key={line.key} className="subagent-stream-line subagent-stream-tool">
                <Icon name={line.status === 'running' ? 'loader' : line.isError ? 'x' : 'check'} size={11} className={line.status === 'running' ? SPIN : undefined} />
                <span className="subagent-stream-body">
                {line.toolName} {line.summary}{line.resultPreview !== undefined ? `：${line.resultPreview}` : ''}
                {toolResultPreviewTruncated(line.resultPreview) ? <span className="subagent-stream-truncated">（已截断）</span> : null}
              </span>
              </div>
            ) : (
              <div key={line.key} className="subagent-stream-line">
                <span className="subagent-stream-tag">回复</span>
                <span className="subagent-stream-body">{line.text}</span>
              </div>
            ),
          )}
        </div>
      ) : null}
      {props.expanded === true ? (
        <ToolCallDetailsInline
          input={props.callDetails !== undefined ? props.callDetails.input : toolSummary?.prompt}
          result={props.callDetails !== undefined ? props.callDetails.result : toolSummary?.resultText}
          artifactRef={props.callDetails?.artifactRef}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SubagentToolView：tool.view 扩展点组件（subagent 工具行）
// ---------------------------------------------------------------------------

export function SubagentToolView(props: ToolViewProps): ReactNode {
  const conversations = useConversations()
  const runsDoc = usePluginDoc<{ runs: WorkflowRunSummary[] }>('runs')
  const ctx = usePluginContext()

  const childId = useMemo(
    () =>
      resolveSubagentConversationId(
        { callId: props.callId, input: props.input, result: typeof props.result === 'string' ? props.result : undefined },
        props.conversationId,
        conversations,
      ),
    [props.callId, props.input, props.result, props.conversationId, conversations],
  )
  const meta = useMemo(
    () =>
      resolveSubagentExecutionMeta(
        { callId: props.callId, result: typeof props.result === 'string' ? props.result : undefined },
        props.conversationId,
        runsDoc?.runs ?? [],
      ),
    [props.callId, props.result, props.conversationId, runsDoc],
  )
  const toolSummary = useMemo(() => parentToolSummaryOf(props), [props])
  const isLatest = isLatestSubagentCallForTarget(
    {
      callId: props.callId,
      input: props.input,
      result: props.result,
      siblingCalls: props.siblingCalls,
      conversationId: props.conversationId,
    },
    childId,
    conversations,
    meta.executionId ?? meta.run?.nodes?.find((node) => node.executionId !== undefined)?.executionId,
  )
  const childStatus = conversations.find((conversation) => conversation.id === childId)?.status
  useToolActivity(props.callId, isLatest && (meta.run?.status === 'running' || childStatus === 'working' || childStatus === 'blocked'))

  // 外部执行（无原生子会话，如 Herdr 窗格）：如实展示后台 run 摘要，不虚构子会话。
  if (childId === undefined) {
    return (
      <div className="trace-entry">
        <ExternalRunSummary run={meta.run} worktree={meta.worktree} toolStatus={props.status} executionId={meta.executionId} />
      </div>
    )
  }

  // 历史调用只保留当次状态；查看详情统一打开子会话抽屉，不在时间线展开。
  if (!isLatest) {
    return (
      <div className="trace-entry">
        <div
          className={`trace-row${props.status === 'error' || props.isError === true ? ' trace-row-error' : ''}`}
          role="button"
          tabIndex={0}
          aria-label={`打开子会话 #${childId} 抽屉`}
          onClick={() => ctx.openConversationDrawer(childId)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              ctx.openConversationDrawer(childId)
            }
          }}
        >
          <span className="trace-row-left">
            <Icon name={props.isError === true ? 'x' : 'check'} size={12} />
            <span className="trace-tool-name">subagent</span>
            <span className="trace-tool-summary">{toolSummary.prompt ?? `子会话 #${childId}`}</span>
            <span className="badge badge-neutral">#{childId} · 已在下文续接</span>
          </span>
          <span className="trace-row-right">{props.status === 'error' || props.isError === true ? '失败' : props.status === 'done' ? '完成' : '运行中'}</span>
        </div>
      </div>
    )
  }

  return (
    <SubagentLiveCard
      childConversationId={childId}
      toolStatus={props.status}
      backgroundRun={meta.run}
      worktree={meta.worktree}
      toolSummary={toolSummary}
      startedAt={props.startedAt}
      expanded={false}
    />
  )
}

/** 外部运行时（如 Herdr 窗格）的后台任务摘要（无原生子会话时如实展示）。 */
function ExternalRunSummary(props: {
  run?: WorkflowRunSummary
  worktree?: { path: string; branch: string }
  toolStatus: 'running' | 'done' | 'error'
  executionId?: string
}): ReactNode {
  const { run, worktree, toolStatus, executionId } = props
  const nodes = run?.nodes ?? []
  const running = nodes.filter((n) => n.status === 'running').length
  const failed = nodes.find((n) => n.status === 'failed')
  const runError = run?.status === 'failed' || run?.status === 'aborted' ? (run.error ?? '后台执行失败') : undefined
  const badge = subagentBadge(undefined, toolStatus, run?.status)
  const active = badge.status === 'working'
  const failedState = badge.status === 'error'
  return (
    <div className="subagent-live-card subagent-external-card">
      <div className="subagent-live-header">
        <Icon name={failedState ? 'x' : active ? 'loader' : 'bot'} size={13} className={active ? SPIN : undefined} />
        <span className="subagent-live-title">外部执行</span>
        {executionId !== undefined ? <span className="badge badge-neutral">{executionId}</span> : null}
        {worktree !== undefined ? (
          <span className="badge badge-neutral subagent-worktree-badge" title={`隔离工作树：${worktree.path}`}>
            <Icon name="git-branch" size={11} />
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
                <Icon name={n.status === 'running' ? 'loader' : n.status === 'failed' ? 'x' : n.status === 'done' ? 'check' : 'circle'} size={11} className={n.status === 'running' ? SPIN : undefined} />
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
            <Icon name="x" size={11} />
            <span className="subagent-stream-body">后台执行失败：{runError}</span>
          </div>
        ) : null}
        {failed !== undefined && failed.error !== undefined ? (
          <div className="subagent-stream-line subagent-stream-error subagent-bg-error" title={failed.error}>
            <Icon name="x" size={11} />
            <span className="subagent-stream-body">节点失败：{failed.error}</span>
          </div>
        ) : null}
        {running > 0 ? <div className="subagent-stream-line subagent-stream-empty">{running} 个节点执行中</div> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WorkflowToolView：tool.view 扩展点组件（SubagentWorkflow 工具行）
// ---------------------------------------------------------------------------

export function WorkflowToolView(props: ToolViewProps): ReactNode {
  const runsDoc = usePluginDoc<{ runs: WorkflowRunSummary[] }>('runs')
  const [cardOpen, setCardOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)

  const run = useMemo(
    () =>
      resolveWorkflowRunForTool(
        { callId: props.callId, result: typeof props.result === 'string' ? props.result : undefined },
        props.conversationId,
        runsDoc?.runs ?? [],
      ),
    [props.callId, props.result, props.conversationId, runsDoc],
  )

  useToolActivity(props.callId, run?.status === 'running')

  if (run === undefined) {
    // 引擎尚未建立关联 run：保留原始调用详情，不猜测其他 run。
    return (
      <div className="trace-entry">
        <ToolCallDetailsInline input={props.input} result={props.result} artifactRef={props.artifactRef} />
      </div>
    )
  }

  return (
    <WorkflowRunCardBody
      run={run}
      cardOpen={cardOpen}
      onToggleCard={() => setCardOpen((v) => !v)}
      resultOpen={resultOpen}
      onToggleResult={() => setResultOpen((v) => !v)}
      busy={busy}
      setBusy={setBusy}
      toolProps={props}
      inWorkbench={false}
    />
  )
}

/** 工作流运行卡主体（时间线与工作台共用）。 */
function WorkflowRunCardBody(props: {
  run: WorkflowRunSummary
  cardOpen: boolean
  onToggleCard: () => void
  resultOpen: boolean
  onToggleResult: () => void
  busy: boolean
  setBusy: (v: boolean) => void
  toolProps?: { input?: unknown; result?: unknown; artifactRef?: string }
  inWorkbench: boolean
}): ReactNode {
  const ctx = usePluginContext()
  const { run, cardOpen, busy, setBusy, toolProps, inWorkbench } = props
  const nodes = run.nodes ?? []
  const done = nodes.filter((n) => n.status === 'done').length
  const tokens = nodes.reduce((sum, n) => sum + (n.tokens ?? 0), 0)
  const sections = useMemo(() => buildWorkflowPhaseSections(run), [run])
  const logs = useMemo(() => extractWorkflowLogs(run), [run])
  const hasNamedPhases = sections.length > 1 || (sections.length === 1 && sections[0]!.title !== '')

  // 运行中秒表（SSR 首帧确定性）。
  const nowMs = useElapsedNowMs(run.status === 'running')
  const elapsedMs =
    run.status === 'running' && nowMs !== undefined && Number.isFinite(run.createdAt) && nowMs >= run.createdAt
      ? nowMs - run.createdAt
      : run.updatedAt - run.createdAt

  const abort = (): void => {
    setBusy(true)
    ctx
      .callAction('abort', { runId: run.id })
      .catch((err: unknown) => ctx.notify(`中止工作流失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
      .finally(() => setBusy(false))
  }
  const resume = (): void => {
    setBusy(true)
    ctx
      .callAction('run', { resumeFromRunId: run.id, conversationId: run.conversationId })
      .catch((err: unknown) => ctx.notify(`断点恢复失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
      .finally(() => setBusy(false))
  }

  const resultJson = useMemo(() => {
    if (run.result === undefined) return undefined
    try {
      return JSON.stringify(run.result, null, 2) ?? String(run.result)
    } catch {
      return String(run.result)
    }
  }, [run.result])

  return (
    <section className="card jr-stack workflow-run-card" aria-label={`工作流：${run.name}`}>
      <div className="jr-stack-row">
        <button type="button" className="btn btn-ghost btn-sm" onClick={props.onToggleCard} title={cardOpen ? '收起工作流卡' : '展开工作流卡'}>
          <Icon name={cardOpen ? 'chevron-down' : 'chevron-right'} size={12} />
        </button>
        <Icon name={run.kind === 'subagent' ? 'bot' : 'terminal'} />
        <strong>{run.name}</strong>
        <span className={`badge ${RUN_BADGE[run.status] ?? 'badge-neutral'}`}>{RUN_LABEL[run.status] ?? run.status}</span>
        {run.replayedFrom !== undefined ? (
          <span className="badge badge-warn" title={`从 journal 前缀重放恢复（源 run ${run.replayedFrom}）`}>cached 重放</span>
        ) : null}
        <span style={{ flex: 1 }} />
        <span className="workflow-run-stats tabular-nums">
          {nodes.length > 0 ? <span>{`节点 ${done}/${nodes.length}`}</span> : null}
          {tokens > 0 ? <span>{`${tokens.toLocaleString()} Tokens`}</span> : null}
          <span>{formatDurationMs(Math.max(0, elapsedMs))}</span>
        </span>
        {run.status === 'running' ? (
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={abort}>
            <Icon name="square" size={11} />
            中止
          </button>
        ) : null}
        {canResumeWorkflowRun(run) ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={resume} title="从 journal 断点重放恢复执行">
            <Icon name="rotate-cw" size={11} />
            断点恢复
          </button>
        ) : null}
        {!inWorkbench ? (
          <button className="btn btn-sm" onClick={() => ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)}>
            工作台详情
          </button>
        ) : null}
      </div>
      {run.description !== undefined && run.description !== '' ? <p className="workflow-run-description">{run.description}</p> : null}
      {cardOpen ? (
        <>
          {hasNamedPhases ? (
            <div className="phase-bar">
              {sections.map((section, idx) => (
                <span
                  key={section.key}
                  className={`phase-segment${section.status === 'running' ? ' phase-segment-active' : section.status === 'done' ? ' phase-segment-done' : section.status === 'failed' ? ' phase-segment-failed' : ''}`}
                  title={section.detail ?? section.title}
                >
                  <Icon name={PHASE_ICON[section.status]} size={11} className={section.status === 'running' ? SPIN : undefined} />
                  {`${idx + 1}. ${section.title}`}
                  {`(${section.doneCount}/${section.totalCount})`}
                </span>
              ))}
            </div>
          ) : null}
          {logs.length > 0 ? (
            <div className="workflow-log-list">
              {logs.map((log) => (
                <div key={log.key} className="workflow-log-line">
                  <Icon name="terminal" size={11} />
                  <span className="workflow-log-text">{log.message}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="workflow-node-list">
            {sections.map((section) => (
              <div key={section.key} className="workflow-phase-group">
                {section.title !== '' ? (
                  <div className="workflow-phase-header">
                    <Icon name={PHASE_ICON[section.status]} size={11} className={section.status === 'running' ? SPIN : undefined} />
                    <span className="workflow-phase-title">{`${section.index + 1}. ${section.title}`}</span>
                    <span className="workflow-phase-count tabular-nums">{`(${section.doneCount}/${section.totalCount})`}</span>
                  </div>
                ) : null}
                {section.nodes.map((node) => (
                  <WorkflowNodeCard key={node.id} node={node} />
                ))}
              </div>
            ))}
            {nodes.length === 0 ? <div className="workflow-phase-empty">暂无节点状态</div> : null}
          </div>
          {run.status === 'completed' && resultJson !== undefined ? (
            <div className="workflow-result-box">
              <div className="workflow-result-header">
                <span className="trace-section-label">最终产出</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={props.onToggleResult}>
                  <Icon name={props.resultOpen ? 'chevron-down' : 'chevron-right'} size={11} />
                  {props.resultOpen ? '收起完整结果' : '展开完整结果'}
                </button>
              </div>
              {props.resultOpen ? (
                <pre className="code-block-pre workflow-node-pre selectable"><code>{resultJson}</code></pre>
              ) : (
                <div className="workflow-result-preview selectable" title={formatNodeOutputPreview(run.result, 160)}>{formatNodeOutputPreview(run.result, 160)}</div>
              )}
            </div>
          ) : null}
          {run.error !== undefined ? <p className="jr-callout jr-callout-err">{run.error}</p> : null}
        </>
      ) : null}
      {toolProps !== undefined ? <ToolCallDetailsInline input={toolProps.input} result={toolProps.result} artifactRef={toolProps.artifactRef} /> : null}
    </section>
  )
}

/** 工作流子代理节点：直接以一体化整卡直出（无手风琴折叠壳）。 */
function WorkflowSubagentNodeCard({ node }: { node: WorkflowNodeState }): ReactNode {
  const outputText = typeof node.output === 'string' ? node.output : undefined
  const nodeStats = useMemo(() => formatWorkflowNodeStats(node), [node])
  return (
    <div className="workflow-subagent-node-card">
      <SubagentLiveCard
        childConversationId={node.conversationId!}
        toolStatus={node.status === 'running' ? 'running' : node.status === 'failed' ? 'error' : node.status === 'done' ? 'done' : 'unknown'}
        startedAt={node.startedAt}
        worktree={node.worktree}
        cached={node.cached}
        extraStats={nodeStats.length > 0 ? nodeStats.join(' · ') : undefined}
        toolSummary={{
          prompt: node.label,
          durationMs: node.durationMs,
          isError: node.status === 'failed',
          resultText: outputText,
        }}
        expanded={false}
      />
      {node.gate !== undefined ? (
        <div className="workflow-node-gate-extra">
          <span className={`badge ${node.gate.ok ? 'badge-ok' : 'badge-err'}`}>
            {node.gate.ok ? 'Gate 通过' : 'Gate 失败'}
          </span>
          {node.gateCommand !== undefined ? <code className="mono workflow-node-gate-cmd">{node.gateCommand}</code> : null}
          {node.gate.output !== '' ? (
            <pre className={`code-block-pre workflow-node-pre${node.gate.ok ? '' : ' workflow-node-pre-err'}`}>
              <code>{node.gate.output}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
      {node.error !== undefined ? <p className="jr-callout jr-callout-err">{node.error}</p> : null}
    </div>
  )
}

/** 无原生子会话节点：动作与外部执行如实展示，均不伪造可导航的子会话。 */
function WorkflowExecutionNodeCard({ node }: { node: WorkflowNodeState }): ReactNode {
  const summaryText = resolveNodeSummaryText(node)
  const nodeStats = useMemo(() => formatWorkflowNodeStats(node), [node])
  const isErr = node.status === 'failed'
  return (
    <div className={`subagent-live-card ${node.kind === 'action' ? 'workflow-action-card' : 'workflow-agent-card'}${isErr ? ' subagent-live-card-error' : ''}`}>
      <div className="subagent-live-header">
        <div className="subagent-live-trigger" style={{ cursor: 'default' }}>
          <Icon
            name={node.status === 'running' ? 'loader' : node.status === 'failed' ? 'x' : node.status === 'done' ? 'check' : node.status === 'skipped' ? 'chevron-right' : 'clock'}
            size={13}
            className={node.status === 'running' ? SPIN : undefined}
          />
          <span className="badge badge-neutral">{node.kind === 'action' ? '动作' : node.executionId !== undefined ? '外部执行' : '子代理节点'}</span>
          <span className="subagent-live-title" title={node.label ?? node.id}>
            <span className="subagent-live-title-text">{node.label ?? node.id}</span>
          </span>
          {node.worktree !== undefined ? (
            <span className="badge badge-neutral subagent-worktree-badge" title={`隔离工作树：${node.worktree.path}`}>
              <Icon name="git-branch" size={11} />
              {node.worktree.branch}
            </span>
          ) : null}
          {node.cached === true ? <span className="badge badge-warn">cached</span> : null}
          <span className={`badge ${NODE_BADGE[node.status] ?? 'badge-neutral'}`}>
            {NODE_LABEL[node.status] ?? node.status}
          </span>
          {node.attempt !== undefined && node.attempt > 1 ? (
            <span className="badge badge-neutral">{`第 ${node.attempt} 次`}</span>
          ) : null}
          {node.gate !== undefined ? (
            <span className={`badge ${node.gate.ok ? 'badge-ok' : 'badge-err'}`}>
              {node.gate.ok ? 'Gate 通过' : 'Gate 失败'}
            </span>
          ) : null}
          {nodeStats.length > 0 ? (
            <span className="subagent-live-stats workflow-node-stats tabular-nums">{nodeStats.join(' · ')}</span>
          ) : null}
          {node.durationMs !== undefined ? (
            <span className="subagent-live-stats workflow-node-duration tabular-nums">{formatDurationMs(node.durationMs)}</span>
          ) : null}
        </div>
      </div>
      {summaryText.text !== undefined ? (
        <div className={`subagent-live-subline${summaryText.isError ? ' subagent-live-subline-error' : ''}`}>
          <Icon name="corner-down-right" size={11} />
          <span className="subagent-live-subline-tag">{summaryText.isError ? '错误' : '产出'}</span>
          <span className="subagent-live-subline-text" title={summaryText.text}>{summaryText.text}</span>
        </div>
      ) : null}
      {hasNodeExtraDetail(node) ? <WorkflowNodeDetail node={node} /> : null}
    </div>
  )
}

/** 单节点卡片：子代理节点直出一体化整卡；动作节点直出扁平双层卡。全程无手风琴折叠。 */
function WorkflowNodeCard({ node }: { node: WorkflowNodeState }): ReactNode {
  if (node.conversationId !== undefined) {
    return <WorkflowSubagentNodeCard node={node} />
  }
  return <WorkflowExecutionNodeCard node={node} />
}

/** 无原生子会话节点的结构化明细。 */
function WorkflowNodeDetail({ node }: { node: WorkflowNodeState }): ReactNode {
  const ctx = usePluginContext()
  const rows: Array<[string, string]> = []
  if (node.agentType !== undefined) rows.push(['执行后端', node.agentType])
  if (node.executionId !== undefined) rows.push(['外部执行', node.executionId])
  if (node.nodeId !== undefined) rows.push(['执行节点', node.nodeId])
  if (node.effectiveCwd !== undefined) rows.push(['工作目录', node.effectiveCwd])
  if (node.worktree !== undefined) rows.push(['工作树', `${node.worktree.branch} @ ${node.worktree.path}`])
  if (node.model !== undefined) rows.push(['模型', node.model])
  if (node.durationMs !== undefined) rows.push(['耗时', formatDurationMs(node.durationMs)])
  if (node.tokens !== undefined && node.tokens > 0) rows.push(['Token', node.tokens.toLocaleString()])
  const outputJson = useMemo(() => {
    if (node.output === undefined) return undefined
    if (typeof node.output === 'string') return node.output
    try {
      return JSON.stringify(node.output, null, 2) ?? String(node.output)
    } catch {
      return String(node.output)
    }
  }, [node.output])
  return (
    <div className="workflow-node-detail">
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
      {node.gateCommand !== undefined || node.gate !== undefined ? (
        <div>
          <div className="trace-section-label">Gate</div>
          {node.gateCommand !== undefined ? <pre className="code-block-pre workflow-node-pre"><code>{node.gateCommand}</code></pre> : null}
          {node.gate !== undefined ? (
            <pre className={`code-block-pre workflow-node-pre${node.gate.ok ? '' : ' workflow-node-pre-err'}`}><code>{node.gate.output}</code></pre>
          ) : null}
        </div>
      ) : null}
      {node.prompt !== undefined ? (
        <div>
          <div className="trace-section-label">Prompt</div>
          <pre className="code-block-pre workflow-node-pre"><code>{node.prompt}</code></pre>
        </div>
      ) : null}
      {outputJson !== undefined ? (
        <div>
          <div className="trace-section-label">Output</div>
          <pre className="code-block-pre workflow-node-pre"><code>{outputJson}</code></pre>
        </div>
      ) : null}
      {node.error !== undefined ? (
        <div>
          <div className="trace-section-label">Error</div>
          <pre className="code-block-pre workflow-node-pre workflow-node-pre-err"><code>{node.error}</code></pre>
        </div>
      ) : null}
      {node.worktree !== undefined ? (
        <button type="button" className="btn btn-xs" onClick={() => {
          void ctx.callAction('cleanup_worktree', { path: node.worktree!.path }).catch((err: unknown) =>
            ctx.notify(`清理工作树失败：${err instanceof Error ? err.message : String(err)}`, 'error'),
          )
        }}>
          清理工作树
        </button>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// WorkflowWorkbenchPanel：workbench.panel 扩展点组件
// ---------------------------------------------------------------------------

export function WorkflowWorkbenchPanel(props: WorkbenchPanelProps): ReactNode {
  const ctx = usePluginContext()
  const runsDoc = usePluginDoc<{ runs: WorkflowRunSummary[] }>('runs')
  const conversations = useConversations()
  const parent = useConversation(props.conversation.id)
  const [inspectRunId, setInspectRunId] = useState<string | undefined>(undefined)

  const runs = useMemo(
    () => (runsDoc?.runs ?? []).filter((r: WorkflowRunSummary) => r.conversationId === props.conversation.id),
    [runsDoc, props.conversation.id],
  )
  const subagentItems = useMemo(
    () => buildWorkbenchSubagentItems(conversations, props.conversation.id, runs),
    [conversations, props.conversation.id, runs],
  )
  const workflowRuns = runs.filter((r) => r.kind !== 'subagent')
  const externalSubagentRuns = runs.filter(
    (r) => r.kind === 'subagent' && !(r.nodes ?? []).some((n) => n.conversationId !== undefined),
  )
  const inspectedRun = inspectRunId !== undefined ? runs.find((r) => r.id === inspectRunId) : undefined

  if (inspectedRun !== undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
        <button type="button" className="btn btn-sm" onClick={() => setInspectRunId(undefined)}>
          返回运行列表
        </button>
        <WorkflowRunCardBody
          run={inspectedRun}
          cardOpen
          onToggleCard={() => undefined}
          resultOpen
          onToggleResult={() => undefined}
          busy={false}
          setBusy={() => undefined}
          inWorkbench
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
      {workflowRuns.length > 0 ? <div className="trace-section-label">工作流运行</div> : null}
      {workflowRuns.map((run) => (
        <div key={run.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <WorkflowRunCardBody
            run={run}
            cardOpen={false}
            onToggleCard={() => setInspectRunId(run.id)}
            resultOpen={false}
            onToggleResult={() => undefined}
            busy={false}
            setBusy={() => undefined}
            inWorkbench
          />
        </div>
      ))}
      {externalSubagentRuns.length > 0 ? <div className="trace-section-label">外部后台任务</div> : null}
      {externalSubagentRuns.map((run) => (
        <ExternalRunSummary key={run.id} run={run} toolStatus={run.status === 'running' ? 'running' : run.status === 'completed' ? 'done' : 'error'} />
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
              expanded={false}
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
