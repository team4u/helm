import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import type {
  ActionManifest,
  ArtifactMetadata,
  AskSpec,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
  CredentialSummary,
  HelmLocale,
  NodeInfo,
  PluginSummary,
  ProviderConfig,
  SkillSummary,
} from '@helm/protocol/browser'
import type { ModelDescriptor } from './api.js'
import type {
  AuthSlice,
  CatalogSlice,
  HelmExternalStore,
  HelmStoreActions,
  LocationTargetsSlice,
  NavSlice,
  PluginHostPortSlice,
  PluginsUiSlice,
  PrefsSlice,
  ProfilesSlice,
  ResolvedAskEntry,
  StoreDomainKey,
  WorkbenchSlice,
} from './helm-store.js'
import type { SessionDocKey } from './session-docs.js'
import type {
  ActiveModal,
  FocusedPanel,
  GroupedUiSpecs,
  HelmStoreValue,
  ResolvedTarget,
  ThemeMode,
  ToastNotice,
} from './types.js'
import type { WorkspaceLocationState } from './url-hash-model.js'

export const HelmStoreContext = createContext<HelmStoreValue | null>(null)
export const HelmExternalStoreContext = createContext<HelmExternalStore | null>(null)

const UNSET = Symbol('helm-store-unset')
const NOOP_UNSUBSCRIBE = () => {}
const NOOP_SUBSCRIBE = () => NOOP_UNSUBSCRIBE

function subscribeLiveById(store: HelmExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationLive(id, listener)
}
function readLiveById(store: HelmExternalStore, id: number): ConversationLive | undefined {
  return store.getConversationLive(id)
}
function readLegacyLiveById(legacy: HelmStoreValue, id: number): ConversationLive | undefined {
  return legacy.conversationLives?.[id]
}

function subscribeDetailById(store: HelmExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationDetail(id, listener)
}
function readDetailById(store: HelmExternalStore, id: number): ConversationDetail | undefined {
  return store.getConversationDetail(id)
}
function readLegacyDetailById(legacy: HelmStoreValue, id: number): ConversationDetail | undefined {
  return legacy.conversationDetails?.[id]
}

function subscribeSummaryById(store: HelmExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationSummary(id, listener)
}
function readSummaryById(store: HelmExternalStore, id: number): ConversationSummary | undefined {
  return store.getConversationSummary(id)
}
function readLegacySummaryById(legacy: HelmStoreValue, id: number): ConversationSummary | undefined {
  return legacy.conversations?.find((c) => c.id === id)
}

function subscribeArtifactsById(store: HelmExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationArtifacts(id, listener)
}
function readArtifactsById(store: HelmExternalStore, id: number): ArtifactMetadata[] | undefined {
  return store.getConversationArtifacts(id)
}
function readLegacyArtifactsById(legacy: HelmStoreValue, id: number): ArtifactMetadata[] | undefined {
  return legacy.conversationArtifacts?.[id]
}

function subscribeResolvedAsksById(store: HelmExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeResolvedAsks(id, listener)
}
function readResolvedAsksById(store: HelmExternalStore, id: number): ResolvedAskEntry[] | undefined {
  return store.getResolvedAsks(id)
}
function readLegacyResolvedAsksById(legacy: HelmStoreValue, id: number): ResolvedAskEntry[] | undefined {
  return legacy.resolvedAsksByConv?.[id]
}

function subscribeHighlightById(store: HelmExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeHighlightForConversation(id, listener)
}
function readHighlightById(store: HelmExternalStore, id: number): { conversationId: number; entryId: string } | null {
  return store.getHighlightedEntryForConversation(id)
}
function readLegacyHighlightById(legacy: HelmStoreValue, id: number): { conversationId: number; entryId: string } | null {
  return legacy.highlightedEntry?.conversationId === id ? legacy.highlightedEntry : null
}

