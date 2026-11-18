/**
 * builtin:swarm 协同黑板纯函数：
 * - Fail-Closed 目标寻址（coordinator / all / #<channel> / <name>）与正交缺省 wake 推导；
 * - 双向游标批合并信封组装（附统一反回声守则与主控 objective / activeWorkingMembers 锚点）；
 * - 看板投影（BoardViewDoc + BoardBadgesDoc）合成与 (headSeq, memberStateDigest) 去重指纹。
 */
import { HelmError } from '@helm/protocol'
import {
  SWARM_PLUGIN_ID,
  toGroupSummary,
  type BoardBadgeEntry,
  type BoardPost,
  type BoardPostKind,
  type BoardViewDoc,
  type BoardViewEdge,
  type BoardViewHeadline,
  type BoardViewMember,
  type CollabGroupRecord,
  type GroupMemberState,
  type MemberLiveState,
} from './contracts.js'
import { truncate } from './settlement.js'

export const ANTI_ECHO_RULE_FOOTER =
  'Anti-echo rule: If this batch is purely informational and requires no concrete action, end your turn immediately without posting pure acknowledgments or thank-yous; never treat partial member completion as full-group completion while activeWorkingMembers is non-empty.'

export interface BoardCallerIdentity {
  role: 'coordinator' | 'worker' | 'human' | 'system'
  from: string
}

/** 缺省 wake 推导：comment 缺省 false，其余非空目标缺省 true。 */
export function resolveDefaultWake(kind: BoardPostKind, to: readonly string[]): boolean {
  if (to.length === 0) return false
  if (kind === 'comment') return false
  return true
}

/** 校验发帖目标频道存在且未归档（缺省 'main'）。 */
export function resolvePostChannel(group: CollabGroupRecord, rawChannel: string | undefined): string {
  const channelName = rawChannel === undefined || rawChannel.trim() === '' ? 'main' : rawChannel.trim()
  const found = group.channels.find((c) => c.name === channelName)
  if (found === undefined) {
    throw new HelmError('swarm_unknown_channel', `未知频道 '${channelName}'`, 404, {
      pluginId: SWARM_PLUGIN_ID,
      groupId: group.id,
      channel: channelName,
    })
  }
  if (found.archived === true) {
    throw new HelmError('swarm_channel_archived', `频道 '${channelName}' 已归档，无法写入新帖`, 409, {
      pluginId: SWARM_PLUGIN_ID,
      groupId: group.id,
      channel: channelName,
    })
  }
  return channelName
}

/**
 * 确定性 Fail-Closed 目标解析（严禁静默丢弃未知目标）：
 * - 'coordinator' -> 主控会话（主控自发时自动剔除防自回声）；
 * - 'all' -> 全体 active 成员（仅主控/人工/system 可用，Worker 调用返 403）；
 * - '#<channel>' -> '#main' 返 400；未知频道返 404；已归档频道返 409；其余展开为订阅该频道的 active 成员；
 * - '<name>' -> 精确匹配 active 成员（未知或已归档返 404）。
 * 所有展开结果均自动剔除发帖者自身防自回声并保持声明序去重。
 */
