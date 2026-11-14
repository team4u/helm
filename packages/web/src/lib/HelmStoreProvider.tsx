import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as LucideReact from 'lucide-react'
import type { ActionManifest, ArtifactMetadata, ConversationDetail, ConversationSummary, HelmEventFrame, HelmResumedFrame, HelmSnapshot, PluginSummary, Profile, ProviderConfig, SkillSummary } from '@helm/protocol'
import { ApiClientError, assetsApi, authApi, conversationsApi, getStoredToken, nodesApi, pluginsApi, setStoredToken, type CredentialSummary, type ModelDescriptor, type NodeInfo } from './api.js'
import { applyEventFrame, applySnapshot, emptyLiveState, entryMatchesReference, mergeConversationDetail, readSseChunkWithDeadline, sortNodes, SseParser, sseClientTimings, type LiveState } from './live-state.js'
import { HelmStoreContext, useHelmStore, usePluginDoc } from './store-context.js'
import {
  evictSessionDocSubscriptions,
  evictSessionDocsOfConversation,
  getSessionDocState,
  resetSessionDocSubscriptions,
  retrySessionDoc,
  subscribeSessionDoc,
} from './session-docs.js'
import { evictPluginClientCache, resetPluginClientCache } from './plugin-client.js'
import { resetStandbyDrafts } from '../conversation/standby-model.js'
import * as HelmPluginClient from './plugin-client-sdk.js'
import { formatLocationHash, isSameLocationState, parseLocationHash, shouldPushLocationHistory, upgradeLegacyLocationState, type WorkspaceLocationState } from './url-hash-model.js'
import { groupUiContributions, isPrototypeParamKey, resolveTargetString, SCREEN_PARAM_KEY_PATTERN, spaceForTarget, type ActiveModal, type GroupedUiSpecs, type HelmStoreValue, type ResolvedTarget, type SidebarSpace, type ThemeMode, type ThemePreference, type ToastNotice } from './types.js'
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

/** openSpace 判定空间回跳目标时的实时快照输入。 */
interface SpaceTargetInput {
  conversations: ConversationSummary[]
  profiles: Profile[]
  plugins: ReadonlyArray<{ id: string; enabled: boolean }>
  /** 静态资产是否已完成本轮加载（未加载完时无法证伪角色存在性，按可用放行）。 */
  assetsLoaded: boolean
  grouped: GroupedUiSpecs
}

/** 空间回跳目标当前是否仍可用：会话须在列表中；agent 待命须角色仍存在；
 * screen 须仍是启用插件的贡献；系统中心是宿主静态目标，恒可用。 */
function isSpaceTargetAvailable(target: ResolvedTarget, input: SpaceTargetInput): boolean {
  switch (target.kind) {
    case 'conversation':
      return input.conversations.some((conv) => conv.id === target.conversationId)
    case 'agent':
      if (!input.assetsLoaded) return true
      return input.profiles.some((profile) => profile.id === target.profileId)
    case 'screen':
      return input.grouped.screens.some(
        (item) => item.pluginId === target.pluginId && item.spec.id === target.screenId,
      )
    default:
      return true
  }
}

/** 空间缺省目标（该空间尚无记忆时）：settings -> 角色中心；conversations -> 最新根会话
 * 所属智能体的待命入口（无会话时退到首个可用角色）；views -> 第一个可解析为 screen
 * 的侧栏项。找不到可用目标时返回 null，由调用方显式通知，绝不伪造不存在目标。 */
