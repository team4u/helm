/**
 * Frontend closed-loop pure logic for composerCompleter (the protocol's
 * ComposerCompleterSpec):
 * - trigger token detection/replacement: the char before the trigger must be
 *   start-of-line or whitespace (a space boundary); tokens may contain Chinese
 *   and path slashes; email user@x, URL a.com/@b and time 12:30 never trigger;
 * - source filtering/sorting: trigger + conversation-scope hits, stable order
 *   by descending priority (default 0);
 * - boundary validation: top-level doc fields and action results are checked
 *   item by item; invalid items are dropped and counted in diagnostics (never
 *   silently);
 * - candidate merging: deduped per "plugin + source" namespace, merged with a
 *   cap, space-tokenized AND filtering (Chinese friendly).
 * Pure functions with no React dependency, consumed by Composer, the
 * subscription hook and unit tests alike.
 */
import type {
  ActionManifest,
  ComposerCompleterSpec,
  ComposerCompletionItem,
  ConversationSummary,
} from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import type { QualifiedUiSpec } from '../lib/types.js'
import { matchesUiScope } from '../lib/types.js'

export type CompletionTrigger = '@' | '#' | ':'

/** Visible candidate cap inside the popover: keyboard cycling also stays
 * within this list (fixes the old 12-shown/full-index mismatch). */
export const COMPLETION_VISIBLE_LIMIT = 12

/** Hard cap of the merge layer: a runaway source contributes at most this
 * many candidates; beyond that it is truncated and reported explicitly. */
export const COMPLETION_MERGE_LIMIT = 100

/** Debounce window for action-source queries. */
export const COMPLETION_QUERY_DEBOUNCE_MS = 150

/** Slash command token: the existing three-source commands plus skill trigger
 * words (ASCII); the character set stays unchanged. */
const SLASH_TOKEN_RE = /(?:^|\s)\/([a-zA-Z0-9:_-]*)$/
/** '@' '#' ':' completion token: the trigger must be preceded by start-of-line
 * or whitespace; the token allows non-whitespace chars (Chinese/slashes/dots). */
