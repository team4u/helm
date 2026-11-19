/**
 * Workbench navigation-location state, split focus, space-memory jump-back,
 * home landing and search-entry locating hook. The browser address-bar
 * read/write boundary (hashchange/popstate and pushState/replaceState) stays
 * in HelmxStoreProvider.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ConversationDetail, Profile } from '@helmx/protocol/browser'
import { entryMatchesReference, type LiveState } from './live-state.js'
import { defaultSpaceTarget, resolveSpaceSwitch, type SpaceTargetInput } from './space-navigation.js'
import {
  groupUiContributions,
  resolveTargetString,
  spaceForTarget,
  type ActiveModal,
  type FocusedPanel,
  type ResolvedTarget,
  type SidebarSpace,
  type ToastNotice,
} from './types.js'
import { isSameLocationState, type WorkspaceLocationState } from './url-hash-model.js'
import { resolveFocusedPanel } from '../shell/shortcuts-model.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'

export interface UseLocationNavigationOptions {
  initialLocation: WorkspaceLocationState
  needsHomeLanding: boolean
  authenticated: boolean
  profilesLoaded: boolean
  assetsLoaded: boolean
  sseConnected: boolean
  liveRef: MutableRefObject<LiveState>
  profilesRef: MutableRefObject<Profile[]>
  profilesLoadedRef: MutableRefObject<boolean>
  assetsLoadedRef: MutableRefObject<boolean>
  conversationDetails: Record<number, ConversationDetail>
  loadErrors: Record<string, string>
  loadEarlierEntries: (conversationId: number) => Promise<void>
  delay: (fn: () => void, ms: number) => void
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void
  /**
   * Locale seam: this hook runs inside HelmxStoreProvider's own body (no
   * context access); the Provider does not pass `t` yet, so the English bridge
   * translator keeps today's behavior until the wiring lands.
   */
  t?: WebMessageTranslator
}

export interface UseLocationNavigationResult {
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  focusedPanel: FocusedPanel
  workbenchOpen: boolean
  workbenchTab: string
  activeModal: ActiveModal
  highlightedEntry: { conversationId: number; entryId: string } | null
  locationState: WorkspaceLocationState
  lastSyncedLocation: MutableRefObject<WorkspaceLocationState>
  pendingHistoryMode: MutableRefObject<'push' | 'replace' | null>
  targets: MutableRefObject<{ primaryTarget: ResolvedTarget; splitTarget: ResolvedTarget | null }>
  focusedPanelRef: MutableRefObject<FocusedPanel>
  workbenchOpenRef: MutableRefObject<boolean>
  activeModalRef: MutableRefObject<ActiveModal>
  setSplitTarget: Dispatch<SetStateAction<ResolvedTarget | null>>
  setWorkbenchOpen: Dispatch<SetStateAction<boolean>>
  setWorkbenchTab: Dispatch<SetStateAction<string>>
  setActiveModal: Dispatch<SetStateAction<ActiveModal>>
  applyPrimaryTarget: (target: ResolvedTarget) => void
  openTarget: (
    target: string | ResolvedTarget,
    opts?: { split?: boolean; highlightEntryId?: string; history?: 'push' | 'replace' },
  ) => void
  closeSplit: () => void
  setFocusedPanel: (panel: FocusedPanel) => void
  openSpace: (space: SidebarSpace) => void
  applyExternalLocation: (parsed: WorkspaceLocationState) => void
  resetNavigationOnLogout: () => void
}

