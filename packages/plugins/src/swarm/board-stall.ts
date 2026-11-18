/**
 * builtin:swarm 防掉棒自愈与 0-Token 根因 [stall] 守卫纯函数：
 * - At-Most-Once Silent-Exit Nudge 判定（单次确定性续催 -> 二次命中代发 [blocker] 结清）；
 * - 6 条件全组静默检测与 3 类根因精确归因（未唤醒悬空产出 / 已读未回帖 / 全员待命未结单）。
 */
import { escapeXml } from '@helm/protocol'
import type { BoardPost, CollabGroupRecord, GroupMemberState, MemberLiveState } from './contracts.js'

export type SilentExitAction =
  | { kind: 'none' }
  | { kind: 'nudge'; taskSeq: number; prompt: string }
  | { kind: 'fallback_blocker'; taskSeq: number; body: string }

/**
 * 判定活跃成员 completed 回合后是否触发哑巴退场自愈：
 * - 仅在无新排队唤醒（pendingWakeupSeq <= readCursorSeq）且存在未回帖行动唤醒
 *   （lastWakeTaskSeq !== undefined && (lastPostSeq ?? 0) < lastWakeTaskSeq）时介入；
 * - 首次命中发送 1 次续催；二次命中代发 [blocker] 并结清。
 */
export function evaluateSilentExit(
  group: CollabGroupRecord,
  member: GroupMemberState,
  lastReplySummary: string,
): SilentExitAction {
  if (member.lifecycle !== 'active') return { kind: 'none' }
  if (member.pendingWakeupSeq > member.readCursorSeq) return { kind: 'none' }
  const taskSeq = member.lastWakeTaskSeq
  if (taskSeq === undefined) return { kind: 'none' }
  if ((member.lastPostSeq ?? 0) >= taskSeq) return { kind: 'none' }

  if (member.silentExitNudgeSeq !== taskSeq) {
    return {
      kind: 'nudge',
      taskSeq,
      prompt: [
        `<swarm_silent_exit_nudge group="${escapeXml(group.id)}" worker="${escapeXml(member.name)}" taskSeq="${taskSeq}">`,
        `You finished your turn for board task #${taskSeq} without calling swarm_board_post.`,
        `Peers and the coordinator only see what is posted to the board. Call swarm_board_post now to publish your outcome ('handoff', 'review', 'done', or 'blocker') with refs: [${taskSeq}].`,
        '</swarm_silent_exit_nudge>',
      ].join('\n'),
    }
  }

  const excerpt = lastReplySummary.trim() !== '' ? lastReplySummary.trim() : '(empty assistant reply)'
  return {
    kind: 'fallback_blocker',
    taskSeq,
    body: `Member @${member.name} exited silently twice without calling swarm_board_post for task #${taskSeq}. Last reply excerpt: ${excerpt}`,
  }
}

export type StallRootCauseKind = 'unwoken_output' | 'unanswered_wakeup' | 'idle_without_done'

export interface StallDiagnosis {
  cause: StallRootCauseKind
  refSeq?: number
  targetMember?: string
  body: string
}

/**
 * 精确归因三类静默根因：
 * 1) 存在 wake === false 的未唤醒悬空产出（指明 #seq）；
 * 2) 存在已读唤醒但未回帖的成员（指明 @name 与 #seq）；
 * 3) 全员空闲待命但尚未产生最终 done 交付。
 */
