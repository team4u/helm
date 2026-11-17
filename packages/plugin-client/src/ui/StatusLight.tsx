/**
 * Unified status light shared by the host Web app and plugin client.tsx cards
 * (exported by @helm/plugin-client): a single dot + one visible label as the
 * card's main status slot, replacing spinner-plus-duplicated-text pairs.
 *
 * Reuses the host design-system `.status-dot` classes (same visual vocabulary
 * as the sidebar conversation rows); the tone shapes differ beyond color
 * (pulse / hollow ring / aborted diamond) and the label is always rendered as
 * text, so status is never conveyed by color alone. Spinner semantics stay
 * where they belong: button requests, loading states and live tool streams.
 */
import type { ReactNode } from 'react'
import { normalizeStatusLightTone, statusLightDotClass } from './status-light-model.js'

export interface StatusLightProps {
  /** Raw status word (running/completed/aborted/skipped/offline/...); normalized internally. */
  status: string
  /** Visible label next to the dot (the non-color signal; pass the localized status word). */
  label?: ReactNode
  /** Extra classes on the wrapper (layout tweaks only, never tone overrides). */
  className?: string
}

export function StatusLight(props: StatusLightProps): ReactNode {
  const tone = normalizeStatusLightTone(props.status)
  const classes = ['helm-status-light', `helm-status-light-${tone}`]
  if (props.className !== undefined && props.className !== '') classes.push(props.className)
  const hasLabel = props.label !== undefined && props.label !== null && props.label !== ''
  return (
    <span className={classes.join(' ')} data-tone={tone}>
      <span className={statusLightDotClass(tone)} aria-hidden="true" />
      {hasLabel ? <span className="helm-status-light-label">{props.label}</span> : null}
    </span>
  )
}
