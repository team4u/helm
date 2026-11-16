import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as LucideReact from 'lucide-react'
import * as HelmPluginClient from '@helm/plugin-client'
import { PluginClientHostContext, usePluginDocValue } from '@helm/plugin-client'
import type { ActionManifest, ArtifactMetadata, ConversationDetail, ConversationEntry, PluginSummary, Profile, ProviderConfig, SkillSummary } from '@helm/protocol/browser'
import { createLocaleTranslator } from '@helm/protocol/browser'
import { assetsApi, authApi, conversationsApi, nodesApi, pluginsApi, setStoredToken, type CredentialSummary, type ModelDescriptor, type NodeInfo } from './api.js'
import { errorText } from './format.js'
import { applyConversationEntry, emptyLiveState, mergeConversationDetail, sortNodes, type LiveState } from './live-state.js'
import { createPluginClientHostPort } from './plugin-client-host.js'
import { resetPluginClientCache } from './plugin-client.js'
import { getSessionDocState, resetSessionDocSubscriptions, retrySessionDoc, subscribeSessionDoc } from './session-docs.js'
import { applyScreenParamsPatch, partitionScreenParamsPatch } from './space-navigation.js'
import { HelmStoreContext, useHelmStore } from './store-context.js'
import { groupUiContributions, type HelmStoreValue, type ToastNotice } from './types.js'
import { formatLocationHash, hashHasPrimaryTarget, isSameLocationState, parseLocationHash, shouldPushLocationHistory, upgradeLegacyLocationState } from './url-hash-model.js'
import { useEscAbort } from './use-esc-abort.js'
import { useGlobalShortcuts } from './use-global-shortcuts.js'
import { useLocationNavigation } from './use-location-navigation.js'
import { useSseEvents, type SseCursor } from './use-sse-events.js'
import { useThemePreferences } from './use-theme-preferences.js'
import { useUnreadSync } from './use-unread-sync.js'
import { resetStandbyDrafts } from '../conversation/standby-model.js'
import { getStoredSidebarCollapsed, persistSidebarCollapsed } from '../shell/shortcuts-model.js'

