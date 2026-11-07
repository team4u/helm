import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ROOT_CONVERSATION_ID,
  type ActionManifest,
  type ArtifactMetadata,
  type AskResolvedEvent,
  type AskSpec,
  type AskUpsertEvent,
  type ConversationDeletedEvent,
  type ConversationDetail,
  type ConversationEntryEvent,
  type ConversationLive,
  type ConversationLiveEvent,
  type ConversationSummary,
  type ConversationUpsertEvent,
  type HelmEvent,
  type HelmEventFrame,
  type HelmSnapshot,
  type NotificationEvent,
  type PluginChangedEvent,
  type PluginDocUpdatedEvent,
  type PluginSummary,
  type PluginUiContribution,
  type Profile,
  type ProviderConfig,
  type SkillSummary,
  type WorkflowRunSummary,
  type WorkflowUpdatedEvent,
} from '@helm/protocol'
import {
  assetsApi,
  authApi,
  conversationsApi,
  getStoredToken,
  pluginsApi,
  setStoredToken,
  workflowsApi,
  type CredentialStatus,
  type ModelDescriptor,
  type SavedWorkflowSummary,
} from './api.js'
import { HelmStoreContext, useHelmStore, usePluginDoc } from './store-context.js'
import {
  groupUiContributions,
  resolveTargetString,
  type ActiveModal,
  type HelmStoreValue,
  type ResolvedTarget,
  type ThemeMode,
  type ToastNotice,
} from './types.js'

function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem('helm:theme')
    return saved === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function sortConversations(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort((a, b) => {
    if (a.id === ROOT_CONVERSATION_ID) return -1
    if (b.id === ROOT_CONVERSATION_ID) return 1
    return b.updatedAt - a.updatedAt
  })
}

