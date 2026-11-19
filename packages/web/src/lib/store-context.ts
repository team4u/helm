import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import type {
  ActionManifest,
  ArtifactMetadata,
  AskSpec,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
  CredentialSummary,
  HelmxLocale,
  NodeInfo,
  PluginSummary,
  ProviderConfig,
  SkillSummary,
} from '@helmx/protocol/browser'
import type { ModelDescriptor } from './api.js'
import type {
  AuthSlice,
  CatalogSlice,
  HelmxExternalStore,
  HelmxStoreActions,
  LocationTargetsSlice,
  NavSlice,
  PluginHostPortSlice,
  PluginsUiSlice,
  PrefsSlice,
  ProfilesSlice,
  ResolvedAskEntry,
  StoreDomainKey,
  WorkbenchSlice,
} from './helmx-store.js'
import type { SessionDocKey } from './session-docs.js'
import type {
  ActiveModal,
  FocusedPanel,
  GroupedUiSpecs,
  HelmxStoreValue,
  ResolvedTarget,
  ThemeMode,
  ToastNotice,
} from './types.js'
import type { WorkspaceLocationState } from './url-hash-model.js'

export const HelmxExternalStoreContext = createContext<HelmxExternalStore | null>(null)

const UNSET = Symbol('helmx-store-unset')
const NOOP_UNSUBSCRIBE = () => {}

function subscribeLiveById(store: HelmxExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationLive(id, listener)
}
function readLiveById(store: HelmxExternalStore, id: number): ConversationLive | undefined {
  return store.getConversationLive(id)
}

function subscribeDetailById(store: HelmxExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationDetail(id, listener)
}
function readDetailById(store: HelmxExternalStore, id: number): ConversationDetail | undefined {
  return store.getConversationDetail(id)
}

function subscribeSummaryById(store: HelmxExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationSummary(id, listener)
}
function readSummaryById(store: HelmxExternalStore, id: number): ConversationSummary | undefined {
  return store.getConversationSummary(id)
}

function subscribeArtifactsById(store: HelmxExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationArtifacts(id, listener)
}
function readArtifactsById(store: HelmxExternalStore, id: number): ArtifactMetadata[] | undefined {
  return store.getConversationArtifacts(id)
}

function subscribeResolvedAsksById(store: HelmxExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeResolvedAsks(id, listener)
}
function readResolvedAsksById(store: HelmxExternalStore, id: number): ResolvedAskEntry[] | undefined {
  return store.getResolvedAsks(id)
}

function subscribeHighlightById(store: HelmxExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeHighlightForConversation(id, listener)
}
function readHighlightById(store: HelmxExternalStore, id: number): { conversationId: number; entryId: string } | null {
  return store.getHighlightedEntryForConversation(id)
}

function subscribeLoadErrorKey(store: HelmxExternalStore, key: string, listener: () => void): () => void {
  return store.subscribeLoadError(key, listener)
}
function readLoadErrorKey(store: HelmxExternalStore, key: string): string | undefined {
  return store.getLoadError(key)
}

function subscribePluginDocKey(store: HelmxExternalStore, docKey: string, listener: () => void): () => void {
  return store.subscribePluginDoc(docKey, listener)
}
function readPluginDocKey(store: HelmxExternalStore, docKey: string): unknown {
  return store.getPluginDoc(docKey)
}

function useDomainSlice<T>(
  domain: StoreDomainKey,
  fromExternal: (store: HelmxExternalStore) => T,
  fallback?: () => T,
): T {
  const external = useContext(HelmxExternalStoreContext)
  const subscribe = useCallback(
    (listener: () => void) => (external !== null ? external.subscribeDomain(domain, listener) : NOOP_UNSUBSCRIBE),
    [external, domain],
  )
  const getSnapshot = (): T | typeof UNSET => (external !== null ? fromExternal(external) : UNSET)
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (value !== UNSET) return value
  if (fallback !== undefined) return fallback()
  throw new Error('useHelmxStore must be called inside <HelmxStoreProvider>')
}

