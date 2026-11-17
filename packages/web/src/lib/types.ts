import type {
  ActionManifest,
  ArtifactMetadata,
  ArtifactPreviewerSpec,
  AskSpec,
  CommandSpec,
  ComposerPillSpec,
  ComposerCompleterSpec,
  ComposerWidgetSpec,
  MarkdownCodeBlockSpec,
  UiActionSpec,
  ConversationDetail,
  ConversationEntry,
  ConversationLive,
  ConversationScope,
  ConversationSummary,
  CredentialSummary,
  HelmLocale,
  NodeInfo,
  NotificationEvent,
  PluginSummary,
  PluginSlotContributionSpec,
  ProfileRuntimeUiSpec,
  PluginUiContribution,
  Profile,
  ProviderConfig,
  ScreenSpec,
  SettingsPanelSpec,
  SidebarItemSpec,
  SidebarSectionSpec,
  SkillSummary,
  TimelineRendererSpec,
  ToolViewSpec,
  WorkbenchPanelSpec,
} from '@helm/protocol/browser'
import { matchesConversationScope, parsePluginUiContribution } from '@helm/protocol/browser'
import type { ModelDescriptor } from './api.js'
import type { SessionDocKey } from './session-docs.js'

export type { SessionDocKey }

export type ThemeMode = 'light' | 'dark'
export type ThemePreference = 'system' | 'light' | 'dark'
export type LocalePreference = 'auto' | HelmLocale
export type FocusedPanel = 'primary' | 'split'

/** Screen param key: non-empty, limited to letters/digits/dot/underscore/hyphen (a stable sub-key inside the URL query namespace). */
export const SCREEN_PARAM_KEY_PATTERN = /^[A-Za-z0-9._-]+$/

/** Reserved names among URL param keys: refused on plain objects (prototype-pollution guard). */
const PROTOTYPE_PARAM_KEY_RE = /^(?:__proto__|constructor|prototype)$/

export const isPrototypeParamKey = (key: string): boolean => PROTOTYPE_PARAM_KEY_RE.test(key)

export type ModelsCenterTab = 'providers' | 'defaults'

export type ResolvedTarget =
  | { kind: 'conversation'; conversationId: number }
  | { kind: 'agent'; profileId: string; nodeId?: string; cwd?: string }
  | { kind: 'screen'; pluginId: string; screenId: string; params?: Record<string, string> }
  | { kind: 'plugins'; pluginId?: string }
  | { kind: 'profiles'; profileId?: string }
  | { kind: 'skills'; skillId?: string }
  | { kind: 'nodes'; nodeId?: string }
  | { kind: 'models'; providerId?: string; tab?: ModelsCenterTab }

export type ActiveModal =
  | { kind: 'command-palette' }
  | { kind: 'artifact-preview'; artifactId: string; conversationId?: number }
  | { kind: 'workspace-file'; conversationId: number; path: string; startLine?: number; endLine?: number }
  | { kind: 'conversation-drawer'; conversationId: number }
  | null

export interface QualifiedUiSpec<T> {
  pluginId: string
  spec: T
}

/** UI action contribution (groupUiContributions restores target semantics by surface). */
export type QualifiedUiActionSpec = QualifiedUiSpec<UiActionSpec> & { target: UiActionSpec['target'] }

export interface GroupedUiSpecs {
  sidebarItems: Array<QualifiedUiSpec<SidebarItemSpec>>
  sidebarSections: Array<QualifiedUiSpec<SidebarSectionSpec>>
  screens: Array<QualifiedUiSpec<ScreenSpec>>
  timelineRenderers: Array<QualifiedUiSpec<TimelineRendererSpec>>
  markdownCodeBlocks: Array<QualifiedUiSpec<MarkdownCodeBlockSpec>>
  toolViews: Array<QualifiedUiSpec<ToolViewSpec>>
  composerPills: Array<QualifiedUiSpec<ComposerPillSpec>>
  composerWidgets: Array<QualifiedUiSpec<ComposerWidgetSpec>>
  composerCompleters: Array<QualifiedUiSpec<ComposerCompleterSpec>>
  artifactPreviewers: Array<QualifiedUiSpec<ArtifactPreviewerSpec>>
  workbenchPanels: Array<QualifiedUiSpec<WorkbenchPanelSpec>>
  commands: Array<QualifiedUiSpec<CommandSpec>>
  settingsPanels: Array<QualifiedUiSpec<SettingsPanelSpec>>
  profileRuntimes: Array<QualifiedUiSpec<ProfileRuntimeUiSpec>>
  uiActions: QualifiedUiActionSpec[]
  pluginSlots: Array<QualifiedUiSpec<PluginSlotContributionSpec>>
}

