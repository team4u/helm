import {
  HelmxError,
  type ConversationSummary,
  type HelmxPluginContext,
} from '@helmx/protocol'
import {
  ARCHIVED_COORDINATOR_TAG,
  ARCHIVED_WORKER_TAG,
  COORDINATOR_TAG,
  SWARM_PLUGIN_ID,
  WORKER_TAG,
  assertGroupId,
  type BoardViewDoc,
  type CollabGroupRecord,
  type RetainedWorktreeInfo,
  type SwarmCoordinator,
} from './contracts.js'
import {
  checkMemberWorktree,
  cleanupManagedWorktree,
  releaseWorktreeHold,
  type CheckedMemberWorktree,
} from './worktree-bridge.js'

export interface EnsureCoordinatorGroupInput {
  conversationId: number
  title: string
  objective?: string
  channels?: Array<{ name: string; topic?: string }>
  reuseExisting?: boolean
  createKey?: string
}

export function assertCoordinatorAuthority(
  conversationId: number | undefined,
  group: CollabGroupRecord,
): void {
  if (conversationId === undefined) return
  if (conversationId !== group.coordinatorConversationId) {
    throw new HelmxError(
      'conversation_scope_violation',
      `该操作仅允许协作组 '${group.id}' 的主控会话 #${group.coordinatorConversationId} 执行（当前会话 #${conversationId}）`,
      403,
      {
        pluginId: SWARM_PLUGIN_ID,
        groupId: group.id,
        coordinatorConversationId: group.coordinatorConversationId,
        conversationId,
      },
    )
  }
}

export function isWorkerBusy(
  coordinator: Pick<SwarmCoordinator, 'readConversationOrUndefined' | 'settlingWorkers'>,
  conversationId: number,
  status?: string,
): boolean {
  const convStatus = status ?? coordinator.readConversationOrUndefined(conversationId)?.status
  return (
    convStatus === 'working' ||
    convStatus === 'blocked' ||
    coordinator.settlingWorkers.has(conversationId)
  )
}

export function resolveCoordinatorGroup(
  groups: SwarmCoordinator['groups'],
  explicitGroupId: string | undefined,
  conversationId: number | undefined,
  requireActive: boolean,
): CollabGroupRecord {
  if (explicitGroupId !== undefined && explicitGroupId.trim() !== '') {
    const group = groups.getGroup(assertGroupId(explicitGroupId))
    if (group === undefined) {
      throw new HelmxError('swarm_group_not_found', `协作组 '${explicitGroupId}' 不存在`, 404, {
        pluginId: SWARM_PLUGIN_ID,
        groupId: explicitGroupId,
      })
    }
    assertCoordinatorAuthority(conversationId, group)
    if (requireActive && group.status !== 'active') {
      throw new HelmxError('swarm_group_closed', `协作组 '${group.id}' 已结单`, 409, {
        pluginId: SWARM_PLUGIN_ID,
        groupId: group.id,
      })
    }
    return group
  }
  if (conversationId !== undefined) {
    const active = groups.findActiveGroupByCoordinator(conversationId)
    if (active !== undefined) return active
    if (!requireActive) {
      const latest = groups.findLatestGroupForConversation(conversationId)
      if (latest !== undefined && latest.coordinatorConversationId === conversationId) return latest
    }
  }
  throw new HelmxError(
    'swarm_group_not_found',
    '未找到关联的活跃协作组；请显式指定 groupId 或先调用 create_group 建组',
    404,
    { pluginId: SWARM_PLUGIN_ID, ...(conversationId !== undefined ? { conversationId } : {}) },
  )
}

