/**
 * Icon component of the builtin:workflow plugin client: delegates to the
 * HelmIcon shared by @helm/plugin-client, avoiding a duplicate
 * lucide-react icon mapping in the host.
 */
import type { ReactNode } from 'react'
import { HelmIcon } from '@helm/plugin-client'

export function Icon({ name, size = 12, className }: { name: string; size?: number; className?: string }): ReactNode {
  return <HelmIcon name={name} size={size} className={className} />
}