export interface ToastNotice extends NotificationEvent {
  id: string
  createdAt: number
}

/** Whether the conversation matches the plugin-declared ConversationScope. */
export function matchesUiScope(
  conversation: ConversationSummary | undefined,
  scope: ConversationScope | undefined,
): boolean {
  if (!scope) return true
  if (!conversation) return false
  return matchesConversationScope(scope, conversation)
}

/** Groups and orders the UI contribution list by extension surface. */
export function groupUiContributions(contributions: PluginUiContribution[]): GroupedUiSpecs {
  const grouped: GroupedUiSpecs = {
    sidebarItems: [],
    sidebarSections: [],
    screens: [],
    timelineRenderers: [],
    markdownCodeBlocks: [],
    toolViews: [],
    composerPills: [],
    composerWidgets: [],
    composerCompleters: [],
    artifactPreviewers: [],
    workbenchPanels: [],
    commands: [],
    settingsPanels: [],
    profileRuntimes: [],
    uiActions: [],
    pluginSlots: [],
  }
  for (const item of contributions) {
    const known = parsePluginUiContribution(item)
    if (!known) continue
    switch (known.surface) {
      case 'sidebar.item':
        grouped.sidebarItems.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'sidebar.section':
        grouped.sidebarSections.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'screen':
        grouped.screens.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'timeline.renderer':
        grouped.timelineRenderers.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'markdown.codeBlock':
        grouped.markdownCodeBlocks.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'tool.view':
        grouped.toolViews.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'composer.pill':
        grouped.composerPills.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'composer.widget':
        grouped.composerWidgets.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'composer.completer':
        grouped.composerCompleters.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'artifact.previewer':
        grouped.artifactPreviewers.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'workbench.panel':
        grouped.workbenchPanels.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'commandPalette':
      case 'command':
        grouped.commands.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'profile.runtime':
        grouped.profileRuntimes.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'conversation.header.action':
        grouped.uiActions.push({ pluginId: known.pluginId, spec: known.spec, target: 'conversation:header' })
        break
      case 'conversation.row.action':
        grouped.uiActions.push({ pluginId: known.pluginId, spec: known.spec, target: 'conversation:row' })
        break
      case 'timeline.entry.action':
        grouped.uiActions.push({ pluginId: known.pluginId, spec: known.spec, target: 'timeline:entry' })
        break
      case 'plugin.slot':
        grouped.pluginSlots.push({ pluginId: known.pluginId, spec: known.spec })
        break
      case 'settings.panel':
        grouped.settingsPanels.push({ pluginId: known.pluginId, spec: known.spec })
        break
    }
  }
  const sidebarOrder = (spec: SidebarItemSpec): number => spec.order ?? 100
  grouped.sidebarItems.sort((a, b) => sidebarOrder(a.spec) - sidebarOrder(b.spec))
  grouped.sidebarSections.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.workbenchPanels.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.settingsPanels.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.profileRuntimes.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.uiActions.sort((a, b) => {
    if (a.target !== b.target) return a.target.localeCompare(b.target)
    return (a.spec.order ?? 100) - (b.spec.order ?? 100)
  })
  return grouped
}

