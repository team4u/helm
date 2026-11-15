/**
 * run-summary.ts — run 的 summary 派生 / 脱敏 / progress 折叠投影（自
 * run-store 拆出的纯函数模块）。
 *
 * 职责：
 * - toSummary：RunRecord → WorkflowRunSummary（纯字段投影，不做脱敏——
 *   持久面在写入前已由调用方脱敏）；
 * - redactSummaryNodes / redactNodes / redactNode：summary 与折叠节点的
 *   元数据逐值脱敏（label/prompt/effectiveCwd/worktree/gate/output 不能
 *   漏 Token）；
 * - nodesFromProgress：progress 条目 → inspect 视图节点（agent 与 action
 *   共享同一全序位次，混合调用按 index 升序输出；长文本只存预览，防千级
 *   节点把 sessionDoc/runs 撑到 2 MiB 上限（413））。
 *
 * 纯投影零 IO：脱敏钩子经参数注入，与 RunStore 持久层正交。
 */

import { redactJsonValue } from '@helm/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts.js'
import { collapse, type WorkflowEntry } from './progress.js'
import type { RunRecord } from './run-store.js'

/**
 * 进度树长文本预览上限（§4.3）：完整内容已在子会话与 .jsonl 账本，进度文档
 * 只存预览，防止千级节点把 sessionDoc/runs 撑到 2 MiB 上限（413）。
 */
const NODE_TEXT_PREVIEW_LIMIT = 1024
const NODE_TRUNCATION_HINT = '\n...[truncated, full content in conversation/journal]'

function nodeTextPreview(text: string): string {
  return text.length > NODE_TEXT_PREVIEW_LIMIT
    ? text.slice(0, NODE_TEXT_PREVIEW_LIMIT) + NODE_TRUNCATION_HINT
    : text
}

export function toSummary(record: RunRecord): WorkflowRunSummary {
  return {
    id: record.id,
    name: record.name,
    conversationId: record.conversationId,
    ...(record.kind !== undefined ? { kind: record.kind } : {}),
    ...(record.savedName !== undefined ? { savedName: record.savedName } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(record.phases !== undefined ? { phases: record.phases } : {}),
    ...(record.parentToolCallId !== undefined && record.parentToolCallId !== ''
      ? { parentToolCallId: record.parentToolCallId }
      : {}),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.nodes !== undefined ? { nodes: record.nodes } : {}),
    ...(record.progress !== undefined ? { progress: record.progress } : {}),
    ...(record.replayedFrom !== undefined ? { replayedFrom: record.replayedFrom } : {}),
    ...(record.journalIoErrors !== undefined ? { journalIoErrors: record.journalIoErrors } : {}),
    ...(record.syncForeground === true ? { syncForeground: true } : {}),
    ...(record.detachedAt !== undefined ? { detachedAt: record.detachedAt } : {}),
  }
}

/** summary 出口统一逐值脱敏（nodes 里的元数据不能漏 Token）。 */
export function redactSummaryNodes(
  redact: (text: string) => string,
  summary: WorkflowRunSummary,
): WorkflowRunSummary {
  if (summary.nodes === undefined) return summary
  return { ...summary, nodes: summary.nodes.map((node) => redactNode(redact, node)) }
}

/** progress 折叠后的节点元数据逐值脱敏（落库/事件前）。 */
export function redactNodes(
  redact: (text: string) => string,
  nodes: NonNullable<WorkflowRunSummary['nodes']>,
): NonNullable<WorkflowRunSummary['nodes']> {
  return nodes.map((node) => redactNode(redact, node))
}

function redactNode(
  redact: (text: string) => string,
  node: NonNullable<WorkflowRunSummary['nodes']>[number],
): NonNullable<WorkflowRunSummary['nodes']>[number] {
  const redacted = redactJsonValue(node, redact) as NonNullable<WorkflowRunSummary['nodes']>[number]
  if (redacted.label !== undefined) redacted.label = redact(redacted.label)
  if (redacted.prompt !== undefined) redacted.prompt = redact(redacted.prompt)
  if (redacted.effectiveCwd !== undefined) redacted.effectiveCwd = redact(redacted.effectiveCwd)
  if (redacted.worktree !== undefined) {
    redacted.worktree = redactJsonValue(redacted.worktree, redact) as NonNullable<WorkflowNodeState['worktree']>
  }
  if (redacted.gate !== undefined) {
    // exitCode/timedOut 是诊断事实（非机密），脱敏时保留不丢。
    redacted.gate = {
      ok: redacted.gate.ok,
      output: redact(redacted.gate.output),
      ...(redacted.gate.exitCode !== undefined ? { exitCode: redacted.gate.exitCode } : {}),
      ...(redacted.gate.timedOut !== undefined ? { timedOut: redacted.gate.timedOut } : {}),
    }
  }
  if (redacted.gateCommand !== undefined) redacted.gateCommand = redact(redacted.gateCommand)
  if (redacted.model !== undefined) redacted.model = redact(redacted.model)
  if (redacted.error !== undefined) redacted.error = redact(redacted.error)
  if (redacted.output !== undefined) redacted.output = redactJsonValue(redacted.output, redact)
  return redacted
}

