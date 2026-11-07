import type {
  ActionManifest,
  ArtifactMetadata,
  AskSpec,
  CommandSpec,
  ComposerPillSpec,
  ComposerWidgetSpec,
  ConversationDetail,
  ConversationLive,
  ConversationScope,
  ConversationSummary,
  NotificationEvent,
  PluginSummary,
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
  WorkflowRunSummary,
} from '@helm/protocol'
import type { CredentialStatus, ModelDescriptor, SavedWorkflowSummary } from './api.js'

export type ThemeMode = 'light' | 'dark'

export type ResolvedTarget =
  | { kind: 'conversation'; conversationId: number }
  | { kind: 'screen'; pluginId: string; screenId: string }

export type ActiveModal =
  | { kind: 'command-palette' }
  | { kind: 'profile-editor'; profileId?: string }
  | { kind: 'provider-auth' }
  | { kind: 'skill-viewer'; skillId?: string }
  | { kind: 'plugin-settings'; pluginId?: string }
  | { kind: 'artifact-preview'; artifactId: string; conversationId?: number }
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
  workbenchPanels: Array<QualifiedUiSpec<WorkbenchPanelSpec>>
  commands: Array<QualifiedUiSpec<CommandSpec>>
  settingsPanels: Array<QualifiedUiSpec<SettingsPanelSpec>>
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
  if (scope.conversationIds !== undefined) {
    if (scope.conversationIds.length === 0) return false
    if (!scope.conversationIds.includes(conversation.id)) return false
  }
  if (scope.profileIds !== undefined) {
    if (scope.profileIds.length === 0) return false
    if (!scope.profileIds.includes(conversation.profileId)) return false
  }
  if (scope.tags !== undefined) {
    if (scope.tags.length === 0) return false
    if (!scope.tags.some((t) => conversation.tags.includes(t))) return false
  }
  return true
}

/** 将 UI 贡献列表按 10 个扩展点分组并排序。 */
export function groupUiContributions(contributions: PluginUiContribution[]): GroupedUiSpecs {
  const grouped: GroupedUiSpecs = {
    sidebarItems: [],
    sidebarSections: [],
    screens: [],
    timelineRenderers: [],
    toolViews: [],
    composerPills: [],
    composerWidgets: [],
    workbenchPanels: [],
    commands: [],
    settingsPanels: [],
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
      case 'workbench.panel':
        grouped.workbenchPanels.push({ pluginId: item.pluginId, spec: spec as unknown as WorkbenchPanelSpec })
        break
      case 'commandPalette':
      case 'command':
        grouped.commands.push({ pluginId: item.pluginId, spec: spec as unknown as CommandSpec })
        break
      case 'settings.panel':
        grouped.settingsPanels.push({ pluginId: item.pluginId, spec: spec as unknown as SettingsPanelSpec })
        break
    }
  }
  const sidebarOrder = (spec: SidebarItemSpec): number => {
    if (spec.order !== undefined) return spec.order
    if (spec.id === 'assistant' || spec.target === 'conversation:1') return 0
    return 100
  }
  grouped.sidebarItems.sort((a, b) => sidebarOrder(a.spec) - sidebarOrder(b.spec))
  grouped.sidebarSections.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.workbenchPanels.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  grouped.settingsPanels.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100))
  return grouped
}

/**
 * 解析声明式导航目标字符串：
 * - 'conversation:1' / 'conversation:42'
 * - 'conversation:profile:superagent' -> 查找该 profileId 的常驻或最新会话
 * - 'conversation:tag:worker' -> 查找含该 tag 的最新会话
 * - 'screen:builtin:herdr/overview' -> 打开全屏插件视图
 */
export function resolveTargetString(
  rawTarget: string,
  conversations: ConversationSummary[],
): ResolvedTarget | null {
  const target = rawTarget.trim()
  if (target.startsWith('conversation:profile:')) {
    const profileId = target.slice('conversation:profile:'.length).trim()
    const matched = conversations.find((c) => c.profileId === profileId && !c.tags.includes('worker'))
      ?? conversations.find((c) => c.profileId === profileId)
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
    const slashIdx = rest.lastIndexOf('/')
    if (slashIdx > 0 && slashIdx < rest.length - 1) {
      return {
        kind: 'screen',
        pluginId: rest.slice(0, slashIdx),
        screenId: rest.slice(slashIdx + 1),
      }
    }
  }
  return null
}

export function isSameResolvedTarget(a: ResolvedTarget | null, b: ResolvedTarget | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'conversation' && b.kind === 'conversation') {
    return a.conversationId === b.conversationId
  }
  if (a.kind === 'screen' && b.kind === 'screen') {
    return a.pluginId === b.pluginId && a.screenId === b.screenId
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
  workflowRuns: WorkflowRunSummary[]
  savedWorkflows: SavedWorkflowSummary[]

  // 静态配置资产
  profiles: Profile[]
  models: ModelDescriptor[]
  providers: ProviderConfig[]
  credentials: CredentialStatus[]
  skills: SkillSummary[]
  actions: ActionManifest[]

  // 视图路由与工作台状态
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  workbenchOpen: boolean
  workbenchTab: string // 'tasks' | 'artifacts' | `plugin:${pluginId}/${panelId}`
  activeModal: ActiveModal
  highlightedEntry: { conversationId: number; entryId: string } | null
  notices: ToastNotice[]

  // 操作方法
  setTheme(theme: ThemeMode): void
  toggleTheme(): void
  checkAuth(): Promise<void>
  onAuthenticated(token: string): Promise<void>
  logout(): void
  refreshAssets(): Promise<void>
  loadConversationDetail(conversationId: number, force?: boolean): Promise<ConversationDetail | undefined>
  loadEarlierEntries(conversationId: number): Promise<void>
  loadConversationArtifacts(conversationId: number): Promise<ArtifactMetadata[] | undefined>
  ensurePluginDoc(pluginId: string, docName: string): Promise<unknown>
  openTarget(target: string | ResolvedTarget, opts?: { split?: boolean; highlightEntryId?: string }): void
  closeSplit(): void
  setWorkbenchOpen(open: boolean): void
  setWorkbenchTab(tab: string): void
  setActiveModal(modal: ActiveModal): void
  dismissNotice(id: string): void
  pushNotice(notice: Omit<ToastNotice, 'id' | 'createdAt'>): void
  invokePluginAction(pluginId: string, actionId: string, input: unknown, conversationId?: number): Promise<unknown>
}
