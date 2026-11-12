import * as React from 'react'
import { HelmIcon } from '../lib/icons.js'
import { Tooltip } from './Tooltip.js'

export interface CloseSplitButtonProps {
  onCloseSplit?: () => void
  label?: string
}

/**
 * 分屏窗格公共关闭按钮：
 * - 基于 Radix Tooltip（content="关闭本分屏", side="bottom"）；
 * - 携带 split-close-btn 与 pane-action-label 类，分屏或窄屏下自动响应。
 */
export function CloseSplitButton({
  onCloseSplit,
  label = '关闭分屏',
}: CloseSplitButtonProps): React.JSX.Element {
  return (
    <Tooltip content="关闭本分屏" side="bottom">
      <button
        type="button"
        className="btn btn-sm btn-ghost split-close-btn"
        aria-label={label}
        title="关闭本分屏"
        onClick={onCloseSplit}
      >
        <HelmIcon name="x" size={13} />
        <span className="pane-action-label">{label}</span>
      </button>
    </Tooltip>
  )
}

export interface SplitToggleButtonProps {
  isSplitActive: boolean
  onToggleSplit: () => void
}

/**
 * 分屏开启/关闭切换按钮：
 * - 基于 Radix Tooltip（content=isSplitActive ? '关闭分屏' : '并排分屏', side="bottom"）；
 * - 携带 split-toggle-btn 与 split-active 状态类，窄屏仅保留激活态。
 */
export function SplitToggleButton({
  isSplitActive,
  onToggleSplit,
}: SplitToggleButtonProps): React.JSX.Element {
  return (
    <Tooltip content={isSplitActive ? '关闭分屏' : '并排分屏'} side="bottom">
      <button
        type="button"
        className={`btn btn-sm split-toggle-btn${isSplitActive ? ' btn-primary split-active' : ''}`}
        aria-label={isSplitActive ? '关闭分屏' : '并排分屏'}
        title="在右屏并排打开 / 关闭分屏"
        onClick={onToggleSplit}
      >
        <HelmIcon name="columns" size={12} />
      </button>
    </Tooltip>
  )
}