const TRIGGER_TOKEN_RE = /(?:^|\s)([@#:])([^\s]*)$/
/** Picked replacement: the nearest trigger token before the caret (including
 * the trigger symbol) is replaced wholesale by insertText. */
const REPLACE_TOKEN_RE = /(?:^|\s)([/@#:][^\s]*)$/

export interface CompletionToken {
  trigger: '/' | '@' | '#' | ':'
  query: string
  /** Start index of the trigger symbol within the whole text (inclusive). */
  tokenStart: number
}

/** Detect the nearest completion trigger token before the caret; slash wins
 * first (its command namespace is independent and the character sets are
 * disjoint). */
export function detectCompletionToken(beforeCaret: string): CompletionToken | null {
  const slash = SLASH_TOKEN_RE.exec(beforeCaret)
  if (slash !== null) {
    const query = slash[1] ?? ''
    return { trigger: '/', query, tokenStart: beforeCaret.length - query.length - 1 }
  }
  const hit = TRIGGER_TOKEN_RE.exec(beforeCaret)
  if (hit !== null) {
    const query = hit[2] ?? ''
    return { trigger: hit[1] as '@' | '#' | ':', query, tokenStart: beforeCaret.length - query.length - 1 }
  }
  return null
}

/** Replace the nearest trigger token before the caret (including the trigger
 * symbol) with insertText, keeping surrounding text; insert in place when no
 * token is found. */
export function replaceTriggerToken(
  text: string,
  caret: number,
  insertText: string,
): { next: string; nextCaret: number } {
  const pos = Math.max(0, Math.min(text.length, Math.trunc(caret) || 0))
  const hit = REPLACE_TOKEN_RE.exec(text.slice(0, pos))
  const start = hit !== null ? pos - (hit[1]?.length ?? 0) : pos
  const next = text.slice(0, start) + insertText + text.slice(pos)
  return { next, nextCaret: start + insertText.length }
}

/** Completion sources available in the current conversation for a trigger:
 * trigger + scope hits, stable order by descending priority. */
export function completersForTrigger(
  completers: ReadonlyArray<QualifiedUiSpec<ComposerCompleterSpec>> | undefined,
  trigger: CompletionTrigger,
  conversation: ConversationSummary | undefined,
): Array<QualifiedUiSpec<ComposerCompleterSpec>> {
  return (completers ?? [])
    .filter((c) => c.spec.trigger === trigger && matchesUiScope(conversation, c.spec.scope))
    .sort((a, b) => (b.spec.priority ?? 0) - (a.spec.priority ?? 0))
}

/** Single-candidate boundary validation: id/label/insertText must be
 * non-empty strings, hint/icon optional strings. */
export function validateCompletionItem(entry: unknown): ComposerCompletionItem | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const e = entry as Record<string, unknown>
  if (typeof e['id'] !== 'string' || e['id'] === '') return null
  if (typeof e['label'] !== 'string' || e['label'] === '') return null
  if (typeof e['insertText'] !== 'string') return null
  if (e['hint'] !== undefined && typeof e['hint'] !== 'string') return null
  if (e['icon'] !== undefined && typeof e['icon'] !== 'string') return null
  return {
    id: e['id'],
    label: e['label'],
    insertText: e['insertText'],
    ...(e['hint'] !== undefined ? { hint: e['hint'] } : {}),
    ...(e['icon'] !== undefined ? { icon: e['icon'] } : {}),
  }
}

export interface ExtractedItems {
  /** Valid parsed candidates; null means the document is not loaded yet (not an error). */
  items: ComposerCompletionItem[] | null
  /** Diagnostics for invalid content (exposed per source; other sources unaffected). */
  error?: string
}

/** doc / sessionDoc source extraction: reads only safe top-level fields of the
 * contributing plugin's own public document, validating each item at the
 * boundary. */
export function extractCompletionItems(
  docValue: unknown,
  itemsField: string,
  t: WebMessageTranslator = englishWebTranslator,
): ExtractedItems {
  if (docValue === undefined || docValue === null) return { items: null }
  if (typeof docValue !== 'object' || Array.isArray(docValue)) {
    return { items: null, error: t('composer.completion.docNotObject') }
  }
  const raw = (docValue as Record<string, unknown>)[itemsField]
  if (raw === undefined || raw === null) return { items: null, error: t('composer.completion.docMissingField', { field: itemsField }) }
  if (!Array.isArray(raw)) return { items: null, error: t('composer.completion.docMissingField', { field: itemsField }) }
  const items: ComposerCompletionItem[] = []
  let dropped = 0
  for (const entry of raw) {
    const item = validateCompletionItem(entry)
    if (item !== null) items.push(item)
    else dropped++
  }
  return { items, error: dropped > 0 ? t('composer.completion.droppedItems', { count: dropped }) : undefined }
}

/** action source result parsing: ComposerCompletionResult { items } validated
 * item by item. */
export function parseCompletionActionResult(
  result: unknown,
  t: WebMessageTranslator = englishWebTranslator,
): ExtractedItems {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { items: null, error: t('composer.completion.invalidActionResult') }
  }
  const items = (result as Record<string, unknown>)['items']
  if (!Array.isArray(items)) return { items: null, error: t('composer.completion.missingItemsArray') }
  const valid: ComposerCompletionItem[] = []
  let dropped = 0
  for (const entry of items) {
    const item = validateCompletionItem(entry)
    if (item !== null) valid.push(item)
    else dropped++
  }
  return { items: valid, error: dropped > 0 ? t('composer.completion.droppedItems', { count: dropped }) : undefined }
}

/** Pre-call verification for action sources: a real manifest must exist and
 * declare idempotent:true (only idempotent read-only actions may serve as
 * completion sources). */
export function verifyCompletionActionManifest(
  actions: ReadonlyArray<ActionManifest> | undefined,
  pluginId: string,
  actionId: string,
  t: WebMessageTranslator = englishWebTranslator,
): string | null {
  const manifest = (actions ?? []).find((a) => a.pluginId === pluginId && a.id === actionId)
  if (manifest === undefined) return t('composer.completion.actionNotRegistered', { pluginId, actionId })
  if (manifest.idempotent !== true) return t('composer.completion.actionNotIdempotent', { pluginId, actionId })
  return null
}

export interface CompletionActionCallPlan {
  /** Built action input; null with an attached error when the current context
   * cannot satisfy required parameters. */
  input: Record<string, unknown> | null
  conversationId?: number
  error?: string
}

/**
 * Assemble the completion query input from the current context (a real
 * conversation or the standby draft's profileId) and the action manifest's
 * inputSchema:
 * - real conversation: { query, conversationId } and the real conversationId
 *   rides along at the top level;
 * - no conversation (standby draft):
 *   - schema.required forcing conversationId -> explicit error that an
 *     existing conversation is required (never fake an ID);
 *   - schema.properties declaring profileId (and a profileId provided) ->
 *     { query, profileId };
 *   - otherwise -> { query } (avoid pushing undeclared fields into an external
 *     plugin with additionalProperties:false).
 */
export function buildCompletionActionCall(
  manifest: ActionManifest,
  query: string,
  context: { conversationId?: number; profileId?: string },
  t: WebMessageTranslator = englishWebTranslator,
): CompletionActionCallPlan {
  if (context.conversationId !== undefined) {
    return {
      input: { query, conversationId: context.conversationId },
      conversationId: context.conversationId,
    }
  }
  const schema = manifest.inputSchema as { properties?: unknown; required?: unknown } | undefined
  const required = Array.isArray(schema?.required) ? schema.required : []
  if (required.includes('conversationId')) {
    return {
      input: null,
      error: t('composer.completion.actionNeedsConversation', { pluginId: manifest.pluginId, actionId: manifest.id }),
    }
  }
  const props =
    schema?.properties !== null && typeof schema?.properties === 'object' && !Array.isArray(schema?.properties)
      ? (schema.properties as Record<string, unknown>)
      : undefined
  if (context.profileId !== undefined && props !== undefined && Object.hasOwn(props, 'profileId')) {
    return { input: { query, profileId: context.profileId } }
  }
  return { input: { query } }
}

/** Space-tokenized AND filtering (case-insensitive, Chinese-includes
 * friendly); an empty query returns items unchanged.
 * Candidate labels often carry a trigger prefix (#tag) while the query has it
 * stripped (the word); therefore every term matches both the raw and the
 * stripped form, so "#word" queries still hit "#tag".*/
export function filterByQuery(
  items: ReadonlyArray<ComposerCompletionItem>,
  query: string,
): ComposerCompletionItem[] {
  const raw = query.toLowerCase().split(/\s+/).filter((t) => t !== '')
  if (raw.length === 0) return [...items]
  // Strip a leading trigger symbol from each term (it may ride along with
  // pasted text); either form matching is enough.
  const terms = raw.flatMap((term) => {
    const stripped = term.replace(/^[@#:\/]+/, '')
    return stripped === '' || stripped === term ? [term] : [term, stripped]
  })
  return items.filter((item) => {
    const haystack = `${item.label}\n${item.id}\n${item.hint ?? ''}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

export interface MergedCompletionItem {
  /** `${pluginId}\u0000${item.id}`: stable key deduped within the plugin + source namespace. */
  key: string
  item: ComposerCompletionItem
}

/** Merge candidates in source order: identical ids across plugins are not
 * deduped (namespace isolation); truncation past the limit is reported
 * faithfully. */
export function mergeCompletionItems(
  groups: ReadonlyArray<{ pluginId: string; items: ReadonlyArray<ComposerCompletionItem> | null }>,
  limit: number = COMPLETION_MERGE_LIMIT,
): { items: MergedCompletionItem[]; total: number; truncated: boolean } {
  const seen = new Set<string>()
  const out: MergedCompletionItem[] = []
  for (const group of groups) {
    if (group.items === null) continue
    for (const item of group.items) {
      const key = `${group.pluginId}\u0000${item.id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (out.length < limit) out.push({ key, item })
    }
  }
  return { items: out, total: seen.size, truncated: seen.size > limit }
}
