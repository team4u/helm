/**
 * 前端扩展面：基础界面、微操作、运行时元数据与插件子插槽。
 * 每个扩展点经 client.tsx 具名导出引用渲染（宿主共享 React 运行时，本包不引 React 类型）。
 */

import type { ConversationAttachmentRef, ConversationEntry, ConversationScope, ConversationSummary, WhenBusy } from './conversation.js'
import type { PluginSummary } from './plugin.js'

/** 编译器保留的 CSS 文本导出名；加载器确认模块有效后才将其挂入页面。 */
export const PLUGIN_CLIENT_CSS_EXPORT = '__helmClientCss' as const

/** 插件 client.tsx 编译产物中的具名导出引用。 */
export interface ClientComponentRef {
  /** 相对插件 clientRoot 的源模块路径（如 'client.tsx'、'panels/Status.tsx'；禁止绝对路径/越根 ../）。 */
  module: string
  /** 具名导出名。 */
  export: string
}

/** 所有 UI 扩展点公共形状（仅 client.tsx 轨道：声明式 JSON Spec 已整体迁出内核，由 builtin:json-render 插件经 markdown 代码块扩展提供）。 */
export interface UiSpecBase {
  /** 扩展点内唯一 ID（最终寻址为 <extension>:<pluginId>/<id>）。 */
  id: string
  title?: string
  /** client.tsx 组件引用（需插件定义提供 clientRoot）。 */
  client?: ClientComponentRef
  /** 会话作用域：仅命中会话（或无会话上下文时）渲染本扩展点。 */
  scope?: ConversationScope
}

// 1. sidebar.item & sidebar.section
export interface SidebarItemSpec extends UiSpecBase {
  label: string
  icon?: string
  /** 点击目标，如 'conversation:1'、'conversation:profile:superagent'、'screen:builtin:superagent/recall-graph'。 */
  target?: string
  order?: number
}

export interface SidebarSectionSpec extends UiSpecBase {
  label: string
  icon?: string
  /** 分组内会话过滤标签（如 'worker'）。 */
  filterTag?: string
  /** 是否支持折叠及默认折叠态（如已归档分组）。 */
  collapsible?: boolean
  defaultCollapsed?: boolean
  order?: number
}

// 2. screen（全屏自定义视图，支持左右 Split View 并排）
export interface ScreenSpec extends UiSpecBase {
  label: string
  icon?: string
}

// 3. timeline.renderer（按 entry kind / 元数据接管时间线条目）
export interface TimelineRendererSpec extends UiSpecBase {
  /** 优先级降序；同优先级保持贡献顺序，缺省 0。 */
  priority?: number
  /** 接管的 entry kind 列表；缺省接管全部。 */
  kinds?: string[]
  /** 接管 entry.data.renderer 等于本值的条目（与 kinds 取 AND）。 */
  matchMeta?: { renderer: string }
}

// 3.5 markdown.codeBlock（按围栏语言接管 Markdown 代码块渲染）
export interface MarkdownCodeBlockSpec extends UiSpecBase {
  /** 接管的围栏语言列表（如 ['ui', 'json-render']、['mermaid']；不可为空、项不得重复）。 */
  languages: string[]
  /** 优先级降序；同优先级保持贡献顺序，缺省 0。同语言多插件冲突时取最高优先级，平级取贡献顺序在先者。 */
  priority?: number
  /** 组件引用（需插件定义提供 clientRoot）；无匹配注册或插件停用时回退普通代码块。 */
  client: ClientComponentRef
}

/** markdown.codeBlock 组件收到的标准 Props。 */
export interface MarkdownCodeBlockProps {
  /** 小写化的围栏语言（与声明 languages 精确匹配，不做子串/前缀）。 */
  language: string
  /** 代码块原始文本（去尾部换行；未经任何解析——JSON 合法性由组件自行判定）。 */
  code: string
  /** 所在会话上下文（无会话渲染场景为 undefined）。 */
  conversationId?: number
}

// 4. tool.view（按 toolName 接管工具调用内联卡片）
export interface ToolViewSpec extends UiSpecBase {
  priority?: number
  toolNames: string[]
  /**
   * true 时完全替换外层默认 .trace-row 工具行（由插件组件自行渲染胶囊横条与内嵌详情），
   * 避免出现上下双横条。
   */
  replaceRow?: boolean
}

