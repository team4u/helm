/**
 * builtin:workflow 插件工作流运行卡组件：
 * - WorkflowToolView：时间线内 SubagentWorkflow 工具调用（tool.view 扩展点）；
 * - WorkflowRunCardBody：工作流运行卡共用执行树视图（时间线与工作台共用）；
 *   run 内节点卡族见 WorkflowNodeCards，重放表单见 WorkflowReplayForm。
 */
import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { formatDurationMs, useConversations, usePluginContext, useToolActivity } from '@helm/plugin-client'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import { WorkflowNodeCard } from './WorkflowNodeCards.tsx'
import { WorkflowReplayForm } from './WorkflowReplayForm.tsx'
import { useElapsedNowMs, usePluginSessionDoc } from './hooks.ts'
import { SPIN, RUN_LABEL, RUN_BADGE, PHASE_ICON, EXECUTION_LABEL, EXECUTION_BADGE } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { stringifyPretty } from './model-format.ts'
import { canSaveRunAsWorkflow, parseWorkflowArgsInput, parseWorkflowSaveResult } from './model-library.ts'
import {
  buildWorkflowPhaseSections,
  canReplayWorkflowRun,
  canResumeWorkflowRun,
  extractWorkflowLogs,
  formatNodeOutputPreview,
  resolveRunElapsedMs,
  resolveWorkflowRunForTool,
} from './model-run.ts'
import { aggregateExecutionNodes, buildExecutionTree } from './model-execution-tree.ts'
import type { ExecutionNode } from './model-execution-tree.ts'
import { collectExecutionApprovals } from './model-execution-view.ts'
import { effectiveRunNodeStatus, executionRunStatus } from './model-execution-status.ts'

// ---------------------------------------------------------------------------
// WorkflowToolView：tool.view 扩展点组件（SubagentWorkflow 工具行）
// ---------------------------------------------------------------------------

export function WorkflowToolView(props: ToolViewProps): ReactNode {
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>('runs', { conversationId: props.conversationId })
  const conversations = useConversations()
  const [cardOpen, setCardOpen] = useState(true)
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

  // 统一执行树：run 节点的子树（agent 节点会话的深层后代经会话链递归）。
  const childNodes = useMemo(
    () =>
      run === undefined
        ? undefined
        : buildExecutionTree({
            rootConversationId: props.conversationId,
            conversations,
            runs: runsDoc?.runs ?? [],
          }).find((node) => node.kind === 'workflow' && node.run?.id === run.id)?.children,
    [run, props.conversationId, conversations, runsDoc],
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
      childNodes={childNodes}
      cardOpen={cardOpen}
      onToggleCard={() => setCardOpen((v) => !v)}
      resultOpen={resultOpen}
      onToggleResult={() => setResultOpen((v) => !v)}
      toolProps={props}
      inWorkbench={false}
    />
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
  const hasNamedPhases = sections.length > 1 || (sections.length === 1 && sections[0]!.title !== '')

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
        <span style={{ flex: 1 }} />
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
        {canResumeWorkflowRun(run) ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={resume} title="从同 run 的 journal 断点恢复：重放已完成前缀，仅重跑失败/未完成节点（沿用原脚本与 args；不支持改参换目标）">
            <Icon name="rotate-cw" size={11} />
            断点恢复
          </button>
        ) : null}
        {canReplayWorkflowRun(run) ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              setReplayOpen((v) => !v)
              setReplayError(undefined)
            }}
            title="打开重放表单（resumeFromRunId：沿用原会话与原脚本源，args 可覆盖）"
          >
            <Icon name="rotate-cw" size={11} />
            重放
          </button>
        ) : null}
        {canSaveRunAsWorkflow(run) ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={saveAsWorkflow}
            title="把这个内联运行固化成跨会话可复用的工作流定义（保存名取脚本 meta.name）"
          >
            <Icon name="check" size={11} />
            保存为工作流
          </button>
        ) : null}
        {!inWorkbench ? (
          <button className="btn btn-sm" onClick={() => ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)}>
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
