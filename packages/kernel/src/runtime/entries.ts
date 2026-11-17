/**
 * Pure translation layer for timeline entries and conversation live views.
 *
 * Responsibilities (mechanism, zero policy):
 * - toConversationEntry: unified mapping from SDK EntryRecord -> protocol ConversationEntry
 *   (converts id to string, preserves kind/data/model verbatim, validates JSON serializability at boundary);
 *   shared identically between HTTP detail and live conversation.entry events so both ends match.
 * - deriveConversationLive: SDK LiveState (pi.live document) -> protocol ConversationLive
 *   (accumulated streaming assistant text snapshot + tool card states).
 *
 * Note: model messages must be preserved (assistant text lives in model, not in data),
 * otherwise pi.assistant text is lost in both HTTP details and live events.
 */

import {
  HelmError,
  type ConversationEntry,
  type ConversationLive,
  type ConversationLiveGeneration,
  type ConversationLiveMessage,
  type QueuedConversationInput,
} from '@helm/protocol'

/** Subset of SDK EntryRecord shape (avoids coupling to SDK concrete types; easy to fake in tests). */
export interface EntryRecordLike {
  readonly id: number | string
  readonly kind: string
  readonly model?: readonly unknown[]
  readonly data?: unknown
  readonly byTaskId?: number
}

/** Recursively reject non-JSON values (cycles, Date, Map, undefined fields, etc.) without silent conversion. */
function assertJsonUsable(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new HelmError('invalid_json_value', `entry.${path} contains a non-finite number and cannot be published as a JSON event`, 500)
    }
    return
  }
  if (typeof value !== 'object') {
    throw new HelmError('invalid_json_value', `entry.${path} contains a non-JSON value (${typeof value})`, 500)
  }
  const obj = value as object
  if (seen.has(obj)) {
    throw new HelmError('invalid_json_value', `entry.${path} contains a circular reference`, 500)
  }
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => assertJsonUsable(item, `${path}[${i}]`, seen))
      return
    }
    const proto = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) {
      throw new HelmError('invalid_json_value', `entry.${path} contains a non-JSON object (${proto.constructor?.name ?? 'unknown'})`, 500)
    }
    for (const [key, item] of Object.entries(obj)) {
      if (item === undefined) {
        throw new HelmError('invalid_json_value', `entry.${path}.${key} contains undefined`, 500)
      }
      assertJsonUsable(item, `${path}.${key}`, seen)
    }
  } finally {
    seen.delete(obj)
  }
}

/**
 * SDK EntryRecord -> protocol ConversationEntry.
 * - Normalizes id to string (protocol contract);
 * - Preserves kind/data/model verbatim (model holds context message arrays including assistant text);
 * - taskId: mapped from positive integer byTaskId (generating task; omitted when unowned such as scheduler context, never fabricated);
 * - Boundary JSON validation: throws HelmError on non-JSON values with no silent fallback or truncation.
 */
export function toConversationEntry(record: EntryRecordLike): ConversationEntry {
  if (typeof record.id !== 'number' && typeof record.id !== 'string') {
    throw new HelmError('invalid_json_value', `entry.id must be number|string, got ${typeof record.id}`, 500)
  }
  if (typeof record.kind !== 'string') {
    throw new HelmError('invalid_json_value', `entry.kind must be string, got ${typeof record.kind}`, 500)
  }
  const taskId =
    typeof record.byTaskId === 'number' && Number.isInteger(record.byTaskId) && record.byTaskId > 0
      ? record.byTaskId
      : undefined
  const entry: ConversationEntry = {
    id: String(record.id),
    kind: record.kind,
    ...(record.data !== undefined ? { data: record.data } : {}),
    ...(record.model !== undefined ? { model: [...record.model] } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  }
  // Boundary check: entire payload besides kind must be JSON-serializable (shared HTTP/SSE exit).
  assertJsonUsable(entry, 'payload', new WeakSet())
  return entry
}

/** Tool card state mapping: SDK tool slot -> protocol status. */
type LiveToolState = ConversationLive['tools'][number]

function slotStatusOf(status: unknown): LiveToolState['status'] {
  return status === 'done' ? 'done' : 'running'
}

/** Streaming assistant message -> accumulated visible text (concatenates text blocks in order; full-snapshot semantics). */
function streamedTextOf(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      text += (block as { text: string }).text
    }
  }
  return text
}

/** Streaming assistant message -> accumulated thinking text (concatenates thinking blocks in order; snapshot semantics). */
function streamedThinkingOf(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  let thinking = ''
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'thinking' &&
      typeof (block as { thinking?: unknown }).thinking === 'string'
    ) {
      thinking += (block as { thinking: string }).thinking
    }
  }
  return thinking
}

function toolInputOf(slot: { arguments?: unknown } | { input?: unknown }): unknown {
  if ('arguments' in slot) return slot.arguments
  return (slot as { input?: unknown }).input
}

/**
 * SDK generation (pi.live generation field) -> protocol constrained projection (generic facts, zero policy).
 * - taskId comes from live.run.taskId in the same snapshot (the generating task): omitted wholesale when missing or
 *   non-positive integer—identities cannot be fabricated, and streaming facts cannot be correlated without an identity;
 * - attempt non-positive integer similarly omits generation wholesale;
 * - message preserves only constrained content blocks (text / thinking / toolCall name+arguments) and provider
 *   cumulative usage.output (positive finite number); omitted when no valid content blocks exist;
 * - drops all other fields (never leaks timestamps or model metadata; rate calculation plugins do not depend on them).
 */
