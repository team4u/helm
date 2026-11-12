import React, { useEffect, useId, useMemo, useState } from 'react'
import * as RadixSelect from '@radix-ui/react-select'
import { HelmIcon } from '../lib/icons.js'
import { Checkbox } from './Checkbox.js'
import { Popover, PopoverContent, PopoverTrigger } from './Popover.js'
import type {
  MultiSelectChangeEvent,
  SelectChangeEvent,
  SelectOption,
} from './select-model.js'

export type { MultiSelectChangeEvent, SelectChangeEvent, SelectOption }

export interface BaseSelectProps<T extends string = string> {
  options: ReadonlyArray<SelectOption<T>>
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
  open?: boolean
  onOpenChange?: (open: boolean) => void
  inline?: boolean
  /** 下拉浮层附加类名（如 helm-select-popover-wide 加宽长模型 ID 面板）。 */
  popoverClassName?: string
}

export interface SingleSelectProps<T extends string = string> extends BaseSelectProps<T> {
  multiple?: false
  value: T
  onChange: (event: SelectChangeEvent<T>) => void
}

export interface MultiSelectProps<T extends string = string> extends BaseSelectProps<T> {
  multiple: true
  value: readonly T[] | T[]
  onChange?: (event: MultiSelectChangeEvent<T>) => void
  onValuesChange?: (values: T[]) => void
  showActions?: boolean
  searchable?: boolean
  renderTriggerLabel?: (
    selectedValues: T[],
    options: ReadonlyArray<SelectOption<T>>,
  ) => React.ReactNode
}

export type SelectProps<T extends string = string> = SingleSelectProps<T> | MultiSelectProps<T>

/**
 * SSR 容错 Portal：在服务端渲染 (typeof window === 'undefined') 或显式 inline 模式下，
 * 直接内联直出 children，避免 createPortal 依赖 document.body 导致测试渲染降级或返回空内容。
 */
export function SelectPortal({
  inline = false,
  children,
  container,
}: RadixSelect.SelectPortalProps & { inline?: boolean }) {
  if (inline || typeof window === 'undefined') {
    return <>{children}</>
  }
  return (
    <RadixSelect.Portal container={container ?? (typeof document !== 'undefined' ? document.body : undefined)}>
      {children}
    </RadixSelect.Portal>
  )
}

/**
 * 通用单选下拉组件实现（保持原有 Radix UI Select 契约）
 */
function SingleSelectInner<T extends string = string>({
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
  open: openProp,
  onOpenChange,
  inline = false,
  popoverClassName,
}: SingleSelectProps<T>) {
  const generatedId = useId()
  const selectId = id ?? generatedId
  const [internalOpen, setInternalOpen] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const isControlled = openProp !== undefined
  const isOpen = isControlled ? openProp : internalOpen

  const handleOpenChange = (nextOpen: boolean) => {
    if (!isControlled) {
      setInternalOpen(nextOpen)
    }
    onOpenChange?.(nextOpen)
  }

  const selectedOption = options.find((opt) => opt.value === value)
  const popperSide = direction === 'up' ? 'top' : direction === 'down' ? 'bottom' : undefined

  const displayedLabel = (
    <span className={`helm-select-label${selectedOption ? '' : ' helm-select-placeholder'}`}>
      {selectedOption ? selectedOption.label : placeholder}
    </span>
  )

  return (
    <div
      className={['helm-select', size ? `helm-select-${size}` : '', className].filter(Boolean).join(' ')}
      style={style}
    >
      <RadixSelect.Root
        value={value}
        onValueChange={(val: string) => {
          if (val !== value) {
            onChange({ target: { value: val as T, name } })
          }
        }}
        disabled={disabled}
        name={name}
        open={isOpen}
        onOpenChange={handleOpenChange}
      >
        <RadixSelect.Trigger
          id={selectId}
          className="helm-select-trigger"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
        >
          {prefixIcon ? <HelmIcon name={prefixIcon} size={12} className="helm-select-prefix" /> : null}
          <RadixSelect.Value placeholder={displayedLabel}>
            {displayedLabel}
          </RadixSelect.Value>
          <RadixSelect.Icon asChild>
            <HelmIcon
              name="chevron-down"
              size={12}
              className={`helm-select-chevron${isOpen ? ' helm-select-chevron-open' : ''}`}
            />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        {isOpen || mounted ? (
          <SelectPortal inline={inline}>
            <RadixSelect.Content
              position="popper"
              side={popperSide}
              sideOffset={4}
              avoidCollisions
              className={`helm-select-popover dropdown-panel${popoverClassName ? ` ${popoverClassName}` : ''}`}
            >
              <RadixSelect.Viewport className="helm-select-viewport">
                {options.map((opt) => {
                  const isSelected = opt.value === value
                  return (
                    <RadixSelect.Item
                      key={opt.value}
                      value={opt.value}
                      disabled={opt.disabled}
                      textValue={typeof opt.label === 'string' ? opt.label : String(opt.value)}
                      className={`helm-select-option${isSelected ? ' selected' : ''}`}
                    >
                      {opt.icon ? <HelmIcon name={opt.icon} size={12} className="helm-select-option-icon" /> : null}
                      <RadixSelect.ItemText asChild>
                        <span className="helm-select-option-label" title={typeof opt.label === 'string' ? opt.label : undefined}>
                          {opt.label}
                        </span>
                      </RadixSelect.ItemText>
                      {opt.meta ? <span className="helm-select-option-meta">{opt.meta}</span> : null}
                      <RadixSelect.ItemIndicator asChild>
                        <HelmIcon name="check" size={12} className="helm-select-check" />
                      </RadixSelect.ItemIndicator>
                    </RadixSelect.Item>
                  )
                })}
              </RadixSelect.Viewport>
            </RadixSelect.Content>
          </SelectPortal>
        ) : null}
      </RadixSelect.Root>
    </div>
  )
}

