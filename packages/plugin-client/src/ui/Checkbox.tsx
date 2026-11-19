import React, { useId } from 'react'
import { HelmxIcon } from '../icons.js'

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
 * Minimal checkbox component (a common primitive in the restrained Helmx style):
 * - Compact size (15px x 15px), hairline border and slight rounding (3px);
 * - Precise vector icons for checked (check) and indeterminate (minus) states;
 * - Full WAI-ARIA checkbox semantics and keyboard interaction (Space / Enter toggles);
 * - Unified minimal design, no Emoji.
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

  const wrapClass = ['helmx-checkbox-wrap', disabled && 'is-disabled', className].filter(Boolean).join(' ')
  const buttonClass = ['helmx-checkbox', checked && 'is-checked', indeterminate && 'is-indeterminate'].filter(Boolean).join(' ')

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
        <HelmxIcon name="minus" size={10} className="helmx-checkbox-icon" />
      ) : checked ? (
        <HelmxIcon name="check" size={10} className="helmx-checkbox-icon" />
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
      <span className="helmx-checkbox-label">{label}</span>
    </label>
  )
}
