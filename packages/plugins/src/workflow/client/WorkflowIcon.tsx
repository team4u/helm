/**
 * builtin:workflow 插件 client 图标组件（lucide-react 线性矢量，与宿主共享
 * 同一实例；无 Emoji）。全 client 仅此模块感知「图标名 → lucide 组件」映射。
 */
import type { ReactNode } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownToLine,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Clock,
  CornerDownRight,
  ExternalLink,
  Eye,
  FileText,
  Folder,
  GitBranch,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  Play,
  RotateCw,
  Search,
  Square,
  Terminal,
  Trash2,
  Workflow,
  X,
} from 'lucide-react'

const ICON_MAP: Record<string, typeof Bot> = {
  'alert-circle': AlertCircle,
  'alert-triangle': AlertTriangle,
  'arrow-down-to-line': ArrowDownToLine,
  bot: Bot,
  check: Check,
  'check-circle': Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  circle: Circle,
  clock: Clock,
  'corner-down-right': CornerDownRight,
  'external-link': ExternalLink,
  eye: Eye,
  'file-text': FileText,
  folder: Folder,
  'git-branch': GitBranch,
  'git-pull-request': GitPullRequest,
  loader: Loader2,
  more: MoreHorizontal,
  play: Play,
  'rotate-cw': RotateCw,
  search: Search,
  square: Square,
  terminal: Terminal,
  trash: Trash2,
  'trash-2': Trash2,
  workflow: Workflow,
  x: X,
}

export function Icon({ name, size = 12, className }: { name: string; size?: number; className?: string }): ReactNode {
  const Cmp = ICON_MAP[name] ?? Circle
  return <Cmp size={size} className={className} />
}
