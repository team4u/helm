import { useMemo } from 'react'
import { ConversationOutlinePopover } from './ConversationOutlinePopover.js'
import { buildMarkdownOutline } from './outline-model.js'

export interface MarkdownOutlinePopoverProps {
  text: string
  activeHeadingIndex?: number
  onSelectHeading: (headingIndex: number) => void
}

/** Markdown 预览的大纲入口：复用会话大纲的筛选、键盘导航与视觉样式。 */
export function MarkdownOutlinePopover({
  text,
  activeHeadingIndex,
  onSelectHeading,
}: MarkdownOutlinePopoverProps) {
  const nodes = useMemo(() => buildMarkdownOutline(text), [text])
  const activeNodeKey = activeHeadingIndex === undefined
    ? undefined
    : `outline:markdown:${activeHeadingIndex}`

  return (
    <ConversationOutlinePopover
      nodes={nodes}
      activeNodeKey={activeNodeKey}
      triggerTitle={`Markdown 大纲（共 ${nodes.length} 个章节）`}
      badgeCount={nodes.length}
      searchPlaceholder="搜索章节标题…"
      accessibilityLabel="Markdown 大纲"
      showModeToggle={false}
      portalled={false}
      forceMount
      onSelectTarget={(target) => {
        if (target.headingIndex !== undefined) onSelectHeading(target.headingIndex)
      }}
    />
  )
}
