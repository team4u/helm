/**
 * builtin:workflow 插件工作流运行卡组件：
 * - WorkflowToolView：时间线内 SubagentWorkflow 工具调用（tool.view 扩展点）；
 * - WorkflowRunCardBody：工作流运行卡共用执行树视图（时间线与工作台共用）；
 *   run 内节点卡族见 WorkflowNodeCards，重放表单见 WorkflowReplayForm。
 */
import { useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  PopoverClose,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  formatCompactTimestamp,
  formatDurationMs,
  useConversations,
  usePluginContext,
  useToolActivity,
} from '@helm/plugin-client'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import { WorkflowNodeCard } from './WorkflowNodeCards.tsx'
import { WorkflowReplayForm } from './WorkflowReplayForm.tsx'
import { useElapsedNowMs, usePluginSessionDoc } from './hooks.ts'
import { SPIN, RUN_LABEL, RUN_BADGE, PHASE_ICON, EXECUTION_LABEL, EXECUTION_BADGE } from './presentation.ts'
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
  resolveWorkflowRunForTool,
  resolveWorkflowToolFallbackLabel,
} from './model-run.ts'
import type { DetachViewerScope } from './model-run.ts'
import { aggregateExecutionNodes, buildExecutionTree } from './model-execution-tree.ts'
import type { ExecutionNode } from './model-execution-tree.ts'
import { collectExecutionApprovals } from './model-execution-view.ts'
import { effectiveRunNodeStatus, executionRunStatus } from './model-execution-status.ts'
import { requestWorkbenchRunFocus } from './workbench-focus.ts'

// ---------------------------------------------------------------------------
// WorkflowToolView：tool.view 扩展点组件（SubagentWorkflow 工具行）
// ---------------------------------------------------------------------------

