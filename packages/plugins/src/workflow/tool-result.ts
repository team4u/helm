import type { AgentExecutionInfo } from '@helm/protocol'
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

/** 模型可将尾行的 conversationId / executionId 原样作为下次 resume 入参。 */
export function subagentFooter(resumeRef: string | undefined, resolved: AgentExecutionInfo | undefined): string {
  const parts: string[] = []
  if (resumeRef !== undefined) parts.push(`resume=${resumeRef}`)
  if (resolved?.conversationId !== undefined) parts.push(`conversationId=${resolved.conversationId}`)
  if (resolved?.executionId !== undefined) parts.push(`executionId=${resolved.executionId}`)
  if (resolved?.effectiveCwd !== undefined) parts.push(`cwd=${resolved.effectiveCwd}`)
  const worktree = resolved === undefined ? undefined : extractWorkflowExecutionMeta(resolved).worktree
  if (worktree !== undefined) {
    parts.push(`worktree=${worktree.path}@${worktree.branch}`)
    if (worktree.id !== undefined) parts.push(`worktreeId=${JSON.stringify(worktree.id)}`)
    parts.push('cleanup=cleanup_worktree')
  }
  return parts.length === 0 ? '' : `[subagent ${parts.join(' ')}]`
}
