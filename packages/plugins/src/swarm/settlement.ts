import type { HelmHostApi } from '@helm/protocol'
import { entryDigestText, lastAssistantText, recentEntrySummaries, truncate } from '../entry-text.js'

export { entryDigestText, recentEntrySummaries, truncate }

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

