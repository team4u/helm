import React, { useId } from 'react'
import { HelmIcon } from '../lib/icons.js'

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  indeterminate?: boolean
  label?: React.ReactNode
  id?: string
  name?: string
  title?: string
  className?: string
  style?: React.CSSProperties
  'aria-label'?: string
}

/**
 * 极简复选框组件（符合 Helm 气质的公共原语）：
 * - 紧凑尺寸（15px x 15px），发丝边框与微圆角（3px）；
 * - 支持勾选（check）与半选（indeterminate / minus）精细矢量图标；
 * - 完整的 WAI-ARIA checkbox 规范语义与键盘交互（Space / Enter 切换）；
 * - 统一极简设计，无 Emoji。
 */
export function Checkbox({
  checked,
  onChange,
  disabled = false,
  indeterminate = false,
  label,
  id,
  name,
  title,
  className = '',
  style,
  'aria-label': ariaLabel,
}: CheckboxProps) {
  const generatedId = useId()
  const checkboxId = id ?? generatedId

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    if (!disabled) {
      onChange(!checked)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      onChange(!checked)
    }
  }

  const wrapClass = ['helm-checkbox-wrap', disabled && 'is-disabled', className].filter(Boolean).join(' ')
  const buttonClass = ['helm-checkbox', checked && 'is-checked', indeterminate && 'is-indeterminate'].filter(Boolean).join(' ')

  const checkboxBox = (
    <button
      type="button"
      role="checkbox"
      id={checkboxId}
      name={name}
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      disabled={disabled}
      className={buttonClass}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      title={title}
    >
      {indeterminate ? (
        <HelmIcon name="minus" size={10} className="helm-checkbox-icon" />
      ) : checked ? (
        <HelmIcon name="check" size={10} className="helm-checkbox-icon" />
      ) : null}
    </button>
  )

  if (label === undefined || label === null || label === '') {
    return (
      <span className={wrapClass} style={style} title={title}>
        {checkboxBox}
      </span>
    )
  }

  return (
    <label
      htmlFor={checkboxId}
      className={wrapClass}
      style={style}
      title={title}
    >
      {checkboxBox}
      <span className="helm-checkbox-label">{label}</span>
    </label>
  )
}
