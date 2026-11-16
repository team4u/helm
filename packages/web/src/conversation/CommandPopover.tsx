import { useEffect, useMemo, useState } from 'react'

// ---------------------------------------------------------------------------
// 斜杠 / 产物引用浮层（自 Composer.tsx 拆出）
// ---------------------------------------------------------------------------

export interface PopoverItem {
  id: string
  label: string
  hint?: string
  /** 回填草稿的触发词（插件命令改用 run 直接执行，不回填）。 */
  apply?: string
  /** 插件命令：选中即执行（不回填触发词到草稿）。 */
  run?: () => void
}
/** 键盘可见候选上限：↑↓ 循环只在此列表内（显示与键盘索引一致）。 */
const SLASH_VISIBLE_LIMIT = 12

export function CommandPopover({
  query,
  slashItems,
  onPick,
  onClose,
}: {
  query: string
  /** 已合并好的斜杠菜单条目（含插件命令）；省略时回退宿主内置三源构建。 */
  slashItems?: ReadonlyArray<PopoverItem>
  onPick: (apply: string, caretSuffix?: string) => void
  onClose: () => void
}) {
  const [active, setActive] = useState(0)

  const items = useMemo<PopoverItem[]>(() => {
    const q = query.toLowerCase()
    if (slashItems !== undefined) {
      return slashItems.filter((i) => i.id.toLowerCase().includes(q) || i.label.toLowerCase().includes(q))
    }
    const builtin: PopoverItem[] = [
      { id: '/new', label: '/new', hint: '开始新话题', apply: '/new' },
      { id: '/clear', label: '/clear', hint: '重置上下文', apply: '/clear' },
      { id: '/compact', label: '/compact', hint: '精简上下文', apply: '/compact' },
    ]
    return builtin.filter((i) => i.id.toLowerCase().includes(q))
  }, [query, slashItems])

  // 键盘循环限定可见候选，修复显示截断但索引越界到不可见项的旧问题。
  // 记忆化保持数组身份稳定：条目集不变时键盘 effect 不重挂全局监听。
  const visible = useMemo(() => items.slice(0, SLASH_VISIBLE_LIMIT), [items])
  const visibleKeys = visible.map((item) => item.id).join('|')

  useEffect(() => {
    setActive(0)
  }, [query, visibleKeys])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // IME 组合中不拦截（组合音节可能含触发符，Enter 属确认候选）。
      if (e.isComposing || e.keyCode === 229) return
      if (visible.length === 0) {
        if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          onClose()
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        setActive((i) => (i + 1) % visible.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        setActive((i) => (i - 1 + visible.length) % visible.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        const item = visible[active]
        if (item !== undefined) {
          if (item.run !== undefined) {
            item.run()
            onClose()
          } else if (item.apply !== undefined) {
            onPick(item.apply)
          }
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, active, onPick, onClose])

  if (visible.length === 0) {
    return (
      <div className="composer-popover">
        <div className="popover-item" style={{ color: 'var(--fg-muted)' }}>
          没有匹配的命令或技能
        </div>
      </div>
    )
  }

  return (
    <div className="composer-popover">
      <div className="popover-header">
        命令与技能
        <span style={{ color: 'var(--fg-subtle)' }}>↑↓ 选择 · Enter 确认 · Esc 关闭</span>
      </div>
      {visible.map((item, idx) => (
        <button
          key={item.id}
          type="button"
          className={`popover-item${idx === active ? ' popover-item-active' : ''}`}
          onMouseEnter={() => setActive(idx)}
          onClick={() => {
            if (item.run !== undefined) {
              item.run()
              onClose()
            } else if (item.apply !== undefined) {
              onPick(item.apply)
            }
          }}
        >
          <span className="mono">{item.label}</span>
          {item.hint !== undefined ? <span className="popover-item-meta">{item.hint}</span> : null}
        </button>
      ))}
      {items.length > visible.length ? (
        <div className="popover-item" style={{ color: 'var(--fg-subtle)', cursor: 'default' }}>
          候选过多，仅显示前 {SLASH_VISIBLE_LIMIT} 项，可继续输入过滤
        </div>
      ) : null}
    </div>
  )
}
