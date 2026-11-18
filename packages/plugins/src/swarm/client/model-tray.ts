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
import type { AskSpec, ConversationLive, ConversationSummary } from '@helm/protocol'
import { DEFAULT_HELM_LOCALE, resolveLocalizedText, type HelmLocale } from '@helm/plugin-client'
import {
  boardProgressOf,
  isMemberInFlight,
  isPlainObject,
  postDigestLine,
  sortBoardMembersForDisplay,
  type BoardMemberView,
  type BoardViewDoc,
} from './board-model.ts'
import {
  TRAY_AWAITING_APPROVAL,
  TRAY_AWAITING_HUMAN,
  TRAY_LOAD_FAILED_TAG,
  TRAY_OUTPUT_TAG,
  TRAY_THINKING_TAG,
  trayParallelToolsTag,
} from './copy.ts'

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

  const progress = boardProgressOf(view.members)
  return {
    items,
    workingCount: items.filter((i) => !i.isBlocked).length,
    blockedCount: items.filter((i) => i.isBlocked).length,
    frontline,
    ...(view.group.createdAt > 0 ? { groupStartedAt: view.group.createdAt } : {}),
    doneCount: progress.done,
    activeCount: progress.total,
  }
}

function firstLineCompact(text: string, maxChars = 100): string {
  const first = (text.trim().split(/\r?\n/, 1)[0] ?? '').replaceAll(/\s+/g, ' ').trim()
  return first.length > maxChars ? `${first.slice(0, maxChars - 1)}…` : first
}

function lastMeaningfulLine(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    return line.replace(/^[#-]+\s+/, '')
  }
  return undefined
}

function formatRunningToolSnippet(toolName: string, input: unknown): string {
  if (isPlainObject(input)) {
    const detail =
      input['command'] ?? input['path'] ?? input['pattern'] ?? input['query'] ?? input['name'] ?? input['kind']
    if (typeof detail === 'string' && detail.trim() !== '') {
      return `${toolName}: ${firstLineCompact(detail, 80)}`
    }
  }
  return toolName
}

/** Derive one live execution / approval snippet from host snapshot facts (never fabricated). */
export function resolveSwarmTrayLiveSnippet(
  input: {
    isBlocked: boolean
    summary?: ConversationSummary
    live?: ConversationLive
    pendingAsk?: Pick<AskSpec, 'title' | 'description'>
    detailError?: string
    fallbackDoing?: string
  },
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string | undefined {
  if (input.detailError !== undefined) {
    return `${resolveLocalizedText(TRAY_LOAD_FAILED_TAG, locale)}: ${firstLineCompact(input.detailError)}`
  }
  const hasBlocked =
    input.isBlocked ||
    input.pendingAsk !== undefined ||
    (input.summary?.pendingAskCount ?? 0) > 0 ||
    input.summary?.status === 'blocked'
  if (hasBlocked) {
    const raw =
      input.pendingAsk?.title ||
      input.pendingAsk?.description ||
      input.summary?.doing ||
      input.fallbackDoing ||
      resolveLocalizedText(TRAY_AWAITING_HUMAN, locale)
    return `${resolveLocalizedText(TRAY_AWAITING_APPROVAL, locale)}: ${firstLineCompact(raw)}`
  }

  const runningTools = (input.live?.tools ?? []).filter((t) => t.status === 'running')
  if (runningTools.length === 1) {
    const tool = runningTools[0]!
    return formatRunningToolSnippet(tool.toolName, tool.input)
  }
  if (runningTools.length > 1) {
    const names = runningTools.slice(0, 2).map((t) => formatRunningToolSnippet(t.toolName, t.input)).join(' · ')
    return `${trayParallelToolsTag(runningTools.length, locale)}: ${names}`
  }

  const liveText = input.live?.text !== undefined ? lastMeaningfulLine(input.live.text) : undefined
  if (liveText !== undefined) {
    return `${resolveLocalizedText(TRAY_OUTPUT_TAG, locale)}: ${firstLineCompact(liveText)}`
  }
  const liveThinking = input.live?.thinking !== undefined ? lastMeaningfulLine(input.live.thinking) : undefined
  if (liveThinking !== undefined) {
    return `${resolveLocalizedText(TRAY_THINKING_TAG, locale)}: ${firstLineCompact(liveThinking)}`
  }

  const doing = input.summary?.doing !== undefined && input.summary.doing.trim() !== ''
    ? input.summary.doing.trim()
    : input.fallbackDoing
  return doing !== undefined && doing.trim() !== '' ? firstLineCompact(doing) : undefined
}
