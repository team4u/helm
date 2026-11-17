import { escapeXml, type HelmPluginContext } from '@helm/protocol'
import {
  ACTIVE_SWARM_GROUP_SECTION_ID,
  ARCHIVED_WORKER_TAG,
  COORDINATOR_BLOCKED_TOOL_NAMES,
  COORDINATOR_TAG,
  READONLY_WORKER_BLOCKED_TOOL_NAMES,
  SWARM_PLUGIN_ID,
  WORKER_TAG,
  type SwarmCoordinator,
  type WorkerAccess,
  type WorkerIsolation,
} from './contracts.js'
import { collectMemberLastReplySummary } from './settlement.js'

/** 100% 字节恒定的协作组主控系统提示词段（仅含创建后永不变更的 groupId 与静态协作铁律，零可变成员列表或状态）。 */
export function activeSwarmGroupCoordinatorSection(groupId: string): string {
  return [
    `<active_swarm_group id="${escapeXml(groupId)}" role="coordinator">`,
    '1. Recruit named peer workers via swarm_dispatch_worker (use isolation="worktree" for parallel writers and access="readonly" for verifiers).',
    '2. Coordinate handoffs via swarm_board_post / swarm_board_read / swarm_board_status using #seq pointers in refs without copy-pasting diffs or long reports.',
    '3. Keep wake=true strictly for the next actor who must act; never close the group while activeWorkingMembers is non-empty.',
    '4. When all slices pass verification and worktree branches await merging, call swarm_close_group({ keepWorktree: true }) to unlock bash and merge cleanly.',
    '</active_swarm_group>',
  ].join('\n')
}

/** 100% 字节恒定的协作组对等成员系统提示词段（仅含该成员生命周期内恒定不变的身份属性与协作铁律）。 */
export function activeSwarmGroupWorkerSection(
  groupId: string,
  memberName: string,
  access: WorkerAccess,
  isolation: WorkerIsolation,
): string {
  return [
    `<active_swarm_group id="${escapeXml(groupId)}" role="worker" name="${escapeXml(memberName)}" access="${access}" isolation="${isolation}">`,
    '1. Always publish your task outcome via swarm_board_post (handoff / review / done / blocker, citing #seq in refs) before ending an actionable turn; never exit silently.',
    '2. Set wake=true only for the next peer who must act (or coordinator on final done / unresolvable blocker); never post pure acknowledgments.',
    '3. Reference prior board items by #seq instead of copying diffs or full reports.',
    ...(access === 'readonly'
      ? ['4. Your access is readonly: run tests and checks via bash, inspect diffs, and post review/done/blocker via swarm_board_post without modifying files.']
      : []),
    '</active_swarm_group>',
  ].join('\n')
}

function collectNonIdempotentDirectToolNames(ctx: HelmPluginContext): Set<string> {
  const blocked = new Set<string>()
  for (const manifest of ctx.host.listActions()) {
    if (manifest.exposeAsTool === true && manifest.idempotent !== true) {
      blocked.add(manifest.id)
      blocked.add(`${manifest.pluginId.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}_${manifest.id}`)
    }
  }
  return blocked
}

