import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActionManifest, ArtifactMetadata, ConversationDetail, HelmEventFrame, HelmSnapshot, Profile, ProviderConfig, SkillSummary } from '@helm/protocol'
import { ApiClientError, assetsApi, authApi, conversationsApi, getStoredToken, pluginsApi, setStoredToken, workflowsApi, type CredentialStatus, type ModelDescriptor, type SavedWorkflowSummary } from './api.js'
import { applyEventFrame, applySnapshot, emptyLiveState, entryMatchesReference, mergeConversationDetail, SseParser, type LiveState } from './live-state.js'
import { HelmStoreContext, useHelmStore, usePluginDoc } from './store-context.js'
import { groupUiContributions, resolveTargetString, type ActiveModal, type HelmStoreValue, type ResolvedTarget, type ThemeMode, type ThemePreference, type ToastNotice } from './types.js'

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
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
  const [credentials, setCredentials] = useState<CredentialStatus[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [actions, setActions] = useState<ActionManifest[]>([])
  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflowSummary[]>([])
  const [primaryTarget, setPrimaryTarget] = useState<ResolvedTarget>({ kind: 'conversation', conversationId: 1 })
  const [splitTarget, setSplitTarget] = useState<ResolvedTarget | null>(null)
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [workbenchTab, setWorkbenchTab] = useState('tasks')
  const [activeModal, setActiveModal] = useState<ActiveModal>(null)
  const [highlightedEntry, setHighlightedEntry] = useState<{ conversationId: number; entryId: string } | null>(null)
  const [notices, setNotices] = useState<ToastNotice[]>([])
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
    const id = crypto.randomUUID()
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
    setStoredToken(null)
    setAuthenticated(false)
    setSseConnected(false)
    setActiveModal(null)
    setSplitTarget(null)
    setPrimaryTarget({ kind: 'conversation', conversationId: 1 })
    updateLive(emptyLiveState)
    setConversationArtifacts({})
    setLoadErrors({})
    setProfiles([]); setModels([]); setProviders([]); setCredentials([]); setSkills([]); setActions([]); setSavedWorkflows([])
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
    const results = await Promise.allSettled([assetsApi.listProfiles(), assetsApi.listModels(), assetsApi.listProviders(), assetsApi.listCredentials(), assetsApi.listSkills(), pluginsApi.listActions(), workflowsApi.listSaved()])
    if (generation !== assetGeneration.current) return
    if (results[0].status === 'fulfilled') setProfiles(results[0].value)
    if (results[1].status === 'fulfilled') setModels(results[1].value)
    if (results[2].status === 'fulfilled') setProviders(results[2].value)
    if (results[3].status === 'fulfilled') setCredentials(results[3].value)
    if (results[4].status === 'fulfilled') setSkills(results[4].value)
    if (results[5].status === 'fulfilled') setActions(results[5].value)
    if (results[6].status === 'fulfilled') setSavedWorkflows(results[6].value)
    const labels = ['角色', '模型', '网关', '凭据', '技能', '插件动作', '工作流']
    results.forEach((result, index) => {
      if (result.status === 'rejected') pushNotice({ type: 'notification', level: 'error', title: `${labels[index]}加载失败`, body: errorText(result.reason) })
    })
  }, [pushNotice])
  useEffect(() => { if (authenticated) void refreshAssets() }, [authenticated, refreshAssets])

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
  const invokePluginAction = useCallback(async (pluginId: string, actionId: string, input: unknown, conversationId?: number) => pluginsApi.invokeAction(pluginId, actionId, input, conversationId), [])

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
              void refreshAssets()
            }
            if (event.type === 'conversation.upsert' && 'conversation' in event) {
              const conv = event.conversation
              const visible = [targets.current.primaryTarget, targets.current.splitTarget].some((target) => target?.kind === 'conversation' && target.conversationId === conv.id)
              if (visible && conv.status !== 'working') void loadConversationArtifacts(conv.id)
              if (visible && conv.unread) void conversationsApi.patch(conv.id, { unread: false }).catch((error: unknown) => reportLoad(`conversation:${conv.id}`, error))
            }
            if (event.type === 'conversation.deleted' && 'conversationId' in event) {
              const id = event.conversationId
              setPrimaryTarget((current) => current.kind === 'conversation' && current.conversationId === id ? { kind: 'conversation', conversationId: 1 } : current)
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
  const store: HelmStoreValue = {
    ...live, authReady, authConfigured, authenticated, authError, connectionError, loadErrors, sseConnected, theme, themePreference, conversationArtifacts,
    groupedUi, savedWorkflows, profiles, models, providers, credentials, skills, actions, primaryTarget, splitTarget, workbenchOpen, workbenchTab, activeModal, highlightedEntry, notices,
    setTheme, setThemePreference, toggleTheme, checkAuth, onAuthenticated, logout, refreshAssets, loadConversationDetail, loadEarlierEntries, loadConversationArtifacts, ensurePluginDoc, openTarget, closeSplit, setWorkbenchOpen, setWorkbenchTab, setActiveModal, dismissNotice, pushNotice, invokePluginAction,
  }
  useEffect(() => {
    const shared = { React, useHelmStore, usePluginDoc }
    ;(window as unknown as Record<string, unknown>).__HELM_SHARED__ = shared
    return () => { delete (window as unknown as Record<string, unknown>).__HELM_SHARED__ }
  }, [])
  return <HelmStoreContext.Provider value={store}>{children}</HelmStoreContext.Provider>
}
