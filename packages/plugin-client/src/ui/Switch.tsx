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
 * 极简滑动开关组件（符合 Helm 气质的公共原语）：
 * - 紧凑尺寸（28px x 16px），微动效平滑位移；
 * - 完整的 WAI-ARIA switch 规范语义与键盘无障碍交互（Space / Enter 切换）；
 * - 统一极简设计，无 Emoji。
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

  const wrapClass = ['helm-switch-wrap', disabled && 'is-disabled', className].filter(Boolean).join(' ')
  const buttonClass = ['helm-switch', checked && 'is-checked'].filter(Boolean).join(' ')

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
      <span className="helm-switch-thumb" />
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
      <span className="helm-switch-label">{label}</span>
    </label>
  )
}