export function resolveBoardTargets(
  group: CollabGroupRecord,
  caller: BoardCallerIdentity,
  rawTargets: readonly string[],
): { normalizedTo: string[]; resolvedTargets: string[] } {
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw new HelmError('validation_error', 'board_post.to 必须是非空目标数组', 400, { groupId: group.id })
  }
  const normalizedTo: string[] = []
  const resolved: string[] = []
  const pushResolved = (target: string): void => {
    if (target === caller.from) return
    if (!resolved.includes(target)) resolved.push(target)
  }

  for (const rawItem of rawTargets) {
    if (typeof rawItem !== 'string' || rawItem.trim() === '') {
      throw new HelmError('validation_error', 'board_post.to 含空目标项', 400, { groupId: group.id })
    }
    const token = rawItem.trim()
    if (!normalizedTo.includes(token)) normalizedTo.push(token)

    if (token === 'coordinator') {
      pushResolved('coordinator')
      continue
    }

    if (token === 'all') {
      if (caller.role === 'worker') {
        throw new HelmError(
          'swarm_broadcast_forbidden',
          `成员 @${caller.from} 禁止使用 'all' 全组广播；请定向点名下一跳责任人或使用 #<channel> 子频道`,
          403,
          { pluginId: SWARM_PLUGIN_ID, groupId: group.id, from: caller.from },
        )
      }
      for (const m of group.members) {
        if (m.lifecycle === 'active') pushResolved(m.name)
      }
      continue
    }

    if (token.startsWith('#')) {
      const chName = token.slice(1)
      if (chName === 'main') {
        throw new HelmError(
          'validation_error',
          "禁止向 '#main' 寻址；如需全组广播请由主控显式使用 'all'",
          400,
          { pluginId: SWARM_PLUGIN_ID, groupId: group.id, target: token },
        )
      }
      const ch = group.channels.find((c) => c.name === chName)
      if (ch === undefined) {
        throw new HelmError('swarm_unknown_channel', `未知子频道 '${token}'`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: group.id,
          channel: chName,
        })
      }
      if (ch.archived === true) {
        throw new HelmError('swarm_channel_archived', `子频道 '${token}' 已归档，拒绝投递`, 409, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: group.id,
          channel: chName,
        })
      }
      for (const m of group.members) {
        if (m.lifecycle === 'active' && m.channels.includes(chName)) {
          pushResolved(m.name)
        }
      }
      continue
    }

    const cleanName = token.startsWith('@') ? token.slice(1) : token
    const member = group.members.find((m) => m.name === cleanName && m.lifecycle === 'active')
    if (member === undefined) {
      throw new HelmError(
        'swarm_unknown_target',
        `未知或已归档的协同目标 '${token}'`,
        404,
        { pluginId: SWARM_PLUGIN_ID, groupId: group.id, target: token },
      )
    }
    pushResolved(member.name)
  }

  return { normalizedTo, resolvedTargets: resolved }
}

function formatSinglePostBlock(post: BoardPost): string {
  const refsPart = post.refs.length > 0 ? ` refs=[${post.refs.map((r) => `#${r}`).join(', ')}]` : ''
  const passivePart = post.wake ? '' : ' (wake=false)'
  const header = `#${post.seq} [${post.kind}] @${post.from} -> ${post.to.join(', ')} (channel: ${post.channel})${refsPart}${passivePart}`
  const snapLines: string[] = []
  if (post.worktreeSnapshot !== undefined) {
    const s = post.worktreeSnapshot
    const parts = [
      `worktreeId=${s.worktreeId}`,
      ...(s.branch !== undefined ? [`branch=${s.branch}`] : []),
      ...(s.commitsAhead !== undefined ? [`commitsAhead=${s.commitsAhead}`] : []),
      `dirtyCount=${s.dirtyCount}`,
      ...(s.changedFilesPreview.length > 0 ? [`files=[${s.changedFilesPreview.join(', ')}]`] : []),
    ]
    snapLines.push(`  [worktree] ${parts.join(' | ')}`)
  }
  return [header, post.body, ...snapLines].join('\n')
}

/** 组装发往对等成员的合并唤醒信封（包含 (fromSeq-1, toSeq] 内该成员可见记录及前置被动留言）。 */
export function selectPostsForMemberWakeup(
  member: GroupMemberState,
  posts: readonly BoardPost[],
  fromSeq: number,
  toSeq: number,
): BoardPost[] {
  return posts.filter(
    (p) =>
      p.seq >= fromSeq &&
      p.seq <= toSeq &&
      p.from !== member.name &&
      (p.resolvedTargets.includes(member.name) || p.channel === 'main' || member.channels.includes(p.channel)),
  )
}

export function formatWorkerWakeupEnvelope(input: {
  group: CollabGroupRecord
  member: GroupMemberState
  posts: readonly BoardPost[]
  fromSeq: number
  toSeq: number
}): string {
  const { group, member, posts, fromSeq, toSeq } = input
  const lines: string[] = [
    `<swarm_board_wakeup group="${group.id}" worker="${member.name}" seq="${fromSeq}..${toSeq}">`,
    `Group: ${group.title} (${group.id})`,
    ...(group.objective !== undefined && group.objective.trim() !== '' ? [`Objective: ${group.objective}`] : []),
    `Your role: @${member.name} (access=${member.access}, isolation=${member.isolation})`,
    '',
    ...posts.map((p) => formatSinglePostBlock(p)),
    '',
    `Action rule: Complete the work requested of @${member.name}, then publish your result via swarm_board_post (handoff / review / done / blocker, citing #seq in refs).`,
    ANTI_ECHO_RULE_FOOTER,
    '</swarm_board_wakeup>',
  ]
  return lines.join('\n')
}