/**
 * 通用多选下拉选择器实现（基于 Radix UI Popover + Checkbox 原语）
 */
function MultiSelectInner<T extends string = string>({
  value,
  options,
  onChange,
  onValuesChange,
  disabled = false,
  prefixIcon,
  placeholder = '请选择...',
  className = '',
  style,
  size,
  'aria-label': ariaLabel,
  id,
  name,
  direction = 'auto',
  open: openProp,
  onOpenChange,
  inline = false,
  showActions = true,
  searchable = true,
  renderTriggerLabel,
  popoverClassName,
}: MultiSelectProps<T>) {
  const generatedId = useId()
  const selectId = id ?? generatedId
  const [internalOpen, setInternalOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')

  const isControlled = openProp !== undefined
  const isOpen = isControlled ? openProp : internalOpen

  const handleOpenChange = (nextOpen: boolean) => {
    if (!isControlled) {
      setInternalOpen(nextOpen)
    }
    if (!nextOpen) {
      setSearchTerm('')
    }
    onOpenChange?.(nextOpen)
  }

  const selectedValues = useMemo(() => Array.from(value ?? []), [value])
  const selectedSet = useMemo(() => new Set<T>(selectedValues), [selectedValues])

  const popperSide = direction === 'up' ? 'top' : direction === 'down' ? 'bottom' : undefined

  // 触发值变更
  const commitChange = (nextValues: T[]) => {
    onChange?.({ target: { value: nextValues, name } })
    onValuesChange?.(nextValues)
  }

  // 切换单个选项
  const toggleValue = (val: T) => {
    if (disabled) return
    const next = selectedSet.has(val)
      ? selectedValues.filter((v) => v !== val)
      : [...selectedValues, val]
    commitChange(next)
  }

  // 全选
  const handleSelectAll = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const selectable = options.filter((opt) => !opt.disabled).map((opt) => opt.value)
    commitChange(selectable)
  }

  // 清空
  const handleClearAll = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    commitChange([])
  }

  // 选项过滤
  const filteredOptions = useMemo(() => {
    if (!searchTerm.trim()) return options
    const term = searchTerm.toLowerCase().trim()
    return options.filter((opt) => {
      const labelStr = typeof opt.label === 'string' ? opt.label : String(opt.value)
      return (
        labelStr.toLowerCase().includes(term) ||
        String(opt.value).toLowerCase().includes(term) ||
        (typeof opt.description === 'string' && opt.description.toLowerCase().includes(term))
      )
    })
  }, [options, searchTerm])

  // 触发器展示文本
  const triggerLabel = useMemo(() => {
    if (renderTriggerLabel) {
      return renderTriggerLabel(selectedValues, options)
    }
    if (selectedValues.length === 0) {
      return (
        <span className="helm-select-label helm-select-placeholder">{placeholder}</span>
      )
    }
    if (selectedValues.length === 1) {
      const match = options.find((opt) => opt.value === selectedValues[0])
      return <span className="helm-select-label">{match ? match.label : selectedValues[0]}</span>
    }
    const allCount = options.filter((opt) => !opt.disabled).length
    if (selectedValues.length === allCount && allCount > 0) {
      return <span className="helm-select-label">{`已全选 (${selectedValues.length})`}</span>
    }
    return (
      <span className="helm-select-label">{`已选择 ${selectedValues.length} 项`}</span>
    )
  }, [renderTriggerLabel, selectedValues, options, placeholder])

  const contentNode = (
    <div className="helm-select-viewport" style={{ maxHeight: 280, overflowY: 'auto' }}>
      {/* 搜索框 */}
      {searchable && options.length > 4 && (
        <div className="helm-select-search" onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜索选项..."
            aria-label="搜索选项"
          />
        </div>
      )}

      {/* 快捷全选/清空操作条 */}
      {showActions && (
        <div className="helm-select-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="btn btn-ghost btn-xs helm-select-action-btn"
            onClick={handleSelectAll}
            disabled={disabled}
          >
            全选
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs helm-select-action-btn"
            onClick={handleClearAll}
            disabled={disabled || selectedValues.length === 0}
          >
            清空
          </button>
        </div>
      )}

      {/* 选项清单 */}
      {filteredOptions.length === 0 ? (
        <div className="text-xs text-subtle" style={{ padding: '8px 10px', textAlign: 'center' }}>
          未找到匹配选项
        </div>
      ) : (
        filteredOptions.map((opt) => {
          const isSelected = selectedSet.has(opt.value)
          return (
            <div
              key={opt.value}
              role="option"
              aria-selected={isSelected}
              aria-disabled={opt.disabled}
              className={`helm-select-option helm-select-multi-option${isSelected ? ' selected' : ''}${opt.disabled ? ' is-disabled' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                if (!opt.disabled) toggleValue(opt.value)
              }}
            >
              <Checkbox
                checked={isSelected}
                disabled={opt.disabled}
                onChange={() => {
                  if (!opt.disabled) toggleValue(opt.value)
                }}
                aria-label={typeof opt.label === 'string' ? opt.label : String(opt.value)}
              />
              {opt.icon ? <HelmIcon name={opt.icon} size={12} className="helm-select-option-icon" /> : null}
              <span className="helm-select-option-label" title={typeof opt.label === 'string' ? opt.label : undefined}>{opt.label}</span>
              {opt.meta ? <span className="helm-select-option-meta">{opt.meta}</span> : null}
            </div>
          )
        })
      )}
    </div>
  )

  return (
    <div
      className={['helm-select', 'helm-select-multi', size ? `helm-select-${size}` : '', className]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            id={selectId}
            className="helm-select-trigger"
            disabled={disabled}
            aria-label={ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={isOpen}
          >
            {prefixIcon ? <HelmIcon name={prefixIcon} size={12} className="helm-select-prefix" /> : null}
            {triggerLabel}
            <HelmIcon
              name="chevron-down"
              size={12}
              className={`helm-select-chevron${isOpen ? ' helm-select-chevron-open' : ''}`}
            />
          </button>
        </PopoverTrigger>

        {inline ? (
          <div
            className={`helm-select-popover dropdown-panel${popoverClassName ? ` ${popoverClassName}` : ''}`}
            style={{ position: 'relative', marginTop: 4 }}
          >
            {contentNode}
          </div>
        ) : (
          <PopoverContent
            side={popperSide}
            sideOffset={4}
            avoidCollisions
            className={`helm-select-popover dropdown-panel${popoverClassName ? ` ${popoverClassName}` : ''}`}
          >
            {contentNode}
          </PopoverContent>
        )}
      </Popover>
    </div>
  )
}

/**
 * 通用下拉选择器（支持单选与多选，符合 Helm 极简克制气质）：
 * - 默认单选模式：基于 @radix-ui/react-select 封装，提供完整键盘导航与 Typeahead Search；
 * - multiple={true} 多选模式：基于 Popover + Checkbox，提供快捷全选/清空、多选勾选与标签汇总；
 * - 兼容 SSR / 测试环境内联渲染，绝对零 Emoji。
 */
export function Select<T extends string = string>(props: SelectProps<T>) {
  if (props.multiple === true) {
    return <MultiSelectInner {...props} />
  }
  return <SingleSelectInner {...props} />
}

/**
 * 强类型显式多选下拉选择器组件
 */
export function MultiSelect<T extends string = string>(
  props: Omit<MultiSelectProps<T>, 'multiple'>,
) {
  return <Select multiple {...props} />
}
