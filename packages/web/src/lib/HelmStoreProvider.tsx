import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as LucideReact from 'lucide-react'
import * as HelmPluginClient from '@helm/plugin-client'
import { PluginClientHostContext, usePluginDocValue } from '@helm/plugin-client'
import type { ActionManifest, ArtifactMetadata, ConversationDetail, ConversationEntry, PluginSummary, Profile, ProviderConfig, SkillSummary } from '@helm/protocol/browser'
import { createLocaleTranslator, type LocalizedText } from '@helm/protocol/browser'
import { assetsApi, authApi, conversationsApi, nodesApi, pluginsApi, setStoredToken, type CredentialSummary, type ModelDescriptor, type NodeInfo } from './api.js'
import { errorText } from './format.js'
import { applyConversationEntry, emptyLiveState, mergeConversationDetail, sortNodes, type LiveState } from './live-state.js'
import { createPluginClientHostPort } from './plugin-client-host.js'
import { resetPluginClientCache } from './plugin-client.js'
import { getSessionDocState, resetSessionDocSubscriptions, retrySessionDoc, subscribeSessionDoc } from './session-docs.js'
import { applyScreenParamsPatch, partitionScreenParamsPatch } from './space-navigation.js'
import { HelmStoreContext, useHelmStore } from './store-context.js'
import { groupUiContributions, defaultConversationDetailLimit, type HelmStoreValue, type ToastNotice } from './types.js'
import { formatLocationHash, hashHasPrimaryTarget, isSameLocationState, parseLocationHash, shouldPushLocationHistory, upgradeLegacyLocationState } from './url-hash-model.js'
import { useEscAbort } from './use-esc-abort.js'
import { useGlobalShortcuts } from './use-global-shortcuts.js'
import { useLocationNavigation } from './use-location-navigation.js'
import { useSseEvents, type SseCursor } from './use-sse-events.js'
import { useThemePreferences } from './use-theme-preferences.js'
import { useUnreadSync, type ArtifactsSyncWatermark } from './use-unread-sync.js'
import { resetStandbyDrafts } from '../conversation/standby-model.js'
import { getStoredSidebarCollapsed, persistSidebarCollapsed } from '../shell/shortcuts-model.js'

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { name?: string }).name === 'AbortError'
}

/**
 * Asset-kind failure notice titles, one per assetsApi/pluginsApi call in
 * refreshAssets (order-locked); resolved against the active locale at push
 * time via the stable shell translator.
 */
