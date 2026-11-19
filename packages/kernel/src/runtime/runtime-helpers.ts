/**
 * Shared file-level runtime helpers (stateless pure functions).
 *
 * Extracted from `runtime.ts`: tool result contracts, `before_turn` section/message manipulation,
 * rewind interval parsing, 404 conversation checks, and other cross-module reusable helpers.
 */
import { join } from 'node:path'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import type { ConversationSummary } from '@helmx/protocol'
import type { Models } from '@earendil-works/pi-ai'
import { HelmxError, assertProfileId, escapeXml, safeResultText } from '@helmx/protocol'
import { redactJsonValue } from '../redact.js'
import type { ConvMeta } from './store.js'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { HelmxStore } from './store.js'
import { requireModelRef } from './models.js'
import { assertSkillId } from '../services/index.js'

// ---------------------------------------------------------------------------
// Common serialization / escaping
// ---------------------------------------------------------------------------

/** Strip an existing `<external_event>` wrapper (prevents double wrapping after trigger transforms; preserves trailing appended text). */
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
// Conversation existence 404 (shared across 15+ call sites)
// ---------------------------------------------------------------------------

/** `store.getConv` + 404 check (centralized helper replacing 15+ inline checks). */
export function requireConv(store: HelmxStore, id: number): NonNullable<ReturnType<HelmxStore['getConv']>> {
  const meta = store.getConv(id)
  if (!meta) throw new HelmxError('not_found', `Conversation not found: ${id}`, 404)
  return meta
}

// ---------------------------------------------------------------------------
// Tool result contract helpers (plugin/hook output -> SDK ToolExecutionResult)
// ---------------------------------------------------------------------------

/**
 * Envelope predicate for structured plugin tool results (prevents business objects containing an `output` field
 * from being misidentified as envelopes): must contain at least one of `output` (string or array),
 * `structuredOutput`, or `isError`, and every present envelope field must have a valid type; malformed envelope
 * fields fail explicitly rather than falling back silently through the plain-text path.
 */
function envelopeProblem(raw: Record<string, unknown>): { isEnvelope: boolean; problem?: string } {
  const hasOutput = raw['output'] !== undefined
  const hasStructured = raw['structuredOutput'] !== undefined
  const hasError = raw['isError'] !== undefined
  if (!hasOutput && !hasStructured && !hasError) return { isEnvelope: false }
  if (hasOutput && typeof raw['output'] !== 'string' && !Array.isArray(raw['output'])) {
    return { isEnvelope: true, problem: "output must be a string or an array of { type: 'text', text }" }
  }
  if (hasError && typeof raw['isError'] !== 'boolean') {
    return { isEnvelope: true, problem: 'isError must be a boolean' }
  }
  return { isEnvelope: true }
}

