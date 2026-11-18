import {
  HelmError,
  type ConversationSummary,
  type HelmPluginContext,
  type PluginToolContext,
} from '@helm/protocol'
import {
  ARCHIVED_COORDINATOR_TAG,
  ARCHIVED_WORKER_TAG,
  COORDINATOR_SCOPE,
  COORDINATOR_TAG,
  PARTICIPANT_SCOPE,
  SWARM_PLUGIN_ID,
  WORKER_TAG,
  assertBoardPostKind,
  assertChannelName,
  assertGroupId,
  assertMemberName,
  isAbsoluteTargetPath,
  isPosIntId,
  type BoardPost,
  type BoardPostKind,
  type BoardViewDoc,
  type CollabGroupRecord,
  type GroupMemberState,
  type RetainedWorktreeInfo,
  type SwarmCoordinator,
  type WorkerAccess,
  type WorkerIsolation,
  type WorktreeHandoffSnapshot,
} from './contracts.js'
import {
  resolveBoardTargets,
  resolveDefaultWake,
  resolvePostChannel,
  type BoardCallerIdentity,
} from './board-router.js'
import { recentEntrySummaries } from './settlement.js'
import {
  archiveWorkerInputSchema,
  boardPostInputSchema,
  boardReadInputSchema,
  boardStatusInputSchema,
  closeGroupInputSchema,
  completerInputSchema,
  createGroupInputSchema,
  dispatchInputSchema,
  manageChannelInputSchema,
  switchModelInputSchema,
  updateGroupInputSchema,
  workerIdInputSchema,
} from './action-schemas.js'
import {
  WORKFLOW_PLUGIN_ID,
  checkMemberWorktree,
  cleanupManagedWorktree,
  inspectManagedWorktree,
  releaseWorktreeHold,
  toWorktreeHandoffSnapshot,
  type CheckedMemberWorktree,
  type WorkflowAcquireResultShape,
} from './worktree-bridge.js'

export interface DispatchInput {
  prompt: string
  groupId?: string
  name: string
  profileId?: string
  access?: WorkerAccess
  isolation?: WorkerIsolation
  forkFrom?: string
  forkEntryId?: number
  model?: string
  effort?: string
  channels?: string[]
  title?: string
  cwd?: string
  nodeId?: string
}

function assertCoordinatorAuthority(
  conversationId: number | undefined,
  group: CollabGroupRecord,
): void {
  if (conversationId === undefined) return
  if (conversationId !== group.coordinatorConversationId) {
    throw new HelmError(
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

export function assertWorkerConversationId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HelmError('validation_error', `workerConversationId 必须是正整数（收到：${String(value)}）`, 400, {})
  }
  return value
}

export function assertProfileId(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 64 || /\s|[/\\]/.test(trimmed)) {
    throw new HelmError('validation_error', `profileId 非法（非空 1..64 字符，不含空白与路径分隔符，收到：${value}）`, 400, {})
  }
  return trimmed
}

export function assertWorkerCwd(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || !isAbsoluteTargetPath(trimmed)) {
    throw new HelmError(
      'validation_error',
      `cwd 必须是跨平台绝对路径（POSIX / 开头、Windows 盘符或 UNC；收到：${value}）`,
      400,
      {},
    )
  }
  return trimmed
}

export function assertWorkerNodeId(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 64 || /\s|[/\\]/.test(trimmed)) {
    throw new HelmError(
      'validation_error',
      `nodeId 非法（非空 1..64 字符，不含空白与路径分隔符，收到：${value}）`,
      400,
      {},
    )
  }
  return trimmed
}

export interface EnsureCoordinatorGroupInput {
  conversationId: number
  title: string
  objective?: string
  channels?: Array<{ name: string; topic?: string }>
  reuseExisting?: boolean
}

export function checkCoordinatorEligibility(
  conv: ConversationSummary,
  ownership: 'human' | 'bot' | 'helm' | string,
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
  ctx: HelmPluginContext,
  coordinator: SwarmCoordinator,
  input: EnsureCoordinatorGroupInput,
): Promise<{ groupId: string; group: BoardViewDoc['group'] }> {
  const { readConversationOrUndefined, enqueueDispatch, groups } = coordinator
  const targetConvId = input.conversationId
  const conv = readConversationOrUndefined(targetConvId)
  if (conv === undefined) {
    throw new HelmError('not_found', `目标会话 #${targetConvId} 不存在`, 404, { conversationId: targetConvId })
  }
  const eligibilityErr = checkCoordinatorEligibility(conv, ctx.host.getConversationOwnership(targetConvId))
  if (eligibilityErr !== undefined) {
    throw new HelmError(eligibilityErr.code, eligibilityErr.message, eligibilityErr.status, eligibilityErr.details)
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

    if (input.reuseExisting === true) {
      const existing = groups.findActiveGroupByCoordinator(targetConvId)
      if (existing !== undefined) {
        return syncTagAndProjections(existing.id)
      }
    }

    const created = await groups.createGroup({
      coordinatorConversationId: targetConvId,
      title: input.title.trim().slice(0, 120),
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.channels !== undefined ? { channels: input.channels } : {}),
    })
    return syncTagAndProjections(created.id)
  })
}

