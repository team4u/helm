/**
 * builtin:workflow 插件 client 图标组件（lucide-react 线性矢量，与宿主共享
 * 同一实例；无 Emoji）。全 client 仅此模块感知「图标名 → lucide 组件」映射。
 */
import type { ReactNode } from 'react'
import { Bot, Check, ChevronDown, ChevronRight, Circle, Clock, CornerDownRight, ExternalLink, GitBranch, GitPullRequest, Loader2, RotateCw, Square, Terminal, X } from 'lucide-react'

export function Icon({ name, size = 12, className }: { name: string; size?: number; className?: string }): ReactNode {
  const map: Record<string, typeof Bot> = {
    bot: Bot,
    check: Check,
    'check-circle': Check,
    'chevron-down': ChevronDown,
    'chevron-right': ChevronRight,
    circle: Circle,
    clock: Clock,
    'corner-down-right': CornerDownRight,
    'external-link': ExternalLink,
    'git-branch': GitBranch,
    'git-pull-request': GitPullRequest,
    loader: Loader2,
    'rotate-cw': RotateCw,
    square: Square,
    terminal: Terminal,
    x: X,
  }
  const Cmp = map[name] ?? Circle
  return <Cmp size={size} className={className} />
}
