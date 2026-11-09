import React, { useEffect, useId, useState } from 'react'
import * as RadixSelect from '@radix-ui/react-select'
import { HelmIcon } from '../lib/icons.js'
import type { SelectOption, SelectChangeEvent } from './select-model.js'

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
  open?: boolean
  onOpenChange?: (open: boolean) => void
  inline?: boolean
}

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
 * 通用极简下拉选择器（符合 Helm 极简克制气质的公共组件）：
 * - 基于 @radix-ui/react-select 原语封装，提供标准 WAI-ARIA combobox / listbox 语义；
 * - 紧凑轻量触发器，继承 .select 与 32px 规范高度，支持可选前缀图标与 Lucide 旋转折叠箭头；
 * - 下拉浮层披挂 .dropdown-panel 与 .helm-select-option 样式，选中项显示发丝微边框与勾选指示符；
 * - 完善的键盘导航与首字母跳选（Typeahead Search）支持；
 * - 视口边界自适应与防碰撞翻转（avoidCollisions）；
 * - 兼容 SSR / 测试环境内联渲染。
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
  open: openProp,
  onOpenChange,
  inline = false,
}: SelectProps<T>) {
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
              className="helm-select-popover dropdown-panel"
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
                        <span className="helm-select-option-label">{opt.label}</span>
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
