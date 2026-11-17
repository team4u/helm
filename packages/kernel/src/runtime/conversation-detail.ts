/**
 * conversation detail situation page, cursor edit decode and FTS index maintain.
 *
 * responsibility:
 * - detail situation page read, by helm.rewind closed zone between filter by override old item, keep metadata item;
 * - page cursor base64url validate and edit decode;
 * - FTS index all amount rebuild (filter rewind override item).
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

/** cursor most large encode length (base64url after; over long reject guard against abuse). */
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
   * conversation detail situation (summary + page timeline):
   * - server side unify filter by helm.rewind override old item (closed zone between [fromEntryId,
   *   throughEntryId]), but keep helm.rewind metadata item itself (frontend SSE and
   *   page filter shared use the same zone between public style);
   * - each time detail situation read when scan aggregate all rewind zone between (simple implement, do not add new durable table/cache),
   *   again from SDK raw cursor page read, filter override item until satisfy limit or without more many;
   * - cursor is base64url(JSON{conversationId,cursor:SDK next}): bind set conversation,
   *   length/JSON legal validate,limit clamp 1..500; not silently truncate;
   * - entry keep model message and data, out boundary before via event same source redaction (publish path unify);
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

  /** detail situation body (page + throw shadow + summary initial value; summary then by parallel merge override is right threat value). */
  private async assembleDetail(
    id: number,
    options?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail> {
    const summary = this.host.getConversation(id)
    const limit = options?.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new HelmError('validation_error', `limit must be 1..500 integer (receives ${limit})`, 400, {
        limit,
      })
    }
    const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `conversation missing:${id}`, 404)

    let sdkCursor: unknown = undefined
    if (options?.cursor !== undefined) {
      sdkCursor = this.decodeDetailCursor(id, options.cursor)
    }
    const rewindCuts = await this.host.collectRewindIntervals(conversation)
    const { collected, nextCursor } = await this.pageVisibleEntries(conversation, id, limit, sdkCursor, rewindCuts)

    // HTTP detail situation exit throw shadow:pi.system filter + signature strip + security pure text tool-result
    // truncate (see entry-projection.ts).SSE/waitForInput do not via this throw shadow.
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
   * single timeline item (GET /api/conversations/:id/entries/:entryId):
   * - precise read (min=max=entryId take 1 , do not via page guess);conversationId and
   *   entryId all strong validate (routing parseIdParam + service layer security integer re-check);
   * - rewind visible and detail situation page consistent: by helm.rewind override old item and pi.system
   *   model side register record one rule 404(helm.rewind mark record itself keep visible, and page behavior same construct);
   * - not truncate but already redaction: only strip signature payload, do not truncate. database original text do not change.
   */
  async getConversationEntry(id: number, entryId: number): Promise<ConversationEntry> {
    if (!Number.isSafeInteger(entryId) || entryId <= 0) {
      throw new HelmError('validation_error', `entryId must be security positive integer (receives ${String(entryId)})`, 400, {
        conversationId: id,
        entryId,
      })
    }
    this.host.getConversation(id)
    const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `conversation missing:${id}`, 404)
    const page = await conversation.entries(
      { minEntryId: entryId as never, maxEntryId: entryId as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    const raw = page.items[0] as { id: number | string; kind: string } | undefined
    if (raw === undefined || Number(raw.id) !== entryId) {
      throw new HelmError('not_found', `item ${entryId} in conversation ${id} in missing`, 404, {
        conversationId: id,
        entryId,
      })
    }
    // visible and detail situation page fully consistent:rewind override old item and pi.system model side register record
    // all invisible (page hide internal item do not because explicit id request re- expose).
    if (raw.kind === 'pi.system') {
      throw new HelmError('not_found', `item ${entryId} is model side register record (pi.system), invisible`, 404, {
        conversationId: id,
        entryId,
      })
    }
    const rewindCuts = await this.host.collectRewindIntervals(conversation)
    if (raw.kind !== 'helm.rewind' && coveredByRewind(entryId, rewindCuts)) {
      throw new HelmError('not_found', `item ${entryId} already by original ground override heavy hide`, 404, {
        conversationId: id,
        entryId,
      })
    }
    return stripEntrySignatures(toConversationEntry(raw as never))
  }

  /** SDK descending page read + rewind/pi.system filter (detail situation body loop; each page precise take remaining).
   * pi.system and rewind override item same belong invisible: in loop inside skip and continue take more old
   * item, guarantee limit semantics = visible count (full after only then filter will let a certain page do not enough limit and
   * cursor already exceeds by filter item, user page see fewer than etc. amount old content). */
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
        // rewind mark record itself keep (SSE consistency and frontend zone between dedupe need to), the rest
        // override zone between old item all hide;pi.system is model side register record, detail situation invisible.
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

  /** encode page cursor:base64url(JSON{conversationId,cursor}). */
  encodeDetailCursor(conversationId: number, sdkCursor: Readonly<Record<string, unknown>>): string {
    const json = JSON.stringify({ conversationId, cursor: sdkCursor })
    return Buffer.from(json, 'utf8').toString('base64url')
  }

  /** decode and validate page cursor: bind set conversation, length and JSON legal (illegal explicit reject). */
  decodeDetailCursor(conversationId: number, encoded: string): unknown {
    if (encoded.length > DETAIL_CURSOR_MAX_LENGTH) {
      throw new HelmError('validation_error', 'cursor exceeds most large length', 400)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      throw new HelmError('validation_error', 'cursor is not legal base64url JSON', 400)
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
        `cursor do not belongs to conversation ${conversationId} or structure illegal`,
        400,
      )
    }
    return shape.cursor
  }

  /** FTS rebuild (host rebuildFts delegate;rewind override item never re- index). */
  async rebuildFts(listConversationIds: () => Array<{ id: number; title: string }>): Promise<void> {
    await this.host.store.rebuildFts(async (index) => {
      for (const conv of listConversationIds()) {
        const conversation = await this.host.harness.conversation(conv.id as never, BACKGROUND_CONTEXT)
        if (!conversation) continue
        // all amount scan after by helm.rewind closed zone between [from, through] filter by override item:
        // they already no longer leap, rebuild FTS when never re- index; the same zone between public style and
        // collectRewindIntervals / detail situation throw shadow shared use closed zone between.
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
