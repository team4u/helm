/**
 * Pure logic for the builtin:workflow client: presentation summaries for
 * unified execution tree nodes — titles, compact-row total durations,
 * frontline activity and descendant approval digests (zero React/DOM
 * dependencies).
 */
import { DEFAULT_HELM_LOCALE, resolveLocalizedText, type HelmLocale } from '@helm/plugin-client'
import type { ExecutionNode } from './model-execution-tree.ts'
import { compactCardTitle } from './model-subagent-card.ts'
import {
  extractCleanPreviewLine,
  firstLineOf,
  isPlaceholderNodeLabel,
  isPlaceholderRunName,
  stripStructuredOutputContract,
} from './model-format.ts'
import { resolveNodeElapsedMs, resolveRunElapsedMs, resolveWorkflowRunDisplayName } from './model-run.ts'
import {
  execApprovalItem,
  execApprovalItemNamed,
  execConversationTitle,
  EXEC_EXTERNAL_FALLBACK,
  execFrontlineContainer,
  execFrontlineConversation,
  execFrontlineNamed,
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

/** Extract a meaningful human-readable node name when available (undefined when only placeholder/id exists). */
export function readableExecutionNodeName(node: ExecutionNode): string | undefined {
  const label = node.label ?? node.runNode?.label
  if (node.kind === 'conversation') {
    const custom = compactCardTitle(node.summary?.title, node.conversationId ?? 0)
    if (custom !== undefined) return custom
    if (!isPlaceholderNodeLabel(label)) return firstLineOf(label!, 60)
    if (node.run?.kind === 'subagent' && !isPlaceholderRunName(node.run.name, node.run.id)) {
      return firstLineOf(node.run.name, 60)
    }
    const prompt = node.runNode?.prompt ?? (node.run?.kind === 'subagent' ? node.run.nodes?.[0]?.prompt : undefined)
    if (prompt !== undefined && prompt.trim() !== '') {
      const cleaned = extractCleanPreviewLine(stripStructuredOutputContract(prompt), 60)
      if (cleaned !== '') return cleaned
    }
    return undefined
  }
  if (node.kind === 'workflow') {
    if (!isPlaceholderNodeLabel(node.label) && (node.run === undefined || node.label?.trim() !== node.run.id)) {
      return firstLineOf(node.label!, 60)
    }
    if (node.run !== undefined) {
      const resolved = resolveWorkflowRunDisplayName(node.run)
      if (resolved !== node.run.id) return resolved
    }
    return undefined
  }
  if (node.kind === 'external') {
    if (!isPlaceholderNodeLabel(node.label) && (node.run === undefined || node.label?.trim() !== node.run.id)) {
      return firstLineOf(node.label!, 60)
    }
    if (node.run !== undefined && !isPlaceholderRunName(node.run.name, node.run.id)) {
      return firstLineOf(node.run.name, 60)
    }
    const firstNode = node.run?.nodes?.[0]
    if (!isPlaceholderNodeLabel(firstNode?.label)) return firstLineOf(firstNode!.label!, 60)
    if (firstNode?.prompt !== undefined && firstNode.prompt.trim() !== '') {
      const cleaned = extractCleanPreviewLine(stripStructuredOutputContract(firstNode.prompt), 60)
      if (cleaned !== '') return cleaned
    }
    return undefined
  }
  // workflow-node
  if (!isPlaceholderNodeLabel(label)) return firstLineOf(label!, 60)
  if (node.runNode?.prompt !== undefined && node.runNode.prompt.trim() !== '') {
    const cleaned = extractCleanPreviewLine(stripStructuredOutputContract(node.runNode.prompt), 60)
    if (cleaned !== '') return cleaned
  }
  return undefined
}

/** Node display title: user title > run name / run node label / prompt > conversation and run fallbacks (never invented). */
export function executionNodeTitle(node: ExecutionNode, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const readable = readableExecutionNodeName(node)
  if (readable !== undefined) return readable
  if (node.kind === 'conversation') {
    return execConversationTitle(node.conversationId ?? 0, locale)
  }
  if (node.kind === 'workflow' && node.run !== undefined) {
    return resolveWorkflowRunDisplayName(node.run)
  }
  if (node.kind === 'workflow-node' && node.runNode !== undefined) {
    return node.runNode.id
  }
  return resolveLocalizedText(EXEC_EXTERNAL_FALLBACK, locale)
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
    const name = readableExecutionNodeName(node)
    const convId = node.conversationId ?? 0
    const doing = node.summary?.doing?.trim()
    if (doing !== undefined && doing !== '') {
      return name !== undefined ? execFrontlineNamed(name, convId, doing, locale) : `#${convId} ${doing}`
    }
    // No own doing and the subtree already has a deeper frontline: do not
    // repeat a placeholder fallback line (parent waiting states yield).
    if (hasDeeper) return undefined
    return name !== undefined
      ? execFrontlineNamed(name, convId, undefined, locale)
      : execFrontlineConversation(convId, locale)
  }
  // A container's (workflow / external run) own execution is its children:
  // skip when the subtree already has a deeper frontline.
  return hasDeeper
    ? undefined
    : execFrontlineContainer(
        readableExecutionNodeName(node) ?? node.run?.id ?? node.key,
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
        const title = readableExecutionNodeName(node)
        items.push({
          key: node.key,
          conversationId: node.conversationId,
          text:
            title !== undefined
              ? execApprovalItemNamed(title, node.conversationId, locale)
              : execApprovalItem(node.conversationId, locale),
        })
      }
      visit(node.children)
    }
  }
  visit(nodes)
  return items
}
