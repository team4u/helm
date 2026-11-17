/**
 * Unified status light shared by the host Web app and plugin client.tsx cards
 * (exported by @helm/plugin-client): a visually dot-only indicator for the
 * card's main status slot — no visible status words (they squeeze mobile
 * layouts and duplicate neighboring text).
 *
 * Accessibility (never color alone): `label` becomes the accessible name via
 * role="img" + aria-label plus a screen-reader-only span (a static image-like
 * indicator, not a chatty live region); hover titles are never the only
 * channel. Tones reuse the host `.status-dot` vocabulary and differ in
 * shape beyond color (pulse / hollow ring / aborted diamond). Spinner
 * semantics stay where they belong: button requests, loading states and live
 * tool streams.
 */
import type { ReactNode } from 'react'
import { normalizeStatusLightTone, statusLightDotClass } from './status-light-model.js'

export interface StatusLightProps {
  /** Raw status word (running/completed/aborted/skipped/offline/...); normalized internally. */
  status: string
  /** Accessible name for screen readers (localized status word); never rendered visibly. */
  label?: ReactNode
  /** Extra classes on the wrapper (layout tweaks only, never tone overrides). */
  className?: string
}

function labelToText(label: ReactNode): string | undefined {
  if (typeof label === 'string') return label === '' ? undefined : label
  if (typeof label === 'number') return String(label)
  return undefined
}

export function StatusLight(props: StatusLightProps): ReactNode {
  const tone = normalizeStatusLightTone(props.status)
  const classes = ['helm-status-light', `helm-status-light-${tone}`]
  if (props.className !== undefined && props.className !== '') classes.push(props.className)
  const hasLabel = props.label !== undefined && props.label !== null && props.label !== ''
  const ariaLabel = labelToText(props.label)
  return (
    <span
      className={classes.join(' ')}
      data-tone={tone}
      role="img"
      {...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {})}
    >
      <span className={statusLightDotClass(tone)} aria-hidden="true" />
      {hasLabel ? <span className="helm-sr-only">{props.label}</span> : null}
    </span>
  )
}