/**
 * Parses a declarative navigation target string:
 * - 'conversation:1' / 'conversation:42'
 * - 'conversation:profile:superagent' -> finds the resident or latest conversation of that profileId
 * - 'conversation:tag:worker' -> finds the latest conversation carrying that tag
 * - 'agent:assistant' -> opens that agent's standby page (the conversation is created on first send)
 * - 'screen:builtin:herdr/overview' -> opens a full-screen plugin view
 * - 'screen:<pluginId>/<screenId>?k1=v1&k2=v2' -> opens a full-screen plugin view with route params
 *
 * Screen query strings are parsed strictly: invalid percent-encoding, empty
 * keys/values, duplicate keys and reserved prototype keys invalidate the whole
 * target.
 */
export function resolveTargetString(
  rawTarget: string,
  conversations: ConversationSummary[],
): ResolvedTarget | null {
  const target = rawTarget.trim()
  if (target === 'plugins') {
    return { kind: 'plugins' }
  }
  if (target.startsWith('plugins:')) {
    const pluginId = target.slice('plugins:'.length).trim()
    return pluginId === '' ? { kind: 'plugins' } : { kind: 'plugins', pluginId }
  }
  if (target === 'profiles') {
    return { kind: 'profiles' }
  }
  if (target.startsWith('profiles:')) {
    const profileId = target.slice('profiles:'.length).trim()
    return profileId === '' ? { kind: 'profiles' } : { kind: 'profiles', profileId }
  }
  if (target === 'skills') {
    return { kind: 'skills' }
  }
  if (target.startsWith('skills:')) {
    const skillId = target.slice('skills:'.length).trim()
    return skillId === '' ? { kind: 'skills' } : { kind: 'skills', skillId }
  }
  if (target === 'nodes') {
    return { kind: 'nodes' }
  }
  if (target.startsWith('nodes:')) {
    const nodeId = target.slice('nodes:'.length).trim()
    return nodeId === '' ? { kind: 'nodes' } : { kind: 'nodes', nodeId }
  }
  if (target === 'models') {
    return { kind: 'models' }
  }
  if (target.startsWith('models:')) {
    const sub = target.slice('models:'.length).trim()
    if (sub === '') return { kind: 'models' }
    // models:defaults deep-links to the global defaults tab (upgraded from the historical virtual card)
    if (sub === 'defaults') return { kind: 'models', tab: 'defaults' }
    return { kind: 'models', providerId: sub }
  }
  if (target.startsWith('agent:')) {
    const profileId = target.slice('agent:'.length).trim()
    return profileId === '' ? null : { kind: 'agent', profileId }
  }
  if (target.startsWith('conversation:profile:')) {
    const profileId = target.slice('conversation:profile:'.length).trim()
    // Resident conversations first: those without parentConversationId are the
    // long-lived conversations created directly by plugins/users; derived
    // Workers (with a parent chain) are not included — no tag-name hardcoding.
    const resident = conversations.filter((c) => c.profileId === profileId && c.parentConversationId === undefined)
    const matched = resident[0] ?? conversations.find((c) => c.profileId === profileId)
    return matched ? { kind: 'conversation', conversationId: matched.id } : null
  }
  if (target.startsWith('conversation:tag:')) {
    const tag = target.slice('conversation:tag:'.length).trim()
    const matched = conversations.find((c) => c.tags.includes(tag))
    return matched ? { kind: 'conversation', conversationId: matched.id } : null
  }
  if (target.startsWith('conversation:')) {
    const idNum = Number(target.slice('conversation:'.length).trim())
    if (Number.isInteger(idNum) && idNum > 0) {
      return { kind: 'conversation', conversationId: idNum }
    }
    return null
  }
  if (target.startsWith('screen:')) {
    const rest = target.slice('screen:'.length).trim()
    const queryIdx = rest.indexOf('?')
    const pathPart = queryIdx === -1 ? rest : rest.slice(0, queryIdx)
    const slashIdx = pathPart.lastIndexOf('/')
    if (slashIdx <= 0 || slashIdx === pathPart.length - 1) return null
    const params = queryIdx === -1 ? undefined : parseScreenTargetQuery(rest.slice(queryIdx + 1))
    if (params === null) return null
    return {
      kind: 'screen',
      pluginId: pathPart.slice(0, slashIdx),
      screenId: pathPart.slice(slashIdx + 1),
      ...(params === undefined ? {} : { params }),
    }
  }
  return null
}

