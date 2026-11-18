import { HelmError, type HelmPluginContext } from '@helm/protocol'
import {
  SWARM_PLUGIN_ID,
  assertBoardPostKind,
  assertGroupId,
  isPosIntId,
  type BoardPost,
  type BoardPostKind,
  type BoardViewDoc,
  type CollabGroupRecord,
  type GroupMemberState,
  type SwarmCoordinator,
  type WorktreeHandoffSnapshot,
} from './contracts.js'
import {
  resolveBoardTargets,
  resolveDefaultWake,
  resolvePostChannel,
  type BoardCallerIdentity,
} from './board-router.js'
import { inspectManagedWorktree, toWorktreeHandoffSnapshot } from './worktree-bridge.js'

export function createBoardHandlers(ctx: HelmPluginContext, coordinator: SwarmCoordinator) {
  const { groups } = coordinator

  const boardPost = async (
    input: {
      groupId?: string
      to: string[]
      kind: BoardPostKind
      body: string
      channel?: string
      wake?: boolean
      refs?: number[]
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
        caller = { role: 'worker', from: senderMember.name }
      } else {
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
    const allPosts = await groups.ensurePostsLoaded(group.id)

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
    await groups.ensurePostsLoaded(group.id)
    return groups.buildBoardView(group.id)
  }

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

  return {
    boardPost,
    boardRead,
    boardStatus,
    completeBoardMembers,
    completeBoardChannels,
  }
}
