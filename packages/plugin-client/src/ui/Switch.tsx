import React, { useId } from 'react'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: React.ReactNode
  id?: string
  name?: string
  title?: string
  className?: string
  style?: React.CSSProperties
  'aria-label'?: string
}

/**
 * Minimal slide switch component (a common primitive in the restrained Helmx style):
 * - Compact size (28px x 16px), smooth micro-animation movement;
 * - Full WAI-ARIA switch semantics and keyboard accessibility (Space / Enter toggles);
 * - Unified minimal design, no Emoji.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  id,
  name,
  title,
  className = '',
  style,
  'aria-label': ariaLabel,
}: SwitchProps) {
  const generatedId = useId()
  const switchId = id ?? generatedId

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

  const wrapClass = ['helmx-switch-wrap', disabled && 'is-disabled', className].filter(Boolean).join(' ')
  const buttonClass = ['helmx-switch', checked && 'is-checked'].filter(Boolean).join(' ')

  const switchButton = (
    <button
      type="button"
      role="switch"
      id={switchId}
      name={name}
      aria-checked={checked}
      aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      disabled={disabled}
      className={buttonClass}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      title={title}
    >
      <span className="helmx-switch-thumb" />
    </button>
  )

  if (label === undefined || label === null || label === '') {
    return (
      <span className={wrapClass} style={style} title={title}>
        {switchButton}
      </span>
    )
  }

  return (
    <label
      htmlFor={switchId}
      className={wrapClass}
      style={style}
      title={title}
    >
      {switchButton}
      <span className="helmx-switch-label">{label}</span>
    </label>
  )
}
