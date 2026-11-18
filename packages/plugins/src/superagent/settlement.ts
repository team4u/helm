import type {
  ArtifactMetadata,
  HelmHostApi,
  TurnOutcome,
  TurnSettledPayload,
} from '@helm/protocol'
import { redactJsonValue } from '@helm/protocol'
import { lastAssistantText } from '../entry-text.js'

/** 从真实会话详情与产物列表收集结算摘要（不调用模型）。 */
export async function collectWorkerSettlement(
  host: Pick<HelmHostApi, 'getConversationDetail' | 'listArtifacts' | 'redact'>,
  payload: TurnSettledPayload,
): Promise<{ summary: string; artifacts: ArtifactMetadata[]; keywords: string[] }> {
  const id = payload.conversation.id
  const [detail, artifacts] = await Promise.all([
    host.getConversationDetail(id, { limit: 10 }),
    host.listArtifacts(id),
  ])
  const lastText = lastAssistantText(detail.entries)
  const outcome: TurnOutcome = payload.outcome
  const head =
    outcome === 'completed'
      ? lastText !== ''
        ? lastText
        : `Worker #${id}（${payload.conversation.profileId}）回合完成`
      : outcome === 'failed'
        ? `Worker #${id}（${payload.conversation.profileId}）回合失败${payload.error !== undefined ? `：${payload.error}` : ''}`
        : `Worker #${id}（${payload.conversation.profileId}）回合被中止`
  const summary = truncate(host.redact(head), 600)
  const keywords = [payload.conversation.profileId, outcome, detail.title]
    .filter((k) => k !== '')
    .map((k) => host.redact(k))
  const redactedArtifacts = redactJsonValue(artifacts, (t) => host.redact(t)) as ArtifactMetadata[]
  return { summary, artifacts: redactedArtifacts, keywords }
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

/** 单条 entry 摘要文本：优先 assistant 文本，否则有界 JSON 概要（不伪造内容）。 */
function entryDigestText(entry: { kind: string; data?: unknown; model?: unknown }): string {
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