// 5. composer.pill & composer.widget
export interface ComposerPillSpec extends UiSpecBase {
  label: string
  icon?: string
}

export interface ComposerWidgetSpec extends UiSpecBase {}
/** 补全仅插入文本，不执行候选携带的命令。 */
export interface ComposerCompletionItem {
  id: string
  label: string
  insertText: string
  hint?: string
  icon?: string
}

/** 查询动作只接收文本与会话身份；nodeId/cwd 应从服务端真实会话解析。 */
export interface ComposerCompletionQuery {
  query: string
  conversationId: number
}

export interface ComposerCompletionResult {
  items: ComposerCompletionItem[]
}

/** 文档源只读取贡献插件自己的公开文档；itemsField 为顶层数组字段名。 */
export type ComposerCompletionSource =
  | { kind: 'action'; actionId: string; actionPluginId?: string }
  | { kind: 'doc' | 'sessionDoc'; name: string; itemsField: string }

/** 补全由宿主统一渲染，不接受 client 回调或视图。'/' 保留给命令和技能。 */
export interface ComposerCompleterSpec extends Omit<UiSpecBase, 'client'> {
  label: string
  trigger: '@' | '#' | ':'
  priority?: number
  source: ComposerCompletionSource
}

/** MIME 精确值或 type/*；extensions 为含点号的小写后缀（含多段后缀）。两类匹配取 OR。 */
export interface ArtifactPreviewerSpec extends UiSpecBase {
  label: string
  icon?: string
  priority?: number
  mimeTypes?: string[]
  extensions?: string[]
}

/** 预览组件在主站运行，是可信插件代码；blob 内容不是可信 HTML。 */
export interface ArtifactPreviewerProps {
  artifactId: string
  conversationId?: number
  /** 未加载名称元数据时缺省，不用 artifactId 冒充文件名。 */
  name?: string
  mimeType: string
  size: number
  /** 由宿主管理生命周期，插件不得自行撤销。 */
  blobUrl: string
  /** 仅解码最多 1 MiB 的文本内容；二进制或超限时为 null。 */
  text: string | null
}

// 6. workbench.panel（会话感知右栏抽屉面板）
export interface WorkbenchPanelBadgeSpec {
  /** 订阅的本插件 public doc 名称。 */
  doc: string
  /** 全局数字计数字段名（读取 docValue[countField]）。 */
  countField?: string
  /** 全局角标色调字段名（读取 docValue[toneField]，值：'warn' | 'accent' | 'neutral'）。 */
  toneField?: string
  /**
   * 按会话 ID 索引的统计映射字段名（读取 docValue[byConversationField][String(conversationId)]，
   * 形状为 { count: number; tone?: 'warn' | 'accent' | 'neutral'; footerText?: string }）。
   */
  byConversationField?: string
}

export interface WorkbenchPanelSpec extends UiSpecBase {
  label: string
  icon?: string
  order?: number
  /** 动态角标与状态栏配置（驱动工作台抽屉页签计数、底部摘要与顶栏「工作台」按钮汇总角标）。 */
  badge?: WorkbenchPanelBadgeSpec
}

// 7. commandPalette (⌘K) & settings.panel
export interface CommandSpec extends UiSpecBase {
  title: string
  icon?: string
  /** 不含 / 的触发词；同时派生输入区斜杠菜单。不允许覆盖宿主保留命令。 */
  slash?: string
  description?: string
  /** 快捷命令复用 ctx.action 端点。 */
  actionId?: string
  actionPluginId?: string
  input?: Record<string, unknown>
  keywords?: string[]
}

export interface SettingsPanelSpec extends UiSpecBase {
  label: string
  order?: number
}

/** 外部 Profile 运行时元数据；表单结构由宿主通用 ProfileRuntime 契约驱动。 */
export interface ProfileRuntimeUiSpec {
  id: string
  kind: string
  label: string
  icon?: string
  description?: string
  agentSuggestions?: string[]
  order?: number
}

