/**
 * runtime sharing file level helpers(without state pure function).
 *
 * from runtime.ts split out: tool result contract,before_turn sections/messages manually technique,
 * rewind zone between parse,404 conversation validate etc. across module re- use small function.
 */
import { join } from 'node:path'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import type { ConversationSummary } from '@helm/protocol'
import type { Models } from '@earendil-works/pi-ai'
import { HelmError, safeResultText } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'
import type { ConvMeta } from './store.js'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { HelmStore } from './store.js'
import { requireModelRef } from './models.js'
import { assertProfileId, assertSkillId } from '../services/index.js'

// ---------------------------------------------------------------------------
// through use serialization / escaping
// ---------------------------------------------------------------------------

/** XML property/text escaping (defang guard against escape and ownership mark record shared use). */
export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** strip already has external_event package wrap (trigger transform after again defang guard against double heavy package wrap; keep package wrap outside append text). */
export function stripEnvelope(text: string): string {
  const match = /[\s\S]*?<external_event[^>]*>\n([\s\S]*?)\n<\/external_event>([\s\S]*)/.exec(text)
  if (match === null) return text
  const body = match[1] ?? ''
  const tail = match[2] ?? ''
  const unescaped = body
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
  return tail.trim() === '' ? unescaped : `${unescaped}${tail}`
}

// ---------------------------------------------------------------------------
// conversation store in 404(all text dedupe public helper)
// ---------------------------------------------------------------------------

/** store.getConv + 404(all text duplicate 15+ where public converge). */
export function requireConv(store: HelmStore, id: number): NonNullable<ReturnType<HelmStore['getConv']>> {
  const meta = store.getConv(id)
  if (!meta) throw new HelmError('not_found', `conversation missing:${id}`, 404)
  return meta
}

// ---------------------------------------------------------------------------
// tool result contract helpers(plugin/hook artifact -> SDK ToolExecutionResult)
// ---------------------------------------------------------------------------

/**
 * plugin tool structure result message seal judge other condition (guard against any contains output field business object by mistakenly
 * identify is message seal): must at least contains output(string or array)/ structuredOutput /
 * isError three message seal field of one, and appear message seal field all type legal; any one message seal field
 * type illegal then explicit errors (is not when ordinary object static default away text channel - - tool act intent do not,
 * boundary reject optimal at guess).
 */
function envelopeProblem(raw: Record<string, unknown>): { isEnvelope: boolean; problem?: string } {
  const hasOutput = raw['output'] !== undefined
  const hasStructured = raw['structuredOutput'] !== undefined
  const hasError = raw['isError'] !== undefined
  if (!hasOutput && !hasStructured && !hasError) return { isEnvelope: false }
  if (hasOutput && typeof raw['output'] !== 'string' && !Array.isArray(raw['output'])) {
    return { isEnvelope: true, problem: 'output must be string or { type: \'text\', text } array' }
  }
  if (hasError && typeof raw['isError'] !== 'boolean') {
    return { isEnvelope: true, problem: 'isError must be boolean value' }
  }
  return { isEnvelope: true }
}

/**
 * plugin tool original return -> SDK ToolExecutionResult:
 * - structure result message seal { output, structuredOutput?, isError? }: only when appear message seal
 *   field all type legal when by message seal rule whole (text and structuredOutput all redaction;
 *   structuredOutput only in tool declaration structuredOutputSchema when keep);
 * - tool not declaration structuredOutputSchema yet return structuredOutput: explicit reject
 *   (invalid_tool_result, no longer static default discard - - data lose must let plugin act see see);
 * - the rest any value unify package single text chunk content(without schema do not pass structuredOutput).
 */
