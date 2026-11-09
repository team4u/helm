/**
 * progress.ts — 工作流进度模型（append-only 事件日志，按 index 折叠 last-write-wins）。
 *
 * 自 @tintinweb/pi-subagents v0.23.1 (MIT) 移植，裁掉上游 TUI 渲染辅助
 * （header/footer/gerund 等）；保留 fold/displayState/stats 三件套与 entry 形状，
 * 内核事件桥与 Web 检查器共用。
 *
 * 两套词汇刻意区分：entry `state` 只有 start|progress|done|error；展示态
 * （queued/running/interrupted/...）由 displayState 派生。
 */

import type { WorkflowMeta, WorkflowPhaseMeta } from './meta.js'
import type { AgentExecutionInfo } from '@helm/protocol'

/** Raw entry lifecycle, as written by the runtime. */
export type WorkflowEntryState = 'start' | 'progress' | 'done' | 'error'

/** Derived per-agent state, as rendered. */
export type WorkflowDisplayState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'interrupted'

export interface WorkflowPhaseEntry {
  type: 'workflow_phase'
  index: number
  title: string
}

export interface WorkflowLogEntry {
  type: 'workflow_log'
  message: string
}

export interface WorkflowAgentEntry {
  type: 'workflow_agent'
  /** 稳定身份：同 index 再发一条即替换前一条。 */
  index: number
  label: string
  /** 未在任何 phase() 之前运行时缺省（信号本身，而非默认 0）。 */
  phaseIndex?: number
  phaseTitle?: string
  state: WorkflowEntryState
  agentId?: string
  nodeId?: string
  /** 宿主侧子会话 id（onResolved 回传），检查器凭它打开会话。 */
  conversationId?: number
  /** 外部运行时执行标识（如 Herdr 窗格/标签 ID）。 */
  executionId?: string
  /** 实际生效工作目录（绝对路径；外部执行环境回传或宿主确认）。 */
  effectiveCwd?: string
  /** isolation: 'worktree' 分配的隔离工作树。 */
  worktree?: AgentExecutionInfo['worktree']
  /** 完整 prompt（审计用；持久面已脱敏）。 */
  prompt?: string
  /** 结构化输出 JSON Schema（脚本声明原样）。 */
  schema?: Record<string, unknown>
  /** gate 执行结果（执行环境内恰好一次执行后的回报）。 */
  gate?: { ok: boolean; output: string }
  /** 脚本声明的 gate 命令原文（审计用；持久面已脱敏）。 */
  gateCommand?: string
  agentType?: string
  model?: string
  thinking?: string
  requestedThinking?: string
  requestedModel?: string
  error?: string
  skipped?: boolean
  cached?: boolean
  queuedAt?: number
  startedAt?: number
  lastProgressAt?: number
  attempt?: number
  promptPreview?: string
  resultPreview?: string
  tokens?: number
  toolCalls?: number
  durationMs?: number
}

/** action 节点进度行（helm 新增：action() 原语）。 */
export interface WorkflowActionEntry {
  type: 'workflow_action'
  index: number
  actionId: string
  label?: string
  state: WorkflowEntryState
  /** 所属阶段（helm：与 agent 行同源的 ambient phase 透传）。 */
  phaseIndex?: number
  phaseTitle?: string
  cached?: boolean
  queuedAt?: number
  startedAt?: number
  lastProgressAt?: number
  durationMs?: number
  error?: string
  resultPreview?: string
}

export type WorkflowEntry = WorkflowPhaseEntry | WorkflowLogEntry | WorkflowAgentEntry | WorkflowActionEntry

export interface CollapsedProgress {
  agents: WorkflowAgentEntry[]
  actions: WorkflowActionEntry[]
  logs: string[]
  phaseTitles: Map<number, string>
}

/** 把事件日志折叠为最新状态。 */
export function collapse(progress: readonly WorkflowEntry[]): CollapsedProgress {
  const agents = new Map<number, WorkflowAgentEntry>()
  const actions = new Map<number, WorkflowActionEntry>()
  const logs: string[] = []
  const phaseTitles = new Map<number, string>()

  for (const entry of progress) {
    if (entry.type === 'workflow_agent') agents.set(entry.index, entry)
    else if (entry.type === 'workflow_action') actions.set(entry.index, entry)
    else if (entry.type === 'workflow_log') logs.push(entry.message)
    else phaseTitles.set(entry.index, entry.title)
  }

  return {
    agents: [...agents.values()].sort((a, b) => a.index - b.index),
    actions: [...actions.values()].sort((a, b) => a.index - b.index),
    logs,
    phaseTitles,
  }
}

/** 单个 agent 的展示态；workflowActive=false 时 start/progress 读作 interrupted。 */
export function displayState(entry: WorkflowAgentEntry, workflowActive: boolean): WorkflowDisplayState {
  if (entry.state === 'done') return 'done'
  if (entry.state === 'error') return entry.skipped ? 'skipped' : 'failed'
  if (!workflowActive) return 'interrupted'
  return entry.queuedAt != null && entry.startedAt == null ? 'queued' : 'running'
}