/** UI 动作统一声明：同一形态服务三类微插槽（target 区分），不再维护三个重复方法。 */
export interface UiActionSpec extends UiSpecBase {
  target: 'conversation:header' | 'conversation:row' | 'timeline:entry'
  label: string
  icon?: string
  order?: number
  /** 仅 conversation:header：'toolbar' 直出按钮组，'menu'（缺省）收纳下拉菜单。 */
  placement?: 'toolbar' | 'menu'
  /** 绑定宿主代管执行的插件动作（与 client 二选一；两者皆缺在注册边界拒绝）。 */
  actionId?: string
  actionPluginId?: string
  input?: Record<string, unknown>
  /** 仅 timeline:entry：接管条目 kind 列表（缺省匹配全部）。 */
  kinds?: string[]
  /** 仅 timeline:entry：接管文本消息角色。 */
  roles?: Array<'user' | 'assistant'>
}

/** 向另一个插件的具名子插槽注入内容。 */
export interface PluginSlotContributionSpec extends UiSpecBase {
  /** <ownerPluginId>/<slotName>，必须恰有一个 /。 */
  target: string
  order?: number
  priority?: number
}

/** Profile 详情抽屉的插件扩展子插槽全限定名（builtin:profile 提供，其他插件注入）。 */
export const PROFILE_DETAIL_SECTION_SLOT = 'builtin:profile/detail-section' as const

/** 宿主节点中心保留的命名空间，不代表存在 builtin:node 插件。 */
export const NODE_DETAIL_SECTION_SLOT = 'builtin:node/detail-section' as const

/** 仅已有节点挂载；不包含节点接入令牌或其他凭据。 */
export interface NodeDetailSlotProps {
  nodeId: string
  isLocal: boolean
  isOnline: boolean
  isNew: boolean
}

/** target: PROFILE_DETAIL_SECTION_SLOT 子插槽传递给插件 client.tsx 组件的通用 Props（不含具体插件业务字段）。 */
export interface ProfileDetailSlotProps {
  /** 当前正在查看/编辑的单个 Profile ID（新建模式为空串）。 */
  profileId: string
  /** 是否处于新建 Profile 模式（尚未创建落盘）。 */
  isNew: boolean
  /** 宿主抽屉是否处于保存或删除中的禁用态。 */
  disabled: boolean
}

/** ctx.ui：基础扩展面与细粒度组合扩展面。 */
export interface PluginUiRegistry {
  sidebarItem(spec: SidebarItemSpec): void
  sidebarSection(spec: SidebarSectionSpec): void
  screen(spec: ScreenSpec): void
  timelineRenderer(spec: TimelineRendererSpec): void
  markdownCodeBlock(spec: MarkdownCodeBlockSpec): void
  toolView(spec: ToolViewSpec): void
  composerPill(spec: ComposerPillSpec): void
  composerWidget(spec: ComposerWidgetSpec): void
  composerCompleter(spec: ComposerCompleterSpec): void
  artifactPreviewer(spec: ArtifactPreviewerSpec): void
  workbenchPanel(spec: WorkbenchPanelSpec): void
  command(spec: CommandSpec): void
  settingsPanel(spec: SettingsPanelSpec): void
  profileRuntime(spec: ProfileRuntimeUiSpec): void
  /** UI 动作统一注册（conversation:header / conversation:row / timeline:entry 三类微插槽）。 */
  action(spec: UiActionSpec): void
  slot(spec: PluginSlotContributionSpec): void
}

// ---------------------------------------------------------------------------
// 标准组件 Props（纯数据形状，供 client.tsx 实现与宿主传递；不引 React 类型）
// ---------------------------------------------------------------------------

/** screen：全屏自定义视图（支持左右 Split View 并排展示）。 */
export interface ScreenProps {
  pluginId: string
  screenId: string
  isSplit: boolean
  params: Readonly<Record<string, string>>
  /** undefined 删除键；默认替换历史记录，显式 push 才新增记录。 */
  setParams(patch: Record<string, string | undefined>, options?: { push?: boolean }): void
}

/** timeline.renderer：接管单条时间线条目的渲染。 */
export interface TimelineRendererProps {
  entry: ConversationEntry
  conversationId: number
}

