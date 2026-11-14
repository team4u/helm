/**
 * @helm/plugin-client 公共 SDK 入口。
 *
 * 两个消费方共享同一模块实例（绝不打包第二份 React）：
 * 1. 宿主（@helm/web）：import 本包使用共享原语 / context / hooks，并在
 *    HelmStoreProvider 挂载 __helm_shared_plugin_client = 本模块命名空间；
 * 2. 插件编译产物：源码里 `import { ... } from '@helm/plugin-client'`，编译器
 *    把该说明符虚拟化为 globalThis.__helm_shared_plugin_client。
 *
 * 插件面向运行时符号唯一真源见 @helm/protocol 的 PLUGIN_CLIENT_SHARED_EXPORTS
 * （services.test / 本包 test 双向锁定）；宿主面向符号（宿主端口、上下文工厂、
 * 显式寻址 hooks）仅供宿主与测试消费，不属于插件契约清单。
 */

// ---- 宿主端口（注入面） ----
export { PluginClientHostContext, usePluginClientHost } from './host-port.js'
export type {
  PluginClientHostPort,
  PluginSessionDocKey,
  PluginSessionDocState,
  PluginSlotPortItem,
} from './host-port.js'

// ---- 插件上下文（usePluginContext）与工厂 ----
export { PluginClientContext, createPluginClientContext, usePluginContext } from './plugin-context.js'

// ---- hooks：文档订阅 / 会话 / 插件清单 / 工具活动 ----
export { usePluginDoc, usePluginDocValue, usePluginSessionDoc, usePluginSessionDocState, usePluginSessionDocValue } from './docs.js'
export type { ConversationHookResult } from './conversation-hooks.js'
export { useConversation, useConversations, usePlugins } from './conversation-hooks.js'
export { ToolActivityContext, useToolActivity } from './tool-activity.js'
export type { ToolActivityRegistry } from './tool-activity.js'

// ---- 无障碍底座组件（Radix 封装） ----
export { Switch } from './ui/Switch.js'
export type { SwitchProps } from './ui/Switch.js'
export { Checkbox } from './ui/Checkbox.js'
export type { CheckboxProps } from './ui/Checkbox.js'
export { Select, SelectPortal } from './ui/Select.js'
export type { SelectProps, SelectOption, SelectChangeEvent, MultiSelectChangeEvent, BaseSelectProps, SingleSelectProps, MultiSelectProps } from './ui/Select.js'
export { MultiSelect } from './ui/Select.js'
export { findNextSelectableIndex } from './ui/select-model.js'
export { Tabs, TabsList, TabsTrigger, TabsContent, SegmentedControl } from './ui/Tabs.js'
export type { TabsProps, TabsListProps, TabsTriggerProps, TabsContentProps, TabsVariant, TabsSize, SegmentedControlItem, SegmentedControlProps } from './ui/Tabs.js'
export { Dialog, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose, DialogTrigger } from './ui/Dialog.js'
export type { DialogProps, DialogPortalProps, DialogOverlayProps, DialogContentProps, DialogTitleProps, DialogDescriptionProps, DialogCloseProps, DialogTriggerProps } from './ui/Dialog.js'
export { Popover, PopoverPortal, PopoverRoot, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent, PopoverArrow } from './ui/Popover.js'
export { OverlayLayerContext, useOverlayChildStyle, useOverlayLayer } from './ui/overlay-stack.js'
export type { OverlayLayer } from './ui/overlay-stack.js'
export { ViewBoundary } from './ui/ViewBoundary.js'

// ---- 轻量布局原语与提示 ----
export { Screen, ScreenSection, DataTable, KvGrid } from './primitives.js'
export type { ScreenProps, ScreenSectionProps, DataTableProps, KvGridProps } from './primitives.js'
export { Callout } from './callout.js'
export type { CalloutProps } from './callout.js'

// ---- 内容展示 ----
export { MarkdownText } from './markdown.js'
export { MarkdownView, CodeBlockView } from './markdown-host.js'
export type { MarkdownViewProps, CodeBlockViewProps } from './markdown-host.js'
export { CopyButton } from './copy-button.js'
export { parseArtifactUrl, markdownUrlTransform } from './artifact-url.js'
export { copyToClipboard } from './clipboard.js'

// ---- 插件间子插槽 ----
export { PluginSlot } from './plugin-slot.js'
export type { PluginSlotProps } from './plugin-slot.js'

// ---- 图标与格式化纯函数 ----
export { HelmIcon } from './icons.js'
export type { HelmIconProps } from './icons.js'
export { formatTime, formatCompactTimestamp, formatDurationMs, formatBytes } from './format.js'