function useKeyedSlice<K, T>(
  subscribeForKey: (store: HelmxExternalStore, key: K, listener: () => void) => () => void,
  fromExternal: (store: HelmxExternalStore, key: K) => T,
  key: K | undefined,
  emptyValue: T,
): T {
  const external = useContext(HelmxExternalStoreContext)
  const subscribe = useCallback(
    (listener: () => void) =>
      external !== null && key !== undefined ? subscribeForKey(external, key, listener) : NOOP_UNSUBSCRIBE,
    [external, subscribeForKey, key],
  )
  const getSnapshot = (): T | typeof UNSET =>
    external !== null ? (key !== undefined ? fromExternal(external, key) : emptyValue) : UNSET
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (value !== UNSET) return value
  throw new Error('useHelmxStore must be called inside <HelmxStoreProvider>')
}

/**
 * Full store snapshot hook (coarse consumers; subscribes to all domains, so
 * production components should prefer sliced hooks below).
 */
export function useHelmxStore(): HelmxStoreValue {
  return useDomainSlice('all', (s) => s.getSnapshot())
}

/** Stable store action bundle (never triggers re-renders inside <HelmxStoreProvider>). */
export function useStoreActions(): HelmxStoreActions {
  const external = useContext(HelmxExternalStoreContext)
  if (external !== null) return external.actions
  throw new Error('useStoreActions must be called inside <HelmxStoreProvider>')
}

export function useOptionalStoreActions(): HelmxStoreActions | null {
  return useContext(HelmxExternalStoreContext)?.actions ?? null
}

/** Direct imperative reference to external store (for event handlers that read without subscribing). */
export function useHelmxExternalStore(): HelmxExternalStore | null {
  return useContext(HelmxExternalStoreContext)
}

// ---- Narrow Domain Hooks --------------------------------------------------

export function useAuthConnection(): AuthSlice {
  return useDomainSlice('auth', (s) => s.getAuthSlice())
}

export function useAuthenticated(): boolean {
  return useDomainSlice('authenticated', (s) => s.getAuthenticated())
}

export function useSseConnected(): boolean {
  return useDomainSlice('sseConnected', (s) => s.getSseConnected())
}

export function useThemePreferencesState(): PrefsSlice {
  return useDomainSlice('prefs', (s) => s.getPrefsSlice())
}

export function useOptionalLocale(): HelmxLocale | undefined {
  return useDomainSlice('locale', (s) => s.getLocale(), () => undefined)
}

export function useThemeMode(): ThemeMode {
  return useDomainSlice('theme', (s) => s.getPrefsSlice().theme)
}

export function useQuietNotifyEnabled(): boolean {
  return useDomainSlice('quietNotify', (s) => s.getPrefsSlice().quietNotifyEnabled)
}

export function useProfilesSlice(): ProfilesSlice {
  return useDomainSlice('profiles', (s) => s.getProfilesSlice())
}

export function useCatalogAssets(): CatalogSlice {
  return useDomainSlice('catalog', (s) => s.getCatalogSlice())
}

export function useModels(): ModelDescriptor[] {
  return useDomainSlice('models', (s) => s.getModels())
}

export function useOptionalModels(): ModelDescriptor[] | undefined {
  return useDomainSlice('models', (s) => s.getModels(), () => undefined)
}

export function useProviders(): ProviderConfig[] {
  return useDomainSlice('providers', (s) => s.getProviders())
}

export function useCredentials(): CredentialSummary[] {
  return useDomainSlice('credentials', (s) => s.getCredentials())
}

export function useSkills(): SkillSummary[] {
  return useDomainSlice('skills', (s) => s.getSkills())
}

export function useCatalogActions(): ActionManifest[] {
  return useDomainSlice('actions', (s) => s.getActionsList())
}

export function useConversations(): ConversationSummary[] {
  return useDomainSlice('conversations', (s) => s.getConversations())
}

export function useOptionalConversations(): ConversationSummary[] | undefined {
  return useDomainSlice('conversations', (s) => s.getConversations(), () => undefined)
}

export function usePendingAsks(): AskSpec[] {
  return useDomainSlice('pendingAsks', (s) => s.getPendingAsks())
}

export function usePlugins(): PluginSummary[] {
  return useDomainSlice('plugins', (s) => s.getPlugins())
}

export function useOptionalPlugins(): PluginSummary[] | undefined {
  return useDomainSlice('plugins', (s) => s.getPlugins(), () => undefined)
}

export function useGroupedUi(): GroupedUiSpecs {
  return useDomainSlice('groupedUi', (s) => s.getGroupedUi())
}

export function useOptionalGroupedUi(): GroupedUiSpecs | undefined {
  return useDomainSlice('groupedUi', (s) => s.getGroupedUi(), () => undefined)
}

