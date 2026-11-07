/**
 * 前端 7 大全界面扩展点（10 个注册方法）。
 * 每个扩展点双轨渲染：声明式 @json-render JSON Spec（零前端构建）
 * 或 client.tsx 具名导出引用（宿主共享 React 运行时，本包不引 React 类型）。
 */

import type { ConversationEntry, ConversationScope, ConversationSummary } from './conversation.js'

/** 插件 client.tsx 编译产物中的具名导出引用。 */
export interface ClientComponentRef {
  /** 相对插件 clientRoot 的源模块路径（如 'client.tsx'、'panels/Status.tsx'；禁止绝对路径/越根 ../）。 */
  module: string
  /** 具名导出名。 */
  export: string
}

/** 所有 UI 扩展点公共形状。 */
export interface UiSpecBase {
  /** 扩展点内唯一 ID（最终寻址为 <extension>:<pluginId>/<id>）。 */
  id: string
  title?: string
  /**
   * 声明式 JSON Spec，由 @json-render 渲染。
   * 双轨优先级：同时声明 json 与 client 时 client 优先（富交互完整能力），
   * json 作为宿主不支持动态加载时的显式降级提示而非静默丢弃。
   */
  json?: Record<string, unknown>
  /** client.tsx 组件引用（需插件定义提供 clientRoot；双轨并存时优先于 json）。 */
  client?: ClientComponentRef
  /** 声明式轨道订阅的本插件公开文档名（挂载至 $docs/<docName>）；必须是同插件 public doc。 */
  docs?: string[]
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
  /** 接管的 entry kind 列表；缺省接管全部。 */
  kinds?: string[]
  /** 接管 entry.data.renderer 等于本值的条目（与 kinds 取 AND）。 */
  matchMeta?: { renderer: string }
}

// 4. tool.view（按 toolName 接管工具调用内联卡片）
export interface ToolViewSpec extends UiSpecBase {
  toolNames: string[]
}

// 5. composer.pill & composer.widget
export interface ComposerPillSpec extends UiSpecBase {
  label: string
  icon?: string
}

export interface ComposerWidgetSpec extends UiSpecBase {}

// 6. workbench.panel（会话感知右栏抽屉面板）
export interface WorkbenchPanelSpec extends UiSpecBase {
  label: string
  icon?: string
  order?: number
}

// 7. commandPalette (⌘K) & settings.panel
export interface CommandSpec extends UiSpecBase {
  title: string
  /** 快捷命令复用 ctx.action 端点。 */
  actionId?: string
  input?: Record<string, unknown>
  keywords?: string[]
}

export interface SettingsPanelSpec extends UiSpecBase {
  label: string
  order?: number
}

/** ctx.ui：前端 7 大扩展点共 10 个注册方法。 */
export interface PluginUiRegistry {
  sidebarItem(spec: SidebarItemSpec): void
  sidebarSection(spec: SidebarSectionSpec): void
  screen(spec: ScreenSpec): void
  timelineRenderer(spec: TimelineRendererSpec): void
  toolView(spec: ToolViewSpec): void
  composerPill(spec: ComposerPillSpec): void
  composerWidget(spec: ComposerWidgetSpec): void
  workbenchPanel(spec: WorkbenchPanelSpec): void
  command(spec: CommandSpec): void
  settingsPanel(spec: SettingsPanelSpec): void
}

// ---------------------------------------------------------------------------
// 标准组件 Props（纯数据形状，供 client.tsx 实现与宿主传递；不引 React 类型）
// ---------------------------------------------------------------------------

/** screen：全屏自定义视图（支持左右 Split View 并排展示）。 */
export interface ScreenProps {
  pluginId: string
  screenId: string
}

/** timeline.renderer：接管单条时间线条目的渲染。 */
export interface TimelineRendererProps {
  entry: ConversationEntry
  conversationId: number
}

/** tool.view：工具调用过程与结果的可序列化数据。 */
export interface ToolViewProps {
  callId: string
  toolName: string
  input?: unknown
  status: 'running' | 'done' | 'error'
  result?: unknown
  conversationId: number
}

/** composer.pill / composer.widget：输入区扩展。 */
export interface ComposerScopeProps {
  conversation: ConversationSummary
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
export interface PluginClientContext {
  pluginId: string
  /** 调用本插件动作（POST /api/actions/:pluginId/:actionId）。 */
  callAction(actionId: string, input?: unknown): Promise<unknown>
  /** 在主屏打开目标（conversation:<id> / screen:<pluginId>/<screenId> 等）。 */
  openScreen(target: string): void
  /** 在右侧分屏打开目标。 */
  openSplitScreen(target: string): void
  /** 读取本插件公共文档当前值（一次性 Promise；订阅式更新用 usePluginDoc 共享 hook）。 */
  getPluginDoc(docName: string): Promise<unknown>
  /** 当前会话 ID（无会话上下文的槽位为 undefined，如部分 settings.panel）。 */
  conversationId?: number
  /** 宿主当前主题。 */
  theme: 'light' | 'dark'
}

/**
 * 插件 client.tsx 可导入的宿主共享模块（编译器虚拟化为 __helm_shared_plugin_client
 * 全局命名空间，与 React 同机制共享，绝不打包第二份 React）：
 *
 *   import { usePluginContext, usePluginDoc } from '@helm/plugin-client'
 *
 * - usePluginContext：等价宿主 React Context usePluginContext（必须在 <PluginUiView> 内）；
 * - usePluginDoc<T>(docName)：响应式订阅本插件 public doc（SSE plugin.doc.updated
 *   实时重渲染，与宿主 usePluginDoc 同一 store，不足 Promise 轮询）。
 */
export const HELM_PLUGIN_CLIENT_SHARED_MODULE = '@helm/plugin-client'

/** GET /api/plugins/:id/client.mjs 响应元信息（错误时 HTTP 错误信封，不出 JS）。 */
export interface PluginClientModuleInfo {
  pluginId: string
  /** 请求的 module 相对路径。 */
  module: string
  /** 编译产物内容 hash（含全部本地依赖；源变更副重新编译）。 */
  contentHash: string
}
