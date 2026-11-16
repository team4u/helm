/**
 * Shared Web UI component copy (split controls, dialogs, generic UI slots)
 * plus lib-level display fallbacks. Owner: the lib-ui partition.
 *
 * Note: SDK component defaults (CopyButton / Select / DataTable / ViewBoundary)
 * are localized inside `@helm/plugin-client` via the host locale port — never
 * duplicate those default strings here; only web-owned overrides belong.
 */
import type { MessageTable } from '../messages.js'

export const uiMessages = {
  // Reference migration (SplitControls), kept as the canonical wiring example.
  'ui.split.closeView': { en: 'Close split view', 'zh-CN': '关闭分屏' },
  'ui.split.closeThisView': { en: 'Close this split view', 'zh-CN': '关闭本分屏' },
  'ui.split.sideBySide': { en: 'Side-by-side split', 'zh-CN': '并排分屏' },
  'ui.split.toggleTitle': { en: 'Open / close the split view on the right', 'zh-CN': '在右屏并排打开 / 关闭分屏' },
} satisfies MessageTable
