/**
 * Conversation detail pagination, cursor codec, and FTS index maintenance.
 *
 * Responsibilities:
 * - Detail timeline retrieval, filtering out entries covered by closed helm.rewind intervals while preserving marker entries;
 * - Pagination cursor base64url validation and encoding/decoding;
 * - Full FTS index rebuild (filtering rewound entries).
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import type { ConversationDetail, ConversationEntry, ConversationSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { SecretStash } from '../services/index.js'
import { toConversationEntry } from './entries.js'
import { projectDetailEntry, stripEntrySignatures } from './entry-projection.js'
import {
  coveredByRewind,
  entryModelText,
  rewindIntervalOf,
  type RewindInterval,
} from './runtime-helpers.js'
import type { HelmStore } from './store.js'

/** Maximum encoded pagination cursor length (base64url; rejects oversized cursors to prevent abuse). */
export const DETAIL_CURSOR_MAX_LENGTH = 2048

export interface ConversationDetailHost {
  readonly harness: Harness
  readonly store: HelmStore
  readonly stash: SecretStash
  readonly getConversation: (id: number) => ConversationSummary
  readonly collectRewindIntervals: (
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
  ) => Promise<RewindInterval[]>
  /** Non-blocking background contextUsage refresh trigger (optional; falls back to fire-and-forget ensureContextUsage). */
  readonly scheduleContextUsage?: (id: number) => void
  /** contextUsage refresh chain trigger (called fire-and-forget without blocking detail return). */
  readonly ensureContextUsage?: (id: number) => Promise<void>
}

export class ConversationDetailService {
  constructor(private readonly host: ConversationDetailHost) {}

  /**
   * Fetch conversation details (summary + paginated timeline):
   * - Server uniformly filters out historical entries covered by closed helm.rewind intervals ([fromEntryId, throughEntryId])
   *   while retaining the helm.rewind marker entries themselves (matching frontend SSE interval deduplication);
   * - Aggregates rewind intervals on each detail read (simple implementation with no extra durable cache/tables),
   *   then paginates backwards via SDK raw cursors while filtering covered entries until `limit` is filled or no more remain;
   * - Cursors are base64url(JSON {conversationId, cursor: SDK next}): bound to the conversation, checked for length and
   *   valid JSON, and `limit` is bounded to 1..500 without silent clamping;
   * - Entries preserve model messages and data, redacted at boundary with the same secret redactor as events;
   * - contextUsage refresh is decoupled asynchronously so slow usage calculations never block timeline delivery;
   *   when uncached usage finishes computing in the background, `conversation.upsert` pushes it to subscribers.
   */
  async getConversationDetail(
    id: number,
    options?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail> {
    const detail = await this.assembleDetail(id, options)
    if (this.host.scheduleContextUsage !== undefined) {
      this.host.scheduleContextUsage(id)
    } else if (this.host.ensureContextUsage !== undefined) {
      try {
        void Promise.resolve(this.host.ensureContextUsage(id)).catch(() => {})
      } catch {
        // background usage refresh errors must not block detail response
      }
    }
    return { ...detail, ...this.host.getConversation(id) }
  }

  /** Assemble detail body (paginated+projected entries + initial summary; updated summary overrides afterwards). */
  private async assembleDetail(
    id: number,
    options?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail> {
    const summary = this.host.getConversation(id)
    const limit = options?.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new HelmError('validation_error', `limit must be an integer between 1 and 500 (received ${limit})`, 400, {
        limit,
      })
    }
    const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `conversation not found: ${id}`, 404)

    let sdkCursor: unknown = undefined
    if (options?.cursor !== undefined) {
      sdkCursor = this.decodeDetailCursor(id, options.cursor)
    }
    const rewindCuts = await this.host.collectRewindIntervals(conversation)
    const { collected, nextCursor } = await this.pageVisibleEntries(conversation, id, limit, sdkCursor, rewindCuts)

    // HTTP detail boundary projection: filter pi.system + strip signatures + truncate safe plain-text tool results
    // (see entry-projection.ts). SSE / waitForInput never go through this projection.
    const entries: ConversationEntry[] = []
    for (const raw of collected.reverse()) {
      const projected = projectDetailEntry(toConversationEntry(raw as { id: number; kind: string }))
      if (projected !== undefined) entries.push(projected)
    }
    return {
      ...summary,
      entries,
      ...(nextCursor !== undefined ? { nextCursor: this.encodeDetailCursor(id, nextCursor as Readonly<Record<string, unknown>>) } : {}),
    }
  }