export function checkCoordinatorEligibility(
  conv: ConversationSummary,
  ownership: 'human' | 'bot' | 'helmx' | string,
): { code: 'validation_error' | 'conversation_scope_violation'; message: string; status: 400 | 403; details: Record<string, unknown> } | undefined {
  if (conv.parentConversationId !== undefined) {
    return {
      code: 'validation_error',
      message: `仅允许在顶层会话创建协作组（会话 #${conv.id} 是子会话，父会话 #${conv.parentConversationId}）`,
      status: 400,
      details: { conversationId: conv.id, parentConversationId: conv.parentConversationId },
    }
  }
  if (
    ownership !== 'human' ||
    conv.tags.includes(WORKER_TAG) ||
    conv.tags.includes(ARCHIVED_WORKER_TAG)
  ) {
    return {
      code: 'conversation_scope_violation',
      message: `禁止在后台会话或 Worker 会话 #${conv.id} 上创建协作组`,
      status: 403,
      details: { conversationId: conv.id },
    }
  }
  return undefined
}

export async function ensureCoordinatorGroup(
  ctx: HelmxPluginContext,
  coordinator: SwarmCoordinator,
  input: EnsureCoordinatorGroupInput,
): Promise<{ groupId: string; group: BoardViewDoc['group'] }> {
  const { readConversationOrUndefined, enqueueDispatch, groups } = coordinator
  const targetConvId = input.conversationId
  const conv = readConversationOrUndefined(targetConvId)
  if (conv === undefined) {
    throw new HelmxError('not_found', `目标会话 #${targetConvId} 不存在`, 404, { conversationId: targetConvId })
  }
  const eligibilityErr = checkCoordinatorEligibility(conv, ctx.host.getConversationOwnership(targetConvId))
  if (eligibilityErr !== undefined) {
    throw new HelmxError(eligibilityErr.code, eligibilityErr.message, eligibilityErr.status, eligibilityErr.details)
  }

  return enqueueDispatch(async () => {
    const syncTagAndProjections = async (groupId: string): Promise<{ groupId: string; group: BoardViewDoc['group'] }> => {
      const latestConv = readConversationOrUndefined(targetConvId)
      if (latestConv !== undefined && !latestConv.tags.includes(COORDINATOR_TAG)) {
        // 挂回活跃主控 tag 时同步摘除结单历史 tag，避免同一会话双主控标记并存。
        await ctx.host.updateConversation(targetConvId, {
          tags: [...latestConv.tags.filter((t) => t !== ARCHIVED_COORDINATOR_TAG), COORDINATOR_TAG],
        })
      }
      groups.syncProjections()
      const view = groups.buildBoardView(groupId)
      return { groupId, group: view.group }
    }

    if (input.reuseExisting === true || input.createKey !== undefined) {
      const existing = groups.findActiveGroupByCoordinator(targetConvId)
      if (
        existing !== undefined &&
        (input.reuseExisting === true || existing.createKey === input.createKey)
      ) {
        return syncTagAndProjections(existing.id)
      }
    }

    const created = await groups.createGroup({
      coordinatorConversationId: targetConvId,
      title: input.title.trim().slice(0, 120),
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.channels !== undefined ? { channels: input.channels } : {}),
      ...(input.createKey !== undefined ? { createKey: input.createKey } : {}),
    })
    return syncTagAndProjections(created.id)
  })
}

function isPosIntId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

