/**
 * builtin:workflow 插件工作台面板（workbench.panel 扩展点组件）：统一执行树
 * 驱动（任意深度聚合 + 父节点下一级紧凑子项）。
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkbenchPanelProps, WorkflowRunSummary } from '@helm/protocol'
import { useConversations } from '@helm/plugin-client'
import { usePluginSessionDoc } from './hooks.ts'
import { buildExecutionTree, executionToolStatus } from './model-execution-tree.ts'
import { ExternalRunSummary, SubagentLiveCard } from './SubagentCard.tsx'
import { WorkflowRunCardBody } from './WorkflowRunCard.tsx'
import { WorkflowLibrarySection } from './WorkflowLibrary.tsx'

// ---------------------------------------------------------------------------
// WorkflowWorkbenchPanel：workbench.panel 扩展点组件
// ---------------------------------------------------------------------------

/** 工作台面板：统一执行树驱动（任意深度聚合，展示父节点下一级紧凑子项）。 */
export function WorkflowWorkbenchPanel(props: WorkbenchPanelProps): ReactNode {
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>('runs', { conversationId: props.conversation.id })
  const conversations = useConversations()
  const [inspectRunId, setInspectRunId] = useState<string | undefined>(undefined)

  // runs 分片为「本会话 + 全部后代」的整棵投影（各 run 保留原始 conversationId，
  // 由后端聚合分片提供）：整份交给 buildExecutionTree 按 conversationId 归位，
  // 不过滤 own runs——深层外部 / 工作流 run 不丢树；直接子节点列表仍由树按
  // 归属自然限定，重复 run id 在构树层去重。
  const runs = useMemo(() => runsDoc?.runs ?? [], [runsDoc])
  // 统一执行树：任意深度经 parentConversationId 递归 + 整棵 runs 投影归位；
  // 深层会话无 run 数据时仅以会话链递归，不虚构。
  const tree = useMemo(
    () => buildExecutionTree({ rootConversationId: props.conversation.id, conversations, runs }),
    [props.conversation.id, conversations, runs],
  )
  const workflowNodes = tree.filter((node) => node.kind === 'workflow' && node.run !== undefined)
  const externalNodes = tree.filter((node) => node.kind === 'external' && node.run !== undefined)
  const conversationNodes = tree.filter((node) => node.kind === 'conversation' && node.conversationId !== undefined)
  const inspectedRun = inspectRunId !== undefined ? runs.find((r) => r.id === inspectRunId) : undefined

  if (inspectedRun !== undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
        <button type="button" className="btn btn-sm" onClick={() => setInspectRunId(undefined)}>
          返回运行列表
        </button>
        <WorkflowRunCardBody
          run={inspectedRun}
          childNodes={workflowNodes.find((node) => node.run?.id === inspectedRun.id)?.children}
          cardOpen
          onToggleCard={() => undefined}
          resultOpen
          onToggleResult={() => undefined}
          inWorkbench
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
      <WorkflowLibrarySection key={props.conversation.id} conversationId={props.conversation.id} />
      {workflowNodes.length > 0 ? <div className="trace-section-label">工作流运行</div> : null}
      {workflowNodes.map((node) => (
        <div key={node.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <WorkflowRunCardBody
            run={node.run!}
            childNodes={node.children}
            cardOpen={false}
            onToggleCard={() => setInspectRunId(node.run!.id)}
            resultOpen={false}
            onToggleResult={() => undefined}
            inWorkbench
          />
        </div>
      ))}
      {externalNodes.length > 0 ? <div className="trace-section-label">外部后台任务</div> : null}
      {externalNodes.map((node) => (
        <ExternalRunSummary
          key={node.key}
          run={node.run}
          toolStatus={node.run!.status === 'running' ? 'running' : node.run!.status === 'completed' ? 'done' : 'error'}
        />
      ))}
      {conversationNodes.length > 0 ? (
        <>
          <div className="trace-section-label">子代理会话</div>
          {conversationNodes.map((node) => (
            <SubagentLiveCard
              key={node.key}
              childConversationId={node.conversationId!}
              toolStatus={executionToolStatus(node.summary, node.run)}
              backgroundRun={node.run}
              childNodes={node.children}
              worktreeInspect={{
                parentConversationId: props.conversation.id,
                ...(node.summary?.nodeId ? { nodeId: node.summary.nodeId } : {}),
              }}
              expanded={false}
            />
          ))}
        </>
      ) : null}
      {tree.length === 0 ? (
        <div className="workflow-phase-empty">当前会话暂无工作流运行或子代理；可从上方工作流库选择已保存定义运行。</div>
      ) : null}
    </div>
  )
}
