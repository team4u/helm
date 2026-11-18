/**
 * Pure derivation for the builtin:swarm composer activity tray (zero React/DOM
 * dependencies, Fast Refresh compliant).
 *
 * Consumes only the live `board-view` session doc facts: in-flight members
 * (working / blocked), blocked-first ordering, one localized frontline digest
 * built from the newest post, and the group start time for the elapsed clock.
 * When no member is in flight the summary is empty and the tray must render
 * null (zero height).
 */
import type { ConversationSummary } from '@helm/protocol'
import {
  isMemberInFlight,
  postDigestLine,
  sortBoardMembersForDisplay,
  type BoardMemberView,
  type BoardViewDoc,
} from './board-model.ts'

export interface SwarmTrayItem {
  key: string
  name: string
  conversationId: number
  liveState: BoardMemberView['liveState']
  isBlocked: boolean
  /** Live host fact from the conversation summary (never fabricated). */
  doing?: string
}

/** Structured frontline so the component localizes the kind verb via copy.ts. */
export interface SwarmTrayFrontline {
  from: string
  to: string
  kind: string
  digest: string
  seq: number
}

export interface SwarmTraySummary {
  items: SwarmTrayItem[]
  workingCount: number
  blockedCount: number
  frontline: SwarmTrayFrontline | undefined
  groupStartedAt?: number
  doneCount: number
  activeCount: number
}

export function buildSwarmTraySummary(
  view: BoardViewDoc,
  conversations: ReadonlyArray<ConversationSummary>,
): SwarmTraySummary {
  const summaryById = new Map<number, ConversationSummary>()
  for (const conv of conversations) summaryById.set(conv.id, conv)

  const inFlight = sortBoardMembersForDisplay(view.members.filter(isMemberInFlight))
  const items: SwarmTrayItem[] = inFlight.map((member) => {
    const summary = summaryById.get(member.conversationId)
    const doing = summary?.doing !== undefined && summary.doing.trim() !== '' ? summary.doing.trim() : undefined
    return {
      key: member.name,
      name: member.name,
      conversationId: member.conversationId,
      liveState: member.liveState,
      isBlocked: member.liveState === 'blocked',
      ...(doing !== undefined ? { doing } : {}),
    }
  })

  const latestPost = view.posts.length > 0 ? view.posts[view.posts.length - 1] : undefined
  let frontline: SwarmTrayFrontline | undefined
  if (latestPost !== undefined) {
    const to = latestPost.resolvedTargets[0] ?? latestPost.to[0] ?? ''
    frontline = {
      from: latestPost.from,
      to,
      kind: latestPost.kind,
      digest: postDigestLine(latestPost.body, 90),
      seq: latestPost.seq,
    }
  }

  const activeMembers = view.members.filter((m) => m.lifecycle === 'active')
  return {
    items,
    workingCount: items.filter((i) => !i.isBlocked).length,
    blockedCount: items.filter((i) => i.isBlocked).length,
    frontline,
    ...(view.group.createdAt > 0 ? { groupStartedAt: view.group.createdAt } : {}),
    doneCount: activeMembers.filter((m) => m.liveState === 'done').length,
    activeCount: activeMembers.length,
  }
}
