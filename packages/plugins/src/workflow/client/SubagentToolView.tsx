/**
 * builtin:workflow 插件 SubagentToolView（自 SubagentCard.tsx 拆出）：
 * tool.view 扩展点组件（subagent 工具行）——最新调用挂载双层胶囊实时卡，
 * 被 resume 续接的历史调用保留单行 trace 行，外部执行（无原生子会话，
 * 如 Herdr 窗格）如实展示后台 run 摘要，不虚构子会话。
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { formatDurationMs, useConversations, usePluginContext, useToolActivity } from '@helm/plugin-client'
import { ExternalRunSummary } from './ExternalRunSummary.tsx'
import { SubagentLiveCard } from './SubagentCard.tsx'
import { usePluginSessionDoc } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { buildExecutionTree } from './model-execution-tree.ts'
import {
  isLatestSubagentCallForTarget,
  parentToolSummaryOf,
  resolveSubagentConversationId,
  resolveSubagentExecutionMeta,
} from './model-subagent-link.ts'

/** 被 resume 续接的历史 subagent 调用：单行 trace 行，点击打开子会话抽屉。 */
function SubagentHistoryRow(props: {
  childId: number
  status: 'running' | 'done' | 'error'
  isError: boolean | undefined
  prompt: string | undefined
  durationMs: number | undefined
}): ReactNode {
  const ctx = usePluginContext()
  const { childId, status, isError, prompt, durationMs } = props
  return (
    <div className="trace-entry">
      <div
        className={`trace-row${status === 'error' || isError === true ? ' trace-row-error' : ''}`}
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
          <Icon name={isError === true ? 'x' : 'check'} size={12} />
          <span className="trace-tool-name">subagent</span>
          <span className="trace-tool-summary">{prompt ?? `子会话 #${childId}`}</span>
          <span className="badge badge-neutral">#{childId} · 已在下文续接</span>
        </span>
        <span className="trace-row-right">
          {durationMs !== undefined ? (
            <span className="tabular-nums">{formatDurationMs(durationMs)}</span>
          ) : null}
          {status === 'error' || isError === true ? '失败' : status === 'done' ? '完成' : '运行中'}
        </span>
      </div>
    </div>
  )
}

export function SubagentToolView(props: ToolViewProps): ReactNode {
  const conversations = useConversations()
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>('runs', { conversationId: props.conversationId })

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
        <ExternalRunSummary
          run={meta.run}
          worktree={meta.worktree}
          toolStatus={props.status}
          executionId={meta.executionId}
          viewer={{
            conversationId: props.conversationId,
            ownedBy: conversations.find((conversation) => conversation.id === props.conversationId)?.ownedBy,
          }}
        />
      </div>
    )
  }

  // 历史调用只保留当次状态；查看详情统一打开子会话抽屉，不在时间线展开。
  if (!isLatest) {
    return (
      <SubagentHistoryRow
        childId={childId}
        status={props.status}
        isError={props.isError}
        prompt={toolSummary.prompt}
        durationMs={props.durationMs}
      />
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
      viewer={{
        conversationId: props.conversationId,
        ownedBy: conversations.find((conversation) => conversation.id === props.conversationId)?.ownedBy,
      }}
    />
  )
}