/**
 * Strictly parses a `k1=v1&k2=v2` query string into Screen params:
 * - keys must match SCREEN_PARAM_KEY_PATTERN (rejecting prototype keys such as
 *   __proto__ / constructor);
 * - values may contain any character but must not be empty; invalid
 *   percent-encoding (decodeURIComponent throwing) invalidates the whole string;
 * - duplicate keys invalidate the whole string (never silently pick one);
 *   returning undefined means no effective params.
 * Returning null means the query string is invalid and the caller must treat
 * the whole target as invalid.
 */
export function parseScreenTargetQuery(rawQuery: string): Record<string, string> | undefined | null {
  if (rawQuery === '') return undefined
  const seen = new Set<string>()
  const params: Record<string, string> = {}
  for (const pair of rawQuery.split('&')) {
    if (pair === '') return null
    const eqIdx = pair.indexOf('=')
    const rawKey = eqIdx === -1 ? pair : pair.slice(0, eqIdx)
    const rawValue = eqIdx === -1 ? '' : pair.slice(eqIdx + 1)
    if (eqIdx === -1 || rawKey === '' || rawValue === '') return null
    if (!SCREEN_PARAM_KEY_PATTERN.test(rawKey) || isPrototypeParamKey(rawKey)) return null
    if (seen.has(rawKey)) return null
    let value: string
    try {
      value = decodeURIComponent(rawValue)
    } catch {
      return null
    }
    if (value === '') return null
    seen.add(rawKey)
    params[rawKey] = value
  }
  return Object.keys(params).length === 0 ? undefined : params
}

export function isSameResolvedTarget(a: ResolvedTarget | null, b: ResolvedTarget | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'conversation' && b.kind === 'conversation') {
    return a.conversationId === b.conversationId
  }
  if (a.kind === 'agent' && b.kind === 'agent') {
    return a.profileId === b.profileId && (a.nodeId ?? undefined) === (b.nodeId ?? undefined) && (a.cwd ?? undefined) === (b.cwd ?? undefined)
  }
  if (a.kind === 'screen' && b.kind === 'screen') {
    if (a.pluginId !== b.pluginId || a.screenId !== b.screenId) return false
    const ap = a.params ?? {}
    const bp = b.params ?? {}
    const apKeys = Object.keys(ap)
    const bpKeys = Object.keys(bp)
    if (apKeys.length !== bpKeys.length) return false
    return apKeys.every((key) => Object.hasOwn(bp, key) && bp[key] === ap[key])
  }
  if (a.kind === 'plugins' && b.kind === 'plugins') {
    return a.pluginId === b.pluginId
  }
  if (a.kind === 'profiles' && b.kind === 'profiles') {
    return a.profileId === b.profileId
  }
  if (a.kind === 'skills' && b.kind === 'skills') {
    return a.skillId === b.skillId
  }
  if (a.kind === 'nodes' && b.kind === 'nodes') {
    return a.nodeId === b.nodeId
  }
  if (a.kind === 'models' && b.kind === 'models') {
    return a.providerId === b.providerId && a.tab === b.tab
  }
  return false
}

/** Sidebar space: conversations / views / settings (the three top-level
 * navigation sections of the Activity Rail). The space is derived uniquely
 * from the primary target (spaceForTarget), not an independent URL/store
 * state; Rail clicks navigate straight to the space's main-stage target via
 * store.openSpace. */
export type SidebarSpace = 'conversations' | 'views' | 'settings'

/** System center target keys (shared by the settings-space vertical list and sidebar-space derivation). */
export const CENTER_TARGETS = ['profiles', 'models', 'skills', 'nodes', 'plugins'] as const

/** Derives the space from the primary target: screen -> views, system
 * centers -> settings, everything else -> conversations. The sidebar space is
 * a derived value of the primary target; the URL expresses only the target. */
export function spaceForTarget(target: ResolvedTarget): SidebarSpace {
  if (target.kind === 'screen') return 'views'
  if ((CENTER_TARGETS as readonly string[]).includes(target.kind)) return 'settings'
  return 'conversations'
}

