/**
 * Domain-sliced external store for `@helmx/web`: decouples high-frequency
 * per-conversation live/detail/artifact updates from low-frequency catalog,
 * auth, preference, and navigation domains so React components subscribe via
 * `useSyncExternalStore` without full-tree re-render cascades.
 */
import type {
  ActionManifest,
  ArtifactMetadata,
  AskSpec,
  ConversationDetail,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  CredentialSummary,
  HelmxLocale,
  LocalizedText,
  NodeInfo,
  PluginSummary,
  PluginUiContribution,
  Profile,
  ProviderConfig,
  SkillSummary,
} from '@helmx/protocol/browser'
import { resolveLocalizedText } from '@helmx/protocol/browser'
import {
  assetsApi,
  authApi,
  conversationsApi,
  nodesApi,
  pluginsApi,
  setStoredToken,
  type ModelDescriptor,
} from './api.js'
import { requestBrowserNotificationPermission } from './browser-notification.js'
import { errorText } from './error-text.js'
import {
  applyConversationEntry,
  emptyLiveState,
  entryMatchesReference,
  mergeConversationDetail,
  sortNodes,
  type LiveState,
} from './live-state.js'
import { resetPluginClientCache } from './plugin-client.js'
import { isAbortError, StoreRequestManager } from './request-manager.js'
import {
  getSessionDocState,
  resetSessionDocSubscriptions,
  retrySessionDoc,
  subscribeSessionDoc,
} from './session-docs.js'
import {
  applyScreenParamsPatch,
  defaultSpaceTarget,
  hasVisibleConversationRoots,
  partitionScreenParamsPatch,
  resolveSpaceSwitch,
  type SpaceTargetInput,
} from './space-navigation.js'
import {
  applyDocumentLocale,
  applyDocumentTheme,
  getStoredLocalePreference,
  getStoredPreference,
  getStoredQuietNotify,
  nextThemePreference,
  persistLocalePreference,
  persistQuietNotify,
  persistThemePreference,
  resolveBrowserLocale,
  resolveLocale,
  resolveTheme,
} from './theme-preferences.js'
import {
  defaultConversationDetailLimit,
  groupUiContributions,
  resolveTargetString,
  spaceForTarget,
  type ActiveModal,
  type FocusedPanel,
  type GroupedUiSpecs,
  type HelmxStoreValue,
  type LocalePreference,
  type ResolvedTarget,
  type SidebarSpace,
  type ThemeMode,
  type ThemePreference,
  type ToastNotice,
} from './types.js'
import { isSameLocationState, parseLocationHash, type WorkspaceLocationState } from './url-hash-model.js'
import type { SseCursor } from './use-sse-events.js'
import { isConversationStatusActive } from './use-unread-sync.js'
import { resetStandbyDrafts } from '../conversation/standby-model.js'
import {
  activeTargetForPanel,
  ESC_ABORT_WINDOW_MS,
  getStoredSidebarCollapsed,
  isConversationAbortable,
  persistSidebarCollapsed,
  resolveFocusedPanel,
} from '../shell/shortcuts-model.js'
import { createWebTranslator, type WebMessageKey } from '../i18n/catalog.js'

const ESC_ABORT_NOTICE_ID = 'esc-abort-confirm'

const ASSET_LOAD_FAILURE_TITLES: ReadonlyArray<LocalizedText> = [
  { en: 'Profiles failed to load', 'zh-CN': '角色加载失败' },
  { en: 'Models failed to load', 'zh-CN': '模型加载失败' },
  { en: 'Providers failed to load', 'zh-CN': '网关加载失败' },
  { en: 'Credentials failed to load', 'zh-CN': '凭据加载失败' },
  { en: 'Skills failed to load', 'zh-CN': '技能加载失败' },
  { en: 'Plugin actions failed to load', 'zh-CN': '插件动作加载失败' },
]

export type StoreListener = () => void
export type StoreUpdater<T> = T | ((prev: T) => T)

export interface AuthSlice {
  authReady: boolean
  authConfigured: boolean
  authenticated: boolean
  authError: string | null
  sseConnected: boolean
  connectionError: string | null
  kernelBootId: string | null
}

export interface PrefsSlice {
  theme: ThemeMode
  themePreference: ThemePreference
  locale: HelmxLocale
  localePreference: LocalePreference
  quietNotifyEnabled: boolean
}

export interface ProfilesSlice {
  profiles: Profile[]
  profilesLoaded: boolean
  assetsLoaded: boolean
}

export interface CatalogSlice {
  profiles: Profile[]
  profilesLoaded: boolean
  assetsLoaded: boolean
  models: ModelDescriptor[]
  providers: ProviderConfig[]
  credentials: CredentialSummary[]
  skills: SkillSummary[]
  actions: ActionManifest[]
}

export interface PluginsUiSlice {
  plugins: PluginSummary[]
  uiContributions: PluginUiContribution[]
  groupedUi: GroupedUiSpecs
}

export interface LocationTargetsSlice {
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  focusedPanel: FocusedPanel
}

export interface WorkbenchSlice {
  workbenchOpen: boolean
  workbenchTab: string
}

export interface NavSlice {
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  focusedPanel: FocusedPanel
  sidebarCollapsed: boolean
  pendingEscAbortConversationId: number | null
  workbenchOpen: boolean
  workbenchTab: string
  activeModal: ActiveModal
  highlightedEntry: { conversationId: number; entryId: string } | null
}

export interface PluginHostPortSlice {
  authenticated: boolean
  theme: ThemeMode
  locale: HelmxLocale
  conversations: ConversationSummary[]
  conversationDetails: Record<number, ConversationDetail>
  conversationLives: Record<number, ConversationLive>
  pendingAsks: AskSpec[]
  loadErrors: Record<string, string>
  plugins: PluginSummary[]
  groupedUi: GroupedUiSpecs
  pluginDocs: Record<string, unknown>
}

export type ResolvedAskEntry = HelmxStoreValue['resolvedAsksByConv'][number][number]

export type HelmxStoreActions = Pick<
  HelmxStoreValue,
  | 'setTheme'
  | 'setThemePreference'
  | 'toggleTheme'
  | 'setLocale'
  | 'setLocalePreference'
  | 'setQuietNotify'
  | 'checkAuth'
  | 'onAuthenticated'
  | 'logout'
  | 'refreshAssets'
  | 'syncPlugins'
  | 'refreshNodes'
  | 'loadConversationDetail'
  | 'loadEarlierEntries'
  | 'backfillConversationEntry'
  | 'loadConversationArtifacts'
  | 'ensurePluginDoc'
  | 'subscribeSessionDoc'
  | 'getSessionDocState'
  | 'getPluginSessionDoc'
  | 'retrySessionDoc'
  | 'openTarget'
  | 'closeSplit'
  | 'setFocusedPanel'
  | 'setSidebarCollapsed'
  | 'toggleSidebarCollapsed'
  | 'setScreenParams'
  | 'setWorkbenchOpen'
  | 'setWorkbenchTab'
  | 'openSpace'
  | 'setActiveModal'
  | 'dismissNotice'
  | 'pushNotice'
  | 'invokePluginAction'
>

export type StoreDomainKey =
  | 'all'
  | 'auth'
  | 'authenticated'
  | 'sseConnected'
  | 'prefs'
  | 'locale'
  | 'theme'
  | 'quietNotify'
  | 'catalog'
  | 'profiles'
  | 'models'
  | 'providers'
  | 'credentials'
  | 'skills'
  | 'actions'
  | 'conversations'
  | 'conversationDetailsMap'
  | 'conversationLivesMap'
  | 'conversationArtifactsMap'
  | 'pendingAsks'
  | 'resolvedAsksMap'
  | 'asks'
  | 'plugins'
  | 'groupedUi'
  | 'pluginsUi'
  | 'pluginDocsMap'
  | 'nodes'
  | 'loadErrorsMap'
  | 'nav'
  | 'locationTargets'
  | 'primaryTarget'
  | 'splitTarget'
  | 'focusedPanel'
  | 'sidebarCollapsed'
  | 'pendingEscAbort'
  | 'workbench'
  | 'activeModal'
  | 'locationState'
  | 'highlightedEntry'
  | 'notices'
  | 'pluginHostPort'

export interface StoreBootLocation {
  location: WorkspaceLocationState
  needsHomeLanding: boolean
}

interface NotifyPlan {
  domains: Set<StoreDomainKey>
  liveIds: Set<number>
  detailIds: Set<number>
  summaryIds: Set<number>
  artifactIds: Set<number>
  resolvedAskIds: Set<number>
  highlightIds: Set<number>
  loadErrorKeys: Set<string>
  pluginDocKeys: Set<string>
}