// ------------------------------------------------------------------
// progress → nodes 折叠（inspect 视图）
// ------------------------------------------------------------------

export function nodesFromProgress(progress: readonly WorkflowEntry[]): NonNullable<WorkflowRunSummary['nodes']> {
  const collapsed = collapse(progress)
  // agent 与 action 共享同一全序位次：混合调用时必须按 index 升序输出，
  // 先遍历 agents 再遍历 actions 会把两类节点拆散重排。
  const merged: Array<{ index: number; node: NonNullable<WorkflowRunSummary['nodes']>[number] }> = []
  for (const agent of collapsed.agents) {
    merged.push({
      index: agent.index,
      node: {
        id: `agent-${agent.index}`,
        kind: 'agent',
        status:
          agent.state === 'done'
            ? 'done'
            : agent.state === 'error'
              ? agent.skipped
                ? 'skipped'
                : 'failed'
              : agent.queuedAt !== undefined && agent.startedAt === undefined
                ? 'pending'
                : 'running',
        ...(agent.cached !== undefined ? { cached: agent.cached } : {}),
        ...(agent.agentType !== undefined ? { agentType: agent.agentType } : {}),
        ...(agent.label !== undefined ? { label: agent.label } : {}),
        ...(agent.nodeId !== undefined ? { nodeId: agent.nodeId } : {}),
        ...(agent.conversationId !== undefined ? { conversationId: agent.conversationId } : {}),
        ...(agent.executionId !== undefined ? { executionId: agent.executionId } : {}),
        ...(agent.effectiveCwd !== undefined ? { effectiveCwd: agent.effectiveCwd } : {}),
        ...(agent.worktree !== undefined ? { worktree: agent.worktree } : {}),
        ...(agent.phaseIndex !== undefined ? { phaseIndex: agent.phaseIndex } : {}),
        ...(agent.phaseTitle !== undefined ? { phaseTitle: agent.phaseTitle } : {}),
        ...(agent.gateCommand !== undefined ? { gateCommand: agent.gateCommand } : {}),
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        ...(agent.attempt !== undefined ? { attempt: agent.attempt } : {}),
        ...(agent.prompt !== undefined ? { prompt: nodeTextPreview(agent.prompt) } : {}),
        ...(agent.schema !== undefined ? { schema: agent.schema } : {}),
        ...(agent.gate !== undefined
          ? {
              gate: {
                ok: agent.gate.ok,
                output: nodeTextPreview(agent.gate.output),
                // exitCode/timedOut 是诊断事实（非机密），折叠时保留不丢。
                ...(agent.gate.exitCode !== undefined ? { exitCode: agent.gate.exitCode } : {}),
                ...(agent.gate.timedOut !== undefined ? { timedOut: agent.gate.timedOut } : {}),
              },
            }
          : {}),
        ...(agent.tokens !== undefined ? { tokens: agent.tokens } : {}),
        ...(agent.durationMs !== undefined ? { durationMs: agent.durationMs } : {}),
        ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
        ...(agent.lastProgressAt !== undefined ? { settledAt: agent.lastProgressAt } : {}),
        ...(agent.state === 'done' && agent.resultPreview !== undefined ? { output: agent.resultPreview } : {}),
        ...(agent.error !== undefined ? { error: nodeTextPreview(agent.error) } : {}),
      },
    })
  }
  for (const action of collapsed.actions) {
    merged.push({
      index: action.index,
      node: {
        id: `action-${action.index}`,
        kind: 'action',
        label: action.label ?? action.actionId,
        status:
          action.state === 'done'
            ? 'done'
            : action.state === 'error'
              ? 'failed'
              : action.queuedAt !== undefined && action.startedAt === undefined
                ? 'pending'
                : 'running',
        ...(action.cached !== undefined ? { cached: action.cached } : {}),
        ...(action.phaseIndex !== undefined ? { phaseIndex: action.phaseIndex } : {}),
        ...(action.phaseTitle !== undefined ? { phaseTitle: action.phaseTitle } : {}),
        ...(action.startedAt !== undefined ? { startedAt: action.startedAt } : {}),
        ...(action.lastProgressAt !== undefined ? { settledAt: action.lastProgressAt } : {}),
        ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}),
        ...(action.state === 'done' && action.resultPreview !== undefined ? { output: action.resultPreview } : {}),
        ...(action.error !== undefined ? { error: nodeTextPreview(action.error) } : {}),
      },
    })
  }
  merged.sort((a, b) => a.index - b.index)
  return merged.map((entry) => entry.node)
}
