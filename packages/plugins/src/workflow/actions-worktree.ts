/**
 * builtin:workflow 受管 Worktree 动作（自 actions.ts 按域拆出）。
 *
 * 3 个动作：cleanup_worktree / list_worktrees / inspect_worktree——
 * 与 tools.ts 的 cleanup_worktree 工具同款选择器语义（显式 conversationId
 * 与调用上下文冲突拒绝；无显式选择器时以 --current 上下文会话兜底）。
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
    description: '清理受管 Git 工作树',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: '受管 worktree 登记 ID（与 conversationId/path 互斥）' },
        conversationId: { type: 'number', minimum: 1, description: '子会话 ID（与 worktreeId/path 互斥）' },
        path: { type: 'string', description: 'worktree 绝对路径（可附 nodeId 消歧）' },
        nodeId: { type: 'string', description: '目标节点 ID（仅可与 path 搭配）' },
        deleteBranch: { type: 'boolean', description: '同时删除 helm/spawn-* 分支（默认保留）' },
        mergedInto: { type: 'string', description: '已合入的目标分支或提交；缺省按记录 baseBranch 再回退主工作树 HEAD' },
        force: { type: 'boolean', description: '强制清理（脏工作区默认拒绝）' },
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
    cli: { command: ['worktrees', 'cleanup'], description: '清理受管 Git 工作树' },
    async handler(input, context) {
      const a = input as Record<string, unknown>
      // 与工具同款语义：显式 conversationId 与上下文冲突拒绝；无任何显式
      // 选择器时（--current）以调用上下文会话为选择器；显式选择器不覆盖。
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
        } as Record<string, never>,
        context.signal,
      )
    },
  })

  ctx.action({
    id: 'list_worktrees',
    description: '列出受管 Git 工作树登记（含已清理记录的元数据）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { worktrees: { type: 'array', items: { type: 'object' } } },
      required: ['worktrees'],
      additionalProperties: false,
    },
    cli: { command: ['worktrees', 'list'], description: '列出受管 Git 工作树登记' },
    async handler() {
      return { worktrees: isolation.allocator.list() }
    },
  })

  ctx.action({
    id: 'inspect_worktree',
    description: '只读检视一个受管 Git 工作树：登记元数据 + 目标节点真实 git 只读探测（状态/统计/有上限 diff 预览）；仅登记记录可检视',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: '受管 worktree 登记 ID（node:path；与 conversationId/path 互斥）' },
        conversationId: { type: 'number', minimum: 1, description: '子会话 ID（与 worktreeId/path 互斥）' },
        path: { type: 'string', description: 'worktree 绝对路径（与 conversationId 互斥；多节点同名路径需另附 nodeId）' },
        nodeId: { type: 'string', description: '目标节点 ID（仅可与 path 搭配，跨节点同名路径消歧）' },
        diff: { type: 'boolean', description: '是否包含 diff 预览（默认包含；登记元数据与统计始终返回）' },
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
      description: '只读检视受管 Git 工作树（登记元数据 + 状态/统计/diff 预览）',
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
