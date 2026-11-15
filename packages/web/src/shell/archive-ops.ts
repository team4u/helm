/**
 * 会话人工归档操作层（纯逻辑 + 现有会话 PATCH 通道，零 React）：
 *
 * - 归档是 Web 宿主策略：宿主命名空间 tag 经现有 `PATCH /api/conversations/:id`
 *   落库，不新增协议字段、不引入插件 ID 特判、不把 tag 交给插件 sidebar.section
 *   动态规则（插件停用清理不受影响）；
 * - 单发与批量共用同一 tag 计算函数（幂等：重复归档不重复追加，恢复保留其余
 *   tags）；批量逐会话 PATCH + allSettled 汇总，部分失败不掩盖成功项、不静默吞错；
 * - 归档/恢复不删除会话——当前打开目标始终有效，故不做任何导航回退（与删除的
 *   SSE 回退管道不同），仅依赖 conversation.upsert 事件更新侧栏列表。
 */
import type { ConversationPatch, ConversationSummary } from '@helm/protocol'
import { conversationsApi } from '../lib/api.js'
import { archiveConversationTags, restoreConversationTags } from '../conversation/archive-model.js'

/** 单会话归档/恢复 PATCH（幂等；失败显式上抛由调用方通知）。 */
export async function patchConversationArchived(
  conv: Pick<ConversationSummary, 'id' | 'tags'>,
  archived: boolean,
): Promise<ConversationSummary> {
  const tags = archived ? archiveConversationTags(conv.tags) : restoreConversationTags(conv.tags)
  const patch: ConversationPatch = { tags }
  return conversationsApi.patch(conv.id, patch)
}

/** 批量归档/恢复结果：逐项计数 + 首个错误摘要（供通知文案）。 */
export interface BatchArchiveOutcome {
  attempted: number
  fulfilled: number
  rejected: number
  firstError?: string
}

/**
 * 批量归档/恢复：按调用时快照逐会话 PATCH（allSettled 汇总，绝不静默吞错）。
 * 调用方负责传入执行时刻的会话快照（从 store 现查），已不存在的 id 自然跳过
 * （删除流程自身的通知已覆盖其结局）。
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

/** 批量归档/恢复结果 → 通知（成功 / 部分失败 / 全失败三档，附首个错误摘要）。 */
export function archiveBatchNotice(archived: boolean, outcome: BatchArchiveOutcome): ArchiveBatchNotice {
  const verb = archived ? '归档' : '恢复'
  if (outcome.rejected === 0) {
    return {
      type: 'notification',
      level: 'info',
      title: `批量${verb}完成`,
      body: `成功${verb} ${outcome.fulfilled} 个会话`,
    }
  }
  const suffix = outcome.firstError !== undefined ? `：${outcome.firstError}` : ''
  if (outcome.fulfilled === 0) {
    return {
      type: 'notification',
      level: 'error',
      title: `批量${verb}失败`,
      body: `${outcome.rejected} 个会话${verb}失败${suffix}`,
    }
  }
  return {
    type: 'notification',
    level: 'warning',
    title: `批量${verb}部分失败`,
    body: `成功 ${outcome.fulfilled} 个，失败 ${outcome.rejected} 个${suffix}`,
  }
}
