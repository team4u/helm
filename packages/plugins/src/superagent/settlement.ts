import type {
  ArtifactMetadata,
  HelmHostApi,
  TurnOutcome,
  TurnSettledPayload,
} from '@helm/protocol'
import { redactJsonValue } from '@helm/protocol'
import { entryDigestText, lastAssistantText, recentEntrySummaries, truncate } from '../entry-text.js'

export { entryDigestText, recentEntrySummaries, truncate }

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