/**
 * Normalize raw plugin tool return value -> SDK `ToolExecutionResult`:
 * - Structured result envelope `{ output, structuredOutput?, isError? }`: formatted per envelope rules only when all
 *   present envelope fields have valid types (both text and `structuredOutput` are redacted; `structuredOutput` is
 *   forwarded only when the tool declares `structuredOutputSchema`);
 * - Returning `structuredOutput` without declaring `structuredOutputSchema` fails explicitly (`invalid_tool_result`,
 *   never silently dropped so plugin authors see data loss);
 * - Any other value wraps as a single text block (`structuredOutput` omitted unless schema is declared).
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
        throw new HelmxError(
          'invalid_tool_result',
          `${where} result envelope has invalid field type: ${verdict.problem}`,
          500,
        )
      }
      // `output`: string wraps into a single text block; array is validated element-by-element.
      let output: Array<{ type: 'text'; text: string }>
      if (typeof env.output === 'string') {
        output = [{ type: 'text', text: redact(env.output) }]
      } else if (Array.isArray(env.output)) {
        output = env.output.map((block) => {
          if (block === null || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text' || typeof (block as { text?: unknown }).text !== 'string') {
            throw new HelmxError(
              'invalid_tool_result',
              `${where} result envelope output array only accepts { type: 'text', text } blocks`,
              500,
            )
          }
          return { type: 'text' as const, text: redact((block as { text: string }).text) }
        })
      } else if (env.output === undefined) {
        output = []
      } else {
        throw new HelmxError(
          'invalid_tool_result',
          `${where} result envelope output must be a string or an array of { type: 'text', text }`,
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
      // `structuredOutput` is forwarded only when the tool declares a schema (SDK contract); values are redacted.
      // Returning `structuredOutput` without a schema fails explicitly instead of silently dropping data.
      if (env.structuredOutput !== undefined && options?.structuredOutputSchema === undefined) {
        throw new HelmxError(
          'invalid_tool_result',
          `${where} returned structuredOutput without declaring structuredOutputSchema (forbidden by SDK contract; declare a schema or return plain text in output)`,
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
  // Not an envelope (no envelope fields or fails envelope check): serialize as plain text (without structuredOutput).
  return { output: [{ type: 'text', text: safeResultText(raw, redact) }] }
}

/** Convert `tool_call` `handled` takeover payload -> valid `ToolExecutionResult` (invalid shape becomes explicit error result). */
export function toolResultOf(handled: unknown): {
  output: Array<{ type: 'text'; text: string }>
  isError: boolean
} {
  const normalized = normalizeToolResult(handled)
  if (normalized !== undefined) {
    return normalized as { output: Array<{ type: 'text'; text: string }>; isError: boolean }
  }
  return {
    output: [{ type: 'text', text: 'tool_call handled hook returned an invalid result shape' }],
    isError: true,
  }
}

/** Normalize `tool_result` transform output: must look like `ToolExecutionResult`, else `undefined` (keeps original). */
export function normalizeToolResult(value: unknown): ToolExecutionResultShape | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as ToolExecutionResultShape
  if (candidate.output === undefined && candidate.structuredOutput === undefined && candidate.isError === undefined) {
    return undefined
  }
  // `output` must be a content block array (wrap string as single text block; SDK contract only accepts arrays).
  if (typeof candidate.output === 'string') {
    return { ...candidate, output: [{ type: 'text', text: candidate.output }] }
  }
  if (candidate.output !== undefined && !Array.isArray(candidate.output)) return undefined
  return candidate
}

interface ToolExecutionResultShape {
  output?: Array<{ type: string; text?: string }> | string
  structuredOutput?: JsonValue
  isError?: boolean
  details?: JsonValue
}

// ---------------------------------------------------------------------------
// `before_turn` sections / tools manipulation (rewrites SDK leading system message)
// ---------------------------------------------------------------------------

/** Extract currently effective system sections from model messages (combining leading declaration and subsequent patches). */
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
 * Project prompt metadata for final scoped active tools in `before_turn`:
 * - `prompt.tools.<name>`: full paragraph per tool (`promptSnippet`);
 * - `prompt.tools.guidelines`: shared section aggregating all `promptGuidelines`;
 * - Overwrites stale same-named sections cleanly (disabled/stripped tools leave no phantom prompts); empty metadata
 *   produces empty projection (clears all stale managed sections); returns original reference when unchanged.
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
    desired.set('prompt.tools.guidelines', `Available tool guidelines:\n${lines.join('\n')}`)
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
        changed = true // remove phantom section
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
 * Boundary validation for full `before_turn` `messages` replacement (prevents system header corruption and history fabrication):
 * - Must be a non-empty array whose first element is a `system` message (SDK replay relies on leading system message);
 * - Base content of leading system message must match original (`sections`/`toolsRemoved`/`toolsAdded` declarations
 *   may change, but base prompt rules and body must not be overwritten);
 * - History starting at the first non-system message must stay intact in original order (appending after is allowed;
 *   truncating/rewriting/fabricating history is forbidden — use rewrite/reset channels for truncation).
 * Violations fail explicitly with `invalid_hook_result` rather than silently accepting broken rewrites.
 */
