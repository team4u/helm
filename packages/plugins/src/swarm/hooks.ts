import { escapeXml, isSkillAvailable, type HelmPluginContext } from '@helm/protocol'
import {
  ACTIVE_SWARM_GROUP_SECTION_ID,
  ARCHIVED_WORKER_TAG,
  COORDINATOR_TAG,
  SWARM_SKILL_ID,
  WORKER_TAG,
  type SwarmCoordinator,
  type WorkerAccess,
  type WorkerIsolation,
} from './contracts.js'
import { checkCoordinatorEligibility, ensureCoordinatorGroup } from './actions.js'
import { collectMemberLastReplySummary } from './settlement.js'

const SWARM_SLASH_RE = /^\/skill:swarm(?:\s+([\s\S]*))?$/
const INELIGIBLE_SWARM_SLASH_REASON =
  '不能在子成员或后台会话中使用 /skill:swarm 发起协同，请在顶层对话输入 /skill:swarm <任务>'

async function isSwarmSkillAllowed(ctx: HelmPluginContext, profileId: string): Promise<boolean> {
  const [profile, allSkills] = await Promise.all([
    ctx.host.profiles.get(profileId),
    ctx.host.skills.list(),
  ])
  if (profile === undefined) return false
  const skill = allSkills.find((s) => s.id === SWARM_SKILL_ID)
  if (skill === undefined) return false
  const enabledPluginIds = new Set(ctx.host.listPlugins().filter((p) => p.enabled).map((p) => p.id))
  return isSkillAvailable(skill, profile, enabledPluginIds)
}

/** 100% 字节恒定的协作组主控系统提示词段（仅含创建后永不变更的 groupId 与静态协作铁律，零可变成员列表或状态）。 */
export function activeSwarmGroupCoordinatorSection(
  groupId: string,
  options?: { skillAvailable?: boolean },
): string {
  const skillStep =
    options?.skillAvailable === false
      ? '1. Coordinate the squad on the blackboard directly with swarm_* tools (profile skills policy disables load_skill). If the user only sent "/skill:swarm" with no task and no prior goal, confirm swarm mode is ready and briefly ask what task to coordinate.'
      : `1. Before coordinating, call load_skill({ skillId: "${SWARM_SKILL_ID}" }) for the full blackboard collaboration rules. If the user only sent "/skill:swarm" with no task and no prior goal, confirm swarm mode is ready and briefly ask what task to coordinate.`
  return [
    `<active_swarm_group id="${escapeXml(groupId)}" role="coordinator">`,
    skillStep,
    '2. Do not write business code or sit inside long blocking builds yourself; delegate implementation and verification to workers (quick read-only lookups to size and split the work are fine). Dynamically decide the squad for the task itself (never follow fixed role-name templates): choose worker count, lowercase names, directory access ("readwrite" / "readonly"), workspace isolation ("worktree" / "inherit"), and optional profileId / model via swarm_dispatch_worker.',
    '3. Coordinate handoffs via swarm_board_post / swarm_board_read / swarm_board_status using #seq pointers in refs without copy-pasting diffs or long reports; keep wake=true strictly for the next actor who must act, and never close the group while activeWorkingMembers is non-empty.',
    '4. When all slices pass verification, merge worktree branches and call swarm_close_group (or pass keepWorktree: true to release holds while preserving unmerged branches).',
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
  // input：/skill:swarm 技能指令激活或复用协作组，保留用户输入原文不变
  // ------------------------------------------------------------------
  ctx.hook.onInput(async (payload) => {
    if (!isActive()) return
    const origin = payload.input.origin
    if (origin !== undefined && origin !== 'human') return
    const trimmed = payload.input.text.trim()
    const match = SWARM_SLASH_RE.exec(trimmed)
    if (match === null) return

    const conv = readConversationOrUndefined(payload.conversationId)
    if (
      conv === undefined ||
      checkCoordinatorEligibility(conv, ctx.host.getConversationOwnership(conv.id)) !== undefined
    ) {
      return { action: 'block', reason: INELIGIBLE_SWARM_SLASH_REASON }
    }
    if (!(await isSwarmSkillAllowed(ctx, conv.profileId))) {
      return {
        action: 'block',
        reason: `当前 Profile '${conv.profileId}' 未开放 '${SWARM_SKILL_ID}' 技能，无法使用 /skill:swarm`,
      }
    }

    const rawTask = (match[1] ?? '').trim()
    if (groups.findActiveGroupByCoordinator(conv.id) === undefined) {
      const firstLine = rawTask.split(/\r?\n/, 1)[0]?.trim() ?? ''
      const title =
        firstLine !== ''
          ? firstLine.slice(0, 80)
          : conv.title.trim() !== ''
            ? conv.title.trim().slice(0, 80)
            : 'Swarm 协同任务'
      const objective = rawTask !== '' ? rawTask.slice(0, 240) : undefined
      await ensureCoordinatorGroup(ctx, coordinator, {
        conversationId: conv.id,
        title,
        ...(objective !== undefined ? { objective } : {}),
        reuseExisting: true,
      })
    }

    return { action: 'continue' }
  })

  // ------------------------------------------------------------------
  // before_turn：swarm_create_group 入口可见性 + 恒定 sections 注入（零剥离业务工具）
  // ------------------------------------------------------------------
  ctx.hook.onBeforeTurn(async (turn) => {
    if (!isActive()) return
    const conv = turn.conversation
    const activeCoordGroup = groups.findActiveGroupByCoordinator(conv.id)
    const participant = groups.findGroupByParticipant(conv.id)

    let nextTools = turn.tools
    let toolsChanged = false

    // swarm_create_group 仅对未建组的顶层人类会话暴露；已挂协作标签、子会话或后台会话隐藏该建组入口
    const hideCreateGroup =
      conv.tags.includes(COORDINATOR_TAG) ||
      conv.tags.includes(WORKER_TAG) ||
      conv.tags.includes(ARCHIVED_WORKER_TAG) ||
      conv.parentConversationId !== undefined ||
      activeCoordGroup !== undefined ||
      (conv.ownedBy !== undefined && conv.ownedBy !== 'human')
    if (hideCreateGroup) {
      const filtered = nextTools.filter((t) => t.name !== 'swarm_create_group')
      if (filtered.length !== nextTools.length) {
        nextTools = filtered
        toolsChanged = true
      }
    }

    let nextSections = turn.sections
    let sectionsChanged = false
    const appendSection = (id: string, text: string): void => {
      nextSections = [...nextSections, { id, text }]
      sectionsChanged = true
    }

    if (activeCoordGroup !== undefined) {
      const skillAvailable = await isSwarmSkillAllowed(ctx, conv.profileId)
      appendSection(
        ACTIVE_SWARM_GROUP_SECTION_ID,
        activeSwarmGroupCoordinatorSection(activeCoordGroup.id, { skillAvailable }),
      )
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
