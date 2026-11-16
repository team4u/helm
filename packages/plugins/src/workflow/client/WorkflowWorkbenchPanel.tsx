/**
 * builtin:workflow 右侧工作台面板（tasks）：
 * - 聚焦当前会话及其后代的真实在途/历史运行（工作流 DAG、节点明细、Gate 审批、Worktree 检视、
 *   原生子会话流与外部代理运行），无损承接时间线 `.trace-row` 收口后移出的全部详情。
 * - 支持从时间线或底部活动托盘点击后经 `workbench-focus` 直接展开并定位到对应 `run.id`。
 * - 已去除重复的工作流定义库列表（保留右上角轻量跳转至独立 `library` 全屏视图）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkbenchPanelProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { MarkdownText, useConversations, usePluginContext } from '@helm/plugin-client'
import { usePluginSessionDoc } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { WorkflowRunCardBody } from './WorkflowRunCard.tsx'
import { SubagentLiveCard } from './SubagentCard.tsx'
import { ExternalRunSummary } from './ExternalRunSummary.tsx'
import { WorktreeInspectSection } from './WorktreeInspectSection.tsx'
import { aggregateExecutionNodes, buildExecutionTree } from './model-execution-tree.ts'
import type { ExecutionNode } from './model-execution-tree.ts'
import { stringifyPretty } from './model-format.ts'
import {
  clearWorkbenchRunFocus,
  peekWorkbenchRunFocus,
  subscribeWorkbenchRunFocus,
} from './workbench-focus.ts'

export function WorkflowWorkbenchPanel(props?: Partial<WorkbenchPanelProps>): ReactNode {
  const ctx = usePluginContext()
  const conversationId = props?.conversation?.id ?? ctx.conversationId
  const conversations = useConversations()
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>(
    'runs',
    conversationId !== undefined ? { conversationId } : undefined,
  )
  const runs = runsDoc?.runs ?? []

  const [focusedRunId, setFocusedRunId] = useState<string | undefined>(() =>
    conversationId !== undefined ? peekWorkbenchRunFocus(conversationId)?.runId : undefined,
  )
  const [openRunIds, setOpenRunIds] = useState<Record<string, boolean>>(() => {
    const initial = conversationId !== undefined ? peekWorkbenchRunFocus(conversationId)?.runId : undefined
    return initial !== undefined ? { [initial]: true } : {}
  })
  const [resultOpenIds, setResultOpenIds] = useState<Record<string, boolean>>({})
  const runRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => {
    const pending = conversationId !== undefined ? peekWorkbenchRunFocus(conversationId)?.runId : undefined
    setFocusedRunId(pending)
    if (pending !== undefined) {
      setOpenRunIds((prev) => ({ ...prev, [pending]: true }))
    }
  }, [conversationId])

  useEffect(
    () =>
      subscribeWorkbenchRunFocus((target) => {
        if (conversationId !== undefined && target.conversationId !== conversationId) {
          return
        }
        setFocusedRunId(target.runId)
        setOpenRunIds((prev) => ({ ...prev, [target.runId]: true }))
      }),
    [conversationId],
  )

  useEffect(() => {
    if (conversationId === undefined || focusedRunId === undefined) return
    if (!runs.some((r) => r.id === focusedRunId)) return
    const el = runRefs.current[focusedRunId]
    if (el !== null && el !== undefined && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
    clearWorkbenchRunFocus(conversationId, focusedRunId)
  }, [focusedRunId, runs, conversationId])

  const tree = useMemo(
    () =>
      conversationId !== undefined
        ? buildExecutionTree({ rootConversationId: conversationId, conversations, runs })
        : [],
    [conversationId, conversations, runs],
  )

  const viewerScope = useMemo(
    () =>
      conversationId !== undefined
        ? {
            conversationId,
            ownedBy: conversations.find((c) => c.id === conversationId)?.ownedBy,
          }
        : undefined,
    [conversationId, conversations],
  )

  const standaloneChildren = useMemo(
    () => tree.filter((node) => node.kind === 'conversation' && node.conversationId !== undefined),
    [tree],
  )

  const runNodesByRunId = useMemo(() => {
    const map = new Map<string, ExecutionNode>()
    for (const node of tree) {
      if (node.run !== undefined) map.set(node.run.id, node)
    }
    return map
  }, [tree])

  return (
    <div className="workflow-workbench-panel">
      <div className="workflow-workbench-head">
        <span className="workflow-workbench-head-left">
          <Icon name="workflow" size={14} />
          <span>当前会话任务</span>
          {runs.length + standaloneChildren.length > 0 ? (
            <span className="badge badge-neutral tabular-nums">{runs.length + standaloneChildren.length}</span>
          ) : null}
        </span>
        <button
          type="button"
          className="btn btn-xs"
          onClick={() => ctx.openScreen(`screen:${ctx.pluginId}/library`)}
        >
          <Icon name="folder" size={11} />
          工作流库
        </button>
      </div>

      {conversationId === undefined ? (
        <div className="workflow-workbench-empty">请先打开一个会话，工作台将展示当前会话的工作流与子代理任务。</div>
      ) : runs.length === 0 && standaloneChildren.length === 0 ? (
        <div className="workflow-workbench-empty">当前会话暂无工作流或子代理运行记录。</div>
      ) : (
        <div className="workflow-workbench-list">
          {runs.map((run, idx) => {
            const treeNode = runNodesByRunId.get(run.id)
            const childNodes = treeNode?.children ?? []
            const isFocused = focusedRunId === run.id
            const defaultOpen = focusedRunId !== undefined ? isFocused : idx === 0 || run.status === 'running'
            const cardOpen = openRunIds[run.id] ?? defaultOpen
            const resultOpen = resultOpenIds[run.id] ?? false
            const isStandaloneExternalSubagent =
              run.kind === 'subagent' &&
              (run.nodes ?? []).length === 0 &&
              childNodes.length === 0

            return (
              <div
                key={run.id}
                data-run-id={run.id}
                ref={(el) => {
                  runRefs.current[run.id] = el
                }}
                className={`workflow-workbench-run-wrap${isFocused ? ' workflow-workbench-run-focused' : ''}`}
              >
                {isStandaloneExternalSubagent ? (
                  <ExternalSubagentWorkbenchCard
                    run={run}
                    viewer={viewerScope}
                  />
                ) : (
                  <WorkflowRunCardBody
                    run={run}
                    childNodes={childNodes}
                    cardOpen={cardOpen}
                    onToggleCard={() =>
                      setOpenRunIds((prev) => ({
                        ...prev,
                        [run.id]: !(prev[run.id] ?? defaultOpen),
                      }))
                    }
                    resultOpen={resultOpen}
                    onToggleResult={() =>
                      setResultOpenIds((prev) => ({
                        ...prev,
                        [run.id]: !(prev[run.id] ?? false),
                      }))
                    }
                    inWorkbench
                    viewer={viewerScope}
                  />
                )}
              </div>
            )
          })}

          {standaloneChildren.map((node) => {
            const childId = node.conversationId
            if (childId === undefined) return null
            const subtree = aggregateExecutionNodes(node.children)
            const hasRunning = node.status === 'working' || node.status === 'blocked' || subtree.running > 0
            return (
              <SubagentLiveCard
                key={node.key}
                childConversationId={childId}
                childNodes={node.children}
                toolStatus={hasRunning ? 'running' : node.status === 'error' ? 'error' : 'done'}
                expanded
                viewer={viewerScope}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function ExternalSubagentWorkbenchCard({
  run,
  viewer,
}: {
  run: WorkflowRunSummary
  viewer: { conversationId: number; ownedBy?: string } | undefined
}): ReactNode {
  const worktree = run.nodes?.find((n) => n.worktree !== undefined)?.worktree
  const executionId = run.nodes?.find((n) => n.executionId !== undefined)?.executionId
  const toolStatus = run.status === 'running' ? 'running' : run.status === 'completed' ? 'done' : 'error'
  const resultPretty = useMemo(() => stringifyPretty(run.result), [run.result])

  return (
    <div className="workflow-workbench-external">
      <ExternalRunSummary
        run={run}
        worktree={worktree}
        toolStatus={toolStatus}
        executionId={executionId}
        viewer={viewer}
      />
      {run.status === 'completed' && run.result !== undefined ? (
        <div className="workflow-result-box">
          <div className="trace-section-label">运行产出</div>
          {typeof run.result === 'string' ? (
            <MarkdownText text={run.result} />
          ) : resultPretty !== undefined ? (
            <pre className="code-block-pre workflow-node-pre selectable">
              <code>{resultPretty}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
      {worktree !== undefined ? (
        <WorktreeInspectSection
          worktree={{
            path: worktree.path,
            branch: worktree.branch,
            ...(worktree.id !== undefined && worktree.id !== '' ? { id: worktree.id } : {}),
          }}
          baseCommit={worktree.baseCommit}
          taskLabel={run.name}
          parentConversationId={run.conversationId}
        />
      ) : null}
    </div>
  )
}
