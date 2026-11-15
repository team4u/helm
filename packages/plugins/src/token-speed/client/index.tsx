/**
 * builtin:token-speed 插件 client.tsx 组件（只导出组件，保 Fast Refresh 契约）：
 * - TokenSpeedStatusBadge：宿主输入区状态行（COMPOSER_STATUS_SLOT）的只读
 *   速率徽标；订阅本插件 speed 会话文档（专用 SSE，随挂载按需连接）。
 *
 * 诚实性：无可靠速率（工具暂停 / 窗口滑空 / 首字前 / 无终态测量）渲染 null，
 * 绝不以 0.0 tok/s 冒充；tooltip 口径见 label.ts。
 */
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helm/protocol'
import { usePluginSessionDoc } from '@helm/plugin-client'
import type { TokenSpeedStatus } from '../contracts.js'
import { tokenSpeedLabelOf } from './label.ts'
import './index.css'

/** 输入区状态行只读速率徽标（props 形状与 composer.pill/widget 同形）。 */
export function TokenSpeedStatusBadge(_props: ComposerScopeProps): ReactNode {
  const status = usePluginSessionDoc<TokenSpeedStatus | null>('speed')
  if (status === null || status === undefined) return null
  const label = tokenSpeedLabelOf(status)
  if (label === null) return null
  return (
    <span className="token-speed-status mono tabular-nums" title={label.title}>
      {label.text}
    </span>
  )
}
