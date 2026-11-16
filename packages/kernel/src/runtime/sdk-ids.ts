/**
 * `@earendil-works/pi-durable` brand count value ID boundary convert auxiliary.
 *
 * SDK use name meaning brand type (`ConversationId`,`EntryId`,`SubmissionId`,`TaskId`)
 * zone each durable entity main key; kernel for outside protocol and store layer with ordinary `number` pass and in boundary before do
 * integer validate, concentrate via this module narrow convert enter SDK, take proxy zero scatter `as never`.
 */
import type { ConversationId, EntryId, Id, SubmissionId, TaskId } from '@earendil-works/pi-durable'

export function asSdkId<I extends Id<string>>(value: number): I {
  return value as I
}

export function asConversationId(id: number): ConversationId {
  return id as ConversationId
}

export function asEntryId(id: number): EntryId {
  return id as EntryId
}

export function asSubmissionId(id: number): SubmissionId {
  return id as SubmissionId
}

export function asTaskId<R = unknown>(id: number): TaskId<R> {
  return id as TaskId<R>
}
