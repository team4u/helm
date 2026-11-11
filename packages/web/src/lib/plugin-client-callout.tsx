/**
 * 插件共享的信息提示原语（复用宿主通用 .callout 样式，与任何插件 DSL 样式无关）。
 * 供 @helm/plugin-client 导出；tone 缺省 info。
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
