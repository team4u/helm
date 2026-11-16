/**
 * builtin:workflow 插件 client 图标组件：委托给 @helm/plugin-client 共享的 HelmIcon，
 * 避免与宿主重复维护 lucide-react 图标映射。
 */
import type { ReactNode } from 'react'
import { HelmIcon } from '@helm/plugin-client'

export function Icon({ name, size = 12, className }: { name: string; size?: number; className?: string }): ReactNode {
  return <HelmIcon name={name} size={size} className={className} />
}
