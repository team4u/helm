/**
 * Pure functions for global single-key shortcuts, split-focus routing, desktop
 * sidebar-collapse persistence and command-palette ordering. Zero React / DOM
 * mount side effects; shared by HelmStoreProvider / CommandPaletteModal / Sidebar.
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

/** Pick the first N non-archived conversations by recent activity for an empty search term (excluding the currently viewed one). */
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