export function pluginToolResult(
  raw: unknown,
  redact: (text: string) => string,
  options?: { structuredOutputSchema?: unknown; toolName?: string; callId?: string },
): {
  output: Array<{ type: 'text'; text: string }>
  structuredOutput?: unknown
  details?: Record<string, unknown>
  isError?: boolean
} {
  const where = options?.toolName !== undefined
    ? `tool ${options.toolName}${options?.callId !== undefined ? `(callId=${options.callId})` : ''}`
    : 'plugin tool'
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const env = raw as { output?: unknown; structuredOutput?: unknown; isError?: unknown }
    const verdict = envelopeProblem(raw as Record<string, unknown>)
    if (verdict.isEnvelope) {
      if (verdict.problem !== undefined) {
        throw new HelmError(
          'invalid_tool_result',
          `${where} result message seal field type illegal:${verdict.problem}`,
          500,
        )
      }
      // output: string package single text chunk; array original validate after pass-through.
      let output: Array<{ type: 'text'; text: string }>
      if (typeof env.output === 'string') {
        output = [{ type: 'text', text: redact(env.output) }]
      } else if (Array.isArray(env.output)) {
        output = env.output.map((block) => {
          if (block === null || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text' || typeof (block as { text?: unknown }).text !== 'string') {
            throw new HelmError(
              'invalid_tool_result',
              `${where} result message seal output array only accept { type: 'text', text } chunk`,
              500,
            )
          }
          return { type: 'text' as const, text: redact((block as { text: string }).text) }
        })
      } else if (env.output === undefined) {
        output = []
      } else {
        throw new HelmError(
          'invalid_tool_result',
          `${where} result message seal output must be string or { type: 'text', text } array`,
          500,
        )
      }
      const result: {
        output: Array<{ type: 'text'; text: string }>
        structuredOutput?: unknown
        details?: Record<string, unknown>
        isError?: boolean
      } = {
        output,
      }
      // structuredOutput only in tool declaration schema when keep (SDK contract); value level redaction.
      // not declaration schema yet return structuredOutput: explicit reject (not silently lose data).
      if (env.structuredOutput !== undefined && options?.structuredOutputSchema === undefined) {
        throw new HelmError(
          'invalid_tool_result',
          `${where} not declaration structuredOutputSchema yet return structuredOutput(SDK contract forbidden; please declaration schema or change is pure output text)`,
          500,
        )
      }
      if (env.structuredOutput !== undefined && options?.structuredOutputSchema !== undefined) {
        const redacted = redactJsonValue(env.structuredOutput, redact)
        result.structuredOutput = redacted
        // pi-durable 仅持久化 details 通道至 transcript tool-result.model[0].details（structuredOutput 仅供内存 executeTool 调用方读取）；
        // 与内置 edit 工具保持一等公民契约一致，对象型结构化输出同步镜像到 details 供 Web Timeline / ToolViewProps.structuredOutput 消费。
        if (redacted !== null && typeof redacted === 'object' && !Array.isArray(redacted)) {
          result.details = redacted as Record<string, unknown>
        }
      }
      if (env.isError === true) result.isError = true
      return result
    }
  }
  // missed message seal judge other (without any message seal field, or field type all legal but a all not appear):
  // ordinary business value unify away text channel (without schema do not pass structuredOutput).
  return { output: [{ type: 'text', text: safeResultText(raw, redact) }] }
}

/** tool_call handled take over artifact -> legal ToolExecutionResult(illegal shape explicit error result). */
export function toolResultOf(handled: unknown): {
  output: Array<{ type: 'text'; text: string }>
  isError: boolean
} {
  const normalized = normalizeToolResult(handled)
  if (normalized !== undefined) {
    return normalized as { output: Array<{ type: 'text'; text: string }>; isError: boolean }
  }
  return {
    output: [{ type: 'text', text: 'tool_call handled hook return illegal result shape (already by error)' }],
    isError: true,
  }
}

/** tool_result transform artifact rule whole: must shape such as ToolExecutionResult, otherwise undefined(keep original result). */
export function normalizeToolResult(value: unknown): ToolExecutionResultShape | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as ToolExecutionResultShape
  if (candidate.output === undefined && candidate.structuredOutput === undefined && candidate.isError === undefined) {
    return undefined
  }
  // output must be content array (string package into single text chunk;SDK contract only accept array).
  if (typeof candidate.output === 'string') {
    return { ...candidate, output: [{ type: 'text', text: candidate.output }] }
  }
  if (candidate.output !== undefined && !Array.isArray(candidate.output)) return undefined
  return candidate
}

export interface ToolExecutionResultShape {
  output?: Array<{ type: string; text?: string }> | string
  structuredOutput?: JsonValue
  isError?: boolean
  details?: JsonValue
}

// ---------------------------------------------------------------------------
// before_turn sections / tools manually technique (SDK system before lead message change write)
// ---------------------------------------------------------------------------

