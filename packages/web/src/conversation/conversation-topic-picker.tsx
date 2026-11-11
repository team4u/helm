import { useMemo, useState } from 'react'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { conversationStatusDotClass, conversationStatusTooltip } from '../shell/sidebar-model.js'
import { Popover, PopoverTrigger, PopoverAnchor, PopoverPortal, PopoverContent } from '../ui/Popover.js'
import { Tooltip } from '../ui/Tooltip.js'
import { computeTopicPickerModel, searchTopicList, visibleTopicTabs } from './conversation-topic-model.js'
import type { ConversationSummary } from '@helm/protocol'

/** 顶栏直接平铺的最近话题 Tab 数量（窄容器经 CSS 进一步收敛）。 */
const TOPIC_TAB_PREVIEW = 4

export interface TopicPickerProps {
  conversation: ConversationSummary
  /** 分屏窗格内切换只更新当前分屏目标。 */
  isSplit?: boolean
  /** Popover 内新建话题入口（与主顶栏同一语义，由窗格注入远端 node/cwd/profile 继承逻辑）。 */
  newTopicDisabled?: boolean
  onNewTopic?: () => void
}

/**
 * 主舞台顶栏话题切换（方案一）：
 * - PC 端直接平铺最近活跃话题 Tabs，当前话题用与左栏智能体一致的
 *   nav-active 微浮起卡片高亮，其余话题安静透明，一键直切；
 * - 超出预览数量时提供「更多」按钮；点击当前话题 Tab 同样展开完整列表
 *   （搜索 + 全量话题 + 新建），窄屏/手机仅保留当前话题 Tab 也能进入列表。
 */
export function TopicPicker({ conversation, isSplit, newTopicDisabled, onNewTopic }: TopicPickerProps) {
  const store = useHelmStore()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

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
  const tabs = useMemo(() => visibleTopicTabs(model.topics, TOPIC_TAB_PREVIEW), [model.topics])
  const visible = useMemo(() => searchTopicList(model.topics, query), [model.topics, query])

  const openTopic = (convId: number): void => {
    store.openTarget(
      { kind: 'conversation', conversationId: convId },
      isSplit ? { split: true } : undefined,
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="topic-tabs" role="group" aria-label={`话题切换：${model.profileLabel}`}>
          {tabs.map(({ conv, active }) => {
            const dotClass = conversationStatusDotClass(conv.status)
            const statusTooltip = conversationStatusTooltip(conv.status, conv.doing, conv.lastError)
            const label = conv.title || `会话 #${conv.id}`
            return (
              <Tooltip key={conv.id} content={dotClass ? `${label} · ${statusTooltip}` : label} side="bottom">
                <button
                  type="button"
                  className={`topic-tab${active ? ' topic-tab-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => {
                    // 点击当前话题：展开完整话题列表（含搜索与新建）
                    if (active) {
                      setOpen(true)
                      return
                    }
                    openTopic(conv.id)
                  }}
                >
                  {dotClass ? (
                    <span className={dotClass} title={statusTooltip} aria-label={statusTooltip} />
                  ) : (
                    <span className="topic-picker-dot-spacer" />
                  )}
                  <span className="topic-tab-title">{label}</span>
                  {active && <HelmIcon name="chevron-down" size={11} className="topic-tab-chevron" />}
                </button>
              </Tooltip>
            )
          })}
          {model.topicCount > tabs.length ? (
            <Tooltip content={`查看全部 ${model.topicCount} 个话题`} side="bottom">
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="topic-tab topic-tab-more"
                  aria-label={`查看全部 ${model.topicCount} 个话题`}
                  title={`查看全部 ${model.topicCount} 个话题`}
                >
                  <HelmIcon name="chevron-down" size={12} />
                  <span className="tabular-nums">{model.topicCount}</span>
                </button>
              </PopoverTrigger>
            </Tooltip>
          ) : null}
        </div>
      </PopoverAnchor>
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