function subscribeLoadErrorKey(store: HelmExternalStore, key: string, listener: () => void): () => void {
  return store.subscribeLoadError(key, listener)
}
function readLoadErrorKey(store: HelmExternalStore, key: string): string | undefined {
  return store.getLoadError(key)
}
function readLegacyLoadErrorKey(legacy: HelmStoreValue, key: string): string | undefined {
  return legacy.loadErrors?.[key]
}

function subscribePluginDocKey(store: HelmExternalStore, docKey: string, listener: () => void): () => void {
  return store.subscribePluginDoc(docKey, listener)
}
function readPluginDocKey(store: HelmExternalStore, docKey: string): unknown {
  return store.getPluginDoc(docKey)
}
function readLegacyPluginDocKey(legacy: HelmStoreValue, docKey: string): unknown {
  return legacy.pluginDocs !== undefined && legacy.pluginDocs !== null && Object.hasOwn(legacy.pluginDocs, docKey)
    ? legacy.pluginDocs[docKey]
    : undefined
}

function useDomainSlice<T>(
  domain: StoreDomainKey,
  fromExternal: (store: HelmExternalStore) => T,
  fromLegacy: (legacy: HelmStoreValue) => T,
  fallback?: () => T,
): T {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  const subscribe = useCallback(
    (listener: () => void) => (external !== null ? external.subscribeDomain(domain, listener) : NOOP_UNSUBSCRIBE),
    [external, domain],
  )
  const getSnapshot = (): T | typeof UNSET => (external !== null ? fromExternal(external) : UNSET)
  const extValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (extValue !== UNSET) return extValue
  if (legacy !== null) return fromLegacy(legacy)
  if (fallback !== undefined) return fallback()
  throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
}

function useKeyedSlice<K, T>(
  subscribeForKey: (store: HelmExternalStore, key: K, listener: () => void) => () => void,
  fromExternal: (store: HelmExternalStore, key: K) => T,
  fromLegacy: (legacy: HelmStoreValue, key: K) => T,
  key: K | undefined,
  emptyValue: T,
): T {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  const subscribe = useCallback(
    (listener: () => void) =>
      external !== null && key !== undefined ? subscribeForKey(external, key, listener) : NOOP_UNSUBSCRIBE,
    [external, subscribeForKey, key],
  )
  const getSnapshot = (): T | typeof UNSET =>
    external !== null ? (key !== undefined ? fromExternal(external, key) : emptyValue) : UNSET
  const extValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (extValue !== UNSET) return extValue
  if (legacy !== null) return key !== undefined ? fromLegacy(legacy, key) : emptyValue
  throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
}

/**
 * Full store snapshot hook (backwards-compatible with test doubles and coarse
 * consumers; subscribes to all domains, so production components should prefer
 * sliced hooks below).
 */
export function useHelmStore(): HelmStoreValue {
  return useDomainSlice(
    'all',
    (s) => s.getSnapshot(),
    (l) => l,
  )
}

/** Stable store action bundle (never triggers re-renders inside <HelmStoreProvider>). */
export function useStoreActions(): HelmStoreActions {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  if (external !== null) return external.actions
  if (legacy !== null) return legacy
  throw new Error('useStoreActions must be called inside <HelmStoreProvider>')
}

export function useOptionalStoreActions(): HelmStoreActions | null {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  if (external !== null) return external.actions
  return legacy
}

/** Direct imperative reference to external store (for event handlers that read without subscribing). */
export function useHelmExternalStore(): HelmExternalStore | null {
  return useContext(HelmExternalStoreContext)
}

// ---- Narrow Domain Hooks --------------------------------------------------

