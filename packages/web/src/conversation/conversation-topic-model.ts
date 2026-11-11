/**
 * 主舞台顶栏「话题切换器」纯函数模型：
 * 从当前会话推导触发器身份文案，并消费 sidebar-model 的话题列表构建/过滤函数。
 * 纯函数无 React 依赖，供 ConversationPane / 话题 Popover 与单测共同消费。
 */
import type { ConversationSummary } from '@helm/protocol'
import { buildProfileTopics, filterTopicList, type TopicListItem } from '../shell/sidebar-model.js'

export interface TopicPickerModelInput {
  conversation: ConversationSummary
  conversations: ConversationSummary[]
  profileLabel?: string
}

export interface TopicPickerModel {
  /** 当前 profile 的展示名（触发器身份用）。 */
  profileLabel: string
  /** 当前话题标题（空标题回退 #id）。 */
  currentTitle: string
  /** 当前 profile 的根话题列表（已按 pinned/updatedAt/id 稳定排序）。 */
  topics: TopicListItem[]
  /** 话题总数（触发器徽标）。 */
  topicCount: number
}

/** 计算话题切换器身份与话题列表（不含搜索过滤）。 */
export function computeTopicPickerModel({
  conversation,
  conversations,
  profileLabel,
}: TopicPickerModelInput): TopicPickerModel {
  const label = profileLabel?.trim() || conversation.profileId
  const topics = buildProfileTopics(conversations, conversation.profileId, conversation.id)
  return {
    profileLabel: label,
    currentTitle: conversation.title === '' ? `会话 #${conversation.id}` : conversation.title,
    topics,
    topicCount: topics.length,
  }
}

/** 对话题列表应用搜索过滤（标题 / #id）。 */
export function searchTopicList(items: TopicListItem[], query: string): TopicListItem[] {
  return filterTopicList(items, query)
}
