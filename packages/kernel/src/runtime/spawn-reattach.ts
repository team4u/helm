/**
 * Validation and entry scanning helpers for in-place cross-restart reattach of native subagents.
 *
 * Responsibilities:
 * - `assertSpawnRequestModes`: shared shape and mutual-exclusion validation for `mode`/`requestId`/`reattach`
 *   at both entry and post-hook convergence (`reattach` is mutually exclusive with `resume` and `fork`;
 *   `reattach.conversationId` requires `requestId`);
 * - `recoverAcceptedStructuredOutput`: scans persisted non-error `register_structured_output` calls starting
 *   from `submission.entry` to backfill `structured.accepted` across restarts;
 * - `readSubmissionAssistantText`: reads assistant text from a settled `submission.answer` (and the submission
 *   range), addressing missing in-memory `lastAssistant` caches when a crash happens right as a turn completes.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Conversation, EntryId, EntryRecord, SettledSubmissionRecord } from '@earendil-works/pi-durable'
import { HelmxError, isAbsoluteAgentPath, type AgentSpawnRequest } from '@helmx/protocol'
import { assertSpawnForkFields } from './spawn-fork.js'
import { extractAcceptedStructuredOutputFromEntries } from './structured-output.js'

const ENTRY_SCAN_PAGE_SIZE = 256

/**
 * Validate shapes and mutual-exclusion constraints for `requestId`, `reattach`, `resume`, and `fork`:
 * - `reattach` is mutually exclusive with `resume` and `fork` (`400 validation_error`);
 * - `reattach` must be a plain object containing `conversationId` or `executionId`;
 * - `reattach.conversationId` must be a positive safe integer paired with a non-empty `requestId` (for submission deduplication).
 */
export function assertSpawnRequestModes(
  request: Pick<AgentSpawnRequest, 'fork' | 'resume' | 'reattach' | 'requestId'>,
): void {
  assertSpawnForkFields(request)
  if (request.requestId !== undefined) {
    if (typeof request.requestId !== 'string' || request.requestId.trim() === '') {
      throw new HelmxError(
        'validation_error',
        `requestId must be a non-empty string (received ${String(request.requestId)})`,
        400,
        { requestId: request.requestId },
      )
    }
  }
  if (request.reattach === undefined) return
  const raw = request.reattach
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmxError('validation_error', 'reattach must be a plain object', 400)
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'conversationId' && key !== 'executionId' && key !== 'effectiveCwd') {
      throw new HelmxError('validation_error', `reattach contains unknown field "${key}"`, 400, { field: key })
    }
  }
  if (request.resume !== undefined) {
    throw new HelmxError(
      'validation_error',
      'reattach and resume are mutually exclusive: cannot reattach in-place while resuming an existing subagent',
      400,
      { resume: request.resume },
    )
  }
  if (request.fork === true) {
    throw new HelmxError(
      'validation_error',
      'reattach and fork are mutually exclusive: cannot reattach in-place while forking from parent conversation',
      400,
    )
  }
  if (raw.conversationId !== undefined) {
    if (typeof raw.conversationId !== 'number' || !Number.isSafeInteger(raw.conversationId) || raw.conversationId <= 0) {
      throw new HelmxError(
        'validation_error',
        `reattach.conversationId must be a positive safe integer (received ${String(raw.conversationId)})`,
        400,
        { conversationId: raw.conversationId },
      )
    }
  }
  if (raw.executionId !== undefined) {
    if (typeof raw.executionId !== 'string' || raw.executionId.length === 0) {
      throw new HelmxError(
        'validation_error',
        `reattach.executionId must be a non-empty string (received ${String(raw.executionId)})`,
        400,
        { executionId: raw.executionId },
      )
    }
  }
  if (raw.effectiveCwd !== undefined) {
    if (typeof raw.effectiveCwd !== 'string' || !isAbsoluteAgentPath(raw.effectiveCwd)) {
      throw new HelmxError(
        'validation_error',
        `reattach.effectiveCwd must be an absolute path (received ${String(raw.effectiveCwd)})`,
        400,
        { effectiveCwd: raw.effectiveCwd },
      )
    }
  }
  if (raw.conversationId === undefined && raw.executionId === undefined) {
    throw new HelmxError('validation_error', 'reattach requires at least conversationId or executionId', 400)
  }
}

async function scanEntryRange(
  conversation: Pick<Conversation, 'entries'>,
  minEntryId: EntryId,
  maxEntryId: EntryId | undefined,
  order: 'ascending' | 'descending',
): Promise<EntryRecord[]> {
  const out: EntryRecord[] = []
  let cursor = undefined
  for (;;) {
    const page = await conversation.entries(
      {
        minEntryId,
        ...(maxEntryId !== undefined ? { maxEntryId } : {}),
        order,
      },
      ENTRY_SCAN_PAGE_SIZE,
      cursor,
      BACKGROUND_CONTEXT,
    )
    out.push(...page.items)
    if (page.next === undefined) break
    cursor = page.next
  }
  return out
}

/**
 * Scan persisted non-error `register_structured_output` tool calls in the child conversation starting from
 * `submission.entry`; returns the structured artifact to backfill `accepted` if Schema validation passed before crash.
 */
export async function recoverAcceptedStructuredOutput(
  conversation: Pick<Conversation, 'entries'>,
  schema: Record<string, unknown>,
  entryId: EntryId,
  answerId?: EntryId,
): Promise<{ found: true; value: unknown } | { found: false }> {
  if (typeof conversation.entries !== 'function') return { found: false }
  const entries = await scanEntryRange(conversation, entryId, answerId, 'ascending')
  return extractAcceptedStructuredOutputFromEntries(entries, schema)
}

function assistantTextFromEntry(entry: EntryRecord | undefined): string {
  if (entry === undefined || entry.kind !== 'pi.assistant' || !Array.isArray(entry.model)) return ''
  const msg = entry.model[0] as { content?: ReadonlyArray<{ type?: unknown; text?: unknown }> } | undefined
  if (!msg || !Array.isArray(msg.content)) return ''
  return msg.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/**
 * Read assistant text for a given submission: prefers `settled.answer` directly, falling back to searching
 * `[settled.entry, settled.answer]` in reverse order for the latest non-empty `pi.assistant` text
 * (stopping at `pi.reset` or `helmx.rewind`).
 */
export async function readSubmissionAssistantText(
  conversation: Pick<Conversation, 'entries'>,
  settled: SettledSubmissionRecord,
): Promise<string | undefined> {
  if (settled.type !== 'input' || settled.status !== 'done' || settled.answer === undefined) {
    return undefined
  }
  if (typeof conversation.entries !== 'function') return undefined
  const directPage = await conversation.entries(
    { minEntryId: settled.answer, maxEntryId: settled.answer, order: 'ascending' },
    1,
    undefined,
    BACKGROUND_CONTEXT,
  )
  const directText = assistantTextFromEntry(directPage.items[0])
  if (directText !== '') return directText
  if (settled.entry === undefined) return undefined
  let cursor = undefined
  for (;;) {
    const page = await conversation.entries(
      { minEntryId: settled.entry, maxEntryId: settled.answer, order: 'descending' },
      ENTRY_SCAN_PAGE_SIZE,
      cursor,
      BACKGROUND_CONTEXT,
    )
    for (const entry of page.items) {
      if (entry.kind === 'pi.reset' || entry.kind === 'helmx.rewind') return undefined
      const text = assistantTextFromEntry(entry)
      if (text !== '') return text
    }
    if (page.next === undefined) break
    cursor = page.next
  }
  return undefined
}
