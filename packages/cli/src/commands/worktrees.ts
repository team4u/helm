/**
 * 受管工作树域：worktrees cleanup。
 * POST /api/worktrees/cleanup 由内核 WorktreeAllocator 执行真实 git 删除，
 * 预算可能远超客户端默认 30s——本请求不施加客户端超时（timeoutMs: 0）。
 */
import type { WorktreeCleanupRequest, WorktreeCleanupResult } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, parsePositiveInt, printResult, resolveConversationTarget } from './shared.js'
import { printText } from '../output.js'

/** 选择器三选一：--id / --conversation / --path（--path 可搭配 --node）。
 *  --current 复用 --conversation 语义（读 HELM_CONVERSATION_ID）。 */
const CLEANUP_FLAGS: readonly FlagSpec[] = [
  { name: 'id', type: 'string', help: '受管 worktree 登记 ID（与 --conversation/--path 互斥）' },
  { name: 'conversation', type: 'string', help: '子会话 ID（与 --id/--path 互斥）' },
  { name: 'current', type: 'boolean', help: '使用 env HELM_CONVERSATION_ID（与 --id/--path 互斥）' },
  { name: 'path', type: 'string', help: 'worktree 绝对路径（与 --id/--conversation 互斥）' },
  { name: 'node', type: 'string', help: '搭配 --path 的节点 ID（多节点同路径消歧）' },
  { name: 'delete-branch', type: 'boolean', help: '一并删除 helm/spawn-* 分支（默认保留）' },
  { name: 'force', type: 'boolean', help: '强制清理（脏工作区默认拒绝）' },
]

export function worktreesCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['worktrees', 'cleanup'],
    description: '清理受管隔离 worktree（POST /api/worktrees/cleanup；仅清理 helm 登记记录，绝不触碰未登记目录）',
    flags: [...CLEANUP_FLAGS],
    async run(ctx: CommandContext) {
      const parsed = parseFlags(CLEANUP_FLAGS, ctx.args)
      assertNoExtraPositionals(parsed.positionals, 0)

      const body: WorktreeCleanupRequest = {}
      const id = flagValue<string>(parsed.flags, 'id')
      const conversation = flagValue<string>(parsed.flags, 'conversation')
      const path = flagValue<string>(parsed.flags, 'path')
      const current = parsed.flags.get('current') === true
      if (current && conversation !== undefined) {
        throw new CliError('--conversation 与 --current 只能提供一个', 'conflicting_flags')
      }

      // 选择器互斥：worktreeId / conversationId / path 必须且只能提供一个。
      const provided = [
        id !== undefined,
        conversation !== undefined || current,
        path !== undefined,
      ].filter(Boolean).length
      if (provided !== 1) {
        throw new CliError(
          provided === 0
            ? '缺少选择器：提供 --id、--conversation、--current 或 --path 之一'
            : '选择器互斥：--id、--conversation/--current、--path 只能提供一个',
          'conflicting_flags',
        )
      }

      if (id !== undefined) {
        if (id.trim() === '') throw new CliError('--id 需为非空字符串', 'invalid_flag_value')
        body.worktreeId = id
      } else if (conversation !== undefined) {
        body.conversationId = parsePositiveInt(conversation, '--conversation', 'invalid_flag_value')
      } else if (current) {
        body.conversationId = resolveConversationTarget(parsed.flags, undefined, ctx.env)
      } else if (path === undefined) {
        throw new CliError('缺少选择器：提供 --id、--conversation、--current 或 --path 之一', 'conflicting_flags')
      } else {
        if (path.trim() === '') throw new CliError('--path 需为非空 worktree 路径', 'invalid_flag_value')
        body.path = path
      }

      const node = flagValue<string>(parsed.flags, 'node')
      if (node !== undefined) {
        if (path === undefined) throw new CliError('--node 仅可搭配 --path 使用', 'conflicting_flags')
        if (node.trim() === '') throw new CliError('--node 需为非空节点 ID', 'invalid_flag_value')
        body.nodeId = node
      }

      if (parsed.flags.get('delete-branch') === true) body.deleteBranch = true
      if (parsed.flags.get('force') === true) body.force = true

      const hub = await ctx.hub()
      // git 真实删除经远端节点执行，预算交给服务端；不施加客户端默认超时。
      const result = await hub.request<WorktreeCleanupResult>('POST', '/api/worktrees/cleanup', {
        body,
        timeoutMs: 0,
      })
      const v = result as unknown as Record<string, unknown>
      if (
        result === null || typeof result !== 'object' || Array.isArray(result) ||
        typeof v['worktreeId'] !== 'string' || v['worktreeId'] === '' ||
        typeof v['removed'] !== 'boolean' ||
        typeof v['path'] !== 'string' ||
        typeof v['branch'] !== 'string' ||
        typeof v['nodeId'] !== 'string' ||
        typeof v['branchDeleted'] !== 'boolean'
      ) {
        throw new CliError('Hub 响应非 WorktreeCleanupResult 形状', 'invalid_response')
      }
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      printText(
        ctx.io,
        result.removed
          ? `已移除受管 worktree ${result.path}（branch: ${result.branch}，节点 ${result.nodeId}${result.branchDeleted ? '，分支已删除' : '，分支保留'}）`
          : `受管 worktree ${result.path} 此前已清理（幂等跳过；branch: ${result.branch}）`,
      )
    },
  })

  return cmds
}
