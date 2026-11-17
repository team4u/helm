/**
 * builtin:workflow plugin workflow run card components:
 * - WorkflowToolView: SubagentWorkflow tool calls in the timeline (tool.view
 *   extension point; skips root execution-tree rebuild when the run has no
 *   child conversations);
 * - WorkflowRunCardBody: shared execution tree view of workflow run cards;
 * - WorkflowRunResultBox: shared collapsed preview + on-demand `inspect` full
 *   result expansion for slimmed projected runs (`hasResult` / `resultPreview`).
 */
import { useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  MarkdownText,
  PopoverClose,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  StatusLight,
  formatCompactTimestamp,
  formatDurationMs,
  resolveLocalizedText,
  useConversations,
  usePluginContext,
  usePluginLocale,
  useToolActivity,
  type LocalizedText,
} from '@helm/plugin-client'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import { WorkflowNodeCard } from './WorkflowNodeCards.tsx'
import { useElapsedNowMs, useInspectedRunResult, usePluginSessionDoc } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { cleanInlineMarkdown, stringifyPretty } from './model-format.ts'
import { canSaveRunAsWorkflow, parseWorkflowArgsInput, parseWorkflowSaveResult } from './model-library.ts'
import {
  buildWorkflowPhaseSections,
  canDetachForegroundRun,
  canReplayWorkflowRun,
  canResumeWorkflowRun,
  extractWorkflowLogs,
  formatNodeOutputPreview,
  isBackgroundWorkflowResultHandle,
  resolveRunElapsedMs,
  resolveWorkflowRunDisplayName,
  resolveWorkflowRunForTool,
  resolveWorkflowToolFallbackLabel,
} from './model-run.ts'
import type { DetachViewerScope } from './model-run.ts'
import { aggregateExecutionNodes, buildExecutionTree, buildLeafNodesForRun } from './model-execution-tree.ts'
import type { ExecutionNode } from './model-execution-tree.ts'
import { collectExecutionApprovals } from './model-execution-view.ts'
import { effectiveRunNodeStatus, executionLightStatus, executionRunStatus } from './model-execution-status.ts'
import { requestWorkbenchRunFocus } from './workbench-focus.ts'
import {
  ACTION_ABORT,
  ACTION_DETACH,
  actionDetachDone,
  approvalsBadge,
  approvalsTitle,
  executionStatusLabel,
  externalErrorJoiner,
  PHASE_ICON,
  REPLAY_ARGS_PLACEHOLDER,
  replayArgsAria,
  REPLAY_HINT,
  replayMeta,
  REPLAY_SUBMIT,
  REPLAY_SUBMIT_ARIA,
  REPLAY_SUBMIT_TITLE,
  RUN_CARD_ABORT_FAILED,
  RUN_CARD_CACHED_REPLAY,
  RUN_CARD_DETACH_FAILED,
  runCardAriaLabel,
  RUN_CARD_COLLAPSE_TITLE,
  RUN_CARD_EXPAND_TITLE,
  runCardNodesStat,
  runCardReplayAccepted,
  RUN_CARD_REPLAY,
  RUN_CARD_REPLAY_FAILED,
  runCardReplayBadgeTitle,
  RUN_CARD_RESUME,
  RUN_CARD_RESUME_FAILED,
  RUN_CARD_RESUME_TITLE,
  runCardSaveCreated,
  runCardSaveInvalidResult,
  runCardSaveOverwritten,
  RUN_CARD_SAVE_AS,
  RUN_CARD_SAVE_FAILED,
  runCardSavedBadgeTitle,
  RUN_CARD_SAVED_BADGE,
  runCardSelfStateTitle,
  runCardSubtreeStat,
  runCardTokensStat,
  selfStatusLabel,
  SPIN,
  traceActiveNode,
  TRACE_BG_DISPATCHED,
  TRACE_RUN_BACKGROUND,
  TRACE_RUN_COMPLETED,
  TRACE_RUN_FAILED,
  TRACE_RUN_RUNNING,
  traceNodeProgress,
  traceToggleDetailsLabel,
  traceWorkflowRowLabel,
  RUN_COLLAPSE_RESULT,
  RUN_EXPAND_RESULT,
  RUN_KV_CREATED_AT,
  RUN_KV_RUN_ID,
  RUN_KV_SAVED_DEF,
  RUN_KV_SOURCE_RUN,
  RUN_KV_UPDATED_AT,
  RUN_NO_NODES,
  RUN_RESULT_LOADING,
  RUN_RESULT_SECTION,
  RUN_CARD_DETACH_TITLE,
  RUN_CARD_MORE_ARIA,
  RUN_CARD_MORE_TITLE,
  RUN_CARD_WORKBENCH_DETAILS,
  runStatusLabel,
} from './copy.ts'

