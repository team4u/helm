/**
 * SubagentWorkflow 数据契约：仅请求 / 状态 / 节点 / 进度 / Journal 的可串行化形状，
 * 编排引擎运行时（executor / sandbox / journal 恢复）在 kernel，不进协议。
 */

import type { AgentGateResult } from './plugin.js'

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
  /** 展示名（脚本 label / 派生描述）。 */
  label?: string
  /** agent 节点实际执行的会话 ID。 */
  conversationId?: number
  /** 外部运行时执行标识（如 Herdr 窗格/标签 ID）。 */
  executionId?: string
  /** 实际生效工作目录。 */
  effectiveCwd?: string
  /** isolation: 'worktree' 分配的隔离工作树。 */
  worktree?: { path: string; branch: string }
  phaseIndex?: number
  phaseTitle?: string
  /** agent 节点的原始提示词（审计/重放展示用）。 */
  prompt?: string
  /** 结构化输出 JSON Schema。 */
  schema?: Record<string, unknown>
  /** gate 执行结果（已在执行环境内恰好一次执行）。 */
  gate?: AgentGateResult
  tokens?: number
  durationMs?: number
  startedAt?: number
  settledAt?: number
  /** 结构化输出（Schema 校验通过后）。 */
  output?: unknown
  error?: string
}

/**
 * 观察用进度行（inspect / Web 检查器渲染）。
 * agent 与 action 节点的权威状态在 `WorkflowRunSummary.nodes`；
 * 这里只保留 phase 声明与脚本 log 两类时间线事件。
 */
export type WorkflowProgressEntry =
  | { at: number; kind: 'phase'; index: number; title: string }
  | { at: number; kind: 'log'; message: string }

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
  /** 观察用时间线（phase / log）；跨重启从 summary 旁文件恢复。 */
  progress?: WorkflowProgressEntry[]
  /** 从 journal 前缀重放恢复的 run 携带的源 run ID。 */
  replayedFrom?: string
}

export type WorkflowRunState = WorkflowRunSummary

/**
 * 引擎私有前缀重放账本行（`dataDir/artifacts/<convId>/workflow-<runId>.jsonl`，每行一个 JSON 对象）。
 *
 * 这是 @helm/kernel 工作流引擎的恢复账本，**不是公开 API 数据形状**：
 * - `seq` 是落盘顺序号（引擎内单调递增）；`index` 是调用发起位次（agent 与 action 共享同一全序）。
 * - `key` 是调用载荷哈希；重放按 index 前缀匹配，首次失配起全部转 live 执行。
 * - agent 失败行断链后 live 重试（沿用上游语义）；action 已确认的成败行重放时直接复用，
 *   绝不重执行副作用；`action_started` 无对应终态行 = 进程在动作执行中崩溃，恢复必须
 *   显式报 `workflow_action_uncertain`，由人类确认后再决定，禁止自动重放。
 *
 * HTTP / CLI 客户端不得依赖本类型的字段细节做任何重放决策；如需展示只应只读透传。
 */
export type WorkflowJournalEntry =
  | {
      v: 1
      seq: number
      type: 'agent'
      index: number
      key: string
      ok: boolean
      text?: string
      /** 该调用续接了既有子会话（agent({ resume })）；重放时同其他行一样按 index+key 逐项匹配。 */
      resumed?: true
    }
  | {
      v: 1
      seq: number
      /** 动作意图先于执行落盘（fsync 成功后才允许执行 handler）。 */
      type: 'action_started'
      index: number
      key: string
    }
  | {
      v: 1
      seq: number
      /** 动作终态行；ok 为 true 时 result 为动作输出，false 时 error 为失败原因。 */
      type: 'action'
      index: number
      key: string
      ok: boolean
      result?: unknown
      error?: string
    }
