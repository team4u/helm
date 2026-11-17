import { useMemo } from 'react'
import { useWebLocale } from '../i18n/use-web-locale.js'
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
  const { t } = useWebLocale()
  const nodes = useMemo(() => buildMarkdownOutline(text), [text])
  const activeNodeKey = activeHeadingIndex === undefined
    ? undefined
    : `outline:markdown:${activeHeadingIndex}`

  return (
    <ConversationOutlinePopover
      nodes={nodes}
      activeNodeKey={activeNodeKey}
      triggerTitle={t('conv.outline.markdownTitle', { count: nodes.length })}
      badgeCount={nodes.length}
      searchPlaceholder={t('conv.outline.markdownSearch')}
      accessibilityLabel={t('conv.outline.markdownAccessibility')}
      showModeToggle={false}
      portalled={false}
      forceMount
      onSelectTarget={(target) => {
        if (target.headingIndex !== undefined) onSelectHeading(target.headingIndex)
      }}
    />
  )
}