export const COMPACT_MOBILE_MAX_WIDTH = 680
export const COMPACT_MOBILE_DETAIL_LIMIT = 40
export const DESKTOP_DETAIL_LIMIT = 150

/** Whether the current viewport is a compact mobile layout (`<= 680px`). */
export function isCompactMobileViewport(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(`(max-width: ${COMPACT_MOBILE_MAX_WIDTH}px)`).matches
  }
  return typeof window.innerWidth === 'number' && window.innerWidth > 0 && window.innerWidth <= COMPACT_MOBILE_MAX_WIDTH
}

/** Default entry limit for conversation detail requests based on current viewport width. */
export function defaultConversationDetailLimit(): number {
  return isCompactMobileViewport() ? COMPACT_MOBILE_DETAIL_LIMIT : DESKTOP_DETAIL_LIMIT
}

export interface HelmStoreValue {
  // Auth & connection state
  authReady: boolean
  authConfigured: boolean
  authenticated: boolean
  authError: string | null
  connectionError: string | null
  loadErrors: Record<string, string>
  sseConnected: boolean
  theme: ThemeMode
  themePreference: ThemePreference
  /** Current UI locale (resolved from localePreference; browser-derived default zh-* -> zh-CN, others -> en). */
  locale: HelmLocale
  /** Stored UI locale preference ('auto' follows navigator.languages; manual value overrides). Test doubles may omit it. */
  localePreference?: LocalePreference
  /** Background browser notification preference (localStorage persisted; delivered only when permission is granted). */
  quietNotifyEnabled: boolean

  // Core realtime data
  conversations: ConversationSummary[]
  conversationDetails: Record<number, ConversationDetail>
  conversationLives: Record<number, ConversationLive>
  conversationArtifacts: Record<number, ArtifactMetadata[]>
  pendingAsks: AskSpec[]
  resolvedAsksByConv: Record<number, Array<{ ask: AskSpec; status: 'answered' | 'cancelled' | 'superseded' }>>
  plugins: PluginSummary[]
  uiContributions: PluginUiContribution[]
  groupedUi: GroupedUiSpecs
  pluginDocs: Record<string, unknown> // key: `${pluginId}/${docName}`
  nodes: NodeInfo[]
  /** Current kernel boot generation (bootId of the SSE snapshot; null/absent =
   * no snapshot received yet). Changes after a kernel restart; read-only
   * consumers such as version watching use it as a "re-probe" signal — it does
   * not imply the web assets were updated. Test doubles may omit it. */
  kernelBootId?: string | null

  // Static config assets
  profiles: Profile[]
  /** Whether profiles finished loading independently of slower assets (models/skills/actions); releases home landing early. */
  profilesLoaded: boolean
  /** Whether static assets (profiles/models/skills/...) finished their first load this session (standby page distinguishes loading from non-existent). */
  assetsLoaded: boolean
  models: ModelDescriptor[]
  defaultModelInfo?: {
    defaultModel: string
    defaultThinkingLevel: string
    modelThinkingLevels?: Record<string, string>
    defaultCompactionModel?: string
    defaultCompactionThinkingLevel?: string
  } | null
  providers: ProviderConfig[]
  credentials: CredentialSummary[]
  skills: SkillSummary[]
  actions: ActionManifest[]

  // View routing & workbench state
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  /** Currently focused panel (memory only, not in the URL; reset to 'primary' when the split closes). Test doubles may omit it. */
  focusedPanel?: FocusedPanel
  /** Desktop left secondary navigation collapsed state (localStorage persisted; not in the URL). Test doubles may omit it. */
  sidebarCollapsed?: boolean
  /** Conversation ID inside the 1.5s double-Esc abort confirmation window (null = not armed). Test doubles may omit it. */
  pendingEscAbortConversationId?: number | null
  workbenchOpen: boolean
  workbenchTab: string // 'artifacts' | `plugin:${pluginId}/${panelId}` (dynamic tab, falls back in WorkbenchDrawer)
  activeModal: ActiveModal
  highlightedEntry: { conversationId: number; entryId: string } | null
  notices: ToastNotice[]