/** from model message extract when before takes effect system sections(contains before lead declaration and after continue patch back put). */
export function systemSectionsOf(messages: ReadonlyArray<{ role?: string; sections?: unknown }>): Array<{ id: string; text: string }> {
  const sections = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'system' || message.sections === undefined) continue
    if (message.sections === null || typeof message.sections !== 'object') continue
    for (const [key, value] of Object.entries(message.sections as Record<string, unknown>)) {
      if (value === null) sections.delete(key)
      else if (typeof value === 'string') sections.set(key, value)
    }
  }
  return [...sections.entries()].map(([id, text]) => ({ id, text }))
}

/**
 *  before_turn final scoped active tools prompt metadata unify throw shoot enter sections:
 * - prompt.tools.<name>: each tool complete segment (promptSnippet);
 * - prompt.tools.guidelines: all promptGuidelines aggregate sharing segment;
 * - old same name segment whole override (deactivate plugin/strip tool do not phantom text); without any metadata
 *   tool collection produce empty throw shoot (clear all old segment);sections not change when original return reference.
 */
export function projectToolPromptSections(
  sections: ReadonlyArray<{ id: string; text: string }>,
  tools: ReadonlyArray<{ name: string; promptSnippet?: string; promptGuidelines?: string[] }>,
): Array<{ id: string; text: string }> {
  const snippets = tools.filter((t) => t.promptSnippet !== undefined)
  const guidelines = tools.filter((t) => t.promptGuidelines !== undefined)
  const desired = new Map<string, string>()
  for (const tool of snippets) {
    desired.set(`prompt.tools.${tool.name}`, tool.promptSnippet!)
  }
  if (guidelines.length > 0) {
    const lines = guidelines.flatMap((tool) => tool.promptGuidelines!.map((item) => `- ${tool.name}: ${item}`))
    desired.set('prompt.tools.guidelines', `available tool use want point:\n${lines.join('\n')}`)
  }
  const projectedIds = new Set([...desired.keys()])
  const isManaged = (id: string) =>
    id === 'prompt.tools.guidelines' || id.startsWith('prompt.tools.')
  let changed = false
  const out: Array<{ id: string; text: string }> = []
  for (const section of sections) {
    if (isManaged(section.id)) {
      const next = desired.get(section.id)
      if (next !== undefined) {
        out.push({ id: section.id, text: next })
        desired.delete(section.id)
        if (next !== section.text) changed = true
      } else {
        changed = true // remove phantom segment
      }
      continue
    }
    out.push(section)
  }
  for (const [id, text] of desired) {
    out.push({ id, text })
    changed = true
  }
  return changed ? out : (sections as Array<{ id: string; text: string }>)
}

/**
 * before_turn messages whole replace boundary validate (guard against system head corrupt and history fabricate):
 * - must be non-empty array and first is system message (SDK back put dependency before lead system);
 * - before lead system  content base bottom must and original message consistent (sections/toolsRemoved/
 *   toolsAdded etc. declaration field can change, person format body text never can override);
 * - original first non- system message start history must original order original keep (only allows in its after append,
 *   disallows truncate/heavy write/fabricate - - need to truncate clean away rewrite/reset channel).
 * violate rule one rule invalid_hook_result explicit reject, never static default adopt accept break change write.
 */
export function assertSafeMessageSurgery(
  original: ReadonlyArray<Record<string, unknown>>,
  replacement: unknown,
): Array<Record<string, unknown>> {
  const fail = (detail: string): HelmError =>
    new HelmError('invalid_hook_result', `before_turn messages change write out of bounds:${detail}`, 500)
  if (!Array.isArray(replacement) || replacement.length === 0) {
    throw fail('must be non-empty message array')
  }
  const lead = replacement[0]!
  if (lead['role'] !== 'system') {
    throw fail('first message must keep system(SDK back put mechanism dependency before lead system message)')
  }
  if (original.length === 0 || original[0]!['role'] !== 'system') {
    throw fail('original request missing before lead system message (kernel state exception, reject change write)')
  }
  if (contentTextOf(original[0]!) !== contentTextOf(lead)) {
    throw fail('before lead system message content base bottom by override (person format and history body text cannot change;sections/tools declaration please away declaration field)')
  }
  // history keep: original first non- system message start sub- sequence must original appear in replace result in (prefix align).
  let firstNonSystem = 0
  while (firstNonSystem < original.length && original[firstNonSystem]!['role'] === 'system') firstNonSystem += 1
  const historyLen = original.length - firstNonSystem
  const preservedHistory = replacement.slice(firstNonSystem, firstNonSystem + historyLen)
  if (historyLen > 0) {
    for (let i = 0; i < historyLen; i += 1) {
      if (preservedHistory[i] !== original[firstNonSystem + i]!) {
        throw fail('history message only allows in its after append, disallows truncate, heavy write or fabricate (truncate please away rewrite/reset channel)')
      }
    }
  }
  return replacement as Array<Record<string, unknown>>
}

