import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as LucideReact from 'lucide-react'
import * as HelmPluginClient from '@helm/plugin-client'
import { usePluginDocValue } from '@helm/plugin-client'
import { HelmExternalStore, type StoreBootLocation } from './helm-store.js'
import { PluginClientHostBridge } from './plugin-host-bridge.js'
import {
  HelmExternalStoreContext,
  useActiveModal,
  useAuthenticated,
  useConversationDetail,
  useHelmStore,
  useHighlightedEntry,
  useLoadError,
  useLocationState,
  useLocationTargets,
  useProfilesSlice,
  useSseConnected,
  useThemePreferencesState,
} from './store-context.js'
import { applyDocumentLocale } from './theme-preferences.js'
import { formatLocationHash, hashHasPrimaryTarget, isSameLocationState, parseLocationHash, shouldPushLocationHistory } from './url-hash-model.js'
import { useGlobalShortcuts } from './use-global-shortcuts.js'
import { useSseEvents } from './use-sse-events.js'
import { useUnreadSync } from './use-unread-sync.js'

function HomeLandingWatcher({ store, boot }: { store: HelmExternalStore; boot: StoreBootLocation }) {
  const pendingRef = useRef(boot.needsHomeLanding)
  const authenticated = useAuthenticated()
  const { profilesLoaded } = useProfilesSlice()
  const sseConnected = useSseConnected()

  useEffect(() => {
    if (!pendingRef.current) return
    if (!authenticated || !profilesLoaded || !sseConnected) return
    pendingRef.current = false
    store.performHomeLanding(boot.location)
  }, [authenticated, profilesLoaded, sseConnected, store, boot])

  return null
}

function HighlightedEntryActiveWatcher({
  store,
  conversationId,
  highlightedEntry,
}: {
  store: HelmExternalStore
  conversationId: number
  highlightedEntry: { conversationId: number; entryId: string }
}) {
  const detail = useConversationDetail(conversationId)
  const historyError = useLoadError(`history:${conversationId}`)

  useEffect(() => {
    store.stepHighlightedEntry()
  }, [store, highlightedEntry, detail, historyError])

  return null
}

function HighlightedEntryWatcher({ store }: { store: HelmExternalStore }) {
  const highlightedEntry = useHighlightedEntry()
  if (highlightedEntry === null) return null
  return (
    <HighlightedEntryActiveWatcher
      store={store}
      conversationId={highlightedEntry.conversationId}
      highlightedEntry={highlightedEntry}
    />
  )
}

