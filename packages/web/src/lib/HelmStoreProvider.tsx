import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as LucideReact from 'lucide-react'
import type { ActionManifest, ArtifactMetadata, ConversationDetail, HelmEventFrame, HelmSnapshot, Profile, ProviderConfig, SkillSummary } from '@helm/protocol'
import { ROOT_CONVERSATION_ID } from '@helm/protocol'
import { ApiClientError, assetsApi, authApi, conversationsApi, getStoredToken, nodesApi, pluginsApi, setStoredToken, type CredentialSummary, type ModelDescriptor, type NodeInfo } from './api.js'
import { applyEventFrame, applySnapshot, emptyLiveState, entryMatchesReference, mergeConversationDetail, sortNodes, SseParser, type LiveState } from './live-state.js'
import { HelmStoreContext, useHelmStore, usePluginDoc } from './store-context.js'
import { evictPluginClientCache, resetPluginClientCache } from './plugin-client.js'
import * as HelmPluginClient from './plugin-client-context.js'
import { formatLocationHash, isSameLocationState, parseLocationHash, shouldPushLocationHistory, type WorkspaceLocationState } from './url-hash-model.js'
import { groupUiContributions, isPrototypeParamKey, resolveTargetString, SCREEN_PARAM_KEY_PATTERN, type ActiveModal, type HelmStoreValue, type ResolvedTarget, type ThemeMode, type ThemePreference, type ToastNotice } from './types.js'
import { errorText } from './format.js'

const getStoredPreference = (): ThemePreference => {
  try {
    const saved = localStorage.getItem('helm:theme')
    if (saved === 'light' || saved === 'dark') return saved
    return 'system'
  } catch {
    return 'system'
  }
}
const getSystemTheme = (): ThemeMode =>
  typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

const resolveTheme = (pref: ThemePreference): ThemeMode =>
  pref === 'system' ? getSystemTheme() : pref

