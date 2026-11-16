import * as React from 'react'
import { HelmIcon } from '@helm/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { Tooltip } from './Tooltip.js'

export interface CloseSplitButtonProps {
  onCloseSplit?: () => void
  label?: string
}

/**
 * Shared close button for split panes:
 * - Radix Tooltip (content = localized "close this split view", side = bottom);
 * - carries the split-close-btn and pane-action-label classes so split panes
 *   and narrow screens respond automatically.
 */
export function CloseSplitButton({
  onCloseSplit,
  label,
}: CloseSplitButtonProps): React.JSX.Element {
  const { t } = useWebLocale()
  const effectiveLabel = label ?? t('ui.split.closeView')
  return (
    <Tooltip content={t('ui.split.closeThisView')} side="bottom">
      <button
        type="button"
        className="btn btn-sm btn-ghost split-close-btn"
        aria-label={effectiveLabel}
        title={t('ui.split.closeThisView')}
        onClick={onCloseSplit}
      >
        <HelmIcon name="x" size={13} />
        <span className="pane-action-label">{effectiveLabel}</span>
      </button>
    </Tooltip>
  )
}

export interface SplitToggleButtonProps {
  isSplitActive: boolean
  onToggleSplit: () => void
}

/**
 * Split open/close toggle button:
 * - Radix Tooltip (content switches between the localized close/side-by-side
 *   copy, side = bottom);
 * - carries the split-toggle-btn and split-active state classes; narrow
 *   screens keep only the active state.
 */
export function SplitToggleButton({
  isSplitActive,
  onToggleSplit,
}: SplitToggleButtonProps): React.JSX.Element {
  const { t } = useWebLocale()
  const actionLabel = isSplitActive ? t('ui.split.closeView') : t('ui.split.sideBySide')
  return (
    <Tooltip content={actionLabel} side="bottom">
      <button
        type="button"
        className={`btn btn-sm split-toggle-btn${isSplitActive ? ' btn-primary split-active' : ''}`}
        aria-label={actionLabel}
        title={t('ui.split.toggleTitle')}
        onClick={onToggleSplit}
      >
        <HelmIcon name="columns" size={12} />
      </button>
    </Tooltip>
  )
}
