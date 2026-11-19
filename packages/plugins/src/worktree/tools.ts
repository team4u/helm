/**
 * builtin:worktree 模型工具注册（自 builtin:workflow/tools.ts 迁出；签名不变）。
 *
 * - cleanup_worktree：清理受管隔离 Git Worktree（错误分支绝不伪造 metadata）；
 * - subagent / SubagentWorkflow 工具仍属 builtin:workflow（workflow/tools.ts）。
 */
import type { HelmxPluginContext } from '@helmx/protocol'
import type { WorktreeIsolation } from './isolation.js'

export interface WorktreeToolDeps {
  isolation: WorktreeIsolation
}

/** cleanup 成功分支（removed/worktreeId/path/branch/nodeId/branchDeleted 全为真实值）。 */
const cleanupSuccessOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: true },
    removed: { type: 'boolean' },
    worktreeId: { type: 'string' },
    path: { type: 'string' },
    branch: { type: 'string' },
    nodeId: { type: 'string' },
    branchDeleted: { type: 'boolean' },
  },
  required: ['ok', 'removed', 'worktreeId', 'path', 'branch', 'nodeId', 'branchDeleted'],
} as const

/** cleanup 失败分支：仅 ok:false + error，绝不伪造空 metadata。 */
const cleanupErrorOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: false },
    error: { type: 'string' },
  },
  required: ['ok', 'error'],
  additionalProperties: false,
} as const

export function registerWorktreeTools(ctx: HelmxPluginContext, deps: WorktreeToolDeps): void {
  const { isolation } = deps

  // ---- 模型工具：cleanup_worktree ----
  ctx.tool({
    name: 'cleanup_worktree',
    description:
      "Clean up one managed isolated Git worktree (the workspace of a sub-conversation spawned with isolation: 'worktree'). Locate it by worktreeId (node:path), conversationId, or worktree path (may attach nodeId to disambiguate); refused by default when the workspace has uncommitted changes or unmerged commits (inspect/merge first, or pass force: true; force cannot bypass occupancy/ownership/locked checks); optionally pass deleteBranch: true to also delete the helmx/spawn-* branch (branch deletion failures can be retried). Only worktrees registered by helmx are cleaned; unregistered directories are never touched.",
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: 'Managed worktree registration ID (node:path; exact selector, mutually exclusive with conversationId/path/nodeId)' },
        conversationId: { type: 'number', description: 'Sub-conversation ID (mutually exclusive with path)' },
        path: { type: 'string', description: 'Worktree absolute path (mutually exclusive with conversationId; same-name paths across nodes need nodeId)' },
        nodeId: { type: 'string', description: 'Target node ID (only combinable with path, disambiguating same-name paths across nodes)' },
        deleteBranch: { type: 'boolean', description: 'Also delete the helmx/spawn-* branch (kept by default)' },
        mergedInto: { type: 'string', description: 'Target branch or commit already merged into; defaults to the recorded baseBranch, falling back to the main worktree HEAD' },
        force: { type: 'boolean', description: 'Force cleanup (only bypasses the uncommitted-changes/unmerged-commits protection; never bypasses occupancy/ownership/locked checks)' },
      },
      additionalProperties: false,
    },
    structuredOutputSchema: { anyOf: [cleanupSuccessOutputSchema, cleanupErrorOutputSchema] } as unknown as typeof cleanupSuccessOutputSchema,
    async execute(args, context) {
      const a = args as Record<string, unknown>
      // --current 语义：无任何显式选择器时以当前会话为选择器（子会话自身
      // 的 worktree）；显式 worktreeId/path/nodeId 永不被上下文覆盖。
      const hasExplicit = a['worktreeId'] !== undefined || a['path'] !== undefined || a['conversationId'] !== undefined
      const selectorConversationId =
        a['conversationId'] !== undefined ? Number(a['conversationId']) : hasExplicit ? undefined : context.conversationId
      try {
        const result = await isolation.cleanup(
          {
            ...(a['worktreeId'] !== undefined ? { worktreeId: String(a['worktreeId']) } : {}),
            ...(selectorConversationId !== undefined ? { conversationId: selectorConversationId } : {}),
            ...(a['path'] !== undefined ? { path: String(a['path']) } : {}),
            ...(a['nodeId'] !== undefined ? { nodeId: String(a['nodeId']) } : {}),
            ...(a['deleteBranch'] !== undefined ? { deleteBranch: a['deleteBranch'] === true } : {}),
            ...(a['mergedInto'] !== undefined ? { mergedInto: String(a['mergedInto']) } : {}),
            ...(a['force'] !== undefined ? { force: a['force'] === true } : {}),
          },
          context.signal,
        )
        const summary = result.removed
          ? `已移除受管 worktree ${result.path}（branch: ${result.branch}，节点 ${result.nodeId}${result.branchDeleted ? '，分支已删除' : '，分支保留'}）`
          : `受管 worktree ${result.path} 此前已清理（幂等跳过；branch: ${result.branch}${result.branchDeleted ? '，分支已删除' : ''}）`
        return {
          output: [{ type: 'text', text: summary }],
          structuredOutput: { ok: true, ...result },
        }
      } catch (error) {
        // 错误分支仅 ok:false + error：绝不伪造空 worktreeId/path/branch/nodeId。
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: [{ type: 'text', text: `cleanup_worktree 失败：${message}` }],
          isError: true,
          structuredOutput: { ok: false, error: message },
        }
      }
    },
  })
}