/** 同会话内全部工具调用的轻量摘要（供插件组件自行去重，如同子会话多次 resume 折叠）。 */
export interface ToolViewSiblingCall {
  callId: string
  toolName: string
  input?: unknown
  status: 'running' | 'done' | 'error'
  result?: unknown
  structuredOutput?: unknown
}

/** tool.view：工具调用过程与结果的可序列化数据。 */
export interface ToolViewProps {
  callId: string
  toolName: string
  input?: unknown
  status: 'running' | 'done' | 'error'
  result?: unknown
  structuredOutput?: unknown
  isError?: boolean
  startedAt?: number
  durationMs?: number
  artifactRef?: string
  conversationId: number
  /** 当前已加载时间线内的全部工具调用（按时间顺序），供插件自行计算折叠/续接关系。 */
  siblingCalls?: ReadonlyArray<ToolViewSiblingCall>
}

export interface ComposerController {
  readonly draft: string
  readonly attachments: ReadonlyArray<ConversationAttachmentRef>
  readonly sending: boolean
  setDraft(text: string): void
  insertText(text: string): void
  /** 省略 text 时提交当前草稿及附件；显式 text 时不消费原草稿。失败必须 reject。 */
  submit(text?: string, options?: { whenBusy?: WhenBusy }): Promise<void>
}

/** composer.pill / composer.widget：输入区扩展。 */
export interface ComposerScopeProps {
  conversation: ConversationSummary
  composer: ComposerController
}

/** workbench.panel：会话感知右栏抽屉面板。 */
export interface WorkbenchPanelProps {
  conversation: ConversationSummary
}

/**
 * 序列化后的 UI 贡献（事件快照 ui 数组元素）：
 * surface 为扩展点名（如 'sidebar.item'、'screen'、'timeline.renderer'）。
 */
export interface PluginUiContribution {
  pluginId: string
  surface: string
  spec: unknown
}

// ---------------------------------------------------------------------------
// client.tsx 轨道：宿主与插件组件的运行时契约（纯类型，不引 React）
// ---------------------------------------------------------------------------

/**
 * client.tsx 组件内部的宿主上下文（usePluginContext() 返回值）：
 * 全部能力来自真实宿主（callAction 走 POST /api/actions，openScreen/openSplitScreen
 * 走宿主导航，getPluginDoc 一次性读取），无 mock。
 * 响应式文档订阅请用共享模块里的 usePluginDoc（import '@helm/plugin-client'）。
 */
export interface CallActionOptions {
  pluginId?: string
  conversationId?: number
}

export interface PluginClientContext {
  pluginId: string
  /** 默认寻址本插件与当前槽位会话，可显式跨插件调用。 */
  callAction(actionId: string, input?: unknown, options?: CallActionOptions): Promise<unknown>
  /** 向指定或当前会话提交输入；无会话时显式报错。 */
  submitInput(text: string, options?: { conversationId?: number; whenBusy?: WhenBusy }): Promise<void>
  /** 在主屏打开目标（conversation:<id> / screen:<pluginId>/<screenId> 等）。 */
  openScreen(target: string): void
  /** 在右侧分屏打开目标。 */
  openSplitScreen(target: string): void
  /** 打开子会话侧边抽屉模态（统一子会话查看入口；不改变当前工作台开关状态）。 */
  openConversationDrawer(conversationId: number): void
  /** 打开产物预览弹窗。 */
  openArtifact(artifactId: string): void
  /** 打开工作台抽屉（可指定激活面板 ID）。 */
  openWorkbench(panelId?: string): void
  /** 关闭工作台抽屉。 */
  closeWorkbench(): void
  /** 发送全局通知提示。 */
  notify(message: string, tone?: 'info' | 'warning' | 'error'): void
  /** 读取本插件公共文档当前值（一次性 Promise；订阅式更新用 usePluginDoc 共享 hook）。 */
  getPluginDoc(docName: string, pluginId?: string): Promise<unknown>
  getPluginSessionDoc(docName: string, options?: { conversationId?: number; pluginId?: string }): Promise<unknown>
  /** 仅输入区扩展及其子插槽提供。 */
  composer?: ComposerController
  /** 当前会话 ID（无会话上下文的槽位为 undefined，如部分 settings.panel）。 */
  conversationId?: number
  /** 宿主当前主题。 */
  theme: 'light' | 'dark'
}

