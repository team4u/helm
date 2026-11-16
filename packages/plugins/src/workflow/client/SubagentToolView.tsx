/**
 * builtin:workflow subagent 工具调用时间线单行渲染器：
 * - 与宿主 TimelineRows.tsx 的 26px `.trace-row` 同构，不在主时间线堆叠大卡片。
 * - 原生子会话点击直达右侧 ConversationDrawer；外部 CLI/托管运行点击定位右边栏工作台对应 run.id；
 *   未落库前置失败可原地展开参数与错误详情。
 * - 后台子代理派发句柄在途阶段绝不将 ~34ms 派发确认耗时当成子会话总耗时展示。
 */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  formatDurationMs,
  useConversation,
  useConversations,
  usePluginContext,
  useToolActivity,
} from '@helm/plugin-client'
import { useElapsedNowMs, usePluginSessionDoc } from './hooks.ts'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import {
  cleanInlineMarkdown,
  latestTurnStartedAt,
  parentToolSummaryOf,
  parseSubagentExecutionInfo,
  resolveRunElapsedMs,
  resolveSubagentConversationId,
  resolveSubagentElapsedMs,
  resolveSubagentExecutionMeta,
  resolveSubagentTaskTitle,
  subagentBadge,
} from './models.ts'
import { requestWorkbenchRunFocus } from './workbench-focus.ts'