/** True while an entry is still expected to change. */
export function isLive(entry: WorkflowAgentEntry): boolean {
  return entry.state === 'start' || entry.state === 'progress'
}

export interface WorkflowStats {
  done: number
  failedCount: number
  running: boolean
  total: number
  started: number
  complete: boolean
}

/** 聚合计数。agentCount 为 runtime 已调度数，可能领先日志已见数。 */
export function stats(progress: readonly WorkflowEntry[], agentCount = 0): WorkflowStats {
  let seen = 0
  let done = 0
  let failed = 0
  let started = 0
  let anyLive = false

  for (const entry of collapse(progress).agents) {
    seen++
    if (entry.state === 'done') {
      done++
      started++
    } else if (entry.state === 'error') {
      failed++
      started++
    } else {
      anyLive = true
      if (entry.startedAt !== undefined || entry.queuedAt === undefined) started++
    }
  }

  const total = Math.max(agentCount, seen)
  return {
    done,
    failedCount: failed,
    running: anyLive,
    total,
    started,
    complete: !anyLive && seen > 0 && done + failed >= total,
  }
}

/** `1m12s` / `9s` / `340ms`。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`
}

export interface PhaseGroup {
  title: string
  status: 'not-started' | 'running' | 'done' | 'failed'
  agents: WorkflowAgentEntry[]
  doneCount: number
  totalCount: number
  tokens: number
  durationMs: number
}

function groupByPhase(
  agents: readonly WorkflowAgentEntry[],
  phaseTitles: Map<number, string>,
): { phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }[] | null {
  if (!agents.some((a) => a.phaseIndex != null)) return null

  const byPhase = new Map<number, { phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }>()
  for (const agent of agents) {
    const phaseIndex = agent.phaseIndex ?? 0
    let group = byPhase.get(phaseIndex)
    if (!group) {
      group = { phaseIndex, title: phaseTitles.get(phaseIndex) ?? `Phase ${phaseIndex}`, agents: [] }
      byPhase.set(phaseIndex, group)
    }
    group.agents.push(agent)
  }
  return [...byPhase.values()].sort((a, b) => a.phaseIndex - b.phaseIndex)
}

function summarize(group: { title: string; agents: WorkflowAgentEntry[] }): PhaseGroup {
  let done = 0
  let failed = 0
  let tokens = 0
  let minStart = Number.POSITIVE_INFINITY
  let maxProgress = 0

  for (const agent of group.agents) {
    if (agent.state === 'done') done++
    else if (agent.state === 'error') failed++
    if (agent.tokens) tokens += agent.tokens
    if (agent.startedAt != null) {
      if (agent.startedAt < minStart) minStart = agent.startedAt
      const last = agent.lastProgressAt ?? agent.startedAt
      if (last > maxProgress) maxProgress = last
    }
  }

  const total = group.agents.length
  const finished = done + failed === total && total > 0
  return {
    title: group.title,
    status: finished ? (failed > 0 ? 'failed' : 'done') : 'running',
    agents: group.agents,
    doneCount: done,
    totalCount: total,
    tokens,
    durationMs: minStart < Number.POSITIVE_INFINITY ? maxProgress - minStart : 0,
  }
}

function placeholder(title: string): PhaseGroup {
  return { title, status: 'not-started', agents: [], doneCount: 0, totalCount: 0, tokens: 0, durationMs: 0 }
}

const normalizeTitle = (title: string) => title.toLowerCase().trim()

function mergePhases(
  declared: readonly WorkflowPhaseMeta[] | undefined,
  observed: { phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }[],
): PhaseGroup[] {
  const consumed = new Set<{ phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }>()
  const merged: PhaseGroup[] = []

  for (const phase of declared ?? []) {
    const wanted = normalizeTitle(phase.title)
    const match = observed.find((group) => {
      if (consumed.has(group)) return false
      const actual = normalizeTitle(group.title)
      return actual === wanted || actual.startsWith(wanted) || wanted.startsWith(actual)
    })
    if (match) {
      consumed.add(match)
      merged.push(summarize(match))
    } else {
      merged.push(placeholder(phase.title))
    }
  }

  for (const group of observed) {
    if (!consumed.has(group)) merged.push(summarize(group))
  }

  return merged
}

/** 构建渲染器遍历的阶段分组。 */
export function buildPhaseGroups(
  progress: readonly WorkflowEntry[],
  declared?: readonly WorkflowPhaseMeta[],
): PhaseGroup[] {
  const { agents, phaseTitles } = collapse(progress)
  const observed = groupByPhase(agents, phaseTitles) ?? []
  const merged = mergePhases(declared, observed)
  if (merged.length === 0 && agents.length > 0) {
    return [summarize({ title: 'Agents', agents })]
  }
  if (agents.length > 0 && !merged.some((group) => group.totalCount > 0)) {
    return [...merged, summarize({ title: 'Agents', agents })]
  }
  return merged
}

/** elapsed 辅助：meta 声明的类型仅供展示层组装 task 时参考。 */
export type { WorkflowMeta }