/**
 * 插件 client.tsx 可导入的宿主共享模块（编译器虚拟化为 __helm_shared_plugin_client
 * 全局命名空间，与 React 同机制共享，绝不打包第二份 React）。
 *
 * 导出符号唯一真源见 PLUGIN_CLIENT_SHARED_EXPORTS：
 * - hooks：usePluginContext / usePluginDoc / usePluginSessionDoc / useToolActivity /
 *   useConversations / useConversation / usePlugins；
 * - 无障碍底座组件：Switch / Select / MultiSelect / Checkbox / Tabs 系列 /
 *   SegmentedControl / HelmIcon / ViewBoundary / Callout；
 * - 轻量布局原语：Screen（页面容器+页头）/ ScreenSection（分节）/
 *   DataTable（组合式表格，统一 loading/empty）/ KvGrid（键值概览）；
 * - 内容展示：MarkdownView（标准 Markdown 渲染）/ CodeBlockView（语法高亮代码块）/
 *   CopyButton（复制按钮）；
 * - PluginSlot：插件间子插槽渲染原语。
 */
export const HELM_PLUGIN_CLIENT_SHARED_MODULE = '@helm/plugin-client'

/** usePlugins()：宿主插件清单与 Screen 贡献的响应式快照（SSE 实时驱动，无轮询）。 */
export interface UsePluginsResult {
  /** 宿主当前全部插件摘要（随 SSE plugin.changed 实时同步）。 */
  plugins: PluginSummary[]
  /** 当前全部已启用插件注册的 Screen 贡献列表（含所属 pluginId）。 */
  screens: Array<{ pluginId: string; spec: ScreenSpec }>
}

/** GET /api/plugins/:id/client.mjs 响应元信息（错误时 HTTP 错误信封，不出 JS）。 */
export interface PluginClientModuleInfo {
  pluginId: string
  /** 请求的 module 相对路径。 */
  module: string
  /** 编译产物内容 hash（含全部本地依赖；源变更副重新编译）。 */
  contentHash: string
}

/** ctx.ui 全部注册方法名唯一真源（与 PluginUiRegistry 接口双向锁定）。 */
export const PLUGIN_UI_METHOD_NAMES = [
  'sidebarItem',
  'sidebarSection',
  'screen',
  'timelineRenderer',
  'markdownCodeBlock',
  'toolView',
  'composerPill',
  'composerWidget',
  'composerCompleter',
  'artifactPreviewer',
  'workbenchPanel',
  'command',
  'settingsPanel',
  'profileRuntime',
  'action',
  'slot',
] as const satisfies readonly (keyof PluginUiRegistry)[]

type _AssertAllPluginUiMethodsListed =
  Exclude<keyof PluginUiRegistry, (typeof PLUGIN_UI_METHOD_NAMES)[number]> extends never
    ? true
    : never
const _assertAllPluginUiMethodsListed: _AssertAllPluginUiMethodsListed = true
void _assertAllPluginUiMethodsListed

/** 宿主保留的会话内斜杠命令触发词（插件 command.slash 禁止占用）。 */
export const RESERVED_SLASH_COMMANDS = ['new', 'clear', 'compact'] as const

/** @helm/plugin-client 面向插件 client.tsx 导出的运行时符号唯一真源。 */
export const PLUGIN_CLIENT_SHARED_EXPORTS = [
  'usePluginContext',
  'usePluginDoc',
  'usePluginSessionDoc',
  'useToolActivity',
  'useConversations',
  'useConversation',
  'usePlugins',
  'PluginSlot',
  'Switch',
  'Select',
  'MultiSelect',
  'Checkbox',
  'Tabs',
  'TabsList',
  'TabsTrigger',
  'TabsContent',
  'SegmentedControl',
  'HelmIcon',
  'MarkdownView',
  'CodeBlockView',
  'CopyButton',
  'ViewBoundary',
  'Callout',
  'Dialog',
  'DialogPortal',
  'DialogOverlay',
  'DialogContent',
  'DialogTitle',
  'DialogDescription',
  'DialogClose',
  'DialogTrigger',
  'Screen',
  'ScreenSection',
  'DataTable',
  'KvGrid',
] as const