export function useAuthConnection(): AuthSlice {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  const subscribe = useCallback(
    (listener: () => void) => (external !== null ? external.subscribeDomain('auth', listener) : NOOP_UNSUBSCRIBE),
    [external],
  )
  const getSnapshot = (): AuthSlice | typeof UNSET => (external !== null ? external.getAuthSlice() : UNSET)
  const extValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const legacySlice = useMemo<AuthSlice | null>(
    () =>
      legacy === null
        ? null
        : {
            authReady: legacy.authReady,
            authConfigured: legacy.authConfigured,
            authenticated: legacy.authenticated,
            authError: legacy.authError,
            sseConnected: legacy.sseConnected,
            connectionError: legacy.connectionError,
            kernelBootId: legacy.kernelBootId ?? null,
          },
    [legacy],
  )
  if (extValue !== UNSET) return extValue
  if (legacySlice !== null) return legacySlice
  throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
}

export function useAuthenticated(): boolean {
  return useDomainSlice('authenticated', (s) => s.getAuthenticated(), (l) => l.authenticated)
}

export function useSseConnected(): boolean {
  return useDomainSlice('sseConnected', (s) => s.getSseConnected(), (l) => l.sseConnected)
}

export function useThemePreferencesState(): PrefsSlice {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  const subscribe = useCallback(
    (listener: () => void) => (external !== null ? external.subscribeDomain('prefs', listener) : NOOP_UNSUBSCRIBE),
    [external],
  )
  const getSnapshot = (): PrefsSlice | typeof UNSET => (external !== null ? external.getPrefsSlice() : UNSET)
  const extValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const legacySlice = useMemo<PrefsSlice | null>(
    () =>
      legacy === null
        ? null
        : {
            theme: legacy.theme,
            themePreference: legacy.themePreference,
            locale: legacy.locale,
            localePreference: legacy.localePreference ?? legacy.locale,
            quietNotifyEnabled: legacy.quietNotifyEnabled,
          },
    [legacy],
  )
  if (extValue !== UNSET) return extValue
  if (legacySlice !== null) return legacySlice
  throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
}

export function useOptionalLocale(): HelmLocale | undefined {
  return useDomainSlice(
    'locale',
    (s) => s.getLocale(),
    (l) => l.locale,
    () => undefined,
  )
}

export function useThemeMode(): ThemeMode {
  return useDomainSlice('theme', (s) => s.getPrefsSlice().theme, (l) => l.theme)
}

export function useQuietNotifyEnabled(): boolean {
  return useDomainSlice('quietNotify', (s) => s.getPrefsSlice().quietNotifyEnabled, (l) => l.quietNotifyEnabled)
}

export function useProfilesSlice(): ProfilesSlice {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  const subscribe = useCallback(
    (listener: () => void) => (external !== null ? external.subscribeDomain('profiles', listener) : NOOP_UNSUBSCRIBE),
    [external],
  )
  const getSnapshot = (): ProfilesSlice | typeof UNSET => (external !== null ? external.getProfilesSlice() : UNSET)
  const extValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const legacySlice = useMemo<ProfilesSlice | null>(
    () =>
      legacy === null
        ? null
        : {
            profiles: legacy.profiles,
            profilesLoaded: legacy.profilesLoaded,
            assetsLoaded: legacy.assetsLoaded,
          },
    [legacy],
  )
  if (extValue !== UNSET) return extValue
  if (legacySlice !== null) return legacySlice
  throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
}

export function useCatalogAssets(): CatalogSlice {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  const subscribe = useCallback(
    (listener: () => void) => (external !== null ? external.subscribeDomain('catalog', listener) : NOOP_UNSUBSCRIBE),
    [external],
  )
  const getSnapshot = (): CatalogSlice | typeof UNSET => (external !== null ? external.getCatalogSlice() : UNSET)
  const extValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const legacySlice = useMemo<CatalogSlice | null>(
    () =>
      legacy === null
        ? null
        : {
            profiles: legacy.profiles,
            profilesLoaded: legacy.profilesLoaded,
            assetsLoaded: legacy.assetsLoaded,
            models: legacy.models,
            providers: legacy.providers,
            credentials: legacy.credentials,
            skills: legacy.skills,
            actions: legacy.actions,
          },
    [legacy],
  )
  if (extValue !== UNSET) return extValue
  if (legacySlice !== null) return legacySlice
  throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
}

