import React, { useEffect, useId, useMemo, useState } from 'react'
import * as RadixSelect from '@radix-ui/react-select'
import { HelmxIcon } from '../icons.js'
import { usePluginTranslator } from '../i18n.js'
import { uiCopy } from '../ui-copy.js'
import { Checkbox } from './Checkbox.js'
import { Popover, PopoverContent, PopoverTrigger } from './Popover.js'
import { useOverlayChildStyle } from './overlay-stack.js'
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
  /** Extra class name for the dropdown overlay (e.g. helmx-select-popover-wide widens long model-ID panels). */
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
 * SSR-tolerant Portal: on server rendering (typeof window === 'undefined') or in
 * explicit inline mode, children are rendered inline directly — this avoids
 * createPortal depending on document.body, which would degrade test rendering
 * or return empty content.
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
 * Generic single-select dropdown implementation (keeps the original Radix UI Select contract).
 * The default placeholder follows the shared UI locale; an explicit prop wins.
 */
function SingleSelectInner<T extends string = string>({
  value,
  options,
  onChange,
  disabled = false,
  prefixIcon,
  placeholder,
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
  const t = usePluginTranslator()
  const resolvedPlaceholder = placeholder ?? t(uiCopy.select)
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
  const layeredPopoverStyle = useOverlayChildStyle()

  const displayedLabel = (
    <span className={`helmx-select-label${selectedOption ? '' : ' helmx-select-placeholder'}`}>
      {selectedOption ? selectedOption.label : resolvedPlaceholder}
    </span>
  )

  return (
    <div
      className={['helmx-select', size ? `helmx-select-${size}` : '', className].filter(Boolean).join(' ')}
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
          className="helmx-select-trigger"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
        >
          {prefixIcon ? <HelmxIcon name={prefixIcon} size={12} className="helmx-select-prefix" /> : null}
          <RadixSelect.Value placeholder={displayedLabel}>
            {displayedLabel}
          </RadixSelect.Value>
          <RadixSelect.Icon asChild>
            <HelmxIcon
              name="chevron-down"
              size={12}
              className={`helmx-select-chevron${isOpen ? ' helmx-select-chevron-open' : ''}`}
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
              className={`helmx-select-popover dropdown-panel${popoverClassName ? ` ${popoverClassName}` : ''}`}
              style={layeredPopoverStyle}
            >
              <RadixSelect.Viewport className="helmx-select-viewport">
                {options.map((opt) => {
                  const isSelected = opt.value === value
                  return (
                    <RadixSelect.Item
                      key={opt.value}
                      value={opt.value}
                      disabled={opt.disabled}
                      textValue={typeof opt.label === 'string' ? opt.label : String(opt.value)}
                      className={`helmx-select-option${isSelected ? ' selected' : ''}`}
                    >
                      {opt.icon ? <HelmxIcon name={opt.icon} size={12} className="helmx-select-option-icon" /> : null}
                      <RadixSelect.ItemText asChild>
                        <span className="helmx-select-option-label" title={typeof opt.label === 'string' ? opt.label : undefined}>
                          {opt.label}
                        </span>
                      </RadixSelect.ItemText>
                      {opt.meta ? <span className="helmx-select-option-meta">{opt.meta}</span> : null}
                      <RadixSelect.ItemIndicator asChild>
                        <HelmxIcon name="check" size={12} className="helmx-select-check" />
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
 * Generic multi-select dropdown implementation (built on the Radix UI Popover + Checkbox primitives).
 * Defaults for placeholders, actions and summaries follow the shared UI locale.
 */
function MultiSelectInner<T extends string = string>({
  value,
  options,
  onChange,
  onValuesChange,
  disabled = false,
  prefixIcon,
  placeholder,
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
  const t = usePluginTranslator()
  const resolvedPlaceholder = placeholder ?? t(uiCopy.select)
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
  const layeredPopoverStyle = useOverlayChildStyle()

  // Commit a value change
  const commitChange = (nextValues: T[]) => {
    onChange?.({ target: { value: nextValues, name } })
    onValuesChange?.(nextValues)
  }

  // Toggle a single option
  const toggleValue = (val: T) => {
    if (disabled) return
    const next = selectedSet.has(val)
      ? selectedValues.filter((v) => v !== val)
      : [...selectedValues, val]
    commitChange(next)
  }

  // Select all
  const handleSelectAll = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const selectable = options.filter((opt) => !opt.disabled).map((opt) => opt.value)
    commitChange(selectable)
  }

  // Clear all
  const handleClearAll = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    commitChange([])
  }

  // Option filtering
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

  // Trigger display text
  const triggerLabel = useMemo(() => {
    if (renderTriggerLabel) {
      return renderTriggerLabel(selectedValues, options)
    }
    if (selectedValues.length === 0) {
      return (
        <span className="helmx-select-label helmx-select-placeholder">{resolvedPlaceholder}</span>
      )
    }
    if (selectedValues.length === 1) {
      const match = options.find((opt) => opt.value === selectedValues[0])
      return <span className="helmx-select-label">{match ? match.label : selectedValues[0]}</span>
    }
    const allCount = options.filter((opt) => !opt.disabled).length
    if (selectedValues.length === allCount && allCount > 0) {
      return <span className="helmx-select-label">{t({ en: `All selected (${selectedValues.length})`, 'zh-CN': `已全选 (${selectedValues.length})` })}</span>
    }
    return (
      <span className="helmx-select-label">{t({ en: `${selectedValues.length} selected`, 'zh-CN': `已选择 ${selectedValues.length} 项` })}</span>
    )
  }, [renderTriggerLabel, selectedValues, options, resolvedPlaceholder, t])

  const contentNode = (
    <div className="helmx-select-viewport" style={{ maxHeight: 280, overflowY: 'auto' }}>
      {/* Search box */}
      {searchable && options.length > 4 && (
        <div className="helmx-select-search" onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t(uiCopy.searchPlaceholder)}
            aria-label={t(uiCopy.searchOptions)}
          />
        </div>
      )}

      {/* Quick select-all / clear action bar */}
      {showActions && (
        <div className="helmx-select-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="btn btn-ghost btn-xs helmx-select-action-btn"
            onClick={handleSelectAll}
            disabled={disabled}
          >
            {t(uiCopy.selectAll)}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs helmx-select-action-btn"
            onClick={handleClearAll}
            disabled={disabled || selectedValues.length === 0}
          >
            {t(uiCopy.clear)}
          </button>
        </div>
      )}

      {/* Option list */}
      {filteredOptions.length === 0 ? (
        <div className="text-xs text-subtle" style={{ padding: '8px 10px', textAlign: 'center' }}>
          No matching options
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
              className={`helmx-select-option helmx-select-multi-option${isSelected ? ' selected' : ''}${opt.disabled ? ' is-disabled' : ''}`}
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
              {opt.icon ? <HelmxIcon name={opt.icon} size={12} className="helmx-select-option-icon" /> : null}
              <span className="helmx-select-option-label" title={typeof opt.label === 'string' ? opt.label : undefined}>{opt.label}</span>
              {opt.meta ? <span className="helmx-select-option-meta">{opt.meta}</span> : null}
            </div>
          )
        })
      )}
    </div>
  )

  return (
    <div
      className={['helmx-select', 'helmx-select-multi', size ? `helmx-select-${size}` : '', className]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            id={selectId}
            className="helmx-select-trigger"
            disabled={disabled}
            aria-label={ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={isOpen}
          >
            {prefixIcon ? <HelmxIcon name={prefixIcon} size={12} className="helmx-select-prefix" /> : null}
            {triggerLabel}
            <HelmxIcon
              name="chevron-down"
              size={12}
              className={`helmx-select-chevron${isOpen ? ' helmx-select-chevron-open' : ''}`}
            />
          </button>
        </PopoverTrigger>

        {inline ? (
          <div
            className={`helmx-select-popover dropdown-panel${popoverClassName ? ` ${popoverClassName}` : ''}`}
            style={{ position: 'relative', marginTop: 4, ...layeredPopoverStyle }}
          >
            {contentNode}
          </div>
        ) : (
          <PopoverContent
            side={popperSide}
            sideOffset={4}
            avoidCollisions
            className={`helmx-select-popover dropdown-panel${popoverClassName ? ` ${popoverClassName}` : ''}`}
          >
            {contentNode}
          </PopoverContent>
        )}
      </Popover>
    </div>
  )
}

/**
 * Generic dropdown selector (single and multiple selection, in the restrained
 * Helmx style):
 * - Default single mode: wraps @radix-ui/react-select with full keyboard
 *   navigation and Typeahead Search;
 * - multiple={true} mode: built on Popover + Checkbox with quick select-all /
 *   clear, multi-check selection and a summary trigger label;
 * - SSR / test-environment inline rendering supported, absolutely zero Emoji.
 */
export function Select<T extends string = string>(props: SelectProps<T>) {
  if (props.multiple === true) {
    return <MultiSelectInner<T> {...props} />
  }
  return <SingleSelectInner {...props} />
}

/**
 * Strongly typed explicit multi-select dropdown component.
 */
export function MultiSelect<T extends string = string>(
  props: Omit<MultiSelectProps<T>, 'multiple'>,
) {
  return <Select<T> multiple {...props} />
}
