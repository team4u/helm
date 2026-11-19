/**
 * The single global single-key shortcut dispatch hook:
 * strictly one key per function (Ctrl+L / Ctrl+O / Mod+K / Mod+B / Mod+J / Esc×2), no aliases.
 * Display copy is not produced here, so no locale seam is needed.
 */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { LiveState } from './live-state.js'
import type { ActiveModal, FocusedPanel, ResolvedTarget } from './types.js'
import {
  activeTargetForPanel,
  hasAnyOpenOverlay,
  hasBlockingAlertDialog,
  hasDialogOpen,
  hasNonModelPickerDialogOpen,
  hasNonWorkbenchDialogOpen,
  isConversationAbortable,
  isInlineInputEscapeTarget,
  resolveFocusedPanel,
  type HelmxShortcutDetail,
} from '../shell/shortcuts-model.js'

export interface UseGlobalShortcutsOptions {
  authenticatedRef: MutableRefObject<boolean>
  focusedPanelRef: MutableRefObject<FocusedPanel>
  targets: MutableRefObject<{ primaryTarget: ResolvedTarget; splitTarget: ResolvedTarget | null }>
  activeModalRef: MutableRefObject<ActiveModal>
  workbenchOpenRef: MutableRefObject<boolean>
  liveRef: MutableRefObject<LiveState>
  clearEscAbortPrompt: () => void
  confirmOrArmEscAbort: (conversationId: number) => void
  setActiveModal: Dispatch<SetStateAction<ActiveModal>>
  setWorkbenchOpen: Dispatch<SetStateAction<boolean>>
  toggleSidebarCollapsed: () => void
}

export function useGlobalShortcuts({
  authenticatedRef,
  focusedPanelRef,
  targets,
  activeModalRef,
  workbenchOpenRef,
  liveRef,
  clearEscAbortPrompt,
  confirmOrArmEscAbort,
  setActiveModal,
  setWorkbenchOpen,
  toggleSidebarCollapsed,
}: UseGlobalShortcutsOptions): void {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!authenticatedRef.current) return
      if (event.isComposing || event.keyCode === 229) return

      const keyLower = event.key.toLowerCase()
      const isMod = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
      const isCtrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      const panel = resolveFocusedPanel(focusedPanelRef.current, targets.current.splitTarget)
      const activeTarget = activeTargetForPanel(
        targets.current.primaryTarget,
        targets.current.splitTarget,
        panel,
      )

      if (isMod && keyLower === 'k') {
        if (event.defaultPrevented || hasBlockingAlertDialog()) return
        event.preventDefault()
        clearEscAbortPrompt()
        setActiveModal((current) => (current?.kind === 'command-palette' ? null : { kind: 'command-palette' }))
        return
      }

      if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (
          event.defaultPrevented ||
          hasAnyOpenOverlay(activeModalRef.current, workbenchOpenRef.current) ||
          isInlineInputEscapeTarget(event.target)
        ) {
          clearEscAbortPrompt()
          return
        }
        if (activeTarget.kind !== 'conversation') {
          clearEscAbortPrompt()
          return
        }
        const convId = activeTarget.conversationId
        const conv =
          liveRef.current.conversations.find((c) => c.id === convId) ??
          liveRef.current.conversationDetails[convId]
        if (!isConversationAbortable(conv)) {
          clearEscAbortPrompt()
          return
        }
        event.preventDefault()
        confirmOrArmEscAbort(convId)
        return
      }

      if (event.defaultPrevented) return

      if (isMod && keyLower === 'j') {
        if (activeModalRef.current !== null || hasNonWorkbenchDialogOpen()) return
        if (!workbenchOpenRef.current && activeTarget.kind !== 'conversation') return
        event.preventDefault()
        clearEscAbortPrompt()
        setWorkbenchOpen((open) => !open)
        return
      }

      if (isMod && keyLower === 'b') {
        if (activeModalRef.current !== null || hasNonWorkbenchDialogOpen()) return
        event.preventDefault()
        toggleSidebarCollapsed()
        return
      }

      if (activeModalRef.current !== null || workbenchOpenRef.current) return

      if (isCtrlOnly && keyLower === 'l') {
        if (hasNonModelPickerDialogOpen()) return
        event.preventDefault()
        const detail: HelmxShortcutDetail = { action: 'toggle-model-picker', panel }
        window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
        return
      }

      if (hasDialogOpen()) return

      if (isCtrlOnly && keyLower === 'o') {
        event.preventDefault()
        const detail: HelmxShortcutDetail = { action: 'toggle-process-groups', panel }
        window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [
    activeModalRef,
    authenticatedRef,
    clearEscAbortPrompt,
    confirmOrArmEscAbort,
    focusedPanelRef,
    liveRef,
    setActiveModal,
    setWorkbenchOpen,
    targets,
    toggleSidebarCollapsed,
    workbenchOpenRef,
  ])
}
