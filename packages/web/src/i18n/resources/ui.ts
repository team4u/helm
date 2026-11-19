/**
 * Shared Web UI component copy (split controls, dialogs, generic UI slots)
 * plus lib-level display fallbacks. Owner: the lib-ui partition.
 *
 * Note: SDK component defaults (CopyButton / Select / DataTable / ViewBoundary)
 * are localized inside `@helmx/plugin-client` via the host locale port — never
 * duplicate those default strings here; only web-owned overrides belong.
 */
import type { MessageTable } from '../messages.js'

export const uiMessages = {
  // Reference migration (SplitControls), kept as the canonical wiring example.
  'ui.split.closeView': { en: 'Close split view', 'zh-CN': '关闭分屏' },
  'ui.split.closeThisView': { en: 'Close this split view', 'zh-CN': '关闭本分屏' },
  'ui.split.sideBySide': { en: 'Side-by-side split', 'zh-CN': '并排分屏' },
  'ui.split.toggleTitle': { en: 'Open / close the split view on the right', 'zh-CN': '在右屏并排打开 / 关闭分屏' },

  // ConfirmDialog defaults (explicit props win; `common.cancel` is reused verbatim).
  'ui.dialog.confirm': { en: 'Confirm', 'zh-CN': '确定' },

  // PluginUiView load/render states (thrown loader errors stay English execution copy).
  'ui.pluginUi.loading': { en: 'Loading plugin component {pluginId}...', 'zh-CN': '正在加载插件组件 {pluginId}...' },
  'ui.pluginUi.loadFailedTitle': { en: 'Failed to load plugin component ({pluginId})', 'zh-CN': '插件组件加载失败（{pluginId}）' },
  'ui.pluginUi.retry': { en: 'Retry loading', 'zh-CN': '重试加载' },
  'ui.pluginUi.boundaryLabel': { en: 'Plugin component', 'zh-CN': '插件组件' },
  'ui.pluginUi.missingClient': {
    en: 'This extension point of plugin {pluginId} declares no client component reference.',
    'zh-CN': '插件 {pluginId} 的该扩展点未声明 client 组件引用。',
  },

  // Thinking level segmented control.
  'ui.thinking.levelLabel': { en: 'Thinking level', 'zh-CN': '思考档位' },
} satisfies MessageTable
