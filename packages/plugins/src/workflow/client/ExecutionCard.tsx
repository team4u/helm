/**
 * Shared presentational frame for the subagent live card and the background
 * report card (plugin-private, not part of public exports).
 *
 * Only owns the container / header / actions / subline DOM skeleton and the
 * existing .subagent-live-* styles: no hooks, no live state, no business
 * decisions — callers inject content via slots:
 * - activate: the header trigger renders as a real navigation <button>
 *   covering the main info area (subagent live card semantics, mounts
 *   subagent-card-clickable); actions and the body stay sibling structures —
 *   no interactive element nests inside another (keyboard Enter/Space come
 *   from the native button);
 * - toggle: the header trigger renders as a collapse toggle button (report
 *   card semantics, aria-expanded / aria-controls).
 * The two semantics are mutually exclusive: a toggle card never navigates on
 * header clicks, and its body stays selectable without accidental collapsing.
 */
import type { ReactNode } from 'react'

interface ExecutionCardActivate {
  /** Navigation entry aria-label (e.g. "Open subagent #11 drawer"). */
  label: string
  /** Hover tooltip (multi-line details). */
  tooltip: string
  open: () => void
}

interface ExecutionCardToggle {
  /** Collapse toggle aria-label (one sentence each for expanded / collapsed). */
  label: string
  expanded: boolean
  /** Real DOM node id of the expansion area (kept alive when collapsed, aria-controls always points at a real region). */
  controlsId: string
  onToggle: () => void
}

export function ExecutionCard(props: {
  /** Status modifier classes (warn / error / expanded variants). */
  variantClass?: string
  /** Header trigger content (icon + title + badges + stat suffix). */
  heading: ReactNode
  /** Header actions area (sibling of the navigation button, never nested). */
  actions?: ReactNode
  /** Single-line subline (subagent-live-subline; no placeholder rendered when absent). */
  snippet?: ReactNode
  children?: ReactNode
} & (
  | { activate: ExecutionCardActivate; toggle?: never }
  | { toggle: ExecutionCardToggle; activate?: never }
)): ReactNode {
  const { activate, toggle, heading, actions, snippet } = props
  const cardClass = `subagent-live-card${props.variantClass ? ` ${props.variantClass}` : ''}`
  return (
    <div className={cardClass}>
      <div className="subagent-live-header">
        {activate !== undefined ? (
          <button
            type="button"
            className="subagent-live-trigger subagent-card-clickable"
            aria-label={activate.label}
            title={activate.tooltip}
            onClick={activate.open}
          >
            {heading}
          </button>
        ) : toggle !== undefined ? (
          <button
            type="button"
            className="subagent-live-trigger subagent-live-toggleable"
            aria-expanded={toggle.expanded}
            aria-controls={toggle.controlsId}
            aria-label={toggle.label}
            onClick={toggle.onToggle}
          >
            {heading}
          </button>
        ) : (
          <div className="subagent-live-trigger">{heading}</div>
        )}
        {actions !== undefined ? <span className="subagent-live-actions">{actions}</span> : null}
      </div>
      {snippet !== undefined ? snippet : null}
      {props.children}
    </div>
  )
}
