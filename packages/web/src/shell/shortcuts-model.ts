/**
 * 全局单键快捷键、分屏焦点路由、桌面侧栏折叠持久化与命令面板排序纯函数。
 * 零 React / DOM 挂载副作用，供 HelmStoreProvider / CommandPaletteModal / Sidebar 共用。
 */
import type { ConversationSummary } from '@helm/protocol/browser'
import { isConversationArchived } from '../conversation/archive-model.js'
import type { ActiveModal, FocusedPanel, ResolvedTarget } from '../lib/types.js'

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'helm:sidebar-collapsed'
export const ESC_ABORT_WINDOW_MS = 1500

export type HelmShortcutAction = 'toggle-model-picker' | 'toggle-process-groups'

export interface HelmShortcutDetail {
  action: HelmShortcutAction
  panel: FocusedPanel
}

const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.helm-popover-content',
  '.helm-dropdown-content',
  '.helm-select-popover',
  '.pane-more-popover',
  '.conversation-outline-popover',
  '.composer-popover',
  'details.composer-extras[open]',
].join(', ')

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]'
const NON_WORKBENCH_DIALOG_SELECTOR = '[role="alertdialog"], [role="dialog"]:not(.helm-workbench)'
const NON_MODEL_PICKER_DIALOG_SELECTOR = '[role="alertdialog"], [role="dialog"]:not(.composer-model-popover)'

export function getStoredSidebarCollapsed(): boolean {
  try {
    const saved = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
    return saved === '1' || saved === 'true'
  } catch {
    return false
  }
}

export function persistSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0')
  } catch {
    /* 禁用存储时保留内存折叠状态 */
  }
}

export function resolveFocusedPanel(
  focusedPanel: FocusedPanel,
  splitTarget: ResolvedTarget | null,
): FocusedPanel {
  return splitTarget !== null && focusedPanel === 'split' ? 'split' : 'primary'
}

export function activeTargetForPanel(
  primaryTarget: ResolvedTarget,
  splitTarget: ResolvedTarget | null,
  focusedPanel: FocusedPanel,
): ResolvedTarget {
  return resolveFocusedPanel(focusedPanel, splitTarget) === 'split' && splitTarget !== null
    ? splitTarget
    : primaryTarget
}

export function isConversationAbortable(
  conversation: Pick<ConversationSummary, 'status' | 'contextUsage'> | undefined,
): boolean {
  if (conversation === undefined) return false
  return (
    conversation.status === 'working' ||
    conversation.status === 'blocked' ||
    conversation.contextUsage?.compacting === true
  )
}

export function hasBlockingAlertDialog(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector('[role="alertdialog"]') !== null
}

export function hasDialogOpen(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(DIALOG_SELECTOR) !== null
}

export function hasNonWorkbenchDialogOpen(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(NON_WORKBENCH_DIALOG_SELECTOR) !== null
}

/** 检测除 ModelPicker 浮层以外的阻塞对话框（确保 Ctrl+L 再次按下时可切换关闭已打开的选型框）。 */
export function hasNonModelPickerDialogOpen(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(NON_MODEL_PICKER_DIALOG_SELECTOR) !== null
}

export function hasAnyOpenOverlay(activeModal: ActiveModal, workbenchOpen: boolean): boolean {
  if (activeModal !== null || workbenchOpen) return true
  if (typeof document === 'undefined') return false
  return document.querySelector(OVERLAY_SELECTOR) !== null
}

export function isInlineInputEscapeTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  return target.closest('.pane-topbar input') !== null
}

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform ?? nav.platform ?? ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** 唯一 Mod 快捷键显示文案（严格单键，无多键别名）。 */
export function formatModShortcut(key: string): string {
  const upper = key.toUpperCase()
  return isApplePlatform() ? `⌘${upper}` : `Ctrl+${upper}`
}

/** 空搜索词时按最近活跃时间挑选前 N 条非归档会话（排除当前正查看会话）。 */
export function selectRecentConversationsForPalette(
  conversations: ReadonlyArray<ConversationSummary>,
  activeConversationId: number | undefined,
  limit = 5,
): ConversationSummary[] {
  return conversations
    .filter((c) => !isConversationArchived(c) && c.id !== activeConversationId)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
    .slice(0, limit)
}