const ASSET_LOAD_FAILURE_TITLES: ReadonlyArray<LocalizedText> = [
  { en: 'Profiles failed to load', 'zh-CN': '角色加载失败' },
  { en: 'Models failed to load', 'zh-CN': '模型加载失败' },
  { en: 'Providers failed to load', 'zh-CN': '网关加载失败' },
  { en: 'Credentials failed to load', 'zh-CN': '凭据加载失败' },
  { en: 'Skills failed to load', 'zh-CN': '技能加载失败' },
  { en: 'Plugin actions failed to load', 'zh-CN': '插件动作加载失败' },
]

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
  const conversationArtifactsRef = useRef(conversationArtifacts)
  conversationArtifactsRef.current = conversationArtifacts
  const artifactsWatermarksRef = useRef(new Map<number, ArtifactsSyncWatermark>())
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
  // Current kernel boot generation (SSE snapshot bootId): a read-only fact
  // exposed to consumers such as version watching; not part of the SSE resume
  // state machine itself (resume credentials stay owned by sseCursorRef).
  const [kernelBootId, setKernelBootId] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  /** Whether profiles finished loading independently of slower assets (releases home landing early). */
  const [profilesLoaded, setProfilesLoaded] = useState(false)
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
  const inFlightControllers = useRef(new Map<string, AbortController>())
  const requestEpochs = useRef(new Map<string, number>())
  const assetsControllerRef = useRef<AbortController | null>(null)
  const prevVisibleConversationIdsRef = useRef<Set<number>>(new Set())
  const failedDocs = useRef(new Set<string>())
  const pluginEpoch = useRef(new Map<string, number>())
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const authenticatedRef = useRef(authenticated)
  authenticatedRef.current = authenticated
  const profilesRef = useRef(profiles)
  profilesRef.current = profiles
  const profilesLoadedRef = useRef(profilesLoaded)
  profilesLoadedRef.current = profilesLoaded
  const assetsLoadedRef = useRef(assetsLoaded)
  assetsLoadedRef.current = assetsLoaded
  const assetGeneration = useRef(0)

  const abortRequestKey = useCallback((key: string): void => {
    requestEpochs.current.set(key, (requestEpochs.current.get(key) ?? 0) + 1)
    const ctrl = inFlightControllers.current.get(key)
    if (ctrl !== undefined) {
      inFlightControllers.current.delete(key)
      ctrl.abort()
    }
    requests.current.delete(key)
  }, [])

  const abortInFlightConversationRequests = useCallback((): void => {
    const keys = new Set<string>([...inFlightControllers.current.keys(), ...requests.current.keys()])
    for (const key of keys) {
      if (key.startsWith('conversation:') || key.startsWith('history:') || key.startsWith('artifacts:')) {
        abortRequestKey(key)
      }
    }
  }, [abortRequestKey])

  const abortAllInFlight = useCallback((): void => {
    const keys = new Set<string>([...inFlightControllers.current.keys(), ...requests.current.keys()])
    for (const key of keys) abortRequestKey(key)
    assetsControllerRef.current?.abort()
    assetsControllerRef.current = null
  }, [abortRequestKey])

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
    abortAllInFlight()
    for (const timer of timers.current) clearTimeout(timer)
  }, [abortAllInFlight])

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
    localePreference,
    quietNotifyEnabled,
    translate,
    setTheme,
    setThemePreference,
    toggleTheme,
    setLocale,
    setLocalePreference,
    setQuietNotify,
  } = useThemePreferences(pushNotice)

  const refreshAssets = useCallback(async () => {
    const generation = ++assetGeneration.current
    assetsControllerRef.current?.abort()
    const controller = new AbortController()
    assetsControllerRef.current = controller
    const signal = controller.signal

    const profilesTask = assetsApi.listProfiles({ signal }).then(
      (list) => {
        if (generation !== assetGeneration.current || signal.aborted) return
        setProfiles(list)
        reportLoad('assets:profiles', undefined)
        profilesLoadedRef.current = true
        setProfilesLoaded(true)
      },
      (reason: unknown) => {
        if (isAbortError(reason) || signal.aborted || generation !== assetGeneration.current) return
        // Profile asset success/failure is tracked separately: the standby page
        // distinguishes "load failed (retryable)" from "really missing".
        reportLoad('assets:profiles', reason)
        profilesLoadedRef.current = true
        setProfilesLoaded(true)
        pushNotice({ type: 'notification', level: 'error', title: translate(ASSET_LOAD_FAILURE_TITLES[0]!), body: errorText(reason) })
      },
    )

    const otherTasks = Promise.allSettled([
      assetsApi.listModels({ signal }),
      assetsApi.listProviders({ signal }),
      assetsApi.listCredentials({ signal }),
      assetsApi.listSkills({ signal }),
      pluginsApi.listActions({ signal }),
    ]).then((results) => {
      if (generation !== assetGeneration.current || signal.aborted) return
      if (results[0].status === 'fulfilled') setModels(results[0].value)
      if (results[1].status === 'fulfilled') setProviders(results[1].value)
      if (results[2].status === 'fulfilled') setCredentials(results[2].value)
      if (results[3].status === 'fulfilled') setSkills(results[3].value)
      if (results[4].status === 'fulfilled') setActions(results[4].value)
      results.forEach((result, index) => {
        if (result.status === 'rejected' && !isAbortError(result.reason)) {
          pushNotice({ type: 'notification', level: 'error', title: translate(ASSET_LOAD_FAILURE_TITLES[index + 1]!), body: errorText(result.reason) })
        }
      })
    })

    await Promise.all([profilesTask, otherTasks])
    if (generation !== assetGeneration.current || signal.aborted) return
    if (assetsControllerRef.current === controller) assetsControllerRef.current = null
    // Regardless of per-item outcomes, a completed round distinguishes
    // "loading" from "missing" (per-item failures get their own notices).
    setAssetsLoaded(true)
  }, [pushNotice, reportLoad, translate])

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
        pushNotice({ type: 'notification', level: 'error', title: translate({ en: 'Compute nodes failed to load', 'zh-CN': '计算节点加载失败' }), body: errorText(error) })
      }
      return undefined
    }
  }, [pushNotice, translate, updateLive])

  const loadConversationDetail = useCallback(async (
    id: number,
    force = false,
    opts?: { silent?: boolean; limit?: number },
  ): Promise<ConversationDetail | undefined> => {
    const key = `conversation:${id}`
    const existing = requests.current.get(key)
    if (existing) return existing as Promise<ConversationDetail | undefined>
    if (!force && liveRef.current.conversationDetails[id]) return liveRef.current.conversationDetails[id]
    const silent = opts?.silent === true
    const hasCached = liveRef.current.conversationDetails[id] !== undefined
    if (!silent || !hasCached) reportLoad(key)
    const epoch = session.current
    const reqEpoch = (requestEpochs.current.get(key) ?? 0) + 1
    requestEpochs.current.set(key, reqEpoch)
    const controller = new AbortController()
    inFlightControllers.current.set(key, controller)
    const limit = opts?.limit ?? defaultConversationDetailLimit()
    const task = conversationsApi.getDetail(id, { limit, signal: controller.signal }).then((detail) => {
      if (session.current !== epoch || controller.signal.aborted || requestEpochs.current.get(key) !== reqEpoch) {
        return undefined
      }
      reportLoad(key)
      updateLive((state) => mergeConversationDetail(state, detail))
      return detail
    }).catch((error: unknown) => {
      if (
        isAbortError(error) ||
        controller.signal.aborted ||
        session.current !== epoch ||
        requestEpochs.current.get(key) !== reqEpoch
      ) {
        return undefined
      }
      if (!silent || liveRef.current.conversationDetails[id] === undefined) {
        reportLoad(key, error)
      }
      return undefined
    }).finally(() => {
      if (inFlightControllers.current.get(key) === controller) inFlightControllers.current.delete(key)
      if (requests.current.get(key) === task) requests.current.delete(key)
    })
    requests.current.set(key, task)
    return task
  }, [reportLoad, updateLive])

  const loadEarlierEntries = useCallback(async (id: number): Promise<void> => {
    const detail = liveRef.current.conversationDetails[id]
    if (!detail?.nextCursor) return
    const key = `history:${id}`
    if (requests.current.has(key)) return
    const epoch = session.current
    const reqEpoch = (requestEpochs.current.get(key) ?? 0) + 1
    requestEpochs.current.set(key, reqEpoch)
    const controller = new AbortController()
    inFlightControllers.current.set(key, controller)
    reportLoad(key)
    const limit = defaultConversationDetailLimit()
    const task = conversationsApi.getDetail(id, { limit, cursor: detail.nextCursor, signal: controller.signal }).then((page) => {
      if (session.current !== epoch || controller.signal.aborted || requestEpochs.current.get(key) !== reqEpoch) {
        return
      }
      updateLive((state) => mergeConversationDetail(state, page, true))
    }).catch((error: unknown) => {
      if (
        isAbortError(error) ||
        controller.signal.aborted ||
        session.current !== epoch ||
        requestEpochs.current.get(key) !== reqEpoch
      ) {
        return
      }
      reportLoad(key, error)
    }).finally(() => {
      if (inFlightControllers.current.get(key) === controller) inFlightControllers.current.delete(key)
      if (requests.current.get(key) === task) requests.current.delete(key)
    })
    requests.current.set(key, task)
    await task
  }, [reportLoad, updateLive])

  /** Backfills a single entry's full text (fetched on demand after server-side preview truncation; reuses conversation.entry's in-place upsert semantics). */
  const backfillConversationEntry = useCallback((conversationId: number, entry: ConversationEntry): void => {
    updateLive((state) => applyConversationEntry(state, conversationId, entry))
  }, [updateLive])

  const loadConversationArtifacts = useCallback(async (
    id: number,
    opts?: { silent?: boolean },
  ): Promise<ArtifactMetadata[] | undefined> => {
    const key = `artifacts:${id}`
    const existing = requests.current.get(key)
    if (existing) return existing as Promise<ArtifactMetadata[] | undefined>
    const silent = opts?.silent === true
    const hasCached = conversationArtifactsRef.current[id] !== undefined
    if (!silent || !hasCached) reportLoad(key)
    const epoch = session.current
    const reqEpoch = (requestEpochs.current.get(key) ?? 0) + 1
    requestEpochs.current.set(key, reqEpoch)
    const controller = new AbortController()
    inFlightControllers.current.set(key, controller)
    const sampledSummary = liveRef.current.conversations.find((c) => c.id === id)
    const sampledWatermark = sampledSummary !== undefined
      ? { stateChangeSeq: sampledSummary.stateChangeSeq, lastEntryId: sampledSummary.lastEntryId }
      : undefined
    const task = conversationsApi.listArtifacts(id, { signal: controller.signal }).then((list) => {
      if (session.current !== epoch || controller.signal.aborted || requestEpochs.current.get(key) !== reqEpoch) {
        return undefined
      }
      reportLoad(key)
      setConversationArtifacts((prev) => ({ ...prev, [id]: list }))
      const resolvedWatermark = sampledWatermark ?? (() => {
        const latest = liveRef.current.conversations.find((c) => c.id === id) ?? liveRef.current.conversationDetails[id]
        return latest !== undefined
          ? { stateChangeSeq: latest.stateChangeSeq, lastEntryId: latest.lastEntryId }
          : undefined
      })()
      if (resolvedWatermark !== undefined) artifactsWatermarksRef.current.set(id, resolvedWatermark)
      else artifactsWatermarksRef.current.delete(id)
      return list
    }).catch((error: unknown) => {
      if (
        isAbortError(error) ||
        controller.signal.aborted ||
        session.current !== epoch ||
        requestEpochs.current.get(key) !== reqEpoch
      ) {
        return undefined
      }
      if (!silent || conversationArtifactsRef.current[id] === undefined) {
        reportLoad(key, error)
        pushNotice({
          type: 'notification',
          level: 'error',
          title: translate({ en: 'Conversation artifacts failed to load', 'zh-CN': '会话产物加载失败' }),
          body: errorText(error),
          conversationId: id,
        })
      }
      return undefined
    }).finally(() => {
      if (inFlightControllers.current.get(key) === controller) inFlightControllers.current.delete(key)
      if (requests.current.get(key) === task) requests.current.delete(key)
    })
    requests.current.set(key, task)
    return task
  }, [reportLoad, pushNotice, translate])

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
        pushNotice({
          type: 'notification',
          level: 'error',
          title: translate({ en: 'Plugin state failed to load', 'zh-CN': '插件状态读取失败' }),
          body: translate({
            en: `${pluginId}/${name}: ${errorText(error)}`,
            'zh-CN': `${pluginId}/${name}：${errorText(error)}`,
          }),
        })
      }
      return undefined
    }).finally(() => { if (requests.current.get(key) === task) requests.current.delete(key) })
    requests.current.set(key, task)
    return task
  }, [pushNotice, reportLoad, translate, updateLive])

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
    profilesLoaded,
    assetsLoaded,
    sseConnected,
    liveRef,
    profilesRef,
    profilesLoadedRef,
    assetsLoadedRef,
    conversationDetails: live.conversationDetails,
    loadErrors,
    loadEarlierEntries,
    delay,
    pushNotice,
  })

  // 目标切换或关闭分屏/抽屉时取消已离开会话的在途 detail / history / artifacts 请求，防拥塞与过期回写。
  useEffect(() => {
    const nextVisible = new Set<number>()
    if (primaryTarget.kind === 'conversation') nextVisible.add(primaryTarget.conversationId)
    if (splitTarget?.kind === 'conversation') nextVisible.add(splitTarget.conversationId)
    if (activeModal?.kind === 'conversation-drawer' || activeModal?.kind === 'artifact-preview') {
      if (activeModal.conversationId !== undefined) nextVisible.add(activeModal.conversationId)
    }
    for (const prevId of prevVisibleConversationIdsRef.current) {
      if (!nextVisible.has(prevId)) {
        abortRequestKey(`conversation:${prevId}`)
        abortRequestKey(`history:${prevId}`)
        abortRequestKey(`artifacts:${prevId}`)
      }
    }
    prevVisibleConversationIdsRef.current = nextVisible
  }, [primaryTarget, splitTarget, activeModal, abortRequestKey])

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
    conversationArtifactsRef,
    artifactsWatermarksRef,
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
      setAuthError(translate({
        en: `Cannot connect to the Helm kernel: ${errorText(error)}`,
        'zh-CN': `无法连接 Helm 内核：${errorText(error)}`,
      }))
    } finally { setAuthReady(true) }
  }, [translate])
  useEffect(() => { void checkAuth() }, [checkAuth])

  const logout = useCallback(() => {
    session.current++
    abortAllInFlight()
    requests.current.clear()
    failedDocs.current.clear()
    artifactsWatermarksRef.current.clear()
    prevVisibleConversationIdsRef.current.clear()
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
    profilesLoadedRef.current = false
    setProfilesLoaded(false)
    setAssetsLoaded(false)
    setProfiles([]); setModels([]); setProviders([]); setCredentials([]); setSkills([]); setActions([])
  }, [abortAllInFlight, clearEscAbortPrompt, lastSyncedLocation, resetNavigationOnLogout, resetUnreadSync, updateLive])
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
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: translate({ en: 'Ignored invalid Screen parameter key', 'zh-CN': '已忽略非法 Screen 参数键' }),
        body: translate({
          en: `Parameter ${key} must use a valid key and a string value`,
          'zh-CN': `参数 ${key} 必须使用合法键和字符串值`,
        }),
      })
    }
    const currentTarget = options?.split ? splitTarget : primaryTarget
    if (validEntries.length === 0 || currentTarget?.kind !== 'screen') return
    if (options?.push) pendingHistoryMode.current = 'push'
    if (options?.split) setSplitTarget((current) => (current === null ? current : applyScreenParamsPatch(current, validEntries)))
    else applyPrimaryTarget(applyScreenParamsPatch(primaryTarget, validEntries))
  }, [applyPrimaryTarget, pendingHistoryMode, primaryTarget, pushNotice, setSplitTarget, splitTarget, translate])
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
    conversationArtifactsRef,
    artifactsWatermarksRef,
    visibleConversationIds,
    loadConversationDetail,
    loadConversationArtifacts,
    abortInFlightConversationRequests,
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
      ...live, authReady, authConfigured, authenticated, authError, connectionError, loadErrors, sseConnected, kernelBootId, theme, themePreference, locale, localePreference, quietNotifyEnabled, conversationArtifacts, profilesLoaded, assetsLoaded,
      groupedUi, profiles, models, providers, credentials, skills, actions, primaryTarget, splitTarget, focusedPanel, sidebarCollapsed, pendingEscAbortConversationId, workbenchOpen, workbenchTab, activeModal, highlightedEntry, notices,
      setTheme, setThemePreference, toggleTheme, setLocale, setLocalePreference, setQuietNotify, checkAuth, onAuthenticated, logout, refreshAssets, syncPlugins, refreshNodes, loadConversationDetail, loadEarlierEntries, backfillConversationEntry, loadConversationArtifacts, ensurePluginDoc, subscribeSessionDoc, getSessionDocState, getPluginSessionDoc, retrySessionDoc, openTarget, closeSplit, setFocusedPanel, setSidebarCollapsed, toggleSidebarCollapsed, setScreenParams, setWorkbenchOpen, setWorkbenchTab, openSpace, setActiveModal, dismissNotice, pushNotice, invokePluginAction,
    }),
    [
      live, authReady, authConfigured, authenticated, authError, connectionError, loadErrors, sseConnected, kernelBootId, theme, themePreference, locale, localePreference, quietNotifyEnabled, conversationArtifacts, profilesLoaded, assetsLoaded,
      groupedUi, profiles, models, providers, credentials, skills, actions, primaryTarget, splitTarget, focusedPanel, sidebarCollapsed, pendingEscAbortConversationId, workbenchOpen, workbenchTab, activeModal, highlightedEntry, notices,
      setTheme, setThemePreference, toggleTheme, setLocale, setLocalePreference, setQuietNotify, checkAuth, onAuthenticated, logout, refreshAssets, syncPlugins, refreshNodes, loadConversationDetail, loadEarlierEntries, backfillConversationEntry, loadConversationArtifacts, ensurePluginDoc, getPluginSessionDoc, openTarget, closeSplit, setFocusedPanel, setSidebarCollapsed, toggleSidebarCollapsed, setScreenParams, setWorkbenchOpen, setWorkbenchTab, openSpace, setActiveModal, dismissNotice, pushNotice, invokePluginAction,
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
