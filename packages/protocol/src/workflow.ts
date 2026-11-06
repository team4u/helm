/**
 * SubagentWorkflow 数据契约：仅请求 / 状态 / 节点 / Journal 的可串行化形状，
 * 编排引擎运行时（executor / sandbox / journal 恢复）在 kernel，不进协议。
 */

/** `POST /api/workflows/run` 请求体。 */
export interface WorkflowRunRequest {
  /** 已保存工作流的名称。name、script、scriptPath 必须恰好提供一个。 */
  name?: string
  script?: string
  scriptPath?: string
  /** 原样传给脚本 args，不限于对象。 */
  args?: unknown
  resumeFromRunId?: string
  conversationId?: number
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'aborted'

export type WorkflowNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

/** DAG 单节点状态（agent / action / gate / script 等统一形状）。 */
export interface WorkflowNodeState {
  id: string
  /** 节点类型：'agent' | 'action' | 'gate' | 'script' 等。 */
  kind: string
  status: WorkflowNodeStatus
  /** agent 节点的执行后端标识（Profile ID 或 'herdr:<kind>'）。 */
  agentType?: string
  startedAt?: number
  settledAt?: number
  /** 结构化输出（Schema 校验通过后）。 */
  output?: unknown
  error?: string
}

/** `GET /api/workflows/runs/:runId` 响应。 */
export interface WorkflowRunSummary {
  id: string
  name: string
  conversationId: number
  status: WorkflowRunStatus
  createdAt: number
  updatedAt: number
  result?: unknown
  error?: string
  nodes?: WorkflowNodeState[]
}

export type WorkflowRunState = WorkflowRunSummary

/** `<runId>.workflow.jsonl` 断点重放账本行（每行一个 JSON 对象，seq 单调递增）。 */
export type WorkflowJournalEntry =
  | { seq: number; type: 'run_started'; runId: string; workflowName: string; at: number }
  | { seq: number; type: 'node_started'; nodeId: string; at: number }
  | { seq: number; type: 'node_completed'; nodeId: string; output?: unknown; at: number }
  | { seq: number; type: 'node_failed'; nodeId: string; error: string; at: number }
  | {
      seq: number
      type: 'run_settled'
      status: WorkflowRunStatus
      error?: string
      at: number
    }
