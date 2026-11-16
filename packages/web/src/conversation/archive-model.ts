/** Web 宿主会话归档标记与纯 tags 变换。 */
import type { ConversationSummary } from '@helm/protocol/browser'

/** 人工归档 tag（Web 宿主命名空间标记，不参与插件 sidebar.section 规则）。 */
export const ARCHIVED_TAG = 'helm:archived'

/** 会话是否已人工归档。 */
export function isConversationArchived(conv: Pick<ConversationSummary, 'tags'>): boolean {
  return conv.tags.includes(ARCHIVED_TAG)
}

/** 归档 tags：幂等追加宿主标记，保留其余 tags 及其顺序。 */
export function archiveConversationTags(tags: readonly string[]): string[] {
  return tags.includes(ARCHIVED_TAG) ? [...tags] : [...tags, ARCHIVED_TAG]
}

/** 恢复 tags：移除宿主归档标记（幂等），保留其余 tags 及其顺序。 */
export function restoreConversationTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => tag !== ARCHIVED_TAG)
}
