import type { MermaidConfig } from 'mermaid'

/**
 * Mermaid 测量引擎在 Canvas 2D 环境计算文本包围盒。
 * 必须提供具体字体栈（不能使用 CSS 变量 var(--font-sans)），否则 Canvas 无法解析
 * 会静默退化为 10px sans-serif，导致节点尺寸计算过小并在渲染时截断文字。
 */
export const MERMAID_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'

export function getMermaidConfig(theme: 'light' | 'dark'): MermaidConfig {
  const isDark = theme === 'dark'
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    fontFamily: MERMAID_FONT_FAMILY,
    fontSize: 14,
    flowchart: {
      htmlLabels: true,
      wrappingWidth: 260,
      useMaxWidth: true,
      curve: 'basis',
    },
    sequence: {
      actorFontSize: 14,
      noteFontSize: 13,
      messageFontSize: 13,
    },
    theme: isDark ? 'dark' : 'neutral',
    themeVariables: isDark
      ? {
          darkMode: true,
          background: 'transparent',
          fontFamily: MERMAID_FONT_FAMILY,
          fontSize: '14px',
          mainBkg: '#1c1f24',
          nodeBorder: '#343843',
          primaryColor: '#1c1f24',
          primaryBorderColor: '#343843',
          primaryTextColor: '#ededec',
          lineColor: '#92959c',
          textColor: '#ededec',
          edgeLabelBackground: '#16181c',
          actorBkg: '#1c1f24',
          actorBorder: '#343843',
          actorTextColor: '#ededec',
          signalColor: '#92959c',
          signalTextColor: '#ededec',
          labelBoxBkgColor: '#1c1f24',
          labelBoxBorderColor: '#343843',
          labelTextColor: '#ededec',
          loopTextColor: '#ededec',
          noteBorderColor: '#343843',
          noteBkgColor: '#16181c',
          noteTextColor: '#ededec',
        }
      : {
          darkMode: false,
          background: 'transparent',
          fontFamily: MERMAID_FONT_FAMILY,
          fontSize: '14px',
        },
  }
}

