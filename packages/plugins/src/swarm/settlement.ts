import type { HelmHostApi } from '@helm/protocol'
import { redactJsonValue } from '@helm/protocol'
import { lastAssistantText } from '../entry-text.js'

/** 读取会话末条 assistant 脱敏文本摘要（不调用模型，不编造占位文本）。 */
export async function collectMemberLastReplySummary(
  host: Pick<HelmHostApi, 'getConversationDetail' | 'redact'>,
  conversationId: number,
): Promise<string> {
  const detail = await host.getConversationDetail(conversationId, { limit: 10 })
  const lastText = lastAssistantText(detail.entries).trim()
  if (lastText === '') return ''
  return truncate(host.redact(lastText), 600)
}

/** 时间线条目受控摘要：assistant 取真实文本，其余取 JSON 概要（脱敏 + 截断）。 */
export function recentEntrySummaries(
  host: Pick<HelmHostApi, 'redact'>,
  entries: Array<{ id: string; kind: string; data?: unknown; model?: unknown }>,
  maxEntries = 20,
): Array<{ id: string; kind: string; text: string }> {
  const redacted = redactJsonValue(entries.slice(-maxEntries), (t) => host.redact(t)) as typeof entries
  return redacted.map((e) => ({
    id: e.id,
    kind: e.kind,
    text: truncate(entryDigestText(e), 400),
  }))
}

export function entryDigestText(entry: { kind: string; data?: unknown; model?: unknown }): string {
  const assistant = lastAssistantText([entry])
  if (assistant !== '') return assistant
  if (entry.data !== undefined) {
    const json = JSON.stringify(entry.data)
    return json.length > 400 ? `${json.slice(0, 399)}…` : json
  }
  return ''
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

