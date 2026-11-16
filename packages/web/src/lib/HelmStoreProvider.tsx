import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as LucideReact from 'lucide-react'
import * as HelmPluginClient from '@helm/plugin-client'
import { PluginClientHostContext, usePluginDocValue } from '@helm/plugin-client'
import type { ActionManifest, ArtifactMetadata, ConversationDetail, ConversationEntry, PluginSummary, Profile, ProviderConfig, SkillSummary } from '@helm/protocol'
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
  // 当前内核启动代（SSE snapshot bootId）：只读事实暴露给版本感知等消费者，
  // 不参与 SSE 续传状态机本身（续传凭据仍由 sseCursorRef 唯一维护）。
  const [kernelBootId, setKernelBootId] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  /** 静态资产是否已完成本轮会话首次加载（待命页区分「加载中」与「角色不存在」）。 */
  const [assetsLoaded, setAssetsLoaded] = useState(false)
  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [actions, setActions] = useState<ActionManifest[]>([])
  // 初始工作台位置取自地址栏 Hash：刷新、复制链接直达与前进/后退都以它为唯一事实来源。
  // 首页进入判定与初始解析同源一次完成：无显式主屏目标且无弹窗的入口，等认证与会话
  // 数据就绪后由首页落地 effect 以 replace 升级到对话空间缺省目标。
  const [boot] = useState(() => {
    const rawHash = typeof window !== 'undefined' ? window.location.hash : ''
    const parsed = parseLocationHash(rawHash)
    return {
      location: upgradeLegacyLocationState(parsed),
      // 无显式主屏目标且无弹窗深链（含旧弹窗参数升级路径）才视为首页进入。
      needsHomeLanding: !hashHasPrimaryTarget(rawHash) && parsed.activeModal === null,
    }
  })
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(getStoredSidebarCollapsed)
  const [notices, setNotices] = useState<ToastNotice[]>([])
  const noticeSequence = useRef(0)
  const session = useRef(0)
  // SSE 短断线续传凭据（bootId 事件代 + 已实际应用的水位 seq）：仅在快照成功应用或
  // 逐帧应用成功后推进；登出/换身份、快照或帧应用失败立即清空，下次连接强制全量
  // 快照，绝不携带损坏 cursor 重试，也不让新身份沿用旧授权的客户端缓存。
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
    quietNotifyEnabled,
    setTheme,
    setThemePreference,
    toggleTheme,
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
    // 角色资产单独记录成败：待命页据此区分「加载失败（可重试）」与「确实不存在」，
    // 不得用全体 assets 的完成信号假装 Profile 加载成功。
    reportLoad('assets:profiles', results[0].status === 'rejected' ? results[0].reason : undefined)
    // 无论单项成败，本轮已返回即可区分「加载中」与「不存在」（单项失败另有通知）。
    setAssetsLoaded(true)
    const labels = ['角色', '模型', '网关', '凭据', '技能', '插件动作']
    results.forEach((result, index) => {
      if (result.status === 'rejected') pushNotice({ type: 'notification', level: 'error', title: `${labels[index]}加载失败`, body: errorText(result.reason) })
    })
  }, [pushNotice, reportLoad])

  // 全量校准插件清单：以服务端列表为基准合并本地 live 状态（SSE 增量优先保留，卸载项剔除）。
  const syncPlugins = useCallback((next: PluginSummary[]) => {
    if (!Array.isArray(next)) return
    updateLive((state) => {
      const byId = new Map(state.plugins.map((p) => [p.id, p]))
      // 同 id 同启用态时保留本地 SSE 版本（可能携带更新的 status/error/managed）
      const merged = next.map((incoming) => {
        const local = byId.get(incoming.id)
        return local && local.enabled === incoming.enabled ? local : incoming
      })
      return { ...state, plugins: merged }
    })
  }, [updateLive])
  useEffect(() => { if (authenticated) void refreshAssets() }, [authenticated, refreshAssets])

  // 刷新计算节点列表（健康指标实时变化，弹窗打开与手动刷新时拉取）。
  const refreshNodes = useCallback(async (): Promise<NodeInfo[] | undefined> => {
    const epoch = session.current
    const nodesBeforeRequest = liveRef.current.nodes
    try {
      const list = await nodesApi.list()
      if (epoch !== session.current) return undefined
      const sorted = sortNodes(list)
      // 节点事件若已到达，保留比本次 HTTP 快照更新的状态。
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

  /** 单条目全文回填（服务端预览截断后按需取回；复用 conversation.entry 的原位 upsert 语义）。 */
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
    // 续传凭据一并作废：同一 Hub 换身份后不得沿用其他授权会话的客户端水位。
    sseCursorRef.current = null
    assetGeneration.current++
    // 释放待命草稿并作废在途首发任务：旧 create/upload/submit 回包不得复活正文/附件或继续发送。
    resetStandbyDrafts()
    resetPluginClientCache()
    resetSessionDocSubscriptions()
    setStoredToken(null)
    setAuthenticated(false)
    setSseConnected(false)
    // 清除断线横幅：登出前的空闲超时/断连提示不得残留到重新登录后的新连接窗口。
    clearEscAbortPrompt()
    setConnectionError(null)
    resetNavigationOnLogout()
    // 地址栏同步复位为默认深链（replaceState 不污染历史栈）；未认证期间禁用写回，避免覆盖用户粘贴的深链。
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

  // ---- Screen 路由参数更新（唯一导航机制内实现，组件不得直接操作浏览器历史） ----
  // setParams(..., { push: true }) 与 openTarget({ history }) 共用 pendingHistoryMode。
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

  // ---- 地址栏 Hash 双向同步 --------------------------------------------------
  // 外部变更（前进/后退/手动改 Hash）：解析后覆盖本地状态。pushState/replaceState
  // 不会触发这两个事件，因此自身写回不会形成回环；与最近同步位置相同的事件是回声，忽略。
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

  // 状态写回地址栏：仅在已认证后进行（AuthGate 阶段保留用户粘贴的深链 Hash）。
  // 视图级变化（主屏/分屏/弹窗开关）push 入栈，列表内选子项/切 Tab 用 replace 折叠历史。
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
  // Context value 需引用稳定：任何一处局部状态变化都不应触发全量消费组件重渲染。
  const store: HelmStoreValue = useMemo(
    () => ({
      ...live, authReady, authConfigured, authenticated, authError, connectionError, loadErrors, sseConnected, kernelBootId, theme, themePreference, quietNotifyEnabled, conversationArtifacts, assetsLoaded,
      groupedUi, profiles, models, providers, credentials, skills, actions, primaryTarget, splitTarget, focusedPanel, sidebarCollapsed, pendingEscAbortConversationId, workbenchOpen, workbenchTab, activeModal, highlightedEntry, notices,
      setTheme, setThemePreference, toggleTheme, setQuietNotify, checkAuth, onAuthenticated, logout, refreshAssets, syncPlugins, refreshNodes, loadConversationDetail, loadEarlierEntries, backfillConversationEntry, loadConversationArtifacts, ensurePluginDoc, subscribeSessionDoc, getSessionDocState, getPluginSessionDoc, retrySessionDoc, openTarget, closeSplit, setFocusedPanel, setSidebarCollapsed, toggleSidebarCollapsed, setScreenParams, setWorkbenchOpen, setWorkbenchTab, openSpace, setActiveModal, dismissNotice, pushNotice, invokePluginAction,
    }),
    [
      live, authReady, authConfigured, authenticated, authError, connectionError, loadErrors, sseConnected, kernelBootId, theme, themePreference, quietNotifyEnabled, conversationArtifacts, assetsLoaded,
      groupedUi, profiles, models, providers, credentials, skills, actions, primaryTarget, splitTarget, focusedPanel, sidebarCollapsed, pendingEscAbortConversationId, workbenchOpen, workbenchTab, activeModal, highlightedEntry, notices,
      setTheme, setThemePreference, toggleTheme, setQuietNotify, checkAuth, onAuthenticated, logout, refreshAssets, syncPlugins, refreshNodes, loadConversationDetail, loadEarlierEntries, backfillConversationEntry, loadConversationArtifacts, ensurePluginDoc, getPluginSessionDoc, openTarget, closeSplit, setFocusedPanel, setSidebarCollapsed, toggleSidebarCollapsed, setScreenParams, setWorkbenchOpen, setWorkbenchTab, openSpace, setActiveModal, dismissNotice, pushNotice, invokePluginAction,
    ],
  )
  useEffect(() => {
    // 宿主共享运行时：
    // - __HELM_SHARED__：具名句柄（调试/未来消费者）；
    // - __helm_shared_* 命名空间：插件 client.tsx 编译产物把共享依赖（react 等）
    //   与 '@helm/plugin-client' 虚拟化为这些全局命名空间，运行时取得同一份
    //   React/lucide/宿主 hooks 实例，绝不打包第二份 React。
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
  // 宿主端口：SDK（@helm/plugin-client）钩子与委托组件经此注入真实 store 能力。
  // 端口对象随 store 快照重建（与 store 同一 SSE 节奏）；钩子内部仅依赖稳定具名函数。
  const pluginClientPort = useMemo(() => createPluginClientHostPort(store), [store])
  return (
    <HelmStoreContext.Provider value={store}>
      <PluginClientHostContext.Provider value={pluginClientPort}>{children}</PluginClientHostContext.Provider>
    </HelmStoreContext.Provider>
  )
}