export function useModels(): ModelDescriptor[] {
  return useDomainSlice('models', (s) => s.getModels(), (l) => l.models)
}

export function useOptionalModels(): ModelDescriptor[] | undefined {
  return useDomainSlice('models', (s) => s.getModels(), (l) => l.models, () => undefined)
}

export function useOptionalDefaultModelInfo(): HelmStoreValue['defaultModelInfo'] {
  return useDomainSlice(
    'models',
    () => undefined,
    (l) => l.defaultModelInfo,
    () => undefined,
  )
}

export function useProviders(): ProviderConfig[] {
  return useDomainSlice('providers', (s) => s.getProviders(), (l) => l.providers)
}

export function useCredentials(): CredentialSummary[] {
  return useDomainSlice('credentials', (s) => s.getCredentials(), (l) => l.credentials)
}

export function useSkills(): SkillSummary[] {
  return useDomainSlice('skills', (s) => s.getSkills(), (l) => l.skills)
}

export function useCatalogActions(): ActionManifest[] {
  return useDomainSlice('actions', (s) => s.getActionsList(), (l) => l.actions)
}

export function useConversations(): ConversationSummary[] {
  return useDomainSlice('conversations', (s) => s.getConversations(), (l) => l.conversations)
}

export function useOptionalConversations(): ConversationSummary[] | undefined {
  return useDomainSlice('conversations', (s) => s.getConversations(), (l) => l.conversations, () => undefined)
}

export function usePendingAsks(): AskSpec[] {
  return useDomainSlice('pendingAsks', (s) => s.getPendingAsks(), (l) => l.pendingAsks)
}

export function usePlugins(): PluginSummary[] {
  return useDomainSlice('plugins', (s) => s.getPlugins(), (l) => l.plugins)
}

export function useOptionalPlugins(): PluginSummary[] | undefined {
  return useDomainSlice('plugins', (s) => s.getPlugins(), (l) => l.plugins, () => undefined)
}

export function useGroupedUi(): GroupedUiSpecs {
  return useDomainSlice('groupedUi', (s) => s.getGroupedUi(), (l) => l.groupedUi)
}

export function useOptionalGroupedUi(): GroupedUiSpecs | undefined {
  return useDomainSlice('groupedUi', (s) => s.getGroupedUi(), (l) => l.groupedUi, () => undefined)
}

export function usePluginsUi(): PluginsUiSlice {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  const subscribe = useCallback(
    (listener: () => void) => (external !== null ? external.subscribeDomain('pluginsUi', listener) : NOOP_UNSUBSCRIBE),
    [external],
  )
  const getSnapshot = (): PluginsUiSlice | typeof UNSET => (external !== null ? external.getPluginsUiSlice() : UNSET)
  const extValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const legacySlice = useMemo<PluginsUiSlice | null>(
    () =>
      legacy === null
        ? null
        : {
            plugins: legacy.plugins,
            uiContributions: legacy.uiContributions,
            groupedUi: legacy.groupedUi,
          },
    [legacy],
  )
  if (extValue !== UNSET) return extValue
  if (legacySlice !== null) return legacySlice
  throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
}

export function useNodes(): NodeInfo[] {
  return useDomainSlice('nodes', (s) => s.getNodes(), (l) => l.nodes)
}

export function useLoadErrorsMap(): Record<string, string> {
  return useDomainSlice('loadErrorsMap', (s) => s.getLoadErrorsMap(), (l) => l.loadErrors)
}

export function usePluginDocsState(): Record<string, unknown> {
  return useDomainSlice('pluginDocsMap', (s) => s.getPluginDocsMap(), (l) => l.pluginDocs)
}

export function useConversationDetailsMap(): Record<number, ConversationDetail> {
  return useDomainSlice('conversationDetailsMap', (s) => s.getConversationDetailsMap(), (l) => l.conversationDetails)
}