function WorkflowReplayForm(props: {
  run: WorkflowRunSummary
  replayArgs: string
  onReplayArgsChange: (value: string) => void
  replayError: string | undefined
  busy: boolean
  onReplay: () => void
}): ReactNode {
  const { run, busy, replayArgs, replayError } = props
  const locale = usePluginLocale()
  return (
    <div className="workflow-replay-form">
      <div className="workflow-replay-meta">
        {replayMeta(run.id, run.conversationId, run.savedName, locale)}
      </div>
      <div className="workflow-replay-hint">{resolveLocalizedText(REPLAY_HINT, locale)}</div>
      <div className="workflow-replay-row">
        <input
          className="workflow-replay-args"
          type="text"
          placeholder={resolveLocalizedText(REPLAY_ARGS_PLACEHOLDER, locale)}
          value={replayArgs}
          onChange={(e) => props.onReplayArgsChange(e.target.value)}
          aria-label={replayArgsAria(run.id, locale)}
        />
        <button
          type="button"
          className="btn btn-xs"
          disabled={busy}
          onClick={props.onReplay}
          aria-label={resolveLocalizedText(REPLAY_SUBMIT_ARIA, locale)}
          title={resolveLocalizedText(REPLAY_SUBMIT_TITLE, locale)}
        >
          <Icon name="rotate-cw" size={11} className={busy ? SPIN : undefined} />
          {resolveLocalizedText(REPLAY_SUBMIT, locale)}
        </button>
      </div>
      {replayError !== undefined ? <div className="callout callout--error">{replayError}</div> : null}
    </div>
  )
}

export function WorkflowRunResultBox(props: {
  run: WorkflowRunSummary
  resultOpen: boolean
  onToggleResult: () => void
  sectionLabel?: LocalizedText
  renderStringAsMarkdown?: boolean
}): ReactNode {
  const { run, resultOpen } = props
  const locale = usePluginLocale()
  const inspected = useInspectedRunResult(run, resultOpen)
  const collapsedPreview = useMemo(
    () => run.resultPreview ?? formatNodeOutputPreview(run.result, 160),
    [run.resultPreview, run.result],
  )
  const resultPretty = useMemo(
    () => (inspected.hasResolvedValue ? stringifyPretty(inspected.result) : undefined),
    [inspected.hasResolvedValue, inspected.result],
  )

  if (run.status !== 'completed' || !inspected.hasResult) return null

  return (
    <div className="workflow-result-box">
      <div className="workflow-result-header">
        <span className="trace-section-label">{resolveLocalizedText(props.sectionLabel ?? RUN_RESULT_SECTION, locale)}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={props.onToggleResult}>
          <Icon name={resultOpen ? 'chevron-down' : 'chevron-right'} size={11} />
          {resolveLocalizedText(resultOpen ? RUN_COLLAPSE_RESULT : RUN_EXPAND_RESULT, locale)}
        </button>
      </div>
      {resultOpen ? (
        inspected.loading ? (
          <div className="loading-state">{resolveLocalizedText(RUN_RESULT_LOADING, locale)}</div>
        ) : inspected.error !== undefined ? (
          <div className="callout callout--error">{inspected.error}</div>
        ) : props.renderStringAsMarkdown === true && typeof inspected.result === 'string' ? (
          <MarkdownText text={inspected.result} />
        ) : resultPretty !== undefined ? (
          <pre className="code-block-pre workflow-node-pre selectable"><code>{resultPretty}</code></pre>
        ) : null
      ) : collapsedPreview !== undefined ? (
        <div className="workflow-result-preview selectable" title={collapsedPreview}>{collapsedPreview}</div>
      ) : null}
    </div>
  )
}

