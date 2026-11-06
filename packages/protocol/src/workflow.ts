/**
 * SubagentWorkflow 数据契约：仅请求 / 状态 / 节点 / Journal 的可串行化形状，
 * 编排引擎运行时（executor / sandbox / journal 恢复）在 kernel，不进协议。
 */

/** `POST /api/workflows/run` 请求体。 */
export interface WorkflowRunRequest {
  /** workflow 名称（~/.helm/workflows/<name>.js）或脚本文件路径。 */
  nameOrFile: string
  inputs?: Record<string, unknown>
  /** 断点恢复：跳过账本中已完成的 agent() 节点。 */
  resumeFromRunId?: string
  /** 发起会话（默认 #1）。 */
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
export interface WorkflowRunState {
  runId: string
  workflowName: string
  conversationId: number
  status: WorkflowRunStatus
  /** 当前阶段描述（如 'phase 2/3: review'）。 */
  phase: string
  nodes: WorkflowNodeState[]
  startedAt: number
  settledAt?: number
  error?: string
}

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