export function assertSafeMessageSurgery(
  original: ReadonlyArray<Record<string, unknown>>,
  replacement: unknown,
): Array<Record<string, unknown>> {
  const fail = (detail: string): HelmxError =>
    new HelmxError('invalid_hook_result', `before_turn messages rewrite out of bounds: ${detail}`, 500)
  if (!Array.isArray(replacement) || replacement.length === 0) {
    throw fail('must be a non-empty message array')
  }
  const lead = replacement[0]!
  if (lead['role'] !== 'system') {
    throw fail('first message must remain system (SDK replay mechanism relies on a leading system message)')
  }
  if (original.length === 0 || original[0]!['role'] !== 'system') {
    throw fail('original request is missing a leading system message (unexpected kernel state; rewrite rejected)')
  }
  if (contentTextOf(original[0]!) !== contentTextOf(lead)) {
    throw fail('leading system message base content was overwritten (base formatting and body are immutable; update sections/tools via declarations)')
  }
  // Preserve history: the subsequence starting at the first non-system message must appear verbatim in replacement (prefix aligned).
  let firstNonSystem = 0
  while (firstNonSystem < original.length && original[firstNonSystem]!['role'] === 'system') firstNonSystem += 1
  const historyLen = original.length - firstNonSystem
  const preservedHistory = replacement.slice(firstNonSystem, firstNonSystem + historyLen)
  if (historyLen > 0) {
    for (let i = 0; i < historyLen; i += 1) {
      if (preservedHistory[i] !== original[firstNonSystem + i]!) {
        throw fail('historical messages may only be appended after; truncating, rewriting, or fabricating history is not allowed (use rewrite/reset channels for truncation)')
      }
    }
  }
  return replacement as Array<Record<string, unknown>>
}

/** Base text content of a system message (string or concatenated text blocks, matching SDK replay extraction). */
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
 * Replace leading system message `sections` wholesale with `desired` (preserving base content).
 * Subsequent system message section patches are folded into `desired`, stripping old patches so replay cannot override.
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
  // New declarations; old keys absent from the new set are removed with `null` (replay semantics).
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
 * Rewrite tool declarations: attach `toolsRemoved`/`toolsAdded` declarations to the leading system message.
 * Parsed on the model side by pi-ai replay (`getCurrentTools`), taking effect immediately on the next round.
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
    if (!tool) throw new HelmxError('unknown_tool', `before_turn selected unregistered tool: ${name}`, 500)
    added.push({ ...tool })
  }
  if (messages.length === 0 || messages[0]!['role'] !== 'system') return [...messages]
  const lead = messages[0]!
  // Full redeclaration: remove stale declarations then add new set (equivalent replay, avoids order drift).
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

