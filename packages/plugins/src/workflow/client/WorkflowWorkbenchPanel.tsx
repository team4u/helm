/**
 * builtin:workflow right workbench panel (tasks):
 * - renders the current conversation's first-level execution nodes (workflow /
 *   external / conversation) per the unified execution tree
 *   `buildExecutionTree`, eliminating duplicated background native subagent
 *   cards, misclassified external nodes, deep-descendant flat-list leaks and
 *   double counting;
 * - keeps `backgroundRun`, `executionToolStatus` and `WorktreeInspectSection`
 *   for standalone/background native subagents (Git Diff inspection and
 *   cleanup), losslessly absorbing all details moved out of the timeline
 *   `.trace-row` collapse;
 * - supports jumping from a timeline or bottom activity tray click straight
 *   to the matching `run.id` via `workbench-focus`;
 * - the duplicated workflow definition library list is gone (only a light
 *   top-right jump to the standalone `library` fullscreen view remains).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkbenchPanelProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { MarkdownText, resolveLocalizedText, useConversations, usePluginContext, usePluginLocale } from '@helm/plugin-client'
import { usePluginSessionDoc } from './hooks.ts'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { WorkflowRunCardBody } from './WorkflowRunCard.tsx'
import { SubagentLiveCard } from './SubagentCard.tsx'
import { ExternalRunSummary } from './ExternalRunSummary.tsx'
import { WorktreeInspectSection } from './WorktreeInspectSection.tsx'
import { buildExecutionTree } from './model-execution-tree.ts'
import type { ExecutionNode } from './model-execution-tree.ts'
import { executionToolStatus } from './model-execution-status.ts'
import { stringifyPretty } from './model-format.ts'
import { listResumableFailedRuns, parseResumeFailedResult, resolveWorkflowRunDisplayName } from './model-run.ts'
import {
  WORKBENCH_EMPTY_NO_CONVERSATION,
  WORKBENCH_EMPTY_NO_RUNS,
  WORKBENCH_HEAD_TITLE,
  WORKBENCH_LIBRARY,
  WORKBENCH_RESULT_SECTION,
  WORKBENCH_RESUME_FAILED_TITLE,
  WORKBENCH_RESUME_NONE_NEEDED,
  workbenchResumeAllSkipped,
  workbenchResumeFailed,
  workbenchResumeFailedButton,
  workbenchResumeInvalidResult,
  workbenchResumeStarted,
} from './copy.ts'
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
  const locale = usePluginLocale()
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
  const [batchResuming, setBatchResuming] = useState(false)
  const batchResumeInFlight = useRef(false)
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

  const resumableRuns = useMemo(
    () => (conversationId !== undefined ? listResumableFailedRuns(runs, conversationId) : []),
    [runs, conversationId],
  )

  const handleResumeFailed = (): void => {
    if (conversationId === undefined || batchResumeInFlight.current) return
    batchResumeInFlight.current = true
    setBatchResuming(true)
    void ctx
      .callAction('resume_failed', { conversationId })
      .then((raw) => {
        const parsed = parseResumeFailedResult(raw)
        if (parsed === undefined) {
          throw new Error(workbenchResumeInvalidResult(locale))
        }
        const { resumedCount, skippedCount } = parsed
        if (resumedCount === 0 && skippedCount > 0) {
          ctx.notify(workbenchResumeAllSkipped(skippedCount, locale), 'warning')
          return
        }
        if (resumedCount === 0 && skippedCount === 0) {
          ctx.notify(resolveLocalizedText(WORKBENCH_RESUME_NONE_NEEDED, locale))
          return
        }
        ctx.notify(workbenchResumeStarted(resumedCount, skippedCount, locale))
      })
      .catch((err: unknown) => {
        ctx.notify(workbenchResumeFailed(err instanceof Error ? err.message : String(err), locale), 'error')
      })
      .finally(() => {
        batchResumeInFlight.current = false
        setBatchResuming(false)
      })
  }

  return (
    <div className="workflow-workbench-panel">
      <div className="workflow-workbench-head">
        <span className="workflow-workbench-head-left">
          <Icon name="workflow" size={14} />
          <span>{resolveLocalizedText(WORKBENCH_HEAD_TITLE, locale)}</span>
          {tree.length > 0 ? (
            <span className="badge badge-neutral tabular-nums">{tree.length}</span>
          ) : null}
        </span>
        <div className="stack-row">
          {conversationId !== undefined && resumableRuns.length > 0 ? (
            <button
              type="button"
              className="btn btn-xs"
              disabled={batchResuming}
              aria-label={workbenchResumeFailedButton(resumableRuns.length, locale)}
              title={resolveLocalizedText(WORKBENCH_RESUME_FAILED_TITLE, locale)}
              onClick={handleResumeFailed}
            >
              <Icon name="rotate-cw" size={12} className={batchResuming ? SPIN : undefined} />
              {workbenchResumeFailedButton(resumableRuns.length, locale)}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => ctx.openScreen(`screen:${ctx.pluginId}/library`)}
          >
            <Icon name="folder" size={11} />
            {resolveLocalizedText(WORKBENCH_LIBRARY, locale)}
          </button>
        </div>
      </div>

      {conversationId === undefined ? (
        <div className="workflow-workbench-empty">{resolveLocalizedText(WORKBENCH_EMPTY_NO_CONVERSATION, locale)}</div>
      ) : tree.length === 0 ? (
        <div className="workflow-workbench-empty">{resolveLocalizedText(WORKBENCH_EMPTY_NO_RUNS, locale)}</div>
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
  const locale = usePluginLocale()
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
          <div className="trace-section-label">{resolveLocalizedText(WORKBENCH_RESULT_SECTION, locale)}</div>
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
          taskLabel={resolveWorkflowRunDisplayName(run)}
          parentConversationId={run.conversationId}
        />
      ) : null}
    </div>
  )
}