export function selectPostsForCoordinatorReport(
  posts: readonly BoardPost[],
  fromSeq: number,
  toSeq: number,
): BoardPost[] {
  return posts.filter((p) => p.seq >= fromSeq && p.seq <= toSeq && p.from !== 'coordinator')
}

export function formatCoordinatorReportEnvelope(input: {
  group: CollabGroupRecord
  posts: readonly BoardPost[]
  fromSeq: number
  toSeq: number
  activeWorkingMembers: readonly string[]
}): string {
  const { group, posts, fromSeq, toSeq, activeWorkingMembers } = input
  const workingText = activeWorkingMembers.length > 0 ? activeWorkingMembers.map((m) => `@${m}`).join(', ') : '(none)'
  const lines: string[] = [
    `<swarm_board_report group="${group.id}" seq="${fromSeq}..${toSeq}">`,
    `Group: ${group.title} (${group.id})`,
    ...(group.objective !== undefined && group.objective.trim() !== '' ? [`Objective: ${group.objective}`] : []),
    `activeWorkingMembers: ${workingText}`,
    '',
    ...posts.map((p) => formatSinglePostBlock(p)),
    '',
    ANTI_ECHO_RULE_FOOTER,
    '</swarm_board_report>',
  ]
  return lines.join('\n')
}

/** 聚合全局拓扑边（按 from -> to 汇总次数、最新序号与最新类型）。 */
export function aggregateBoardEdges(posts: readonly BoardPost[]): BoardViewEdge[] {
  const byKey = new Map<string, BoardViewEdge>()
  for (const post of posts) {
    const targets = post.resolvedTargets.length > 0 ? post.resolvedTargets : post.to
    for (const rawTarget of targets) {
      if (rawTarget === post.from) continue
      const key = `${post.from}\0${rawTarget}`
      const existing = byKey.get(key)
      if (existing === undefined) {
        byKey.set(key, {
          from: post.from,
          to: rawTarget,
          count: 1,
          lastSeq: post.seq,
          lastKind: post.kind,
        })
      } else {
        existing.count += 1
        existing.lastSeq = post.seq
        existing.lastKind = post.kind
      }
    }
  }
  return [...byKey.values()]
}

/** 合成看板顶部一句话态势。 */
export function synthesizeHeadline(
  group: CollabGroupRecord,
  members: readonly BoardViewMember[],
  posts: readonly BoardPost[],
  activeWorkingMembers: readonly string[],
): BoardViewHeadline {
  if (group.status === 'closed') {
    const retained = group.retainedWorktrees ?? []
    if (retained.length > 0) {
      return {
        kind: 'unmerged',
        tone: 'warn',
        text: `Group closed with ${retained.length} retained worktree branch(es) awaiting merge`,
        targetMember: retained[0]!.memberName,
      }
    }
    return {
      kind: 'closed',
      tone: 'ok',
      text: group.closeSummary ?? 'Swarm group closed',
    }
  }

  const activeMembers = members.filter((m) => m.lifecycle === 'active')
  const erroredMember = activeMembers.find((m) => m.liveState === 'error')
  const latestPost = posts.length > 0 ? posts[posts.length - 1] : undefined

  if (latestPost?.kind === 'blocker') {
    const targetMember =
      latestPost.from !== 'system' && latestPost.from !== 'coordinator'
        ? latestPost.from
        : erroredMember?.name
    return {
      kind: 'blocker',
      tone: 'err',
      text: truncate(`#${latestPost.seq} [blocker] ${latestPost.body.replaceAll(/\s+/g, ' ').trim()}`, 140),
      ...(targetMember !== undefined ? { targetMember } : {}),
      refSeq: latestPost.seq,
    }
  }

  if (erroredMember !== undefined) {
    return {
      kind: 'blocker',
      tone: 'err',
      text: `Member @${erroredMember.name} stopped in error state`,
      targetMember: erroredMember.name,
    }
  }

  if (latestPost?.kind === 'stall' && activeWorkingMembers.length === 0) {
    const matchMember = latestPost.body.match(/@([a-z][a-z0-9_-]{0,31})/)?.[1]
    return {
      kind: 'stall',
      tone: 'warn',
      text: truncate(`#${latestPost.seq} [stall] ${latestPost.body.replaceAll(/\s+/g, ' ').trim()}`, 140),
      ...(matchMember !== undefined ? { targetMember: matchMember } : {}),
      refSeq: latestPost.seq,
    }
  }

  if (activeWorkingMembers.length > 0) {
    return {
      kind: 'normal',
      tone: 'info',
      text: `Active: ${activeWorkingMembers.map((m) => `@${m}`).join(', ')}`,
      targetMember: activeWorkingMembers[0]!,
    }
  }

  for (let i = posts.length - 1; i >= 0; i -= 1) {
    const p = posts[i]!
    if (p.kind === 'done') {
      return {
        kind: 'normal',
        tone: 'ok',
        text: truncate(`#${p.seq} [done] @${p.from}: ${p.body.replaceAll(/\s+/g, ' ').trim()}`, 140),
        ...(p.from !== 'coordinator' && p.from !== 'system' ? { targetMember: p.from } : {}),
        refSeq: p.seq,
      }
    }
  }

  if (activeMembers.length === 0) {
    return {
      kind: 'normal',
      tone: 'info',
      text: 'Group ready — dispatch peer roles to start collaboration',
    }
  }

  return {
    kind: 'normal',
    tone: 'info',
    text: `${activeMembers.length} active member(s) idle`,
  }
}

