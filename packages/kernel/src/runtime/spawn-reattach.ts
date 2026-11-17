/**
 * 原生 subagent 跨重启原位重挂（reattach）校验与会话条目扫描辅助函数。
 *
 * 职责：
 * - assertSpawnRequestModes：入口与钩子收敛后共用的 mode/requestId/reattach 形状校验
 *   及互斥检查（reattach 与 resume / fork 互斥，reattach.conversationId 必须携带 requestId）；
 * - recoverAcceptedStructuredOutput：从 submission.entry 起扫描已落库的非错误
 *   register_structured_output 调用，跨重启回填 structured.accepted；
 * - readSubmissionAssistantText：从已结算 submission.answer（及 submission 区间）读取
 *   assistant 文本，解决崩溃重启瞬间已完成回合在内存 lastAssistant 缓存缺失的问题。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Conversation, EntryId, EntryRecord, SettledSubmissionRecord } from '@earendil-works/pi-durable'
import { HelmError, isAbsoluteAgentPath, type AgentSpawnRequest } from '@helm/protocol'
import { assertSpawnForkFields } from './spawn-fork.js'
import { extractAcceptedStructuredOutputFromEntries } from './structured-output.js'

const ENTRY_SCAN_PAGE_SIZE = 256

/**
 * 校验 requestId、reattach、resume 与 fork 的字段形状及互斥约束：
 * - reattach 与 resume / fork 互斥（400 validation_error）；
 * - reattach 必须是含 conversationId 或 executionId 的普通对象；
 * - reattach.conversationId 必须是正安全整数且携带非空 requestId（确保提交去重）。
 */
export function assertSpawnRequestModes(
  request: Pick<AgentSpawnRequest, 'fork' | 'resume' | 'reattach' | 'requestId'>,
): void {
  assertSpawnForkFields(request)
  if (request.requestId !== undefined) {
    if (typeof request.requestId !== 'string' || request.requestId.trim() === '') {
      throw new HelmError(
        'validation_error',
        `requestId 必须是非空字符串（收到 ${String(request.requestId)}）`,
        400,
        { requestId: request.requestId },
      )
    }
  }
  if (request.reattach === undefined) return
  const raw = request.reattach
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmError('validation_error', 'reattach 必须是普通对象', 400)
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'conversationId' && key !== 'executionId' && key !== 'effectiveCwd') {
      throw new HelmError('validation_error', `reattach 包含未知字段 "${key}"`, 400, { field: key })
    }
  }
  if (request.resume !== undefined) {
    throw new HelmError(
      'validation_error',
      'reattach 与 resume 互斥：不能同时原位重挂和续接既有子代理',
      400,
      { resume: request.resume },
    )
  }
  if (request.fork === true) {
    throw new HelmError(
      'validation_error',
      'reattach 与 fork 互斥：不能同时原位重挂和从父会话分叉',
      400,
    )
  }
  if (raw.conversationId !== undefined) {
    if (typeof raw.conversationId !== 'number' || !Number.isSafeInteger(raw.conversationId) || raw.conversationId <= 0) {
      throw new HelmError(
        'validation_error',
        `reattach.conversationId 必须是正安全整数（收到 ${String(raw.conversationId)}）`,
        400,
        { conversationId: raw.conversationId },
      )
    }
  }
  if (raw.executionId !== undefined) {
    if (typeof raw.executionId !== 'string' || raw.executionId.length === 0) {
      throw new HelmError(
        'validation_error',
        `reattach.executionId 必须是非空字符串（收到 ${String(raw.executionId)}）`,
        400,
        { executionId: raw.executionId },
      )
    }
  }
  if (raw.effectiveCwd !== undefined) {
    if (typeof raw.effectiveCwd !== 'string' || !isAbsoluteAgentPath(raw.effectiveCwd)) {
      throw new HelmError(
        'validation_error',
        `reattach.effectiveCwd 必须是绝对路径（收到 ${String(raw.effectiveCwd)}）`,
        400,
        { effectiveCwd: raw.effectiveCwd },
      )
    }
  }
  if (raw.conversationId === undefined && raw.executionId === undefined) {
    throw new HelmError('validation_error', 'reattach 至少需要提供 conversationId 或 executionId', 400)
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
 * 扫描子会话自本次 submission.entry 起已落库的非错误 register_structured_output
 * 工具调用，若崩溃前已通过 Schema 校验则返回其结构化产物以回填 accepted。
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
 * 读取指定 submission 对应的 assistant 文本：优先精确读取 settled.answer 条目，
 * 若该条目无文本块则在 [settled.entry, settled.answer] 区间倒序查找最新非空
 * pi.assistant 文本（遇 reset/rewind 停止）。
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
      if (entry.kind === 'pi.reset' || entry.kind === 'helm.rewind') return undefined
      const text = assistantTextFromEntry(entry)
      if (text !== '') return text
    }
    if (page.next === undefined) break
    cursor = page.next
  }
  return undefined
}
