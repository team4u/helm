/**
 * timeline item and conversation real-time view pure function means layer.
 *
 * responsibility (mechanism, without policy):
 * - toConversationEntry:SDK EntryRecord -> protocol ConversationEntry unify means
 *   (id rotate string,kind/data/model original keep, boundary JSON available validate reject non- JSON value);
 *   HTTP detail situation and conversation.entry real-time event shared use the same function, guarantee two end shape consistent.
 * - deriveConversationLive:SDK LiveState(pi.live document)-> protocol ConversationLive
 *   (streaming assist manually text cumulative snapshot + tool card state).
 *
 * note:model message must keep (assistant text in model in, do not in data),
 * otherwise pi.assistant text in HTTP detail situation and real-time event in lose.
 */

import {
  HelmError,
  type ConversationEntry,
  type ConversationLive,
  type ConversationLiveGeneration,
  type ConversationLiveMessage,
  type QueuedConversationInput,
} from '@helm/protocol'

/** SDK EntryRecord structure sub- collection (avoid dependency SDK specific type, test can construct faux shape). */
export interface EntryRecordLike {
  readonly id: number | string
  readonly kind: string
  readonly model?: readonly unknown[]
  readonly data?: unknown
  readonly byTaskId?: number
}

/** recursion reject non- JSON value (loop,Date,Map,undefined field etc.), never static default convert. */
function assertJsonUsable(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new HelmError('invalid_json_value', `entry.${path} contains non- finite number, cannot as JSON event publish`, 500)
    }
    return
  }
  if (typeof value !== 'object') {
    throw new HelmError('invalid_json_value', `entry.${path} contains non- JSON value (${typeof value})`, 500)
  }
  const obj = value as object
  if (seen.has(obj)) {
    throw new HelmError('invalid_json_value', `entry.${path} contains loop reference`, 500)
  }
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => assertJsonUsable(item, `${path}[${i}]`, seen))
      return
    }
    const proto = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) {
      throw new HelmError('invalid_json_value', `entry.${path} contains non- JSON object (${proto.constructor?.name ?? 'unknown'})`, 500)
    }
    for (const [key, item] of Object.entries(obj)) {
      if (item === undefined) {
        throw new HelmError('invalid_json_value', `entry.${path}.${key} contains undefined value`, 500)
      }
      assertJsonUsable(item, `${path}.${key}`, seen)
    }
  } finally {
    seen.delete(obj)
  }
}

/**
 * SDK EntryRecord -> protocol ConversationEntry.
 * - id unify rotate string(protocol contract);
 * - kind/data/model original keep (model is model context message array,assistant text in among them);
 * - taskId:byTaskId is positive integer when throw shoot (append the entry generate task;scheduler
 *   context etc. without ownership when default, never fabricate);
 * - boundary JSON available validate: non- JSON value explicit throw HelmError, not silently fall back, do not fabricate truncate.
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
  // boundary validate:kind of outside payload must whole can JSON serialization (HTTP/SSE shared use exit).
  assertJsonUsable(entry, 'payload', new WeakSet())
  return entry
}

/** tool card state mapping:SDK tool slot -> protocol three state. */
type LiveToolState = ConversationLive['tools'][number]

function slotStatusOf(status: unknown): LiveToolState['status'] {
  return status === 'done' ? 'done' : 'running'
}

/** streaming assistant message -> cumulative visible text (text chunk by order concatenate; snapshot semantics, client whole replace). */
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

/** streaming assistant message -> cumulative think text (thinking chunk by order concatenate; snapshot semantics). */
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
 * SDK generation(pi.live generation field)-> protocol subject to limit throw shadow (through use fact, zero policy).
 * - taskId from same snapshot live.run.taskId(generation actual which belong generate task): missing or
 *   non- positive integer when whole omit generation- - identity cannot fabricate, without identity streaming fact cannot related;
 * - attempt non- positive integer when same whole omit;
 * - message only keep content subject to limit chunk (text/thinking/toolCall name+arguments) and
 *   provider cumulative usage.output(correct finite count); without valid content chunk when message omit;
 * - do not pass-through other field (timestamp/model metadata do not outside leak, rate policy independent of they).
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

/** partial assistant message -> subject to limit JSON-safe throw shadow; without valid content chunk return undefined. */
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

/** pi.inbox queued items structure sub- collection (tracker pass; shape illegal items directly skip, do not fabricate). */
export interface InboxItemLike {
  readonly id: number | string
  readonly mode?: string
  readonly entry?: { kind?: string; data?: unknown }
}

/** inbox queued items -> QueuedConversationInput; non- helm.input / illegal payload return undefined. */
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

/** queue up input sort:steer all arrange in followUp before (same mode keep original order). */
function sortQueuedInputs(items: QueuedConversationInput[]): void {
  const rank = (mode: QueuedConversationInput['mode']): number => (mode === 'steer' ? 0 : 1)
  items.sort((a, b) => rank(a.mode) - rank(b.mode))
}

/**
 * SDK LiveState(pi.live document value)-> protocol ConversationLive.
 * - text:generation.message.content in text chunk cumulative snapshot (client replace style render);
 * - tools: model start tool round (tools) and embed set invoke (nestedTools) unify mapping;
 *   input take slot run parameter (model start invoke parameter in assistant entry,slot 
 *   arguments/output only embed set invoke carry), result text does not enter live(detail situation away entry);
 * - generation: through use streaming fact (taskId + attempt + subject to limit message throw shadow), supply rate class
 *   plugin policy consume;taskId take same snapshot live.run.taskId(without identity do not throw shadow);
 *   kernel zero rate compute;
 * - queuedInputs: from pi.inbox queue up items derive await takes effect input manifest (steer takes precedence),
 *   without queue up items when omit.
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
