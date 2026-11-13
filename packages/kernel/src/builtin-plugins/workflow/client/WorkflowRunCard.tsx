/**
 * builtin:workflow 插件工作流运行卡组件：
 * - WorkflowToolView：时间线内 SubagentWorkflow 工具调用（tool.view 扩展点）；
 * - WorkflowRunCardBody：工作流运行卡共用执行树视图（时间线与工作台共用）；
 * - WorkflowSubagentNodeCard / WorkflowExecutionNodeCard / WorkflowNodeCard /
 *   WorkflowNodeDetail：run 内节点卡（子代理一体化整卡 / 无会话节点扁平双层卡）。
 */
import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps, WorkflowNodeState, WorkflowRunSummary } from '@helm/protocol'
import { formatDurationMs, useConversations, usePluginContext, useToolActivity } from '@helm/plugin-client'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import { useElapsedNowMs, usePluginSessionDoc } from './hooks.ts'
import { SPIN, RUN_LABEL, RUN_BADGE, NODE_LABEL, NODE_BADGE, PHASE_ICON, EXECUTION_LABEL, EXECUTION_BADGE } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { SubagentLiveCard } from './SubagentCard.tsx'
import { WorktreeInspectSection } from './WorktreeInspectSection.tsx'
import { buildWorktreeSelector } from './model-worktree.ts'
import {
  buildWorkflowPhaseSections,
  canReplayWorkflowRun,
  canResumeWorkflowRun,
  extractWorkflowLogs,
  formatNodeOutputPreview,
  formatWorkflowNodeStats,
  hasNodeExtraDetail,
  resolveNodeSummaryText,
  resolveWorkflowRunForTool,
} from './model-run.ts'
import { canSaveRunAsWorkflow, parseWorkflowArgsInput, parseWorkflowSaveResult } from './model-library.ts'
import {
  aggregateExecutionNodes,
  buildExecutionTree,
  collectExecutionApprovals,
  effectiveRunNodeStatus,
  executionRunStatus,
} from './model-execution-tree.ts'
import type { ExecutionNode } from './model-execution-tree.ts'

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

  // 运行中秒表（SSR 首帧确定性）。
  const nowMs = useElapsedNowMs(run.status === 'running')
  const elapsedMs =
    run.status === 'running' && nowMs !== undefined && Number.isFinite(run.createdAt) && nowMs >= run.createdAt
      ? nowMs - run.createdAt
      : run.updatedAt - run.createdAt

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

  const resultJson = useMemo(() => {
    if (run.result === undefined) return undefined
    try {
      return JSON.stringify(run.result, null, 2) ?? String(run.result)
    } catch {
      return String(run.result)
    }
  }, [run.result])

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
          <span>{formatDurationMs(Math.max(0, elapsedMs))}</span>
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
        <div className="workflow-replay-form">
          <div className="workflow-replay-meta">
            源 run <code className="mono">{run.id}</code>（会话 #{run.conversationId}；
            {run.savedName !== undefined ? `已保存定义 ${run.savedName} 按最新文件内容执行` : '内联脚本沿用原源码'}）
          </div>
          <div className="workflow-replay-hint">缓存仅复用调用载荷完全相同的前缀节点；首次载荷失配起真实重执行，改参不保证命中缓存，含外部副作用的节点会照实重跑。</div>
          <div className="workflow-replay-row">
            <input
              className="workflow-replay-args"
              type="text"
              placeholder="args JSON（可选；空白沿用原 args，非空严格解析）"
              value={replayArgs}
              onChange={(e) => {
                setReplayArgs(e.target.value)
                setReplayError(undefined)
              }}
              aria-label={`重放 run ${run.id} 的 args JSON 覆盖`}
            />
            <button
              type="button"
              className="btn btn-xs"
              disabled={busy}
              onClick={replay}
              aria-label="发起重放"
              title="按 resumeFromRunId 发起重放（新 run 保留原会话；空白 args 沿用原 args）"
            >
              <Icon name="rotate-cw" size={11} className={busy ? SPIN : undefined} />
              发起重放
            </button>
          </div>
          {replayError !== undefined ? <div className="callout callout--error">{replayError}</div> : null}
        </div>
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

/** 工作流子代理节点：直接以一体化整卡直出（无手风琴折叠壳）。 */
function WorkflowSubagentNodeCard(props: { node: WorkflowNodeState; runConversationId: number; childNodes?: ExecutionNode[] }): ReactNode {
  const { node, childNodes } = props
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
        childNodes={childNodes}
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
      {node.error !== undefined ? <p className="callout callout--error">{node.error}</p> : null}
      {node.worktree !== undefined ? (
        <WorktreeInspectSection
          worktree={{
            path: node.worktree.path,
            branch: node.worktree.branch,
            ...(node.worktree.id !== undefined ? { id: node.worktree.id } : {}),
          }}
          nodeId={node.nodeId}
          baseCommit={node.worktree.baseCommit}
          taskLabel={node.label}
          parentConversationId={props.runConversationId}
        />
      ) : null}
    </div>
  )
}

/** 无原生子会话节点：动作与外部执行如实展示，均不伪造可导航的子会话。 */
function WorkflowExecutionNodeCard(props: { node: WorkflowNodeState; runConversationId: number }): ReactNode {
  const { node } = props
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
      {node.worktree !== undefined ? (
        <WorktreeInspectSection
          worktree={{
            path: node.worktree.path,
            branch: node.worktree.branch,
            ...(node.worktree.id !== undefined ? { id: node.worktree.id } : {}),
          }}
          nodeId={node.nodeId}
          baseCommit={node.worktree.baseCommit}
          taskLabel={node.label}
          parentConversationId={props.runConversationId}
        />
      ) : null}
    </div>
  )
}

/** 单节点卡片：子代理节点直出一体化整卡；动作节点直出扁平双层卡。全程无手风琴折叠。 */
function WorkflowNodeCard(props: { node: WorkflowNodeState; runConversationId: number; childNodes?: ExecutionNode[] }): ReactNode {
  const { node, childNodes } = props
  if (node.conversationId !== undefined) {
    return <WorkflowSubagentNodeCard node={node} childNodes={childNodes} runConversationId={props.runConversationId} />
  }
  return <WorkflowExecutionNodeCard node={node} runConversationId={props.runConversationId} />
}

/** 无原生子会话节点的结构化明细。 */
function WorkflowNodeDetail({ node }: { node: WorkflowNodeState }): ReactNode {
  const ctx = usePluginContext()
  const [cleaning, setCleaning] = useState(false)
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
        <div className="kv-grid">
          {rows.map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
              <span className="kv-key">{k}</span>
              <span className="kv-val mono">{v}</span>
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
        <button
          type="button"
          className="btn btn-xs"
          disabled={cleaning}
          onClick={() => {
            if (cleaning) return
            setCleaning(true)
            ctx
              .callAction('cleanup_worktree', buildWorktreeSelector(node.worktree!, node.nodeId))
              .then(() => ctx.notify(`已清理工作树 ${node.worktree!.branch}`))
              .catch((err: unknown) =>
                ctx.notify(`清理工作树失败：${err instanceof Error ? err.message : String(err)}`, 'error'),
              )
              .finally(() => setCleaning(false))
          }}
        >
          <Icon name="rotate-cw" size={11} className={cleaning ? SPIN : undefined} />
          清理工作树
        </button>
      ) : null}
    </div>
  )
}