  // Actions
  setTheme(theme: ThemeMode): void
  setThemePreference(pref: ThemePreference): void
  toggleTheme(): void
  /** Sets the UI locale and persists the preference. */
  setLocale(locale: HelmLocale): void
  /** Sets the UI locale preference ('auto' clears storage override and follows the browser). Test doubles may omit it. */
  setLocalePreference?(pref: LocalePreference): void
  /** When enabling, requests browser notification permission first; on denial stays disabled with a toast notice; disabling takes effect immediately. */
  setQuietNotify(on: boolean): Promise<void>
  checkAuth(): Promise<void>
  onAuthenticated(token: string): Promise<void>
  logout(): void
  refreshAssets(): Promise<void>
  /** Fully recalibrates the plugin list (after package install/update/remove; SSE plugin.changed remains the incremental truth, merged idempotently). Test doubles may omit it. */
  syncPlugins?(plugins: PluginSummary[]): void
  refreshNodes(): Promise<NodeInfo[] | undefined>
  loadConversationDetail(
    conversationId: number,
    force?: boolean,
    opts?: { silent?: boolean; limit?: number },
  ): Promise<ConversationDetail | undefined>
  loadEarlierEntries(conversationId: number): Promise<void>
  /** Backfills a single entry's full text (fetched on demand after server-side
   * timeline preview truncation): same upsert semantics as the
   * conversation.entry event (same id replaced in place, order preserved), no
   * network triggered, pagination cursor untouched. The production provider
   * always provides it; test doubles may omit it (the truncation-fetch hook
   * then errors explicitly instead of degrading silently). */
  backfillConversationEntry?(conversationId: number, entry: ConversationEntry): void
  loadConversationArtifacts(conversationId: number, opts?: { silent?: boolean }): Promise<ArtifactMetadata[] | undefined>
  ensurePluginDoc(pluginId: string, docName: string): Promise<unknown>
  /** Subscribes to a conversation-scoped doc tuple (ref-counted dedicated SSE stream; see lib/session-docs.ts). */
  subscribeSessionDoc(key: SessionDocKey, listener: () => void): () => void
  /** Reads the current cached state of a conversation-scoped doc (with error and deleted markers; empty state when unsubscribed). */
  getSessionDocState(key: SessionDocKey): { value?: unknown; hasValue: boolean; deleted: boolean; error?: string; connected: boolean }
  /** One-shot read of a conversation-scoped doc (GET /api/plugins/:id/docs/:name?conversationId=). */
  getPluginSessionDoc(pluginId: string, docName: string, conversationId: number): Promise<unknown>
  /** Explicit reconnect of a conversation-scoped doc (UI retry entry after a subscription error). */
  retrySessionDoc(key: SessionDocKey): void
  openTarget(
    target: string | ResolvedTarget,
    opts?: { split?: boolean; highlightEntryId?: string; history?: 'push' | 'replace' },
  ): void
  closeSplit(): void
  /** Updates the currently focused panel; switching to 'split' is ignored while splitTarget is empty. Test doubles may omit it. */
  setFocusedPanel?(panel: FocusedPanel): void
  /** Sets the desktop sidebar collapsed state and persists it. Test doubles may omit it. */
  setSidebarCollapsed?(collapsed: boolean): void
  /** Toggles the desktop sidebar collapsed state and persists it. Test doubles may omit it. */
  toggleSidebarCollapsed?(): void
  /** Updates the current screen route params (undefined deletes the key); applies to the primary pane when split is omitted. */
  setScreenParams(patch: Record<string, string | undefined>, options?: { split?: boolean; push?: boolean }): void
  setWorkbenchOpen(open: boolean): void
  setWorkbenchTab(tab: string): void
  /** Activity Rail space switch: navigates the primary pane to the space's most recent target (space default when none remembered), pushing history. */
  openSpace(space: SidebarSpace): void
  setActiveModal(modal: ActiveModal): void
  dismissNotice(id: string): void
  pushNotice(notice: Omit<ToastNotice, 'id' | 'createdAt'>): void
  invokePluginAction(pluginId: string, actionId: string, input: unknown, conversationId?: number): Promise<unknown>
}