export function useLocationTargets(): LocationTargetsSlice {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  const subscribe = useCallback(
    (listener: () => void) =>
      external !== null ? external.subscribeDomain('locationTargets', listener) : NOOP_UNSUBSCRIBE,
    [external],
  )
  const getSnapshot = (): LocationTargetsSlice | typeof UNSET =>
    external !== null ? external.getLocationTargetsSlice() : UNSET
  const extValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const legacySlice = useMemo<LocationTargetsSlice | null>(
    () =>
      legacy === null
        ? null
        : {
            primaryTarget: legacy.primaryTarget,
            splitTarget: legacy.splitTarget,
            focusedPanel: legacy.focusedPanel ?? 'primary',
          },
    [legacy],
  )
  if (extValue !== UNSET) return extValue
  if (legacySlice !== null) return legacySlice
  throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
}

export function usePrimaryTarget(): ResolvedTarget {
  return useDomainSlice('primaryTarget', (s) => s.getPrimaryTarget(), (l) => l.primaryTarget)
}

export function useSplitTarget(): ResolvedTarget | null {
  return useDomainSlice('splitTarget', (s) => s.getSplitTarget(), (l) => l.splitTarget)
}

export function useFocusedPanel(): FocusedPanel {
  return useDomainSlice('focusedPanel', (s) => s.getFocusedPanel(), (l) => l.focusedPanel ?? 'primary')
}

export function useSidebarCollapsed(): boolean {
  return useDomainSlice('sidebarCollapsed', (s) => s.getSidebarCollapsed(), (l) => Boolean(l.sidebarCollapsed))
}

export function useWorkbenchState(): WorkbenchSlice {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  const subscribe = useCallback(
    (listener: () => void) => (external !== null ? external.subscribeDomain('workbench', listener) : NOOP_UNSUBSCRIBE),
    [external],
  )
  const getSnapshot = (): WorkbenchSlice | typeof UNSET => (external !== null ? external.getWorkbenchSlice() : UNSET)
  const extValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const legacySlice = useMemo<WorkbenchSlice | null>(
    () =>
      legacy === null
        ? null
        : {
            workbenchOpen: legacy.workbenchOpen,
            workbenchTab: legacy.workbenchTab,
          },
    [legacy],
  )
  if (extValue !== UNSET) return extValue
  if (legacySlice !== null) return legacySlice
  throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
}

export function useActiveModal(): ActiveModal {
  return useDomainSlice('activeModal', (s) => s.getActiveModal(), (l) => l.activeModal)
}

export function useLocationState(): WorkspaceLocationState {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  const subscribe = useCallback(
    (listener: () => void) =>
      external !== null ? external.subscribeDomain('locationState', listener) : NOOP_UNSUBSCRIBE,
    [external],
  )
  const getSnapshot = (): WorkspaceLocationState | typeof UNSET =>
    external !== null ? external.getLocationState() : UNSET
  const extValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const legacySlice = useMemo<WorkspaceLocationState | null>(
    () =>
      legacy === null
        ? null
        : {
            primaryTarget: legacy.primaryTarget,
            splitTarget: legacy.splitTarget,
            workbenchOpen: legacy.workbenchOpen,
            workbenchTab: legacy.workbenchTab,
            activeModal: legacy.activeModal,
          },
    [legacy],
  )
  if (extValue !== UNSET) return extValue
  if (legacySlice !== null) return legacySlice
  throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
}

export function useHighlightedEntry(): { conversationId: number; entryId: string } | null {
  return useDomainSlice('highlightedEntry', (s) => s.getHighlightedEntry(), (l) => l.highlightedEntry)
}

export function useNotices(): ToastNotice[] {
  return useDomainSlice('notices', (s) => s.getNotices(), (l) => l.notices)
}

