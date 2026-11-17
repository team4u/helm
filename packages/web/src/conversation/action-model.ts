/**
 * Pure-function matching and payload construction for UI actions (ctx.ui.action:
 * the conversation:header / conversation:row / timeline:entry micro-slots).
 *
 * Contract highlights:
 * - Every micro-slot is filtered by matchesUiScope(spec.scope, conversation);
 * - action-only (actionId without client): the host renders the standard minimal
 *   icon button / menu item; when client is declared an inline <PluginUiView /> renders;
 * - Action payloads follow the actual context: conversationId / entryId are force-injected
 *   by the host and override same-named spec.input fields (spec.input cannot forge a target
 *   conversation or entry);
 * - Invocation addressing uses actionPluginId ?? pluginId.
 */
import type {
  ConversationEntry,
  ConversationSummary,
  UiActionSpec,
} from '@helm/protocol/browser'
import { matchesUiScope, type QualifiedUiSpec, type QualifiedUiActionSpec } from '../lib/types.js'

/** action-only check for a UI action: no client declared, executes via actionId alone. */
export function isActionOnlyActionSpec(spec: UiActionSpec): boolean {
  return spec.actionId !== undefined && spec.client === undefined
}

/** Conversation-level UI action filter: target + scope hit + an execution track declared (at least one of actionId / client). */
export function matchConversationActions(
  actions: ReadonlyArray<QualifiedUiActionSpec> | undefined,
  target: UiActionSpec['target'],
  conversation: ConversationSummary | undefined,
): Array<QualifiedUiActionSpec> {
  if (!actions || conversation === undefined) return []
  return actions.filter(
    (a) =>
      a.target === target &&
      matchesUiScope(conversation, a.spec.scope) &&
      (a.spec.actionId !== undefined || a.spec.client !== undefined),
  )
}

/** Group header actions by placement: 'toolbar' renders directly; 'menu' (default) goes into the "more actions" dropdown. */
export function splitConversationHeaderActions(
  actions: ReadonlyArray<QualifiedUiActionSpec>,
): {
  toolbar: Array<QualifiedUiActionSpec>
  menu: Array<QualifiedUiActionSpec>
} {
  const toolbar: Array<QualifiedUiActionSpec> = []
  const menu: Array<QualifiedUiActionSpec> = []
  for (const a of actions) {
    if (a.spec.placement === 'toolbar') toolbar.push(a)
    else menu.push(a)
  }
  return { toolbar, menu }
}

/** Entry matching context for timeline:entry. */
export interface TimelineEntryActionContext {
  /** Entry kind (e.g. 'pi.user', 'pi.assistant', 'helm.input'). */
  kind: string
  /** Text message role: 'user' | 'assistant'; undefined for non-text entries. */
  role?: 'user' | 'assistant'
}

/**
 * Real ConversationEntry -> timeline:entry matching context: kind comes verbatim
 * from the real entry; text message entries carry a role (pi.user / helm.input ->
 * user, pi.assistant -> assistant); other entries (custom kinds, pi.tool-result,
 * etc.) have no role, so actions declaring roles never match them.
 */
export function timelineEntryActionContextOf(entry: ConversationEntry): TimelineEntryActionContext {
  if (entry.kind === 'pi.user' || entry.kind === 'helm.input') return { kind: entry.kind, role: 'user' }
  if (entry.kind === 'pi.assistant') return { kind: entry.kind, role: 'assistant' }
  return { kind: entry.kind }
}

/**
 * Single timeline:entry match decision:
 * - when kinds is provided it must include entry.kind (default matches all entries);
 * - when roles is provided it must include the entry role (default does not filter by
 *   role; role-less entries match only when roles is omitted).
 */
export function matchesTimelineEntryAction(
  spec: UiActionSpec,
  entry: TimelineEntryActionContext,
): boolean {
  const kinds = spec.kinds
  if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.includes(entry.kind))) return false
  const roles = spec.roles
  if (roles !== undefined) {
    if (entry.role === undefined) return false
    if (!roles.includes(entry.role)) return false
  }
  return true
}

/** timeline:entry filter: target + scope + execution track + kinds/roles. */
export function matchTimelineEntryActions(
  actions: ReadonlyArray<QualifiedUiActionSpec> | undefined,
  conversation: ConversationSummary | undefined,
  entry: TimelineEntryActionContext,
): Array<QualifiedUiActionSpec> {
  if (!actions || conversation === undefined) return []
  return actions.filter(
    (a) =>
      a.target === 'timeline:entry' &&
      matchesUiScope(conversation, a.spec.scope) &&
      (a.spec.actionId !== undefined || a.spec.client !== undefined) &&
      matchesTimelineEntryAction(a.spec, entry),
  )
}

/**
 * Build the action invocation payload: the actual context force-overrides same-named
 * spec.input fields. spec.input may add arbitrary extra fields, but conversationId /
 * entryId always come from the host's real context: a plugin declaration cannot forge
 * the target conversation; without an entryId context the conversation-level payload
 * also drops (not passes through) any forged entryId from spec.input.
 */
export function buildMicroActionInput(
  spec: { input?: Record<string, unknown> },
  context: { conversationId: number; entryId?: string },
): Record<string, unknown> {
  const { entryId: _forged, ...rest } = spec.input ?? {}
  void _forged
  return {
    ...rest,
    conversationId: context.conversationId,
    ...(context.entryId !== undefined ? { entryId: context.entryId } : {}),
  }
}

/** Target plugin for an action invocation: actionPluginId override, defaulting to the contributing plugin. */
export function microActionPluginId(spec: { actionPluginId?: string }, fallbackPluginId: string): string {
  return spec.actionPluginId ?? fallbackPluginId
}
