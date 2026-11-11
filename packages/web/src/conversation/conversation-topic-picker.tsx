import { useMemo, useState } from 'react'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { conversationStatusDotClass, conversationStatusTooltip } from '../shell/sidebar-model.js'
import { Popover, PopoverTrigger, PopoverPortal, PopoverContent } from '../ui/Popover.js'
import { Tooltip } from '../ui/Tooltip.js'
import { computeTopicPickerModel, searchTopicList } from './conversation-topic-model.js'
import type { ConversationSummary } from '@helm/protocol'

export interface TopicPickerProps {
  conversation: ConversationSummary
  /** 分屏窗格内切换只更新当前分屏目标。 */
  isSplit?: boolean
  /** Popover 内新建话题入口（与主顶栏同一语义，由窗格注入远端 node/cwd/profile 继承逻辑）。 */
  newTopicDisabled?: boolean
  onNewTopic?: () => void
}

/**
 * 主舞台顶栏话题切换器：紧凑展示当前智能体/当前话题身份，
 * Popover 内搜索并切换当前 profile 下的根会话（主屏或当前分屏目标）。
 */
export function TopicPicker({ conversation, isSplit, newTopicDisabled, onNewTopic }: TopicPickerProps) {
  const store = useHelmStore()
  const [query, setQuery] = useState('')

  const profile = store.profiles.find((p) => p.id === conversation.profileId)
  const model = useMemo(
    () =>
      computeTopicPickerModel({
        conversation,
        conversations: store.conversations,
        profileLabel: profile?.name,
      }),
    [conversation, store.conversations, profile?.name],
  )
  const visible = useMemo(() => searchTopicList(model.topics, query), [model.topics, query])

  const openTopic = (convId: number): void => {
    store.openTarget(
      { kind: 'conversation', conversationId: convId },
      isSplit ? { split: true } : undefined,
    )
  }

  return (
    <Popover>
      <Tooltip content="切换当前智能体下的话题" side="bottom">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="topic-picker-trigger"
            aria-label={`话题切换器：${model.profileLabel} / ${model.currentTitle}`}
            title={`切换当前智能体下的话题（共 ${model.topicCount} 个）`}
          >
            <span className="topic-picker-identity">
              <span className="topic-picker-profile">{model.profileLabel}</span>
              <span className="topic-picker-sep">/</span>
              <span className="topic-picker-title">{model.currentTitle}</span>
            </span>
            <span className="topic-picker-count tabular-nums">{model.topicCount}</span>
            <HelmIcon name="chevron-down" size={12} />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverPortal>
        <PopoverContent className="topic-picker-popover" align="start" sideOffset={6}>
          <div className="topic-picker-search">
            <HelmIcon name="search" size={12} />
            <input
              className="topic-picker-search-input"
              value={query}
              placeholder="搜索话题标题或 #id"
              aria-label="搜索话题"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="topic-picker-list">
            {visible.length === 0 ? (
              <div className="topic-picker-empty">没有匹配的话题</div>
            ) : (
              visible.map(({ conv, active }) => {
                const dotClass = conversationStatusDotClass(conv.status)
                const tooltip = conversationStatusTooltip(conv.status, conv.doing, conv.lastError)
                return (
                  <button
                    key={conv.id}
                    type="button"
                    className={`topic-picker-item${active ? ' topic-picker-item-active' : ''}`}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => openTopic(conv.id)}
                  >
                    {dotClass ? (
                      <span className={dotClass} title={tooltip} aria-label={tooltip} />
                    ) : (
                      <span className="topic-picker-dot-spacer" />
                    )}
                    <span className="topic-picker-item-title">{conv.title || `会话 #${conv.id}`}</span>
                    <span className="topic-picker-item-id tabular-nums">#{conv.id}</span>
                    {conv.nodeId && conv.nodeId !== 'local' ? (
                      <span className="topic-picker-item-node mono" title={`运行节点：${conv.nodeId}`}>
                        @{conv.nodeId}
                      </span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
          {onNewTopic ? (
            <button
              type="button"
              className="topic-picker-new-btn"
              disabled={newTopicDisabled}
              onClick={onNewTopic}
            >
              <HelmIcon name="plus" size={12} />
              在当前智能体下新建话题
            </button>
          ) : null}
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  )
}