export function useNavSlice(): NavSlice {
  const external = useContext(HelmExternalStoreContext)
  const legacy = useContext(HelmStoreContext)
  const subscribe = useCallback(
    (listener: () => void) => (external !== null ? external.subscribeDomain('nav', listener) : NOOP_UNSUBSCRIBE),
    [external],
  )
  const getSnapshot = (): NavSlice | typeof UNSET => (external !== null ? external.getNavSlice() : UNSET)
  const extValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const legacySlice = useMemo<NavSlice | null>(
    () =>
      legacy === null
        ? null
        : {
            primaryTarget: legacy.primaryTarget,
            splitTarget: legacy.splitTarget,
            focusedPanel: legacy.focusedPanel ?? 'primary',
            sidebarCollapsed: Boolean(legacy.sidebarCollapsed),
            pendingEscAbortConversationId: legacy.pendingEscAbortConversationId ?? null,
            workbenchOpen: legacy.workbenchOpen,
            workbenchTab: legacy.workbenchTab,
            activeModal: legacy.activeModal,
            highlightedEntry: legacy.highlightedEntry,
          },
    [legacy],
  )
  if (extValue !== UNSET) return extValue
  if (legacySlice !== null) return legacySlice
  throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
}

export function usePluginHostPortSlice(): PluginHostPortSlice {
  return useDomainSlice(
    'pluginHostPort',
    (s) => s.getPluginHostPortSlice(),
    (l) => l,
  )
}

// ---- Per-Key / Per-Conversation Hooks -------------------------------------

export function useConversationLive(conversationId: number | undefined): ConversationLive | undefined {
  return useKeyedSlice(subscribeLiveById, readLiveById, readLegacyLiveById, conversationId, undefined)
}

export function useConversationDetail(conversationId: number | undefined): ConversationDetail | undefined {
  return useKeyedSlice(subscribeDetailById, readDetailById, readLegacyDetailById, conversationId, undefined)
}

export function useConversationSummary(conversationId: number | undefined): ConversationSummary | undefined {
  return useKeyedSlice(subscribeSummaryById, readSummaryById, readLegacySummaryById, conversationId, undefined)
}

export function useConversationArtifacts(conversationId: number | undefined): ArtifactMetadata[] | undefined {
  return useKeyedSlice(subscribeArtifactsById, readArtifactsById, readLegacyArtifactsById, conversationId, undefined)
}

export function useResolvedAsks(conversationId: number | undefined): ResolvedAskEntry[] | undefined {
  return useKeyedSlice(subscribeResolvedAsksById, readResolvedAsksById, readLegacyResolvedAsksById, conversationId, undefined)
}

export function useHighlightedEntryForConversation(
  conversationId: number | undefined,
): { conversationId: number; entryId: string } | null {
  return useKeyedSlice(subscribeHighlightById, readHighlightById, readLegacyHighlightById, conversationId, null)
}

export function useLoadError(key: string | undefined): string | undefined {
  return useKeyedSlice(subscribeLoadErrorKey, readLoadErrorKey, readLegacyLoadErrorKey, key, undefined)
}

export function usePluginDoc(pluginId: string | undefined, docName: string | undefined): unknown {
  const docKey = pluginId && docName ? `${pluginId}/${docName}` : undefined
  return useKeyedSlice(subscribePluginDocKey, readPluginDocKey, readLegacyPluginDocKey, docKey, undefined)
}

// ---------------------------------------------------------------------------
// Batch conversation-scoped plugin document (sessionDoc) subscription hooks
// (host-only): single-value / diagnostics subscriptions live in
// @helm/plugin-client as usePluginSessionDocValue / usePluginSessionDocState
// (port-driven; plugins and the host share one implementation).
// Ref-counted dedicated SSE streams connect only while mounted refs exist;
// see lib/session-docs.ts.
// ---------------------------------------------------------------------------

/**
 * Batch-subscribe multiple conversation-scoped docs of one plugin in one
 * conversation, returning `{ [docName]: value }`. A failing doc omits its key
 * and surfaces the error honestly on the snapshot (never a silent empty map).
 */