function emptyPlan(): NotifyPlan {
  return {
    domains: new Set(),
    liveIds: new Set(),
    detailIds: new Set(),
    summaryIds: new Set(),
    artifactIds: new Set(),
    resolvedAskIds: new Set(),
    highlightIds: new Set(),
    loadErrorKeys: new Set(),
    pluginDocKeys: new Set(),
  }
}

function addChangedRecordKeys<V>(
  prev: Record<number, V>,
  next: Record<number, V>,
  out: Set<number>,
): void {
  for (const key of Object.keys(prev)) {
    const id = Number(key)
    if (prev[id] !== next[id]) out.add(id)
  }
  for (const key of Object.keys(next)) {
    const id = Number(key)
    if (prev[id] !== next[id]) out.add(id)
  }
}

function addChangedStringKeys<V>(
  prev: Record<string, V>,
  next: Record<string, V>,
  out: Set<string>,
): void {
  for (const key of Object.keys(prev)) {
    if (!Object.hasOwn(next, key) || prev[key] !== next[key]) out.add(key)
  }
  for (const key of Object.keys(next)) {
    if (!Object.hasOwn(prev, key) || prev[key] !== next[key]) out.add(key)
  }
}

function applyUpdater<T>(prev: T, update: StoreUpdater<T>): T {
  return typeof update === 'function' ? (update as (p: T) => T)(prev) : update
}

function sameArtifactMetadata(a: ArtifactMetadata, b: ArtifactMetadata): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.conversationId === b.conversationId &&
      a.kind === b.kind &&
      a.name === b.name &&
      a.path === b.path &&
      a.mimeType === b.mimeType &&
      a.size === b.size &&
      a.createdAt === b.createdAt)
  )
}

/**
 * 复用未变更产物的数组与单项引用：内容完全一致时返回原数组以跳过订阅重渲染，
 * 列表变更时保留未变项原引用，避免预览模态框因元数据引用刷新误重置解码状态。
 */
function reconcileArtifactList(
  prev: ReadonlyArray<ArtifactMetadata> | undefined,
  next: ArtifactMetadata[],
): ArtifactMetadata[] {
  if (prev === undefined) return next
  const prevById = new Map(prev.map((item) => [item.id, item]))
  let allSame = prev.length === next.length
  const merged = next.map((item, index) => {
    const existing = prevById.get(item.id)
    if (existing !== undefined && sameArtifactMetadata(existing, item)) {
      if (allSame && prev[index] !== existing) allSame = false
      return existing
    }
    allSame = false
    return item
  })
  return allSame ? (prev as ArtifactMetadata[]) : merged
}

function shallowEqualAuth(a: AuthSlice, b: AuthSlice): boolean {
  return (
    a.authReady === b.authReady &&
    a.authConfigured === b.authConfigured &&
    a.authenticated === b.authenticated &&
    a.authError === b.authError &&
    a.sseConnected === b.sseConnected &&
    a.connectionError === b.connectionError &&
    a.kernelBootId === b.kernelBootId
  )
}

export class HelmxExternalStore {
  readonly requests = new StoreRequestManager()
  readonly sseCursorRef: { current: SseCursor | null } = { current: null }
  readonly lastSyncedLocation: { current: WorkspaceLocationState }
  readonly pendingHistoryMode: { current: 'push' | 'replace' | null } = { current: null }
  readonly liveRef: { current: LiveState }
  readonly authenticatedRef: { current: boolean } = { current: false }
  readonly profilesRef: { current: Profile[] } = { current: [] }
  readonly profilesLoadedRef: { current: boolean } = { current: false }
  readonly assetsLoadedRef: { current: boolean } = { current: false }
  readonly conversationArtifactsRef: { current: Record<number, ArtifactMetadata[]> } = { current: {} }
  readonly targets: { current: { primaryTarget: ResolvedTarget; splitTarget: ResolvedTarget | null } }
  readonly focusedPanelRef: { current: FocusedPanel } = { current: 'primary' }
  readonly workbenchOpenRef: { current: boolean }
  readonly activeModalRef: { current: ActiveModal }

  private authState: AuthSlice = {
    authReady: false,
    authConfigured: false,
    authenticated: false,
    authError: null,
    sseConnected: false,
    connectionError: null,
    kernelBootId: null,
  }
  private prefsState: PrefsSlice
  private catalogState: CatalogSlice = {
    profiles: [],
    profilesLoaded: false,
    assetsLoaded: false,
    models: [],
    providers: [],
    credentials: [],
    skills: [],
    actions: [],
  }
  private profilesSlice: ProfilesSlice = {
    profiles: [],
    profilesLoaded: false,
    assetsLoaded: false,
  }
  private liveState: LiveState = emptyLiveState()
  private groupedUi: GroupedUiSpecs = groupUiContributions([])
  private pluginsUiSlice: PluginsUiSlice
  private summaryById = new Map<number, ConversationSummary>()
  private artifactsState: Record<number, ArtifactMetadata[]> = {}
  private loadErrorsState: Record<string, string> = {}
  private navState: NavSlice
  private locationTargetsSlice: LocationTargetsSlice
  private workbenchSlice: WorkbenchSlice
  private locationStateCache: WorkspaceLocationState
  private noticesState: ToastNotice[] = []
  private pluginHostPortSlice: PluginHostPortSlice
  private fullSnapshotCache: HelmxStoreValue | null = null

  private noticeSequence = 0
  private spaceMemory: Partial<Record<SidebarSpace, ResolvedTarget>>
  private escAbortTimer: ReturnType<typeof setTimeout> | null = null
  private logoutImpl: (() => void) | null = null

  private domainListeners = new Map<StoreDomainKey, Set<StoreListener>>()
  private liveListeners = new Map<number, Set<StoreListener>>()
  private detailListeners = new Map<number, Set<StoreListener>>()
  private summaryListeners = new Map<number, Set<StoreListener>>()
  private artifactsListeners = new Map<number, Set<StoreListener>>()
  private resolvedAsksListeners = new Map<number, Set<StoreListener>>()
  private highlightListeners = new Map<number, Set<StoreListener>>()
  private loadErrorListeners = new Map<string, Set<StoreListener>>()
  private pluginDocListeners = new Map<string, Set<StoreListener>>()

  readonly actions: HelmxStoreActions

  constructor(bootLocation: WorkspaceLocationState) {
    const themePreference = getStoredPreference()
    const localePreference = getStoredLocalePreference()
    const locale = resolveLocale(localePreference)
    this.prefsState = {
      themePreference,
      theme: resolveTheme(themePreference),
      localePreference,
      locale,
      quietNotifyEnabled: getStoredQuietNotify(),
    }
    this.pluginsUiSlice = {
      plugins: this.liveState.plugins,
      uiContributions: this.liveState.uiContributions,
      groupedUi: this.groupedUi,
    }
    this.navState = {
      primaryTarget: bootLocation.primaryTarget,
      splitTarget: bootLocation.splitTarget,
      focusedPanel: 'primary',
      sidebarCollapsed: getStoredSidebarCollapsed(),
      pendingEscAbortConversationId: null,
      workbenchOpen: bootLocation.workbenchOpen,
      workbenchTab: bootLocation.workbenchTab,
      activeModal: bootLocation.activeModal,
      highlightedEntry: null,
    }
    this.locationTargetsSlice = {
      primaryTarget: this.navState.primaryTarget,
      splitTarget: this.navState.splitTarget,
      focusedPanel: this.navState.focusedPanel,
    }
    this.workbenchSlice = {
      workbenchOpen: this.navState.workbenchOpen,
      workbenchTab: this.navState.workbenchTab,
    }
    this.locationStateCache = {
      primaryTarget: this.navState.primaryTarget,
      splitTarget: this.navState.splitTarget,
      workbenchOpen: this.navState.workbenchOpen,
      workbenchTab: this.navState.workbenchTab,
      activeModal: this.navState.activeModal,
    }
    this.spaceMemory = {}
    this.rememberSpaceTarget(bootLocation.primaryTarget)
    this.lastSyncedLocation = { current: bootLocation }
    this.liveRef = { current: this.liveState }
    this.targets = {
      current: {
        primaryTarget: this.navState.primaryTarget,
        splitTarget: this.navState.splitTarget,
      },
    }
    this.workbenchOpenRef = { current: this.navState.workbenchOpen }
    this.activeModalRef = { current: this.navState.activeModal }
    this.pluginHostPortSlice = this.buildPluginHostPortSlice()

    this.actions = {
      setTheme: this.setTheme,
      setThemePreference: this.setThemePreference,
      toggleTheme: this.toggleTheme,
      setLocale: this.setLocale,
      setLocalePreference: this.setLocalePreference,
      setQuietNotify: this.setQuietNotify,
      checkAuth: this.checkAuth,
      onAuthenticated: this.onAuthenticated,
      logout: () => {
        if (this.logoutImpl !== null) this.logoutImpl()
        else {
          this.prepareLogoutHistoryReset()
          this.finishLogoutStateReset()
        }
      },
      refreshAssets: this.refreshAssets,
      syncPlugins: this.syncPlugins,
      refreshNodes: this.refreshNodes,
      loadConversationDetail: this.loadConversationDetail,
      loadEarlierEntries: this.loadEarlierEntries,
      backfillConversationEntry: this.backfillConversationEntry,
      loadConversationArtifacts: this.loadConversationArtifacts,
      ensurePluginDoc: this.ensurePluginDoc,
      subscribeSessionDoc,
      getSessionDocState,
      getPluginSessionDoc: this.getPluginSessionDoc,
      retrySessionDoc,
      openTarget: this.openTarget,
      closeSplit: this.closeSplit,
      setFocusedPanel: this.setFocusedPanel,
      setSidebarCollapsed: this.setSidebarCollapsed,
      toggleSidebarCollapsed: this.toggleSidebarCollapsed,
      setScreenParams: this.setScreenParams,
      setWorkbenchOpen: this.setWorkbenchOpen,
      setWorkbenchTab: this.setWorkbenchTab,
      openSpace: this.openSpace,
      setActiveModal: this.setActiveModal,
      dismissNotice: this.dismissNotice,
      pushNotice: this.pushNotice,
      invokePluginAction: this.invokePluginAction,
    }
  }

