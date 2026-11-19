/**
 * Display copy for the builtin:mermaid client (pure copy table, no component
 * exports — Fast Refresh friendly).
 *
 * Inline-block chrome and the fullscreen preview modal resolve every
 * human-visible string here against the active host locale; diagram source
 * and renderer diagnostics pass through unchanged.
 */
import type { HelmxLocale, LocalizedText } from '@helmx/plugin-client'
import { resolveLocalizedText } from '@helmx/plugin-client'

/** Inline code-block header. */
export const MERMAID_ZOOM_IN: LocalizedText = { en: 'Zoom in', 'zh-CN': '放大预览' }
export const MERMAID_COPY_SOURCE: LocalizedText = { en: 'Copy source', 'zh-CN': '复制源码' }
export const MERMAID_RENDER_FAILED: LocalizedText = { en: 'Mermaid render failed', 'zh-CN': 'Mermaid 渲染失败' }
export const MERMAID_RENDERING: LocalizedText = { en: 'Rendering Mermaid diagram...', 'zh-CN': '正在渲染 Mermaid 图表...' }
export const MERMAID_RETRY: LocalizedText = { en: 'Retry', 'zh-CN': '重试' }

/** Preview modal chrome. */
export const MERMAID_PREVIEW_TITLE: LocalizedText = { en: 'Mermaid preview', 'zh-CN': 'Mermaid 图预览' }
export const MERMAID_ZOOM_IN_TITLE: LocalizedText = { en: 'Zoom in (+)', 'zh-CN': '放大 (+)' }
export const MERMAID_ZOOM_OUT_TITLE: LocalizedText = { en: 'Zoom out (-)', 'zh-CN': '缩小 (-)' }
export const MERMAID_FIT_SCREEN_TITLE: LocalizedText = {
  en: 'Fit whole diagram on screen (0)',
  'zh-CN': '适应屏幕全貌 (0)',
}
export const MERMAID_FIT_SCREEN: LocalizedText = { en: 'Fit', 'zh-CN': '适屏' }
export const MERMAID_FIT_WIDTH_TITLE: LocalizedText = { en: 'Fit viewport width (W)', 'zh-CN': '适应视口宽度 (W)' }
export const MERMAID_FIT_WIDTH: LocalizedText = { en: 'Fit width', 'zh-CN': '适宽' }
export const MERMAID_ACTUAL_TITLE: LocalizedText = { en: 'Actual size 100% (1)', 'zh-CN': '实际大小 100% (1)' }
export const MERMAID_VIEW_SOURCE: LocalizedText = { en: 'View source', 'zh-CN': '查看源码' }
export const MERMAID_VIEW_DIAGRAM: LocalizedText = { en: 'View diagram', 'zh-CN': '查看图形' }
export const MERMAID_CLOSE_TITLE: LocalizedText = { en: 'Close (Esc)', 'zh-CN': '关闭 (Esc)' }
export const MERMAID_CLOSE: LocalizedText = { en: 'Close', 'zh-CN': '关闭' }

/** In-canvas status while the modal renders on its own (error passthrough). */
export function mermaidModalStatus(error: string | null, locale: HelmxLocale): string {
  if (error !== null) {
    return resolveLocalizedText({ en: `Render failed: ${error}`, 'zh-CN': `渲染失败：${error}` }, locale)
  }
  return resolveLocalizedText({ en: 'Rendering…', 'zh-CN': '正在渲染…' }, locale)
}
