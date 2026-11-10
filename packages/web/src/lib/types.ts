import type {
  ActionManifest,
  ArtifactMetadata,
  ArtifactPreviewerSpec,
  AskSpec,
  CommandSpec,
  ComposerPillSpec,
  ComposerCompleterSpec,
  ComposerWidgetSpec,
  ConversationActionSpec,
  ConversationDetail,
  ConversationLive,
  ConversationScope,
  ConversationSummary,
  CredentialSummary,
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
  TimelineEntryActionSpec,
  TimelineRendererSpec,
  ToolViewSpec,
  WorkbenchPanelSpec,
} from '@helm/protocol'
import { matchesConversationScope } from '@helm/protocol'
import type { ModelDescriptor } from './api.js'
import type { SessionDocKey } from './session-docs.js'

export type { SessionDocKey }

export type ThemeMode = 'light' | 'dark'
export type ThemePreference = 'system' | 'light' | 'dark'

/** Screen 参数键：非空且仅限字母/数字/点/下划线/连字符（URL 查询串命名空间内的稳定子键）。 */
export const SCREEN_PARAM_KEY_PATTERN = /^[A-Za-z0-9._-]+$/

/** URL 参数键中的保留名：拒绝挂到普通对象上（防原型污染）。 */
const PROTOTYPE_PARAM_KEY_RE = /^(?:__proto__|constructor|prototype)$/

export const isPrototypeParamKey = (key: string): boolean => PROTOTYPE_PARAM_KEY_RE.test(key)

export type ResolvedTarget =
  | { kind: 'conversation'; conversationId: number }
  | { kind: 'screen'; pluginId: string; screenId: string; params?: Record<string, string> }
  | { kind: 'plugins'; pluginId?: string }
  | { kind: 'profiles'; profileId?: string }
  | { kind: 'skills'; skillId?: string }
  | { kind: 'nodes'; nodeId?: string }
  | { kind: 'models'; providerId?: string }

export type ActiveModal =
  | { kind: 'command-palette' }
  | { kind: 'profile-editor'; profileId?: string }
  | { kind: 'provider-auth' }
  | { kind: 'skill-viewer'; skillId?: string }
  | { kind: 'plugin-settings'; pluginId?: string }
  | { kind: 'nodes'; nodeId?: string }
  | { kind: 'artifact-preview'; artifactId: string; conversationId?: number }
  | { kind: 'conversation-drawer'; conversationId: number }
  | null

export interface QualifiedUiSpec<T> {
  pluginId: string
  spec: T
}

export interface GroupedUiSpecs {
  sidebarItems: Array<QualifiedUiSpec<SidebarItemSpec>>
  sidebarSections: Array<QualifiedUiSpec<SidebarSectionSpec>>
  screens: Array<QualifiedUiSpec<ScreenSpec>>
  timelineRenderers: Array<QualifiedUiSpec<TimelineRendererSpec>>
  toolViews: Array<QualifiedUiSpec<ToolViewSpec>>
  composerPills: Array<QualifiedUiSpec<ComposerPillSpec>>
  composerWidgets: Array<QualifiedUiSpec<ComposerWidgetSpec>>
  composerCompleters: Array<QualifiedUiSpec<ComposerCompleterSpec>>
  artifactPreviewers: Array<QualifiedUiSpec<ArtifactPreviewerSpec>>
  workbenchPanels: Array<QualifiedUiSpec<WorkbenchPanelSpec>>
  commands: Array<QualifiedUiSpec<CommandSpec>>
  settingsPanels: Array<QualifiedUiSpec<SettingsPanelSpec>>
  profileRuntimes: Array<QualifiedUiSpec<ProfileRuntimeUiSpec>>
  conversationHeaderActions: Array<QualifiedUiSpec<ConversationActionSpec>>
  conversationRowActions: Array<QualifiedUiSpec<ConversationActionSpec>>
  timelineEntryActions: Array<QualifiedUiSpec<TimelineEntryActionSpec>>
  pluginSlots: Array<QualifiedUiSpec<PluginSlotContributionSpec>>
}

export interface ToastNotice extends NotificationEvent {
  id: string
  createdAt: number
}

/** 判断会话是否命中插件声明的 ConversationScope。 */
export function matchesUiScope(
  conversation: ConversationSummary | undefined,
  scope: ConversationScope | undefined,
): boolean {
  if (!scope) return true
  if (!conversation) return false
  return matchesConversationScope(scope, conversation)
}