  bindLogout(fn: () => void): void {
    this.logoutImpl = fn
  }

  dispose(): void {
    this.clearEscTimer()
    this.requests.dispose()
  }

  private clearEscTimer(): void {
    if (this.escAbortTimer !== null) {
      clearTimeout(this.escAbortTimer)
      this.escAbortTimer = null
    }
  }

  translate = (text: LocalizedText): string => resolveLocalizedText(text, this.prefsState.locale)

  private tt(key: WebMessageKey, params?: Record<string, string | number>): string {
    return createWebTranslator(this.prefsState.locale)(key, params as never)
  }

  // ---- Subscriptions --------------------------------------------------------

  subscribeDomain = (key: StoreDomainKey, listener: StoreListener): (() => void) => {
    return this.addListener(this.domainListeners, key, listener)
  }

  subscribeAll = (listener: StoreListener): (() => void) => this.subscribeDomain('all', listener)

  subscribeConversationLive = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.liveListeners, conversationId, listener)

  subscribeConversationDetail = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.detailListeners, conversationId, listener)

  subscribeConversationSummary = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.summaryListeners, conversationId, listener)

  subscribeConversationArtifacts = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.artifactsListeners, conversationId, listener)

  subscribeResolvedAsks = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.resolvedAsksListeners, conversationId, listener)

  subscribeHighlightForConversation = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.highlightListeners, conversationId, listener)

  subscribeLoadError = (key: string, listener: StoreListener): (() => void) =>
    this.addListener(this.loadErrorListeners, key, listener)

  subscribePluginDoc = (docKey: string, listener: StoreListener): (() => void) =>
    this.addListener(this.pluginDocListeners, docKey, listener)

  private addListener<K>(map: Map<K, Set<StoreListener>>, key: K, listener: StoreListener): () => void {
    let set = map.get(key)
    if (set === undefined) {
      set = new Set()
      map.set(key, set)
    }
    set.add(listener)
    return () => {
      const current = map.get(key)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) map.delete(key)
    }
  }

  // ---- Cached Snapshot Getters ----------------------------------------------

  getAuthSlice = (): AuthSlice => this.authState
  getAuthenticated = (): boolean => this.authState.authenticated
  getSseConnected = (): boolean => this.authState.sseConnected
  getPrefsSlice = (): PrefsSlice => this.prefsState
  getLocale = (): HelmxLocale => this.prefsState.locale
  getCatalogSlice = (): CatalogSlice => this.catalogState
  getProfilesSlice = (): ProfilesSlice => this.profilesSlice
  getModels = (): ModelDescriptor[] => this.catalogState.models
  getProviders = (): ProviderConfig[] => this.catalogState.providers
  getCredentials = (): CredentialSummary[] => this.catalogState.credentials
  getSkills = (): SkillSummary[] => this.catalogState.skills
  getActionsList = (): ActionManifest[] => this.catalogState.actions
  getLiveState = (): LiveState => this.liveState
  getConversations = (): ConversationSummary[] => this.liveState.conversations
  getConversationDetailsMap = (): Record<number, ConversationDetail> => this.liveState.conversationDetails
  getConversationLivesMap = (): Record<number, ConversationLive> => this.liveState.conversationLives
  getConversationArtifactsMap = (): Record<number, ArtifactMetadata[]> => this.artifactsState
  getPendingAsks = (): AskSpec[] => this.liveState.pendingAsks
  getResolvedAsksMap = (): Record<number, ResolvedAskEntry[]> => this.liveState.resolvedAsksByConv
  getPlugins = (): PluginSummary[] => this.liveState.plugins
  getGroupedUi = (): GroupedUiSpecs => this.groupedUi
  getPluginsUiSlice = (): PluginsUiSlice => this.pluginsUiSlice
  getPluginDocsMap = (): Record<string, unknown> => this.liveState.pluginDocs
  getNodes = (): NodeInfo[] => this.liveState.nodes
  getLoadErrorsMap = (): Record<string, string> => this.loadErrorsState
  getNavSlice = (): NavSlice => this.navState
  getLocationTargetsSlice = (): LocationTargetsSlice => this.locationTargetsSlice
  getPrimaryTarget = (): ResolvedTarget => this.navState.primaryTarget
  getSplitTarget = (): ResolvedTarget | null => this.navState.splitTarget
  getFocusedPanel = (): FocusedPanel => this.navState.focusedPanel
  getSidebarCollapsed = (): boolean => this.navState.sidebarCollapsed
  getPendingEscAbort = (): number | null => this.navState.pendingEscAbortConversationId
  getWorkbenchSlice = (): WorkbenchSlice => this.workbenchSlice
  getActiveModal = (): ActiveModal => this.navState.activeModal
  getLocationState = (): WorkspaceLocationState => this.locationStateCache
  getHighlightedEntry = (): { conversationId: number; entryId: string } | null => this.navState.highlightedEntry
  getNotices = (): ToastNotice[] => this.noticesState
  getPluginHostPortSlice = (): PluginHostPortSlice => this.pluginHostPortSlice

  getConversationLive = (id: number): ConversationLive | undefined => this.liveState.conversationLives[id]
  getConversationDetail = (id: number): ConversationDetail | undefined => this.liveState.conversationDetails[id]
  getConversationSummary = (id: number): ConversationSummary | undefined => this.summaryById.get(id)
  getConversationArtifacts = (id: number): ArtifactMetadata[] | undefined => this.artifactsState[id]
  getResolvedAsks = (id: number): ResolvedAskEntry[] | undefined => this.liveState.resolvedAsksByConv[id]
  getHighlightedEntryForConversation = (id: number): { conversationId: number; entryId: string } | null =>
    this.navState.highlightedEntry?.conversationId === id ? this.navState.highlightedEntry : null
  getLoadError = (key: string): string | undefined => this.loadErrorsState[key]
  getPluginDoc = (docKey: string): unknown =>
    Object.hasOwn(this.liveState.pluginDocs, docKey) ? this.liveState.pluginDocs[docKey] : undefined

  getSnapshot = (): HelmxStoreValue => {
    if (this.fullSnapshotCache !== null) return this.fullSnapshotCache
    const next: HelmxStoreValue = {
      ...this.liveState,
      ...this.authState,
      ...this.prefsState,
      ...this.catalogState,
      groupedUi: this.groupedUi,
      conversationArtifacts: this.artifactsState,
      loadErrors: this.loadErrorsState,
      ...this.navState,
      notices: this.noticesState,
      ...this.actions,
    }
    this.fullSnapshotCache = next
    return next
  }

  private buildPluginHostPortSlice(): PluginHostPortSlice {
    return {
      authenticated: this.authState.authenticated,
      theme: this.prefsState.theme,
      locale: this.prefsState.locale,
      conversations: this.liveState.conversations,
      conversationDetails: this.liveState.conversationDetails,
      conversationLives: this.liveState.conversationLives,
      pendingAsks: this.liveState.pendingAsks,
      loadErrors: this.loadErrorsState,
      plugins: this.liveState.plugins,
      groupedUi: this.groupedUi,
      pluginDocs: this.liveState.pluginDocs,
    }
  }

  // ---- Atomic Commit / Notification Engine ----------------------------------

  private emit(plan: NotifyPlan): void {
    const anyChanged =
      plan.domains.size > 0 ||
      plan.liveIds.size > 0 ||
      plan.detailIds.size > 0 ||
      plan.summaryIds.size > 0 ||
      plan.artifactIds.size > 0 ||
      plan.resolvedAskIds.size > 0 ||
      plan.highlightIds.size > 0 ||
      plan.loadErrorKeys.size > 0 ||
      plan.pluginDocKeys.size > 0
    if (!anyChanged) return

    this.fullSnapshotCache = null
    if (plan.domains.has('pluginHostPort')) {
      this.pluginHostPortSlice = this.buildPluginHostPortSlice()
    }

    // Reconcile armed double-Esc abort synchronously on nav / conversation / detail shifts.
    this.reconcileEscAbort(plan)

    const listeners = new Set<StoreListener>()
    const collect = <K>(map: Map<K, Set<StoreListener>>, key: K) => {
      const set = map.get(key)
      if (set !== undefined) {
        for (const fn of set) listeners.add(fn)
      }
    }

    for (const domain of plan.domains) collect(this.domainListeners, domain)
    for (const id of plan.liveIds) collect(this.liveListeners, id)
    for (const id of plan.detailIds) collect(this.detailListeners, id)
    for (const id of plan.summaryIds) collect(this.summaryListeners, id)
    for (const id of plan.artifactIds) collect(this.artifactsListeners, id)
    for (const id of plan.resolvedAskIds) collect(this.resolvedAsksListeners, id)
    for (const id of plan.highlightIds) collect(this.highlightListeners, id)
    for (const key of plan.loadErrorKeys) collect(this.loadErrorListeners, key)
    for (const key of plan.pluginDocKeys) collect(this.pluginDocListeners, key)

    for (const fn of listeners) fn()
  }

  private reconcileEscAbort(plan: NotifyPlan): void {
    const pendingId = this.navState.pendingEscAbortConversationId
    if (pendingId === null) return
    const activeTarget = activeTargetForPanel(
      this.navState.primaryTarget,
      this.navState.splitTarget,
      this.navState.focusedPanel,
    )
    const targetInvalid = activeTarget.kind !== 'conversation' || activeTarget.conversationId !== pendingId
    const conv = this.summaryById.get(pendingId) ?? this.liveState.conversationDetails[pendingId]
    if (!targetInvalid && isConversationAbortable(conv)) return

    this.clearEscTimer()
    this.navState = { ...this.navState, pendingEscAbortConversationId: null }
    plan.domains.add('pendingEscAbort')
    plan.domains.add('nav')
    plan.domains.add('all')
    if (this.noticesState.some((item) => item.id === ESC_ABORT_NOTICE_ID)) {
      this.noticesState = this.noticesState.filter((item) => item.id !== ESC_ABORT_NOTICE_ID)
      plan.domains.add('notices')
    }
  }

  // ---- Internal Mutators ----------------------------------------------------

  private patchAuth(patch: Partial<AuthSlice>, plan = emptyPlan(), deferEmit = false): void {
    const prev = this.authState
    const next: AuthSlice = { ...prev, ...patch }
    if (shallowEqualAuth(prev, next)) return
    this.authState = next
    this.authenticatedRef.current = next.authenticated
    plan.domains.add('auth')
    plan.domains.add('all')
    if (next.authenticated !== prev.authenticated) {
      plan.domains.add('authenticated')
      plan.domains.add('pluginHostPort')
    }
    if (next.sseConnected !== prev.sseConnected) plan.domains.add('sseConnected')
    if (!deferEmit) this.emit(plan)
  }

  setSseConnected = (update: StoreUpdater<boolean>): void => {
    const next = applyUpdater(this.authState.sseConnected, update)
    this.patchAuth({ sseConnected: next })
  }

  setConnectionError = (update: StoreUpdater<string | null>): void => {
    const next = applyUpdater(this.authState.connectionError, update)
    this.patchAuth({ connectionError: next })
  }

  setKernelBootId = (update: StoreUpdater<string | null>): void => {
    const next = applyUpdater(this.authState.kernelBootId, update)
    this.patchAuth({ kernelBootId: next })
  }

  private patchPrefs(patch: Partial<PrefsSlice>, plan = emptyPlan()): void {
    const prev = this.prefsState
    const next: PrefsSlice = { ...prev, ...patch }
    if (
      prev.theme === next.theme &&
      prev.themePreference === next.themePreference &&
      prev.locale === next.locale &&
      prev.localePreference === next.localePreference &&
      prev.quietNotifyEnabled === next.quietNotifyEnabled
    ) {
      return
    }
    this.prefsState = next
    plan.domains.add('prefs')
    plan.domains.add('all')
    if (next.theme !== prev.theme || next.themePreference !== prev.themePreference) {
      plan.domains.add('theme')
    }
    if (next.locale !== prev.locale || next.localePreference !== prev.localePreference) {
      plan.domains.add('locale')
    }
    if (next.theme !== prev.theme || next.locale !== prev.locale) {
      plan.domains.add('pluginHostPort')
    }
    if (next.quietNotifyEnabled !== prev.quietNotifyEnabled) {
      plan.domains.add('quietNotify')
    }
    this.emit(plan)
  }

  handleSystemThemeChange = (matchesDark: boolean): void => {
    if (this.prefsState.themePreference !== 'system') return
    const next: ThemeMode = matchesDark ? 'dark' : 'light'
    applyDocumentTheme(next)
    this.patchPrefs({ theme: next })
  }

  handleBrowserLanguageChange = (): void => {
    if (this.prefsState.localePreference !== 'auto') return
    const next = resolveBrowserLocale()
    applyDocumentLocale(next)
    this.patchPrefs({ locale: next })
  }

  private patchCatalog(patch: Partial<CatalogSlice>, plan = emptyPlan(), deferEmit = false): void {
    const prev = this.catalogState
    const next: CatalogSlice = { ...prev, ...patch }
    let changed = false
    if (next.profiles !== prev.profiles || next.profilesLoaded !== prev.profilesLoaded || next.assetsLoaded !== prev.assetsLoaded) {
      this.profilesSlice = {
        profiles: next.profiles,
        profilesLoaded: next.profilesLoaded,
        assetsLoaded: next.assetsLoaded,
      }
      this.profilesRef.current = next.profiles
      this.profilesLoadedRef.current = next.profilesLoaded
      this.assetsLoadedRef.current = next.assetsLoaded
      plan.domains.add('profiles')
      changed = true
    }
    if (next.models !== prev.models) { plan.domains.add('models'); changed = true }
    if (next.providers !== prev.providers) { plan.domains.add('providers'); changed = true }
    if (next.credentials !== prev.credentials) { plan.domains.add('credentials'); changed = true }
    if (next.skills !== prev.skills) { plan.domains.add('skills'); changed = true }
    if (next.actions !== prev.actions) { plan.domains.add('actions'); changed = true }
    if (!changed) return
    this.catalogState = next
    plan.domains.add('catalog')
    plan.domains.add('all')
    if (!deferEmit) this.emit(plan)
  }

  updateLive = (update: (state: LiveState) => LiveState, plan = emptyPlan(), deferEmit = false): void => {
    const prev = this.liveState
    const next = update(prev)
    if (next === prev) return
    this.liveState = next
    this.liveRef.current = next

    if (next.conversationLives !== prev.conversationLives) {
      addChangedRecordKeys(prev.conversationLives, next.conversationLives, plan.liveIds)
      if (plan.liveIds.size > 0) {
        plan.domains.add('conversationLivesMap')
        plan.domains.add('pluginHostPort')
        plan.domains.add('all')
      }
    }
    if (next.conversationDetails !== prev.conversationDetails) {
      addChangedRecordKeys(prev.conversationDetails, next.conversationDetails, plan.detailIds)
      if (plan.detailIds.size > 0) {
        plan.domains.add('conversationDetailsMap')
        plan.domains.add('pluginHostPort')
        plan.domains.add('all')
      }
    }
    if (next.conversations !== prev.conversations) {
      const nextMap = new Map<number, ConversationSummary>()
      for (const conv of next.conversations) nextMap.set(conv.id, conv)
      for (const [id, prevConv] of this.summaryById) {
        if (nextMap.get(id) !== prevConv) plan.summaryIds.add(id)
      }
      for (const [id, nextConv] of nextMap) {
        if (this.summaryById.get(id) !== nextConv) plan.summaryIds.add(id)
      }
      this.summaryById = nextMap
      plan.domains.add('conversations')
      plan.domains.add('pluginHostPort')
      plan.domains.add('all')
    }
    if (next.pendingAsks !== prev.pendingAsks) {
      plan.domains.add('pendingAsks')
      plan.domains.add('asks')
      plan.domains.add('pluginHostPort')
      plan.domains.add('all')
    }
    if (next.resolvedAsksByConv !== prev.resolvedAsksByConv) {
      addChangedRecordKeys(prev.resolvedAsksByConv, next.resolvedAsksByConv, plan.resolvedAskIds)
      if (plan.resolvedAskIds.size > 0) {
        plan.domains.add('resolvedAsksMap')
        plan.domains.add('asks')
        plan.domains.add('all')
      }
    }
    if (next.plugins !== prev.plugins) {
      plan.domains.add('plugins')
      plan.domains.add('pluginsUi')
      plan.domains.add('pluginHostPort')
      plan.domains.add('all')
    }
    if (next.uiContributions !== prev.uiContributions) {
      this.groupedUi = groupUiContributions(next.uiContributions)
      plan.domains.add('groupedUi')
      plan.domains.add('pluginsUi')
      plan.domains.add('pluginHostPort')
      plan.domains.add('all')
    }
    if (next.plugins !== prev.plugins || next.uiContributions !== prev.uiContributions) {
      this.pluginsUiSlice = {
        plugins: next.plugins,
        uiContributions: next.uiContributions,
        groupedUi: this.groupedUi,
      }
    }
    if (next.pluginDocs !== prev.pluginDocs) {
      addChangedStringKeys(prev.pluginDocs, next.pluginDocs, plan.pluginDocKeys)
      if (plan.pluginDocKeys.size > 0) {
        plan.domains.add('pluginDocsMap')
        plan.domains.add('pluginHostPort')
        plan.domains.add('all')
      }
    }
    if (next.nodes !== prev.nodes) {
      plan.domains.add('nodes')
      plan.domains.add('all')
    }
    if (!deferEmit) this.emit(plan)
  }

  setConversationArtifacts = (
    update: StoreUpdater<Record<number, ArtifactMetadata[]>>,
    plan = emptyPlan(),
    deferEmit = false,
  ): void => {
    const prev = this.artifactsState
    const next = applyUpdater(prev, update)
    if (next === prev) return
    addChangedRecordKeys(prev, next, plan.artifactIds)
    if (plan.artifactIds.size === 0) return
    this.artifactsState = next
    this.conversationArtifactsRef.current = next
    plan.domains.add('conversationArtifactsMap')
    plan.domains.add('all')
    if (!deferEmit) this.emit(plan)
  }

  setLoadErrors = (
    update: StoreUpdater<Record<string, string>>,
    plan = emptyPlan(),
    deferEmit = false,
  ): void => {
    const prev = this.loadErrorsState
    const next = applyUpdater(prev, update)
    if (next === prev) return
    addChangedStringKeys(prev, next, plan.loadErrorKeys)
    if (plan.loadErrorKeys.size === 0) return
    this.loadErrorsState = next
    plan.domains.add('loadErrorsMap')
    plan.domains.add('pluginHostPort')
    plan.domains.add('all')
    if (!deferEmit) this.emit(plan)
  }

  reportLoad = (key: string, error?: unknown): void => {
    if (error === undefined && !Object.hasOwn(this.loadErrorsState, key)) return
    const nextMessage = error === undefined ? undefined : errorText(error)
    if (error !== undefined && this.loadErrorsState[key] === nextMessage) return
    const next = { ...this.loadErrorsState }
    if (nextMessage === undefined) delete next[key]
    else next[key] = nextMessage
    this.setLoadErrors(next)
  }

  setNotices = (
    update: StoreUpdater<ToastNotice[]>,
    plan = emptyPlan(),
    deferEmit = false,
  ): void => {
    const prev = this.noticesState
    const next = applyUpdater(prev, update)
    if (next === prev) return
    this.noticesState = next
    plan.domains.add('notices')
    plan.domains.add('all')
    if (!deferEmit) this.emit(plan)
  }

  private patchNav(patch: Partial<NavSlice>, plan = emptyPlan(), deferEmit = false): void {
    const prev = this.navState
    const next: NavSlice = { ...prev, ...patch }
    if (next.splitTarget === null && next.focusedPanel !== 'primary') {
      next.focusedPanel = 'primary'
    }
    const primaryChanged = next.primaryTarget !== prev.primaryTarget
    const splitChanged = next.splitTarget !== prev.splitTarget
    const focusedChanged = next.focusedPanel !== prev.focusedPanel
    const collapsedChanged = next.sidebarCollapsed !== prev.sidebarCollapsed
    const escChanged = next.pendingEscAbortConversationId !== prev.pendingEscAbortConversationId
    const wbChanged = next.workbenchOpen !== prev.workbenchOpen || next.workbenchTab !== prev.workbenchTab
    const modalChanged = next.activeModal !== prev.activeModal
    const highlightChanged = next.highlightedEntry !== prev.highlightedEntry

    if (
      !primaryChanged &&
      !splitChanged &&
      !focusedChanged &&
      !collapsedChanged &&
      !escChanged &&
      !wbChanged &&
      !modalChanged &&
      !highlightChanged
    ) {
      return
    }

    this.navState = next
    this.targets.current = { primaryTarget: next.primaryTarget, splitTarget: next.splitTarget }
    this.focusedPanelRef.current = next.focusedPanel
    this.workbenchOpenRef.current = next.workbenchOpen
    this.activeModalRef.current = next.activeModal

    plan.domains.add('nav')
    plan.domains.add('all')
    if (primaryChanged) plan.domains.add('primaryTarget')
    if (splitChanged) plan.domains.add('splitTarget')
    if (focusedChanged) plan.domains.add('focusedPanel')
    if (primaryChanged || splitChanged || focusedChanged) {
      this.locationTargetsSlice = {
        primaryTarget: next.primaryTarget,
        splitTarget: next.splitTarget,
        focusedPanel: next.focusedPanel,
      }
      plan.domains.add('locationTargets')
    }
    if (collapsedChanged) plan.domains.add('sidebarCollapsed')
    if (escChanged) plan.domains.add('pendingEscAbort')
    if (wbChanged) {
      this.workbenchSlice = {
        workbenchOpen: next.workbenchOpen,
        workbenchTab: next.workbenchTab,
      }
      plan.domains.add('workbench')
    }
    if (modalChanged) plan.domains.add('activeModal')
    if (primaryChanged || splitChanged || wbChanged || modalChanged) {
      this.locationStateCache = {
        primaryTarget: next.primaryTarget,
        splitTarget: next.splitTarget,
        workbenchOpen: next.workbenchOpen,
        workbenchTab: next.workbenchTab,
        activeModal: next.activeModal,
      }
      plan.domains.add('locationState')
    }
    if (highlightChanged) {
      plan.domains.add('highlightedEntry')
      if (prev.highlightedEntry !== null) plan.highlightIds.add(prev.highlightedEntry.conversationId)
      if (next.highlightedEntry !== null) plan.highlightIds.add(next.highlightedEntry.conversationId)
    }

    if (!deferEmit) this.emit(plan)
  }

  // ---- Preferences Actions --------------------------------------------------

  setThemePreference = (pref: ThemePreference): void => {
    const effective = resolveTheme(pref)
    applyDocumentTheme(effective)
    persistThemePreference(pref)
    this.patchPrefs({ themePreference: pref, theme: effective })
  }

  setTheme = (next: ThemeMode): void => {
    this.setThemePreference(next)
  }

  toggleTheme = (): void => {
    this.setThemePreference(nextThemePreference(this.prefsState.themePreference))
  }

  setLocalePreference = (next: LocalePreference): void => {
    const effective = resolveLocale(next)
    applyDocumentLocale(effective)
    persistLocalePreference(next)
    this.patchPrefs({ localePreference: next, locale: effective })
  }

  setLocale = (next: HelmxLocale): void => {
    this.setLocalePreference(next)
  }

  setQuietNotify = async (on: boolean): Promise<void> => {
    if (!on) {
      persistQuietNotify(false)
      this.patchPrefs({ quietNotifyEnabled: false })
      return
    }
    const permission = await requestBrowserNotificationPermission()
    if (permission === 'unsupported') {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.translate({ en: 'Notifications unsupported in this browser', 'zh-CN': '当前浏览器不支持通知' }),
        body: this.translate({
          en: 'The browser notification API is unavailable, so background notification alerts cannot be enabled.',
          'zh-CN': '浏览器通知 API 不可用，无法开启后台通知提醒。',
        }),
      })
      return
    }
    if (permission !== 'granted') {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.translate({ en: 'Browser notification permission not granted', 'zh-CN': '浏览器通知权限未授予' }),
        body: this.translate({
          en: 'Allow notifications in the browser site settings, then enable background notifications again.',
          'zh-CN': '请在浏览器站点设置中允许通知后重新开启。',
        }),
      })
      return
    }
    persistQuietNotify(true)
    this.patchPrefs({ quietNotifyEnabled: true })
  }

  // ---- Notices & Auth & Logout ----------------------------------------------

  dismissNotice = (id: string): void => {
    if (!this.noticesState.some((item) => item.id === id)) return
    this.setNotices((prev) => prev.filter((notice) => notice.id !== id))
  }

  pushNotice = (notice: Omit<ToastNotice, 'id' | 'createdAt'>): void => {
    const id = `notice-${++this.noticeSequence}`
    this.setNotices((prev) => [
      ...prev.filter((item) => item.title !== notice.title || item.body !== notice.body),
      { ...notice, id, createdAt: Date.now() },
    ])
    if (notice.level === 'info') {
      this.requests.delay(() => this.dismissNotice(id), 6000)
    }
  }

  checkAuth = async (): Promise<void> => {
    this.patchAuth({ authError: null })
    try {
      const status = await authApi.status()
      this.patchAuth({ authConfigured: status.configured, authenticated: status.authenticated, authReady: true })
    } catch (error) {
      this.patchAuth({
        authReady: true,
        authError: this.translate({
          en: `Cannot connect to the Helmx kernel: ${errorText(error)}`,
          'zh-CN': `无法连接 Helmx 内核：${errorText(error)}`,
        }),
      })
    }
  }

  onAuthenticated = async (token: string): Promise<void> => {
    setStoredToken(token)
    this.patchAuth({ authConfigured: true, authError: null, authenticated: true })
  }

  /** Resets non-URL refs, timers, and caches before the provider resets window.history. */
  prepareLogoutHistoryReset(): void {
    this.clearEscTimer()
    this.requests.resetOnLogout()
    this.sseCursorRef.current = null
    resetStandbyDrafts()
    resetPluginClientCache()
    resetSessionDocSubscriptions()
    setStoredToken(null)
    this.lastSyncedLocation.current = parseLocationHash('#/settings/profiles')
    this.pendingHistoryMode.current = null
  }

  /** Clears all reactive store slices in one atomic batch on logout. */
  finishLogoutStateReset(): void {
    const plan = emptyPlan()
    this.patchAuth({ authenticated: false, sseConnected: false, connectionError: null }, plan, true)
    this.spaceMemory = { settings: { kind: 'profiles' } }
    this.patchNav(
      {
        activeModal: null,
        splitTarget: null,
        focusedPanel: 'primary',
        primaryTarget: { kind: 'profiles' },
        workbenchOpen: false,
        workbenchTab: 'artifacts',
        pendingEscAbortConversationId: null,
        highlightedEntry: null,
      },
      plan,
      true,
    )
    this.updateLive(emptyLiveState, plan, true)
    this.setConversationArtifacts({}, plan, true)
    this.setLoadErrors({}, plan, true)
    if (this.noticesState.some((item) => item.id === ESC_ABORT_NOTICE_ID)) {
      this.setNotices((prev) => prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID), plan, true)
    }
    this.patchCatalog(
      {
        profilesLoaded: false,
        assetsLoaded: false,
        profiles: [],
        models: [],
        providers: [],
        credentials: [],
        skills: [],
        actions: [],
      },
      plan,
      true,
    )
    this.emit(plan)
  }

  // ---- Assets, Plugins & Nodes ----------------------------------------------

  refreshAssets = async (): Promise<void> => {
    const { generation, controller } = this.requests.beginAssetRefresh()
    const signal = controller.signal
    const isStale = (): boolean => generation !== this.requests.assetGeneration.current || signal.aborted

    const profilesTask = assetsApi.listProfiles({ signal }).then(
      (list) => {
        if (isStale()) return
        const plan = emptyPlan()
        this.patchCatalog({ profiles: list, profilesLoaded: true }, plan, true)
        if (Object.hasOwn(this.loadErrorsState, 'assets:profiles')) {
          const nextErrors = { ...this.loadErrorsState }
          delete nextErrors['assets:profiles']
          this.setLoadErrors(nextErrors, plan, true)
        }
        this.emit(plan)
      },
      (reason: unknown) => {
        if (isAbortError(reason) || isStale()) return
        const plan = emptyPlan()
        this.patchCatalog({ profilesLoaded: true }, plan, true)
        const nextMessage = errorText(reason)
        if (this.loadErrorsState['assets:profiles'] !== nextMessage) {
          this.setLoadErrors({ ...this.loadErrorsState, 'assets:profiles': nextMessage }, plan, true)
        }
        this.emit(plan)
        this.pushNotice({
          type: 'notification',
          level: 'error',
          title: this.translate(ASSET_LOAD_FAILURE_TITLES[0]!),
          body: nextMessage,
        })
      },
    )

    const otherTasks = Promise.allSettled([
      assetsApi.listModels({ signal }),
      assetsApi.listProviders({ signal }),
      assetsApi.listCredentials({ signal }),
      assetsApi.listSkills({ signal }),
      pluginsApi.listActions({ signal }),
    ]).then((results) => {
      if (isStale()) return
      const patch: Partial<CatalogSlice> = {}
      if (results[0].status === 'fulfilled') patch.models = results[0].value
      if (results[1].status === 'fulfilled') patch.providers = results[1].value
      if (results[2].status === 'fulfilled') patch.credentials = results[2].value
      if (results[3].status === 'fulfilled') patch.skills = results[3].value
      if (results[4].status === 'fulfilled') patch.actions = results[4].value
      this.patchCatalog(patch)
      results.forEach((result, index) => {
        if (result.status === 'rejected' && !isAbortError(result.reason)) {
          this.pushNotice({
            type: 'notification',
            level: 'error',
            title: this.translate(ASSET_LOAD_FAILURE_TITLES[index + 1]!),
            body: errorText(result.reason),
          })
        }
      })
    })

    await Promise.all([profilesTask, otherTasks])
    if (isStale()) return
    this.requests.finishAssetRefresh(controller)
    this.patchCatalog({ assetsLoaded: true })
  }

  syncPlugins = (next: PluginSummary[]): void => {
    if (!Array.isArray(next)) return
    this.updateLive((state) => {
      const byId = new Map(state.plugins.map((p) => [p.id, p]))
      const merged = next.map((incoming) => {
        const local = byId.get(incoming.id)
        return local && local.enabled === incoming.enabled ? local : incoming
      })
      return { ...state, plugins: merged }
    })
  }

  refreshNodes = async (): Promise<NodeInfo[] | undefined> => {
    const epoch = this.requests.session.current
    const nodesBeforeRequest = this.liveState.nodes
    try {
      const list = await nodesApi.list()
      if (epoch !== this.requests.session.current) return undefined
      const sorted = sortNodes(list)
      this.updateLive((state) => (state.nodes === nodesBeforeRequest ? { ...state, nodes: sorted } : state))
      return this.liveState.nodes
    } catch (error) {
      if (epoch === this.requests.session.current) {
        this.pushNotice({
          type: 'notification',
          level: 'error',
          title: this.translate({ en: 'Compute nodes failed to load', 'zh-CN': '计算节点加载失败' }),
          body: errorText(error),
        })
      }
      return undefined
    }
  }

  // ---- Conversations & Plugin Docs Requests ---------------------------------

  loadConversationDetail = async (
    id: number,
    force = false,
    opts?: { silent?: boolean; limit?: number },
  ): Promise<ConversationDetail | undefined> => {
    const key = `conversation:${id}`
    const existing = this.requests.requests.current.get(key)
    if (existing) return existing as Promise<ConversationDetail | undefined>
    if (!force && this.liveState.conversationDetails[id]) return this.liveState.conversationDetails[id]

    const silent = opts?.silent === true
    const hasCached = this.liveState.conversationDetails[id] !== undefined
    const limit = opts?.limit ?? defaultConversationDetailLimit()

    return this.requests.runControlled({
      key,
      onStart: () => {
        if (!silent || !hasCached) this.reportLoad(key)
      },
      onError: (error) => {
        if (!silent || this.liveState.conversationDetails[id] === undefined) {
          this.reportLoad(key, error)
        }
      },
      exec: async ({ signal, isStale }) => {
        const detail = await conversationsApi.getDetail(id, { limit, signal })
        if (isStale()) return undefined
        const plan = emptyPlan()
        if (Object.hasOwn(this.loadErrorsState, key)) {
          const nextErrors = { ...this.loadErrorsState }
          delete nextErrors[key]
          this.setLoadErrors(nextErrors, plan, true)
        }
        this.updateLive((state) => mergeConversationDetail(state, detail), plan, true)
        this.emit(plan)
        return detail
      },
    })
  }

  loadEarlierEntries = async (id: number): Promise<void> => {
    const detail = this.liveState.conversationDetails[id]
    if (!detail?.nextCursor) return
    const key = `history:${id}`
    if (this.requests.requests.current.has(key)) return
    const limit = defaultConversationDetailLimit()
    const cursor = detail.nextCursor

    await this.requests.runControlled<void>({
      key,
      onStart: () => {
        this.reportLoad(key)
      },
      onError: (error) => {
        this.reportLoad(key, error)
      },
      exec: async ({ signal, isStale }) => {
        const page = await conversationsApi.getDetail(id, { limit, cursor, signal })
        if (isStale()) return undefined
        this.updateLive((state) => mergeConversationDetail(state, page, true))
        return undefined
      },
    })
  }

  backfillConversationEntry = (conversationId: number, entry: ConversationEntry): void => {
    this.updateLive((state) => applyConversationEntry(state, conversationId, entry))
  }

  loadConversationArtifacts = async (
    id: number,
    opts?: { silent?: boolean },
  ): Promise<ArtifactMetadata[] | undefined> => {
    const key = `artifacts:${id}`
    const existing = this.requests.requests.current.get(key)
    if (existing) {
      const latest = this.summaryById.get(id) ?? this.liveState.conversationDetails[id]
      const inFlight = this.requests.artifactsInFlight.get(id)
      const latestActive = latest !== undefined && isConversationStatusActive(latest.status)
      if (
        latest !== undefined &&
        !latestActive &&
        (inFlight === undefined ||
          inFlight.active ||
          inFlight.watermark === undefined ||
          inFlight.watermark.stateChangeSeq !== latest.stateChangeSeq ||
          inFlight.watermark.lastEntryId !== latest.lastEntryId)
      ) {
        this.requests.dirtyArtifacts.add(id)
      }
      return existing as Promise<ArtifactMetadata[] | undefined>
    }

    const silent = opts?.silent === true
    const hasCached = this.artifactsState[id] !== undefined
    const sampledSummary = this.summaryById.get(id)
    const sampledActive = sampledSummary !== undefined && isConversationStatusActive(sampledSummary.status)
    const sampledWatermark =
      sampledSummary !== undefined && !sampledActive
        ? { stateChangeSeq: sampledSummary.stateChangeSeq, lastEntryId: sampledSummary.lastEntryId }
        : undefined
    const sessionEpoch = this.requests.session.current
    const reqEpochBefore = this.requests.requestEpochs.get(key) ?? 0
    this.requests.artifactsInFlight.set(id, { active: sampledActive, watermark: sampledWatermark })
    this.requests.dirtyArtifacts.delete(id)

    const result = await this.requests.runControlled({
      key,
      onStart: () => {
        if (!silent || !hasCached) this.reportLoad(key)
      },
      onError: (error) => {
        if (!silent || this.artifactsState[id] === undefined) {
          this.reportLoad(key, error)
          this.pushNotice({
            type: 'notification',
            level: 'error',
            title: this.translate({ en: 'Conversation artifacts failed to load', 'zh-CN': '会话产物加载失败' }),
            body: errorText(error),
            conversationId: id,
          })
        }
      },
      exec: async ({ signal, isStale }) => {
        const list = await conversationsApi.listArtifacts(id, { signal })
        if (isStale()) return undefined
        const plan = emptyPlan()
        if (Object.hasOwn(this.loadErrorsState, key)) {
          const nextErrors = { ...this.loadErrorsState }
          delete nextErrors[key]
          this.setLoadErrors(nextErrors, plan, true)
        }
        const reconciled = reconcileArtifactList(this.artifactsState[id], list)
        this.setConversationArtifacts(
          (prev) => (prev[id] === reconciled ? prev : { ...prev, [id]: reconciled }),
          plan,
          true,
        )
        this.emit(plan)
        const latestSummary = this.summaryById.get(id) ?? this.liveState.conversationDetails[id]
        const latestActive = latestSummary !== undefined && isConversationStatusActive(latestSummary.status)
        if (!sampledActive && !latestActive && !this.requests.dirtyArtifacts.has(id)) {
          const resolvedWatermark =
            sampledWatermark ??
            (latestSummary !== undefined
              ? { stateChangeSeq: latestSummary.stateChangeSeq, lastEntryId: latestSummary.lastEntryId }
              : undefined)
          if (resolvedWatermark !== undefined) this.requests.artifactsWatermarks.current.set(id, resolvedWatermark)
          else this.requests.artifactsWatermarks.current.delete(id)
        } else {
          this.requests.artifactsWatermarks.current.delete(id)
        }
        return reconciled
      },
    })

    if (sessionEpoch === this.requests.session.current && (this.requests.requestEpochs.get(key) ?? 0) === reqEpochBefore + 1) {
      this.requests.artifactsInFlight.delete(id)
      if (this.requests.dirtyArtifacts.delete(id)) {
        return await this.loadConversationArtifacts(id, { silent: true })
      }
    }
    return result
  }

  ensurePluginDoc = async (pluginId: string, name: string): Promise<unknown> => {
    const docKey = `${pluginId}/${name}`
    const key = `doc:${docKey}`
    if (Object.hasOwn(this.liveState.pluginDocs, docKey)) return this.liveState.pluginDocs[docKey]
    if (this.requests.failedDocs.current.has(key)) return undefined
    const existing = this.requests.requests.current.get(key)
    if (existing) return existing

    const epoch = this.requests.session.current
    const pluginVersion = this.requests.pluginEpoch.current.get(pluginId)
    const task = pluginsApi
      .getPublicDoc(pluginId, name)
      .then((doc) => {
        if (epoch !== this.requests.session.current || pluginVersion !== this.requests.pluginEpoch.current.get(pluginId)) {
          return undefined
        }
        this.updateLive((state) => {
          if (Object.hasOwn(state.pluginDocs, docKey) || !state.plugins.some((p) => p.id === pluginId && p.enabled)) {
            return state
          }
          return { ...state, pluginDocs: { ...state.pluginDocs, [docKey]: doc.value } }
        })
        return doc.value
      })
      .catch((error: unknown) => {
        if (epoch === this.requests.session.current && pluginVersion === this.requests.pluginEpoch.current.get(pluginId)) {
          this.requests.failedDocs.current.add(key)
          this.reportLoad(key, error)
          this.pushNotice({
            type: 'notification',
            level: 'error',
            title: this.translate({ en: 'Plugin state failed to load', 'zh-CN': '插件状态读取失败' }),
            body: this.translate({
              en: `${pluginId}/${name}: ${errorText(error)}`,
              'zh-CN': `${pluginId}/${name}：${errorText(error)}`,
            }),
          })
        }
        return undefined
      })
      .finally(() => {
        if (this.requests.requests.current.get(key) === task) this.requests.requests.current.delete(key)
      })
    this.requests.requests.current.set(key, task)
    return task
  }

  getPluginSessionDoc = async (pluginId: string, docName: string, conversationId: number): Promise<unknown> => {
    const doc = await pluginsApi.getPublicSessionDoc(pluginId, docName, conversationId)
    return doc.value
  }

  invokePluginAction = async (pluginId: string, actionId: string, input: unknown, conversationId?: number) =>
    pluginsApi.invokeAction(pluginId, actionId, input, conversationId)

  // ---- Navigation, Shortcuts & Esc-Abort ------------------------------------

  /** 空间记忆写入的唯一入口：总览是有专属入口的顶层目的地，不占对话空间
   *  的记忆位——boot 初始化、程序导航（applyPrimaryTarget/openTarget）与
   *  hashchange 同步（applyExternalLocation）全部经此收敛，「对话」空间按钮
   *  永远跳回最近的真实会话/待命目标，绝不被总览劫持（含 #/overview 直达
   *  后的刷新场景）。 */
  private rememberSpaceTarget(target: ResolvedTarget): void {
    if (target.kind === 'overview') return
    this.spaceMemory[spaceForTarget(target)] = target
  }

  applyPrimaryTarget = (target: ResolvedTarget): void => {
    this.rememberSpaceTarget(target)
    this.patchNav({ primaryTarget: target })
  }

  setSplitTarget = (update: StoreUpdater<ResolvedTarget | null>): void => {
    const next = applyUpdater(this.navState.splitTarget, update)
    this.patchNav({ splitTarget: next })
  }

  setFocusedPanel = (panel: FocusedPanel): void => {
    const next = resolveFocusedPanel(panel, this.navState.splitTarget)
    this.patchNav({ focusedPanel: next })
  }

  closeSplit = (): void => {
    this.patchNav({ splitTarget: null, focusedPanel: 'primary' })
  }

  setSidebarCollapsed = (collapsed: boolean): void => {
    persistSidebarCollapsed(collapsed)
    this.patchNav({ sidebarCollapsed: collapsed })
  }

  toggleSidebarCollapsed = (): void => {
    const next = !this.navState.sidebarCollapsed
    persistSidebarCollapsed(next)
    this.patchNav({ sidebarCollapsed: next })
  }

  setWorkbenchOpen = (update: StoreUpdater<boolean>): void => {
    const next = applyUpdater(this.navState.workbenchOpen, update)
    this.patchNav({ workbenchOpen: next })
  }

  setWorkbenchTab = (update: StoreUpdater<string>): void => {
    const next = applyUpdater(this.navState.workbenchTab, update)
    this.patchNav({ workbenchTab: next })
  }

  setActiveModal = (update: StoreUpdater<ActiveModal>): void => {
    const next = applyUpdater(this.navState.activeModal, update)
    const patch: Partial<NavSlice> = { activeModal: next }
    // 打开会话抽屉即离开工作台「抬升态」：收起旧工作台，避免它隐藏在抽屉之下
    // 却仍占据 workbenchOpen 语义（工作台改为绑定抽屉会话，经抽屉内按钮显式
    // 重新打开、叠于抽屉之上）。深链恢复（applyExternalLocation）不走此路径，
    // `wb` + `modal=drawer` 组合态仍可精确还原。
    if (next?.kind === 'conversation-drawer') patch.workbenchOpen = false
    this.patchNav(patch)
  }

  openTarget = (
    target: string | ResolvedTarget,
    opts?: { split?: boolean; highlightEntryId?: string; history?: 'push' | 'replace' },
  ): void => {
    const resolved = typeof target === 'string' ? resolveTargetString(target, this.liveState.conversations) : target
    if (!resolved) {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.tt('shell.nav.targetNotReady'),
        body: typeof target === 'string' ? target : this.tt('shell.nav.invalidTarget'),
      })
      return
    }
    if (opts?.history !== undefined) this.pendingHistoryMode.current = opts.history
    const patch: Partial<NavSlice> = {}
    if (opts?.split) {
      patch.splitTarget = resolved
    } else {
      // 总览不占对话空间记忆位（rememberSpaceTarget 内置守卫，见其注释）。
      this.rememberSpaceTarget(resolved)
      patch.primaryTarget = resolved
      // 主屏导航离开当前视图时收起覆盖型会话抽屉：抽屉内徽标/通知等触发的
      // openTarget 若不收抽屉，新目标被全高抽屉遮挡，表现为「点击无反应」。
      // 深链恢复（applyExternalLocation）不走此路径，wb+modal=drawer 组合仍可精确还原。
      if (this.navState.activeModal?.kind === 'conversation-drawer') patch.activeModal = null
    }
    if (resolved.kind === 'conversation' && opts?.highlightEntryId) {
      patch.highlightedEntry = { conversationId: resolved.conversationId, entryId: opts.highlightEntryId }
    }
    this.patchNav(patch)
  }

  openSpace = (space: SidebarSpace): void => {
    const input: SpaceTargetInput = {
      conversations: this.liveState.conversations,
      profiles: this.catalogState.profiles,
      plugins: this.liveState.plugins,
      assetsLoaded: this.catalogState.profilesLoaded || this.catalogState.assetsLoaded,
      grouped: this.groupedUi,
    }
    const resolution = resolveSpaceSwitch(space, this.navState.primaryTarget, this.spaceMemory, input)
    if (resolution.kind === 'already-in-space') return
    if (resolution.clearStaleMemory) delete this.spaceMemory[space]
    if (resolution.kind === 'unavailable') {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.tt('shell.nav.noOpenableEntry'),
        body: space === 'views' ? this.tt('shell.nav.noViewsBody') : this.tt('shell.nav.noConversationsBody'),
      })
      return
    }
    this.openTarget(resolution.target, { history: 'push' })
  }

  setScreenParams = (
    patch: Record<string, string | undefined>,
    options?: { split?: boolean; push?: boolean },
  ): void => {
    const { validEntries, invalidKeys } = partitionScreenParamsPatch(patch)
    for (const key of invalidKeys) {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.translate({ en: 'Ignored invalid Screen parameter key', 'zh-CN': '已忽略非法 Screen 参数键' }),
        body: this.translate({
          en: `Parameter ${key} must use a valid key and a string value`,
          'zh-CN': `参数 ${key} 必须使用合法键和字符串值`,
        }),
      })
    }
    const currentTarget = options?.split ? this.navState.splitTarget : this.navState.primaryTarget
    if (validEntries.length === 0 || currentTarget?.kind !== 'screen') return
    if (options?.push) this.pendingHistoryMode.current = 'push'
    if (options?.split) {
      this.setSplitTarget((current) => (current === null ? current : applyScreenParamsPatch(current, validEntries)))
    } else {
      this.applyPrimaryTarget(applyScreenParamsPatch(currentTarget, validEntries))
    }
  }

  applyExternalLocation = (parsed: WorkspaceLocationState): void => {
    this.pendingHistoryMode.current = null
    this.lastSyncedLocation.current = parsed
    this.rememberSpaceTarget(parsed.primaryTarget)
    this.patchNav({
      primaryTarget: parsed.primaryTarget,
      splitTarget: parsed.splitTarget,
      workbenchOpen: parsed.workbenchOpen,
      workbenchTab: parsed.workbenchTab,
      activeModal: parsed.activeModal,
    })
  }

  performHomeLanding(initialLocation: WorkspaceLocationState): void {
    if (!isSameLocationState(this.locationStateCache, initialLocation)) return
    const input: SpaceTargetInput = {
      conversations: this.liveState.conversations,
      profiles: this.catalogState.profiles,
      plugins: this.liveState.plugins,
      assetsLoaded: this.catalogState.profilesLoaded || this.catalogState.assetsLoaded,
      grouped: this.groupedUi,
    }
    // 并发主入口：非全新系统（存在可见根会话树，与总览暴露边界同口径）冷
    // 启动以 replace 落到会话总览；全新/清空系统回退对话空间缺省目标
    // （最新根会话所属角色的待命页，无会话时首个可用角色），保住首次
    // 部署打开即能打字的体验。
    if (hasVisibleConversationRoots(input)) {
      this.openTarget({ kind: 'overview' }, { history: 'replace' })
      return
    }
    const home = defaultSpaceTarget('conversations', input)
    if (home === null) return
    this.openTarget(home, { history: 'replace' })
  }

  stepHighlightedEntry(): void {
    const current = this.navState.highlightedEntry
    if (current === null) return
    const detail = this.liveState.conversationDetails[current.conversationId]
    if (!detail) return
    const matched = detail.entries.find((entry) => entryMatchesReference(entry, current.entryId))
    if (matched) {
      if (matched.id !== current.entryId) {
        this.patchNav({ highlightedEntry: { ...current, entryId: matched.id } })
        return
      }
      this.requests.delay(() => {
        if (this.navState.highlightedEntry === current) {
          this.patchNav({ highlightedEntry: null })
        }
      }, 5000)
    } else if (detail.nextCursor && !this.loadErrorsState[`history:${detail.id}`]) {
      void this.loadEarlierEntries(detail.id)
    } else if (!detail.nextCursor) {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.tt('shell.nav.searchEntryGone'),
        conversationId: detail.id,
      })
      this.patchNav({ highlightedEntry: null })
    }
  }

  clearEscAbortPrompt = (): void => {
    this.clearEscTimer()
    const plan = emptyPlan()
    if (this.navState.pendingEscAbortConversationId !== null) {
      this.patchNav({ pendingEscAbortConversationId: null }, plan, true)
    }
    if (this.noticesState.some((item) => item.id === ESC_ABORT_NOTICE_ID)) {
      this.setNotices((prev) => prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID), plan, true)
    }
    this.emit(plan)
  }

  private armEscAbortPrompt(conversationId: number): void {
    this.clearEscTimer()
    const plan = emptyPlan()
    this.patchNav({ pendingEscAbortConversationId: conversationId }, plan, true)
    this.setNotices(
      (prev) => [
        ...prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID),
        {
          id: ESC_ABORT_NOTICE_ID,
          type: 'notification',
          level: 'warning',
          title: this.tt('shell.esc.confirmTitle'),
          body: this.tt('shell.esc.confirmBody'),
          conversationId,
          createdAt: Date.now(),
        },
      ],
      plan,
      true,
    )
    this.emit(plan)

    this.escAbortTimer = setTimeout(() => {
      this.escAbortTimer = null
      this.clearEscAbortPrompt()
    }, ESC_ABORT_WINDOW_MS)
  }

  confirmOrArmEscAbort = (conversationId: number): void => {
    if (this.navState.pendingEscAbortConversationId === conversationId) {
      this.clearEscAbortPrompt()
      void conversationsApi.abort(conversationId).catch((error: unknown) => {
        this.pushNotice({
          type: 'notification',
          level: 'error',
          title: this.tt('shell.esc.abortFailedTitle'),
          body: errorText(error),
          conversationId,
        })
      })
    } else {
      this.armEscAbortPrompt(conversationId)
    }
  }
}