export function HelmStoreProvider({ children }: { children: React.ReactNode }) {
  const [authReady, setAuthReady] = useState(false)
  const [authConfigured, setAuthConfigured] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [sseConnected, setSseConnected] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveState>(emptyLiveState)
  const liveRef = useRef(live)
  const [conversationArtifacts, setConversationArtifacts] = useState<Record<number, ArtifactMetadata[]>>({})
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
  // Current kernel boot generation (SSE snapshot bootId): a read-only fact
  // exposed to consumers such as version watching; not part of the SSE resume
  // state machine itself (resume credentials stay owned by sseCursorRef).
  const [kernelBootId, setKernelBootId] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  /** Whether static assets finished their first load this session (the standby page distinguishes "loading" from "profile missing"). */
  const [assetsLoaded, setAssetsLoaded] = useState(false)
  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [actions, setActions] = useState<ActionManifest[]>([])
  // The initial workbench position comes from the URL hash: refreshes,
  // copied deep links and forward/back all treat it as the single source of
  // truth. Home-entry detection and initial parsing complete in one pass:
  // entries without an explicit primary target and without a modal are
  // upgraded by the home-landing effect (replace) to the conversation-space
  // default target once auth and conversation data are ready.
  const [boot] = useState(() => {
    const rawHash = typeof window !== 'undefined' ? window.location.hash : ''
    const parsed = parseLocationHash(rawHash)
    return {
      location: upgradeLegacyLocationState(parsed),
      // Only entries without an explicit primary target and without a modal
      // deep link (including the legacy modal-param upgrade path) count as home entry.
      needsHomeLanding: !hashHasPrimaryTarget(rawHash) && parsed.activeModal === null,
    }
  })
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(getStoredSidebarCollapsed)
  const [notices, setNotices] = useState<ToastNotice[]>([])
  const noticeSequence = useRef(0)
  const session = useRef(0)
  // SSE short-disconnect resume credentials (bootId event generation + the
  // actually applied seq watermark): advanced only after a snapshot or frame
  // applies successfully; cleared immediately on logout/identity change or
  // snapshot/frame application failure, forcing a full snapshot on the next
  // connect — never retrying with a corrupted cursor, never letting a new
  // identity reuse the old authorization's client cache.
  const sseCursorRef = useRef<SseCursor | null>(null)
  const requests = useRef(new Map<string, Promise<unknown>>())
  const failedDocs = useRef(new Set<string>())
  const pluginEpoch = useRef(new Map<string, number>())
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const authenticatedRef = useRef(authenticated)
  authenticatedRef.current = authenticated
  const profilesRef = useRef(profiles)
  profilesRef.current = profiles
  const assetsLoadedRef = useRef(assetsLoaded)
  assetsLoadedRef.current = assetsLoaded
  const assetGeneration = useRef(0)

  const updateLive = useCallback((update: (state: LiveState) => LiveState) => {
    const next = update(liveRef.current)
    liveRef.current = next
    setLive(next)
  }, [])
  const delay = useCallback((fn: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.current.delete(timer); fn() }, ms)
    timers.current.add(timer)
  }, [])
  useEffect(() => () => {
    session.current++
    for (const timer of timers.current) clearTimeout(timer)
  }, [])

  const dismissNotice = useCallback((id: string) => setNotices((prev) => prev.filter((notice) => notice.id !== id)), [])
  const pushNotice = useCallback((notice: Omit<ToastNotice, 'id' | 'createdAt'>) => {
    const id = `notice-${++noticeSequence.current}`
    setNotices((prev) => [...prev.filter((item) => item.title !== notice.title || item.body !== notice.body), { ...notice, id, createdAt: Date.now() }])
    if (notice.level === 'info') delay(() => dismissNotice(id), 6000)
  }, [delay, dismissNotice])
  const reportLoad = useCallback((key: string, error?: unknown) => {
    setLoadErrors((prev) => {
      const next = { ...prev }
      if (error === undefined) delete next[key]
      else next[key] = errorText(error)
      return next
    })
  }, [])

  const {
    theme,
    themePreference,
    locale,
    quietNotifyEnabled,
    setTheme,
    setThemePreference,
    toggleTheme,
    setLocale,
    setQuietNotify,
  } = useThemePreferences(pushNotice)

  const refreshAssets = useCallback(async () => {
    const generation = ++assetGeneration.current
    const results = await Promise.allSettled([assetsApi.listProfiles(), assetsApi.listModels(), assetsApi.listProviders(), assetsApi.listCredentials(), assetsApi.listSkills(), pluginsApi.listActions()])
    if (generation !== assetGeneration.current) return
    if (results[0].status === 'fulfilled') setProfiles(results[0].value)
    if (results[1].status === 'fulfilled') setModels(results[1].value)
    if (results[2].status === 'fulfilled') setProviders(results[2].value)
    if (results[3].status === 'fulfilled') setCredentials(results[3].value)
    if (results[4].status === 'fulfilled') setSkills(results[4].value)
    if (results[5].status === 'fulfilled') setActions(results[5].value)
    // Profile asset success/failure is tracked separately: the standby page
    // distinguishes "load failed (retryable)" from "really missing"; never use
    // the all-assets completion signal to fake a successful Profile load.
    reportLoad('assets:profiles', results[0].status === 'rejected' ? results[0].reason : undefined)
    // Regardless of per-item outcomes, a completed round distinguishes
    // "loading" from "missing" (per-item failures get their own notices).
    setAssetsLoaded(true)
    const labels = ['角色', '模型', '网关', '凭据', '技能', '插件动作']
    results.forEach((result, index) => {
      if (result.status === 'rejected') pushNotice({ type: 'notification', level: 'error', title: `${labels[index]}加载失败`, body: errorText(result.reason) })
    })
  }, [pushNotice, reportLoad])

  // Fully recalibrates the plugin list: merges local live state against the
  // server list as the baseline (SSE increments preferred, removed items dropped).
  const syncPlugins = useCallback((next: PluginSummary[]) => {
    if (!Array.isArray(next)) return
    updateLive((state) => {
      const byId = new Map(state.plugins.map((p) => [p.id, p]))
      // Same id and enabled state: keep the local SSE version (may carry newer status/error/managed)
      const merged = next.map((incoming) => {
        const local = byId.get(incoming.id)
        return local && local.enabled === incoming.enabled ? local : incoming
      })
      return { ...state, plugins: merged }
    })
  }, [updateLive])
  useEffect(() => { if (authenticated) void refreshAssets() }, [authenticated, refreshAssets])

  // Refreshes the compute node list (health metrics change in real time; fetched when the modal opens and on manual refresh).
  const refreshNodes = useCallback(async (): Promise<NodeInfo[] | undefined> => {
    const epoch = session.current
    const nodesBeforeRequest = liveRef.current.nodes
    try {
      const list = await nodesApi.list()
      if (epoch !== session.current) return undefined
      const sorted = sortNodes(list)
      // If node events already arrived, keep the state newer than this HTTP snapshot.
      updateLive((state) => state.nodes === nodesBeforeRequest ? { ...state, nodes: sorted } : state)
      return liveRef.current.nodes
    } catch (error) {
      if (epoch === session.current) {
        pushNotice({ type: 'notification', level: 'error', title: '计算节点加载失败', body: errorText(error) })
      }
      return undefined
    }
  }, [pushNotice, updateLive])

  const loadConversationDetail = useCallback(async (id: number, force = false): Promise<ConversationDetail | undefined> => {
    const key = `conversation:${id}`
    const existing = requests.current.get(key)
    if (existing) return existing as Promise<ConversationDetail | undefined>
    if (!force && liveRef.current.conversationDetails[id]) return liveRef.current.conversationDetails[id]
    reportLoad(key)
    const epoch = session.current
    const task = conversationsApi.getDetail(id, { limit: 150 }).then((detail) => {
      if (session.current !== epoch) return undefined
      updateLive((state) => mergeConversationDetail(state, detail))
      return detail
    }).catch((error: unknown) => {
      if (session.current === epoch) reportLoad(key, error)
      return undefined
    }).finally(() => { if (requests.current.get(key) === task) requests.current.delete(key) })
    requests.current.set(key, task)
    return task
  }, [reportLoad, updateLive])

  const loadEarlierEntries = useCallback(async (id: number): Promise<void> => {
    const detail = liveRef.current.conversationDetails[id]
    if (!detail?.nextCursor) return
    const key = `history:${id}`
    if (requests.current.has(key)) return
    const epoch = session.current
    reportLoad(key)
    const task = conversationsApi.getDetail(id, { limit: 150, cursor: detail.nextCursor }).then((page) => {
      if (epoch === session.current) updateLive((state) => mergeConversationDetail(state, page, true))
    }).catch((error: unknown) => { if (epoch === session.current) reportLoad(key, error) })
      .finally(() => { if (requests.current.get(key) === task) requests.current.delete(key) })
    requests.current.set(key, task)
    await task
  }, [reportLoad, updateLive])

  /** Backfills a single entry's full text (fetched on demand after server-side preview truncation; reuses conversation.entry's in-place upsert semantics). */
  const backfillConversationEntry = useCallback((conversationId: number, entry: ConversationEntry): void => {
    updateLive((state) => applyConversationEntry(state, conversationId, entry))
  }, [updateLive])

  const loadConversationArtifacts = useCallback(async (id: number): Promise<ArtifactMetadata[] | undefined> => {
    const key = `artifacts:${id}`
    const existing = requests.current.get(key)
    if (existing) return existing as Promise<ArtifactMetadata[] | undefined>
    const epoch = session.current
    reportLoad(key)
    const task = conversationsApi.listArtifacts(id).then((list) => {
      if (epoch === session.current) setConversationArtifacts((prev) => ({ ...prev, [id]: list }))
      return list
    }).catch((error: unknown) => {
      if (epoch === session.current) {
        reportLoad(key, error)
        pushNotice({ type: 'notification', level: 'error', title: '会话产物加载失败', body: errorText(error), conversationId: id })
      }
      return undefined
    }).finally(() => { if (requests.current.get(key) === task) requests.current.delete(key) })
    requests.current.set(key, task)
    return task
  }, [reportLoad, pushNotice])

  const ensurePluginDoc = useCallback(async (pluginId: string, name: string): Promise<unknown> => {
    const docKey = `${pluginId}/${name}`, key = `doc:${docKey}`
    if (Object.hasOwn(liveRef.current.pluginDocs, docKey)) return liveRef.current.pluginDocs[docKey]
    if (failedDocs.current.has(key)) return undefined
    if (requests.current.has(key)) return requests.current.get(key)
    const epoch = session.current
    const pluginVersion = pluginEpoch.current.get(pluginId)
    const task = pluginsApi.getPublicDoc(pluginId, name).then((doc) => {
      if (epoch !== session.current || pluginVersion !== pluginEpoch.current.get(pluginId)) return undefined
      updateLive((state) => {
        if (Object.hasOwn(state.pluginDocs, docKey) || !state.plugins.some((p) => p.id === pluginId && p.enabled)) return state
        return { ...state, pluginDocs: { ...state.pluginDocs, [docKey]: doc.value } }
      })
      return doc.value
    }).catch((error: unknown) => {
      if (epoch === session.current && pluginVersion === pluginEpoch.current.get(pluginId)) {
        failedDocs.current.add(key)
        reportLoad(key, error)
        pushNotice({ type: 'notification', level: 'error', title: '插件状态读取失败', body: `${pluginId}/${name}：${errorText(error)}` })
      }
      return undefined
    }).finally(() => { if (requests.current.get(key) === task) requests.current.delete(key) })
    requests.current.set(key, task)
    return task
  }, [pushNotice, reportLoad, updateLive])

  const {
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
  } = useLocationNavigation({
    initialLocation: boot.location,
    needsHomeLanding: boot.needsHomeLanding,
    authenticated,
    assetsLoaded,
    sseConnected,
    liveRef,
    profilesRef,
    assetsLoadedRef,
    conversationDetails: live.conversationDetails,
    loadErrors,
    loadEarlierEntries,
    delay,
    pushNotice,
  })

  const {
    pendingEscAbortConversationId,
    clearEscAbortPrompt,
    confirmOrArmEscAbort,
  } = useEscAbort({
    primaryTarget,
    splitTarget,
    focusedPanel,
    conversations: live.conversations,
    conversationDetails: live.conversationDetails,
    setNotices,
    pushNotice,
  })

  const {
    unreadClearInFlight,
    unreadClearedSeq,
    visibleConversationIds,
    clearVisibleConversationUnread,
    resetUnreadSync,
  } = useUnreadSync({
    authenticated,
    authenticatedRef,
    primaryTarget,
    splitTarget,
    targets,
    liveRef,
    session,
    loadConversationDetail,
    loadConversationArtifacts,
    pushNotice,
  })

  const checkAuth = useCallback(async () => {
    setAuthError(null)
    try {
      const status = await authApi.status()
      setAuthConfigured(status.configured)
      setAuthenticated(status.authenticated)
    } catch (error) {
      setAuthError(`无法连接 Helm 内核：${errorText(error)}`)
    } finally { setAuthReady(true) }
  }, [])
  useEffect(() => { void checkAuth() }, [checkAuth])

  const logout = useCallback(() => {
    session.current++
    requests.current.clear()
    failedDocs.current.clear()
    resetUnreadSync()
    // Resume credentials are invalidated too: after switching identity on the
    // same Hub, another authorization's client watermark must not be reused.
    sseCursorRef.current = null
    assetGeneration.current++
    // Releases standby drafts and voids in-flight first-send tasks: stale
    // create/upload/submit responses must not revive text/attachments or keep sending.
    resetStandbyDrafts()
    resetPluginClientCache()
    resetSessionDocSubscriptions()
    setStoredToken(null)
    setAuthenticated(false)
    setSseConnected(false)
    // Clears the disconnect banner: idle-timeout/disconnect notices from
    // before logout must not linger into the new connection window after re-login.
    clearEscAbortPrompt()
    setConnectionError(null)
    resetNavigationOnLogout()
    // Resets the address bar to the default deep link (replaceState keeps the
    // history stack clean); writes stay disabled while unauthenticated to avoid
    // clobbering a user-pasted deep link.
    lastSyncedLocation.current = parseLocationHash('#/settings/profiles')
    window.history.replaceState(null, '', '#/settings/profiles')
    updateLive(emptyLiveState)
    setConversationArtifacts({})
    setLoadErrors({})
    setAssetsLoaded(false)
    setProfiles([]); setModels([]); setProviders([]); setCredentials([]); setSkills([]); setActions([])
  }, [clearEscAbortPrompt, lastSyncedLocation, resetNavigationOnLogout, resetUnreadSync, updateLive])
  useEffect(() => {
    window.addEventListener('helm:unauthorized', logout)
    return () => window.removeEventListener('helm:unauthorized', logout)
  }, [logout])
  const onAuthenticated = useCallback(async (token: string) => {
    setStoredToken(token)
    setAuthConfigured(true)
    setAuthError(null)
    setAuthenticated(true)
  }, [])

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed)
    persistSidebarCollapsed(collapsed)
  }, [])

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsedState((prev) => {
      const next = !prev
      persistSidebarCollapsed(next)
      return next
    })
  }, [])

  // ---- Screen route param updates (implemented inside the single navigation
  // mechanism; components must never touch browser history directly) ----
  // setParams(..., { push: true }) and openTarget({ history }) share pendingHistoryMode.
  const setScreenParams = useCallback((patch: Record<string, string | undefined>, options?: { split?: boolean; push?: boolean }) => {
    const { validEntries, invalidKeys } = partitionScreenParamsPatch(patch)
    for (const key of invalidKeys) {
      pushNotice({ type: 'notification', level: 'warning', title: '已忽略非法 Screen 参数键', body: `参数 ${key} 必须使用合法键和字符串值` })
    }
    const currentTarget = options?.split ? splitTarget : primaryTarget
    if (validEntries.length === 0 || currentTarget?.kind !== 'screen') return
    if (options?.push) pendingHistoryMode.current = 'push'
    if (options?.split) setSplitTarget((current) => (current === null ? current : applyScreenParamsPatch(current, validEntries)))
    else applyPrimaryTarget(applyScreenParamsPatch(primaryTarget, validEntries))
  }, [applyPrimaryTarget, pendingHistoryMode, primaryTarget, pushNotice, setSplitTarget, splitTarget])
  const invokePluginAction = useCallback(async (pluginId: string, actionId: string, input: unknown, conversationId?: number) => pluginsApi.invokeAction(pluginId, actionId, input, conversationId), [])

  const getPluginSessionDoc = useCallback(async (pluginId: string, docName: string, conversationId: number): Promise<unknown> => {
    const doc = await pluginsApi.getPublicSessionDoc(pluginId, docName, conversationId)
    return doc.value
  }, [])

  // ---- URL hash two-way sync --------------------------------------------------
  // External changes (forward/back/manual hash edit): parsed and overlaid onto
  // local state. pushState/replaceState do not fire these events, so our own
  // writes never loop; an event equal to the last synced position is an echo
  // and is ignored.
  useEffect(() => {
    const applyUrlLocation = () => {
      const parsed = upgradeLegacyLocationState(parseLocationHash(window.location.hash))
      if (isSameLocationState(parsed, lastSyncedLocation.current)) return
      applyExternalLocation(parsed)
    }
    window.addEventListener('hashchange', applyUrlLocation)
    window.addEventListener('popstate', applyUrlLocation)
    return () => {
      window.removeEventListener('hashchange', applyUrlLocation)
      window.removeEventListener('popstate', applyUrlLocation)
    }
  }, [applyExternalLocation])

  // State is written back to the address bar only after authentication (the
  // AuthGate phase preserves the user's pasted deep-link hash). View-level
  // changes (primary/split/modal toggles) push history; selecting an item
  // within a list or switching tabs replaces to keep history compact.
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
  })

  useSseEvents({
    authenticated,
    session,
    sseCursorRef,
    liveRef,
    requests,
    failedDocs,
    unreadClearInFlight,
    unreadClearedSeq,
    pluginEpoch,
    targets,
    activeModalRef,
    pendingHistoryMode,
    logout,
    setSseConnected,
    setConnectionError,
    setLoadErrors,
    updateLive,
    setKernelBootId,
    setConversationArtifacts,
    visibleConversationIds,
    loadConversationDetail,
    loadConversationArtifacts,
    clearVisibleConversationUnread,
    pushNotice,
    refreshAssets,
    applyPrimaryTarget,
    setSplitTarget,
    setActiveModal,
  })

  const groupedUi = useMemo(() => groupUiContributions(live.uiContributions), [live.uiContributions])
  // The context value must keep a stable reference: no single piece of local
  // state should re-render every consuming component.
  const store: HelmStoreValue = useMemo(
    () => ({
      ...live, authReady, authConfigured, authenticated, authError, connectionError, loadErrors, sseConnected, kernelBootId, theme, themePreference, locale, quietNotifyEnabled, conversationArtifacts, assetsLoaded,
      groupedUi, profiles, models, providers, credentials, skills, actions, primaryTarget, splitTarget, focusedPanel, sidebarCollapsed, pendingEscAbortConversationId, workbenchOpen, workbenchTab, activeModal, highlightedEntry, notices,
      setTheme, setThemePreference, toggleTheme, setLocale, setQuietNotify, checkAuth, onAuthenticated, logout, refreshAssets, syncPlugins, refreshNodes, loadConversationDetail, loadEarlierEntries, backfillConversationEntry, loadConversationArtifacts, ensurePluginDoc, subscribeSessionDoc, getSessionDocState, getPluginSessionDoc, retrySessionDoc, openTarget, closeSplit, setFocusedPanel, setSidebarCollapsed, toggleSidebarCollapsed, setScreenParams, setWorkbenchOpen, setWorkbenchTab, openSpace, setActiveModal, dismissNotice, pushNotice, invokePluginAction,
    }),
    [
      live, authReady, authConfigured, authenticated, authError, connectionError, loadErrors, sseConnected, kernelBootId, theme, themePreference, locale, quietNotifyEnabled, conversationArtifacts, assetsLoaded,
      groupedUi, profiles, models, providers, credentials, skills, actions, primaryTarget, splitTarget, focusedPanel, sidebarCollapsed, pendingEscAbortConversationId, workbenchOpen, workbenchTab, activeModal, highlightedEntry, notices,
      setTheme, setThemePreference, toggleTheme, setLocale, setQuietNotify, checkAuth, onAuthenticated, logout, refreshAssets, syncPlugins, refreshNodes, loadConversationDetail, loadEarlierEntries, backfillConversationEntry, loadConversationArtifacts, ensurePluginDoc, getPluginSessionDoc, openTarget, closeSplit, setFocusedPanel, setSidebarCollapsed, toggleSidebarCollapsed, setScreenParams, setWorkbenchOpen, setWorkbenchTab, openSpace, setActiveModal, dismissNotice, pushNotice, invokePluginAction,
    ],
  )
  useEffect(() => {
    // Host shared runtime:
    // - __HELM_SHARED__: named handles (debugging / future consumers);
    // - __helm_shared_* namespaces: plugin client.tsx build artifacts
    //   virtualize shared dependencies (react etc.) and '@helm/plugin-client'
    //   into these global namespaces; at runtime they resolve to the same
    //   React/lucide/host hooks instances — never a second React bundle.
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
  // Host port: SDK (@helm/plugin-client) hooks and delegate components get the
  // real store capabilities injected through this port. The port object is
  // rebuilt with each store snapshot (same SSE cadence as the store); hooks
  // depend only on stable named functions. Locale/translate are added on top
  // of the base adapter (which stays locale-agnostic until its own phase).
  const pluginClientPort = useMemo(
    () => ({ ...createPluginClientHostPort(store), locale: store.locale, translate: createLocaleTranslator(store.locale) }),
    [store],
  )
  return (
    <HelmStoreContext.Provider value={store}>
      <PluginClientHostContext.Provider value={pluginClientPort}>{children}</PluginClientHostContext.Provider>
    </HelmStoreContext.Provider>
  )
}