/** 将 UI 贡献列表按扩展面分组并排序。 */
export function groupUiContributions(contributions: PluginUiContribution[]): GroupedUiSpecs {
  const grouped: GroupedUiSpecs = {
    sidebarItems: [],
    sidebarSections: [],
    screens: [],
    timelineRenderers: [],
    toolViews: [],
    composerPills: [],
    composerWidgets: [],
    composerCompleters: [],
    artifactPreviewers: [],
    workbenchPanels: [],
    commands: [],
    settingsPanels: [],
    profileRuntimes: [],
    conversationHeaderActions: [],
    conversationRowActions: [],
    timelineEntryActions: [],
    pluginSlots: [],
  }
  for (const item of contributions) {
    const spec = item.spec as Record<string, unknown> | undefined
    if (!spec || typeof spec !== 'object') continue
    switch (item.surface) {
      case 'sidebar.item':
        grouped.sidebarItems.push({ pluginId: item.pluginId, spec: spec as unknown as SidebarItemSpec })
        break
      case 'sidebar.section':
        grouped.sidebarSections.push({ pluginId: item.pluginId, spec: spec as unknown as SidebarSectionSpec })
        break
      case 'screen':
        grouped.screens.push({ pluginId: item.pluginId, spec: spec as unknown as ScreenSpec })
        break
      case 'timeline.renderer':
        grouped.timelineRenderers.push({ pluginId: item.pluginId, spec: spec as unknown as TimelineRendererSpec })
        break
      case 'tool.view':
        grouped.toolViews.push({ pluginId: item.pluginId, spec: spec as unknown as ToolViewSpec })
        break
      case 'composer.pill':
        grouped.composerPills.push({ pluginId: item.pluginId, spec: spec as unknown as ComposerPillSpec })
        break
      case 'composer.widget':
        grouped.composerWidgets.push({ pluginId: item.pluginId, spec: spec as unknown as ComposerWidgetSpec })
        break
      case 'composer.completer':
        grouped.composerCompleters.push({ pluginId: item.pluginId, spec: spec as unknown as ComposerCompleterSpec })
        break
      case 'artifact.previewer':
        grouped.artifactPreviewers.push({ pluginId: item.pluginId, spec: spec as unknown as ArtifactPreviewerSpec })
        break
      case 'workbench.panel':
        grouped.workbenchPanels.push({ pluginId: item.pluginId, spec: spec as unknown as WorkbenchPanelSpec })
        break
      case 'commandPalette':
      case 'command':
        grouped.commands.push({ pluginId: item.pluginId, spec: spec as unknown as CommandSpec })
        break
      case 'profile.runtime':
        grouped.profileRuntimes.push({ pluginId: item.pluginId, spec: spec as unknown as ProfileRuntimeUiSpec })
        break
      case 'conversation.header.action':
        grouped.conversationHeaderActions.push({ pluginId: item.pluginId, spec: spec as unknown as ConversationActionSpec })
        break
      case 'conversation.row.action':
        grouped.conversationRowActions.push({ pluginId: item.pluginId, spec: spec as unknown as ConversationActionSpec })
        break
      case 'timeline.entry.action':
        grouped.timelineEntryActions.push({ pluginId: item.pluginId, spec: spec as unknown as TimelineEntryActionSpec })
        break
      case 'plugin.slot':
        grouped.pluginSlots.push({ pluginId: item.pluginId, spec: spec as unknown as PluginSlotContributionSpec })
        break
      case 'settings.panel':
        grouped.settingsPanels.push({ pluginId: item.pluginId, spec: spec as unknown as SettingsPanelSpec })
        break
    }
  }
  const sidebarOrder = (spec: SidebarItemSpec): number => spec.order ?? 100
  grouped.sidebarItems.sort((a, b) => sidebarOrder(a.spec) - sidebarOrder(b.spec))
  grouped.sidebarSections.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.workbenchPanels.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.settingsPanels.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.profileRuntimes.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.conversationHeaderActions.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.conversationRowActions.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.timelineEntryActions.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  return grouped
}

