import type { AgentExecutionInfo } from '@helmx/protocol'
import { extractWorkflowExecutionMeta } from '../contracts.js'

/** 插件结构化结果仅保留执行底座实际回传的字段（worktree 经业务 meta 提取）。 */
export function executionOf(info: AgentExecutionInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (info.nodeId !== undefined) out['nodeId'] = info.nodeId
  if (info.conversationId !== undefined) out['conversationId'] = info.conversationId
  if (info.executionId !== undefined) out['executionId'] = info.executionId
  if (info.effectiveCwd !== undefined) out['effectiveCwd'] = info.effectiveCwd
  const worktree = extractWorkflowExecutionMeta(info).worktree
  if (worktree !== undefined) {
    out['worktree'] = { ...worktree }
  }
  return out
}
