/**
 * builtin:worktree 受管 Worktree 动作（cleanup_worktree / list_worktrees / inspect_worktree，
 * 以及内部隐藏动作 acquire_worktree / release_worktree_hold）。
 */
import { HelmxError, type HelmxPluginContext } from '@helmx/protocol'
import type { WorktreeIsolation } from './isolation.js'

export interface WorktreeActionDeps {
  isolation: WorktreeIsolation
}

export function registerWorktreeActions(ctx: HelmxPluginContext, deps: WorktreeActionDeps): void {
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
        deleteBranch: { type: 'boolean', description: 'Also delete the helmx/spawn-* branch (kept by default)' },
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
        removedReason: {
          type: 'string',
          enum: ['directory_missing_forced'],
          description: 'Set only when the registration was force-cleared after the directory was confirmed missing',
        },
        prune: {
          type: 'object',
          description: 'git worktree prune outcome (directory-missing force path only; ran=false when no repoRoot anchor)',
          properties: {
            ran: { type: 'boolean' },
            ok: { type: 'boolean' },
            output: { type: 'string' },
          },
          required: ['ran', 'ok'],
          additionalProperties: false,
        },
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
        throw new HelmxError(
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
        unmergedCommits: { type: 'number' },
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

  ctx.action({
    id: 'acquire_worktree',
    description: 'Allocate a managed Git worktree for a worker conversation and attach a durable plugin hold',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'integer',
          minimum: 1,
          description: 'Worker conversation ID to bind to the newly allocated worktree',
        },
        parentConversationId: {
          type: 'integer',
          minimum: 1,
          description: 'Parent or coordinator conversation ID used to resolve the spawn target',
        },
        profileId: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Optional worker profile ID for spawn target resolution',
        },
        requestCwd: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Optional explicit source directory override',
        },
        fork: {
          type: 'boolean',
          description: 'Whether the worker conversation was forked from the parent conversation',
        },
        hold: {
          type: 'object',
          properties: {
            pluginId: {
              type: 'string',
              minLength: 1,
              pattern: '\\S',
              description: 'Owning plugin ID holding the durable worktree lock',
            },
            holdId: {
              type: 'string',
              minLength: 1,
              pattern: '\\S',
              description: 'Stable hold identifier within the owning plugin',
            },
            label: {
              type: 'string',
              minLength: 1,
              pattern: '\\S',
              description: 'Human-readable hold diagnostic label (redacted before persistence)',
            },
          },
          required: ['pluginId', 'holdId', 'label'],
          additionalProperties: false,
        },
      },
      required: ['conversationId', 'parentConversationId', 'hold'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string' },
        path: { type: 'string' },
        branch: { type: 'string' },
        baseCommit: { type: 'string' },
        nodeId: { type: 'string' },
      },
      required: ['worktreeId', 'path', 'branch', 'baseCommit', 'nodeId'],
      additionalProperties: false,
    },
    cli: { hidden: true },
    exposeAsTool: false,
    exposeToPrompt: false,
    async handler(input, context) {
      const a = input as {
        conversationId: number
        parentConversationId: number
        profileId?: string
        requestCwd?: string
        fork?: boolean
        hold: { pluginId: string; holdId: string; label: string }
      }
      return isolation.acquireWorktree(
        {
          conversationId: a.conversationId,
          parentConversationId: a.parentConversationId,
          ...(a.profileId !== undefined ? { profileId: a.profileId } : {}),
          ...(a.requestCwd !== undefined ? { requestCwd: a.requestCwd } : {}),
          ...(a.fork !== undefined ? { fork: a.fork } : {}),
          hold: {
            pluginId: a.hold.pluginId,
            holdId: a.hold.holdId,
            label: a.hold.label,
          },
        },
        context.signal,
      )
    },
  })

  ctx.action({
    id: 'release_worktree_hold',
    description: 'Release a durable plugin hold on a managed Git worktree',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Managed worktree registration ID (node:path)',
        },
        pluginId: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Owning plugin ID expected on the active hold',
        },
        holdId: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Stable hold identifier expected on the active hold',
        },
      },
      required: ['worktreeId', 'pluginId', 'holdId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        released: { type: 'boolean' },
      },
      required: ['released'],
      additionalProperties: false,
    },
    cli: { hidden: true },
    exposeAsTool: false,
    exposeToPrompt: false,
    async handler(input) {
      const a = input as { worktreeId: string; pluginId: string; holdId: string }
      return isolation.releaseWorktreeHold({
        worktreeId: a.worktreeId,
        pluginId: a.pluginId,
        holdId: a.holdId,
      })
    },
  })
}