export function diagnoseStallRootCause(
  group: CollabGroupRecord,
  posts: readonly BoardPost[],
): StallDiagnosis {
  const activeMembers = group.members.filter((m) => m.lifecycle === 'active')
  const activeNames = new Set(activeMembers.map((m) => m.name))

  // 根因 ①：存在 wake === false 的未唤醒悬空产出（目标活跃成员尚未读到，或位于最后一次唤醒之后）
  const lastWakeSeq = posts.reduce((max, p) => (p.wake && p.kind !== 'stall' ? Math.max(max, p.seq) : max), 0)
  for (let i = posts.length - 1; i >= 0; i -= 1) {
    const post = posts[i]!
    if (post.wake || post.from === 'system') continue
    const unreadTarget = post.resolvedTargets.find((target) => {
      if (!activeNames.has(target)) return false
      const m = activeMembers.find((item) => item.name === target)
      return m !== undefined && m.readCursorSeq < post.seq
    })
    if (unreadTarget !== undefined) {
      return {
        cause: 'unwoken_output',
        refSeq: post.seq,
        targetMember: unreadTarget,
        body: `Group stalled: post #${post.seq} from @${post.from} was recorded with wake=false, leaving @${unreadTarget} unwoken.`,
      }
    }
    if (post.seq > lastWakeSeq) {
      const targetHint = post.to.find((t) => t !== 'coordinator')
      return {
        cause: 'unwoken_output',
        refSeq: post.seq,
        ...(targetHint !== undefined ? { targetMember: targetHint.replace(/^[@#]/, '') } : {}),
        body: `Group stalled: passive post #${post.seq} (${post.kind}, wake=false) from @${post.from} did not wake any next actor.`,
      }
    }
  }

  // 根因 ②：存在已读唤醒但未回帖的成员（指明 @name 与 #seq）
  for (const member of activeMembers) {
    const lastPostSeq = member.lastPostSeq ?? 0
    for (let i = posts.length - 1; i >= 0; i -= 1) {
      const post = posts[i]!
      if (!post.wake || post.kind === 'stall') continue
      if (!post.resolvedTargets.includes(member.name)) continue
      if (post.seq <= member.readCursorSeq && lastPostSeq < post.seq) {
        return {
          cause: 'unanswered_wakeup',
          refSeq: post.seq,
          targetMember: member.name,
          body: `Group stalled: @${member.name} read wakeup #${post.seq} (${post.kind}) without publishing a follow-up swarm_board_post.`,
        }
      }
      break
    }
  }

  // 根因 ③：全员空闲待命但尚未产生最终 done 交付
  const memberList = activeMembers.map((m) => `@${m.name}`).join(', ')
  const headHint = group.headSeq > 0 ? ` (latest #${group.headSeq})` : ''
  return {
    cause: 'idle_without_done',
    ...(group.headSeq > 0 ? { refSeq: group.headSeq } : {}),
    ...(activeMembers[0] !== undefined ? { targetMember: activeMembers[0].name } : {}),
    body: `Group stalled: all active members (${memberList}) and coordinator are idle${headHint}, but no final [done] delivery has been posted.`,
  }
}

export interface MemberRuntimeSnapshot {
  name: string
  liveState: MemberLiveState
  completionSeq: number
  isSettling: boolean
  lastWakeCompletionSeq?: number
}

export interface QuiescenceCheckInput {
  group: CollabGroupRecord
  posts: readonly BoardPost[]
  hasInflightDeliveries: boolean
  coordinatorState: { exists: boolean; liveState: MemberLiveState }
  memberSnapshots: readonly MemberRuntimeSnapshot[]
}

/** 计算静默去重水位：以 (stall 后 headSeq, 活跃成员名与 completionSeq) 锁定单次告警。 */
export function computeStallWatermark(
  headSeq: number,
  memberSnapshots: readonly Pick<MemberRuntimeSnapshot, 'name' | 'completionSeq'>[],
): string {
  const memberDigest = [...memberSnapshots]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => `${m.name}:${m.completionSeq}`)
    .join(',')
  return `${headSeq}|${memberDigest}`
}

/**
 * 6 条件 0-Token 全组静默守卫评估：
 * 1) 组活跃且主控未脱离（且至少有 1 名活跃成员与至少 1 条记录）；
 * 2) 无在途唤醒投递或待发主控汇总定时器；
 * 3) 全员读游标已追平（pendingWakeupSeq <= readCursorSeq）；
 * 4) 全员空闲（非 working/blocked/missing 且不在结算中）且 completionSeq > lastWakeCompletionSeq；
 * 5) 主控空闲且无待送达汇报（coordinatorPendingSeq <= coordinatorNotifiedSeq），且最新有效帖非 done/blocker/stall；
 * 6) 当前静默水位首次命中（!== group.lastStallWatermark）。
 */
export function evaluateGroupQuiescence(
  input: QuiescenceCheckInput,
): { shouldEmitStall: false } | { shouldEmitStall: true; diagnosis: StallDiagnosis; nextWatermarkAfterPost: string } {
  const { group, posts, hasInflightDeliveries, coordinatorState, memberSnapshots } = input
  const activeMembers = group.members.filter((m) => m.lifecycle === 'active')

  // 条件 1：组活跃未脱离，且存在活跃成员与黑板流转记录
  if (group.status !== 'active' || group.coordinatorDetached === true) return { shouldEmitStall: false }
  if (activeMembers.length === 0 || group.headSeq === 0) return { shouldEmitStall: false }

  // 条件 2：无在途投递
  if (hasInflightDeliveries) return { shouldEmitStall: false }

  // 条件 3：全员读游标追平
  for (const m of activeMembers) {
    if (m.pendingWakeupSeq > m.readCursorSeq) return { shouldEmitStall: false }
  }

  // 条件 4：全员空闲且 completionSeq > lastWakeCompletionSeq
  const snapByName = new Map(memberSnapshots.map((s) => [s.name, s]))
  for (const m of activeMembers) {
    const snap = snapByName.get(m.name)
    if (snap === undefined) return { shouldEmitStall: false }
    if (snap.isSettling) return { shouldEmitStall: false }
    if (snap.liveState === 'working' || snap.liveState === 'blocked' || snap.liveState === 'missing') {
      return { shouldEmitStall: false }
    }
    if (snap.lastWakeCompletionSeq !== undefined && snap.completionSeq <= snap.lastWakeCompletionSeq) {
      return { shouldEmitStall: false }
    }
  }

  // 条件 5：主控空闲且无待送达汇报，且最新帖非 done / blocker / stall
  if (!coordinatorState.exists) return { shouldEmitStall: false }
  if (coordinatorState.liveState === 'working' || coordinatorState.liveState === 'blocked') {
    return { shouldEmitStall: false }
  }
  if (group.coordinatorPendingSeq > group.coordinatorNotifiedSeq) return { shouldEmitStall: false }
  const latestPost = posts[posts.length - 1]
  if (latestPost === undefined) return { shouldEmitStall: false }
  if (latestPost.kind === 'done' || latestPost.kind === 'blocker' || latestPost.kind === 'stall') {
    return { shouldEmitStall: false }
  }

  // 条件 6：水位首次命中
  const activeSnaps = activeMembers.map((m) => snapByName.get(m.name)!)
  const currentWatermark = computeStallWatermark(group.headSeq, activeSnaps)
  if (group.lastStallWatermark === currentWatermark) {
    return { shouldEmitStall: false }
  }

  const diagnosis = diagnoseStallRootCause(group, posts)
  const nextWatermarkAfterPost = computeStallWatermark(group.headSeq + 1, activeSnaps)
  return {
    shouldEmitStall: true,
    diagnosis,
    nextWatermarkAfterPost,
  }
}