function HelmStoreEffects({ store, boot }: { store: HelmExternalStore; boot: StoreBootLocation }) {
  const authenticated = useAuthenticated()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const activeModal = useActiveModal()
  const locationState = useLocationState()
  const { locale, localePreference, themePreference } = useThemePreferencesState()

  const { lastSyncedLocation, pendingHistoryMode } = store

  useEffect(() => {
    applyDocumentLocale(locale)
  }, [locale])

  useEffect(() => {
    if (typeof window === 'undefined' || localePreference !== 'auto') return
    const handler = () => store.handleBrowserLanguageChange()
    window.addEventListener('languagechange', handler)
    return () => window.removeEventListener('languagechange', handler)
  }, [localePreference, store])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => store.handleSystemThemeChange(e.matches)
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [themePreference, store])

  useEffect(() => {
    if (authenticated) void store.refreshAssets()
  }, [authenticated, store])

  useEffect(() => {
    const nextVisible = new Set<number>()
    if (primaryTarget.kind === 'conversation') nextVisible.add(primaryTarget.conversationId)
    if (splitTarget?.kind === 'conversation') nextVisible.add(splitTarget.conversationId)
    if (activeModal?.kind === 'conversation-drawer' || activeModal?.kind === 'artifact-preview' || activeModal?.kind === 'workspace-file') {
      if (activeModal.conversationId !== undefined) nextVisible.add(activeModal.conversationId)
    }
    store.requests.syncVisibleConversations(nextVisible)
  }, [primaryTarget, splitTarget, activeModal, store])

  const {
    unreadClearInFlight,
    unreadClearedSeq,
    visibleConversationIds,
    clearVisibleConversationUnread,
    resetUnreadSync,
  } = useUnreadSync({
    authenticated,
    authenticatedRef: store.authenticatedRef,
    primaryTarget,
    splitTarget,
    targets: store.targets,
    liveRef: store.liveRef,
    conversationArtifactsRef: store.conversationArtifactsRef,
    artifactsWatermarksRef: store.requests.artifactsWatermarks,
    session: store.requests.session,
    loadConversationDetail: store.loadConversationDetail,
    loadConversationArtifacts: store.loadConversationArtifacts,
    pushNotice: store.pushNotice,
  })

  useEffect(() => {
    void store.checkAuth()
    return () => store.dispose()
  }, [store])

  const logout = useCallback(() => {
    store.prepareLogoutHistoryReset()
    resetUnreadSync()
    // Resets the address bar to the default deep link (replaceState keeps the
    // history stack clean); writes stay disabled while unauthenticated to avoid
    // clobbering a user-pasted deep link.
    window.history.replaceState(null, '', '#/settings/profiles')
    store.finishLogoutStateReset()
  }, [resetUnreadSync, store])
  store.bindLogout(logout)

  useEffect(() => {
    window.addEventListener('helm:unauthorized', logout)
    return () => window.removeEventListener('helm:unauthorized', logout)
  }, [logout])

  // ---- Screen route param updates (implemented inside the single navigation
  // mechanism; components must never touch browser history directly) ----
  const setScreenParams = useCallback(
    (patch: Record<string, string | undefined>, options?: { split?: boolean; push?: boolean }) => {
      store.setScreenParams(patch, options)
    },
    [store],
  )
  const invokePluginAction = store.invokePluginAction
  void setScreenParams
  void invokePluginAction

  useEffect(() => {
    const applyUrlLocation = () => {
      const parsed = parseLocationHash(window.location.hash)
      if (isSameLocationState(parsed, lastSyncedLocation.current)) return
      store.applyExternalLocation(parsed)
    }
    window.addEventListener('hashchange', applyUrlLocation)
    window.addEventListener('popstate', applyUrlLocation)
    return () => {
      window.removeEventListener('hashchange', applyUrlLocation)
      window.removeEventListener('popstate', applyUrlLocation)
    }
  }, [lastSyncedLocation, store])

  useEffect(() => {
    if (!authenticated) return
    const nextHash = formatLocationHash(locationState)
    if (nextHash === window.location.hash) {
      lastSyncedLocation.current = locationState
      pendingHistoryMode.current = null
      return
    }
    const override = pendingHistoryMode.current
    if (override === 'push' || (override === null && shouldPushLocationHistory(lastSyncedLocation.current, locationState))) {
      window.history.pushState(null, '', nextHash)
    } else {
      window.history.replaceState(null, '', nextHash)
    }
    pendingHistoryMode.current = null
    lastSyncedLocation.current = locationState
  }, [authenticated, lastSyncedLocation, locationState, pendingHistoryMode])

  useGlobalShortcuts({
    authenticatedRef: store.authenticatedRef,
    focusedPanelRef: store.focusedPanelRef,
    targets: store.targets,
    activeModalRef: store.activeModalRef,
    workbenchOpenRef: store.workbenchOpenRef,
    liveRef: store.liveRef,
    clearEscAbortPrompt: store.clearEscAbortPrompt,
    confirmOrArmEscAbort: store.confirmOrArmEscAbort,
    setActiveModal: store.setActiveModal,
    setWorkbenchOpen: store.setWorkbenchOpen,
    toggleSidebarCollapsed: store.toggleSidebarCollapsed,
  })

  useSseEvents({
    authenticated,
    session: store.requests.session,
    sseCursorRef: store.sseCursorRef,
    liveRef: store.liveRef,
    requests: store.requests.requests,
    failedDocs: store.requests.failedDocs,
    unreadClearInFlight,
    unreadClearedSeq,
    pluginEpoch: store.requests.pluginEpoch,
    targets: store.targets,
    activeModalRef: store.activeModalRef,
    pendingHistoryMode,
    logout,
    setSseConnected: store.setSseConnected,
    setConnectionError: store.setConnectionError,
    setLoadErrors: store.setLoadErrors,
    updateLive: store.updateLive,
    setKernelBootId: store.setKernelBootId,
    setConversationArtifacts: store.setConversationArtifacts,
    conversationArtifactsRef: store.conversationArtifactsRef,
    artifactsWatermarksRef: store.requests.artifactsWatermarks,
    visibleConversationIds,
    loadConversationDetail: store.loadConversationDetail,
    loadConversationArtifacts: store.loadConversationArtifacts,
    abortInFlightConversationRequests: store.requests.abortInFlightConversationRequests,
    clearVisibleConversationUnread,
    pushNotice: store.pushNotice,
    refreshAssets: store.refreshAssets,
    applyPrimaryTarget: store.applyPrimaryTarget,
    setSplitTarget: store.setSplitTarget,
    setActiveModal: store.setActiveModal,
  })

  return (
    <>
      {boot.needsHomeLanding ? <HomeLandingWatcher store={store} boot={boot} /> : null}
      <HighlightedEntryWatcher store={store} />
    </>
  )
}

export function HelmStoreProvider({ children }: { children: React.ReactNode }) {
  const [boot] = useState<StoreBootLocation>(() => {
    const rawHash = typeof window !== 'undefined' ? window.location.hash : ''
    const parsed = parseLocationHash(rawHash)
    return {
      location: parsed,
      needsHomeLanding: !hashHasPrimaryTarget(rawHash) && parsed.activeModal === null,
    }
  })

  const storeRef = useRef<HelmExternalStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = new HelmExternalStore(boot.location)
  }
  const store = storeRef.current

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__HELM_SHARED__ = { React, useHelmStore, usePluginDoc: usePluginDocValue }
    w.__helm_shared_react = React
    w.__helm_shared_react_dom = ReactDom
    w.__helm_shared_react_dom_client = ReactDomClient
    w.__helm_shared_react_jsx_runtime = ReactJsxRuntime
    w.__helm_shared_lucide_react = LucideReact
    w.__helm_shared_plugin_client = HelmPluginClient
    return () => {
      delete w.__HELM_SHARED__
      delete w.__helm_shared_react
      delete w.__helm_shared_react_dom
      delete w.__helm_shared_react_dom_client
      delete w.__helm_shared_react_jsx_runtime
      delete w.__helm_shared_lucide_react
      delete w.__helm_shared_plugin_client
    }
  }, [])

  return (
    <HelmExternalStoreContext.Provider value={store}>
      <HelmStoreEffects store={store} boot={boot} />
      <PluginClientHostBridge store={store}>{children}</PluginClientHostBridge>
    </HelmExternalStoreContext.Provider>
  )
}