export function useLocationNavigation({
  initialLocation,
  needsHomeLanding,
  authenticated,
  profilesLoaded,
  assetsLoaded,
  sseConnected,
  liveRef,
  profilesRef,
  profilesLoadedRef,
  assetsLoadedRef,
  conversationDetails,
  loadErrors,
  loadEarlierEntries,
  delay,
  pushNotice,
  t,
}: UseLocationNavigationOptions): UseLocationNavigationResult {
  const tt = t ?? englishWebTranslator
  const [primaryTarget, setPrimaryTarget] = useState<ResolvedTarget>(initialLocation.primaryTarget)
  const [splitTarget, setSplitTarget] = useState<ResolvedTarget | null>(initialLocation.splitTarget)
  const [focusedPanel, setFocusedPanelState] = useState<FocusedPanel>('primary')
  const [workbenchOpen, setWorkbenchOpen] = useState(initialLocation.workbenchOpen)
  const [workbenchTab, setWorkbenchTab] = useState(initialLocation.workbenchTab)
  const [activeModal, setActiveModal] = useState<ActiveModal>(initialLocation.activeModal)
  const [highlightedEntry, setHighlightedEntry] = useState<{ conversationId: number; entryId: string } | null>(null)

  // The location last agreed with the address bar: both the dedup baseline for
  // external hash changes and the "prev" for push/replace decisions.
  const lastSyncedLocation = useRef<WorkspaceLocationState>(initialLocation)
  // Explicit history-mode marker (openTarget history option / setScreenParams
  // push / openSpace): marks only the next beat; the actual pushState/
  // replaceState is executed by the single address-bar write-back effect —
  // components never touch history directly.
  const pendingHistoryMode = useRef<'push' | 'replace' | null>(null)
  const targets = useRef({ primaryTarget, splitTarget })
  targets.current = { primaryTarget, splitTarget }
  const focusedPanelRef = useRef<FocusedPanel>(focusedPanel)
  focusedPanelRef.current = focusedPanel
  const workbenchOpenRef = useRef(workbenchOpen)
  workbenchOpenRef.current = workbenchOpen
  const activeModalRef = useRef(activeModal)
  activeModalRef.current = activeModal
  // Space memory: each sidebar space's most recent primary target (in-session
  // memory only, never in the URL). Used by Rail switching to jump back; updated
  // uniformly by primary openTarget / external hash restore / delete fallback,
  // seeded initially from the deep-link target.
  const spaceMemory = useRef<Partial<Record<SidebarSpace, ResolvedTarget>>>({
    [spaceForTarget(initialLocation.primaryTarget)]: initialLocation.primaryTarget,
  })
  const homeLandingPending = useRef(needsHomeLanding)

  const setFocusedPanel = useCallback((panel: FocusedPanel) => {
    const next = resolveFocusedPanel(panel, targets.current.splitTarget)
    focusedPanelRef.current = next
    setFocusedPanelState(next)
  }, [])

  const closeSplit = useCallback(() => {
    setSplitTarget(null)
    focusedPanelRef.current = 'primary'
    setFocusedPanelState('primary')
  }, [])

  useEffect(() => {
    if (splitTarget === null && focusedPanelRef.current !== 'primary') {
      focusedPanelRef.current = 'primary'
      setFocusedPanelState('primary')
    }
  }, [splitTarget])

  // Single entry point for primary-target changes: syncs the owning space
  // memory (shared by openTarget and delete fallback).
  const applyPrimaryTarget = useCallback((target: ResolvedTarget) => {
    spaceMemory.current[spaceForTarget(target)] = target
    setPrimaryTarget(target)
  }, [])

  const openTarget = useCallback((
    target: string | ResolvedTarget,
    opts?: { split?: boolean; highlightEntryId?: string; history?: 'push' | 'replace' },
  ) => {
    const resolved = typeof target === 'string' ? resolveTargetString(target, liveRef.current.conversations) : target
    if (!resolved) {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: tt('shell.nav.targetNotReady'),
        body: typeof target === 'string' ? target : tt('shell.nav.invalidTarget'),
      })
      return
    }
    // Explicit history mode marks only the next beat; the actual pushState/
    // replaceState is still executed by the single write-back effect.
    if (opts?.history !== undefined) pendingHistoryMode.current = opts.history
    if (opts?.split) setSplitTarget(resolved)
    else applyPrimaryTarget(resolved)
    if (resolved.kind === 'conversation' && opts?.highlightEntryId) {
      setHighlightedEntry({ conversationId: resolved.conversationId, entryId: opts.highlightEntryId })
    }
  }, [applyPrimaryTarget, liveRef, pushNotice, tt])

  // Activity Rail space switch = navigating the main stage directly: jump back
  // to the space's most recent primary target (or the space default when no
  // memory), pushed through the openTarget single navigation mechanism (the
  // actual pushState is done by the single write-back effect); an unavailable
  // target produces an explicit notice and a safe no-op — never a fabricated
  // target. Already in the space means the main stage IS the latest memory, so
  // plain no-op (no history entry).
  const openSpace = useCallback((space: SidebarSpace) => {
    const input: SpaceTargetInput = {
      conversations: liveRef.current.conversations,
      profiles: profilesRef.current,
      plugins: liveRef.current.plugins,
      assetsLoaded: profilesLoadedRef.current || assetsLoadedRef.current,
      grouped: groupUiContributions(liveRef.current.uiContributions),
    }
    const resolution = resolveSpaceSwitch(space, targets.current.primaryTarget, spaceMemory.current, input)
    if (resolution.kind === 'already-in-space') return
    if (resolution.clearStaleMemory) {
      delete spaceMemory.current[space] // Memory points to a stale target; safely cleared and falling back to the space default
    }
    if (resolution.kind === 'unavailable') {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: tt('shell.nav.noOpenableEntry'),
        body: space === 'views' ? tt('shell.nav.noViewsBody') : tt('shell.nav.noConversationsBody'),
      })
      return
    }
    openTarget(resolution.target, { history: 'push' })
  }, [assetsLoadedRef, profilesLoadedRef, liveRef, openTarget, profilesRef, pushNotice, tt])

  const applyExternalLocation = useCallback((parsed: WorkspaceLocationState) => {
    // External hash events outrank unconsumed component navigation markers, so
    // push/replace markers cannot leak into the next navigation.
    pendingHistoryMode.current = null
    lastSyncedLocation.current = parsed
    setPrimaryTarget(parsed.primaryTarget)
    // External hash restore (forward/back/manual hash edit) also updates the
    // owning space memory.
    spaceMemory.current[spaceForTarget(parsed.primaryTarget)] = parsed.primaryTarget
    setSplitTarget(parsed.splitTarget)
    setWorkbenchOpen(parsed.workbenchOpen)
    setWorkbenchTab(parsed.workbenchTab)
    setActiveModal(parsed.activeModal)
  }, [])

  const resetNavigationOnLogout = useCallback(() => {
    setActiveModal(null)
    setSplitTarget(null)
    focusedPanelRef.current = 'primary'
    setFocusedPanelState('primary')
    setPrimaryTarget({ kind: 'profiles' })
    // All data is cleared: reset space memory to the post-logout default
    // deep-link location as well.
    spaceMemory.current = { settings: { kind: 'profiles' } }
    setWorkbenchOpen(false)
    setWorkbenchTab('artifacts')
  }, [])

  const locationState = useMemo<WorkspaceLocationState>(
    () => ({ primaryTarget, splitTarget, workbenchOpen, workbenchTab, activeModal }),
    [primaryTarget, splitTarget, workbenchOpen, workbenchTab, activeModal],
  )

  // Home landing: entering with an empty hash (no explicit primary target and
  // no modal) is not a navigation intent — once authenticated and the
  // conversation snapshot plus profile assets are ready (without waiting for
  // slow models/skills), the primary lands with replace on the conversations
  // space's default target; if the location moved meanwhile the existing intent
  // wins and the landing is cancelled; with no usable profile at all, keep
  // the parsed default (profile center).
  useEffect(() => {
    if (!homeLandingPending.current) return
    if (!authenticated || !profilesLoaded || !sseConnected) return
    homeLandingPending.current = false
    // Location already moved before data was ready (user click / external
    // forward-back / programmatic navigation): the existing intent wins; cancel the landing.
    if (!isSameLocationState(locationState, initialLocation)) return
    const home = defaultSpaceTarget('conversations', {
      conversations: liveRef.current.conversations,
      profiles: profilesRef.current,
      plugins: liveRef.current.plugins,
      assetsLoaded: profilesLoadedRef.current || assetsLoadedRef.current,
      grouped: groupUiContributions(liveRef.current.uiContributions),
    })
    if (home === null) return // No profiles available: keep the resolution default (profile center); never fabricate a target
    // The landing is a continuation of initial location parsing, not a user
    // navigation: replace creates no history entry, and back does not return to the profile center.
    openTarget(home, { history: 'replace' })
  }, [authenticated, profilesLoaded, sseConnected, locationState, initialLocation, openTarget, liveRef, profilesRef, profilesLoadedRef, assetsLoadedRef])

  // When an old message is hit, page in history until the entry is visible or the cursor is exhausted.
  useEffect(() => {
    if (!highlightedEntry) return
    const detail = conversationDetails[highlightedEntry.conversationId]
    if (!detail) return
    const matched = detail.entries.find((entry) => entryMatchesReference(entry, highlightedEntry.entryId))
    if (matched) {
      if (matched.id !== highlightedEntry.entryId) {
        setHighlightedEntry({ ...highlightedEntry, entryId: matched.id })
        return
      }
      delay(() => setHighlightedEntry((current) => (current === highlightedEntry ? null : current)), 5000)
    } else if (detail.nextCursor && !loadErrors[`history:${detail.id}`]) {
      void loadEarlierEntries(detail.id)
    } else if (!detail.nextCursor) {
      pushNotice({ type: 'notification', level: 'warning', title: tt('shell.nav.searchEntryGone'), conversationId: detail.id })
      setHighlightedEntry(null)
    }
  }, [highlightedEntry, conversationDetails, loadEarlierEntries, loadErrors, delay, pushNotice, tt])

  return {
    primaryTarget,
    splitTarget,
    focusedPanel,
    workbenchOpen,
    workbenchTab,
    activeModal,
    highlightedEntry,
    locationState,
    lastSyncedLocation,
    pendingHistoryMode,
    targets,
    focusedPanelRef,
    workbenchOpenRef,
    activeModalRef,
    setSplitTarget,
    setWorkbenchOpen,
    setWorkbenchTab,
    setActiveModal,
    applyPrimaryTarget,
    openTarget,
    closeSplit,
    setFocusedPanel,
    openSpace,
    applyExternalLocation,
    resetNavigationOnLogout,
  }
}
