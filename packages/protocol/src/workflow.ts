/**
 * SubagentWorkflow 数据契约：仅请求 / 状态 / 节点 / 进度 / 公共文档的可串行化形状（引擎私有 journal 行类型已迁回内核引擎目录）；
 * 编排引擎运行时（executor / sandbox / journal 恢复）在 kernel，不进协议。
 */

import type { AgentExecutionInfo, AgentGateResult } from './plugin.js'

/** builtin:workflow/list 动作返回的已保存工作流摘要。 */
export interface SavedWorkflowSummary {
  name: string
  path?: string
  /** 定义文件最后修改时间（epoch ms；真实 fs stat，非缓存副本）。 */
  updatedAt: number
  /** 定义文件字节数（真实 fs stat）。 */
  size: number
  /** 元数据校验失败时保留目录条目，并显式返回诊断。 */
  metadataError?: string
  description?: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}

/** builtin:workflow/get 动作返回的完整定义（只读源码 + 元数据 + 文件事实）。 */
export interface SavedWorkflowDetail extends SavedWorkflowSummary {
  /** 完整脚本源码：仅供只读展示与 AI 读取；Web 端不提供编辑能力。 */
  script: string
}

/** builtin:workflow/save 动作入参：script / fromRunId 恰好提供一个。 */
export interface WorkflowSaveRequest {
  /** 完整脚本源码（与 fromRunId 二选一）。 */
  script?: string
  /** 把既有运行持久化的脚本源固化为定义（与 script 二选一；不可用于 subagent run）。 */
  fromRunId?: string
  /** 保存名称；缺省用 meta.name，与 meta.name 不一致时显式拒绝。 */
  name?: string
  /** 覆盖同名定义（默认拒绝，显式 true 才覆盖）。 */
  overwrite?: boolean
}

/** builtin:workflow/save 动作结果（保存后按真实 fs 重新构建的摘要）。 */
export interface WorkflowSaveResult {
  /** true 新建；false 显式 overwrite 覆盖了既有定义。 */
  created: boolean
  workflow: SavedWorkflowSummary
}

/** builtin:workflow/delete 动作结果（只删除定义文件，历史 run 记录不受影响）。 */
export interface WorkflowDeleteResult {
  deleted: true
  name: string
  path: string
}

/** 工作流引擎运行请求（经 builtin:workflow 动作或内核编排调用）。 */
export interface WorkflowRunRequest {
  /** 已保存工作流的名称。name、script、scriptPath 必须恰好提供一个。 */
  name?: string
  script?: string
  scriptPath?: string
  /** 原样传给脚本 args，不限于对象。 */
  args?: unknown
  resumeFromRunId?: string
  /** 目标会话；新 run 必须明确指定，resume 省略时沿用原 run 的会话。 */
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
  /** 直接复用成功账本结果，未新建执行上下文。HTTP、CLI 与事件使用同一字段。 */
  cached?: boolean
  /** agent 节点的执行后端标识（Profile ID 或 'herdr:<kind>'）。 */
  agentType?: string
  /** 展示名（脚本 label / 派生描述）。 */
  label?: string
  /** 实际执行节点。 */
  nodeId?: string
  /** agent 节点实际执行的会话 ID。 */
  conversationId?: number
  /** 外部运行时执行标识（如 Herdr 窗格/标签 ID）。 */
  executionId?: string
  /** 实际生效工作目录。 */
  effectiveCwd?: string
  /** isolation: 'worktree' 分配的隔离工作树。 */
  worktree?: AgentExecutionInfo['worktree']
  /** 外部执行控制动作引用（onResolved.controls 透传；steer 据此路由外部委托）。 */
  controls?: AgentExecutionInfo['controls']
  phaseIndex?: number
  phaseTitle?: string
  /** agent 节点的原始提示词（审计/重放展示用）。 */
  prompt?: string
  /** 结构化输出 JSON Schema。 */
  schema?: Record<string, unknown>
  /** 脚本声明的 gate 验收命令原文。 */
  gateCommand?: string
  /** gate 执行结果（已在执行环境内恰好一次执行）。 */
  gate?: AgentGateResult
  /** 节点实际或请求的模型标识。 */
  model?: string
  /** 节点执行尝试次数（重试时 > 1）。 */
  attempt?: number
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

/** builtin:workflow 的 run/runs/inspect 动作与会话投影使用的运行摘要。 */
export interface WorkflowRunSummary {
  id: string
  name: string
  conversationId: number
  /** run 种类：DSL 编排工作流（缺省/'workflow'）或后台单子代理（'subagent'）。 */
  kind?: 'workflow' | 'subagent'
  /** 触发本次 run 的已保存工作流名（按保存定义重跑的稳定入口；内联脚本无此字段）。 */
  savedName?: string
  /** 脚本 meta.description 描述。 */
  description?: string
  /** 脚本 meta.phases 声明的阶段蓝图。 */
  phases?: Array<{ title: string; detail?: string; model?: string }>
  /**
   * 触发本次 run 的父会话 SubagentWorkflow 工具调用 ID（内核受信注入，
   * 非用户可写字段；HTTP/CLI 仅输出透传）。前端据此精确关联运行卡。
   */
  parentToolCallId?: string
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
  /**
   * 账本记账失败的诊断明细（agent 行写失败；恢复重放的损行计数）。
   * 只读诊断面：只影响下次 resume 的重放优化，不影响本次 run 结果；
   * HTTP/CLI/Web 仅透传展示，不据其做任何重放决策。
   */
  journalIoErrors?: string[]
}

export type WorkflowRunState = WorkflowRunSummary

/**
 * 受管子代理默认派生深度上限：主会话直接派生的一层子代理默认可继续派生
 * 二层（1 → 2），达到上限的会话即编排叶子。派生请求（AgentSpawnRequest
 * .maxSubagentDepth）与插件配置可显式授予更深，协议不要求每次传参。
 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 2 as const

/**
 * 派生深度绝对上限：插件配置与 AgentSpawnRequest.maxSubagentDepth 的共同
 * 校验边界（越界显式拒绝，防失控递归派生）。
 */
export const HARD_MAX_SUBAGENT_DEPTH = 5 as const

/** 内置编排插件 ID 与公共运行态文档名。 */
export const WORKFLOW_PLUGIN_ID = 'builtin:workflow' as const
export const WORKFLOW_RUNS_DOC = 'runs' as const

/** 全局紧凑角标文档名（仅每会话 count/tone/footerText，不含完整 run 摘要）。 */
export const WORKFLOW_RUN_BADGES_DOC = 'run-badges' as const

export interface WorkflowConversationBadgeSummary {
  count: number
  tone?: 'warn' | 'accent' | 'neutral'
  footerText?: string
}

/** `builtin:workflow` 会话级文档 `runs` 的分片快照（当前会话及后代的 run，保留直接归属）。 */
export interface WorkflowRunSessionDocState {
  runs: WorkflowRunSummary[]
}

/** `builtin:workflow` 全局紧凑角标文档 `run-badges` 的结构化快照。 */
export interface WorkflowRunBadgesDocState {
  byConversation: Record<string, WorkflowConversationBadgeSummary>
}

