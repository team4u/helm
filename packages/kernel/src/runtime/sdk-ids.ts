/**
 * Narrowing helpers for `@earendil-works/pi-durable` branded numeric IDs.
 *
 * The SDK distinguishes durable primary keys via nominal branded types (`ConversationId`, `EntryId`,
 * `SubmissionId`, `TaskId`); external protocol and store layers pass plain `number` values and validate
 * integer bounds at boundaries before narrowing here—replacing scattered `as never` casts.
 */
import type { ConversationId, EntryId, Id, SubmissionId, TaskId } from '@earendil-works/pi-durable'

export function asConversationId(id: number): ConversationId {
  return id as ConversationId
}

export function asEntryId(id: number): EntryId {
  return id as EntryId
}

