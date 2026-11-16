/**
 * builtin:token-speed plugin client.tsx components (component exports only,
 * Fast Refresh contract):
 * - TokenSpeedStatusBadge: read-only rate badge on the host composer status
 *   row (COMPOSER_STATUS_SLOT); subscribes to this plugin's `speed` session
 *   doc (dedicated SSE, connected on demand while mounted).
 *
 * Honesty: tool pauses and streaming gaps keep the last valid rate of the
 * turn (tool execution is not counted as decode time); renders null before
 * the first measurement or when the settled turn has no reliable measurement
 * — never fakes a rate with 0.0 tok/s. Tooltip disclosures live in label.ts.
 *
 * Display copy follows the host locale via usePluginLocale (no independent
 * language state, no localStorage).
 */
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helm/protocol'
import { usePluginLocale, usePluginSessionDoc } from '@helm/plugin-client'
import type { TokenSpeedStatus } from '../contracts.js'
import { tokenSpeedLabelOf } from './label.ts'
import './index.css'

/** Read-only rate badge for the composer status row (props shape mirrors composer.pill/widget). */
export function TokenSpeedStatusBadge(_props: ComposerScopeProps): ReactNode {
  const status = usePluginSessionDoc<TokenSpeedStatus | null>('speed')
  const locale = usePluginLocale()
  if (status === null || status === undefined) return null
  const label = tokenSpeedLabelOf(status, locale)
  if (label === null) return null
  return (
    <span className="token-speed-status mono tabular-nums" title={label.title}>
      {label.text}
    </span>
  )
}