export function WorkflowToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const viewerConversationId = props.conversationId ?? ctx.conversationId
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>(
    'runs',
    viewerConversationId !== undefined ? { conversationId: viewerConversationId } : undefined,
  )
  const conversations = useConversations()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()

  const runs = runsDoc?.runs ?? []
  const run = useMemo(
    () =>
      viewerConversationId !== undefined
        ? resolveWorkflowRunForTool(
            {
              callId: props.callId,
              structuredOutput: props.structuredOutput,
              result: typeof props.result === 'string' ? props.result : undefined,
            },
            viewerConversationId,
            runs,
          )
        : undefined,
    [props.callId, props.structuredOutput, props.result, viewerConversationId, runs],
  )

  const hasChildConversations = useMemo(
    () => (run?.nodes ?? []).some((n) => n.conversationId !== undefined),
    [run],
  )
  const leafOnlyNodes = useMemo(
    () => (run !== undefined && !hasChildConversations ? buildLeafNodesForRun(run) : undefined),
    [run, hasChildConversations],
  )
  const treeChildNodes = useMemo(
    () =>
      run === undefined || viewerConversationId === undefined || !hasChildConversations
        ? []
        : (buildExecutionTree({
            rootConversationId: viewerConversationId,
            conversations,
            runs,
          }).find((node) => node.kind === 'workflow' && node.run?.id === run.id)?.children ?? []),
    [run, viewerConversationId, hasChildConversations, conversations, runs],
  )
  const childNodes = leafOnlyNodes ?? treeChildNodes
  const subtree = useMemo(() => aggregateExecutionNodes(childNodes), [childNodes])
  const effectiveStatus = run !== undefined ? effectiveRunNodeStatus(run, subtree) : undefined
  const toolActive = run !== undefined ? run.status === 'running' : props.status === 'running'
  const isRunning =
    run !== undefined
      ? run.status === 'running' || effectiveStatus === 'working' || effectiveStatus === 'blocked'
      : props.status === 'running'

  useToolActivity(props.callId, toolActive)
  const nowMs = useElapsedNowMs(toolActive)
  const resultText = typeof props.result === 'string' ? props.result : undefined
  const isBgHandle = run === undefined && isBackgroundWorkflowResultHandle(props.structuredOutput, resultText)

  const elapsedMs = useMemo(() => {
    if (run !== undefined) return resolveRunElapsedMs(run, nowMs)
    if (isBgHandle) return undefined
    if (props.status === 'running' && props.startedAt !== undefined && nowMs !== undefined) return Math.max(0, nowMs - props.startedAt)
    return props.durationMs
  }, [run, nowMs, isBgHandle, props.status, props.startedAt, props.durationMs])

  if (run === undefined) {
    const fallbackLabel = resolveWorkflowToolFallbackLabel(props.input, locale)
    const isError = props.status === 'error'
    const lightStatus = isError ? 'failed' : isBgHandle || props.status === 'running' ? 'running' : 'completed'
    const badgeText = isError
      ? resolveLocalizedText(TRACE_RUN_FAILED, locale)
      : isBgHandle
        ? resolveLocalizedText(TRACE_RUN_BACKGROUND, locale)
        : props.status === 'running'
          ? resolveLocalizedText(TRACE_RUN_RUNNING, locale)
          : resolveLocalizedText(TRACE_RUN_COMPLETED, locale)
    const summaryText =
      isError && resultText !== undefined && resultText.trim() !== ''
        ? cleanInlineMarkdown(resultText.split(/\r?\n/, 1)[0] ?? '')
        : isBgHandle
          ? resolveLocalizedText(TRACE_BG_DISPATCHED, locale)
          : undefined

    return (
      <div className="trace-entry">
        <button
          type="button"
          className={`trace-row workflow-trace-row-btn${isError ? ' trace-row-error' : ''}`}
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          aria-label={traceToggleDetailsLabel(fallbackLabel, detailsOpen, locale)}
          onClick={() => setDetailsOpen((v) => !v)}
        >
          <span className="trace-row-left">
            <Icon name="workflow" size={12} />
            <span className="trace-tool-name workflow-trace-name">{fallbackLabel}</span>
            {summaryText !== undefined ? (
              <span className={`trace-tool-summary${isError ? ' workflow-trace-error' : ''}`} title={summaryText}>
                {summaryText}
              </span>
            ) : null}
          </span>
          <span className="trace-row-right workflow-trace-right">
            <StatusLight status={lightStatus} label={badgeText} />
            {elapsedMs !== undefined ? <span className="trace-duration tabular-nums">{formatDurationMs(elapsedMs)}</span> : null}
            <Icon name={detailsOpen ? 'chevron-down' : 'chevron-right'} size={11} />
          </span>
        </button>
        <div id={detailsId} hidden={!detailsOpen}>
          {detailsOpen ? (
            <ToolCallDetailsInline input={props.input} result={props.result} artifactRef={props.artifactRef} />
          ) : null}
        </div>
      </div>
    )
  }

  const nodes = run.nodes ?? []
  const doneCount = nodes.filter((n) => n.status === 'done').length
  const selfRunStatus = executionRunStatus(run)
  const displayStatus = effectiveStatus ?? selfRunStatus
  const isError = run.status === 'failed' || run.status === 'aborted' || displayStatus === 'error'
  const statusBadgeText =
    effectiveStatus !== undefined && effectiveStatus !== selfRunStatus
      ? executionStatusLabel(effectiveStatus, locale)
      : runStatusLabel(run.status, locale)

  const displayName = resolveWorkflowRunDisplayName(run)
  const progressPart = nodes.length > 0 ? traceNodeProgress(doneCount, nodes.length, locale) : undefined
  const activeNode = nodes.find((n) => n.status === 'running')
  const livePart = activeNode !== undefined ? traceActiveNode(activeNode.label ?? activeNode.id, locale) : undefined
  const errorPart =
    run.error !== undefined && run.error.trim() !== '' ? cleanInlineMarkdown(run.error.split(/\r?\n/, 1)[0] ?? '') : undefined
  const summaryParts = [progressPart, isError ? errorPart : isRunning ? livePart : undefined].filter(
    (part): part is string => part !== undefined && part !== '',
  )
  const summaryText =
    summaryParts.join(' · ') ||
    (run.description !== undefined && run.description.trim() !== displayName ? run.description : undefined)

  return (
    <div className="trace-entry">
      <button
        type="button"
        className={`trace-row workflow-trace-row-btn${isError ? ' trace-row-error' : ''}`}
        aria-label={traceWorkflowRowLabel(displayName, summaryText, locale)}
        onClick={() => {
          requestWorkbenchRunFocus(viewerConversationId ?? run.conversationId, run.id)
          ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)
        }}
      >
        <span className="trace-row-left">
          <Icon name="workflow" size={12} />
          <span className="trace-tool-name workflow-trace-name">{displayName}</span>
          {summaryText !== undefined && summaryText !== '' ? (
            <span className={`trace-tool-summary${isError ? ' workflow-trace-error' : ''}`} title={summaryText}>
              {summaryText}
            </span>
          ) : null}
        </span>
        <span className="trace-row-right workflow-trace-right">
          <StatusLight
            status={
              effectiveStatus !== undefined && effectiveStatus !== selfRunStatus
                ? executionLightStatus(effectiveStatus, run)
                : run.status
            }
            label={statusBadgeText}
          />
          {elapsedMs !== undefined ? <span className="trace-duration tabular-nums">{formatDurationMs(elapsedMs)}</span> : null}
          <Icon name="chevron-right" size={11} />
        </span>
      </button>
    </div>
  )
}

