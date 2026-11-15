/**
 * builtin:workflow 插件子代理卡组件：
 * - SubagentLiveCard：子会话双层胶囊实时卡（会话节点卡）；
 * - SubagentToolView：时间线内 subagent 工具调用（tool.view 扩展点）。
 * 执行树紧凑子项行与外部执行摘要在同目录独立模块（ExecutionChildrenRows /
 * ExternalRunSummary），此处按原 client 模块形状再导出（workflow.ts UI 注册
 * 与既有消费方经 SubagentCard.tsx 引用）。
 * 数据经 @helm/plugin-client 共享 hooks 响应式读取；动作经 ctx.callAction 走
 * POST /api/actions/builtin:workflow/<actionId>，无任何宿主私有依赖。
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { useConversation, useConversations, usePluginContext, useToolActivity, formatDurationMs } from '@helm/plugin-client'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import { ExecutionCard } from './ExecutionCard.tsx'
import { ExecutionChildrenRows } from './ExecutionChildrenRows.tsx'
import { ExternalRunSummary } from './ExternalRunSummary.tsx'
import { SubagentStream } from './SubagentStream.tsx'
import { useElapsedNowMs, usePluginSessionDoc, useStreamFollow } from './hooks.ts'
import { SPIN, EXECUTION_BADGE, EXECUTION_LABEL } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { WorktreeInspectSection } from './WorktreeInspectSection.tsx'
import { buildWorktreeSelector } from './model-worktree.ts'
import { resolveRunElapsedMs } from './model-run.ts'
import { aggregateExecutionNodes, buildExecutionTree } from './model-execution-tree.ts'
import type { ExecutionNode } from './model-execution-tree.ts'
import { aggregateExecutionStatuses } from './model-execution-status.ts'
import type { ExecutionNodeStatus } from './model-execution-status.ts'
import { collectExecutionApprovals, collectExecutionFrontline } from './model-execution-view.ts'
import {
  isLatestSubagentCallForTarget,
  parentToolSummaryOf,
  resolveSubagentConversationId,
  resolveSubagentExecutionMeta,
} from './model-subagent-link.ts'
import {
  buildSubagentStatSegments,
  buildSubagentStreamLines,
} from './model-subagent-stream.ts'
import {
  resolveSubagentElapsedMs,
  resolveSubagentHeaderSnippet,
  resolveSubagentTaskTitle,
  subagentBadge,
} from './model-subagent-card.ts'
import type { SubagentBadge } from './model-subagent-card.ts'

// 既有模块形状再导出（同目录独立组件；见文件头说明）。
export { ExecutionChildrenRows } from './ExecutionChildrenRows.tsx'
export { ExternalRunSummary } from './ExternalRunSummary.tsx'

// ---------------------------------------------------------------------------
// 子代理双层胶囊卡（原 SubagentLiveCard 语义；统一为 ExecutionNode 的会话节点卡）
// ---------------------------------------------------------------------------

export function SubagentLiveCard(props: {
  childConversationId: number
  toolStatus: 'running' | 'done' | 'error' | 'unknown'
  backgroundRun?: WorkflowRunSummary
  worktree?: { path: string; branch: string; id?: string; baseCommit?: string }
  /**
   * 工作树只读检视入口（独立子代理卡：单次/后台/工作台子会话）：提供时且存在
   * 工作树坐标才渲染检视节；workflow 节点卡在外层自渲染检视，不传以避免重复。
   * nodeId 用于无登记 ID 时的 path 消歧（缺省回退子会话绑定节点）。
   */
  worktreeInspect?: { parentConversationId: number; nodeId?: string }
  toolSummary?: { prompt?: string; startedAt?: number; durationMs?: number; resultText?: string; isError?: boolean }
  startedAt?: number
  /** 是否为缓存/历史重放任务。 */
  cached?: boolean
  /** 工作流节点的权威模型 / Token 统计，覆盖摘要中的同类字段，避免重复展示。 */
  statsOverride?: { model?: string; tokens?: number }
  /** 展开态展示实时流与底部调用详情。 */
  expanded?: boolean
  callDetails?: Pick<ToolViewProps, 'input' | 'result' | 'artifactRef'>
  /** 统一执行树下一级子节点（工作台 / 工作流节点卡注入；缺省不渲染深层子树）。 */
  childNodes?: ExecutionNode[]
}) {
  const ctx = usePluginContext()
  const { childConversationId, toolStatus, backgroundRun, worktree, toolSummary, startedAt, statsOverride } = props
  const conv = useConversation(childConversationId)
  const summary = conv.summary
  const detail = conv.detail
  const live = conv.live
  const pendingAsk = conv.pendingAsks[0]
  const detailError = conv.loadError
  const [cleaning, setCleaning] = useState(false)

  // 自身徽章：审批事实优先——AskDoc 存在（pendingAsks 或 pendingAskCount > 0）
  // 即等待审批，与 AskDock 同源；Herdr 外部执行的 AskDoc 归属原生父会话时
  // 会话 status 可能仍在 working，有单不得仍显示执行中。
  const selfBadge: SubagentBadge =
    pendingAsk !== undefined || (summary?.pendingAskCount ?? 0) > 0
      ? { status: 'blocked', label: '等待审批', badge: 'badge-warn' }
      : subagentBadge(summary?.status, toolStatus, backgroundRun?.status)
  const taskTitle = resolveSubagentTaskTitle(summary, childConversationId, toolSummary, backgroundRun)
  const statSegments = useMemo(
    () =>
      buildSubagentStatSegments({
        ...(summary !== undefined ? { summary } : {}),
        ...(detail?.entries !== undefined ? { entries: detail.entries } : {}),
        ...(live !== undefined ? { live } : {}),
        ...(backgroundRun !== undefined ? { backgroundRun } : {}),
        ...(statsOverride?.model !== undefined ? { modelOverride: statsOverride.model } : {}),
        ...(statsOverride?.tokens !== undefined ? { tokensOverride: statsOverride.tokens } : {}),
      }),
    [summary, detail?.entries, live, backgroundRun, statsOverride?.model, statsOverride?.tokens],
  )
  const snippet = useMemo(
    () =>
      resolveSubagentHeaderSnippet({
        badgeStatus: selfBadge.status,
        ...(summary !== undefined ? { summary } : {}),
        ...(live !== undefined ? { live } : {}),
        ...(detail?.entries !== undefined ? { entries: detail.entries } : {}),
        ...(pendingAsk !== undefined ? { pendingAsk } : {}),
        ...(backgroundRun !== undefined ? { backgroundRun } : {}),
        ...(toolSummary !== undefined ? { toolSummary } : {}),
        ...(detailError !== undefined ? { detailError } : {}),
      }),
    [selfBadge.status, summary, live, detail?.entries, pendingAsk, backgroundRun, toolSummary, detailError],
  )

  // 统一执行树：后代子树聚合 / 前线活动 / 后代审批（仅由真实数据提炼）。
  const childNodes = props.childNodes ?? []
  const descendants = useMemo(() => aggregateExecutionNodes(childNodes), [childNodes])
  const frontline = useMemo(() => collectExecutionFrontline(childNodes, 2), [childNodes])
  const approvals = useMemo(() => collectExecutionApprovals(childNodes, 3), [childNodes])
  // 主徽章有效状态：与执行树同源（自身 + 后代聚合）；后台 / 深层子任务未
  // 结算（blocked / working / error / pending）时绝不显示已完成，自身终态另标清楚。
  const effectiveStatus: ExecutionNodeStatus =
    descendants.total > 0 ? aggregateExecutionStatuses([selfBadge.status, descendants.status]) : selfBadge.status

  // 任一自身/后代仍在执行或等待审批时，总耗时持续增长。聚合徽章可能因
  // 另一后代失败而显示 error，因此计时不能只依赖 effectiveStatus。
  const elapsedActive =
    selfBadge.status === 'working' || selfBadge.status === 'blocked' ||
    descendants.running > 0 || descendants.blocked > 0
  // SSR 首帧不启动时钟，保持确定性渲染。
  const nowMs = useElapsedNowMs(elapsedActive)
  // 总耗时独立展示位：仅以真实边界解析（本次调用 / 后台 run；运行中随秒表
  // 动态推进、结算定格持久化 duration；无本轮边界如实省略，不用会话
  // createdAt 伪造一次 resume 的耗时）。
  const elapsedMs = resolveSubagentElapsedMs({
    ...(backgroundRun !== undefined ? { backgroundRun } : {}),
    ...(toolSummary !== undefined ? { toolSummary } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    nowMs,
    status: elapsedActive ? 'working' : effectiveStatus,
  })
  const elapsedText = elapsedMs !== undefined ? formatDurationMs(elapsedMs) : undefined

  // 隔离工作树:显式入参优先,其次回退后台 run 首个节点的 worktree。
  const wt = worktree ?? backgroundRun?.nodes?.find((n) => n.worktree !== undefined)?.worktree
  // 检视/清理共用消歧坐标：调用方显式 nodeId > 子会话绑定节点。
  const inspectNodeId =
    props.worktreeInspect?.nodeId ?? (summary?.nodeId !== undefined && summary.nodeId !== '' ? summary.nodeId : undefined)
  const streamLines = useMemo(
    () => (props.expanded === true && detail?.entries !== undefined ? buildSubagentStreamLines(detail.entries, live, selfBadge.status === 'working') : []),
    [props.expanded, detail?.entries, live, selfBadge.status],
  )

  const stream = useStreamFollow(streamLines)

  const variantClass = [
    effectiveStatus === 'blocked' ? 'subagent-live-card-warn' : undefined,
    effectiveStatus === 'error' || detailError !== undefined ? 'subagent-live-card-error' : undefined,
    props.expanded === true ? 'subagent-live-card-expanded' : undefined,
  ]
    .filter(Boolean)
    .join(' ')

  const openChild = (): void => {
    ctx.openConversationDrawer(childConversationId)
  }

  // 头部触发区：图标 + 标题 + 徽章 + 统计尾注（纯展示插槽内容）。
  const heading = (
    <>
      <Icon
        name={detailError !== undefined ? 'x' : effectiveStatus === 'working' ? 'loader' : effectiveStatus === 'error' ? 'x' : 'bot'}
        size={13}
        className={effectiveStatus === 'working' && detailError === undefined ? SPIN : undefined}
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
      {effectiveStatus !== selfBadge.status ? (
        <>
          <span
            className={`badge ${EXECUTION_BADGE[effectiveStatus] ?? 'badge-neutral'}`}
            title={
              [
                `自身${selfBadge.label}，子树聚合：${EXECUTION_LABEL[effectiveStatus] ?? effectiveStatus}`,
                approvals.length > 0 ? `后代等待审批：${approvals.map((item) => item.text).join('；')}` : undefined,
              ]
                .filter(Boolean)
                .join('\n')
            }
          >
            {EXECUTION_LABEL[effectiveStatus] ?? effectiveStatus}
          </span>
          <span className="badge badge-neutral" title={`自身状态：${selfBadge.label}`}>{`自身${selfBadge.label}`}</span>
        </>
      ) : (
        <span className={`badge ${selfBadge.badge}`}>{selfBadge.label}</span>
      )}
      {descendants.total > 0 ? (
        <span
          className="badge badge-neutral tabular-nums"
          title={`子树执行进度：${descendants.done}/${descendants.total} 完成、${descendants.running} 执行中`}
        >
          {`子树 ${descendants.done}/${descendants.total}`}
        </span>
      ) : null}
      {descendants.blocked > 0 ? (
        <span
          className="badge badge-warn"
          title={`后代等待审批：${approvals.map((item) => item.text).join('；')}`}
        >
          {`审批 ${descendants.blocked}`}
        </span>
      ) : null}
      {statSegments.length > 0 ? (
        <span className="subagent-live-stats tabular-nums">{statSegments.join(' · ')}</span>
      ) : null}
      {elapsedText !== undefined ? (
        <span className="subagent-live-elapsed tabular-nums">{elapsedText}</span>
      ) : null}
    </>
  )

  // 头部动作区：中止 / 清理 / 重试（点击已由框架隔离，不冒泡整卡导航）。
  const actions = (
    <>
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
          disabled={cleaning}
          title="清理隔离工作树（优先登记 ID 精确定位，避免跨节点同名路径歧义）"
          aria-label="清理隔离工作树"
          onClick={(e) => {
            e.stopPropagation()
            if (cleaning) return
            setCleaning(true)
            ctx
              .callAction('cleanup_worktree', buildWorktreeSelector(wt, inspectNodeId))
              .then(() => ctx.notify(`已清理隔离工作树 ${wt.branch}`))
              .catch((err: unknown) => ctx.notify(`清理工作树失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
              .finally(() => setCleaning(false))
          }}
        >
          <Icon name="rotate-cw" size={11} className={cleaning ? SPIN : undefined} />
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
    </>
  )

  // 第 2 层动态副栏：当前动作 / 思考 / 结论 / 错误 + 前线活动摘要。
  const sublines =
    snippet !== undefined || frontline.length > 0 ? (
      <>
        {snippet !== undefined ? (
          <div className={`subagent-live-subline subagent-live-subline-${snippet.kind}`} title={snippet.text}>
            <Icon name="corner-down-right" size={11} />
            {snippet.tag !== undefined ? <span className="subagent-live-subline-tag">{snippet.tag}</span> : null}
            <span className="subagent-live-subline-text">{snippet.text}</span>
          </div>
        ) : null}
        {frontline.length > 0 ? (
          <div
            className="subagent-live-subline execution-frontline"
            title={frontline.map((item) => item.text).join('\n')}
          >
            <Icon name="corner-down-right" size={11} />
            <span className="subagent-live-subline-tag">前线</span>
            <span className="subagent-live-subline-text">{frontline.map((item) => item.text).join(' · ')}</span>
          </div>
        ) : null}
      </>
    ) : undefined

  return (
    <ExecutionCard
      variantClass={variantClass}
      activate={{
        label: `打开子会话 #${childConversationId} 抽屉`,
        tooltip: [taskTitle, summary?.profileId, wt?.branch, [...statSegments, elapsedText].filter(Boolean).join(' · '), '点击打开子会话抽屉'].filter(Boolean).join('\n'),
        open: openChild,
      }}
      heading={heading}
      actions={actions}
      snippet={sublines}
    >
      {childNodes.length > 0 ? <ExecutionChildrenRows nodes={childNodes} /> : null}
      {props.expanded === true && streamLines.length > 0 ? (
        <SubagentStream lines={streamLines} followRef={stream.ref} onScroll={stream.onScroll} />
      ) : null}
      {props.expanded === true ? (
        <ToolCallDetailsInline
          input={props.callDetails !== undefined ? props.callDetails.input : toolSummary?.prompt}
          result={props.callDetails !== undefined ? props.callDetails.result : toolSummary?.resultText}
          artifactRef={props.callDetails?.artifactRef}
        />
      ) : null}
      {props.worktreeInspect !== undefined && wt !== undefined ? (
        <div className="subagent-inspect-slot" onClick={(e) => e.stopPropagation()}>
          <WorktreeInspectSection
            worktree={{
              path: wt.path,
              branch: wt.branch,
              ...(wt.id !== undefined && wt.id !== '' ? { id: wt.id } : {}),
            }}
            nodeId={inspectNodeId}
            baseCommit={wt.baseCommit}
            taskLabel={taskTitle}
            parentConversationId={props.worktreeInspect.parentConversationId}
          />
        </div>
      ) : null}
    </ExecutionCard>
  )
}

// ---------------------------------------------------------------------------
// SubagentToolView：tool.view 扩展点组件（subagent 工具行）
// ---------------------------------------------------------------------------

export function SubagentToolView(props: ToolViewProps): ReactNode {
  const conversations = useConversations()
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>('runs', { conversationId: props.conversationId })
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

  // 统一执行树：子会话的下一级子项（仅由真实会话链与 runs 分片构树，不虚构）。
  const childNodes = useMemo(
    () =>
      childId === undefined
        ? undefined
        : buildExecutionTree({
            rootConversationId: props.conversationId,
            conversations,
            runs: runsDoc?.runs ?? [],
          }).find((node) => node.kind === 'conversation' && node.conversationId === childId)?.children,
    [childId, props.conversationId, conversations, runsDoc],
  )

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
          <span className="trace-row-right">
            {props.durationMs !== undefined ? (
              <span className="tabular-nums">{formatDurationMs(props.durationMs)}</span>
            ) : null}
            {props.status === 'error' || props.isError === true ? '失败' : props.status === 'done' ? '完成' : '运行中'}
          </span>
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
      worktreeInspect={{
        parentConversationId: props.conversationId,
        ...(meta.nodeId !== undefined && meta.nodeId !== '' ? { nodeId: meta.nodeId } : {}),
      }}
      toolSummary={toolSummary}
      startedAt={props.startedAt}
      expanded={false}
      childNodes={childNodes}
    />
  )
}
