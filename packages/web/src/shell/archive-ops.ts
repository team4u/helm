/**
 * Human-initiated conversation archive operations (pure logic + the existing
 * conversation PATCH channel, zero React):
 *
 * - Archiving is a Web host policy: the host-namespace tag is persisted through
 *   the existing `PATCH /api/conversations/:id`, adding no protocol field, no
 *   plugin-ID special-casing, and never handing the tag to plugin
 *   sidebar.section dynamic rules (plugin disable/cleanup stays unaffected);
 * - Single and batch flows share the same tag computation (idempotent:
 *   re-archiving does not re-append, restoring keeps the other tags); batches
 *   PATCH per conversation and aggregate with allSettled — partial failures
 *   never mask successes and are never silently swallowed;
 * - Archive/restore does not delete the conversation — archived conversations
 *   stay openable, so restore never navigates. Archiving the conversation
 *   currently shown in the primary or split pane jumps to the owning agent's
 *   standby (new-conversation) page; that navigation lives in the SSE
 *   conversation.upsert handler (single source of truth, mirroring the delete
 *   fallback pipeline) so every archive surface (pane menu, sidebar rows) and
 *   even another client's archive follows the same rule; the sidebar list
 *   updates purely via conversation.upsert.
 */
import type { ConversationPatch, ConversationSummary } from '@helm/protocol/browser'
import { conversationsApi } from '../lib/api.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import { archiveConversationTags, restoreConversationTags } from '../conversation/archive-model.js'

/** Archive/restore PATCH for one conversation (idempotent; failures propagate for the caller to notice). */
export async function patchConversationArchived(
  conv: Pick<ConversationSummary, 'id' | 'tags'>,
  archived: boolean,
): Promise<ConversationSummary> {
  const tags = archived ? archiveConversationTags(conv.tags) : restoreConversationTags(conv.tags)
  const patch: ConversationPatch = { tags }
  return conversationsApi.patch(conv.id, patch)
}

/** Batch archive/restore outcome: per-item counts + the first error summary (for notice copy). */
export interface BatchArchiveOutcome {
  attempted: number
  fulfilled: number
  rejected: number
  firstError?: string
}

/**
 * Batch archive/restore: PATCH per conversation from the snapshot taken at call
 * time (allSettled aggregation, never silently swallowing errors). The caller
 * supplies the conversation snapshot as of execution (queried live from the
 * store); ids that no longer exist are simply skipped (the delete flow's own
 * notice already covers their fate).
 */
export async function patchConversationsArchived(
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'tags'>>,
  archived: boolean,
): Promise<BatchArchiveOutcome> {
  const snapshots = [...conversations]
  const results = await Promise.allSettled(
    snapshots.map((conv) => patchConversationArchived(conv, archived)),
  )
  let fulfilled = 0
  let rejected = 0
  let firstError: string | undefined
  for (const result of results) {
    if (result.status === 'fulfilled') {
      fulfilled += 1
      continue
    }
    rejected += 1
    if (firstError === undefined) {
      firstError = result.reason instanceof Error ? result.reason.message : String(result.reason)
    }
  }
  return { attempted: snapshots.length, fulfilled, rejected, firstError }
}

export type ArchiveBatchNotice = {
  type: 'notification'
  level: 'info' | 'warning' | 'error'
  title: string
  body: string
}

/** Batch archive/restore outcome → notice (success / partial / total failure, with the first error summary). */
export function archiveBatchNotice(
  archived: boolean,
  outcome: BatchArchiveOutcome,
  t: WebMessageTranslator = englishWebTranslator,
): ArchiveBatchNotice {
  const verb = archived ? t('shell.archive.verbArchive') : t('shell.archive.verbRestore')
  if (outcome.rejected === 0) {
    return {
      type: 'notification',
      level: 'info',
      title: t('shell.archive.completedTitle', { verb }),
      body: t('shell.archive.completedBody', { verb, count: outcome.fulfilled }),
    }
  }
  // The first error stays verbatim (server/execution text); only the joining
  // punctuation is locale copy.
  const suffix = outcome.firstError !== undefined ? t('shell.archive.errorSuffix', { error: outcome.firstError }) : ''
  if (outcome.fulfilled === 0) {
    return {
      type: 'notification',
      level: 'error',
      title: t('shell.archive.failedTitle', { verb }),
      body: t('shell.archive.failedBody', { verb, count: outcome.rejected }) + suffix,
    }
  }
  return {
    type: 'notification',
    level: 'warning',
    title: t('shell.archive.partialTitle', { verb }),
    body: t('shell.archive.partialBody', { fulfilled: outcome.fulfilled, rejected: outcome.rejected }) + suffix,
  }
}