export function WorkflowToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
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
            { callId: props.callId, result: typeof props.result === 'string' ? props.result : undefined },
            viewerConversationId,
            runs,
          )
        : undefined,
    [props.callId, props.result, viewerConversationId, runs],
  )

  const childNodes = useMemo(
    () =>
      run === undefined || viewerConversationId === undefined
        ? []
        : (buildExecutionTree({
            rootConversationId: viewerConversationId,
            conversations,
            runs,
          }).find((node) => node.kind === 'workflow' && node.run?.id === run.id)?.children ?? []),
    [run, viewerConversationId, conversations, runs],
  )
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
  const isBgHandle = run === undefined && isBackgroundWorkflowResultHandle(resultText)

  const elapsedMs = useMemo(() => {
    if (run !== undefined) return resolveRunElapsedMs(run, nowMs)
    if (isBgHandle) return undefined
    if (props.status === 'running' && props.startedAt !== undefined && nowMs !== undefined) return Math.max(0, nowMs - props.startedAt)
    return props.durationMs
  }, [run, nowMs, isBgHandle, props.status, props.startedAt, props.durationMs])

  if (run === undefined) {
    const fallbackLabel = resolveWorkflowToolFallbackLabel(props.input)
    const isError = props.status === 'error'
    const badgeCls = isError ? 'badge-err' : isBgHandle || props.status === 'running' ? 'badge-accent' : 'badge-ok'
    const badgeText = isError ? '失败' : isBgHandle ? '后台运行中' : props.status === 'running' ? '运行中' : '已完成'
    const summaryText =
      isError && resultText !== undefined && resultText.trim() !== ''
        ? cleanInlineMarkdown(resultText.split(/\r?\n/, 1)[0] ?? '')
        : isBgHandle
          ? '已派发后台运行'
          : undefined

    return (
      <div className="trace-entry">
        <button
          type="button"
          className={`trace-row workflow-trace-row-btn${isError ? ' trace-row-error' : ''}`}
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          aria-label={`${fallbackLabel} — ${detailsOpen ? '收起详情' : '展开详情'}`}
          onClick={() => setDetailsOpen((v) => !v)}
        >
          <span className="trace-row-left">
            <Icon name={isError ? 'alert-circle' : isRunning ? 'loader' : 'workflow'} size={12} className={isRunning ? SPIN : undefined} />
            <span className="trace-tool-name">{fallbackLabel}</span>
            {summaryText !== undefined ? (
              <span className={`trace-tool-summary${isError ? ' workflow-trace-error' : ''}`} title={summaryText}>
                {summaryText}
              </span>
            ) : null}
          </span>
          <span className="trace-row-right workflow-trace-right">
            <span className={`badge workflow-trace-badge ${badgeCls}`}>{badgeText}</span>
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
  const isBlocked = displayStatus === 'blocked'
  const statusBadgeCls =
    effectiveStatus !== undefined && effectiveStatus !== selfRunStatus
      ? (EXECUTION_BADGE[effectiveStatus] ?? 'badge-neutral')
      : (RUN_BADGE[run.status] ?? 'badge-neutral')
  const statusBadgeText =
    effectiveStatus !== undefined && effectiveStatus !== selfRunStatus
      ? (EXECUTION_LABEL[effectiveStatus] ?? effectiveStatus)
      : (RUN_LABEL[run.status] ?? run.status)

  const progressPart = nodes.length > 0 ? `${doneCount}/${nodes.length} 节点` : undefined
  const activeNode = nodes.find((n) => n.status === 'running')
  const livePart = activeNode !== undefined ? `进行中: ${activeNode.label ?? activeNode.id}` : undefined
  const errorPart =
    run.error !== undefined && run.error.trim() !== '' ? cleanInlineMarkdown(run.error.split(/\r?\n/, 1)[0] ?? '') : undefined
  const summaryParts = [progressPart, isError ? errorPart : isRunning ? livePart : undefined].filter(
    (part): part is string => part !== undefined && part !== '',
  )
  const summaryText = summaryParts.join(' · ') || run.description

  return (
    <div className="trace-entry">
      <button
        type="button"
        className={`trace-row workflow-trace-row-btn${isError ? ' trace-row-error' : ''}`}
        aria-label={`工作流 ${run.name}${summaryText ? ` · ${summaryText}` : ''} — 在工作台查看详情`}
        onClick={() => {
          requestWorkbenchRunFocus(viewerConversationId ?? run.conversationId, run.id)
          ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)
        }}
      >
        <span className="trace-row-left">
          <Icon
            name={isError ? 'alert-circle' : isBlocked ? 'alert-triangle' : isRunning ? 'loader' : 'workflow'}
            size={12}
            className={isRunning ? SPIN : undefined}
          />
          <span className="trace-tool-name">{run.name}</span>
          {summaryText !== undefined && summaryText !== '' ? (
            <span className={`trace-tool-summary${isError ? ' workflow-trace-error' : ''}`} title={summaryText}>
              {summaryText}
            </span>
          ) : null}
        </span>
        <span className="trace-row-right workflow-trace-right">
          <span className={`badge workflow-trace-badge ${statusBadgeCls}`}>{statusBadgeText}</span>
          {elapsedMs !== undefined ? <span className="trace-duration tabular-nums">{formatDurationMs(elapsedMs)}</span> : null}
          <Icon name="chevron-right" size={11} />
        </span>
      </button>
    </div>
  )
}

