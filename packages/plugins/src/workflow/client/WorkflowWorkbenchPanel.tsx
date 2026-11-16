/**
 * builtin:workflow 右侧工作台面板（tasks）：
 * - 按统一执行树 `buildExecutionTree` 渲染当前会话的一级执行节点（workflow / external / conversation），
 *   消除后台原生子代理双卡重复、外部节点误分类、深层后代平铺泄露与统计双计。
 * - 为独立/后台原生子代理保留 `backgroundRun`、`executionToolStatus` 与 `WorktreeInspectSection`
 *   （Git Diff 检视与清理），无损承接时间线 `.trace-row` 收口后移出的全部详情。
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
import { buildExecutionTree } from './model-execution-tree.ts'
import type { ExecutionNode } from './model-execution-tree.ts'
import { executionToolStatus } from './model-execution-status.ts'
import { stringifyPretty } from './model-format.ts'
import {
  clearWorkbenchRunFocus,
  peekWorkbenchRunFocus,
  subscribeWorkbenchRunFocus,
} from './workbench-focus.ts'

function nodeMatchesRunId(node: ExecutionNode, targetRunId: string): boolean {
  if (node.run?.id === targetRunId) return true
  return node.children.some((child) => nodeMatchesRunId(child, targetRunId))
}

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
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({})

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

  const tree = useMemo(
    () =>
      conversationId !== undefined
        ? buildExecutionTree({ rootConversationId: conversationId, conversations, runs })
        : [],
    [conversationId, conversations, runs],
  )

  useEffect(() => {
    if (conversationId === undefined || focusedRunId === undefined) return
    const matchedTopNode = tree.find((node) => nodeMatchesRunId(node, focusedRunId))
    if (matchedTopNode === undefined) return
    const targetKey = matchedTopNode.run?.id ?? matchedTopNode.key
    const el = nodeRefs.current[targetKey]
    if (el !== null && el !== undefined && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
    clearWorkbenchRunFocus(conversationId, focusedRunId)
  }, [focusedRunId, tree, conversationId])

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

  return (
    <div className="workflow-workbench-panel">
      <div className="workflow-workbench-head">
        <span className="workflow-workbench-head-left">
          <Icon name="workflow" size={14} />
          <span>当前会话任务</span>
          {tree.length > 0 ? (
            <span className="badge badge-neutral tabular-nums">{tree.length}</span>
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
      ) : tree.length === 0 ? (
        <div className="workflow-workbench-empty">当前会话暂无工作流或子代理运行记录。</div>
      ) : (
        <div className="workflow-workbench-list">
          {tree.map((node, idx) => {
            const run = node.run
            const refKey = run?.id ?? node.key
            const isFocused = focusedRunId !== undefined && nodeMatchesRunId(node, focusedRunId)

            if (node.kind === 'workflow' && run !== undefined) {
              const defaultOpen =
                focusedRunId !== undefined ? isFocused : idx === 0 || run.status === 'running'
              const cardOpen = openRunIds[run.id] ?? defaultOpen
              const resultOpen = resultOpenIds[run.id] ?? false
              return (
                <div
                  key={node.key}
                  data-run-id={run.id}
                  ref={(el) => {
                    nodeRefs.current[refKey] = el
                  }}
                  className={`workflow-workbench-run-wrap${isFocused ? ' workflow-workbench-run-focused' : ''}`}
                >
                  <WorkflowRunCardBody
                    run={run}
                    childNodes={node.children}
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
                </div>
              )
            }

            if (node.kind === 'external' && run !== undefined) {
              return (
                <div
                  key={node.key}
                  data-run-id={run.id}
                  ref={(el) => {
                    nodeRefs.current[refKey] = el
                  }}
                  className={`workflow-workbench-run-wrap${isFocused ? ' workflow-workbench-run-focused' : ''}`}
                >
                  <ExternalSubagentWorkbenchCard run={run} viewer={viewerScope} />
                </div>
              )
            }

            if (node.kind === 'conversation' && node.conversationId !== undefined) {
              const worktreeNode = run?.nodes?.find((n) => n.worktree !== undefined)
              const inspectNodeId =
                worktreeNode?.nodeId ??
                (node.summary?.nodeId !== undefined && node.summary.nodeId !== '' ? node.summary.nodeId : undefined)
              return (
                <div
                  key={node.key}
                  data-run-id={run?.id}
                  ref={(el) => {
                    nodeRefs.current[refKey] = el
                  }}
                  className={`workflow-workbench-run-wrap${isFocused ? ' workflow-workbench-run-focused' : ''}`}
                >
                  <SubagentLiveCard
                    childConversationId={node.conversationId}
                    backgroundRun={run}
                    toolStatus={executionToolStatus(node.summary, run)}
                    worktree={worktreeNode?.worktree}
                    childNodes={node.children}
                    expanded={false}
                    viewer={viewerScope}
                    worktreeInspect={{
                      parentConversationId: conversationId,
                      ...(inspectNodeId !== undefined ? { nodeId: inspectNodeId } : {}),
                    }}
                  />
                </div>
              )
            }

            return null
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
  const worktreeNode = run.nodes?.find((n) => n.worktree !== undefined)
  const execNode = run.nodes?.find((n) => n.executionId !== undefined || n.nodeId !== undefined || n.effectiveCwd !== undefined)
  const worktree = worktreeNode?.worktree
  const executionId = execNode?.executionId
  const toolStatus = run.status === 'running' ? 'running' : run.status === 'completed' ? 'done' : 'error'
  const resultPretty = useMemo(() => stringifyPretty(run.result), [run.result])

  return (
    <div className="workflow-workbench-external">
      <ExternalRunSummary
        run={run}
        worktree={worktree}
        toolStatus={toolStatus}
        executionId={executionId}
        nodeId={execNode?.nodeId ?? worktreeNode?.nodeId}
        effectiveCwd={execNode?.effectiveCwd}
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
          nodeId={worktreeNode?.nodeId}
          baseCommit={worktree.baseCommit}
          taskLabel={run.name}
          parentConversationId={run.conversationId}
        />
      ) : null}
    </div>
  )
}