export function usePluginsUi(): PluginsUiSlice {
  return useDomainSlice('pluginsUi', (s) => s.getPluginsUiSlice())
}

export function useNodes(): NodeInfo[] {
  return useDomainSlice('nodes', (s) => s.getNodes())
}

export function useLoadErrorsMap(): Record<string, string> {
  return useDomainSlice('loadErrorsMap', (s) => s.getLoadErrorsMap())
}

export function usePluginDocsState(): Record<string, unknown> {
  return useDomainSlice('pluginDocsMap', (s) => s.getPluginDocsMap())
}

export function useConversationDetailsMap(): Record<number, ConversationDetail> {
  return useDomainSlice('conversationDetailsMap', (s) => s.getConversationDetailsMap())
}

export function useLocationTargets(): LocationTargetsSlice {
  return useDomainSlice('locationTargets', (s) => s.getLocationTargetsSlice())
}

export function usePrimaryTarget(): ResolvedTarget {
  return useDomainSlice('primaryTarget', (s) => s.getPrimaryTarget())
}

export function useSplitTarget(): ResolvedTarget | null {
  return useDomainSlice('splitTarget', (s) => s.getSplitTarget())
}

export function useFocusedPanel(): FocusedPanel {
  return useDomainSlice('focusedPanel', (s) => s.getFocusedPanel())
}

export function useSidebarCollapsed(): boolean {
  return useDomainSlice('sidebarCollapsed', (s) => s.getSidebarCollapsed())
}

export function useWorkbenchState(): WorkbenchSlice {
  return useDomainSlice('workbench', (s) => s.getWorkbenchSlice())
}

export function useActiveModal(): ActiveModal {
  return useDomainSlice('activeModal', (s) => s.getActiveModal())
}

export function useLocationState(): WorkspaceLocationState {
  return useDomainSlice('locationState', (s) => s.getLocationState())
}

export function useHighlightedEntry(): { conversationId: number; entryId: string } | null {
  return useDomainSlice('highlightedEntry', (s) => s.getHighlightedEntry())
}

export function useNotices(): ToastNotice[] {
  return useDomainSlice('notices', (s) => s.getNotices())
}

export function useNavSlice(): NavSlice {
  return useDomainSlice('nav', (s) => s.getNavSlice())
}

export function usePluginHostPortSlice(): PluginHostPortSlice {
  return useDomainSlice('pluginHostPort', (s) => s.getPluginHostPortSlice())
}

// ---- Per-Key / Per-Conversation Hooks -------------------------------------

export function useConversationLive(conversationId: number | undefined): ConversationLive | undefined {
  return useKeyedSlice(subscribeLiveById, readLiveById, conversationId, undefined)
}

export function useConversationDetail(conversationId: number | undefined): ConversationDetail | undefined {
  return useKeyedSlice(subscribeDetailById, readDetailById, conversationId, undefined)
}

export function useConversationSummary(conversationId: number | undefined): ConversationSummary | undefined {
  return useKeyedSlice(subscribeSummaryById, readSummaryById, conversationId, undefined)
}

export function useConversationArtifacts(conversationId: number | undefined): ArtifactMetadata[] | undefined {
  return useKeyedSlice(subscribeArtifactsById, readArtifactsById, conversationId, undefined)
}

export function useResolvedAsks(conversationId: number | undefined): ResolvedAskEntry[] | undefined {
  return useKeyedSlice(subscribeResolvedAsksById, readResolvedAsksById, conversationId, undefined)
}

export function useHighlightedEntryForConversation(
  conversationId: number | undefined,
): { conversationId: number; entryId: string } | null {
  return useKeyedSlice(subscribeHighlightById, readHighlightById, conversationId, null)
}

export function useLoadError(key: string | undefined): string | undefined {
  return useKeyedSlice(subscribeLoadErrorKey, readLoadErrorKey, key, undefined)
}

export function usePluginDoc(pluginId: string | undefined, docName: string | undefined): unknown {
  const docKey = pluginId && docName ? `${pluginId}/${docName}` : undefined
  return useKeyedSlice(subscribePluginDocKey, readPluginDocKey, docKey, undefined)
}

// ---------------------------------------------------------------------------
// Batch conversation-scoped plugin document (sessionDoc) subscription hooks
// (host-only): single-value / diagnostics subscriptions live in
// @helmx/plugin-client as usePluginSessionDocValue / usePluginSessionDocState
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
  HelmxExternalStore,
  HelmxStoreActions,
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
