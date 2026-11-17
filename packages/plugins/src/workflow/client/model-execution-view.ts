/**
 * Pure logic for the builtin:workflow client: presentation summaries for
 * unified execution tree nodes — titles, compact-row total durations,
 * frontline activity and descendant approval digests (zero React/DOM
 * dependencies).
 */
import { DEFAULT_HELM_LOCALE, resolveLocalizedText, type HelmLocale } from '@helm/plugin-client'
import type { ExecutionNode } from './model-execution-tree.ts'
import { compactCardTitle } from './model-subagent-card.ts'
import { firstLineOf } from './model-format.ts'
import { resolveNodeElapsedMs, resolveRunElapsedMs } from './model-run.ts'
import {
  execApprovalItem,
  execConversationTitle,
  EXEC_EXTERNAL_FALLBACK,
  execFrontlineContainer,
  execFrontlineConversation,
} from './copy.ts'

/**
 * Compact-row total duration of an execution tree node: runNode real
 * boundaries first (running advances with startedAt + nowMs, settled freezes
 * at durationMs); container rows without a runNode (deep workflow / external)
 * and conversation rows carrying a background run use run boundaries; pure
 * conversation nodes without a reliable turn boundary (the conversation
 * createdAt is not a turn boundary) return undefined — never fabricated.
 */
export function resolveExecutionNodeElapsedMs(
  node: Pick<ExecutionNode, 'run' | 'runNode'>,
  nowMs?: number,
): number | undefined {
  if (node.runNode !== undefined) return resolveNodeElapsedMs(node.runNode, nowMs)
  if (node.run !== undefined) return resolveRunElapsedMs(node.run, nowMs)
  return undefined
}

/** Node display title: user title > run node label / prompt > conversation and run fallbacks (never invented). */
export function executionNodeTitle(node: ExecutionNode, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const label = node.label ?? node.runNode?.label
  if (node.kind === 'conversation') {
    const custom = compactCardTitle(node.summary?.title, node.conversationId ?? 0)
    if (custom !== undefined) return custom
    if (label !== undefined && label.trim() !== '' && label.trim() !== 'subagent') return firstLineOf(label, 60)
    const prompt = node.runNode?.prompt
    if (prompt !== undefined && prompt.trim() !== '') return firstLineOf(prompt, 60)
    return execConversationTitle(node.conversationId ?? 0, locale)
  }
  if (label !== undefined && label.trim() !== '') return firstLineOf(label, 60)
  return node.run?.name ?? resolveLocalizedText(EXEC_EXTERNAL_FALLBACK, locale)
}

/** Frontline activity item: one-line summary of a node currently executing inside the subtree. */
export interface ExecutionFrontlineItem {
  key: string
  conversationId?: number
  text: string
}

function executionFrontlineText(node: ExecutionNode, hasDeeper: boolean, locale: HelmLocale): string | undefined {
  if (node.status !== 'working') return undefined
  if (node.kind === 'conversation') {
    const doing = node.summary?.doing?.trim()
    if (doing !== undefined && doing !== '') return `#${node.conversationId} ${doing}`
    // No own doing and the subtree already has a deeper frontline: do not
    // repeat a placeholder fallback line (parent waiting states yield).
    return hasDeeper ? undefined : execFrontlineConversation(node.conversationId ?? 0, locale)
  }
  // A container's (workflow / external run) own execution is its children:
  // skip when the subtree already has a deeper frontline.
  return hasDeeper
    ? undefined
    : execFrontlineContainer(
        node.runNode?.label ?? node.label ?? node.run?.name ?? node.key,
        locale,
      )
}

/**
 * Frontline activity digest: post-order depth-first (deepest active frontline
 * first), at most limit items; the same node key is collected once (multiple
 * historical references do not repeat). Own real work (doing) stays after the
 * deeper frontline.
 */
export function collectExecutionFrontline(
  nodes: ReadonlyArray<ExecutionNode>,
  limit = 2,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): ExecutionFrontlineItem[] {
  const items: ExecutionFrontlineItem[] = []
  const seen = new Set<string>()
  const visit = (list: ReadonlyArray<ExecutionNode>): void => {
    for (const node of list) {
      if (items.length >= limit) return
      const before = items.length
      visit(node.children)
      if (items.length >= limit) return
      if (seen.has(node.key)) continue
      const text = executionFrontlineText(node, items.length > before, locale)
      if (text !== undefined) {
        seen.add(node.key)
        items.push({
          key: node.key,
          text,
          ...(node.conversationId !== undefined ? { conversationId: node.conversationId } : {}),
        })
      }
    }
  }
  visit(nodes)
  return items
}

/** Descendant approval item (pendingAsk titles are not in the conversation list data; only the conversation id is shown, honestly). */
export interface ExecutionApprovalItem {
  key: string
  conversationId?: number
  text: string
}

/**
 * Descendant approval digest: blocked conversation nodes in the subtree
 * (pendingAskCount>0 or status=blocked, both normalized to blocked by the
 * tree builder), at most limit items; the same node key never repeats.
 */
export function collectExecutionApprovals(
  nodes: ReadonlyArray<ExecutionNode>,
  limit = 3,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): ExecutionApprovalItem[] {
  const items: ExecutionApprovalItem[] = []
  const seen = new Set<string>()
  const visit = (list: ReadonlyArray<ExecutionNode>): void => {
    for (const node of list) {
      if (items.length >= limit) return
      if (
        node.status === 'blocked' && node.kind === 'conversation' && node.conversationId !== undefined &&
        !seen.has(node.key)
      ) {
        seen.add(node.key)
        const title = compactCardTitle(node.summary?.title, node.conversationId)
        items.push({
          key: node.key,
          conversationId: node.conversationId,
          text: title !== undefined ? `#${node.conversationId} ${title}` : execApprovalItem(node.conversationId, locale),
        })
      }
      visit(node.children)
    }
  }
  visit(nodes)
  return items
}
