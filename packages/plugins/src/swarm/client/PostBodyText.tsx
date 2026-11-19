/**
 * Board post body with honest collapse semantics: collapsed shows the existing
 * preview slice and expands to the full stored text (never a fake "expand
 * everything" over truncated data). Component & type exports only (Fast
 * Refresh compliant).
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { resolveLocalizedText, usePluginLocale } from '@helmx/plugin-client'
import { previewPostBody } from './board-model.ts'
import { SW_BODY_COLLAPSE, SW_BODY_EXPAND } from './copy.ts'

export function PostBodyText(props: { body: string; collapsible: boolean }): ReactNode {
  const locale = usePluginLocale()
  const [expanded, setExpanded] = useState(false)
  const showFull = !props.collapsible || expanded
  return (
    <div className="sw-panel-post-body">
      <p className="sw-panel-post-text">{showFull ? props.body : previewPostBody(props.body)}</p>
      {props.collapsible ? (
        <button
          type="button"
          className="btn btn-xs btn-ghost sw-panel-post-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span>{resolveLocalizedText(expanded ? SW_BODY_COLLAPSE : SW_BODY_EXPAND, locale)}</span>
        </button>
      ) : null}
    </div>
  )
}