  /**
   * Single timeline entry (GET /api/conversations/:id/entries/:entryId):
   * - Exact lookup (min=max=entryId limit 1, never scans pages); validates both conversationId and entryId strictly;
   * - Same rewind visibility as detail pagination: entries covered by helm.rewind or internal pi.system records
   *   return 404 (helm.rewind marker entries remain visible, matching pagination);
   * - Untruncated yet redacted: strips opaque signatures without truncating payload text; original DB data untouched.
   */
  async getConversationEntry(id: number, entryId: number): Promise<ConversationEntry> {
    if (!Number.isSafeInteger(entryId) || entryId <= 0) {
      throw new HelmError('validation_error', `entryId must be a positive safe integer (received ${String(entryId)})`, 400, {
        conversationId: id,
        entryId,
      })
    }
    this.host.getConversation(id)
    const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
    const page = await conversation.entries(
      { minEntryId: entryId as never, maxEntryId: entryId as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    const raw = page.items[0] as { id: number | string; kind: string } | undefined
    if (raw === undefined || Number(raw.id) !== entryId) {
      throw new HelmError('not_found', `entry ${entryId} does not exist in conversation ${id}`, 404, {
        conversationId: id,
        entryId,
      })
    }
    // Identical visibility to detail pagination: rewound entries and pi.system model records remain invisible
    // even when queried directly by ID.
    if (raw.kind === 'pi.system') {
      throw new HelmError('not_found', `entry ${entryId} is an internal model record (pi.system) and not visible`, 404, {
        conversationId: id,
        entryId,
      })
    }
    const rewindCuts = await this.host.collectRewindIntervals(conversation)
    if (raw.kind !== 'helm.rewind' && coveredByRewind(entryId, rewindCuts)) {
      throw new HelmError('not_found', `entry ${entryId} was hidden by in-place overwrite & resend`, 404, {
        conversationId: id,
        entryId,
      })
    }
    return stripEntrySignatures(toConversationEntry(raw as never))
  }

  /** Descending SDK pagination + rewind/pi.system filtering (detail paging loop fetching remaining count per iteration).
   * Both pi.system and rewound entries are skipped inside the loop before counting toward `limit`, guaranteeing
   * `limit` measures visible entries (filtering afterwards would under-fill pages and advance past hidden entries). */
  async pageVisibleEntries(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    limit: number,
    initialCursor: unknown,
    rewindCuts: RewindInterval[],
  ): Promise<{
    collected: Array<{ id: number; kind: string; model?: readonly unknown[]; data?: unknown }>
    nextCursor: unknown
  }> {
    const collected: Array<{ id: number; kind: string; model?: readonly unknown[]; data?: unknown }> = []
    let sdkCursor = initialCursor
    let nextCursor: unknown = undefined
    for (;;) {
      const remaining = limit - collected.length
      const page = await conversation.entries(
        { order: 'descending' },
        remaining,
        sdkCursor as never,
        BACKGROUND_CONTEXT,
      )
      for (const raw of page.items as never as Array<{
        id: number
        kind: string
        model?: readonly unknown[]
        data?: unknown
      }>) {
        // Keep helm.rewind markers (for SSE consistency and frontend interval deduplication), hide older entries
        // inside closed rewind intervals, and hide internal pi.system records from detail timelines.
        const numericId = Number(raw.id)
        if (raw.kind === 'pi.system') continue
        if (raw.kind !== 'helm.rewind' && coveredByRewind(numericId, rewindCuts)) continue
        collected.push(raw)
      }
      if (page.next === undefined) {
        nextCursor = undefined
        break
      }
      if (collected.length >= limit) {
        nextCursor = page.next
        break
      }
      sdkCursor = page.next
    }
    void id
    return { collected, nextCursor }
  }

  /** Encode pagination cursor: base64url(JSON {conversationId, cursor}). */
  encodeDetailCursor(conversationId: number, sdkCursor: Readonly<Record<string, unknown>>): string {
    const json = JSON.stringify({ conversationId, cursor: sdkCursor })
    return Buffer.from(json, 'utf8').toString('base64url')
  }

  /** Decode and validate pagination cursor: verifies conversation ownership, max length, and JSON structure. */
  decodeDetailCursor(conversationId: number, encoded: string): unknown {
    if (encoded.length > DETAIL_CURSOR_MAX_LENGTH) {
      throw new HelmError('validation_error', 'cursor exceeds maximum length', 400)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      throw new HelmError('validation_error', 'cursor is not valid base64url JSON', 400)
    }
    const shape = decoded as { conversationId?: unknown; cursor?: unknown }
    if (
      shape === null ||
      typeof shape !== 'object' ||
      Number(shape.conversationId) !== conversationId ||
      typeof shape.cursor !== 'object' ||
      shape.cursor === null
    ) {
      throw new HelmError(
        'validation_error',
        `cursor does not belong to conversation ${conversationId} or has invalid structure`,
        400,
      )
    }
    return shape.cursor
  }

  /** FTS rebuild (delegated by host rebuildFts; entries hidden by rewind are never re-indexed). */
  async rebuildFts(listConversationIds: () => Array<{ id: number; title: string }>): Promise<void> {
    await this.host.store.rebuildFts(async (index) => {
      for (const conv of listConversationIds()) {
        const conversation = await this.host.harness.conversation(conv.id as never, BACKGROUND_CONTEXT)
        if (!conversation) continue
        // Filter covered entries across all closed helm.rewind [from, through] intervals after full scan so superseded
        // entries are never re-indexed (shares identical interval rules with collectRewindIntervals and detail projection).
        const rewindCuts: RewindInterval[] = []
        const indexed: Array<{ id: number; text: string }> = []
        let cursor: unknown = undefined
        for (;;) {
          const page = await conversation.entries(
            { order: 'ascending' },
            50,
            cursor as never,
            BACKGROUND_CONTEXT,
          )
          for (const entry of page.items) {
            const record = entry as { id: number; kind: string; data?: unknown }
            if (record.kind === 'helm.rewind') {
              const interval = rewindIntervalOf(record)
              if (interval !== undefined) rewindCuts.push(interval)
              continue
            }
            const text = entryModelText(entry as never)
            if (text) indexed.push({ id: Number(record.id), text })
          }
          if (!page.next) break
          cursor = page.next
        }
        for (const item of indexed) {
          if (coveredByRewind(item.id, rewindCuts)) continue
          index(conv.id, `entry:${item.id}`, conv.title, this.host.stash.redact(item.text))
        }
      }
    })
  }
}