/** 合成单个协作组的完整 BoardViewDoc 及其 (headSeq, memberStateDigest) 去重指纹。 */
export function synthesizeBoardView(input: {
  group: CollabGroupRecord
  posts: readonly BoardPost[]
  previewLimit: number
  resolveMemberLive: (conversationId: number) => { liveState: MemberLiveState; model?: string }
}): { view: BoardViewDoc; digest: string; badge: BoardBadgeEntry } {
  const { group, posts, previewLimit, resolveMemberLive } = input
  const members: BoardViewMember[] = group.members.map((m) => {
    const live = resolveMemberLive(m.conversationId)
    return {
      ...m,
      channels: [...m.channels],
      ...(m.lastOutboundEdge !== undefined
        ? { lastOutboundEdge: { ...m.lastOutboundEdge, to: [...m.lastOutboundEdge.to] } }
        : {}),
      liveState: live.liveState,
      ...(live.model !== undefined ? { model: live.model } : {}),
    }
  })

  const activeWorkingMembers = members
    .filter((m) => m.lifecycle === 'active' && (m.liveState === 'working' || m.liveState === 'blocked'))
    .map((m) => m.name)

  const edges = aggregateBoardEdges(posts)
  const headline = synthesizeHeadline(group, members, posts, activeWorkingMembers)
  const previewPosts = posts.slice(-previewLimit)
  const summary = toGroupSummary(group)

  const view: BoardViewDoc = {
    group: {
      ...summary,
      ...(group.objective !== undefined ? { objective: group.objective } : {}),
      channels: group.channels.map((c) => ({ ...c })),
      ...(group.retainedWorktrees !== undefined
        ? { retainedWorktrees: group.retainedWorktrees.map((rw) => ({ ...rw })) }
        : {}),
      ...(group.closeSummary !== undefined ? { closeSummary: group.closeSummary } : {}),
    },
    headline,
    members,
    edges,
    posts: previewPosts,
    activeWorkingMembers,
  }

  const digest = JSON.stringify({
    headSeq: group.headSeq,
    status: group.status,
    title: group.title,
    objective: group.objective ?? '',
    coordinatorDetached: Boolean(group.coordinatorDetached),
    channels: group.channels,
    retainedWorktrees: group.retainedWorktrees ?? [],
    closeSummary: group.closeSummary ?? '',
    previewLimit,
    members: members.map((m) => [
      m.name,
      m.lifecycle,
      m.liveState,
      m.model ?? '',
      m.access,
      m.isolation,
      m.worktreeId ?? '',
      m.channels,
      m.readCursorSeq,
      m.pendingWakeupSeq,
      m.lastPostSeq ?? 0,
      m.lastWakeTaskSeq ?? 0,
      m.silentExitNudgeSeq ?? 0,
    ]),
  })

  const hasWarn =
    headline.kind === 'stall' ||
    headline.kind === 'blocker' ||
    members.some((m) => m.lifecycle === 'active' && m.liveState === 'error')
  const tone: BoardBadgeEntry['tone'] = hasWarn
    ? 'warn'
    : activeWorkingMembers.length > 0
      ? 'accent'
      : 'neutral'
  const footerText = hasWarn
    ? headline.text
    : activeWorkingMembers.length > 0
      ? `${activeWorkingMembers.length} working`
      : undefined

  const badge: BoardBadgeEntry = {
    groupId: group.id,
    coordinatorConversationId: group.coordinatorConversationId,
    count: summary.activeWorkerCount,
    tone,
    ...(footerText !== undefined ? { footerText } : {}),
  }

  return { view, digest, badge }
}
