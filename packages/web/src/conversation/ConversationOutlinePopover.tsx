import { useEffect, useMemo, useRef, useState } from 'react'
import { HelmIcon, Popover, PopoverContent, PopoverTrigger } from '@helm/plugin-client'
import { formatMessageTime } from '../lib/format.js'
import {
  countOutlineTurns,
  filterOutlineNodes,
  type OutlineFilterMode,
  type OutlineNode,
} from './outline-model.js'

export interface OutlineJumpTarget {
  entryId: string
  headingIndex?: number
  /** 回合内业务卡二级锚（AssistantTurn 顶层 tool.view 卡的 tool key）。 */
  cardId?: string
  nodeKey?: string
}

export interface ConversationOutlinePopoverProps {
  nodes: ReadonlyArray<OutlineNode>
  /** 当前视口阅读位置对应的激活 entryId。 */
  activeEntryId?: string
  /** 当前大纲节点的唯一 key；文档大纲使用它区分同一 entryId 下的不同标题。 */
  activeNodeKey?: string
  /** 触发按钮文案，默认「大纲」。 */
  triggerLabel?: string
  /** 触发按钮标题，默认显示会话轮数。 */
  triggerTitle?: string
  /** 触发按钮角标数量，未传时使用人类提问轮数。 */
  badgeCount?: number
  /** 搜索框占位文案。 */
  searchPlaceholder?: string
  /** 浮层与搜索框的无障碍名称。 */
  accessibilityLabel?: string
  /** 是否显示「对话 / 仅提问 / 全部」切换，文档大纲不需要该切换。 */
  showModeToggle?: boolean
  /** 是否通过 Portal 渲染浮层；Dialog 内嵌使用 false 避免落到模态层外。 */
  portalled?: boolean
  /** 是否强制挂载浮层内容；嵌套 Dialog 中可避免 Radix Presence 首次打开丢失内容。 */
  forceMount?: boolean
  /** 是否存在更早的未加载历史分页。 */
  hasEarlierHistory?: boolean
  loadingEarlierHistory?: boolean
  onLoadEarlierHistory?: () => void
  onSelectTarget: (target: OutlineJumpTarget) => void
}

/**
 * 会话顶栏「大纲」快速导航浮层（基于 Radix Popover 原语）：
 * - 按时间序列出全部提问回合（#1, #2...）、助手回复摘要/Markdown 标题（H1~H3）、
 *   业务卡（tool.view 顶层卡与 timeline.renderer 接管卡）与上下文分割线；
 * - 支持实时关键词检索（提问/回复全文、卡片摘要与标题）与「全部 / 仅提问」切换；
 * - 支持 ↑ / ↓ / Enter 键盘快速跳转，点击或回车后平滑定位并闪烁高亮目标消息
 *   （标题按 headingIndex、业务卡按 cardId 二级锚精确到具体卡片 DOM）。
 */