function defaultSpaceTarget(space: SidebarSpace, input: SpaceTargetInput): ResolvedTarget | null {
  if (space === 'settings') return { kind: 'profiles' }
  if (space === 'views') {
    for (const item of input.grouped.sidebarItems) {
      if (!item.spec.target) continue
      const resolved = resolveTargetString(item.spec.target, input.conversations)
      if (resolved?.kind === 'screen') return resolved
    }
    return null
  }
  const agentUsable = (profileId: string): boolean =>
    !input.assetsLoaded || input.profiles.some((profile) => profile.id === profileId)
  const latestRoot = input.conversations
    .filter((conv) => conv.parentConversationId === undefined)
    .reduce<ConversationSummary | null>(
      (best, conv) =>
        best === null || conv.updatedAt > best.updatedAt || (conv.updatedAt === best.updatedAt && conv.id > best.id)
          ? conv
          : best,
      null,
    )
  if (latestRoot !== null && agentUsable(latestRoot.profileId)) {
    return { kind: 'agent', profileId: latestRoot.profileId }
  }
  const enabledPluginIds = new Set(input.plugins.filter((p) => p.enabled).map((p) => p.id))
  const visible = input.profiles.filter(
    (profile) => profile.managedByPlugin === undefined || enabledPluginIds.has(profile.managedByPlugin),
  )
  const preferred = visible.find((profile) => profile.humanSelectable !== false) ?? visible[0]
  return preferred === undefined ? null : { kind: 'agent', profileId: preferred.id }
}

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
  /** 静态资产是否已完成本轮会话首次加载（待命页区分「加载中」与「角色不存在」）。 */
  const [assetsLoaded, setAssetsLoaded] = useState(false)
  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [actions, setActions] = useState<ActionManifest[]>([])
  // 初始工作台位置取自地址栏 Hash：刷新、复制链接直达与前进/后退都以它为唯一事实来源。
  const [initialLocation] = useState<WorkspaceLocationState>(() => upgradeLegacyLocationState(
    parseLocationHash(typeof window !== 'undefined' ? window.location.hash : ''),
  ))
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
  // SSE 短断线续传凭据（bootId 事件代 + 已实际应用的水位 seq）：仅在快照成功应用或
  // 逐帧应用成功后推进；登出/换身份、快照或帧应用失败立即清空，下次连接强制全量
  // 快照，绝不携带损坏 cursor 重试，也不让新身份沿用旧授权的客户端缓存。
  const sseCursorRef = useRef<{ bootId: string; seq: number } | null>(null)
  const requests = useRef(new Map<string, Promise<unknown>>())
  const failedDocs = useRef(new Set<string>())
  const pluginEpoch = useRef(new Map<string, number>())
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const targets = useRef({ primaryTarget, splitTarget })
  targets.current = { primaryTarget, splitTarget }
  // 空间记忆：每个侧栏空间最近的主屏目标（会话内内存态，不进 URL）。Rail 切换回跳用；
  // 主屏 openTarget / 外部 Hash 恢复 / 删除回退统一在此更新，初始由深链目标播种。
  const spaceMemory = useRef<Partial<Record<SidebarSpace, ResolvedTarget>>>({
    [spaceForTarget(initialLocation.primaryTarget)]: initialLocation.primaryTarget,
  })
  const profilesRef = useRef(profiles)
  profilesRef.current = profiles
  const assetsLoadedRef = useRef(assetsLoaded)
  assetsLoadedRef.current = assetsLoaded
  const activeModalRef = useRef(activeModal)
  activeModalRef.current = activeModal
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
    setConnectionError(null)
    setActiveModal(null)
    setSplitTarget(null)
    setPrimaryTarget({ kind: 'profiles' })
    // 全量数据已清空：空间记忆一并复位为登出后的默认深链位置。
    spaceMemory.current = { settings: { kind: 'profiles' } }
    setWorkbenchOpen(false)
    setWorkbenchTab('artifacts')
    // 地址栏同步复位为默认深链（replaceState 不污染历史栈）；未认证期间禁用写回，避免覆盖用户粘贴的深链。
    lastSyncedLocation.current = parseLocationHash('#/settings/profiles')
    window.history.replaceState(null, '', '#/settings/profiles')
    updateLive(emptyLiveState)
    setConversationArtifacts({})
    setLoadErrors({})
    setAssetsLoaded(false)
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

  const closeSplit = useCallback(() => setSplitTarget(null), [])

  // 显式历史策略标记（openTarget history 选项 / setScreenParams push / openSpace）：
  // 只标记下一拍，实际 pushState/replaceState 由唯一的地址栏写回 effect 执行，组件不得直接操作 history。
  const pendingHistoryMode = useRef<'push' | 'replace' | null>(null)

  // 主屏目标变化的统一入口：同步更新所属空间记忆（openTarget / 删除回退共用）。
  const applyPrimaryTarget = useCallback((target: ResolvedTarget) => {
    spaceMemory.current[spaceForTarget(target)] = target
    setPrimaryTarget(target)
  }, [])

  const openTarget = useCallback((target: string | ResolvedTarget, opts?: { split?: boolean; highlightEntryId?: string; history?: 'push' | 'replace' }) => {
    const resolved = typeof target === 'string' ? resolveTargetString(target, liveRef.current.conversations) : target
    if (!resolved) {
      pushNotice({ type: 'notification', level: 'warning', title: '目标未就绪', body: typeof target === 'string' ? target : '导航目标无效' })
      return
    }
    // 显式历史策略只标记下一拍；实际 pushState/replaceState 仍由唯一写回 effect 执行。
    if (opts?.history !== undefined) pendingHistoryMode.current = opts.history
    if (opts?.split) setSplitTarget(resolved)
    else applyPrimaryTarget(resolved)
    if (resolved.kind === 'conversation' && opts?.highlightEntryId) setHighlightedEntry({ conversationId: resolved.conversationId, entryId: opts.highlightEntryId })
  }, [applyPrimaryTarget, pushNotice])

  // Activity Rail 空间切换 = 直接导航主舞台：回跳该空间最近的主屏目标（无记忆时取空间
  // 缺省目标），经 openTarget 唯一导航机制 push 入栈（实际 pushState 由唯一写回 effect
  // 执行）；目标不可用时显式通知并安全 no-op，绝不伪造不存在目标。已在当前空间时
  // 主屏即最新记忆，直接 no-op（不产生历史项）。
  const openSpace = useCallback((space: SidebarSpace) => {
    if (spaceForTarget(targets.current.primaryTarget) === space) return
    const input: SpaceTargetInput = {
      conversations: liveRef.current.conversations,
      profiles: profilesRef.current,
      plugins: liveRef.current.plugins,
      assetsLoaded: assetsLoadedRef.current,
      grouped: groupUiContributions(liveRef.current.uiContributions),
    }
    const remembered = spaceMemory.current[space]
    if (remembered !== undefined) {
      if (isSpaceTargetAvailable(remembered, input)) {
        openTarget(remembered, { history: 'push' })
        return
      }
      delete spaceMemory.current[space] // 记忆指向已失效目标：安全清理后走空间缺省
    }
    const fallback = defaultSpaceTarget(space, input)
    if (fallback === null) {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: '暂无可打开的入口',
        body:
          space === 'views'
            ? '暂无可用视图，请先在插件中心启用提供视图的插件'
            : '尚无可用会话或角色，请稍后重试',
      })
      return
    }
    openTarget(fallback, { history: 'push' })
  }, [openTarget, pushNotice])

  // ---- Screen 路由参数更新（唯一导航机制内实现，组件不得直接操作 history） ----
  // setParams(..., { push: true }) 与 openTarget({ history }) 共用 pendingHistoryMode。
  const setScreenParams = useCallback((patch: Record<string, string | undefined>, options?: { split?: boolean; push?: boolean }) => {
    const entries = Object.entries(patch).filter(([key, value]) => {
      if (SCREEN_PARAM_KEY_PATTERN.test(key) && !isPrototypeParamKey(key) && (value === undefined || typeof value === 'string')) return true
      pushNotice({ type: 'notification', level: 'warning', title: '已忽略非法 Screen 参数键', body: `参数 ${key} 必须使用合法键和字符串值` })
      return false
    })
    const currentTarget = options?.split ? splitTarget : primaryTarget
    if (entries.length === 0 || currentTarget?.kind !== 'screen') return
    if (options?.push) pendingHistoryMode.current = 'push'
    const update = (current: ResolvedTarget): ResolvedTarget => {
      if (current.kind !== 'screen') return current
      const next: Record<string, string> = { ...(current.params ?? {}) }
      for (const [rawKey, rawValue] of entries) {
        if (rawValue === undefined) delete next[rawKey]
        else if (rawValue !== '') next[rawKey] = rawValue
      }
      const params = Object.keys(next).length === 0 ? undefined : next
      const target: ResolvedTarget = params === undefined
        ? { kind: 'screen', pluginId: current.pluginId, screenId: current.screenId }
        : { kind: 'screen', pluginId: current.pluginId, screenId: current.screenId, params }
      return target
    }
    if (options?.split) setSplitTarget((current) => (current === null ? current : update(current)))
    else applyPrimaryTarget(update(primaryTarget))
  }, [applyPrimaryTarget, pushNotice, primaryTarget, splitTarget])
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
      // 外部 Hash 事件优先级高于尚未消费的组件导航标记，避免 push/replace 标记泄漏到下一次导航。
      pendingHistoryMode.current = null
      lastSyncedLocation.current = parsed
      setPrimaryTarget(parsed.primaryTarget)
      // 外部 Hash 恢复（前进/后退/手动改 Hash）同样更新所属空间记忆。
      spaceMemory.current[spaceForTarget(parsed.primaryTarget)] = parsed.primaryTarget
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
        // 短断线续传：携带上一条连接实际应用到的水位（双凭据缺一不可）；
        // 校验不过时内核改发 snapshot 全量对齐，客户端无需预判。
        const cursor = sseCursorRef.current
        const eventsUrl = cursor !== null
          ? `/api/events?afterSeq=${cursor.seq}&bootId=${encodeURIComponent(cursor.bootId)}`
          : '/api/events'
        const response = await fetch(eventsUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal })
        if (response.status === 401) { logout(); return }
        if (cursor !== null && response.status === 400) {
          // 续传凭据被判非法：作废凭据（本次即失败重连，下次全量），绝不带坏凭据死循环。
          sseCursorRef.current = null
          throw new Error('实时续传请求被内核拒绝（HTTP 400），已改为全量重新同步')
        }
        if (!response.ok || !response.body) throw new Error(`实时连接失败（HTTP ${response.status}）`)
        /** null=待首帧控制帧；fresh=全量已就绪；resumed=补发中（追平 headSeq 才 live）。 */
        let mode: 'fresh' | 'resumed' | null = null
        /** resumed 连接的追平水位：重放期间不宣称 live，避免显示「新鲜」的陈旧状态。 */
        let resumedHeadSeq = 0
        let liveAnnounced = false
        const announceLive = (): void => {
          if (liveAnnounced) return
          liveAnnounced = true
          setSseConnected(true)
          setConnectionError(null)
        }
        const parser = new SseParser((message) => {
          // 消息处理边界：任何协议错误（无效 JSON / 空或畸形控制帧 / 缺 event 增量 /
          // 快照或帧应用失败 / 握手不匹配 / 重复控制帧）都在此作废续传凭据后重抛
          // 断开本连接，下次强制全量——绝不带着可能错位的水位重试坏状态；网络层
          // 异常（空闲超时/流断开）不经过此边界，完好凭据仍可短断线续传。
          try {
            const payload: unknown = JSON.parse(message.data)
            if (message.event === 'snapshot') {
              if (mode !== null) throw new Error('实时连接收到重复的 snapshot 控制帧')
              const snap = payload as HelmSnapshot
              if (snap === null || typeof snap !== 'object' || typeof snap.bootId !== 'string' || snap.bootId === '') {
                throw new Error('内核实时快照格式无效（缺少有效 bootId）')
              }
              mode = 'fresh'
              session.current++
              requests.current.clear()
              failedDocs.current.clear()
              // 断线期间可能发生停用/升级：旧模块与在途下载不能跨快照复活。
              resetPluginClientCache()
              setLoadErrors({})
              updateLive((state) => applySnapshot(state, snap))
              sseCursorRef.current = { bootId: snap.bootId, seq: snap.seq }
              setConversationArtifacts({})
              retry = 0
              announceLive()
              for (const target of [targets.current.primaryTarget, targets.current.splitTarget]) {
                if (target?.kind === 'conversation') { void loadConversationDetail(target.conversationId, true); void loadConversationArtifacts(target.conversationId) }
              }
            } else if (message.event === 'resumed') {
              if (mode !== null) throw new Error('实时连接收到重复的 resumed 控制帧')
              const resumed = payload as HelmResumedFrame
              const current = sseCursorRef.current
              if (
                current === null ||
                resumed === null ||
                typeof resumed !== 'object' ||
                typeof resumed.bootId !== 'string' ||
                resumed.bootId !== current.bootId ||
                resumed.seq !== current.seq ||
                !Number.isSafeInteger(resumed.headSeq) ||
                resumed.headSeq < current.seq
              ) {
                throw new Error('实时连接续传握手不匹配，正在全量重新同步')
              }
              mode = 'resumed'
              resumedHeadSeq = resumed.headSeq
              retry = 0
              // 不清详情/产物/插件缓存：续传补发未丢失任何状态；只有实际追平 headSeq
              // 才宣称 live（零补发时立即 live），重放中不显示「新鲜」。
              if (liveRef.current.seq >= resumedHeadSeq) announceLive()
            } else {
              if (mode === null) throw new Error('实时连接缺少初始快照')
              const frame = payload as HelmEventFrame
              if (frame === null || typeof frame !== 'object' || frame.event === null || typeof frame.event !== 'object' || typeof frame.event.type !== 'string') {
                throw new Error('实时事件帧格式无效（缺少 event）')
              }
              const oldSeq = liveRef.current.seq
              // 删除事件先快照被删会话摘要（applyEventFrame 后列表即移除）：待命目标需
              // 继承其 profileId/nodeId/cwd，防止远端坐标悄悄回落本机。
              const deletedEvent = frame.event.type === 'conversation.deleted' && 'conversationId' in frame.event ? frame.event : undefined
              const deletedSummary = deletedEvent !== undefined
                ? liveRef.current.conversations.find((c) => c.id === deletedEvent.conversationId)
                : undefined
              updateLive((state) => applyEventFrame(state, frame))
              // 按帧实际应用推进续传水位（应用失败已在边界作废凭据，绝不提前推进）。
              const applied = sseCursorRef.current
              if (applied !== null && liveRef.current.seq > applied.seq) {
                sseCursorRef.current = { bootId: applied.bootId, seq: liveRef.current.seq }
              }
              if (mode === 'resumed' && liveRef.current.seq >= resumedHeadSeq) announceLive()
              if (frame.seq <= oldSeq) return
            const event = frame.event
            if (event.type === 'notification' && 'title' in event) pushNotice(event)
            if (event.type === 'plugin.changed' && 'plugin' in event) {
              pluginEpoch.current.set(event.plugin.id, (pluginEpoch.current.get(event.plugin.id) ?? 0) + 1)
              for (const key of requests.current.keys()) if (key.startsWith(`doc:${event.plugin.id}/`)) requests.current.delete(key)
              failedDocs.current.clear()
              // 任意 plugin.changed（含 enabled=true 的热重载/升级）都让该插件 client 模块
              // 缓存失效：loader 只在缓存代变化后才重新拉取比对 contentHash，只处理停用
              // 会让启用态重载后无限残留旧 UI 代码（续传不 reset 全局缓存时更是如此）。
              evictPluginClientCache(event.plugin.id)
              // 插件停用/卸载（ui 贡献移除）时同步释放全部会话文档订阅
              if (!event.plugin.enabled) {
                evictSessionDocSubscriptions(event.plugin.id)
              }
              void refreshAssets()
            }
            if (event.type === 'models.changed') void refreshAssets()
            if (event.type === 'conversation.upsert' && 'conversation' in event) {
              const conv = event.conversation
              const visible = [targets.current.primaryTarget, targets.current.splitTarget].some((target) => target?.kind === 'conversation' && target.conversationId === conv.id)
              if (visible && conv.status !== 'working') void loadConversationArtifacts(conv.id)
              if (visible && conv.unread) void conversationsApi.patch(conv.id, { unread: false }).catch((error: unknown) => reportLoad(`conversation:${conv.id}`, error))
            }
            if (deletedEvent !== undefined) {
              const id = deletedEvent.conversationId
              // 删除导航唯一 truths：仅当被删的正是当前主屏/分屏/抽屉目标时，
              // 以 replace 回到该智能体待命态（无 Profile 信息时显式回角色中心）；
              // 绝不选中其他会话，批量连续删除不闪烁，用户已切走时不覆盖新导航。
              const fallback: ResolvedTarget = deletedSummary !== undefined
                ? {
                    kind: 'agent',
                    profileId: deletedSummary.profileId,
                    ...(deletedSummary.nodeId !== undefined && deletedSummary.nodeId !== '' && deletedSummary.nodeId !== 'local'
                      ? { nodeId: deletedSummary.nodeId }
                      : {}),
                    ...(deletedSummary.cwd !== undefined && deletedSummary.cwd !== '' ? { cwd: deletedSummary.cwd } : {}),
                  }
                : { kind: 'profiles' }
              const primaryHit = targets.current.primaryTarget.kind === 'conversation' && targets.current.primaryTarget.conversationId === id
              const splitHit = targets.current.splitTarget?.kind === 'conversation' && targets.current.splitTarget.conversationId === id
              const drawerHit = activeModalRef.current?.kind === 'conversation-drawer' && activeModalRef.current.conversationId === id
              if (primaryHit || splitHit || drawerHit) pendingHistoryMode.current = 'replace'
              if (primaryHit) applyPrimaryTarget(fallback)
              if (splitHit) setSplitTarget(null)
              if (drawerHit) setActiveModal(null)
              setConversationArtifacts((prev) => { const next = { ...prev }; delete next[id]; return next })
              evictSessionDocsOfConversation(id)
            }
          }
          } catch (error) {
            // 协议边界统一作废续传凭据（见边界注释）后重抛：本次连接按失败重连，
            // 下次必须全量快照，绝不携带可能错位的水位重试。
            sseCursorRef.current = null
            throw error
          }
        })
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        while (active) {
          const read = await readSseChunkWithDeadline(reader, sseClientTimings.idleTimeoutMs)
          if (read.kind === 'idle') {
            // 连接卡死（如 dev 代理保留的挂起流，reader.read() 永不返回）：
            // 抛错走统一 catch（提示 + abort 解开挂起读取）与 finally 重连；
            // 重连 fetch 拿 401 即登出。正常连接持续收到字节（含心跳注释）不会触发。
            throw new Error('实时连接空闲超时，正在重新连接')
          }
          if (read.chunk.done) break
          if (!active) return
          parser.push(decoder.decode(read.chunk.value, { stream: true }))
        }
        if (active) throw new Error('实时连接已断开，正在重新同步')
      } catch (error) {
        if (active && !controller.signal.aborted) setConnectionError(errorText(error))
        // 出错连接一律主动中止：解开空闲超时下可能挂起的 reader.read()
        //（其余路径连接本已坏，abort 幂等无害），finally 统一进入重连。
        controller.abort()
      } finally {
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
        if (active) {
          setSseConnected(false)
          // 指数退避 + 随机抖动：内核重启等同时断线场景避免同步重连风暴。
          const backoff = Math.min(1000 * 2 ** retry, 10000) + Math.random() * 250
          retry += 1
          timer = setTimeout(() => { void connect() }, backoff)
        }
      }
    }
    void connect()
    return () => { active = false; if (timer) clearTimeout(timer); controller?.abort() }
  }, [authenticated, logout, loadConversationDetail, loadConversationArtifacts, reportLoad, pushNotice, refreshAssets, updateLive, applyPrimaryTarget])

  const groupedUi = useMemo(() => groupUiContributions(live.uiContributions), [live.uiContributions])
  // Context value 需引用稳定：任何一处局部状态变化都不应触发全量消费组件重渲染。
  const store: HelmStoreValue = useMemo(
    () => ({
      ...live, authReady, authConfigured, authenticated, authError, connectionError, loadErrors, sseConnected, theme, themePreference, conversationArtifacts, assetsLoaded,
      groupedUi, profiles, models, providers, credentials, skills, actions, primaryTarget, splitTarget, workbenchOpen, workbenchTab, activeModal, highlightedEntry, notices,
      setTheme, setThemePreference, toggleTheme, checkAuth, onAuthenticated, logout, refreshAssets, syncPlugins, refreshNodes, loadConversationDetail, loadEarlierEntries, loadConversationArtifacts, ensurePluginDoc, subscribeSessionDoc, getSessionDocState, getPluginSessionDoc, retrySessionDoc, openTarget, closeSplit, setScreenParams, setWorkbenchOpen, setWorkbenchTab, openSpace, setActiveModal, dismissNotice, pushNotice, invokePluginAction,
    }),
    [
      live, authReady, authConfigured, authenticated, authError, connectionError, loadErrors, sseConnected, theme, themePreference, conversationArtifacts, assetsLoaded,
      groupedUi, profiles, models, providers, credentials, skills, actions, primaryTarget, splitTarget, workbenchOpen, workbenchTab, activeModal, highlightedEntry, notices,
      setTheme, setThemePreference, toggleTheme, checkAuth, onAuthenticated, logout, refreshAssets, syncPlugins, refreshNodes, loadConversationDetail, loadEarlierEntries, loadConversationArtifacts, ensurePluginDoc, subscribeSessionDoc, getSessionDocState, getPluginSessionDoc, retrySessionDoc, openTarget, closeSplit, setScreenParams, setWorkbenchOpen, setWorkbenchTab, openSpace, setActiveModal, dismissNotice, pushNotice, invokePluginAction,
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