/** system message content base bottom text (string or text chunk concatenate; and SDK back put opening path consistent). */
function contentTextOf(message: Record<string, unknown>): string {
  const content = message['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

export function sectionsEqual(a: Array<{ id: string; text: string }>, b: Array<{ id: string; text: string }>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.id !== b[i]!.id || a[i]!.text !== b[i]!.text) return false
  }
  return true
}

/**
 * before lead system message sections whole replace is desired(keep base content).
 * after continue system message sections patch already collapse enter desired, remove old patch avoid back put override.
 */
export function withSections(
  messages: ReadonlyArray<Record<string, unknown>>,
  desired: Array<{ id: string; text: string }>,
): Array<Record<string, unknown>> {
  if (messages.length === 0) return [...messages]
  const out: Array<Record<string, unknown>> = [...messages]
  const lead = out[0]!
  if (lead['role'] !== 'system') return out
  const previous = lead['sections']
  const previousKeys =
    previous !== null && typeof previous === 'object'
      ? Object.keys(previous as Record<string, unknown>)
      : []
  // new declaration collection; old key do not in new concentrate with null remove (back put semantics).
  const next: Record<string, string | null> = {}
  for (const [i, section] of desired.entries()) {
    void i
    next[section.id] = section.text
  }
  for (const key of previousKeys) {
    if (!(key in next)) next[key] = null
  }
  out[0] = { ...lead, sections: next }
  for (let i = 1; i < out.length; i += 1) {
    const message = out[i]!
    if (message['role'] !== 'system' || message['sections'] === undefined) continue
    const { sections: _sections, ...rest } = message
    out[i] = rest
  }
  return out
}

/**
 * tool collection change: in before lead system message append toolsRemoved/toolsAdded declaration.
 * model side by pi-ai back put mechanism parse (getCurrentTools), under one round i.e. takes effect.
 */
export function withToolDeclarations(
  messages: ReadonlyArray<Record<string, unknown>>,
  declared: Set<string>,
  tools: ReturnType<typeof getCurrentTools>,
): Array<Record<string, unknown>> {
  const available = new Map(tools.map((tool) => [tool.name, tool]))
  const added: Array<Record<string, unknown>> = []
  for (const name of declared) {
    const tool = available.get(name)
    if (!tool) throw new HelmError('unknown_tool', `before_turn choose not registered tool:${name}`, 500)
    added.push({ ...tool })
  }
  if (messages.length === 0 || messages[0]!['role'] !== 'system') return [...messages]
  const lead = messages[0]!
  // complete heavy declaration: remove all old declaration again add new collection (etc. price replay, guard against order drift).
  const next: Record<string, unknown> = { ...lead }
  const sections = lead['sections']
  next['sections'] =
    sections !== null && typeof sections === 'object'
      ? { ...(sections as Record<string, unknown>) }
      : {}
  next['toolsRemoved'] = currentToolNames(messages).filter((name) => declared.has(name) === false).map((name) => ({ name }))
  next['toolsAdded'] = added
  return [{ ...next }, ...messages.slice(1)]
}

/** back put message in when before tool name manifest. */
export function currentToolNames(messages: ReadonlyArray<Record<string, unknown>>): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message['role'] !== 'system') continue
    for (const tool of message['toolsAdded'] as Array<{ name?: string }> | undefined ?? []) {
      if (typeof tool?.name === 'string') names.add(tool.name)
    }
    for (const ref of message['toolsRemoved'] as Array<{ name?: string }> | undefined ?? []) {
      if (typeof ref?.name === 'string') names.delete(ref.name)
    }
  }
  return [...names]
}

