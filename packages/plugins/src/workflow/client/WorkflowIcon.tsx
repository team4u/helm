/**
 * Icon component of the builtin:workflow plugin client: delegates to the
 * HelmxIcon shared by @helmx/plugin-client, avoiding a duplicate
 * lucide-react icon mapping in the host.
 */
import type { ReactNode } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'

export function Icon({ name, size = 12, className }: { name: string; size?: number; className?: string }): ReactNode {
  return <HelmxIcon name={name} size={size} className={className} />
}
