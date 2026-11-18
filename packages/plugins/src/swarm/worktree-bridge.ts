/**
 * builtin:swarm 与 builtin:workflow 的跨插件 Worktree 协作桥接辅助：
 * - 只读检视 worktree 状态（inspect_worktree，由 builtin:workflow 权威计算 unmergedCommits）；
 * - 统一释放持久持有锁（release_worktree_hold）与清理工作树（cleanup_worktree）；
 * - 统一生成 Worktree 交接快照与未合入提交汇总。
 */
import type { HelmPluginContext } from '@helm/protocol'
import type { WorktreeInspectResult } from '../contracts.js'
import { SWARM_PLUGIN_ID, type GroupMemberState, type WorktreeHandoffSnapshot } from './contracts.js'

export const WORKFLOW_PLUGIN_ID = 'builtin:workflow'

export interface CheckedMemberWorktree {
  member: GroupMemberState
  worktreeId: string
  inspected: WorktreeInspectResult
  unmergedCommits: number
  isDirty: boolean
}

export function extractChangedFilesPreview(inspected: WorktreeInspectResult, maxItems = 20): string[] {
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
): Promise<WorktreeInspectResult> {
  const raw = await ctx.host.invokeAction(
    WORKFLOW_PLUGIN_ID,
    'inspect_worktree',
    { worktreeId, diff: false },
    signal !== undefined ? { signal } : undefined,
  )
  return raw as WorktreeInspectResult
}

export function toWorktreeHandoffSnapshot(
  worktreeId: string,
  inspected: WorktreeInspectResult,
): WorktreeHandoffSnapshot {
  return {
    worktreeId,
    ...(inspected.currentBranch !== undefined ? { branch: inspected.currentBranch } : {}),
    ...(inspected.commitsAhead !== undefined ? { commitsAhead: inspected.commitsAhead } : {}),
    dirtyCount: inspected.dirtyFileCount,
    changedFilesPreview: extractChangedFilesPreview(inspected),
  }
}

export async function checkMemberWorktree(
  ctx: HelmPluginContext,
  member: GroupMemberState,
  signal?: AbortSignal,
): Promise<CheckedMemberWorktree | undefined> {
  if (member.worktreeId === undefined) return undefined
  const inspected = await inspectManagedWorktree(ctx, member.worktreeId, signal)
  const unmergedCommits = inspected.exists ? (inspected.unmergedCommits ?? inspected.commitsAhead ?? 0) : 0
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