export function usePluginSessionDocsMap(
  pluginId: string | undefined,
  docNames: string[] | undefined,
  conversationId: number | undefined,
): Record<string, unknown> {
  const { subscribeSessionDoc, getSessionDocState } = useStoreActions()
  const namesKey = JSON.stringify(docNames ?? [])
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!pluginId || conversationId === undefined) return () => {}
      const unsubs = (JSON.parse(namesKey) as string[]).map((name) =>
        subscribeSessionDoc({ pluginId, docName: name, conversationId }, listener))
      return () => { for (const off of unsubs) off() }
    },
    [pluginId, namesKey, conversationId, subscribeSessionDoc],
  )
  const state = useSyncExternalStore(
    subscribe,
    () => {
      if (!pluginId || conversationId === undefined) return EMPTY_SESSION_DOCS_MAP
      const names = JSON.parse(namesKey) as string[]
      if (names.length === 0) return EMPTY_SESSION_DOCS_MAP
      const map: Record<string, unknown> = {}
      let error: string | undefined
      for (const name of names) {
        const s = getSessionDocState({ pluginId, docName: name, conversationId })
        if (s.error !== undefined) error = s.error
        else if (s.hasValue) map[name] = s.value
      }
      const cached = snapshotCache.get(subscribe)
      if (
        cached !== undefined && cached.pluginId === pluginId && cached.conversationId === conversationId &&
        cached.error === error && cacheSame(cached.map, map)
      ) {
        return cached.result
      }
      snapshotCache.set(subscribe, { pluginId, conversationId, map, error, result: map })
      return map
    },
    () => EMPTY_SESSION_DOCS_MAP,
  )
  return state
}

const EMPTY_SESSION_DOCS_MAP: Record<string, unknown> = {}
interface SessionDocsMapCache { pluginId?: string; conversationId?: number; map: Record<string, unknown>; error?: string; result: Record<string, unknown> }
const snapshotCache = new WeakMap<(listener: () => void) => () => void, SessionDocsMapCache>()

function cacheSame(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const prevKeys = Object.keys(prev)
  if (prevKeys.length !== Object.keys(next).length) return false
  for (const key of prevKeys) {
    if (!Object.hasOwn(next, key) || prev[key] !== next[key]) return false
  }
  return true
}

/**
 * Batch-subscribe multiple public docs of one plugin, returning a `{ [docName]: docValue }` map.
 */
export function usePluginDocsMap(
  pluginId: string | undefined,
  docNames: string[] | undefined,
): Record<string, unknown> {
  const authenticated = useAuthenticated()
  const pluginDocs = usePluginDocsState()
  const { ensurePluginDoc } = useStoreActions()
  const namesKey = JSON.stringify(docNames ?? [])
  useEffect(() => {
    if (!pluginId || !authenticated) return
    for (const name of JSON.parse(namesKey) as string[]) {
      if (!Object.hasOwn(pluginDocs, `${pluginId}/${name}`)) void ensurePluginDoc(pluginId, name)
    }
  }, [pluginId, namesKey, authenticated, ensurePluginDoc, pluginDocs])

  return useMemo(() => {
    if (!pluginId || !docNames || docNames.length === 0) return EMPTY_SESSION_DOCS_MAP
    const map: Record<string, unknown> = {}
    for (const name of docNames) {
      const key = `${pluginId}/${name}`
      if (Object.hasOwn(pluginDocs, key)) {
        map[name] = pluginDocs[key]
      }
    }
    return map
  }, [pluginId, docNames, pluginDocs])
}

export type { SessionDocKey }
export type {
  AuthSlice,
  CatalogSlice,
  HelmExternalStore,
  HelmStoreActions,
  LocationTargetsSlice,
  NavSlice,
  PluginHostPortSlice,
  PluginsUiSlice,
  PrefsSlice,
  ProfilesSlice,
  ResolvedAskEntry,
  StoreDomainKey,
  WorkbenchSlice,
}
