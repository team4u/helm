/**
 * Pure data models for the builtin:superagent client components (no component
 * exports, Fast Refresh contract).
 *
 * Doc shapes are declared here only (mirroring the server contracts in
 * superagent/contracts.ts); parsing is lenient at the boundary: an
 * not-yet-arrived doc (undefined) or a missing field resolves to a safe
 * default, never fabricated data. Display-copy builders take an explicit
 * trailing locale (defaulting to en so existing English assertions stay
 * valid) and resolve via copy.ts against it.
 */
import type { ConversationSummary, TimelineRendererProps, ToolViewProps } from '@helmx/protocol'
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale } from '@helmx/plugin-client'

import { SA_OUTCOME_UNKNOWN } from './copy.ts'

/** SuperAgentIndexDoc (public doc 'index'). */
export interface SuperAgentIndexDoc {
  version: 1
  routerConversationId?: number
  watchdogConversationId?: number
  workers: Array<{ conversationId: number; parentConversationId: number; profileId: string; createdAt: number }>
}

/** ThreadSubscriptionDoc (public doc 'subscriptions'). */
export interface ThreadSubscriptionDoc {
  version: 1
  subscriptions: Array<{ threadKey: string; workerConversationId: number; createdAt: number }>
}

/** RecallGraphDoc (public doc 'recall-graph'). */
export interface RecallGraphDoc {
  version: 1
  nodes: Array<{
    id: string
    conversationId: number
    profileId: string
    completionSeq: number
    outcome: string
    summary: string
    artifacts: Array<{ id: string; name: string; size: number }>
    createdAt: number
  }>
}

/** RouterModeDoc (public doc 'routing'). */
export interface RouterModeDoc {
  version: 1
  routerMode: boolean
}

/** Read the doc and leniently parse the workers array (undefined → empty list, never fabricated). */
export function parseWorkers(doc: SuperAgentIndexDoc | undefined): SuperAgentIndexDoc['workers'] {
  return Array.isArray(doc?.workers) ? doc!.workers : []
}

export function parseSubscriptions(doc: ThreadSubscriptionDoc | undefined): ThreadSubscriptionDoc['subscriptions'] {
  return Array.isArray(doc?.subscriptions) ? doc!.subscriptions : []
}

export function parseRecallNodes(doc: RecallGraphDoc | undefined): RecallGraphDoc['nodes'] {
  return Array.isArray(doc?.nodes) ? doc!.nodes : []
}

export function parseRouterMode(doc: RouterModeDoc | undefined): boolean | undefined {
  return typeof doc?.routerMode === 'boolean' ? doc!.routerMode : undefined
}

/** Shape of worker-report timeline entry.data.meta (server submitInput meta projection). */
interface WorkerReportMeta {
  renderer?: string
  workerId?: number
  profileId?: string
  outcome?: string
  completionSeq?: number
  summary?: string
  artifacts?: Array<{ id: string; name: string; size: number }>
}

/** Extract the worker-report meta from TimelineRendererProps.entry (missing fields stay undefined). */
export function workerReportMeta(props: TimelineRendererProps): WorkerReportMeta {
  const data = props.entry.data as { meta?: WorkerReportMeta } | undefined
  return data?.meta ?? {}
}

/** Shape of a dispatch_worker tool-call input. */
interface DispatchToolInput {
  prompt?: string
  profileId?: string
  title?: string
  threadKey?: string
}

/** Leniently parse the dispatch_worker tool input. */
export function dispatchInput(props: ToolViewProps): DispatchToolInput {
  const input = props.input
  if (typeof input !== 'object' || input === null) return {}
  const raw = input as Record<string, unknown>
  const out: DispatchToolInput = {}
  if (typeof raw.prompt === 'string') out.prompt = raw.prompt
  if (typeof raw.profileId === 'string') out.profileId = raw.profileId
  if (typeof raw.title === 'string') out.title = raw.title
  if (typeof raw.threadKey === 'string') out.threadKey = raw.threadKey
  return out
}

/** workerConversationId from the dispatch_worker tool result (present once done; missing stays undefined). */
export function dispatchedWorkerId(props: ToolViewProps): number | undefined {
  const raw = props.structuredOutput as { workerConversationId?: unknown } | undefined
  const id = raw?.workerConversationId
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined
}

/** Outcome badge tone: completed→ok, failed→err, aborted→warn, anything else→neutral. */
export function outcomeTone(outcome: string | undefined): 'ok' | 'err' | 'warn' | 'neutral' {
  if (outcome === 'completed') return 'ok'
  if (outcome === 'failed') return 'err'
  if (outcome === 'aborted') return 'warn'
  return 'neutral'
}

/**
 * Outcome display text: raw outcome identifiers pass through verbatim; a
 * missing outcome resolves to the localized "Unknown" placeholder.
 */
export function outcomeLabel(outcome: string | undefined, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  if (outcome === undefined || outcome === '') return resolveLocalizedText(SA_OUTCOME_UNKNOWN, locale)
  return outcome
}

/** Build a lookup map from conversation id to summary (over live useConversations()). */
export function buildConversationMap(conversations: ReadonlyArray<ConversationSummary>): Map<number, ConversationSummary> {
  const map = new Map<number, ConversationSummary>()
  for (const c of conversations) {
    map.set(c.id, c)
  }
  return map
}

/**
 * Resolve a meaningful conversation title from the live summaries map.
 * Returns undefined when the conversation is missing (deleted/archived), blank,
 * or only holds a default placeholder (`subagent N` / `子代理 N` / `子会话 N`)
 * so callers render `#N` honestly without fabricating a name.
 */
export function resolveConversationTitle(
  conversationsById: ReadonlyMap<number, ConversationSummary>,
  conversationId: number,
): string | undefined {
  const conv = conversationsById.get(conversationId)
  if (conv === undefined) return undefined
  const trimmed = conv.title.trim()
  if (trimmed === '') return undefined
  if (
    trimmed.toLowerCase() === `subagent ${conversationId}` ||
    trimmed === `子代理 ${conversationId}` ||
    trimmed === `子会话 ${conversationId}`
  ) {
    return undefined
  }
  return trimmed
}
