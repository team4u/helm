import React, { useEffect, useId, useRef, useState } from 'react'
import { HelmIcon } from '../lib/icons.js'
import { findNextSelectableIndex, type SelectOption, type SelectChangeEvent } from './select-model.js'

export type { SelectOption, SelectChangeEvent }

export interface SelectProps<T extends string = string> {
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (event: SelectChangeEvent<T>) => void
  disabled?: boolean
  prefixIcon?: string
  placeholder?: string
  className?: string
  style?: React.CSSProperties
  size?: 'sm' | 'md'
  'aria-label'?: string
  id?: string
  name?: string
  direction?: 'down' | 'up' | 'auto'
}

/**
 * 通用极简下拉选择器（符合 Helm 气质的公共组件）：
 * - 紧凑轻量触发器，支持可选前缀图标与 Lucide 旋转折叠箭头；
 * - 浮层式下拉项展示，支持选项图标、次级状态标签与激活勾选；
 * - 完整的 WAI-ARIA combobox 语义与键盘无障碍交互（上下键、Enter/Space 选中、Escape 关闭）；
 * - 视口边界自适应向上/向下展开；
 * - 点击浮层外部自动收起。
 */
export function Select<T extends string = string>({
  value,
  options,
  onChange,
  disabled = false,
  prefixIcon,
  placeholder = '请选择',
  className = '',
  style,
  size,
  'aria-label': ariaLabel,
  id,
  name,
  direction = 'auto',
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [actualDirection, setActualDirection] = useState<'down' | 'up'>('down')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const generatedId = useId()
  const selectId = id ?? generatedId
  const listboxId = `${selectId}-listbox`

  const selectedIndex = options.findIndex((opt) => opt.value === value)
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex)

  useEffect(() => {
    if (open) {
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0)
      if (direction === 'auto') {
        if (triggerRef.current && typeof window !== 'undefined') {
          const rect = triggerRef.current.getBoundingClientRect()
          const spaceBelow = window.innerHeight - rect.bottom
          const spaceAbove = rect.top
          setActualDirection(spaceBelow < 220 && spaceAbove > spaceBelow ? 'up' : 'down')
        }
      } else {
        setActualDirection(direction)
      }
    }
  }, [open, selectedIndex, direction])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const selectOption = (opt: SelectOption<T>): void => {
    if (opt.disabled) return
    setOpen(false)
    if (opt.value !== value) {
      onChange({ target: { value: opt.value, name } })
    }
    triggerRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return

    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((prev) => findNextSelectableIndex(options, prev, 1))
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((prev) => findNextSelectableIndex(options, prev, -1))
      return
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const opt = options[highlightedIndex]
      if (opt !== undefined && !opt.disabled) {
        selectOption(opt)
      }
      return
    }

    if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div
      ref={rootRef}
      className={['helm-select', size ? `helm-select-${size}` : '', className].filter(Boolean).join(' ')}
      style={style}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        id={selectId}
        className="helm-select-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          if (!disabled) setOpen((v) => !v)
        }}
      >
        {prefixIcon ? <HelmIcon name={prefixIcon} size={12} className="helm-select-prefix" /> : null}
        <span className={`helm-select-label${selectedOption ? '' : ' helm-select-placeholder'}`}>
          {selectedOption?.label ?? placeholder}
        </span>
        <HelmIcon
          name="chevron-down"
          size={12}
          className={`helm-select-chevron${open ? ' helm-select-chevron-open' : ''}`}
        />
      </button>

      {open ? (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className={`helm-select-popover direction-${actualDirection}`}
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value
            const isHighlighted = idx === highlightedIndex
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={opt.disabled}
                className={`helm-select-option${isSelected ? ' selected' : ''}${isHighlighted ? ' highlighted' : ''}`}
                onClick={() => selectOption(opt)}
                onMouseEnter={() => setHighlightedIndex(idx)}
              >
                {opt.icon ? <HelmIcon name={opt.icon} size={12} className="helm-select-option-icon" /> : null}
                <span className="helm-select-option-label">{opt.label}</span>
                {opt.meta ? <span className="helm-select-option-meta">{opt.meta}</span> : null}
                {isSelected ? <HelmIcon name="check" size={12} className="helm-select-check" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
