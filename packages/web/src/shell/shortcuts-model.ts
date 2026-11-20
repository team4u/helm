/**
 * Pure functions for global single-key shortcuts, split-focus routing, desktop
 * sidebar-collapse persistence and command-palette ordering. Zero React / DOM
 * mount side effects; shared by HelmxStoreProvider / CommandPaletteModal / Sidebar.
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import { isConversationArchived } from '../conversation/archive-model.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'
import type { ActiveModal, FocusedPanel, ResolvedTarget } from '../lib/types.js'

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'helmx:sidebar-collapsed'
export const ESC_ABORT_WINDOW_MS = 1500

export type HelmxShortcutAction = 'toggle-model-picker' | 'toggle-process-groups'

export interface HelmxShortcutDetail {
  action: HelmxShortcutAction
  panel: FocusedPanel
}

const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.helmx-popover-content',
  '.helmx-dropdown-content',
  '.helmx-select-popover',
  '.pane-more-popover',
  '.conversation-outline-popover',
  '.composer-popover',
  'details.composer-extras[open]',
].join(', ')

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]'
// 会话抽屉是完整的会话视图（非阻断性弹窗）：对工作台快捷键视为会话上下文，
// 不计入「其他对话框打开」的阻断判定。
const NON_WORKBENCH_DIALOG_SELECTOR =
  '[role="alertdialog"], [role="dialog"]:not(.helmx-workbench):not(.conversation-drawer)'
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
    /* Keep the in-memory collapse state when storage is disabled */
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

/** Detect blocking dialogs other than the ModelPicker popover (so a second Ctrl+L can toggle the open picker closed). */
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

/** The single Mod-shortcut display label (strictly one key; no multi-key aliases). */
export function formatModShortcut(key: string): string {
  const upper = key.toUpperCase()
  return isApplePlatform() ? `⌘${upper}` : `Ctrl+${upper}`
}

/**
 * Pick the first N non-archived conversations for an empty search term
 * (excluding the currently viewed one).
 *
 * Attention-first ordering (shares the global attention verdict, zero
 * re-implementation): conversations that need attention (error / blocked)
 * outrank running ones (working or background in flight, when the background
 * index is provided), which outrank unread completions (done && unread); the
 * rest keep the updatedAt-descending recency order. Existing callers without
 * a background index keep working — background in-flight simply cannot be
 * detected there and falls through to the base five-state verdicts.
 */
export function selectRecentConversationsForPalette(
  conversations: ReadonlyArray<ConversationSummary>,
  activeConversationId: number | undefined,
  limit = 5,
  background?: ConversationBackgroundIndex,
): ConversationSummary[] {
  const attentionTier = (conversation: ConversationSummary): number => {
    if (conversation.status === 'error' || conversation.status === 'blocked') return 0
    if (conversation.status === 'working' || background?.get(conversation.id)?.active === true) return 1
    if (conversation.status === 'done' && conversation.unread === true) return 2
    return 3
  }
  return conversations
    .filter((c) => !isConversationArchived(c) && c.id !== activeConversationId)
    .slice()
    .sort((a, b) => attentionTier(a) - attentionTier(b) || b.updatedAt - a.updatedAt || b.id - a.id)
    .slice(0, limit)
}