export function HelmStoreProvider({ children }: { children: React.ReactNode }) {
  const [authReady, setAuthReady] = useState(false)
  const [authConfigured, setAuthConfigured] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [sseConnected, setSseConnected] = useState(false)
  const [theme, setThemeState] = useState<ThemeMode>(getInitialTheme)

  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationDetails, setConversationDetails] = useState<Record<number, ConversationDetail>>({})
  const [conversationLives, setConversationLives] = useState<Record<number, ConversationLive>>({})
  const [conversationArtifacts, setConversationArtifacts] = useState<Record<number, ArtifactMetadata[]>>({})
  const [pendingAsks, setPendingAsks] = useState<AskSpec[]>([])
  const [resolvedAsksByConv, setResolvedAsksByConv] = useState<
    Record<number, Array<{ ask: AskSpec; status: 'answered' | 'cancelled' | 'superseded' }>>
  >({})
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [uiContributions, setUiContributions] = useState<PluginUiContribution[]>([])
  const [pluginDocs, setPluginDocs] = useState<Record<string, unknown>>({})
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSummary[]>([])
  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflowSummary[]>([])

  const [profiles, setProfiles] = useState<Profile[]>([])
  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [credentials, setCredentials] = useState<CredentialStatus[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [actions, setActions] = useState<ActionManifest[]>([])

  const [primaryTarget, setPrimaryTarget] = useState<ResolvedTarget>({
    kind: 'conversation',
    conversationId: ROOT_CONVERSATION_ID,
  })
  const [splitTarget, setSplitTarget] = useState<ResolvedTarget | null>(null)
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [workbenchTab, setWorkbenchTab] = useState('tasks')
  const [activeModal, setActiveModal] = useState<ActiveModal>(null)
  const [highlightedEntry, setHighlightedEntry] = useState<{ conversationId: number; entryId: string } | null>(null)
  const [notices, setNotices] = useState<ToastNotice[]>([])

  const pendingAsksRef = useRef<AskSpec[]>([])
  pendingAsksRef.current = pendingAsks

  const conversationsRef = useRef<ConversationSummary[]>([])
  conversationsRef.current = conversations

  const inFlightDocFetches = useRef<Set<string>>(new Set())

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next)
    try {
      localStorage.setItem('helm:theme', next)
    } catch {
      // ignore
    }
    document.documentElement.setAttribute('data-theme', next)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }, [theme, setTheme])

  const dismissNotice = useCallback((id: string) => {
    setNotices((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const pushNotice = useCallback(
    (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => {
      const id = `notice_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const item: ToastNotice = { ...notice, id, createdAt: Date.now() }
      setNotices((prev) => [item, ...prev].slice(0, 6))
      setTimeout(() => dismissNotice(id), 6_000)
    },
    [dismissNotice],
  )

  const refreshAssets = useCallback(async () => {
    const results = await Promise.allSettled([
      assetsApi.listProfiles(),
      assetsApi.listModels(),
      assetsApi.listProviders(),
      assetsApi.listCredentials(),
      assetsApi.listSkills(),
      pluginsApi.listActions(),
      workflowsApi.listSaved(),
    ])
    if (results[0].status === 'fulfilled') setProfiles(results[0].value)
    if (results[1].status === 'fulfilled') setModels(results[1].value)
    if (results[2].status === 'fulfilled') setProviders(results[2].value)
    if (results[3].status === 'fulfilled') setCredentials(results[3].value)
    if (results[4].status === 'fulfilled') setSkills(results[4].value)
    if (results[5].status === 'fulfilled') setActions(results[5].value)
    if (results[6].status === 'fulfilled') setSavedWorkflows(results[6].value)
  }, [])

  const loadConversationDetail = useCallback(
    async (conversationId: number, force = false): Promise<ConversationDetail | undefined> => {
      try {
        const detail = await conversationsApi.getDetail(conversationId, { limit: 150 })
        setConversationDetails((prev) => {
          if (!force && prev[conversationId] && detail.entries.length === 0 && prev[conversationId].entries.length > 0) {
            return prev
          }
          return { ...prev, [conversationId]: detail }
        })
        return detail
      } catch {
        return undefined
      }
    },
    [],
  )

  const loadConversationArtifacts = useCallback(async (conversationId: number): Promise<ArtifactMetadata[]> => {
    try {
      const list = await conversationsApi.listArtifacts(conversationId)
      setConversationArtifacts((prev) => ({ ...prev, [conversationId]: list }))
      return list
    } catch {
      return []
    }
  }, [])

  const ensurePluginDoc = useCallback(async (pluginId: string, docName: string): Promise<unknown> => {
    const key = `${pluginId}/${docName}`
    if (inFlightDocFetches.current.has(key)) return undefined
    inFlightDocFetches.current.add(key)
    try {
      const res = await pluginsApi.getPublicDoc(pluginId, docName)
      setPluginDocs((prev) => ({ ...prev, [key]: res.value }))
      return res.value
    } catch {
      return undefined
    } finally {
      inFlightDocFetches.current.delete(key)
    }
  }, [])

  const openTarget = useCallback(
    (target: string | ResolvedTarget, opts?: { split?: boolean; highlightEntryId?: string }) => {
      const resolved = typeof target === 'string' ? resolveTargetString(target, conversationsRef.current) : target
      if (!resolved) {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: '目标未就绪',
          body: typeof target === 'string' ? `未找到匹配目标: ${target}` : '目标无效',
        })
        return
      }
      if (opts?.split) {
        setSplitTarget(resolved)
      } else {
        setPrimaryTarget(resolved)
      }
      if (resolved.kind === 'conversation') {
        void loadConversationDetail(resolved.conversationId)
        void loadConversationArtifacts(resolved.conversationId)
        if (opts?.highlightEntryId) {
          setHighlightedEntry({ conversationId: resolved.conversationId, entryId: opts.highlightEntryId })
          setTimeout(() => {
            setHighlightedEntry((curr) =>
              curr?.entryId === opts.highlightEntryId ? null : curr,
            )
          }, 2600)
        }
      }
    },
    [loadConversationDetail, loadConversationArtifacts, pushNotice],
  )

  const closeSplit = useCallback(() => {
    setSplitTarget(null)
  }, [])

  const invokePluginAction = useCallback(
    async (pluginId: string, actionId: string, input: unknown, conversationId?: number): Promise<unknown> => {
      const result = await pluginsApi.invokeAction(pluginId, actionId, input, conversationId)
      void refreshAssets()
      return result
    },
    [refreshAssets],
  )

  const onAuthenticated = useCallback(
    async (token: string) => {
      setStoredToken(token)
      setAuthConfigured(true)
      setAuthenticated(true)
      await refreshAssets()
    },
    [refreshAssets],
  )

  const logout = useCallback(() => {
    setStoredToken(null)
    setAuthenticated(false)
    setSseConnected(false)
  }, [])

  // 初始检查 Auth 状态
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const st = await authApi.status()
        if (cancelled) return
        setAuthConfigured(st.configured)
        setAuthenticated(st.authenticated)
        setAuthReady(true)
        if (st.authenticated) {
          void refreshAssets()
        }
      } catch {
        if (!cancelled) setAuthReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshAssets])

  // 当主屏或副屏切换到某个会话时，自动确保加载该会话的详情与产物
  useEffect(() => {
    if (!authenticated) return
    if (primaryTarget.kind === 'conversation') {
      void loadConversationDetail(primaryTarget.conversationId)
      void loadConversationArtifacts(primaryTarget.conversationId)
    }
  }, [authenticated, primaryTarget, loadConversationDetail, loadConversationArtifacts])

  useEffect(() => {
    if (!authenticated || !splitTarget) return
    if (splitTarget.kind === 'conversation') {
      void loadConversationDetail(splitTarget.conversationId)
      void loadConversationArtifacts(splitTarget.conversationId)
    }
  }, [authenticated, splitTarget, loadConversationDetail, loadConversationArtifacts])

  // 全局快捷键：⌘K / Ctrl+K 打开命令面板，Esc 关闭顶层弹窗
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setActiveModal((curr) => (curr?.kind === 'command-palette' ? null : { kind: 'command-palette' }))
      } else if (e.key === 'Escape') {
        setActiveModal((curr) => (curr !== null ? null : curr))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // SSE 实时流连接与重连
  useEffect(() => {
    if (!authenticated) return
    let active = true
    let abortCtrl: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const handleSnapshot = (snap: HelmSnapshot) => {
      setConversations(sortConversations(snap.conversations ?? []))
      setPendingAsks(snap.pendingAsks ?? [])
      setPlugins(snap.plugins ?? [])
      setUiContributions(snap.ui ?? [])
      setWorkflowRuns(snap.workflowRuns ?? [])
    }

    const handleEvent = (ev: HelmEvent) => {
      switch (ev.type) {
        case 'conversation.upsert': {
          const conv = (ev as ConversationUpsertEvent).conversation
          setConversations((prev) => {
            const idx = prev.findIndex((c) => c.id === conv.id)
            if (idx === -1) return sortConversations([conv, ...prev])
            const next = [...prev]
            next[idx] = conv
            return sortConversations(next)
          })
          setConversationDetails((prev) => {
            const existing = prev[conv.id]
            if (!existing) return prev
            return { ...prev, [conv.id]: { ...existing, ...conv } }
          })
          if (conv.status !== 'working') {
            setConversationLives((prev) => {
              if (!(conv.id in prev)) return prev
              const next = { ...prev }
              delete next[conv.id]
              return next
            })
            void loadConversationArtifacts(conv.id)
          }
          break
        }
        case 'conversation.deleted': {
          const deletedId = (ev as ConversationDeletedEvent).conversationId
          setConversations((prev) => prev.filter((c) => c.id !== deletedId))
          setConversationDetails((prev) => {
            const next = { ...prev }
            delete next[deletedId]
            return next
          })
          setPrimaryTarget((curr) =>
            curr.kind === 'conversation' && curr.conversationId === deletedId
              ? { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID }
              : curr,
          )
          setSplitTarget((curr) =>
            curr && curr.kind === 'conversation' && curr.conversationId === deletedId ? null : curr,
          )
          break
        }
        case 'conversation.entry': {
          const { conversationId, entry } = ev as ConversationEntryEvent
          setConversationDetails((prev) => {
            const detail = prev[conversationId]
            if (!detail) return prev
            const exists = detail.entries.some((e) => e.id === entry.id)
            const entries = exists
              ? detail.entries.map((e) => (e.id === entry.id ? entry : e))
              : [...detail.entries, entry]
            return { ...prev, [conversationId]: { ...detail, entries } }
          })
          break
        }
        case 'conversation.live': {
          const { live } = ev as ConversationLiveEvent
          setConversationLives((prev) => ({ ...prev, [live.conversationId]: live }))
          break
        }
        case 'ask.upsert': {
          const { ask } = ev as AskUpsertEvent
          setPendingAsks((prev) => {
            const rest = prev.filter((a) => a.id !== ask.id)
            return ask.status === 'pending' ? [...rest, ask] : rest
          })
          break
        }
        case 'ask.resolved': {
          const resolvedEv = ev as AskResolvedEvent
          const matched = pendingAsksRef.current.find((a) => a.id === resolvedEv.askId)
          setPendingAsks((prev) => prev.filter((a) => a.id !== resolvedEv.askId))
          if (matched) {
            setResolvedAsksByConv((prev) => {
              const list = prev[matched.conversationId] ?? []
              if (list.some((item) => item.ask.id === matched.id)) return prev
              return {
                ...prev,
                [matched.conversationId]: [...list, { ask: matched, status: resolvedEv.status }],
              }
            })
          }
          break
        }
        case 'plugin.changed': {
          const { plugin, ui } = ev as PluginChangedEvent
          setPlugins((prev) => {
            const idx = prev.findIndex((p) => p.id === plugin.id)
            if (idx === -1) return [...prev, plugin]
            const next = [...prev]
            next[idx] = plugin
            return next
          })
          setUiContributions((prev) => [
            ...prev.filter((u) => u.pluginId !== plugin.id),
            ...(ui ?? []),
          ])
          void refreshAssets()
          break
        }
        case 'plugin.doc.updated': {
          const { doc } = ev as PluginDocUpdatedEvent
          setPluginDocs((prev) => ({
            ...prev,
            [`${doc.pluginId}/${doc.name}`]: doc.value,
          }))
          break
        }
        case 'workflow.updated': {
          const { run } = ev as WorkflowUpdatedEvent
          setWorkflowRuns((prev) => {
            const idx = prev.findIndex((r) => r.id === run.id)
            if (idx === -1) return [run, ...prev]
            const next = [...prev]
            next[idx] = run
            return next
          })
          break
        }
        case 'notification': {
          pushNotice(ev as NotificationEvent)
          break
        }
      }
    }

    const connectSse = async () => {
      if (!active) return
      const token = getStoredToken()
      abortCtrl = new AbortController()
      try {
        const res = await fetch('/api/events', {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          signal: abortCtrl.signal,
        })
        if (res.status === 401) {
          setSseConnected(false)
          setAuthenticated(false)
          return
        }
        if (!res.ok || !res.body) {
          throw new Error(`SSE HTTP ${res.status}`)
        }
        setSseConnected(true)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (active) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let sepIdx = buffer.indexOf('\n\n')
          while (sepIdx !== -1) {
            const rawBlock = buffer.slice(0, sepIdx)
            buffer = buffer.slice(sepIdx + 2)
            sepIdx = buffer.indexOf('\n\n')

            let eventName = 'message'
            const dataLines: string[] = []
            for (const line of rawBlock.split('\n')) {
              if (line.startsWith('event:')) {
                eventName = line.slice(6).trim()
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trim())
              }
            }
            if (dataLines.length === 0) continue
            try {
              const payload = JSON.parse(dataLines.join('\n')) as unknown
              if (eventName === 'snapshot') {
                handleSnapshot(payload as HelmSnapshot)
              } else {
                const frame = payload as HelmEventFrame
                if (frame && typeof frame === 'object' && 'event' in frame) {
                  handleEvent(frame.event)
                }
              }
            } catch {
              // 忽略格式异常帧
            }
          }
        }
      } catch {
        // 断开或异常
      } finally {
        if (active) {
          setSseConnected(false)
          retryTimer = setTimeout(() => {
            void connectSse()
          }, 1500)
        }
      }
    }

    void connectSse()

    return () => {
      active = false
      if (retryTimer) clearTimeout(retryTimer)
      abortCtrl?.abort()
    }
  }, [authenticated, loadConversationArtifacts, pushNotice, refreshAssets])

  const groupedUi = useMemo(() => groupUiContributions(uiContributions), [uiContributions])

  const storeValue = useMemo<HelmStoreValue>(
    () => ({
      authReady,
      authConfigured,
      authenticated,
      sseConnected,
      theme,
      conversations,
      conversationDetails,
      conversationLives,
      conversationArtifacts,
      pendingAsks,
      resolvedAsksByConv,
      plugins,
      uiContributions,
      groupedUi,
      pluginDocs,
      workflowRuns,
      savedWorkflows,
      profiles,
      models,
      providers,
      credentials,
      skills,
      actions,
      primaryTarget,
      splitTarget,
      workbenchOpen,
      workbenchTab,
      activeModal,
      highlightedEntry,
      notices,
      setTheme,
      toggleTheme,
      onAuthenticated,
      logout,
      refreshAssets,
      loadConversationDetail,
      loadConversationArtifacts,
      ensurePluginDoc,
      openTarget,
      closeSplit,
      setWorkbenchOpen,
      setWorkbenchTab,
      setActiveModal,
      dismissNotice,
      pushNotice,
      invokePluginAction,
    }),
    [
      authReady,
      authConfigured,
      authenticated,
      sseConnected,
      theme,
      conversations,
      conversationDetails,
      conversationLives,
      conversationArtifacts,
      pendingAsks,
      resolvedAsksByConv,
      plugins,
      uiContributions,
      groupedUi,
      pluginDocs,
      workflowRuns,
      savedWorkflows,
      profiles,
      models,
      providers,
      credentials,
      skills,
      actions,
      primaryTarget,
      splitTarget,
      workbenchOpen,
      workbenchTab,
      activeModal,
      highlightedEntry,
      notices,
      setTheme,
      toggleTheme,
      onAuthenticated,
      logout,
      refreshAssets,
      loadConversationDetail,
      loadConversationArtifacts,
      ensurePluginDoc,
      openTarget,
      closeSplit,
      setWorkbenchOpen,
      setWorkbenchTab,
      setActiveModal,
      dismissNotice,
      pushNotice,
      invokePluginAction,
    ],
  )

  // 向 window.__HELM_SHARED__ 暴露运行时供动态插件 client.mjs 使用
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__HELM_SHARED__ = {
      React,
      useHelmStore,
      usePluginDoc,
    }
  }, [])

  return <HelmStoreContext.Provider value={storeValue}>{children}</HelmStoreContext.Provider>
}