/** List current tool names from replay messages. */
function currentToolNames(messages: ReadonlyArray<Record<string, unknown>>): string[] {
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
// Conversation summary fallback / error normalization
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
    return new HelmxError('conversation_busy', 'Conversation is busy and whenBusy=reject was specified', 409)
  }
  if (name === 'ConversationIdle') {
    return new HelmxError('conversation_idle', 'Conversation is idle and conflicts with whenIdle=reject', 409)
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

/** Concatenate assistant text blocks from an `entry.model` array (used to extract `waitForInput` answers). */
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
// Rewind intervals (in-place edit & overwrite contract)
// ---------------------------------------------------------------------------

/** Overwrite range declared by a `helmx.rewind` truncation marker (closed interval `[from, through]`).
 *
 * `throughEntryId` is a strict boundary: max old entry ID within the overwritten span, so newer
 * input entries always have strictly larger IDs and are never mistakenly removed across intervals. */
export interface RewindInterval {
  from: number
  through: number
  marker: number
}

/** Parse a single rewind interval; returns `undefined` if not a rewind marker or missing `fromEntryId`. */
export function rewindIntervalOf(entry: { id: number | string; kind: string; data?: unknown }): RewindInterval | undefined {
  if (entry.kind !== 'helmx.rewind') return undefined
  const data = entry.data as { fromEntryId?: unknown; throughEntryId?: unknown } | undefined
  const from = Number(data?.fromEntryId)
  if (!Number.isSafeInteger(from) || from <= 0) return undefined
  const marker = Number(entry.id)
  const through = Number(data?.throughEntryId)
  if (!Number.isSafeInteger(marker) || !Number.isSafeInteger(through) || through < from || through >= marker) {
    throw new HelmxError('invalid_rewind_entry', `History overwrite marker ${entry.id} has an invalid interval`, 500)
  }
  return { from, through, marker }
}

/** Check whether an entry is covered by any rewind interval (shared by detail display / FTS rebuild / lastAssistant cleanup). */
export function coveredByRewind(entryId: number, intervals: ReadonlyArray<RewindInterval>): boolean {
  return intervals.some((cut) => entryId >= cut.from && entryId <= cut.through)
}

/** Edit target restriction: only human input entries may be overwritten (agent/trigger injections and control entries are rejected). */
export function assertEditableHumanInput(
  entry: { kind: string; data?: unknown },
  conversationId: number,
  entryId: number,
): void {
  if (entry.kind === 'pi.user') return
  if (entry.kind !== 'helmx.input') {
    throw new HelmxError(
      'entry_not_editable',
      `Only human input entries can be edited (entry ${entryId} has kind=${entry.kind})`,
      400,
      { conversationId, entryId, kind: entry.kind },
    )
  }
  const origin = (entry.data as { origin?: unknown } | undefined)?.origin
  if (origin !== 'human') {
    throw new HelmxError(
      'entry_not_editable',
      `Entry ${entryId} has origin '${String(origin)}'; only human inputs can be edited in place`,
      409,
      { conversationId, entryId, origin: String(origin) },
    )
  }
}

export type { ToolExecutionResult }

/** Startup corruption check for `models-store.json` (open phase; matches `ModelRegistry` logic). */
export async function assertModelsStoreHealthyAtBoot(models: Models): Promise<void> {
  const result = await models.refresh({ allowNetwork: false })
  for (const [, err] of result.errors) {
    if (err instanceof HelmxError && err.code === 'models_store_corrupted') {
      throw new HelmxError(
        'models_store_corrupted',
        `models-store.json is corrupted (discovered while reading): ${err.message}`,
        500,
      )
    }
  }
}

/** Underlying text-completion helper. */
export async function completeConversationTextHelper(
  deps: {
    store: HelmxStore
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
    throw new HelmxError('not_found', `Conversation not found: ${input.conversationId}`, 404, { conversationId: input.conversationId })
  }
  const effective = await deps.conversations.resolveEffectiveModel(meta.modelOverride, meta.profileId)
  if (effective === undefined || effective === '') {
    throw new HelmxError('model_not_configured', `Conversation ${input.conversationId} has no effective model resolved; cannot run text completion`, 409, { conversationId: input.conversationId })
  }
  const ref = requireModelRef(effective)
  const model = deps.modelsRegistry.models.getModel(ref.provider, ref.modelId)
  if (model === undefined) {
    throw new HelmxError('model_not_found', `Effective model '${effective}' is not in the current model set (may have been removed on hot reload)`, 409, { model: effective })
  }
  if (deps.modelsRegistry.isModelDisabled(ref.provider, ref.modelId)) {
    throw new HelmxError('model_disabled', `Model ${ref.provider}/${ref.modelId} is disabled; cannot run text completion`, 409, { model: effective })
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
    throw new HelmxError(
      'model_completion_unavailable',
      `Text completion did not finish cleanly (stopReason=${message.stopReason}${message.errorMessage !== undefined ? `: ${deps.stash.redact(String(message.errorMessage)).slice(0, 200)}` : ''}); refusing to return partial text`,
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
 * Helper to resolve the physical directory of a skill.
 */
export function skillDirectoryHelper(dataDir: string, id: string): string {
  try {
    assertSkillId(id)
  } catch (err) {
    throw new HelmxError(
      'validation_error',
      `Invalid Skill ID: ${err instanceof Error ? err.message : String(err)}`,
      400,
      { skillId: id },
    )
  }
  return join(dataDir, 'skills', id)
}

/**
 * Helper to resolve the physical directory of a Profile.
 */
export function profileDirectoryHelper(dataDir: string, id: string): string {
  assertProfileId(id)
  return join(dataDir, 'profiles', id)
}