/** 工作流运行卡共用执行树视图，在途按钮用同步 ref 防止重复提交。 */
export function WorkflowRunCardBody(props: {
  run: WorkflowRunSummary
  cardOpen: boolean
  onToggleCard: () => void
  resultOpen: boolean
  onToggleResult: () => void
  toolProps?: { input?: unknown; result?: unknown; artifactRef?: string }
  inWorkbench: boolean
  /** 查看方作用域（会话 + 归属）：前台同步 run 的「转入后台」可见性判定。 */
  viewer?: DetachViewerScope
  /** 统一执行树子节点（agent 节点会话的深层后代；缺省仅展示 run 自身节点）。 */
  childNodes?: ExecutionNode[]
}): ReactNode {
  const ctx = usePluginContext()
  const { run, cardOpen, toolProps, inWorkbench } = props
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [replayOpen, setReplayOpen] = useState(false)
  const [replayArgs, setReplayArgs] = useState('')
  const [replayError, setReplayError] = useState<string | undefined>(undefined)
  const nodes = run.nodes ?? []
  const done = nodes.filter((n) => n.status === 'done').length
  const tokens = nodes.reduce((sum, n) => sum + (n.tokens ?? 0), 0)
  const sections = useMemo(() => buildWorkflowPhaseSections(run), [run])
  const logs = useMemo(() => extractWorkflowLogs(run), [run])

  // 统一执行树：子树计数与后代审批（存在深层后代时才展示，不虚构）。
  const childNodes = props.childNodes ?? []
  const subtree = useMemo(() => aggregateExecutionNodes(childNodes), [childNodes])
  const deeperCount = subtree.total - nodes.length
  const approvals = useMemo(() => collectExecutionApprovals(childNodes, 3), [childNodes])
  const descendantApprovals = subtree.blocked
  // 主徽章有效状态：与执行树同源（自身 run 终态 + 子树聚合）；后台 / 深层
  // 子任务未结算（working / blocked / error / pending）时不假完成，自身终态
  // 另标清楚（自身已失败 / 中止时保留更具体的终态文案）。
  const selfRunStatus = executionRunStatus(run)
  const effectiveStatus = effectiveRunNodeStatus(run, subtree)

  // 运行中秒表（SSR 首帧确定性）：总耗时随秒表动态推进，结束定格在
  // createdAt → updatedAt 真实边界。
  const nowMs = useElapsedNowMs(run.status === 'running')
  const elapsedMs = resolveRunElapsedMs(run, nowMs)

  /** 同步 ref 防重复：渲染尚未刷新时连点也不重复发请求；错误如实通知，不覆盖成功。 */
  const guarded = (dispatch: () => Promise<unknown>, failMessage: string): void => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    dispatch()
      .catch((err: unknown) => ctx.notify(`${failMessage}：${err instanceof Error ? err.message : String(err)}`, 'error'))
      .finally(() => {
        inFlight.current = false
        setBusy(false)
      })
  }
  const abort = (): void => {
    guarded(() => ctx.callAction('abort', { runId: run.id }), '中止工作流失败')
  }
  // 转入后台：仅运行中的前台同步 run（父回合工具调用阻塞等待处可放行）；
  // Detach releases the current call; settlement reports use steer.
  const detach = (): void => {
    guarded(
      () =>
        ctx
          .callAction('detach', { runId: run.id })
          .then(() => ctx.notify(`已转入后台（运行 ${run.id}）：当前调用将收到后台句柄，完成后自动汇报`)),
      '转入后台失败',
    )
  }
  const resume = (): void => {
    guarded(
      () => ctx.callAction('run', { resumeFromRunId: run.id, conversationId: run.conversationId }),
      '断点恢复失败',
    )
  }
  // 重放：completed DSL run（含内联）经 resumeFromRunId 发起新 run，新 run 保留
  // 原会话；空白 args 沿用原 args，显式 args 严格解析后覆盖。缓存只复用调用
  // 载荷相同的前缀节点，首次失配起重执行——不承诺改参必命中缓存。
  const replay = (): void => {
    const parsed = parseWorkflowArgsInput(replayArgs)
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
          .then(() => ctx.notify(`重放已受理（源 run ${run.id}；新 run 保留原会话与原脚本源）`)),
      '重放失败',
    )
  }

  // 一键保存内联 run 为工作流定义（save fromRunId：缺省名用 meta.name；重名/
  // 语法错误等由动作端如实拒绝，绝不伪造成功）。
  const saveAsWorkflow = (): void => {
    guarded(
      () =>
        ctx
          .callAction('save', { fromRunId: run.id })
          .then((raw) => {
            const parsed = parseWorkflowSaveResult(raw)
            if (parsed === undefined) {
              throw new Error('保存返回结构不合法（动作返回非预期形状）')
            }
            ctx.notify(
              parsed.created
                ? `已保存为工作流定义 ${parsed.workflow.name}（可在工作流库查看）`
                : `已覆盖工作流定义 ${parsed.workflow.name}`,
            )
          }),
      '保存工作流失败',
    )
  }

  const resultJson = useMemo(() => stringifyPretty(run.result), [run.result])

  return (
    <section className="card workflow-run-card" aria-label={`工作流：${run.name}`}>
      <div className="stack-row workflow-run-header">
        <button type="button" className="btn btn-ghost btn-sm" onClick={props.onToggleCard} title={cardOpen ? '收起工作流卡' : '展开工作流卡'}>
          <Icon name={cardOpen ? 'chevron-down' : 'chevron-right'} size={12} />
        </button>
        <Icon name={run.kind === 'subagent' ? 'bot' : 'terminal'} />
        <strong>{run.name}</strong>
        {effectiveStatus !== selfRunStatus ? (
          <>
            <span
              className={`badge ${EXECUTION_BADGE[effectiveStatus] ?? 'badge-neutral'}`}
              title={`run 自身${RUN_LABEL[run.status] ?? run.status}；子树仍有未结算任务（${EXECUTION_LABEL[effectiveStatus] ?? effectiveStatus}）`}
            >
              {EXECUTION_LABEL[effectiveStatus] ?? effectiveStatus}
            </span>
            <span className="badge badge-neutral" title={`run 自身状态：${RUN_LABEL[run.status] ?? run.status}`}>
              {`自身${RUN_LABEL[run.status] ?? run.status}`}
            </span>
          </>
        ) : (
          <span className={`badge ${RUN_BADGE[run.status] ?? 'badge-neutral'}`}>{RUN_LABEL[run.status] ?? run.status}</span>
        )}
        {run.replayedFrom !== undefined ? (
          <span className="badge badge-warn" title={`从 journal 前缀重放恢复（源 run ${run.replayedFrom}）`}>cached 重放</span>
        ) : null}
        {run.savedName !== undefined ? (
          <span className="badge badge-neutral" title={`已保存工作流：${run.savedName}`}>已保存定义</span>
        ) : null}
        <span className="workflow-run-header-spacer" />
        <span className="workflow-run-stats tabular-nums">
          {nodes.length > 0 ? <span>{`节点 ${done}/${nodes.length}`}</span> : null}
          {deeperCount > 0 ? <span>{`子树 ${subtree.done}/${subtree.total}`}</span> : null}
          {tokens > 0 ? <span>{`${tokens.toLocaleString()} Tokens`}</span> : null}
          {elapsedMs !== undefined ? <span>{formatDurationMs(elapsedMs)}</span> : null}
        </span>
        {descendantApprovals > 0 ? (
          <span
            className="badge badge-warn"
            title={`后代等待审批：${approvals.map((item) => item.text).join('；')}`}
          >
            {`审批 ${descendantApprovals}`}
          </span>
        ) : null}
        {run.status === 'running' ? (
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={abort}>
            <Icon name="square" size={11} />
            中止
          </button>
        ) : null}
        {canDetachForegroundRun(run, props.viewer) ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={detach}
            title={ctx.translate({ en: 'Move this workflow to the background; the current call returns a handle and the result arrives as an interjection.', 'zh-CN': '将工作流转入后台，当前调用立即返回句柄，完成后自动插话汇报' })}
          >
            <Icon name="arrow-down-to-line" size={11} />
            转入后台
          </button>
        ) : null}
        {canResumeWorkflowRun(run) ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={resume} title="从同 run 的 journal 断点恢复：重放已完成前缀，仅重跑失败/未完成节点（沿用原脚本与 args；不支持改参换目标）">
            <Icon name="rotate-cw" size={11} />
            断点恢复
          </button>
        ) : null}
        {canReplayWorkflowRun(run) || canSaveRunAsWorkflow(run) ? (
          <PopoverRoot>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                aria-label="更多操作"
                title="更多工作流操作"
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
                      重放
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
                      保存为工作流
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
            工作台详情
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
      {cardOpen ? (
        <>
          <div className="kv-grid workflow-run-meta">
            <span className="kv-key">运行 ID</span>
            <span className="kv-val mono">{run.id}</span>
            <span className="kv-key">发起时间</span>
            <span className="kv-val tabular-nums">{formatCompactTimestamp(run.createdAt)}</span>
            <span className="kv-key">更新时间</span>
            <span className="kv-val tabular-nums">{formatCompactTimestamp(run.updatedAt)}</span>
            {run.replayedFrom !== undefined ? (
              <>
                <span className="kv-key">源 run</span>
                <span className="kv-val mono">{run.replayedFrom}</span>
              </>
            ) : null}
            {run.savedName !== undefined ? (
              <>
                <span className="kv-key">保存定义</span>
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
          {run.error !== undefined ? <p className="callout callout--error">{run.error}</p> : null}
        </>
      ) : null}
      {toolProps !== undefined ? <ToolCallDetailsInline input={toolProps.input} result={toolProps.result} artifactRef={toolProps.artifactRef} /> : null}
    </section>
  )
}