export function createGroupHandlers(ctx: HelmxPluginContext, coordinator: SwarmCoordinator) {
  const { readConversationOrUndefined, enqueueDispatch, groups } = coordinator

  const createGroup = async (
    input: {
      title: string
      objective?: string
      channels?: Array<{ name: string; topic?: string }>
      conversationId?: number
    },
    contextConversationId: number | undefined,
    idempotencyKey?: string,
  ): Promise<{ groupId: string; group: BoardViewDoc['group'] }> => {
    if (typeof input.title !== 'string' || input.title.trim() === '') {
      throw new HelmxError('validation_error', 'create_group 需要非空 title', 400, {})
    }
    if (
      input.conversationId !== undefined &&
      contextConversationId !== undefined &&
      input.conversationId !== contextConversationId
    ) {
      throw new HelmxError(
        'validation_error',
        `conversationId 冲突：输入指定 #${input.conversationId} 与调用上下文 #${contextConversationId} 不一致`,
        400,
        { inputConversationId: input.conversationId, contextConversationId },
      )
    }
    const targetConvId = input.conversationId ?? contextConversationId
    if (!isPosIntId(targetConvId)) {
      throw new HelmxError('validation_error', 'create_group 需要有效的目标主控会话 conversationId', 400, {})
    }
    return ensureCoordinatorGroup(ctx, coordinator, {
      conversationId: targetConvId,
      title: input.title,
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.channels !== undefined ? { channels: input.channels } : {}),
      reuseExisting: false,
      ...(idempotencyKey !== undefined ? { createKey: idempotencyKey } : {}),
    })
  }

  const updateGroup = async (
    input: { groupId?: string; title?: string; objective?: string },
    conversationId: number | undefined,
  ): Promise<{ groupId: string; group: BoardViewDoc['group'] }> => {
    const group = resolveCoordinatorGroup(groups, input.groupId, conversationId, true)
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.trim() === '')) {
      throw new HelmxError('validation_error', 'title 必须是非空字符串', 400, {})
    }
    if (input.objective !== undefined && typeof input.objective !== 'string') {
      throw new HelmxError('validation_error', 'objective 必须是字符串', 400, {})
    }
    await groups.updateGroup(group.id, {
      ...(input.title !== undefined ? { title: input.title.trim().slice(0, 120) } : {}),
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
    })
    const view = groups.buildBoardView(group.id)
    return { groupId: group.id, group: view.group }
  }

  const manageChannel = async (
    input: {
      groupId?: string
      op: 'create' | 'subscribe' | 'unsubscribe' | 'archive'
      channel: string
      topic?: string
      member?: string
    },
    conversationId: number | undefined,
  ): Promise<{ groupId: string; channels: Array<{ name: string; topic?: string; archived?: boolean }> }> => {
    const group = resolveCoordinatorGroup(groups, input.groupId, conversationId, true)
    if (!['create', 'subscribe', 'unsubscribe', 'archive'].includes(input.op)) {
      throw new HelmxError('validation_error', `未知频道操作 '${String(input.op)}'`, 400, {})
    }
    const updated = await groups.manageChannel(group.id, input)
    return {
      groupId: updated.id,
      channels: updated.channels.map((c) => ({ ...c })),
    }
  }

  const closeGroup = async (
    input: {
      groupId?: string
      keepWorktree?: boolean
      abortRunning?: boolean
      summary?: string
    },
    conversationId: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ closed: true; groupId: string; retainedWorktrees: RetainedWorktreeInfo[] }> => {
    const group = resolveCoordinatorGroup(groups, input.groupId, conversationId, false)
    if (group.status === 'closed') {
      return {
        closed: true,
        groupId: group.id,
        retainedWorktrees: group.retainedWorktrees ?? [],
      }
    }

    return enqueueDispatch(async () => {
      const freshGroup = groups.getGroup(group.id)
      if (freshGroup === undefined) {
        throw new HelmxError('swarm_group_not_found', `协作组 '${group.id}' 不存在`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: group.id,
        })
      }
      if (freshGroup.status === 'closed') {
        return {
          closed: true,
          groupId: freshGroup.id,
          retainedWorktrees: freshGroup.retainedWorktrees ?? [],
        }
      }

      const activeMembers = freshGroup.members.filter((m) => m.lifecycle === 'active')

      for (const member of activeMembers) {
        const s = readConversationOrUndefined(member.conversationId)
        if (s === undefined || !isWorkerBusy(coordinator, member.conversationId, s.status)) continue
        if (input.abortRunning === true) {
          if (s.status === 'working' || s.status === 'blocked') {
            await ctx.host.abortConversationGuarded(member.conversationId, { expectedOwnership: 'helmx' })
          }
          continue
        }
        throw new HelmxError(
          'swarm_worker_busy',
          `协作组 '${freshGroup.id}' 成员 @${member.name} (#${member.conversationId}) 仍在运行中；请等待完工或传 abortRunning: true`,
          409,
          {
            pluginId: SWARM_PLUGIN_ID,
            groupId: freshGroup.id,
            memberName: member.name,
            workerConversationId: member.conversationId,
          },
        )
      }

      const worktreeChecks: CheckedMemberWorktree[] = []
      for (const member of activeMembers) {
        const checked = await checkMemberWorktree(ctx, member, signal)
        if (checked !== undefined) worktreeChecks.push(checked)
      }

      const keepWorktree = input.keepWorktree === true
      if (!keepWorktree) {
        const unmerged = worktreeChecks.filter(
          (item) => item.inspected.exists && (item.isDirty || item.unmergedCommits > 0),
        )
        if (unmerged.length > 0) {
          const branchList = unmerged
            .map((item) => `@${item.member.name}:${item.inspected.currentBranch ?? item.inspected.record.branch}`)
            .join(', ')
          throw new HelmxError(
            'swarm_worktree_unmerged',
            `协作组 '${freshGroup.id}' 含未合入或脏工作树分支（${branchList}）；请传 keepWorktree: true 解锁主控合入收尾后再清理`,
            409,
            {
              pluginId: SWARM_PLUGIN_ID,
              groupId: freshGroup.id,
              unmergedWorktrees: unmerged.map((item) => ({
                memberName: item.member.name,
                worktreeId: item.worktreeId,
                branch: item.inspected.currentBranch ?? item.inspected.record.branch,
                path: item.inspected.record.path,
                commitsAhead: item.unmergedCommits,
                dirtyCount: item.inspected.dirtyFileCount,
              })),
            },
          )
        }
      }

      const retainedWorktrees: RetainedWorktreeInfo[] = []
      for (const item of worktreeChecks) {
        await releaseWorktreeHold(ctx, freshGroup.id, item.member.name, item.worktreeId, signal)
        if (!item.inspected.exists) continue
        if (keepWorktree && (item.isDirty || item.unmergedCommits > 0)) {
          retainedWorktrees.push({
            memberName: item.member.name,
            worktreeId: item.worktreeId,
            branch: item.inspected.currentBranch ?? item.inspected.record.branch,
            path: item.inspected.record.path,
            commitsAhead: item.unmergedCommits,
          })
        } else {
          await cleanupManagedWorktree(ctx, item.worktreeId, false, signal)
        }
      }

      const now = Date.now()
      await groups.mutateGroup(freshGroup.id, (draft) => {
        draft.status = 'closed'
        draft.closedAt = now
        draft.updatedAt = now
        draft.retainedWorktrees = retainedWorktrees
        if (input.summary !== undefined && input.summary.trim() !== '') {
          draft.closeSummary = input.summary.trim()
        }
        for (const m of draft.members) {
          if (m.lifecycle === 'active') {
            m.lifecycle = 'archived'
            m.archivedAt = now
          }
        }
        return { group: draft, result: undefined }
      })

      for (const member of activeMembers) {
        const s = readConversationOrUndefined(member.conversationId)
        if (s !== undefined) {
          const nextTags = [...s.tags.filter((t) => t !== WORKER_TAG), ARCHIVED_WORKER_TAG]
          await ctx.host.updateConversation(member.conversationId, { tags: nextTags })
        }
      }

      const coordConv = readConversationOrUndefined(freshGroup.coordinatorConversationId)
      if (coordConv !== undefined && coordConv.tags.includes(COORDINATOR_TAG)) {
        // 结单后将活跃主控 tag 原地替换为历史 tag：workbench 编排面板仍可访问已完成编组，
        // 但 swarm_create_group 解锁、主控守卫与工具注入按活跃组判定不再复活。
        await ctx.host.updateConversation(freshGroup.coordinatorConversationId, {
          tags: [...coordConv.tags.filter((t) => t !== COORDINATOR_TAG), ARCHIVED_COORDINATOR_TAG],
        })
      }

      groups.syncProjections()
      return {
        closed: true,
        groupId: freshGroup.id,
        retainedWorktrees,
      }
    })
  }

  return { createGroup, updateGroup, manageChannel, closeGroup }
}
