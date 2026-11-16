/**
 * `@earendil-works/pi-durable` 品牌化数值 ID 边界转换辅助。
 *
 * SDK 使用名义品牌类型（`ConversationId`、`EntryId`、`SubmissionId`、`TaskId`）
 * 区分各持久实体主键；内核对外协议与存储层以普通 `number` 传递并在入界前做
 * 整数校验，集中经本模块窄转换进入 SDK，取代零散 `as never`。
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
