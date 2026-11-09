import { useEffect, useMemo, useState } from 'react'
import type { WorkflowNodeState, WorkflowRunSummary } from '@helm/protocol'
import { workflowsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { formatDurationMs, type ToolTrace } from './timeline-model.js'
import { resolveSubagentHeaderSnippet } from './subagent-live-model.js'
import { ToolCallDetails } from './ToolCallDetails.js'
import { SubagentLiveCard } from './SubagentLiveCard.js'
import {
  buildWorkflowPhaseSections,
  canResumeWorkflowRun,
  extractWorkflowLogs,
  formatWorkflowNodeStats,
  resolveNodeSummaryText,
  type WorkflowPhaseSection,
} from './workflow-card-model.js'

const NODE_ICON: Record<string, string> = {
  pending: 'clock',
  running: 'loader',
  done: 'check',
  failed: 'x',
  skipped: 'corner-down-right',
}

const NODE_LABEL: Record<string, string> = {
  pending: '待执行',
  running: '运行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
}

const NODE_BADGE: Record<string, string> = {
  pending: 'badge-neutral',
  running: 'badge-accent',
  done: 'badge-ok',
  failed: 'badge-err',
  skipped: 'badge-neutral',
}

const RUN_LABEL: Record<string, string> = {
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  aborted: '已中止',
}

const RUN_BADGE: Record<string, string> = {
  running: 'badge-accent',
  completed: 'badge-ok',
  failed: 'badge-err',
  aborted: 'badge-warn',
}

const PHASE_ICON: Record<WorkflowPhaseSection['status'], string> = {
  pending: 'circle',
  running: 'loader',
  done: 'check',
  failed: 'x',
}

/** 阶段分组小标题栏 + 该阶段全部节点行。 */
function WorkflowPhaseGroup({
  section,
  openNodes,
  toggleNode,
  onNavigate,
}: {
  section: WorkflowPhaseSection
  openNodes: ReadonlySet<string>
  toggleNode: (nodeId: string) => void
  onNavigate?: () => void
}) {
  return (
    <div className="workflow-phase-group">
      {section.title !== '' ? (
        <div className="workflow-phase-header">
          <HelmIcon
            name={PHASE_ICON[section.status]}
            size={11}
            className={section.status === 'running' ? 'spin-slow' : undefined}
          />
          <span className="workflow-phase-title">{`${section.index + 1}. ${section.title}`}</span>
          <span className="workflow-phase-count tabular-nums">{`(${section.doneCount}/${section.totalCount})`}</span>
          {section.detail !== undefined ? <span className="workflow-phase-detail" title={section.detail}>{section.detail}</span> : null}
        </div>
      ) : null}
      {section.nodes.length === 0 ? (
        section.title !== '' ? <div className="workflow-phase-empty">待进入此阶段</div> : null
      ) : (
        section.nodes.map((node) => (
          <WorkflowNodeRow key={node.id} node={node} open={openNodes.has(node.id)} onToggle={() => toggleNode(node.id)} onNavigate={onNavigate} />
        ))
      )}
    </div>
  )
}

/** 无原生子会话节点（action / cached 重放 / herdr 外部窗格）的结构化明细。 */
function WorkflowNodeDetailCard({ node }: { node: WorkflowNodeState }) {
  const rows: Array<[string, string]> = []
  if (node.agentType !== undefined) rows.push(['执行后端', node.agentType])
  if (node.executionId !== undefined) rows.push(['外部执行', node.executionId])
  if (node.nodeId !== undefined) rows.push(['执行节点', node.nodeId])
  if (node.effectiveCwd !== undefined) rows.push(['工作目录', node.effectiveCwd])
  if (node.worktree !== undefined) rows.push(['工作树', `${node.worktree.branch} @ ${node.worktree.path}`])
  if (node.model !== undefined) rows.push(['模型', node.model])
  if (node.durationMs !== undefined) rows.push(['耗时', formatDurationMs(node.durationMs)])
  if (node.tokens !== undefined && node.tokens > 0) rows.push(['Token', node.tokens.toLocaleString()])
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
          {node.gateCommand !== undefined ? (
            <pre className="code-block-pre workflow-node-pre">
              <code>{node.gateCommand}</code>
            </pre>
          ) : null}
          {node.gate !== undefined ? (
            <pre className={`code-block-pre workflow-node-pre${node.gate.ok ? '' : ' workflow-node-pre-err'}`}>
              <code>{node.gate.output}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
      {node.prompt !== undefined ? (
        <div>
          <div className="trace-section-label">Prompt</div>
          <pre className="code-block-pre workflow-node-pre">
            <code>{node.prompt}</code>
          </pre>
        </div>
      ) : null}
      {node.output !== undefined ? (
        <div>
          <div className="trace-section-label">Output</div>
          <pre className="code-block-pre workflow-node-pre">
            <code>{safeJsonStringify(node.output)}</code>
          </pre>
        </div>
      ) : null}
      {node.error !== undefined ? (
        <div>
          <div className="trace-section-label">Error</div>
          <pre className="code-block-pre workflow-node-pre workflow-node-pre-err">
            <code>{node.error}</code>
          </pre>
        </div>
      ) : null}
    </div>
  )
}

function safeJsonStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 单节点行：收起行高密度展示，展开体内嵌 SubagentLiveCard（默认展开防双重折叠）或结构化明细。 */
function WorkflowNodeRow({ node, open, onToggle, onNavigate }: { node: WorkflowNodeState; open: boolean; onToggle: () => void; onNavigate?: () => void }) {
  const store = useHelmStore()
  const child = node.conversationId !== undefined
    ? store.conversations.find((c) => c.id === node.conversationId)
    : undefined
  const pendingAskTitle = node.conversationId !== undefined
    ? store.pendingAsks.find((a) => a.conversationId === node.conversationId)?.title
    : undefined
  const isBlocked = node.status === 'running' && child?.status === 'blocked'
  const liveSnippet = node.status === 'running' ? resolveSubagentHeaderSnippet({
    badgeStatus: isBlocked ? 'blocked' : 'working',
    summary: child,
    live: node.conversationId !== undefined ? store.conversationLives[node.conversationId] : undefined,
    pendingAsk: pendingAskTitle ? { title: pendingAskTitle } : undefined,
  }) : undefined
  const summary = liveSnippet !== undefined
    ? { text: liveSnippet.kind === 'blocked' ? `等待审批：${liveSnippet.text}` : [liveSnippet.tag, liveSnippet.text].filter(Boolean).join(' · '), isError: liveSnippet.kind === 'error' }
    : resolveNodeSummaryText(node, child?.doing, child?.status, pendingAskTitle)
  const nodeStats = formatWorkflowNodeStats(node)
  return (
    <div className={`workflow-node-item${open ? ' workflow-node-item-open' : ''}`}>
      <button type="button" className="workflow-node-line" onClick={onToggle} title={open ? '收起节点详情' : '展开节点详情'}>
        <HelmIcon
          name={isBlocked ? 'alert-circle' : NODE_ICON[node.status] ?? 'circle'}
          size={11}
          className={node.status === 'running' && !isBlocked ? 'spin-slow' : undefined}
        />
        {node.kind === 'action' ? <span className="badge badge-neutral">动作</span> : null}
        <span className="workflow-node-label">{node.label ?? node.id}</span>
        <span className={`badge ${isBlocked ? 'badge-warn' : NODE_BADGE[node.status] ?? 'badge-neutral'}`}>{isBlocked ? '等待审批' : NODE_LABEL[node.status] ?? node.status}</span>
        {node.cached === true ? <span className="badge badge-warn">cached</span> : null}
        {node.attempt !== undefined && node.attempt > 1 ? (
          <span className="badge badge-neutral">{`第 ${node.attempt} 次`}</span>
        ) : null}
        {node.worktree !== undefined ? (
          <span className="badge badge-neutral subagent-worktree-badge" title={`隔离工作树：${node.worktree.path}`}>
            <HelmIcon name="git-branch" size={11} />
            {node.worktree.branch}
          </span>
        ) : null}
        {node.gate !== undefined ? (
          <span className={`badge ${node.gate.ok ? 'badge-ok' : 'badge-err'}`}>{node.gate.ok ? 'Gate 通过' : 'Gate 失败'}</span>
        ) : null}
        {summary.text !== undefined ? (
          <span
            className={`workflow-node-progress${summary.isError ? ' workflow-node-progress-err' : ''}`}
            title={summary.text}
          >
            {summary.text}
          </span>
        ) : null}
        <span className="workflow-node-right">
          {nodeStats.length > 0 ? (
            <span className="workflow-node-stats tabular-nums">{nodeStats.join(' · ')}</span>
          ) : null}
          {node.durationMs !== undefined ? (
            <span className="workflow-node-duration tabular-nums">{formatDurationMs(node.durationMs)}</span>
          ) : null}
          {node.conversationId !== undefined ? (
            <span
              className="btn btn-ghost btn-sm"
              role="button"
              title={`在分屏打开子会话 #${node.conversationId}`}
              onClick={(e) => {
                e.stopPropagation()
                store.openTarget({ kind: 'conversation', conversationId: node.conversationId! }, { split: true })
                onNavigate?.()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  store.openTarget({ kind: 'conversation', conversationId: node.conversationId! }, { split: true })
                  onNavigate?.()
                }
              }}
            >
              {`#${node.conversationId}`}
            </span>
          ) : null}
          <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
        </span>
      </button>
      {open ? (
        <div className="workflow-node-expanded">
          {node.conversationId !== undefined ? (
            <>
              <SubagentLiveCard
                childConversationId={node.conversationId}
                defaultExpanded={true}
                startedAt={node.startedAt}
                onNavigate={onNavigate}
                toolStatus={
                  node.status === 'running' ? 'running' : node.status === 'failed' ? 'error' : node.status === 'done' ? 'done' : 'unknown'
                }
                worktree={node.worktree}
              />
              {node.gate !== undefined ? (
                <div className="workflow-node-gate-extra">
                  <span className={`badge ${node.gate.ok ? 'badge-ok' : 'badge-err'}`}>{node.gate.ok ? 'Gate 通过' : 'Gate 失败'}</span>
                  {node.gateCommand !== undefined ? <code className="mono workflow-node-gate-cmd">{node.gateCommand}</code> : null}
                  {node.gate.output !== '' ? (
                    <pre className="code-block-pre workflow-node-pre">
                      <code>{node.gate.output}</code>
                    </pre>
                  ) : null}
                </div>
              ) : null}
              {node.error !== undefined ? <p className="jr-callout jr-callout-err">{node.error}</p> : null}
            </>
          ) : (
            <WorkflowNodeDetailCard node={node} />
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 工作流运行卡（聊天流与右侧工作台共用同一组件）：
 * 阶段进度条 + 脚本日志 + 按阶段分组节点列表 + 最终产出；
 * agent 节点展开体无缝内嵌 SubagentLiveCard 实时流。
 */
export function WorkflowRunCard({ run, inWorkbench = false, toolCall, onNavigate }: { run: WorkflowRunSummary; inWorkbench?: boolean; toolCall?: ToolTrace; onNavigate?: () => void }) {
  const store = useHelmStore()
  const [cardOpen, setCardOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [openNodes, setOpenNodes] = useState<ReadonlySet<string>>(() => defaultOpenNodeIds(run))
  const nodes = run.nodes ?? []
  const done = nodes.filter((n) => n.status === 'done').length
  const tokens = nodes.reduce((sum, n) => sum + (n.tokens ?? 0), 0)
  const sections = useMemo(() => buildWorkflowPhaseSections(run), [run])
  const logs = useMemo(() => extractWorkflowLogs(run), [run])
  const hasNamedPhases = sections.length > 1 || (sections.length === 1 && sections[0]!.title !== '')

  // 运行中秒表：SSR 首帧不启动时钟，仅客户端 useEffect 定时推进（确定性渲染）。
  const [nowMs, setNowMs] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (run.status !== 'running') return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [run.status])
  const elapsedMs =
    run.status === 'running' && nowMs !== undefined && Number.isFinite(run.createdAt) && nowMs >= run.createdAt
      ? nowMs - run.createdAt
      : run.updatedAt - run.createdAt

  const toggleNode = (nodeId: string): void => {
    setOpenNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  const abort = async (): Promise<void> => {
    setBusy(true)
    try {
      await workflowsApi.abort(run.id)
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '中止工作流失败',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  const resume = async (): Promise<void> => {
    setBusy(true)
    try {
      await workflowsApi.run({ resumeFromRunId: run.id, conversationId: run.conversationId })
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: '断点恢复已启动',
        body: `已从 run ${run.id} 的 journal 前缀重放恢复执行。`,
      })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '断点恢复失败',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card jr-stack workflow-run-card" aria-label={`工作流：${run.name}`}>
      <div className="jr-stack-row">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setCardOpen((v) => !v)}
          title={cardOpen ? '收起工作流卡' : '展开工作流卡'}
        >
          <HelmIcon name={cardOpen ? 'chevron-down' : 'chevron-right'} size={12} />
        </button>
        <HelmIcon name={run.kind === 'subagent' ? 'bot' : 'workflow'} />
        <strong>{run.name}</strong>
        <span className={`badge ${RUN_BADGE[run.status] ?? 'badge-neutral'}`}>{RUN_LABEL[run.status] ?? run.status}</span>
        {run.replayedFrom !== undefined ? (
          <span className="badge badge-warn" title={`从 journal 前缀重放恢复（源 run ${run.replayedFrom}）`}>
            cached 重放
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <span className="workflow-run-stats tabular-nums">
          {nodes.length > 0 ? <span>{`节点 ${done}/${nodes.length}`}</span> : null}
          {tokens > 0 ? <span>{`${tokens.toLocaleString()} Tokens`}</span> : null}
          <span>{formatDurationMs(Math.max(0, elapsedMs))}</span>
        </span>
        {run.status === 'running' ? (
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void abort()}>
            <HelmIcon name="square" size={11} />
            中止
          </button>
        ) : null}
        {canResumeWorkflowRun(run) ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void resume()} title="从 journal 断点重放恢复执行">
            <HelmIcon name="rotate-cw" size={11} />
            断点恢复
          </button>
        ) : null}
        {!inWorkbench ? (
          <button
            className="btn btn-sm"
            onClick={() => {
              store.setWorkbenchTab('tasks')
              store.setWorkbenchOpen(true)
            }}
          >
            查看执行详情
          </button>
        ) : null}
      </div>
      {run.description !== undefined && run.description !== '' ? (
        <p className="workflow-run-description">{run.description}</p>
      ) : null}
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
                  <HelmIcon
                    name={PHASE_ICON[section.status]}
                    size={11}
                    className={section.status === 'running' ? 'spin-slow' : undefined}
                  />
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
                  <HelmIcon name="terminal" size={11} />
                  <span className="workflow-log-text">{log.message}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="workflow-node-list">
            {sections.map((section) => (
              <WorkflowPhaseGroup key={section.key} section={section} openNodes={openNodes} toggleNode={toggleNode} onNavigate={onNavigate} />
            ))}
            {nodes.length === 0 ? <div className="workflow-phase-empty">暂无节点状态</div> : null}
          </div>
          {run.status === 'completed' && run.result !== undefined ? (
            <WorkflowResultBox result={run.result} open={resultOpen} onToggle={() => setResultOpen((v) => !v)} />
          ) : null}
          {run.error !== undefined ? <p className="jr-callout jr-callout-err">{run.error}</p> : null}
        </>
      ) : null}
      {toolCall !== undefined ? <ToolCallDetails tool={toolCall} /> : null}
    </section>
  )
}

/** 失败节点默认展开（错误详情直接可见），其余节点默认收起。 */
function defaultOpenNodeIds(run: WorkflowRunSummary): ReadonlySet<string> {
  return new Set((run.nodes ?? []).filter((n) => n.status === 'failed' && n.conversationId === undefined).map((n) => n.id))
}

/** 工作流最终产出：默认紧凑单行预览，长结果可展开完整 JSON。 */
function WorkflowResultBox({ result, open, onToggle }: { result: unknown; open: boolean; onToggle: () => void }) {
  const full = safeJsonStringify(result)
  const preview = truncatePreview(full)
  return (
    <div className="workflow-result-box">
      <div className="workflow-result-header">
        <span className="trace-section-label">最终产出</span>
        {full.length > preview.length ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onToggle}>
            <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
            {open ? '收起完整结果' : '展开完整结果'}
          </button>
        ) : null}
      </div>
      {open ? (
        <pre className="code-block-pre workflow-node-pre selectable">
          <code>{full}</code>
        </pre>
      ) : (
        <div className="workflow-result-preview selectable" title={preview}>{preview}</div>
      )}
    </div>
  )
}

function truncatePreview(text: string, maxChars = 160): string {
  const nl = text.indexOf('\n')
  const firstLine = nl === -1 ? text : text.slice(0, nl)
  return firstLine.length > maxChars ? `${firstLine.slice(0, maxChars)}…` : firstLine
}
