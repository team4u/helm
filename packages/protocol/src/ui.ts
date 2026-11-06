/**
 * 前端 7 大全界面扩展点（10 个注册方法）。
 * 每个扩展点双轨渲染：声明式 @json-render JSON Spec（零前端构建）
 * 或 client.tsx 具名导出引用（宿主共享 React 运行时，本包不引 React 类型）。
 */

import type { ConversationEntry, ConversationScope, ConversationSummary } from './conversation.js'

/** 插件 client.tsx 编译产物中的具名导出引用。 */
export interface ClientComponentRef {
  /** 源模块文件名，约定 'client.tsx'。 */
  module: string
  /** 具名导出名。 */
  export: string
}

/** 所有 UI 扩展点公共形状。 */
export interface UiSpecBase {
  /** 扩展点内唯一 ID（最终寻址为 <extension>:<pluginId>/<id>）。 */
  id: string
  title?: string
  /** 声明式 JSON Spec，由 @json-render 渲染。 */
  json?: Record<string, unknown>
  /** client.tsx 组件引用。 */
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