export function registerSwarmHooks(
  ctx: HelmPluginContext,
  coordinator: SwarmCoordinator,
): void {
  const {
    isActive,
    readConversationOrUndefined,
    groups,
    settlingWorkers,
  } = coordinator

  // ------------------------------------------------------------------
  // before_turn：互斥工具裁剪 + 恒定 sections 注入（零破 Cache）
  // ------------------------------------------------------------------
  ctx.hook.onBeforeTurn((turn) => {
    if (!isActive()) return
    const conv = turn.conversation
    const activeCoordGroup = groups.findActiveGroupByCoordinator(conv.id)
    const participant = groups.findGroupByParticipant(conv.id)

    let nextTools = turn.tools
    let toolsChanged = false
    const filterTools = (predicate: (toolName: string) => boolean): void => {
      const filtered = nextTools.filter((t) => predicate(t.name))
      if (filtered.length !== nextTools.length) {
        nextTools = filtered
        toolsChanged = true
      }
    }

    // 1) swarm_create_group 对已挂 swarm-coordinator / swarm-worker / swarm-worker-archived、子会话或后台会话隐藏
    const hideCreateGroup =
      conv.tags.includes(COORDINATOR_TAG) ||
      conv.tags.includes(WORKER_TAG) ||
      conv.tags.includes(ARCHIVED_WORKER_TAG) ||
      conv.parentConversationId !== undefined ||
      activeCoordGroup !== undefined ||
      (conv.ownedBy !== undefined && conv.ownedBy !== 'human')
    if (hideCreateGroup) {
      filterTools((name) => name !== 'swarm_create_group')
    }

    // 2) 主控守卫（coordinatorGuard === true）剥离重度阻塞工具
    if (activeCoordGroup?.coordinatorGuard === true) {
      filterTools((name) => !COORDINATOR_BLOCKED_TOOL_NAMES.has(name))
    }

    // 3) 只读成员（access: 'readonly'）剥离写文件、清理工作树与非幂等直暴外部工具
    if (participant?.role === 'worker' && participant.member.access === 'readonly') {
      const nonIdempotentTools = collectNonIdempotentDirectToolNames(ctx)
      filterTools((name) => !READONLY_WORKER_BLOCKED_TOOL_NAMES.has(name) && !nonIdempotentTools.has(name))
    }

    let nextSections = turn.sections
    let sectionsChanged = false
    const appendSection = (id: string, text: string): void => {
      nextSections = [...nextSections, { id, text }]
      sectionsChanged = true
    }

    if (activeCoordGroup !== undefined) {
      appendSection(ACTIVE_SWARM_GROUP_SECTION_ID, activeSwarmGroupCoordinatorSection(activeCoordGroup.id))
    } else if (participant?.role === 'worker') {
      appendSection(
        ACTIVE_SWARM_GROUP_SECTION_ID,
        activeSwarmGroupWorkerSection(
          participant.group.id,
          participant.member.name,
          participant.member.access,
          participant.member.isolation,
        ),
      )
    }

    if (!toolsChanged && !sectionsChanged) return
    return {
      action: 'transform',
      value: {
        ...turn,
        ...(toolsChanged ? { tools: nextTools } : {}),
        ...(sectionsChanged ? { sections: nextSections } : {}),
      },
    }
  })

  // ------------------------------------------------------------------
  // tool_call：主控守卫与只读成员执行期硬拦截
  // ------------------------------------------------------------------
  ctx.hook.onToolCall((payload) => {
    if (!isActive()) return
    const activeCoordGroup = groups.findActiveGroupByCoordinator(payload.conversationId)

    if (COORDINATOR_BLOCKED_TOOL_NAMES.has(payload.toolName) && activeCoordGroup?.coordinatorGuard === true) {
      return {
        action: 'block',
        reason: `Swarm 主控守卫（coordinatorGuard）已剥离重度阻塞工具 ${payload.toolName}；请通过 swarm_dispatch_worker / swarm_board_post 委派组内成员执行，或在全员审过后调用 swarm_close_group({ keepWorktree: true }) 解锁合入`,
      }
    }

    const participant = groups.findGroupByParticipant(payload.conversationId)
    if (participant?.role === 'worker' && participant.member.access === 'readonly') {
      if (READONLY_WORKER_BLOCKED_TOOL_NAMES.has(payload.toolName)) {
        return {
          action: 'block',
          reason: `只读成员 @${participant.member.name}（access: readonly）禁止调用写工具 ${payload.toolName}；请使用 bash 运行只读测试并通过 swarm_board_post 提交审阅结果`,
        }
      }
      if (payload.toolName === 'run_action') {
        if (payload.input['describe'] === true) return
        const qualified = typeof payload.input['actionId'] === 'string' ? payload.input['actionId'].trim() : ''
        if (qualified === `${SWARM_PLUGIN_ID}.board_post`) return
        const dot = qualified.indexOf('.')
        if (dot > 0) {
          const pluginId = qualified.slice(0, dot)
          const actionId = qualified.slice(dot + 1)
          const manifest = ctx.host.listActions().find((a) => a.pluginId === pluginId && a.id === actionId)
          if (manifest !== undefined && manifest.idempotent !== true) {
            return {
              action: 'block',
              reason: `只读成员 @${participant.member.name}（access: readonly）禁止通过 run_action 调用非幂等外部动作 ${qualified}`,
            }
          }
        }
      } else {
        const nonIdempotentTools = collectNonIdempotentDirectToolNames(ctx)
        if (nonIdempotentTools.has(payload.toolName)) {
          return {
            action: 'block',
            reason: `只读成员 @${participant.member.name}（access: readonly）禁止调用非幂等外部动作工具 ${payload.toolName}`,
          }
        }
      }
    }
  })

  // ------------------------------------------------------------------
  // turn_settled：纯事件驱动 Supervisor-Scoped 自愈闭环（零轮询定时器）
  // ------------------------------------------------------------------
  ctx.hook.onTurnSettled(async (payload) => {
    if (!isActive()) return
    const conversation = payload.conversation

    // 若为活跃协作组主控会话：冲刷忙碌期间积压的汇总报告并评估全组静默守卫
    if (groups.findActiveGroupByCoordinator(conversation.id) !== undefined) {
      await groups.onCoordinatorTurnSettled(conversation.id)
    }

    const participant = groups.findGroupByParticipant(conversation.id)
    if (participant?.role !== 'worker') return
    const current = readConversationOrUndefined(conversation.id)
    if (current === undefined || !current.tags.includes(WORKER_TAG)) return

    const targetGroupId = participant.group.id
    const targetMemberName = participant.member.name

    settlingWorkers.set(conversation.id, (settlingWorkers.get(conversation.id) ?? 0) + 1)
    try {
      const lastReplySummary = await collectMemberLastReplySummary(ctx.host, conversation.id)
      const stillParticipant = groups.findGroupByParticipant(conversation.id)
      const stillTagged = readConversationOrUndefined(conversation.id)?.tags.includes(WORKER_TAG) === true
      if (
        stillParticipant?.role !== 'worker' ||
        stillParticipant.group.id !== targetGroupId ||
        stillParticipant.member.name !== targetMemberName ||
        !stillTagged
      ) {
        return
      }
      await groups.onMemberTurnSettled({
        groupId: targetGroupId,
        memberName: targetMemberName,
        conversationId: conversation.id,
        completionSeq: conversation.completionSeq,
        outcome: payload.outcome,
        ...(payload.error !== undefined ? { error: payload.error } : {}),
        lastReplySummary,
      })
    } finally {
      const remaining = (settlingWorkers.get(conversation.id) ?? 1) - 1
      if (remaining === 0) settlingWorkers.delete(conversation.id)
      else settlingWorkers.set(conversation.id, remaining)
    }
  })
}