export function registerSwarmActions(
  ctx: HelmPluginContext,
  coordinator: SwarmCoordinator,
): void {
  const {
    getConfig,
    readConversationOrUndefined,
    reportError,
    enqueueDispatch,
    groups,
    settlingWorkers,
  } = coordinator

  const isWorkerBusy = (conversationId: number, status?: string): boolean => {
    const convStatus = status ?? readConversationOrUndefined(conversationId)?.status
    return (
      convStatus === 'working' ||
      convStatus === 'blocked' ||
      settlingWorkers.has(conversationId)
    )
  }

  // ------------------------------------------------------------------
  // 协作组上下文解析辅助
  // ------------------------------------------------------------------
  const resolveCoordinatorGroup = (
    explicitGroupId: string | undefined,
    conversationId: number | undefined,
    requireActive: boolean,
  ): CollabGroupRecord => {
    if (explicitGroupId !== undefined && explicitGroupId.trim() !== '') {
      const group = groups.getGroup(assertGroupId(explicitGroupId))
      if (group === undefined) {
        throw new HelmError('swarm_group_not_found', `协作组 '${explicitGroupId}' 不存在`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: explicitGroupId,
        })
      }
      assertCoordinatorAuthority(conversationId, group)
      if (requireActive && group.status !== 'active') {
        throw new HelmError('swarm_group_closed', `协作组 '${group.id}' 已结单`, 409, {
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
    throw new HelmError(
      'swarm_group_not_found',
      '未找到关联的活跃协作组；请显式指定 groupId 或先调用 create_group 建组',
      404,
      { pluginId: SWARM_PLUGIN_ID, ...(conversationId !== undefined ? { conversationId } : {}) },
    )
  }

  const resolveTargetWorker = (
    input: { workerConversationId?: number; groupId?: string; name?: string },
    callerConversationId: number | undefined,
  ): { group: CollabGroupRecord; member: GroupMemberState; workerConversationId: number } => {
    const hasId = input.workerConversationId !== undefined
    const hasName = input.name !== undefined && input.name.trim() !== ''
    if (!hasId && !hasName) {
      throw new HelmError('validation_error', '必须指定 workerConversationId 或成员名 name', 400, {})
    }
    if (hasName) {
      const cleanName = assertMemberName(input.name)
      let group: CollabGroupRecord | undefined
      if (input.groupId !== undefined && input.groupId.trim() !== '') {
        group = groups.getGroup(assertGroupId(input.groupId))
      } else if (callerConversationId !== undefined) {
        group = groups.findLatestGroupForConversation(callerConversationId)
      }
      if (group === undefined) {
        throw new HelmError('swarm_group_not_found', '未找到目标协作组', 404, { pluginId: SWARM_PLUGIN_ID })
      }
      const member = group.members.find((m) => m.name === cleanName)
      if (member === undefined) {
        throw new HelmError('swarm_unknown_target', `协作组 '${group.id}' 中不存在成员 '${cleanName}'`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: group.id,
          name: cleanName,
        })
      }
      if (hasId && assertWorkerConversationId(input.workerConversationId) !== member.conversationId) {
        throw new HelmError('validation_error', 'workerConversationId 与 name 指向不同会话', 400, {})
      }
      return { group, member, workerConversationId: member.conversationId }
    }

    const workerId = assertWorkerConversationId(input.workerConversationId)
    for (const g of groups.listGroups()) {
      if (input.groupId !== undefined && input.groupId.trim() !== '' && g.id !== assertGroupId(input.groupId)) continue
      const m = g.members.find((item) => item.conversationId === workerId)
      if (m !== undefined) {
        return { group: g, member: m, workerConversationId: workerId }
      }
    }
    throw new HelmError('not_found', `会话 #${workerId} 不是 ${SWARM_PLUGIN_ID} 登记的协作组成员`, 404, {
      pluginId: SWARM_PLUGIN_ID,
      workerConversationId: workerId,
    })
  }

  // ------------------------------------------------------------------
  // 1. create_group / update_group / manage_channel
  // ------------------------------------------------------------------
  const createGroup = async (
    input: {
      title: string
      objective?: string
      channels?: Array<{ name: string; topic?: string }>
      conversationId?: number
    },
    contextConversationId: number | undefined,
  ): Promise<{ groupId: string; group: BoardViewDoc['group'] }> => {
    if (typeof input.title !== 'string' || input.title.trim() === '') {
      throw new HelmError('validation_error', 'create_group 需要非空 title', 400, {})
    }
    if (
      input.conversationId !== undefined &&
      contextConversationId !== undefined &&
      input.conversationId !== contextConversationId
    ) {
      throw new HelmError(
        'validation_error',
        `conversationId 冲突：输入指定 #${input.conversationId} 与调用上下文 #${contextConversationId} 不一致`,
        400,
        { inputConversationId: input.conversationId, contextConversationId },
      )
    }
    const targetConvId = input.conversationId ?? contextConversationId
    if (!isPosIntId(targetConvId)) {
      throw new HelmError('validation_error', 'create_group 需要有效的目标主控会话 conversationId', 400, {})
    }
    return ensureCoordinatorGroup(ctx, coordinator, {
      conversationId: targetConvId,
      title: input.title,
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.channels !== undefined ? { channels: input.channels } : {}),
      reuseExisting: false,
    })
  }

  const updateGroup = async (
    input: { groupId?: string; title?: string; objective?: string },
    conversationId: number | undefined,
  ): Promise<{ groupId: string; group: BoardViewDoc['group'] }> => {
    const group = resolveCoordinatorGroup(input.groupId, conversationId, true)
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.trim() === '')) {
      throw new HelmError('validation_error', 'title 必须是非空字符串', 400, {})
    }
    if (input.objective !== undefined && typeof input.objective !== 'string') {
      throw new HelmError('validation_error', 'objective 必须是字符串', 400, {})
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
    const group = resolveCoordinatorGroup(input.groupId, conversationId, true)
    if (!['create', 'subscribe', 'unsubscribe', 'archive'].includes(input.op)) {
      throw new HelmError('validation_error', `未知频道操作 '${String(input.op)}'`, 400, {})
    }
    const updated = await groups.manageChannel(group.id, input)
    return {
      groupId: updated.id,
      channels: updated.channels.map((c) => ({ ...c })),
    }
  }

  // ------------------------------------------------------------------
  // 2. dispatch_worker（协作组具名对等角色招募）
  // ------------------------------------------------------------------
  const dispatchWorker = async (
    input: DispatchInput,
    conversationId: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ workerConversationId: number; groupId: string; name: string; worktreeId?: string; postSeq: number }> => {
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
      throw new HelmError('validation_error', 'dispatch_worker 需要 prompt（非空文本）', 400, {})
    }
    const group = resolveCoordinatorGroup(input.groupId, conversationId, true)
    const memberName = assertMemberName(input.name)
    const access: WorkerAccess = input.access === undefined ? 'readwrite' : input.access
    if (access !== 'readwrite' && access !== 'readonly') {
      throw new HelmError('validation_error', `access 非法（期望 readwrite | readonly，收到：${String(access)}）`, 400, {})
    }
    const isolation: WorkerIsolation = input.isolation === undefined ? 'inherit' : input.isolation
    if (isolation !== 'inherit' && isolation !== 'worktree') {
      throw new HelmError('validation_error', `isolation 非法（期望 inherit | worktree，收到：${String(isolation)}）`, 400, {})
    }
    if (input.forkEntryId !== undefined && input.forkFrom === undefined) {
      throw new HelmError('validation_error', '指定 forkEntryId 时必须同时指定 forkFrom', 400, {})
    }

    let sourceConversationId: number | undefined
    if (input.forkFrom !== undefined) {
      const fromToken = input.forkFrom.trim()
      if (fromToken === 'coordinator') {
        sourceConversationId = group.coordinatorConversationId
      } else {
        const cleanFrom = fromToken.startsWith('@') ? fromToken.slice(1) : fromToken
        const peer = group.members.find((m) => m.name === cleanFrom)
        if (peer === undefined) {
          throw new HelmError('swarm_unknown_target', `forkFrom 目标成员 '${fromToken}' 不存在`, 404, {
            pluginId: SWARM_PLUGIN_ID,
            groupId: group.id,
            forkFrom: fromToken,
          })
        }
        sourceConversationId = peer.conversationId
      }
    }

    const sourceSummary = sourceConversationId !== undefined ? readConversationOrUndefined(sourceConversationId) : undefined
    const coordSummary = readConversationOrUndefined(group.coordinatorConversationId)
    const defaultProfile = sourceSummary?.profileId ?? coordSummary?.profileId ?? 'assistant'
    const targetProfile = input.profileId === undefined ? defaultProfile : assertProfileId(input.profileId)
    const profileRecord = await ctx.host.profiles.get(targetProfile)
    if (profileRecord === undefined) {
      throw new HelmError('validation_error', `Profile 不存在：${targetProfile}`, 400, { profileId: targetProfile })
    }
    if (profileRecord.humanSelectable === false) {
      throw new HelmError(
        'validation_error',
        `dispatch_worker 禁止使用系统内部 Profile '${targetProfile}'`,
        400,
        { profileId: targetProfile },
      )
    }

    const requestedCwd = input.cwd === undefined ? undefined : assertWorkerCwd(input.cwd)
    const explicitNodeId = input.nodeId === undefined ? undefined : assertWorkerNodeId(input.nodeId)
    const model = input.model !== undefined && input.model.trim() !== '' ? input.model.trim() : undefined
    const effort = input.effort !== undefined && input.effort.trim() !== '' ? input.effort.trim() : undefined

    const subscribedChannels = ['main']
    for (const rawCh of input.channels ?? []) {
      const chName = assertChannelName(rawCh)
      if (chName === 'main') continue
      const ch = group.channels.find((c) => c.name === chName)
      if (ch === undefined) {
        throw new HelmError('swarm_unknown_channel', `频道 '${chName}' 不存在`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: group.id,
          channel: chName,
        })
      }
      if (ch.archived === true) {
        throw new HelmError('swarm_channel_archived', `频道 '${chName}' 已归档，无法订阅`, 409, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: group.id,
          channel: chName,
        })
      }
      if (!subscribedChannels.includes(chName)) subscribedChannels.push(chName)
    }

    return enqueueDispatch(async () => {
      const freshGroup = groups.getGroup(group.id)
      if (freshGroup === undefined || freshGroup.status !== 'active') {
        throw new HelmError('swarm_group_closed', `协作组 '${group.id}' 已不可用或已结单`, 409, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: group.id,
        })
      }
      if (freshGroup.members.some((m) => m.name === memberName)) {
        throw new HelmError(
          'swarm_member_conflict',
          `协作组 '${freshGroup.id}' 中成员名 '${memberName}' 已被占用`,
          409,
          { pluginId: SWARM_PLUGIN_ID, groupId: freshGroup.id, name: memberName },
        )
      }
      const activeCount = freshGroup.members.filter((m) => m.lifecycle === 'active').length
      const maxMembers = getConfig().maxWorkersPerGroup
      if (activeCount >= maxMembers) {
        throw new HelmError(
          'swarm_group_member_limit',
          `协作组 '${freshGroup.id}' 活跃成员数已达上限 ${maxMembers}`,
          409,
          { pluginId: SWARM_PLUGIN_ID, groupId: freshGroup.id, maxWorkersPerGroup: maxMembers },
        )
      }

      const resolvedTarget = await ctx.host.resolveSpawnTarget({
        parentConversationId: freshGroup.coordinatorConversationId,
        profileId: targetProfile,
        ...(requestedCwd !== undefined ? { requestCwd: requestedCwd } : {}),
        ...(sourceConversationId !== undefined ? { fork: true } : {}),
      })
      let finalNodeId = explicitNodeId ?? resolvedTarget.nodeId
      let finalCwd = resolvedTarget.sourceCwd
      const workerTitle =
        input.title !== undefined && input.title.trim() !== ''
          ? input.title.trim().slice(0, 80)
          : `[${freshGroup.title}] @${memberName}`.slice(0, 80)

      const created =
        sourceConversationId !== undefined
          ? await ctx.host.forkConversation(sourceConversationId, {
              ...(input.forkEntryId !== undefined ? { entryId: input.forkEntryId } : {}),
              title: workerTitle,
            })
          : await ctx.host.createConversation({
              title: workerTitle,
              profileId: targetProfile,
              tags: [WORKER_TAG],
              parentConversationId: freshGroup.coordinatorConversationId,
              nodeId: finalNodeId,
              cwd: finalCwd,
              ...(model !== undefined ? { model } : {}),
            })

      let acquiredWorktreeId: string | undefined
      const now = Date.now()

      try {
        ctx.host.markConversationOwnership(created.id, 'helm')
        if (sourceConversationId !== undefined || effort !== undefined) {
          await ctx.host.updateConversation(created.id, {
            profileId: targetProfile,
            tags: [WORKER_TAG],
            nodeId: finalNodeId,
            cwd: finalCwd,
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { thinkingLevel: effort } : {}),
          })
        }

        if (isolation === 'worktree') {
          const wt = (await ctx.host.invokeAction(
            WORKFLOW_PLUGIN_ID,
            'acquire_worktree',
            {
              conversationId: created.id,
              parentConversationId: freshGroup.coordinatorConversationId,
              profileId: targetProfile,
              ...(requestedCwd !== undefined ? { requestCwd: requestedCwd } : {}),
              ...(sourceConversationId !== undefined ? { fork: true } : {}),
              hold: {
                pluginId: SWARM_PLUGIN_ID,
                holdId: `${freshGroup.id}:${memberName}`,
                label: `Swarm group "${freshGroup.title}" (${freshGroup.id}) member @${memberName} (#${created.id})`,
              },
            },
            signal !== undefined ? { signal } : undefined,
          )) as WorkflowAcquireResultShape
          acquiredWorktreeId = wt.worktreeId
          finalCwd = wt.path
          finalNodeId = wt.nodeId
          await ctx.host.updateConversation(created.id, {
            cwd: wt.path,
            nodeId: wt.nodeId,
          })
        }

        const { post } = await groups.addMemberWithBrief(
          freshGroup.id,
          {
            name: memberName,
            conversationId: created.id,
            profileId: targetProfile,
            access,
            isolation,
            nodeId: finalNodeId,
            cwd: finalCwd,
            ...(acquiredWorktreeId !== undefined ? { worktreeId: acquiredWorktreeId } : {}),
            channels: subscribedChannels,
            lifecycle: 'active',
            createdAt: now,
          },
          input.prompt,
        )

        return {
          workerConversationId: created.id,
          groupId: freshGroup.id,
          name: memberName,
          ...(acquiredWorktreeId !== undefined ? { worktreeId: acquiredWorktreeId } : {}),
          postSeq: post.seq,
        }
      } catch (err) {
        reportError(`协作组 ${freshGroup.id} 成员 @${memberName} (#${created.id}) 派工失败，执行回滚`, err)
        if (acquiredWorktreeId !== undefined) {
          await releaseWorktreeHold(ctx, freshGroup.id, memberName, acquiredWorktreeId).catch(() => {})
          await cleanupManagedWorktree(ctx, acquiredWorktreeId, true).catch(() => {})
        }
        const freshConv = readConversationOrUndefined(created.id)
        if (freshConv !== undefined) {
          const nextTags = [...freshConv.tags.filter((t) => t !== WORKER_TAG && t !== COORDINATOR_TAG), ARCHIVED_WORKER_TAG]
          await ctx.host.updateConversation(created.id, { tags: nextTags }).catch(() => {})
        }
        throw err
      }
    })
  }

  // ------------------------------------------------------------------
  // 3. board_post / board_read / board_status
  // ------------------------------------------------------------------
  const boardPost = async (
    input: {
      groupId?: string
      to: string[]
      kind: BoardPostKind
      body: string
      channel?: string
      wake?: boolean
      refs?: number[]
      from?: string
    },
    conversationId: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ post: BoardPost }> => {
    if (typeof input.body !== 'string' || input.body.trim() === '') {
      throw new HelmError('validation_error', 'board_post.body 必须是非空文本', 400, {})
    }
    const kind = assertBoardPostKind(input.kind)
    if (kind === 'stall') {
      throw new HelmError('validation_error', "kind='stall' 为系统保留静默告警类型，禁止手动发布", 400, {})
    }

    let group: CollabGroupRecord | undefined
    let caller: BoardCallerIdentity
    let senderMember: GroupMemberState | undefined

    if (conversationId !== undefined) {
      const participant = groups.findGroupByParticipant(conversationId)
      if (participant === undefined) {
        throw new HelmError(
          'conversation_scope_violation',
          `当前会话 #${conversationId} 未关联任何活跃协作组`,
          403,
          { pluginId: SWARM_PLUGIN_ID, conversationId },
        )
      }
      if (input.groupId !== undefined && assertGroupId(input.groupId) !== participant.group.id) {
        throw new HelmError(
          'conversation_scope_violation',
          `会话 #${conversationId} 属于协作组 '${participant.group.id}'，无权写入 '${input.groupId}'`,
          403,
          { pluginId: SWARM_PLUGIN_ID, conversationId, groupId: input.groupId },
        )
      }
      group = participant.group
      if (participant.role === 'worker') {
        senderMember = participant.member
        if (input.from !== undefined && input.from.trim() !== '' && input.from.trim() !== senderMember.name) {
          throw new HelmError(
            'conversation_scope_violation',
            `成员 @${senderMember.name} 禁止伪造发帖身份 '${input.from}'`,
            403,
            { from: input.from, expectedFrom: senderMember.name },
          )
        }
        caller = { role: 'worker', from: senderMember.name }
      } else {
        if (input.from !== undefined && input.from.trim() !== '' && input.from.trim() !== 'coordinator') {
          throw new HelmError('conversation_scope_violation', '主控会话发帖身份固定为 coordinator', 403, {
            from: input.from,
          })
        }
        caller = { role: 'coordinator', from: 'coordinator' }
      }
    } else {
      if (input.groupId !== undefined && input.groupId.trim() !== '') {
        group = groups.getGroup(assertGroupId(input.groupId))
      }
      if (group === undefined) {
        throw new HelmError('swarm_group_not_found', '未找到活跃协作组；人工调用请显式指定 groupId', 404, {
          pluginId: SWARM_PLUGIN_ID,
        })
      }
      const explicitFrom = input.from !== undefined && input.from.trim() !== '' ? input.from.trim() : 'coordinator'
      if (explicitFrom !== 'coordinator') {
        throw new HelmError('validation_error', "人工直连发帖的 from 仅允许省略或传 'coordinator'", 400, {
          from: explicitFrom,
        })
      }
      caller = { role: 'human', from: 'coordinator' }
    }

    if (group.status !== 'active') {
      throw new HelmError('swarm_group_closed', `协作组 '${group.id}' 已结单，无法追加黑板消息`, 409, {
        pluginId: SWARM_PLUGIN_ID,
        groupId: group.id,
      })
    }

    const channel = resolvePostChannel(group, input.channel)
    const { normalizedTo, resolvedTargets } = resolveBoardTargets(group, caller, input.to)
    if (input.wake !== undefined && typeof input.wake !== 'boolean') {
      throw new HelmError('validation_error', 'wake 必须是布尔值', 400, {})
    }
    const wake = input.wake ?? resolveDefaultWake(kind, normalizedTo)

    const refs: number[] = []
    if (input.refs !== undefined) {
      if (!Array.isArray(input.refs)) {
        throw new HelmError('validation_error', 'refs 必须是正整数数组', 400, {})
      }
      for (const ref of input.refs) {
        if (!isPosIntId(ref) || ref > group.headSeq) {
          throw new HelmError(
            'validation_error',
            `refs 含不存在的黑板序号 #${String(ref)}（当前 headSeq=${group.headSeq}）`,
            400,
            { ref, headSeq: group.headSeq },
          )
        }
        if (!refs.includes(ref)) refs.push(ref)
      }
    }

    let worktreeSnapshot: WorktreeHandoffSnapshot | undefined
    if (senderMember?.worktreeId !== undefined && (kind === 'handoff' || kind === 'done')) {
      const inspected = await inspectManagedWorktree(ctx, senderMember.worktreeId, signal)
      worktreeSnapshot = toWorktreeHandoffSnapshot(senderMember.worktreeId, inspected)
    }

    const post = await groups.appendPost(group.id, {
      channel,
      from: caller.from,
      to: normalizedTo,
      resolvedTargets,
      wake,
      kind,
      refs,
      body: input.body.trim(),
      ...(worktreeSnapshot !== undefined ? { worktreeSnapshot } : {}),
    })

    return { post }
  }

  const resolveReadableGroup = (
    explicitGroupId: string | undefined,
    conversationId: number | undefined,
  ): CollabGroupRecord => {
    if (explicitGroupId !== undefined && explicitGroupId.trim() !== '') {
      const validId = assertGroupId(explicitGroupId)
      const group = groups.getGroup(validId)
      if (group === undefined) {
        throw new HelmError('swarm_group_not_found', `协作组 '${validId}' 不存在`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: validId,
        })
      }
      if (conversationId !== undefined) {
        const isParticipant =
          group.coordinatorConversationId === conversationId ||
          group.members.some((m) => m.conversationId === conversationId)
        if (!isParticipant) {
          throw new HelmError(
            'conversation_scope_violation',
            `会话 #${conversationId} 不属于协作组 '${group.id}'`,
            403,
            { pluginId: SWARM_PLUGIN_ID, conversationId, groupId: group.id },
          )
        }
      }
      return group
    }

    if (conversationId !== undefined) {
      const found = groups.findLatestGroupForConversation(conversationId)
      if (found !== undefined) return found
    }
    throw new HelmError('swarm_group_not_found', '未找到关联协作组；请显式传入 groupId', 404, {
      pluginId: SWARM_PLUGIN_ID,
    })
  }

  const boardRead = async (
    input: {
      groupId?: string
      channel?: string
      sinceSeq?: number
      seqs?: number[]
      limit?: number
    },
    conversationId: number | undefined,
  ): Promise<{ groupId: string; headSeq: number; posts: BoardPost[] }> => {
    const group = resolveReadableGroup(input.groupId, conversationId)
    const allPosts = groups.getPosts(group.id)

    if (input.seqs !== undefined) {
      if (!Array.isArray(input.seqs) || !input.seqs.every((s) => isPosIntId(s))) {
        throw new HelmError('validation_error', 'seqs 必须是正整数数组', 400, {})
      }
      const wanted = new Set(input.seqs)
      const posts = allPosts.filter((p) => wanted.has(p.seq))
      return { groupId: group.id, headSeq: group.headSeq, posts }
    }

    let filtered = allPosts
    if (input.channel !== undefined && input.channel.trim() !== '') {
      const chName = input.channel.trim()
      if (!group.channels.some((c) => c.name === chName)) {
        throw new HelmError('swarm_unknown_channel', `未知频道 '${chName}'`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: group.id,
          channel: chName,
        })
      }
      filtered = filtered.filter((p) => p.channel === chName)
    }

    const limit = input.limit === undefined ? 50 : input.limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0 || limit > 200) {
      throw new HelmError('validation_error', `limit 必须是 1..200 整数（收到：${String(input.limit)}）`, 400, {})
    }

    if (input.sinceSeq !== undefined) {
      if (typeof input.sinceSeq !== 'number' || !Number.isInteger(input.sinceSeq) || input.sinceSeq < 0) {
        throw new HelmError('validation_error', `sinceSeq 必须是非负整数（收到：${String(input.sinceSeq)}）`, 400, {})
      }
      const after = filtered.filter((p) => p.seq > input.sinceSeq!)
      return { groupId: group.id, headSeq: group.headSeq, posts: after.slice(0, limit) }
    }

    return { groupId: group.id, headSeq: group.headSeq, posts: filtered.slice(-limit) }
  }

  const boardStatus = async (
    input: { groupId?: string },
    conversationId: number | undefined,
  ): Promise<BoardViewDoc> => {
    const group = resolveReadableGroup(input.groupId, conversationId)
    return groups.buildBoardView(group.id)
  }

  // ------------------------------------------------------------------
  // 4. abort_worker / switch_worker_model / inspect_worker / archive_worker / close_group
  // ------------------------------------------------------------------
  const abortWorker = async (
    input: { groupId?: string; name?: string; workerConversationId?: number },
    conversationId: number | undefined,
  ): Promise<{ aborted: boolean; workerConversationId: number; name: string }> => {
    const { group, member, workerConversationId } = resolveTargetWorker(input, conversationId)
    assertCoordinatorAuthority(conversationId, group)

    const summary = readConversationOrUndefined(workerConversationId)
    if (summary === undefined) {
      throw new HelmError('not_found', `会话 #${workerConversationId} 不存在`, 404, {
        workerConversationId,
      })
    }
    if (summary.status !== 'working' && summary.status !== 'blocked') {
      return { aborted: false, workerConversationId, name: member.name }
    }

    await ctx.host.abortConversationGuarded(workerConversationId, { expectedOwnership: 'helm' })
    groups.syncProjections()
    return { aborted: true, workerConversationId, name: member.name }
  }

  const switchWorkerModel = async (
    input: { groupId?: string; name?: string; workerConversationId?: number; model: string },
    conversationId: number | undefined,
  ): Promise<{ workerConversationId: number; model: string; name: string }> => {
    if (typeof input.model !== 'string' || input.model.trim() === '') {
      throw new HelmError('validation_error', 'model 必须是非空字符串（格式 provider/model）', 400, {})
    }
    const { group, member, workerConversationId } = resolveTargetWorker(input, conversationId)
    assertCoordinatorAuthority(conversationId, group)
    if (member.lifecycle !== 'active') {
      throw new HelmError('swarm_unknown_target', `成员 @${member.name} 已归档，无法切换模型`, 409, {
        pluginId: SWARM_PLUGIN_ID,
        groupId: group.id,
        name: member.name,
      })
    }

    const summary = readConversationOrUndefined(workerConversationId)
    if (summary === undefined) {
      throw new HelmError('not_found', `会话 #${workerConversationId} 不存在`, 404, {
        workerConversationId,
      })
    }
    if (isWorkerBusy(workerConversationId, summary.status)) {
      throw new HelmError(
        'swarm_worker_busy',
        `成员 @${member.name} (#${workerConversationId}) 当前仍在运行中（${summary.status}）；请先等待完成或调用 abort_worker 刹停后再切换模型`,
        409,
        { pluginId: SWARM_PLUGIN_ID, workerConversationId, name: member.name, status: summary.status },
      )
    }

    const updated = await ctx.host.updateConversation(workerConversationId, { model: input.model.trim() })
    groups.syncProjections()
    return {
      workerConversationId: updated.id,
      model: updated.model,
      name: member.name,
    }
  }

  const inspectWorker = async (
    input: { workerConversationId?: number; groupId?: string; name?: string },
    conversationId: number | undefined,
  ): Promise<Record<string, unknown>> => {
    const { group, member, workerConversationId } = resolveTargetWorker(input, conversationId)
    if (conversationId !== undefined) {
      const isParticipant =
        group.coordinatorConversationId === conversationId ||
        group.members.some((m) => m.conversationId === conversationId && m.lifecycle === 'active')
      if (!isParticipant) {
        throw new HelmError(
          'conversation_scope_violation',
          `当前会话 #${conversationId} 无权检视协作组 '${group.id}' 成员`,
          403,
          { pluginId: SWARM_PLUGIN_ID, conversationId, groupId: group.id },
        )
      }
    }

    const detail = await ctx.host.getConversationDetail(workerConversationId, { limit: 20 })
    const artifacts = await ctx.host.listArtifacts(workerConversationId)
    const summaries = recentEntrySummaries(ctx.host, detail.entries)
    return {
      conversationId: detail.id,
      groupId: group.id,
      name: member.name,
      ...(member.worktreeId !== undefined ? { worktreeId: member.worktreeId } : {}),
      title: detail.title,
      profileId: detail.profileId,
      status: detail.status,
      doing: detail.doing ?? null,
      completionSeq: detail.completionSeq,
      artifacts: artifacts.map((a) => ({ id: a.id, name: a.name, size: a.size })),
      recentEntries: summaries,
    }
  }

  const archiveWorker = async (
    input: {
      workerConversationId?: number
      groupId?: string
      name?: string
      keepWorktree?: boolean
      force?: boolean
    },
    conversationId: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ archived: true; workerConversationId: number }> => {
    const { group, member, workerConversationId } = resolveTargetWorker(input, conversationId)
    assertCoordinatorAuthority(conversationId, group)
    if (member.lifecycle === 'archived') {
      return { archived: true, workerConversationId }
    }
    const summary = readConversationOrUndefined(workerConversationId)
    if (summary !== undefined && isWorkerBusy(workerConversationId, summary.status)) {
      throw new HelmError(
        'swarm_worker_busy',
        `成员 @${member.name} (#${workerConversationId}) 当前正在运行或结算，拒绝归档（请先 abort_worker 或等待结束）`,
        409,
        { pluginId: SWARM_PLUGIN_ID, workerConversationId, name: member.name, status: summary.status },
      )
    }

    return enqueueDispatch(async () => {
      const freshSummary = readConversationOrUndefined(workerConversationId)
      if (freshSummary !== undefined && isWorkerBusy(workerConversationId, freshSummary.status)) {
        throw new HelmError(
          'swarm_worker_busy',
          `成员 @${member.name} (#${workerConversationId}) 已进入运行，拒绝归档`,
          409,
          { pluginId: SWARM_PLUGIN_ID, workerConversationId, name: member.name, status: freshSummary.status },
        )
      }

      const wtCheck = await checkMemberWorktree(ctx, member, signal)
      if (wtCheck !== undefined) {
        if (input.keepWorktree === true) {
          await releaseWorktreeHold(ctx, group.id, member.name, wtCheck.worktreeId, signal)
        } else {
          if (input.force !== true && wtCheck.inspected.exists && (wtCheck.isDirty || wtCheck.unmergedCommits > 0)) {
            throw new HelmError(
              'swarm_worktree_unmerged',
              `成员 @${member.name} 的工作树 ${wtCheck.worktreeId} (branch: ${wtCheck.inspected.currentBranch ?? wtCheck.inspected.record.branch}) 存在未提交改动(${wtCheck.inspected.dirtyFileCount})或未合入提交(${wtCheck.unmergedCommits})；请先合入或传 keepWorktree: true / force: true`,
              409,
              {
                pluginId: SWARM_PLUGIN_ID,
                groupId: group.id,
                memberName: member.name,
                worktreeId: wtCheck.worktreeId,
                branch: wtCheck.inspected.currentBranch ?? wtCheck.inspected.record.branch,
                path: wtCheck.inspected.record.path,
                dirtyCount: wtCheck.inspected.dirtyFileCount,
                commitsAhead: wtCheck.unmergedCommits,
              },
            )
          }
          await releaseWorktreeHold(ctx, group.id, member.name, wtCheck.worktreeId, signal)
          if (wtCheck.inspected.exists) {
            await cleanupManagedWorktree(ctx, wtCheck.worktreeId, input.force === true, signal)
          }
        }
      }

      if (freshSummary !== undefined) {
        const nextTags = [...freshSummary.tags.filter((t) => t !== WORKER_TAG), ARCHIVED_WORKER_TAG]
        await ctx.host.updateConversation(workerConversationId, { tags: nextTags })
      }

      await groups.mutateGroup(group.id, (draft) => {
        const target = draft.members.find((m) => m.name === member.name)
        if (target !== undefined) {
          target.lifecycle = 'archived'
          target.archivedAt = Date.now()
        }
        draft.updatedAt = Date.now()
        return { group: draft, result: undefined }
      })

      return { archived: true, workerConversationId }
    })
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
    const group = resolveCoordinatorGroup(input.groupId, conversationId, false)
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
        throw new HelmError('swarm_group_not_found', `协作组 '${group.id}' 不存在`, 404, {
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
        if (s === undefined || !isWorkerBusy(member.conversationId, s.status)) continue
        if (input.abortRunning === true) {
          if (s.status === 'working' || s.status === 'blocked') {
            await ctx.host.abortConversationGuarded(member.conversationId, { expectedOwnership: 'helm' })
          }
          continue
        }
        throw new HelmError(
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
          throw new HelmError(
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

      for (const member of activeMembers) {
        const s = readConversationOrUndefined(member.conversationId)
        if (s !== undefined) {
          const nextTags = [...s.tags.filter((t) => t !== WORKER_TAG), ARCHIVED_WORKER_TAG]
          await ctx.host.updateConversation(member.conversationId, { tags: nextTags })
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

      const coordConv = readConversationOrUndefined(freshGroup.coordinatorConversationId)
      if (coordConv !== undefined && coordConv.tags.includes(COORDINATOR_TAG)) {
        // 结单后将活跃主控 tag 原地替换为历史 tag：workbench 编排面板仍可访问已完成编组，
        // 但 swarm_create_group 解锁与工具注入按活跃组判定不再复活。
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

  // ------------------------------------------------------------------
  // 5. Web 输入区 @ / # 幂等补全源动作（cli.hidden = true）
  // ------------------------------------------------------------------
  const completeBoardMembers = (
    input: { query?: string; conversationId?: number },
    contextConversationId: number | undefined,
  ): { items: Array<{ id: string; label: string; insertText: string; hint?: string; icon?: string }> } => {
    const targetConvId = input.conversationId ?? contextConversationId
    if (targetConvId === undefined) return { items: [] }
    const participant = groups.findGroupByParticipant(targetConvId)
    if (participant === undefined) return { items: [] }

    const q = (input.query ?? '').trim().replace(/^@+/, '').toLowerCase()
    const items: Array<{ id: string; label: string; insertText: string; hint?: string; icon?: string }> = []

    if (participant.role === 'worker') {
      items.push({
        id: 'coordinator',
        label: '@coordinator',
        insertText: '@coordinator ',
        hint: 'Group coordinator',
        icon: 'shield',
      })
    } else {
      items.push({
        id: 'all',
        label: '@all',
        insertText: '@all ',
        hint: 'Broadcast to all active members',
        icon: 'users',
      })
    }

    for (const m of participant.group.members) {
      if (m.lifecycle !== 'active') continue
      if (participant.role === 'worker' && m.name === participant.member.name) continue
      items.push({
        id: m.name,
        label: `@${m.name}`,
        insertText: `@${m.name} `,
        hint: `${m.profileId} · ${m.access} · ${m.isolation}`,
        icon: 'bot',
      })
    }

    return {
      items:
        q === ''
          ? items
          : items.filter((item) => `${item.id}\n${item.label}\n${item.hint ?? ''}`.toLowerCase().includes(q)),
    }
  }

  const completeBoardChannels = (
    input: { query?: string; conversationId?: number },
    contextConversationId: number | undefined,
  ): { items: Array<{ id: string; label: string; insertText: string; hint?: string; icon?: string }> } => {
    const targetConvId = input.conversationId ?? contextConversationId
    if (targetConvId === undefined) return { items: [] }
    const participant = groups.findGroupByParticipant(targetConvId)
    if (participant === undefined) return { items: [] }

    const q = (input.query ?? '').trim().replace(/^#+/, '').toLowerCase()
    const items = participant.group.channels
      .filter((c) => c.name !== 'main' && c.archived !== true)
      .map((c) => ({
        id: c.name,
        label: `#${c.name}`,
        insertText: `#${c.name} `,
        ...(c.topic !== undefined ? { hint: c.topic } : {}),
        icon: 'hash',
      }))

    return {
      items:
        q === ''
          ? items
          : items.filter((item) => `${item.id}\n${item.label}\n${item.hint ?? ''}`.toLowerCase().includes(q)),
    }
  }

  // ------------------------------------------------------------------
  // ctx.tool（统一 swarm_ 前缀，避免与 builtin:superagent 或外部插件全局工具名冲突）
  // ------------------------------------------------------------------
  ctx.tool({
    name: 'swarm_create_group',
    description:
      'Start an active peer swarm collaboration board on the current top-level conversation, tagging it swarm-coordinator and unlocking squad tools on the next step.',
    inputSchema: createGroupInputSchema,
    execute: (input: never, context: PluginToolContext) =>
      createGroup(input as Parameters<typeof createGroup>[0], context.conversationId),
  })

  ctx.tool({
    name: 'swarm_update_group',
    description: 'Update the active swarm collaboration group title or objective.',
    inputSchema: updateGroupInputSchema,
    scope: COORDINATOR_SCOPE,
    execute: (input: never, context: PluginToolContext) =>
      updateGroup(input as Parameters<typeof updateGroup>[0], context.conversationId),
  })

  ctx.tool({
    name: 'swarm_dispatch_worker',
    description:
      'Recruit a named peer role into the active swarm collaboration group with optional worktree isolation and clean-anchor conversation forking.',
    inputSchema: dispatchInputSchema,
    scope: COORDINATOR_SCOPE,
    execute: (input: never, context: PluginToolContext) =>
      dispatchWorker(input as DispatchInput, context.conversationId, context.signal),
  })

  ctx.tool({
    name: 'swarm_board_post',
    description:
      'Publish a structured message on the swarm collaboration board with deterministic target resolution and orthogonal wake control (handoff and done posts from worktree members automatically attach a worktree snapshot).',
    inputSchema: boardPostInputSchema,
    scope: PARTICIPANT_SCOPE,
    execute: (input: never, context: PluginToolContext) =>
      boardPost(input as Parameters<typeof boardPost>[0], context.conversationId, context.signal),
  })

  ctx.tool({
    name: 'swarm_board_read',
    description: 'Read swarm collaboration board posts by channel, sinceSeq, or exact seqs.',
    inputSchema: boardReadInputSchema,
    scope: PARTICIPANT_SCOPE,
    replay: 'safe',
    execute: (input: never, context: PluginToolContext) =>
      boardRead(input as Parameters<typeof boardRead>[0], context.conversationId),
  })

  ctx.tool({
    name: 'swarm_board_status',
    description:
      'Inspect live swarm collaboration group status, member cursors and live states, activeWorkingMembers, handoff edges, and retained worktrees.',
    inputSchema: boardStatusInputSchema,
    scope: PARTICIPANT_SCOPE,
    replay: 'safe',
    execute: (input: never, context: PluginToolContext) =>
      boardStatus(input as { groupId?: string }, context.conversationId),
  })

  ctx.tool({
    name: 'swarm_abort_worker',
    description:
      'Stop an in-flight swarm worker turn in place while preserving its conversation history and managed worktree hold for follow-up correction.',
    inputSchema: workerIdInputSchema,
    scope: COORDINATOR_SCOPE,
    execute: (input: never, context: PluginToolContext) =>
      abortWorker(input as Parameters<typeof abortWorker>[0], context.conversationId),
  })

  ctx.tool({
    name: 'swarm_switch_worker_model',
    description: 'Switch an idle swarm worker conversation to another model in place while preserving its conversation history.',
    inputSchema: switchModelInputSchema,
    scope: COORDINATOR_SCOPE,
    execute: (input: never, context: PluginToolContext) =>
      switchWorkerModel(input as Parameters<typeof switchWorkerModel>[0], context.conversationId),
  })

  ctx.tool({
    name: 'swarm_inspect_worker',
    description: "Read a swarm worker's recent timeline summary, artifact list, and bound worktreeId.",
    inputSchema: workerIdInputSchema,
    scope: PARTICIPANT_SCOPE,
    replay: 'safe',
    execute: (input: never, context: PluginToolContext) =>
      inspectWorker(input as Parameters<typeof inspectWorker>[0], context.conversationId),
  })

  ctx.tool({
    name: 'swarm_archive_worker',
    description: 'Archive an idle swarm worker (verifying worktree merge safety and releasing worktree holds when applicable).',
    inputSchema: archiveWorkerInputSchema,
    scope: COORDINATOR_SCOPE,
    execute: (input: never, context: PluginToolContext) =>
      archiveWorker(input as Parameters<typeof archiveWorker>[0], context.conversationId, context.signal),
  })

  ctx.tool({
    name: 'swarm_close_group',
    description:
      'Close the swarm collaboration group in full-cleanup mode or retain-branches mode (keepWorktree: true releases holds and preserves modified branches in retainedWorktrees).',
    inputSchema: closeGroupInputSchema,
    scope: COORDINATOR_SCOPE,
    execute: (input: never, context: PluginToolContext) =>
      closeGroup(input as Parameters<typeof closeGroup>[0], context.conversationId, context.signal),
  })

  // ------------------------------------------------------------------
  // ctx.action（HTTP / CLI / Workflow / Web 五端同源复用，exposeAsTool: false）
  // ------------------------------------------------------------------
  ctx.action({
    id: 'create_group',
    description: 'Create an active swarm collaboration group on a top-level conversation.',
    exposeAsTool: false,
    cli: { command: ['swarm', 'create-group'], description: 'Create an active swarm collaboration group' },
    inputSchema: createGroupInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: Parameters<typeof createGroup>[0], context) => createGroup(input, context.conversationId),
  })

  ctx.action({
    id: 'update_group',
    description: 'Update swarm collaboration group metadata.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'update-group'], description: 'Update swarm collaboration group metadata' },
    inputSchema: updateGroupInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: Parameters<typeof updateGroup>[0], context) => updateGroup(input, context.conversationId),
  })

  ctx.action({
    id: 'manage_channel',
    description: 'Create, subscribe, unsubscribe, or archive swarm collaboration group subchannels.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'channel'], description: 'Manage swarm collaboration group subchannels' },
    inputSchema: manageChannelInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: Parameters<typeof manageChannel>[0], context) => manageChannel(input, context.conversationId),
  })

  ctx.action({
    id: 'dispatch_worker',
    description: 'Recruit a named peer worker role into an active swarm collaboration group.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'dispatch-worker'], description: 'Recruit a named swarm peer worker' },
    inputSchema: dispatchInputSchema,
    outputSchema: {
      type: 'object',
      properties: {
        workerConversationId: { type: 'number' },
        groupId: { type: 'string' },
        name: { type: 'string' },
        worktreeId: { type: 'string' },
        postSeq: { type: 'number' },
      },
      required: ['workerConversationId', 'groupId', 'name', 'postSeq'],
      additionalProperties: false,
    },
    handler: (input: DispatchInput, context) => dispatchWorker(input, context.conversationId, context.signal),
  })

  ctx.action({
    id: 'board_post',
    description: 'Publish a structured post to the swarm collaboration board.',
    exposeAsTool: false,
    scope: PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'board-post'], description: 'Publish a post to the swarm collaboration board' },
    inputSchema: boardPostInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: Parameters<typeof boardPost>[0], context) =>
      boardPost(input, context.conversationId, context.signal),
  })

  ctx.action({
    id: 'board_read',
    description: 'Read posts from the swarm collaboration board.',
    exposeAsTool: false,
    idempotent: true,
    scope: PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'board-read'], description: 'Read posts from the swarm collaboration board' },
    inputSchema: boardReadInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: Parameters<typeof boardRead>[0], context) => boardRead(input, context.conversationId),
  })

  ctx.action({
    id: 'board_status',
    description: 'Inspect swarm collaboration group board status, members, edges, and retained worktrees.',
    exposeAsTool: false,
    idempotent: true,
    scope: PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'board-status'], description: 'Inspect swarm collaboration group board status' },
    inputSchema: boardStatusInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: { groupId?: string }, context) => boardStatus(input, context.conversationId),
  })

  ctx.action({
    id: 'abort_worker',
    description: 'Abort an in-flight swarm worker turn in place while preserving conversation history and worktree hold.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'abort-worker'], description: 'Abort an in-flight swarm worker turn in place' },
    inputSchema: workerIdInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: Parameters<typeof abortWorker>[0], context) => abortWorker(input, context.conversationId),
  })

  ctx.action({
    id: 'switch_worker_model',
    description: 'Switch an idle swarm worker conversation to another model in place.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'switch-model'], description: 'Switch an idle swarm worker conversation model' },
    inputSchema: switchModelInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: Parameters<typeof switchWorkerModel>[0], context) => switchWorkerModel(input, context.conversationId),
  })

  ctx.action({
    id: 'inspect_worker',
    description: "Read a swarm worker's recent timeline summary, artifact list, and bound worktreeId.",
    exposeAsTool: false,
    idempotent: true,
    scope: PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'inspect-worker'], description: 'Inspect a swarm worker' },
    inputSchema: workerIdInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: Parameters<typeof inspectWorker>[0], context) => inspectWorker(input, context.conversationId),
  })

  ctx.action({
    id: 'archive_worker',
    description: 'Archive an idle swarm worker: releases worktree holds and swaps swarm-worker tag for swarm-worker-archived.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'archive-worker'], description: 'Archive an idle swarm worker' },
    inputSchema: archiveWorkerInputSchema,
    outputSchema: {
      type: 'object',
      properties: {
        archived: { type: 'boolean' },
        workerConversationId: { type: 'number' },
      },
      required: ['archived', 'workerConversationId'],
      additionalProperties: false,
    },
    handler: (input: Parameters<typeof archiveWorker>[0], context) =>
      archiveWorker(input, context.conversationId, context.signal),
  })

  ctx.action({
    id: 'close_group',
    description: 'Close a swarm collaboration group in full-cleanup mode or unlock-merge mode (keepWorktree: true).',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'close-group'], description: 'Close a swarm collaboration group' },
    inputSchema: closeGroupInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: Parameters<typeof closeGroup>[0], context) =>
      closeGroup(input, context.conversationId, context.signal),
  })

  ctx.action({
    id: 'complete_board_members',
    description: 'List mentionable swarm collaboration board roles for composer @ completion.',
    exposeAsTool: false,
    idempotent: true,
    scope: PARTICIPANT_SCOPE,
    cli: { hidden: true },
    inputSchema: completerInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: { query?: string; conversationId?: number }, context) =>
      completeBoardMembers(input, context.conversationId),
  })

  ctx.action({
    id: 'complete_board_channels',
    description: 'List active swarm collaboration board subchannels for composer # completion.',
    exposeAsTool: false,
    idempotent: true,
    scope: PARTICIPANT_SCOPE,
    cli: { hidden: true },
    inputSchema: completerInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: { query?: string; conversationId?: number }, context) =>
      completeBoardChannels(input, context.conversationId),
  })
}