// ---------------------------------------------------------------------------
// conversation summary fall back / error archive one
// ---------------------------------------------------------------------------

export function summaryOfFallback(
  meta: ConvMeta,
  status: ConversationSummary['status'],
  pendingAskCount: number,
): ConversationSummary {
  return {
    id: meta.id,
    title: meta.title,
    profileId: meta.profileId,
    tags: meta.tags,
    ...(meta as { parentConversationId?: number }).parentConversationId !== undefined
      ? { parentConversationId: (meta as { parentConversationId?: number }).parentConversationId }
      : {},
    cwd: meta.cwd,
    model: meta.model,
    thinkingLevel: meta.thinkingLevel,
    ...(meta.thinkingLevelOverride !== undefined ? { thinkingLevelOverride: meta.thinkingLevelOverride } : {}),
    status,
    stateChangeSeq: meta.stateChangeSeq,
    completionSeq: meta.completionSeq,
    unread: meta.unread,
    pinned: meta.pinned,
    pendingAskCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

export function normalizeBusyError(error: unknown): unknown {
  const name = (error as { name?: string })?.name
  if (name === 'ConversationBusy') {
    return new HelmError('conversation_busy', 'conversation correct busy and whenBusy=reject', 409)
  }
  if (name === 'ConversationIdle') {
    return new HelmError('conversation_idle', 'conversation idle and whenIdle=reject conflict', 409)
  }
  return error
}

export function entryModelText(entry: { model?: ReadonlyArray<{ content?: unknown }> }): string {
  const content = entry.model?.[0]?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/** entry.model message array -> assistant text chunk concatenate (waitForInput extract answer use). */
export function assistantTextOfModel(model: unknown[] | undefined): string {
  if (model === undefined) return ''
  const out: string[] = []
  for (const message of model) {
    const blocks = (message as { content?: ReadonlyArray<{ type: string; text?: string }> }).content
    if (!blocks) continue
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// rewind zone between (original ground override heavy contract)
// ---------------------------------------------------------------------------

/** helm.rewind truncate mark record declaration override zone between (closed zone between [from, through]).
 *
 * throughEntryId is new contract: override zone between inside most large old item ID, new input item ID must however
 * more large, never will by self household zone between mistakenly delete. */
export interface RewindInterval {
  from: number
  through: number
  marker: number
}

/** parse a purpose rewind zone between; non- rewind mark record or payload illegal return undefined. */
export function rewindIntervalOf(entry: { id: number | string; kind: string; data?: unknown }): RewindInterval | undefined {
  if (entry.kind !== 'helm.rewind') return undefined
  const data = entry.data as { fromEntryId?: unknown; throughEntryId?: unknown } | undefined
  const from = Number(data?.fromEntryId)
  if (!Number.isSafeInteger(from) || from <= 0) return undefined
  const marker = Number(entry.id)
  const through = Number(data?.throughEntryId)
  if (!Number.isSafeInteger(marker) || !Number.isSafeInteger(through) || through < from || through >= marker) {
    throw new HelmError('invalid_rewind_entry', `history override mark record ${entry.id} zone between invalid`, 500)
  }
  return { from, through, marker }
}

/** item is otherwise by any one rewind zone between override (detail situation throw shadow / FTS rebuild / lastAssistant clean up shared use). */
export function coveredByRewind(entryId: number, intervals: ReadonlyArray<RewindInterval>): boolean {
  return intervals.some((cut) => entryId >= cut.from && entryId <= cut.through)
}

/** edit target limit set: only allows override person class input item (agent/trigger inject and control item reject). */
export function assertEditableHumanInput(
  entry: { kind: string; data?: unknown },
  conversationId: number,
  entryId: number,
): void {
  if (entry.kind === 'pi.user') return
  if (entry.kind !== 'helm.input') {
    throw new HelmError(
      'entry_not_editable',
      `only support edit person class input item (item ${entryId} kind=${entry.kind})`,
      400,
      { conversationId, entryId, kind: entry.kind },
    )
  }
  const origin = (entry.data as { origin?: unknown } | undefined)?.origin
  if (origin !== 'human') {
    throw new HelmError(
      'entry_not_editable',
      `item ${entryId} source is ${String(origin)}, only person class input can original ground override heavy`,
      409,
      { conversationId, entryId, origin: String(origin) },
    )
  }
}

export type { ToolExecutionResult }

/** models-store.json start corrupt detect (open phase; semantics same ModelRegistry inside same name logic). */
export async function assertModelsStoreHealthyAtBoot(models: Models): Promise<void> {
  const result = await models.refresh({ allowNetwork: false })
  for (const [, err] of result.errors) {
    if (err instanceof HelmError && err.code === 'models_store_corrupted') {
      throw new HelmError(
        'models_store_corrupted',
        `models-store.json corrupt (read when discover):${err.message}`,
        500,
      )
    }
  }
}

/** text completion underlying implement helper. */
export async function completeConversationTextHelper(
  deps: {
    store: HelmStore
    conversations: { resolveEffectiveModel(modelOverride?: string, profileId?: string): Promise<string | undefined> }
    modelsRegistry: { models: Models; isModelDisabled(providerId: string, modelId: string): boolean }
    stash: { redact(text: string): string }
  },
  input: {
    conversationId: number
    systemPrompt: string
    text: string
    maxTokens?: number
    signal?: AbortSignal
  },
): Promise<string> {
  input.signal?.throwIfAborted()
  const meta = deps.store.getConv(input.conversationId)
  if (meta === undefined) {
    throw new HelmError('not_found', `conversation missing:${input.conversationId}`, 404, { conversationId: input.conversationId })
  }
  const effective = await deps.conversations.resolveEffectiveModel(meta.modelOverride, meta.profileId)
  if (effective === undefined || effective === '') {
    throw new HelmError('model_not_configured', `conversation ${input.conversationId} not parse out takes effect model, cannot execute text completion`, 409, { conversationId: input.conversationId })
  }
  const ref = requireModelRef(effective)
  const model = deps.modelsRegistry.models.getModel(ref.provider, ref.modelId)
  if (model === undefined) {
    throw new HelmError('model_not_found', `takes effect model '${effective}' do not in when before model set in (may already hot reload remove)`, 409, { model: effective })
  }
  if (deps.modelsRegistry.isModelDisabled(ref.provider, ref.modelId)) {
    throw new HelmError('model_disabled', `model ${ref.provider}/${ref.modelId} already by disable, cannot execute text completion`, 409, { model: effective })
  }
  input.signal?.throwIfAborted()
  const message = await deps.modelsRegistry.models.completeSimple(
    model,
    {
      systemPrompt: deps.stash.redact(input.systemPrompt),
      messages: [
        {
          role: 'user',
          content: deps.stash.redact(input.text),
          timestamp: Date.now(),
        },
      ],
    },
    {
      signal: input.signal,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    },
  )
  input.signal?.throwIfAborted()
  if (message.stopReason !== 'stop') {
    throw new HelmError(
      'model_completion_unavailable',
      `text completion not succeeded end (stopReason=${message.stopReason}${message.errorMessage !== undefined ? `:${deps.stash.redact(String(message.errorMessage)).slice(0, 200)}` : ''}), reject return part text`,
      502,
      { stopReason: message.stopReason },
    )
  }
  const text = (message.content as Array<{ type?: string; text?: string }>)
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
  return deps.stash.redact(text)
}

/**
 * validate Profile ID is otherwise legal (public interface validate, unify throw 400 validation_error).
 */
export function assertProfileIdPublic(id: string): void {
  try {
    assertProfileId(id)
  } catch (err) {
    throw new HelmError(
      'validation_error',
      `Profile id illegal:${err instanceof Error ? err.message : String(err)}`,
      400,
      { profileId: id },
    )
  }
}

/**
 * skill thing directory parse Helper.
 */
export function skillDirectoryHelper(dataDir: string, id: string): string {
  try {
    assertSkillId(id)
  } catch (err) {
    throw new HelmError(
      'validation_error',
      `Skill id illegal:${err instanceof Error ? err.message : String(err)}`,
      400,
      { skillId: id },
    )
  }
  return join(dataDir, 'skills', id)
}

/**
 * Profile thing directory parse Helper.
 */
export function profileDirectoryHelper(dataDir: string, id: string): string {
  assertProfileIdPublic(id)
  return join(dataDir, 'profiles', id)
}


