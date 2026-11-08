import type { MermaidConfig } from 'mermaid'

export function getMermaidConfig(theme: 'light' | 'dark'): MermaidConfig {
  const isDark = theme === 'dark'
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    fontFamily: 'var(--font-sans)',
    theme: isDark ? 'dark' : 'neutral',
    themeVariables: isDark
      ? {
          darkMode: true,
          background: 'transparent',
          fontFamily: 'var(--font-sans)',
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
          fontFamily: 'var(--font-sans)',
        },
  }
}
