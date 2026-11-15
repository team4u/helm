/**
 * builtin:workflow 插件子代理实时卡：SubagentLiveCard（会话节点卡）。
 * 卡内子视图（头部徽章区 / 动作栏 / 副栏）在同目录 SubagentCardDetails.tsx；
 * tool.view 入口组件 SubagentToolView 在同目录 SubagentToolView.tsx；
 * 执行树紧凑子项行与外部执行摘要在同目录独立模块（ExecutionChildrenRows /
 * ExternalRunSummary），此处按原 client 模块形状再导出（既有消费方经
 * SubagentCard.tsx 引用）。
 * 数据经 @helm/plugin-client 共享 hooks 响应式读取；动作经 ctx.callAction 走
 * POST /api/actions/builtin:workflow/<actionId>，无任何宿主私有依赖。
 */
import { useMemo } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { useConversation, usePluginContext, formatDurationMs } from '@helm/plugin-client'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import { ExecutionCard } from './ExecutionCard.tsx'
import { ExecutionChildrenRows } from './ExecutionChildrenRows.tsx'
import { SubagentStream } from './SubagentStream.tsx'
import {
  SubagentCardActions,
  SubagentCardHeading,
  SubagentCardSublines,
} from './SubagentCardDetails.tsx'
import { useElapsedNowMs, useStreamFollow } from './hooks.ts'
import { WorktreeInspectSection } from './WorktreeInspectSection.tsx'
import { aggregateExecutionNodes } from './model-execution-tree.ts'
import type { ExecutionNode } from './model-execution-tree.ts'
import { aggregateExecutionStatuses } from './model-execution-status.ts'
import type { ExecutionNodeStatus } from './model-execution-status.ts'
import { collectExecutionApprovals, collectExecutionFrontline } from './model-execution-view.ts'
import { buildSubagentStatSegments, buildSubagentStreamLines } from './model-subagent-stream.ts'
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
  /** 当前查看会话（时间线即发起会话）：前台同步 run 的「转入后台」可见性判定。 */
  viewerConversationId?: number
}) {
  const ctx = usePluginContext()
  const { childConversationId, toolStatus, backgroundRun, worktree, toolSummary, startedAt, statsOverride } = props
  const conv = useConversation(childConversationId)
  const summary = conv.summary
  const detail = conv.detail
  const live = conv.live
  const pendingAsk = conv.pendingAsks[0]
  const detailError = conv.loadError

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

  return (
    <ExecutionCard
      variantClass={variantClass}
      activate={{
        label: `打开子会话 #${childConversationId} 抽屉`,
        tooltip: [taskTitle, summary?.profileId, wt?.branch, [...statSegments, elapsedText].filter(Boolean).join(' · '), '点击打开子会话抽屉'].filter(Boolean).join('\n'),
        open: openChild,
      }}
      heading={
        <SubagentCardHeading
          childConversationId={childConversationId}
          profileId={summary?.profileId}
          taskTitle={taskTitle}
          worktree={wt}
          cached={props.cached}
          detailError={detailError}
          effectiveStatus={effectiveStatus}
          selfBadge={selfBadge}
          descendants={descendants}
          approvals={approvals}
          statSegments={statSegments}
          elapsedText={elapsedText}
        />
      }
      actions={
        <SubagentCardActions
          backgroundRun={backgroundRun}
          worktree={wt}
          inspectNodeId={inspectNodeId}
          detailError={detailError}
          onReload={() => conv.reload()}
          viewerConversationId={props.viewerConversationId}
        />
      }
      snippet={<SubagentCardSublines snippet={snippet} frontline={frontline} />}
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
