/**
 * Public SDK entry of @helm/plugin-client.
 *
 * Two consumers share the same module instance (never a second React bundle):
 * 1. the host (@helm/web): imports this package for shared primitives /
 *    context / hooks, and mounts __helm_shared_plugin_client = this module
 *    namespace inside HelmStoreProvider;
 * 2. plugin build artifacts: source code uses
 *    `import { ... } from '@helm/plugin-client'`; the compiler virtualizes
 *    that specifier into globalThis.__helm_shared_plugin_client.
 *
 * The single source of truth of plugin-facing runtime symbols is
 * PLUGIN_CLIENT_SHARED_EXPORTS in @helm/protocol (bi-directionally locked by
 * services.test / this package's tests); host-facing symbols (host port,
 * context factory, explicitly-addressing hooks) are consumed only by the host
 * and tests, and are not part of the plugin contract list.
 */

// ---- Host port (injection surface) ----
export { PluginClientHostContext, usePluginClientHost } from './host-port.js'
export type {
  PluginClientHostPort,
  PluginSessionDocKey,
  PluginSessionDocState,
  PluginSlotPortItem,
} from './host-port.js'

// ---- Plugin context (usePluginContext) and factory ----
export { PluginClientContext, createPluginClientContext, usePluginContext } from './plugin-context.js'

// ---- i18n: locale & translation (plugin-consumable hooks + locale essentials) ----
export { usePluginLocale, usePluginTranslator } from './i18n.js'
export {
  HELM_LOCALES,
  DEFAULT_HELM_LOCALE,
  isHelmLocale,
  normalizeLocaleTag,
  parseLocalizedText,
  resolveLocalizedText,
  createLocaleTranslator,
} from './i18n.js'
export type { HelmLocale, LocalizedText, ExecutionText, LocaleTranslator } from './i18n.js'

// ---- hooks: doc subscriptions / conversations / plugin list / tool activity ----
export { usePluginDoc, usePluginDocValue, usePluginSessionDoc, usePluginSessionDocState, usePluginSessionDocValue } from './docs.js'
export type { ConversationHookOptions, ConversationHookResult } from './conversation-hooks.js'
export { useConversation, useConversations, usePluginConfig, usePlugins, useSharedNowMs } from './conversation-hooks.js'
export { ToolActivityContext, useToolActivity } from './tool-activity.js'
export type { ToolActivityRegistry } from './tool-activity.js'

// ---- Accessibility base components (Radix wrappers) ----
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

// ---- Lightweight layout primitives and hints ----
export { Screen, ScreenSection, DataTable, KvGrid } from './primitives.js'
export type { ScreenProps, ScreenSectionProps, DataTableProps, KvGridProps } from './primitives.js'
export { Callout } from './callout.js'
export type { CalloutProps } from './callout.js'

// ---- Content display ----
export { MarkdownText } from './markdown.js'
export { MarkdownView, CodeBlockView } from './markdown-host.js'
export type { MarkdownViewProps, CodeBlockViewProps } from './markdown-host.js'
export { CopyButton } from './copy-button.js'
export { parseArtifactUrl, markdownUrlTransform } from './artifact-url.js'
export { copyToClipboard } from './clipboard.js'

// ---- Inter-plugin sub-slots ----
export { PluginSlot } from './plugin-slot.js'
export type { PluginSlotProps } from './plugin-slot.js'

// ---- Icons and formatting pure functions ----
export { HelmIcon } from './icons.js'
export type { HelmIconName, HelmIconProps } from './icons.js'
export { formatTime, formatCompactTimestamp, formatDurationMs, formatBytes } from './format.js'
