/**
 * Shared plugin info-callout primitive (reuses the host's generic .callout
 * style, unrelated to any plugin DSL styling).
 * Exported by @helm/plugin-client; tone defaults to info.
 */
import type { ReactNode } from 'react'
import { HelmIcon } from './icons.js'

export interface CalloutProps {
  tone?: 'info' | 'warn' | 'err' | 'ok'
  title?: string
  children: ReactNode
}

const TONE_CLASS: Record<NonNullable<CalloutProps['tone']>, string> = {
  info: 'callout',
  warn: 'callout callout--warning',
  err: 'callout callout--error',
  ok: 'callout callout--success',
}

const TONE_ICON: Record<NonNullable<CalloutProps['tone']>, string> = {
  info: 'alert-circle',
  warn: 'alert-triangle',
  err: 'alert-circle',
  ok: 'check-circle',
}

export function Callout({ tone = 'info', title, children }: CalloutProps): ReactNode {
  return (
    <div className={TONE_CLASS[tone]}>
      <HelmIcon name={TONE_ICON[tone]} size={13} />
      <div>
        {title !== undefined && title !== '' && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  )
}
