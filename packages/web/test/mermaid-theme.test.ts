import test from 'node:test'
import assert from 'node:assert/strict'
import { getMermaidConfig, MERMAID_FONT_FAMILY } from '../src/conversation/mermaid-theme.js'

test('getMermaidConfig: 浅色模式返回 neutral 主题与透明背景', { timeout: 60_000 }, () => {
  const config = getMermaidConfig('light')
  assert.equal(config.theme, 'neutral')
  assert.equal(config.startOnLoad, false)
  assert.equal(config.suppressErrorRendering, true)
  assert.equal(config.themeVariables?.background, 'transparent')
  assert.equal(config.themeVariables?.darkMode, false)
})

test('getMermaidConfig: 暗黑模式返回 dark 主题并精确映射 Helm 调色板', { timeout: 60_000 }, () => {
  const config = getMermaidConfig('dark')
  assert.equal(config.theme, 'dark')
  assert.equal(config.startOnLoad, false)
  assert.equal(config.suppressErrorRendering, true)
  assert.equal(config.themeVariables?.darkMode, true)
  assert.equal(config.themeVariables?.background, 'transparent')
  assert.equal(config.themeVariables?.primaryColor, '#1c1f24')
  assert.equal(config.themeVariables?.primaryBorderColor, '#343843')
  assert.equal(config.themeVariables?.primaryTextColor, '#ededec')
  assert.equal(config.themeVariables?.lineColor, '#92959c')
})

test('getMermaidConfig: 字体栈使用系统真实字体，避免 Canvas 测量回退 10px 导致文字截断', { timeout: 60_000 }, () => {
  assert.ok(MERMAID_FONT_FAMILY.includes('sans-serif'))
  assert.ok(!MERMAID_FONT_FAMILY.includes('var('))

  const light = getMermaidConfig('light')
  assert.equal(light.fontFamily, MERMAID_FONT_FAMILY)
  assert.equal(light.fontSize, 14)
  assert.equal(light.flowchart?.htmlLabels, true)
  assert.equal(light.flowchart?.wrappingWidth, 260)
  assert.equal(light.themeVariables?.fontFamily, MERMAID_FONT_FAMILY)

  const dark = getMermaidConfig('dark')
  assert.equal(dark.fontFamily, MERMAID_FONT_FAMILY)
  assert.equal(dark.themeVariables?.fontFamily, MERMAID_FONT_FAMILY)
})

test('MarkdownView 源码契约：MermaidBlock 依赖 theme 并使用 getMermaidConfig', { timeout: 60_000 }, async () => {
  const fs = await import('node:fs')
  const content = fs.readFileSync(new URL('../src/conversation/MarkdownView.tsx', import.meta.url), 'utf8')
  assert.match(content, /import\s*\{[^}]*getMermaidConfig[^}]*\}\s*from\s*['"]\.\/mermaid-theme(?:\.js)?['"]/)
  assert.match(content, /useHelmStore\(\)/)
  assert.match(content, /getMermaidConfig\(theme\)/)
  assert.match(content, /helm-mermaid-\$\{theme\}-\$\{seq\}-/)
  assert.match(content, /\[code,\s*theme\]/)
})

test('MermaidPreviewModal 源码契约：全屏画板支持主题重绘与透明图层', { timeout: 60_000 }, async () => {
  const fs = await import('node:fs')
  const content = fs.readFileSync(new URL('../src/conversation/MermaidPreviewModal.tsx', import.meta.url), 'utf8')
  assert.match(content, /import\s*\{[^}]*getMermaidConfig[^}]*\}\s*from\s*['"]\.\/mermaid-theme(?:\.js)?['"]/)
  assert.match(content, /getMermaidConfig\(theme\)/)

  const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert.match(styles, /\.mermaid-body\s*\{[^}]*background:\s*transparent/)
  assert.match(styles, /\.mermaid-svg-layer\s*\{[^}]*background:\s*transparent/)
})

test('styles.css 样式契约：Mermaid SVG 与 foreignObject 防文字截断规则', { timeout: 60_000 }, async () => {
  const fs = await import('node:fs')
  const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert.match(styles, /\.mermaid-body\s+foreignObject[^}]*overflow:\s*visible\s*!important/)
  assert.match(styles, /\.mermaid-svg-layer\s+foreignObject[^}]*overflow:\s*visible\s*!important/)
  assert.match(styles, /foreignObject\s*>\s*div[^}]*width:\s*100%\s*!important/)
  assert.match(styles, /foreignObject\s*>\s*div[^}]*max-width:\s*100%\s*!important/)
})