export function ConversationOutlinePopover({
  nodes,
  activeEntryId,
  activeNodeKey,
  triggerLabel = 'Outline',
  triggerTitle,
  badgeCount,
  searchPlaceholder = 'Search questions, replies and cards…',
  accessibilityLabel = 'Conversation outline',
  showModeToggle = true,
  portalled = true,
  forceMount,
  hasEarlierHistory = false,
  loadingEarlierHistory = false,
  onLoadEarlierHistory,
  onSelectTarget,
}: ConversationOutlinePopoverProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<OutlineFilterMode>('dialogue')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const effectiveMode: OutlineFilterMode = showModeToggle ? mode : 'all'
  const turnCount = useMemo(() => countOutlineTurns(nodes), [nodes])
  const displayCount = badgeCount ?? turnCount
  const hasFilterableNodes = useMemo(
    () =>
      nodes.some(
        (n) => (n.kind === 'human' && n.origin !== 'human') || (n.kind !== 'human' && n.kind !== 'divider'),
      ),
    [nodes],
  )

  const filtered = useMemo(
    () => filterOutlineNodes(nodes, { query, mode: effectiveMode }),
    [nodes, query, effectiveMode],
  )

  // 打开浮层时：默认将键盘焦点索引对齐到当前激活项（若存在），否则置为最后一项（最新提问）或首项。
  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    if (activeNodeKey !== undefined) {
      const idx = filtered.findIndex((n) => n.key === activeNodeKey)
      if (idx >= 0) {
        setSelectedIdx(idx)
        return
      }
    }
    if (activeEntryId !== undefined) {
      const idx = filtered.findIndex((n) => n.entryId === activeEntryId)
      if (idx >= 0) {
        setSelectedIdx(idx)
        return
      }
    }
    setSelectedIdx(filtered.length > 0 ? filtered.length - 1 : 0)
  }, [open])

  // 搜索词或过滤开关变化时重置选中索引
  useEffect(() => {
    setSelectedIdx(0)
  }, [query, effectiveMode])

  // 键盘移动或初次打开时将选中项滚动进浮层可视区
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-outline-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, selectedIdx])

  if (nodes.length === 0) return null

  const triggerSelect = (node: OutlineNode): void => {
    setOpen(false)
    onSelectTarget({
      entryId: node.entryId,
      nodeKey: node.key,
      ...(node.kind === 'heading' ? { headingIndex: node.headingIndex } : {}),
      ...(node.kind === 'card' && node.cardId !== undefined ? { cardId: node.cardId } : {}),
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (filtered.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => (i + 1) % filtered.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => (i - 1 + filtered.length) % filtered.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[selectedIdx]
      if (target !== undefined) triggerSelect(target)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`btn btn-sm conversation-outline-trigger${open ? ' is-open' : ''}`}
          aria-label={`${accessibilityLabel} navigation`}
          title={triggerTitle ?? `Conversation outline navigation (${turnCount} question turns)`}
        >
          <HelmIcon name="list-tree" size={12} />
          <span className="pane-action-label">{triggerLabel}</span>
          {displayCount > 0 ? (
            <span className="badge badge-neutral tabular-nums">{displayCount}</span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        portalled={portalled}
        forceMount={forceMount ? true : undefined}
        align="end"
        sideOffset={6}
        className="conversation-outline-popover"
        aria-label={accessibilityLabel}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          searchInputRef.current?.focus()
        }}
        onKeyDown={handleKeyDown}
      >
          <div className="conversation-outline-header">
            <div className="search-box conversation-outline-search">
              <HelmIcon name="search" size={13} />
              <input
                ref={searchInputRef}
                type="text"
                aria-label={`Filter ${accessibilityLabel}`}
                placeholder={searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query !== '' ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon-xs"
                  aria-label="Clear outline search"
                  title="Clear search"
                  onClick={() => {
                    setQuery('')
                    searchInputRef.current?.focus()
                  }}
                >
                  <HelmIcon name="x" size={11} />
                </button>
              ) : null}
            </div>
            {hasFilterableNodes && showModeToggle ? (
              <div className="segmented-control conversation-outline-mode" role="group" aria-label="Outline level switch">
                {(
                  [
                    ['dialogue', 'Conversation'],
                    ['questions', 'Questions only'],
                    ['all', 'All'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`segmented-control-btn${mode === value ? ' is-active' : ''}`}
                    aria-pressed={mode === value}
                    onClick={() => setMode(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {hasEarlierHistory && onLoadEarlierHistory !== undefined ? (
            <div className="conversation-outline-earlier-bar">
              <button
                type="button"
                className="btn btn-ghost btn-xs conversation-outline-earlier-btn"
                disabled={loadingEarlierHistory}
                onClick={() => onLoadEarlierHistory()}
              >
                <HelmIcon name={loadingEarlierHistory ? 'loader' : 'arrow-up'} size={11} className={loadingEarlierHistory ? 'spin-slow' : undefined} />
                {loadingEarlierHistory ? 'Loading earlier history…' : 'Load earlier messages to complete the outline'}
              </button>
            </div>
          ) : null}

          <div ref={listRef} className="conversation-outline-list" role="listbox" aria-label="Conversation outline entries">
            {filtered.length === 0 ? (
              <div className="conversation-outline-empty">
                No matching outline entries
              </div>
            ) : (
              filtered.map((node, idx) => {
                const isSelected = idx === selectedIdx
                const isActive = activeNodeKey !== undefined
                  ? node.key === activeNodeKey
                  : activeEntryId !== undefined && node.entryId === activeEntryId

                if (node.kind === 'divider') {
                  return (
                    <button
                      key={node.key}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-outline-idx={idx}
                      className={`conversation-outline-item conversation-outline-divider${isSelected ? ' is-selected' : ''}`}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => triggerSelect(node)}
                    >
                      <HelmIcon name={node.divider === 'reset' ? 'rotate-ccw' : 'archive'} size={11} />
                      <span className="conversation-outline-divider-label">{node.label}</span>
                    </button>
                  )
                }

                if (node.kind === 'heading') {
                  return (
                    <button
                      key={node.key}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-outline-idx={idx}
                      className={`conversation-outline-item conversation-outline-heading conversation-outline-heading-h${node.level}${isSelected ? ' is-selected' : ''}${isActive ? ' is-current' : ''}`}
                      title={node.text}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => triggerSelect(node)}
                    >
                      <span className="conversation-outline-heading-marker mono">H{node.level}</span>
                      <span className="conversation-outline-item-label">{node.text}</span>
                    </button>
                  )
                }

                if (node.kind === 'assistant') {
                  const timeText = formatMessageTime(node.createdAt)
                  return (
                    <button
                      key={node.key}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-outline-idx={idx}
                      className={`conversation-outline-item conversation-outline-assistant${isSelected ? ' is-selected' : ''}${isActive ? ' is-current' : ''}`}
                      title={node.fullText !== '' ? node.fullText : node.label}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => triggerSelect(node)}
                    >
                      <HelmIcon
                        name={node.live ? 'loader' : 'sparkles'}
                        size={11}
                        className={node.live ? 'spin-slow' : undefined}
                      />
                      <span className="conversation-outline-item-label">{node.label}</span>
                      {node.status === 'failed' ? (
                        <span className="conversation-outline-status-badge">Failed</span>
                      ) : null}
                      {timeText !== '' ? (
                        <span className="conversation-outline-time mono tabular-nums">{timeText}</span>
                      ) : null}
                    </button>
                  )
                }

                if (node.kind === 'card') {
                  const cardIcon =
                    node.status === 'running' ? 'loader' : node.status === 'error' ? 'alert-triangle' : 'layout-grid'
                  return (
                    <button
                      key={node.key}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-outline-idx={idx}
                      {...(node.status !== undefined ? { 'data-status': node.status } : {})}
                      className={`conversation-outline-item conversation-outline-card${isSelected ? ' is-selected' : ''}${isActive ? ' is-current' : ''}`}
                      title={node.searchText}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => triggerSelect(node)}
                    >
                      <HelmIcon
                        name={cardIcon}
                        size={11}
                        className={node.status === 'running' ? 'spin-slow' : undefined}
                      />
                      <span className="conversation-outline-item-label">{node.label}</span>
                    </button>
                  )
                }

                const timeText = formatMessageTime(node.createdAt)
                return (
                  <button
                    key={node.key}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-outline-idx={idx}
                    className={`conversation-outline-item conversation-outline-human${isSelected ? ' is-selected' : ''}${isActive ? ' is-current' : ''}`}
                    title={node.fullText}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    onClick={() => triggerSelect(node)}
                  >
                    <span className="conversation-outline-turn-badge mono tabular-nums">
                      #{node.turnIndex}
                    </span>
                    {node.origin !== 'human' ? (
                      <HelmIcon
                        name={node.origin === 'trigger' ? 'webhook' : 'bot'}
                        size={11}
                        className="conversation-outline-origin-icon"
                      />
                    ) : null}
                    <span className="conversation-outline-item-label">{node.label}</span>
                    {timeText !== '' ? (
                      <span className="conversation-outline-time mono tabular-nums">{timeText}</span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
      </PopoverContent>
    </Popover>
  )
}