export function SubagentToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const conversations = useConversations()
  const viewerConversationId = props.conversationId ?? ctx.conversationId
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>(
    'runs',
    viewerConversationId !== undefined ? { conversationId: viewerConversationId } : undefined,
  )
  const parentToolSummary = useMemo(() => parentToolSummaryOf(props), [props])
  const resultText = typeof props.result === 'string' ? props.result : undefined
  const runs = runsDoc?.runs ?? []

  const execInfo = useMemo(() => parseSubagentExecutionInfo(resultText), [resultText])
  const execMeta = useMemo(
    () =>
      viewerConversationId !== undefined
        ? resolveSubagentExecutionMeta({ callId: props.callId, result: props.result }, viewerConversationId, runs)
        : undefined,
    [props.callId, props.result, viewerConversationId, runs],
  )
  const childId = useMemo(
    () =>
      viewerConversationId !== undefined
        ? resolveSubagentConversationId(
            { callId: props.callId, input: props.input, result: props.result },
            viewerConversationId,
            conversations,
          )
        : undefined,
    [props.callId, props.input, props.result, viewerConversationId, conversations],
  )
  const childConv = useConversation(childId)
  const childSummary = useMemo(
    () => (childId !== undefined ? (conversations.find((c) => c.id === childId) ?? childConv.summary) : undefined),
    [childId, conversations, childConv.summary],
  )

  const backgroundRun = useMemo(() => {
    if (execMeta?.run !== undefined) return execMeta.run
    if (execInfo?.runId !== undefined) return runs.find((r) => r.id === execInfo.runId)
    return undefined
  }, [execMeta?.run, execInfo?.runId, runs])

  const isBgHandle = execInfo?.background === true && execInfo.runId !== undefined
  const handleStatus = execInfo?.status
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()

  const isRunning =
    props.status === 'running' ||
    childSummary?.status === 'working' ||
    childSummary?.status === 'blocked' ||
    backgroundRun?.status === 'running' ||
    (isBgHandle && backgroundRun === undefined && (handleStatus === 'running' || handleStatus === 'blocked'))

  useToolActivity(props.callId, isRunning)
  const nowMs = useElapsedNowMs(isRunning)

  const badge = subagentBadge(childSummary?.status, props.status, backgroundRun, {
    isBackgroundHandle: isBgHandle,
    handleStatus,
  })

  const rawPrompt =
    parentToolSummary.prompt ??
    (typeof props.input === 'object' &&
    props.input !== null &&
    !Array.isArray(props.input) &&
    typeof (props.input as Record<string, unknown>)['task'] === 'string'
      ? ((props.input as Record<string, unknown>)['task'] as string)
      : undefined)

  const taskTitle =
    childId !== undefined
      ? resolveSubagentTaskTitle(childSummary, childId, parentToolSummary, backgroundRun, childConv.detail?.entries)
      : cleanInlineMarkdown(rawPrompt ?? backgroundRun?.name ?? execMeta?.executionId ?? '子代理调用')

  const fallbackStartedAt = parentToolSummary.startedAt ?? latestTurnStartedAt(childConv.detail?.entries)
  const elapsedMs = useMemo(() => {
    if (childId !== undefined) {
      return resolveSubagentElapsedMs({
        ...(backgroundRun !== undefined ? { backgroundRun } : {}),
        toolSummary: parentToolSummary,
        ...(fallbackStartedAt !== undefined ? { startedAt: fallbackStartedAt } : {}),
        nowMs,
        status: badge.status,
      })
    }
    if (backgroundRun !== undefined) {
      return resolveRunElapsedMs(backgroundRun, nowMs)
    }
    if (isBgHandle) return undefined
    if (props.status === 'running' && props.startedAt !== undefined && nowMs !== undefined) {
      return Math.max(0, nowMs - props.startedAt)
    }
    return props.durationMs
  }, [
    childId,
    backgroundRun,
    parentToolSummary,
    fallbackStartedAt,
    nowMs,
    badge.status,
    isBgHandle,
    props.status,
    props.startedAt,
    props.durationMs,
  ])

  const isError =
    props.status === 'error' ||
    backgroundRun?.status === 'failed' ||
    backgroundRun?.status === 'aborted' ||
    childSummary?.status === 'error'

  const targetWorkbenchRunId = backgroundRun?.id ?? execInfo?.runId
  const canOpenChildDrawer = childId !== undefined
  const canOpenWorkbenchRun = !canOpenChildDrawer && targetWorkbenchRunId !== undefined
  const hasErrorText = props.status === 'error' && resultText !== undefined && resultText.trim() !== ''

  const baseTitle = taskTitle ?? '子代理调用'
  const displaySummary = hasErrorText && resultText !== undefined
    ? `${baseTitle} · ${cleanInlineMarkdown(resultText.split(/\r?\n/, 1)[0] ?? '')}`
    : execMeta?.nodeId !== undefined
      ? `${execMeta.nodeId} · ${baseTitle}`
      : baseTitle

  const handleActivate = (): void => {
    if (canOpenChildDrawer && childId !== undefined) {
      ctx.openConversationDrawer(childId)
      return
    }
    if (canOpenWorkbenchRun && targetWorkbenchRunId !== undefined) {
      requestWorkbenchRunFocus(viewerConversationId, targetWorkbenchRunId)
      ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)
      return
    }
    setDetailsOpen((prev) => !prev)
  }

  const labelTarget = canOpenChildDrawer
    ? `打开子会话 #${childId}`
    : canOpenWorkbenchRun
      ? `在工作台查看运行 ${targetWorkbenchRunId}`
      : detailsOpen
        ? '收起子代理调用详情'
        : '展开子代理调用详情'

  const toolName = childId !== undefined ? `子代理 #${childId}` : execMeta?.executionId !== undefined ? '外部代理' : '子代理'

  return (
    <div className="trace-entry">
      <button
        type="button"
        className={`trace-row workflow-trace-row-btn${isError ? ' trace-row-error' : ''}`}
        aria-label={`${toolName} ${displaySummary} — ${labelTarget}`}
        aria-expanded={!canOpenChildDrawer && !canOpenWorkbenchRun ? detailsOpen : undefined}
        aria-controls={!canOpenChildDrawer && !canOpenWorkbenchRun ? detailsId : undefined}
        onClick={handleActivate}
      >
        <span className="trace-row-left">
          <Icon name={isError ? 'alert-circle' : isRunning ? 'loader' : 'bot'} size={12} className={isRunning ? SPIN : undefined} />
          <span className="trace-tool-name">{toolName}</span>
          <span className={`trace-tool-summary${isError ? ' workflow-trace-error' : ''}`} title={displaySummary}>
            {displaySummary}
          </span>
        </span>
        <span className="trace-row-right workflow-trace-right">
          <span className={`badge workflow-trace-badge ${badge.badge}`}>{badge.label}</span>
          {elapsedMs !== undefined ? <span className="trace-duration tabular-nums">{formatDurationMs(elapsedMs)}</span> : null}
          <Icon
            name={canOpenChildDrawer ? 'external-link' : canOpenWorkbenchRun ? 'chevron-right' : detailsOpen ? 'chevron-down' : 'chevron-right'}
            size={11}
          />
        </span>
      </button>
      {!canOpenChildDrawer && !canOpenWorkbenchRun ? (
        <div id={detailsId} hidden={!detailsOpen}>
          {detailsOpen ? (
            <ToolCallDetailsInline input={props.input} result={props.result} artifactRef={props.artifactRef} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
