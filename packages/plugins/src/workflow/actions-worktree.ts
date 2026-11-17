/**
 * builtin:workflow 受管 Worktree 动作（cleanup_worktree / list_worktrees / inspect_worktree）。
 */
import { HelmError, type HelmPluginContext } from '@helm/protocol'
import type { WorkflowActionDeps } from './actions.js'

export function registerWorktreeActions(
  ctx: HelmPluginContext,
  deps: Pick<WorkflowActionDeps, 'isolation'>,
): void {
  const { isolation } = deps

  ctx.action({
    id: 'cleanup_worktree',
    description: 'Clean up a managed Git worktree',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: 'Managed worktree registration ID (mutually exclusive with conversationId/path)' },
        conversationId: { type: 'number', minimum: 1, description: 'Sub-conversation ID (mutually exclusive with worktreeId/path)' },
        path: { type: 'string', description: 'Worktree absolute path (may attach nodeId to disambiguate)' },
        nodeId: { type: 'string', description: 'Target node ID (only combinable with path)' },
        deleteBranch: { type: 'boolean', description: 'Also delete the helm/spawn-* branch (kept by default)' },
        mergedInto: { type: 'string', description: 'Target branch or commit already merged into; defaults to the recorded baseBranch, falling back to the main worktree HEAD' },
        force: { type: 'boolean', description: 'Force cleanup (dirty worktrees are refused by default)' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        removed: { type: 'boolean' },
        worktreeId: { type: 'string' },
        path: { type: 'string' },
        branch: { type: 'string' },
        nodeId: { type: 'string' },
        branchDeleted: { type: 'boolean' },
      },
      required: ['removed', 'worktreeId', 'path', 'branch', 'nodeId', 'branchDeleted'],
      additionalProperties: false,
    },
    cli: { command: ['worktrees', 'cleanup'], description: 'Clean up a managed Git worktree' },
    async handler(input, context) {
      const a = input as Record<string, unknown>
      if (
        a['conversationId'] !== undefined &&
        context.conversationId !== undefined &&
        a['conversationId'] !== context.conversationId
      ) {
        throw new HelmError(
          'validation_error',
          `conversationId 冲突：输入指定 ${String(a['conversationId'])} 与调用上下文 ${context.conversationId} 不一致，请显式统一`,
          400,
          { inputConversationId: a['conversationId'], contextConversationId: context.conversationId },
        )
      }
      const hasExplicit = a['worktreeId'] !== undefined || a['path'] !== undefined || a['conversationId'] !== undefined
      const selectorConversationId =
        a['conversationId'] !== undefined ? Number(a['conversationId']) : hasExplicit ? undefined : context.conversationId
      return isolation.cleanup(
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
    },
  })

  ctx.action({
    id: 'list_worktrees',
    description: 'List managed Git worktree registrations (including metadata of cleaned-up records)',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { worktrees: { type: 'array', items: { type: 'object' } } },
      required: ['worktrees'],
      additionalProperties: false,
    },
    cli: { command: ['worktrees', 'list'], description: 'List managed Git worktree registrations' },
    async handler() {
      return { worktrees: isolation.allocator.list() }
    },
  })

  ctx.action({
    id: 'inspect_worktree',
    description: 'Read-only inspection of one managed Git worktree: registration metadata plus a real read-only git probe on the target node (status/stats/capped diff preview); only registered records can be inspected',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: 'Managed worktree registration ID (node:path; mutually exclusive with conversationId/path)' },
        conversationId: { type: 'number', minimum: 1, description: 'Sub-conversation ID (mutually exclusive with worktreeId/path)' },
        path: { type: 'string', description: 'Worktree absolute path (mutually exclusive with conversationId; same-name paths across nodes need nodeId)' },
        nodeId: { type: 'string', description: 'Target node ID (only combinable with path, disambiguating same-name paths across nodes)' },
        diff: { type: 'boolean', description: 'Whether to include a diff preview (included by default; registration metadata and stats are always returned)' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        record: { type: 'object' },
        exists: { type: 'boolean' },
        unavailableReason: { type: 'string', enum: ['removed', 'directory_missing'] },
        currentBranch: { type: 'string' },
        currentHead: { type: 'string' },
        branchChanged: { type: 'boolean' },
        dirtyFiles: { type: 'array', items: { type: 'string' } },
        dirtyFileCount: { type: 'number' },
        dirtyFilesTruncated: { type: 'boolean' },
        commitsAhead: { type: 'number' },
        diffStat: { type: 'string' },
        diffPreview: { type: 'string' },
        diffTruncated: { type: 'boolean' },
        diffBase: { type: 'string', enum: ['baseCommit', 'HEAD'] },
      },
      required: ['record', 'exists', 'dirtyFiles', 'dirtyFileCount', 'dirtyFilesTruncated', 'diffTruncated', 'diffBase'],
      additionalProperties: false,
    },
    cli: {
      command: ['worktrees', 'inspect'],
      description: 'Read-only inspection of a managed Git worktree (registration metadata + status/stats/diff preview)',
      positional: [{ field: 'worktreeId', required: true }],
    },
    async handler(input, context) {
      const a = input as Record<string, unknown>
      return isolation.allocator.inspect(
        {
          ...(a['worktreeId'] !== undefined ? { worktreeId: String(a['worktreeId']) } : {}),
          ...(a['conversationId'] !== undefined ? { conversationId: Number(a['conversationId']) } : {}),
          ...(a['path'] !== undefined ? { path: String(a['path']) } : {}),
          ...(a['nodeId'] !== undefined ? { nodeId: String(a['nodeId']) } : {}),
          ...(a['diff'] !== undefined ? { diff: a['diff'] === true } : {}),
        },
        context.signal,
      )
    },
  })
}