export function HelmStoreProvider({ children }: { children: React.ReactNode }) {
  const [authReady, setAuthReady] = useState(false)
  const [authConfigured, setAuthConfigured] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [sseConnected, setSseConnected] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(getStoredPreference)
  const [theme, setThemeState] = useState<ThemeMode>(() => resolveTheme(getStoredPreference()))
  const [live, setLive] = useState<LiveState>(emptyLiveState)
  const liveRef = useRef(live)
  const [conversationArtifacts, setConversationArtifacts] = useState<Record<number, ArtifactMetadata[]>>({})
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [actions, setActions] = useState<ActionManifest[]>([])
  // 初始工作台位置取自地址栏 Hash：刷新、复制链接直达与前进/后退都以它为唯一事实来源。
  const [initialLocation] = useState<WorkspaceLocationState>(() => parseLocationHash(typeof window !== 'undefined' ? window.location.hash : ''))
  const [primaryTarget, setPrimaryTarget] = useState<ResolvedTarget>(initialLocation.primaryTarget)
  const [splitTarget, setSplitTarget] = useState<ResolvedTarget | null>(initialLocation.splitTarget)
  const [workbenchOpen, setWorkbenchOpen] = useState(initialLocation.workbenchOpen)
  const [workbenchTab, setWorkbenchTab] = useState(initialLocation.workbenchTab)
  const [activeModal, setActiveModal] = useState<ActiveModal>(initialLocation.activeModal)
  // 最近一次与地址栏达成一致的位置：既是外部 Hash 变更的判重基准，也是 push/replace 决策的 prev。
  const lastSyncedLocation = useRef<WorkspaceLocationState>(initialLocation)
  const [highlightedEntry, setHighlightedEntry] = useState<{ conversationId: number; entryId: string } | null>(null)
  const [notices, setNotices] = useState<ToastNotice[]>([])
  const noticeSequence = useRef(0)
  const session = useRef(0)
  const requests = useRef(new Map<string, Promise<unknown>>())
  const failedDocs = useRef(new Set<string>())
  const pluginEpoch = useRef(new Map<string, number>())
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const targets = useRef({ primaryTarget, splitTarget })
  targets.current = { primaryTarget, splitTarget }
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
  useEffect(() => () => { session.current++; for (const timer of timers.current) clearTimeout(timer) }, [])

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

  const setThemePreference = useCallback((pref: ThemePreference) => {
    setThemePreferenceState(pref)
    const effective = resolveTheme(pref)
    setThemeState(effective)
    document.documentElement.dataset.theme = effective
    try {
      if (pref === 'system') {
        localStorage.removeItem('helm:theme')
      } else {
        localStorage.setItem('helm:theme', pref)
      }
    } catch { /* 内存主题仍可使用。 */ }
  }, [])
  const setTheme = useCallback((next: ThemeMode) => setThemePreference(next), [setThemePreference])
  const toggleTheme = useCallback(() => {
    setThemePreferenceState((prev) => {
      const next: ThemePreference = prev === 'system' ? 'light' : prev === 'light' ? 'dark' : 'system'
      const effective = resolveTheme(next)
      setThemeState(effective)
      document.documentElement.dataset.theme = effective
      try {
        if (next === 'system') {
          localStorage.removeItem('helm:theme')
        } else {
          localStorage.setItem('helm:theme', next)
        }
      } catch { /* 内存主题仍可使用。 */ }
      return next
    })
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      if (themePreference === 'system') {
        const next: ThemeMode = e.matches ? 'dark' : 'light'
        setThemeState(next)
        document.documentElement.dataset.theme = next
      }
    }
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [themePreference])

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
    assetGeneration.current++
    resetPluginClientCache()
    setStoredToken(null)
    setAuthenticated(false)
    setSseConnected(false)
    setActiveModal(null)
    setSplitTarget(null)
    setPrimaryTarget({ kind: 'conversation', conversationId: ROOT_CONVERSATION_ID })
    setWorkbenchOpen(false)
    setWorkbenchTab('artifacts')
    // 地址栏同步复位为默认深链（replaceState 不污染历史栈）；未认证期间禁用写回，避免覆盖用户粘贴的深链。
    lastSyncedLocation.current = parseLocationHash('#/c/1')
    window.history.replaceState(null, '', '#/c/1')
    updateLive(emptyLiveState)
    setConversationArtifacts({})
    setLoadErrors({})
    setProfiles([]); setModels([]); setProviders([]); setCredentials([]); setSkills([]); setActions([])
  }, [updateLive])
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
    const labels = ['角色', '模型', '网关', '凭据', '技能', '插件动作']
    results.forEach((result, index) => {
      if (result.status === 'rejected') pushNotice({ type: 'notification', level: 'error', title: `${labels[index]}加载失败`, body: errorText(result.reason) })
    })
  }, [pushNotice])
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

  const openTarget = useCallback((target: string | ResolvedTarget, opts?: { split?: boolean; highlightEntryId?: string }) => {
    const resolved = typeof target === 'string' ? resolveTargetString(target, liveRef.current.conversations) : target
    if (!resolved) {
      pushNotice({ type: 'notification', level: 'warning', title: '目标未就绪', body: typeof target === 'string' ? target : '导航目标无效' })
      return
    }
    if (opts?.split) setSplitTarget(resolved)
    else setPrimaryTarget(resolved)
    if (resolved.kind === 'conversation' && opts?.highlightEntryId) setHighlightedEntry({ conversationId: resolved.conversationId, entryId: opts.highlightEntryId })
  }, [pushNotice])
  const closeSplit = useCallback(() => setSplitTarget(null), [])

  // ---- Screen 路由参数更新（唯一导航机制内实现，组件不得直接操作 history） ----
  // setParams(..., { push: true }) 只标记下一拍强制 push；实际 pushState 仍由
  // 唯一的地址栏写回 effect 执行，保证与既有导航共用同一套同步与判重路径。
  const pendingForcePush = useRef(false)
  const setScreenParams = useCallback((patch: Record<string, string | undefined>, options?: { split?: boolean; push?: boolean }) => {
    if (options?.push) pendingForcePush.current = true
    const update = (current: ResolvedTarget): ResolvedTarget => {
      if (current.kind !== 'screen') return current
      const next: Record<string, string> = { ...(current.params ?? {}) }
      for (const [rawKey, rawValue] of Object.entries(patch)) {
        if (!SCREEN_PARAM_KEY_PATTERN.test(rawKey) || isPrototypeParamKey(rawKey)) {
          // 边界处拒绝非法键：显式告警而非静默丢弃，防止筛选器状态假象。
          pushNotice({ type: 'notification', level: 'warning', title: '已忽略非法 Screen 参数键', body: `参数键 ${rawKey} 仅允许字母、数字、点、下划线与连字符` })
          continue
        }
        if (rawValue === undefined) delete next[rawKey]
        else if (rawValue !== '') next[rawKey] = rawValue
      }
      const params = Object.keys(next).length === 0 ? undefined : next
      return params === undefined
        ? { kind: 'screen', pluginId: current.pluginId, screenId: current.screenId }
        : { kind: 'screen', pluginId: current.pluginId, screenId: current.screenId, params }
    }
    if (options?.split) setSplitTarget((current) => (current === null ? current : update(current)))
    else setPrimaryTarget(update)
  }, [pushNotice])
  const invokePluginAction = useCallback(async (pluginId: string, actionId: string, input: unknown, conversationId?: number) => pluginsApi.invokeAction(pluginId, actionId, input, conversationId), [])

  // ---- 地址栏 Hash 双向同步 --------------------------------------------------
  // 外部变更（前进/后退/手动改 Hash）：解析后覆盖本地状态。pushState/replaceState
  // 不会触发这两个事件，因此自身写回不会形成回环；与最近同步位置相同的事件是回声，忽略。
  useEffect(() => {
    const applyUrlLocation = () => {
      const parsed = parseLocationHash(window.location.hash)
      if (isSameLocationState(parsed, lastSyncedLocation.current)) return
      lastSyncedLocation.current = parsed
      setPrimaryTarget(parsed.primaryTarget)
      setSplitTarget(parsed.splitTarget)
      setWorkbenchOpen(parsed.workbenchOpen)
      setWorkbenchTab(parsed.workbenchTab)
      setActiveModal(parsed.activeModal)
    }
    window.addEventListener('hashchange', applyUrlLocation)
    window.addEventListener('popstate', applyUrlLocation)
    return () => {
      window.removeEventListener('hashchange', applyUrlLocation)
      window.removeEventListener('popstate', applyUrlLocation)
    }
  }, [])

  // 状态写回地址栏：仅在已认证后进行（AuthGate 阶段保留用户粘贴的深链 Hash）。
  // 视图级变化（主屏/分屏/弹窗开关）push 入栈，列表内选子项/切 Tab 用 replace 折叠历史。
  const locationState = useMemo<WorkspaceLocationState>(
    () => ({ primaryTarget, splitTarget, workbenchOpen, workbenchTab, activeModal }),
    [primaryTarget, splitTarget, workbenchOpen, workbenchTab, activeModal],
  )
  useEffect(() => {
    if (!authenticated) return
    const nextHash = formatLocationHash(locationState)
    if (nextHash === window.location.hash) {
      lastSyncedLocation.current = locationState
      pendingForcePush.current = false
      return
    }
    if (pendingForcePush.current || shouldPushLocationHistory(lastSyncedLocation.current, locationState)) {
      window.history.pushState(null, '', nextHash)
    } else {
      window.history.replaceState(null, '', nextHash)
    }
    pendingForcePush.current = false
    lastSyncedLocation.current = locationState
  }, [authenticated, locationState])

  useEffect(() => {
    if (!authenticated) return
    const visible = [primaryTarget, splitTarget].filter((target): target is { kind: 'conversation'; conversationId: number } => target?.kind === 'conversation')
    for (const id of new Set(visible.map((target) => target.conversationId))) {
      void loadConversationDetail(id)
      void loadConversationArtifacts(id)
      const summary = liveRef.current.conversations.find((conv) => conv.id === id)
      if (summary?.unread) void conversationsApi.patch(id, { unread: false }).catch((error: unknown) => pushNotice({ type: 'notification', level: 'error', title: '标记已读失败', body: errorText(error) }))
    }
  }, [authenticated, primaryTarget, splitTarget, loadConversationDetail, loadConversationArtifacts, pushNotice])

  // 命中老消息时逐页取历史，直至 entry 可见或游标耗尽。
  useEffect(() => {
    if (!highlightedEntry) return
    const detail = live.conversationDetails[highlightedEntry.conversationId]
    if (!detail) return
    const matched = detail.entries.find((entry) => entryMatchesReference(entry, highlightedEntry.entryId))
    if (matched) {
      if (matched.id !== highlightedEntry.entryId) {
        setHighlightedEntry({ ...highlightedEntry, entryId: matched.id })
        return
      }
      delay(() => setHighlightedEntry((current) => current === highlightedEntry ? null : current), 5000)
    } else if (detail.nextCursor && !loadErrors[`history:${detail.id}`]) {
      void loadEarlierEntries(detail.id)
    } else if (!detail.nextCursor) {
      pushNotice({ type: 'notification', level: 'warning', title: '搜索条目已不在会话历史中', conversationId: detail.id })
      setHighlightedEntry(null)
    }
  }, [highlightedEntry, live.conversationDetails, loadEarlierEntries, loadErrors, delay, pushNotice])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setActiveModal((current) => current?.kind === 'command-palette' ? null : { kind: 'command-palette' })
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])

  useEffect(() => {
    if (!authenticated) return
    let active = true, retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const connect = async (): Promise<void> => {
      controller = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const token = getStoredToken()
        const response = await fetch('/api/events', { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal })
        if (response.status === 401) { logout(); return }
        if (!response.ok || !response.body) throw new Error(`实时连接失败（HTTP ${response.status}）`)
        let gotSnapshot = false
        const parser = new SseParser((message) => {
          const payload: unknown = JSON.parse(message.data)
          if (message.event === 'snapshot') {
            session.current++
            requests.current.clear()
            failedDocs.current.clear()
            // 断线期间可能发生停用/升级：旧模块与在途下载不能跨快照复活。
            resetPluginClientCache()
            setLoadErrors({})
            updateLive((state) => applySnapshot(state, payload as HelmSnapshot))
            setConversationArtifacts({})
            gotSnapshot = true
            retry = 0
            setSseConnected(true)
            setConnectionError(null)
            for (const target of [targets.current.primaryTarget, targets.current.splitTarget]) {
              if (target?.kind === 'conversation') { void loadConversationDetail(target.conversationId, true); void loadConversationArtifacts(target.conversationId) }
            }
          } else {
            if (!gotSnapshot) throw new Error('实时连接缺少初始快照')
            const frame = payload as HelmEventFrame
            const oldSeq = liveRef.current.seq
            updateLive((state) => applyEventFrame(state, frame))
            if (frame.seq <= oldSeq) return
            const event = frame.event
            if (event.type === 'notification' && 'title' in event) pushNotice(event)
            if (event.type === 'plugin.changed' && 'plugin' in event) {
              pluginEpoch.current.set(event.plugin.id, (pluginEpoch.current.get(event.plugin.id) ?? 0) + 1)
              for (const key of requests.current.keys()) if (key.startsWith(`doc:${event.plugin.id}/`)) requests.current.delete(key)
              failedDocs.current.clear()
              // 插件停用/卸载（ui 贡献移除）时同步释放其 client 模块缓存
              if (!event.plugin.enabled) evictPluginClientCache(event.plugin.id)
              void refreshAssets()
            }
            if (event.type === 'models.changed') void refreshAssets()
            if (event.type === 'conversation.upsert' && 'conversation' in event) {
              const conv = event.conversation
              const visible = [targets.current.primaryTarget, targets.current.splitTarget].some((target) => target?.kind === 'conversation' && target.conversationId === conv.id)
              if (visible && conv.status !== 'working') void loadConversationArtifacts(conv.id)
              if (visible && conv.unread) void conversationsApi.patch(conv.id, { unread: false }).catch((error: unknown) => reportLoad(`conversation:${conv.id}`, error))
            }
            if (event.type === 'conversation.deleted' && 'conversationId' in event) {
              const id = event.conversationId
              setPrimaryTarget((current) => current.kind === 'conversation' && current.conversationId === id ? { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID } : current)
              setSplitTarget((current) => current?.kind === 'conversation' && current.conversationId === id ? null : current)
              setConversationArtifacts((prev) => { const next = { ...prev }; delete next[id]; return next })
            }
          }
        })
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        while (active) {
          const chunk = await reader.read()
          if (chunk.done) break
          if (!active) return
          parser.push(decoder.decode(chunk.value, { stream: true }))
        }
        if (active) throw new Error('实时连接已断开，正在重新同步')
      } catch (error) {
        if (active && !controller.signal.aborted) setConnectionError(errorText(error))
      } finally {
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
        if (active) {
          setSseConnected(false)
          timer = setTimeout(() => { void connect() }, Math.min(1000 * 2 ** retry++, 10000))
        }
      }
    }
    void connect()
    return () => { active = false; if (timer) clearTimeout(timer); controller?.abort() }
  }, [authenticated, logout, loadConversationDetail, loadConversationArtifacts, reportLoad, pushNotice, refreshAssets, updateLive])

  const groupedUi = useMemo(() => groupUiContributions(live.uiContributions), [live.uiContributions])
  // Context value 需引用稳定：任何一处局部状态变化都不应触发全量消费组件重渲染。
  const store: HelmStoreValue = useMemo(
    () => ({
      ...live, authReady, authConfigured, authenticated, authError, connectionError, loadErrors, sseConnected, theme, themePreference, conversationArtifacts,
      groupedUi, profiles, models, providers, credentials, skills, actions, primaryTarget, splitTarget, workbenchOpen, workbenchTab, activeModal, highlightedEntry, notices,
      setTheme, setThemePreference, toggleTheme, checkAuth, onAuthenticated, logout, refreshAssets, refreshNodes, loadConversationDetail, loadEarlierEntries, loadConversationArtifacts, ensurePluginDoc, openTarget, closeSplit, setScreenParams, setWorkbenchOpen, setWorkbenchTab, setActiveModal, dismissNotice, pushNotice, invokePluginAction,
    }),
    [
      live, authReady, authConfigured, authenticated, authError, connectionError, loadErrors, sseConnected, theme, themePreference, conversationArtifacts,
      groupedUi, profiles, models, providers, credentials, skills, actions, primaryTarget, splitTarget, workbenchOpen, workbenchTab, activeModal, highlightedEntry, notices,
      setTheme, setThemePreference, toggleTheme, checkAuth, onAuthenticated, logout, refreshAssets, refreshNodes, loadConversationDetail, loadEarlierEntries, loadConversationArtifacts, ensurePluginDoc, openTarget, closeSplit, setScreenParams, setWorkbenchOpen, setWorkbenchTab, setActiveModal, dismissNotice, pushNotice, invokePluginAction,
    ],
  )
  useEffect(() => {
    // 宿主共享运行时：
    // - __HELM_SHARED__：具名句柄（调试/未来消费者）；
    // - __helm_shared_* 命名空间：插件 client.tsx 编译产物把共享依赖（react 等）
    //   与 '@helm/plugin-client' 虚拟化为这些全局命名空间，运行时取得同一份
    //   React/lucide/宿主 hooks 实例，绝不打包第二份 React。
    const w = window as unknown as Record<string, unknown>
    w.__HELM_SHARED__ = { React, useHelmStore, usePluginDoc }
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
  return <HelmStoreContext.Provider value={store}>{children}</HelmStoreContext.Provider>
}