export function WorkflowRunCardBody(props: {
  run: WorkflowRunSummary
  cardOpen: boolean
  onToggleCard: () => void
  resultOpen: boolean
  onToggleResult: () => void
  toolProps?: { input?: unknown; result?: unknown; artifactRef?: string }
  inWorkbench: boolean
  viewer?: DetachViewerScope
  childNodes?: ExecutionNode[]
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { run, cardOpen, toolProps, inWorkbench } = props
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const cardBodyId = useId()
  const [replayOpen, setReplayOpen] = useState(false)
  const [replayArgs, setReplayArgs] = useState('')
  const [replayError, setReplayError] = useState<string | undefined>(undefined)
  const nodes = run.nodes ?? []
  const done = nodes.filter((n) => n.status === 'done').length
  const tokens = nodes.reduce((sum, n) => sum + (n.tokens ?? 0), 0)
  const sections = useMemo(() => buildWorkflowPhaseSections(run, locale), [run, locale])
  const logs = useMemo(() => extractWorkflowLogs(run), [run])

  const childNodes = props.childNodes ?? []
  const subtree = useMemo(() => aggregateExecutionNodes(childNodes), [childNodes])
  const deeperCount = subtree.total - nodes.length
  const approvals = useMemo(() => collectExecutionApprovals(childNodes, 3, locale), [childNodes, locale])
  const descendantApprovals = subtree.blocked
  const selfRunStatus = executionRunStatus(run)
  const effectiveStatus = effectiveRunNodeStatus(run, subtree)

  const nowMs = useElapsedNowMs(run.status === 'running')
  const elapsedMs = resolveRunElapsedMs(run, nowMs)

  const guarded = (dispatch: () => Promise<unknown>, failMessage: string): void => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    dispatch()
      .catch((err: unknown) => ctx.notify(`${failMessage}${externalErrorJoiner(locale)}${err instanceof Error ? err.message : String(err)}`, 'error'))
      .finally(() => {
        inFlight.current = false
        setBusy(false)
      })
  }
  const abort = (): void => {
    guarded(() => ctx.callAction('abort', { runId: run.id }), resolveLocalizedText(RUN_CARD_ABORT_FAILED, locale))
  }
  const detach = (): void => {
    guarded(
      () =>
        ctx
          .callAction('detach', { runId: run.id })
          .then(() => ctx.notify(actionDetachDone(run.id, locale))),
      resolveLocalizedText(RUN_CARD_DETACH_FAILED, locale),
    )
  }
  const resume = (): void => {
    guarded(
      () => ctx.callAction('run', { resumeFromRunId: run.id, conversationId: run.conversationId }),
      resolveLocalizedText(RUN_CARD_RESUME_FAILED, locale),
    )
  }
  const replay = (): void => {
    const parsed = parseWorkflowArgsInput(replayArgs, locale)
    if (!parsed.ok) {
      setReplayError(parsed.error)
      return
    }
    setReplayError(undefined)
    guarded(
      () =>
        ctx
          .callAction('run', {
            resumeFromRunId: run.id,
            conversationId: run.conversationId,
            ...(parsed.args !== undefined ? { args: parsed.args } : {}),
          })
          .then(() => ctx.notify(runCardReplayAccepted(run.id, locale))),
      resolveLocalizedText(RUN_CARD_REPLAY_FAILED, locale),
    )
  }
  const saveAsWorkflow = (): void => {
    guarded(
      () =>
        ctx
          .callAction('save', { fromRunId: run.id })
          .then((raw) => {
            const parsed = parseWorkflowSaveResult(raw)
            if (parsed === undefined) {
              throw new Error(runCardSaveInvalidResult(locale))
            }
            ctx.notify(
              parsed.created
                ? runCardSaveCreated(parsed.workflow.name, locale)
                : runCardSaveOverwritten(parsed.workflow.name, locale),
            )
          }),
      resolveLocalizedText(RUN_CARD_SAVE_FAILED, locale),
    )
  }

  const displayName = resolveWorkflowRunDisplayName(run)

  return (
    <section className="card workflow-run-card" aria-label={runCardAriaLabel(displayName, locale)}>
      <div className="stack-row workflow-run-header">
        {/* 整块非动作头部即展开开关：真实 button 覆盖主信息位（灯/名称/统计），
            中止 / detach / 恢复 / 工作台等动作控件为右侧同级 sibling，无嵌套交互。 */}
        <button
          type="button"
          className="workflow-run-header-main"
          aria-expanded={cardOpen}
          aria-controls={cardBodyId}
          aria-label={traceToggleDetailsLabel(displayName, cardOpen, locale)}
          title={resolveLocalizedText(cardOpen ? RUN_CARD_COLLAPSE_TITLE : RUN_CARD_EXPAND_TITLE, locale)}
          onClick={props.onToggleCard}
        >
          <Icon name={cardOpen ? 'chevron-down' : 'chevron-right'} size={12} />
          <Icon name={run.kind === 'subagent' ? 'bot' : 'terminal'} />
          <strong className="workflow-run-header-name">{displayName}</strong>
          {effectiveStatus !== selfRunStatus ? (
            <>
              <StatusLight
                status={executionLightStatus(effectiveStatus, run)}
                label={executionStatusLabel(executionLightStatus(effectiveStatus, run), locale)}
              />
              <span className="badge badge-neutral" title={runCardSelfStateTitle(runStatusLabel(run.status, locale), locale)}>
                {selfStatusLabel(runStatusLabel(run.status, locale), locale)}
              </span>
            </>
          ) : (
            <StatusLight status={run.status} label={runStatusLabel(run.status, locale)} />
          )}
          {run.replayedFrom !== undefined ? (
            <span className="badge badge-warn" title={runCardReplayBadgeTitle(run.replayedFrom, locale)}>{resolveLocalizedText(RUN_CARD_CACHED_REPLAY, locale)}</span>
          ) : null}
          {run.savedName !== undefined ? (
            <span className="badge badge-neutral" title={runCardSavedBadgeTitle(run.savedName, locale)}>{resolveLocalizedText(RUN_CARD_SAVED_BADGE, locale)}</span>
          ) : null}
          <span className="workflow-run-stats tabular-nums">
            {nodes.length > 0 ? <span>{runCardNodesStat(done, nodes.length, locale)}</span> : null}
            {deeperCount > 0 ? <span>{runCardSubtreeStat(subtree.done, subtree.total, locale)}</span> : null}
            {tokens > 0 ? <span>{runCardTokensStat(tokens, locale)}</span> : null}
            {elapsedMs !== undefined ? <span>{formatDurationMs(elapsedMs)}</span> : null}
          </span>
          {descendantApprovals > 0 ? (
            <span
              className="badge badge-warn"
              title={approvalsTitle(approvals.map((item) => item.text), locale)}
            >
              {approvalsBadge(descendantApprovals, locale)}
            </span>
          ) : null}
        </button>
        {run.status === 'running' ? (
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={abort}>
            <Icon name="square" size={11} />
            {resolveLocalizedText(ACTION_ABORT, locale)}
          </button>
        ) : null}
        {canDetachForegroundRun(run, props.viewer) ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={detach}
            title={resolveLocalizedText(RUN_CARD_DETACH_TITLE, locale)}
          >
            <Icon name="arrow-down-to-line" size={11} />
            {resolveLocalizedText(ACTION_DETACH, locale)}
          </button>
        ) : null}
        {canResumeWorkflowRun(run) ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={resume} title={resolveLocalizedText(RUN_CARD_RESUME_TITLE, locale)}>
            <Icon name="rotate-cw" size={11} />
            {resolveLocalizedText(RUN_CARD_RESUME, locale)}
          </button>
        ) : null}
        {canReplayWorkflowRun(run) || canSaveRunAsWorkflow(run) ? (
          <PopoverRoot>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                aria-label={resolveLocalizedText(RUN_CARD_MORE_ARIA, locale)}
                title={resolveLocalizedText(RUN_CARD_MORE_TITLE, locale)}
              >
                <Icon name="more" size={12} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="workflow-run-menu-popover">
              <div className="workflow-run-menu">
                {canReplayWorkflowRun(run) ? (
                  <PopoverClose asChild>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm workflow-run-menu-item"
                      disabled={busy}
                      onClick={() => {
                        setReplayOpen((v) => !v)
                        setReplayError(undefined)
                      }}
                    >
                      <Icon name="rotate-cw" size={11} />
                      {resolveLocalizedText(RUN_CARD_REPLAY, locale)}
                    </button>
                  </PopoverClose>
                ) : null}
                {canSaveRunAsWorkflow(run) ? (
                  <PopoverClose asChild>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm workflow-run-menu-item"
                      disabled={busy}
                      onClick={saveAsWorkflow}
                    >
                      <Icon name="check" size={11} />
                      {resolveLocalizedText(RUN_CARD_SAVE_AS, locale)}
                    </button>
                  </PopoverClose>
                ) : null}
              </div>
            </PopoverContent>
          </PopoverRoot>
        ) : null}
        {!inWorkbench ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              requestWorkbenchRunFocus(run.conversationId, run.id)
              ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)
            }}
          >
            {resolveLocalizedText(RUN_CARD_WORKBENCH_DETAILS, locale)}
          </button>
        ) : null}
      </div>
      {replayOpen && canReplayWorkflowRun(run) ? (
        <WorkflowReplayForm
          run={run}
          replayArgs={replayArgs}
          onReplayArgsChange={(value) => {
            setReplayArgs(value)
            setReplayError(undefined)
          }}
          replayError={replayError}
          busy={busy}
          onReplay={replay}
        />
      ) : null}
      {run.description !== undefined && run.description !== '' ? <p className="workflow-run-description">{run.description}</p> : null}
      {/* 裸 div 承载 hidden：aria-controls 始终指向真实区域；内容仍按需挂载。 */}
      <div id={cardBodyId} hidden={!cardOpen}>
        {cardOpen ? (
          <>
          <div className="kv-grid workflow-run-meta">
            <span className="kv-key">{resolveLocalizedText(RUN_KV_RUN_ID, locale)}</span>
            <span className="kv-val mono">{run.id}</span>
            <span className="kv-key">{resolveLocalizedText(RUN_KV_CREATED_AT, locale)}</span>
            <span className="kv-val tabular-nums">{formatCompactTimestamp(run.createdAt)}</span>
            <span className="kv-key">{resolveLocalizedText(RUN_KV_UPDATED_AT, locale)}</span>
            <span className="kv-val tabular-nums">{formatCompactTimestamp(run.updatedAt)}</span>
            {run.replayedFrom !== undefined ? (
              <>
                <span className="kv-key">{resolveLocalizedText(RUN_KV_SOURCE_RUN, locale)}</span>
                <span className="kv-val mono">{run.replayedFrom}</span>
              </>
            ) : null}
            {run.savedName !== undefined ? (
              <>
                <span className="kv-key">{resolveLocalizedText(RUN_KV_SAVED_DEF, locale)}</span>
                <span className="kv-val mono">{run.savedName}</span>
              </>
            ) : null}
          </div>
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
                    <span
                      className={`phase-segment${section.status === 'running' ? ' phase-segment-active' : section.status === 'done' ? ' phase-segment-done' : section.status === 'failed' ? ' phase-segment-failed' : ''}`}
                      title={section.detail ?? section.title}
                    >
                      <Icon name={PHASE_ICON[section.status]} size={11} className={section.status === 'running' ? SPIN : undefined} />
                      {`${section.index + 1}. ${section.title}`}
                      {` (${section.doneCount}/${section.totalCount})`}
                    </span>
                  </div>
                ) : null}
                {section.nodes.map((node) => (
                  <WorkflowNodeCard
                    key={node.id}
                    node={node}
                    runConversationId={run.conversationId}
                    childNodes={childNodes.find((child) => child.runNode?.id === node.id)?.children}
                  />
                ))}
              </div>
            ))}
            {nodes.length === 0 ? <div className="workflow-phase-empty">{resolveLocalizedText(RUN_NO_NODES, locale)}</div> : null}
          </div>
          <WorkflowRunResultBox
            run={run}
            resultOpen={props.resultOpen}
            onToggleResult={props.onToggleResult}
          />
          {run.error !== undefined ? <p className="callout callout--error">{run.error}</p> : null}
          </>
        ) : null}
      </div>
      {toolProps !== undefined ? <ToolCallDetailsInline input={toolProps.input} result={toolProps.result} artifactRef={toolProps.artifactRef} /> : null}
    </section>
  )
}