export function liveGenerationOf(
  generation: { attempt?: unknown; message?: unknown } | undefined,
  runTaskId: unknown,
): ConversationLiveGeneration | undefined {
  if (generation === null || typeof generation !== 'object') return undefined
  const attempt = (generation as { attempt?: unknown }).attempt
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt <= 0) return undefined
  if (typeof runTaskId !== 'number' || !Number.isInteger(runTaskId) || runTaskId <= 0) return undefined
  const message = liveMessageOf((generation as { message?: unknown }).message)
  return { taskId: runTaskId, attempt, ...(message !== undefined ? { message } : {}) }
}

/** Partial assistant message -> constrained JSON-safe projection; returns undefined if no valid blocks exist. */
function liveMessageOf(message: unknown): ConversationLiveMessage | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const blocks: ConversationLiveMessage['content'] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      blocks.push({ type: 'text', text: b.text })
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      blocks.push({ type: 'thinking', thinking: b.thinking })
    } else if (b.type === 'toolCall' && typeof b.name === 'string') {
      blocks.push({ type: 'toolCall', name: b.name, ...('arguments' in b ? { arguments: b.arguments } : {}) })
    }
  }
  if (blocks.length === 0) return undefined
  const output = (message as { usage?: { output?: unknown } }).usage?.output
  const usage =
    typeof output === 'number' && Number.isFinite(output) && output > 0
      ? { output }
      : undefined
  return { content: blocks, ...(usage !== undefined ? { usage } : {}) }
}

/** Subset of pi.inbox queued item shape (passed from tracker; malformed items are skipped without fabrication). */
export interface InboxItemLike {
  readonly id: number | string
  readonly mode?: string
  readonly entry?: { kind?: string; data?: unknown }
}

/** Inbox queued item -> QueuedConversationInput; returns undefined for non-helm.input or invalid payloads. */
function queuedInputOf(item: InboxItemLike, fallbackCreatedAt: number): QueuedConversationInput | undefined {
  if (item.mode !== 'steer' && item.mode !== 'followUp') return undefined
  if (item.entry?.kind !== 'helm.input') return undefined
  const data = item.entry.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const d = data as Record<string, unknown>
  if (typeof d['id'] !== 'string' || typeof d['text'] !== 'string') return undefined
  const origin = d['origin'] === 'agent' || d['origin'] === 'trigger' ? d['origin'] : 'human'
  const createdAt =
    typeof d['createdAt'] === 'number' && Number.isFinite(d['createdAt']) ? d['createdAt'] : fallbackCreatedAt
  const attachments = Array.isArray(d['attachments']) && d['attachments'].length > 0 ? d['attachments'] : undefined
  return {
    id: d['id'],
    submissionId: String(item.id),
    text: d['text'],
    mode: item.mode,
    origin,
    createdAt,
    ...(attachments !== undefined ? { attachments: attachments as QueuedConversationInput['attachments'] } : {}),
  }
}

/** Sort queued inputs: all steer items precede followUp items (preserving original order within each mode). */
function sortQueuedInputs(items: QueuedConversationInput[]): void {
  const rank = (mode: QueuedConversationInput['mode']): number => (mode === 'steer' ? 0 : 1)
  items.sort((a, b) => rank(a.mode) - rank(b.mode))
}

/**
 * SDK LiveState (pi.live document) -> protocol ConversationLive.
 * - text: accumulated snapshot of text blocks inside generation.message.content (client replaces whole text);
 * - tools: unified projection of top-level tool rounds (tools) and nested calls (nestedTools);
 *   inputs come from slot arguments/input (model call args live in assistant entries; slot arguments/output are set
 *   only for nested calls), while result texts stay out of live views (details belong in entries);
 * - generation: generic streaming facts (taskId + attempt + constrained message projection) consumed by rate-display
 *   plugins; taskId comes from live.run.taskId in the same snapshot (omitted if absent); zero rate calculations in kernel;
 * - queuedInputs: pending inputs derived from pi.inbox (steer first), omitted when empty.
 */
export function deriveConversationLive(
  conversationId: number,
  live: {
    generation?: { attempt?: unknown; message?: unknown }
    run?: { taskId?: unknown }
    tools?: ReadonlyArray<{
      callId: string
      name: string
      status?: string
      arguments?: unknown
      input?: unknown
    }>
    nestedTools?: ReadonlyArray<{
      callId: string
      name: string
      status?: string
      arguments?: unknown
      input?: unknown
    }>
  } | undefined,
  updatedAt: number,
  inboxItems?: ReadonlyArray<InboxItemLike>,
): ConversationLive {
  const source = live ?? {}
  const tools: LiveToolState[] = []
  const collect = (slots: ReadonlyArray<{ callId: string; name: string; status?: string; arguments?: unknown; input?: unknown }> | undefined): void => {
    for (const slot of slots ?? []) {
      if (typeof slot?.callId !== 'string' || typeof slot?.name !== 'string') continue
      const input = toolInputOf(slot)
      tools.push({
        callId: slot.callId,
        toolName: slot.name,
        ...(input !== undefined ? { input } : {}),
        status: slotStatusOf(slot.status),
      })
    }
  }
  collect(source.tools)
  collect(source.nestedTools)
  const thinking = streamedThinkingOf(source.generation?.message)
  const generation = liveGenerationOf(source.generation, source.run?.taskId)
  const queuedInputs: QueuedConversationInput[] = []
  for (const item of inboxItems ?? []) {
    const queued = queuedInputOf(item, updatedAt)
    if (queued !== undefined) queuedInputs.push(queued)
  }
  sortQueuedInputs(queuedInputs)
  return {
    conversationId,
    text: streamedTextOf(source.generation?.message),
    ...(thinking !== '' ? { thinking } : {}),
    tools,
    ...(generation !== undefined ? { generation } : {}),
    ...(queuedInputs.length > 0 ? { queuedInputs } : {}),
    updatedAt,
  }
}