/**
 * 解析声明式导航目标字符串：
 * - 'conversation:1' / 'conversation:42'
 * - 'conversation:profile:superagent' -> 查找该 profileId 的常驻或最新会话
 * - 'conversation:tag:worker' -> 查找含该 tag 的最新会话
 * - 'screen:builtin:herdr/overview' -> 打开全屏插件视图
 * - 'screen:<pluginId>/<screenId>?k1=v1&k2=v2' -> 打开携带路由参数的全屏插件视图
 *
 * screen 查询串采用严格解析：非法百分号编码、空键值、重复键与保留的原型键一律整体判无效。
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
    const providerId = target.slice('models:'.length).trim()
    return providerId === '' ? { kind: 'models' } : { kind: 'models', providerId }
  }
  if (target.startsWith('conversation:profile:')) {
    const profileId = target.slice('conversation:profile:'.length).trim()
    // 常驻会话优先：无 parentConversationId 的即插件/用户直接创建的长期会话，
    // 派生 Worker（有父链）不在此列，不做任何标签名硬编码。
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
 * 严格解析 `k1=v1&k2=v2` 查询串为 Screen 参数：
 * - 键必须匹配 SCREEN_PARAM_KEY_PATTERN（含拒 __proto__ / constructor 等原型键）；
 * - 值可含任意字符但不得为空串；非法百分号编码（decodeURIComponent 抛出）判整体无效；
 * - 重复键判整体无效（不得静默取其一）；返回 undefined 表示无有效参数。
 * 返回 null 表示查询串非法，调用方必须让整个目标判无效。
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
    return a.providerId === b.providerId
  }
  return false
}

export interface HelmStoreValue {
  // 鉴权与连接状态
  authReady: boolean
  authConfigured: boolean
  authenticated: boolean
  authError: string | null
  connectionError: string | null
  loadErrors: Record<string, string>
  sseConnected: boolean
  theme: ThemeMode
  themePreference: ThemePreference

  // 核心实时数据
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

  // 静态配置资产
  profiles: Profile[]
  models: ModelDescriptor[]
  providers: ProviderConfig[]
  credentials: CredentialSummary[]
  skills: SkillSummary[]
  actions: ActionManifest[]

  // 视图路由与工作台状态
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  workbenchOpen: boolean
  workbenchTab: string // 'artifacts' | `plugin:${pluginId}/${panelId}`（动态页签，由 WorkbenchDrawer 回退）
  activeModal: ActiveModal
  highlightedEntry: { conversationId: number; entryId: string } | null
  notices: ToastNotice[]

  // 操作方法
  setTheme(theme: ThemeMode): void
  setThemePreference(pref: ThemePreference): void
  toggleTheme(): void
  checkAuth(): Promise<void>
  onAuthenticated(token: string): Promise<void>
  logout(): void
  refreshAssets(): Promise<void>
  refreshNodes(): Promise<NodeInfo[] | undefined>
  loadConversationDetail(conversationId: number, force?: boolean): Promise<ConversationDetail | undefined>
  loadEarlierEntries(conversationId: number): Promise<void>
  loadConversationArtifacts(conversationId: number): Promise<ArtifactMetadata[] | undefined>
  ensurePluginDoc(pluginId: string, docName: string): Promise<unknown>
  /** 订阅会话级文档元组（ref-count 共享专用 SSE 流；详见 lib/session-docs.ts）。 */
  subscribeSessionDoc(key: SessionDocKey, listener: () => void): () => void
  /** 读取会话级文档当前缓存态（含错误与删除标记；未订阅返回空态）。 */
  getSessionDocState(key: SessionDocKey): { value?: unknown; hasValue: boolean; deleted: boolean; error?: string; connected: boolean }
  /** 一次性读取会话级文档（GET /api/plugins/:id/docs/:name?conversationId=）。 */
  getPluginSessionDoc(pluginId: string, docName: string, conversationId: number): Promise<unknown>
  /** 会话级文档显式重连（订阅错误后的 UI 重试入口）。 */
  retrySessionDoc(key: SessionDocKey): void
  openTarget(target: string | ResolvedTarget, opts?: { split?: boolean; highlightEntryId?: string }): void
  closeSplit(): void
  /** 更新当前 screen 路由参数（undefined 值删除键）；split 省略时作用于主屏。 */
  setScreenParams(patch: Record<string, string | undefined>, options?: { split?: boolean; push?: boolean }): void
  setWorkbenchOpen(open: boolean): void
  setWorkbenchTab(tab: string): void
  setActiveModal(modal: ActiveModal): void
  dismissNotice(id: string): void
  pushNotice(notice: Omit<ToastNotice, 'id' | 'createdAt'>): void
  invokePluginAction(pluginId: string, actionId: string, input: unknown, conversationId?: number): Promise<unknown>
}
