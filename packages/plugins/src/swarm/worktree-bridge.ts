/**
 * builtin:swarm 与 builtin:workflow 的跨插件 Worktree 协作桥接辅助：
 * - 只读检视 worktree 状态（inspect_worktree）、判定有效未合入提交（git merge-base --is-ancestor）；
 * - 统一释放持久持有锁（release_worktree_hold）与清理工作树（cleanup_worktree）；
 * - 统一生成 `409 swarm_worktree_unmerged` 错误，消除 archive_worker 与 close_group 重复分支。
 */
import { HelmError, type HelmPluginContext } from '@helm/protocol'
import { SWARM_PLUGIN_ID, type GroupMemberState, type WorktreeHandoffSnapshot } from './contracts.js'

export const WORKFLOW_PLUGIN_ID = 'builtin:workflow'

export interface WorkflowInspectResultShape {
  record: {
    id: string
    nodeId: string
    repoRoot: string
    path: string
    branch: string
    baseBranch?: string
    baseCommit: string
    status: 'active' | 'removed'
  }
  exists: boolean
  currentBranch?: string
  currentHead?: string
  dirtyFiles: string[]
  dirtyFileCount: number
  commitsAhead?: number
  diffStat?: string
}

export interface WorkflowAcquireResultShape {
  worktreeId: string
  path: string
  branch: string
  baseCommit: string
  nodeId: string
}

export interface CheckedMemberWorktree {
  member: GroupMemberState
  worktreeId: string
  inspected: WorkflowInspectResultShape
  unmergedCommits: number
  isDirty: boolean
}

export function extractChangedFilesPreview(inspected: WorkflowInspectResultShape, maxItems = 20): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (file: string): void => {
    const clean = file.trim()
    if (clean === '' || seen.has(clean)) return
    seen.add(clean)
    if (out.length < maxItems) out.push(clean)
  }
  for (const rawLine of inspected.dirtyFiles) {
    const pathPart = rawLine.length > 3 ? rawLine.slice(3).trim() : rawLine.trim()
    push(pathPart)
  }
  if (typeof inspected.diffStat === 'string') {
    for (const line of inspected.diffStat.split('\n')) {
      const pipeIdx = line.indexOf(' | ')
      if (pipeIdx <= 0) continue
      push(line.slice(0, pipeIdx))
    }
  }
  return out
}

export async function inspectManagedWorktree(
  ctx: HelmPluginContext,
  worktreeId: string,
  signal?: AbortSignal,
): Promise<WorkflowInspectResultShape> {
  const raw = await ctx.host.invokeAction(
    WORKFLOW_PLUGIN_ID,
    'inspect_worktree',
    { worktreeId, diff: false },
    signal !== undefined ? { signal } : undefined,
  )
  return raw as WorkflowInspectResultShape
}

export function toWorktreeHandoffSnapshot(
  worktreeId: string,
  inspected: WorkflowInspectResultShape,
): WorktreeHandoffSnapshot {
  return {
    worktreeId,
    ...(inspected.currentBranch !== undefined ? { branch: inspected.currentBranch } : {}),
    ...(inspected.commitsAhead !== undefined ? { commitsAhead: inspected.commitsAhead } : {}),
    dirtyCount: inspected.dirtyFileCount,
    changedFilesPreview: extractChangedFilesPreview(inspected),
  }
}

export async function computeEffectiveUnmergedCommits(
  ctx: HelmPluginContext,
  inspected: WorkflowInspectResultShape,
  signal?: AbortSignal,
): Promise<number> {
  if (!inspected.exists) return 0
  const ahead = inspected.commitsAhead ?? 0
  if (ahead <= 0) return 0
  if (inspected.record.repoRoot !== '' && inspected.currentHead !== undefined && inspected.currentHead !== '') {
    const res = await ctx.host.execEnv(
      {
        nodeId: inspected.record.nodeId,
        cwd: inspected.record.repoRoot,
        command: ['git', 'merge-base', '--is-ancestor', inspected.currentHead, 'HEAD'],
      },
      signal !== undefined ? { signal } : undefined,
    )
    if (res.exitCode === 0) return 0
  }
  return ahead
}

export async function checkMemberWorktree(
  ctx: HelmPluginContext,
  member: GroupMemberState,
  signal?: AbortSignal,
): Promise<CheckedMemberWorktree | undefined> {
  if (member.worktreeId === undefined) return undefined
  const inspected = await inspectManagedWorktree(ctx, member.worktreeId, signal)
  const unmergedCommits = await computeEffectiveUnmergedCommits(ctx, inspected, signal)
  return {
    member,
    worktreeId: member.worktreeId,
    inspected,
    unmergedCommits,
    isDirty: inspected.exists && inspected.dirtyFileCount > 0,
  }
}

export async function releaseWorktreeHold(
  ctx: HelmPluginContext,
  groupId: string,
  memberName: string,
  worktreeId: string,
  signal?: AbortSignal,
): Promise<void> {
  await ctx.host.invokeAction(
    WORKFLOW_PLUGIN_ID,
    'release_worktree_hold',
    {
      worktreeId,
      pluginId: SWARM_PLUGIN_ID,
      holdId: `${groupId}:${memberName}`,
    },
    signal !== undefined ? { signal } : undefined,
  )
}

export async function cleanupManagedWorktree(
  ctx: HelmPluginContext,
  worktreeId: string,
  force: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await ctx.host.invokeAction(
    WORKFLOW_PLUGIN_ID,
    'cleanup_worktree',
    {
      worktreeId,
      deleteBranch: true,
      ...(force ? { force: true } : {}),
    },
    signal !== undefined ? { signal } : undefined,
  )
}
