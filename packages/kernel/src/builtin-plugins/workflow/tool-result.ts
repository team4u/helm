import type { AgentExecutionInfo } from '@helm/protocol'

/** 插件结构化结果仅保留执行底座实际回传的字段。 */
export function executionOf(info: AgentExecutionInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (info.nodeId !== undefined) out['nodeId'] = info.nodeId
  if (info.conversationId !== undefined) out['conversationId'] = info.conversationId
  if (info.executionId !== undefined) out['executionId'] = info.executionId
  if (info.effectiveCwd !== undefined) out['effectiveCwd'] = info.effectiveCwd
  if (info.worktree !== undefined) {
    out['worktree'] = { ...info.worktree }
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
  if (resolved?.worktree !== undefined) {
    parts.push(`worktree=${resolved.worktree.path}@${resolved.worktree.branch}`)
    if (resolved.worktree.id !== undefined) parts.push(`worktreeId=${JSON.stringify(resolved.worktree.id)}`)
    parts.push('cleanup=cleanup_worktree')
  }
  return parts.length === 0 ? '' : `[subagent ${parts.join(' ')}]`
}
