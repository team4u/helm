/**
 * composerCompleter 插件源浮层（'@' '#' ':'）：
 * - 定位复用既有 .composer-box 相对定位 + .composer-popover 视觉类（Radix
 *   Popover Anchor 挂载，满足 WAI-ARIA combobox/listbox 契约，非裸 div）；
 * - 键盘：↑↓ 仅在可见候选内循环（修复旧 12 显示/全量索引不一致），Enter 选中、
 *   Escape 关闭，全部事件在浮层内消化并保持 textarea 焦点（IME composing 不误提交）；
 * - 状态可辨：loading（骨架行）/ 空态 / 逐源错误；截断时显式提示候选上限。
 * 组件文件只导出组件与 TS 类型（Fast Refresh 约定）。
 */
import { useEffect, useRef, useState } from 'react'
import type { MergedCompletionItem } from './composer-completion-model.js'
import { COMPLETION_VISIBLE_LIMIT } from './composer-completion-model.js'
import type { CompletionSourceSnapshot } from './use-composer-completion.js'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/Popover.js'

export interface CompletionPopoverProps {
  open: boolean
  /** 触发符（标题展示与 aria-label）。 */
  trigger: '@' | '#' | ':'
  snapshot: CompletionSourceSnapshot
  /** 选中候选（只替换光标前触发 token 并插入 insertText）。 */
  onPick: (item: MergedCompletionItem) => void
  onClose: () => void
  /** 宿主锚点（.composer-box；Anchor 需始终渲染，open 只控浮层显隐）。 */
  anchorRef: { current: HTMLElement | null }
}

const TRIGGER_TITLES: Record<'@' | '#' | ':', string> = {
  '@': '引用与补全',
  '#': '补全',
  ':': '补全',
}

export function CompletionPopover({ open, trigger, snapshot, onPick, onClose, anchorRef }: CompletionPopoverProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const visible = snapshot.items.slice(0, COMPLETION_VISIBLE_LIMIT)
  const itemKeys = visible.map((entry) => entry.key).join('|')

  // 候选集变化（查询/源更新）重置高亮到首项。
  useEffect(() => {
    setActiveIndex(0)
  }, [itemKeys])

  // 键盘导航：捕获期全局监听（与既有斜杠浮层同机制），composing 期间不拦截。
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      // IME 组合中不拦截任何键（组合音节可能含触发符，Enter 属干确认候选）。
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (visible.length === 0) {
        if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown') event.preventDefault()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((i) => (i + 1) % visible.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((i) => (i - 1 + visible.length) % visible.length)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const item = visible[activeIndex]
        if (item !== undefined) onPick(item)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, visible, activeIndex, onPick, onClose])

  if (!open) return null

  const anchor = anchorRef.current
  if (anchor === null) return null

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <PopoverAnchor virtualRef={{ current: anchor }} />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="composer-popover composer-completion-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
        aria-label={`${TRIGGER_TITLES[trigger]}候选`}
      >
        <div className="popover-header">
          {TRIGGER_TITLES[trigger]}
          <span style={{ color: 'var(--fg-subtle)' }}>↑↓ 选择 · Enter 确认 · Esc 关闭</span>
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label={`${TRIGGER_TITLES[trigger]}候选列表`}
          className="composer-completion-list"
        >
          {visible.map((entry, index) => (
            <button
              key={entry.key}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`popover-item${index === activeIndex ? ' popover-item-active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(entry)}
            >
              <span className="mono">{entry.item.label}</span>
              {entry.item.hint !== undefined ? <span className="popover-item-meta">{entry.item.hint}</span> : null}
            </button>
          ))}
          {visible.length === 0 ? (
            snapshot.loading ? (
              <div className="popover-item composer-completion-state" role="status">正在查询候选…</div>
            ) : snapshot.errors.length > 0 ? (
              <div className="popover-item composer-completion-state composer-completion-error" role="alert">
                {snapshot.errors.map((err) => (
                  <span key={`${err.source}:${err.message}`} title={`${err.source}: ${err.message}`}>源 {err.source}：{err.message}</span>
                ))}
              </div>
            ) : (
              <div className="popover-item composer-completion-state">没有匹配的候选</div>
            )
          ) : null}
        </div>
        {snapshot.total > visible.length ? (
          <div className="popover-item composer-completion-state" role="status" title={`候选过多，仅显示前 ${COMPLETION_VISIBLE_LIMIT} 项，可继续输入过滤`}>
            候选超过上限，仅显示前 {COMPLETION_VISIBLE_LIMIT} 项{snapshot.truncated ? `（共 ${snapshot.total} 项）` : ''}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
