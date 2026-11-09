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
  assert.equal(config.themeVariables?.mainBkg, '#1c1f24')
  assert.equal(config.themeVariables?.nodeBorder, '#343843')
  assert.equal(config.themeVariables?.textColor, '#ededec')
  assert.equal(config.themeVariables?.edgeLabelBackground, '#16181c')

  // Sequence 专属 themeVariables 断言
  assert.equal(config.themeVariables?.actorBkg, '#1c1f24')
  assert.equal(config.themeVariables?.actorBorder, '#343843')
  assert.equal(config.themeVariables?.actorTextColor, '#ededec')
  assert.equal(config.themeVariables?.signalColor, '#92959c')
  assert.equal(config.themeVariables?.signalTextColor, '#ededec')
  assert.equal(config.themeVariables?.labelBoxBkgColor, '#1c1f24')
  assert.equal(config.themeVariables?.labelBoxBorderColor, '#343843')
  assert.equal(config.themeVariables?.labelTextColor, '#ededec')
  assert.equal(config.themeVariables?.loopTextColor, '#ededec')
  assert.equal(config.themeVariables?.noteBorderColor, '#343843')
  assert.equal(config.themeVariables?.noteBkgColor, '#16181c')
  assert.equal(config.themeVariables?.noteTextColor, '#ededec')

  // Sequence 与 Flowchart 配置结构断言
  assert.equal(config.sequence?.actorFontSize, 14)
  assert.equal(config.sequence?.noteFontSize, 13)
  assert.equal(config.sequence?.messageFontSize, 13)
  assert.equal(config.flowchart?.htmlLabels, true)
  assert.equal(config.flowchart?.wrappingWidth, 260)
  assert.equal(config.flowchart?.useMaxWidth, true)
  assert.equal(config.flowchart?.curve, 'basis')
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

test('MarkdownView 源码契约：MermaidBlock 依赖 theme 并使用 getMermaidConfig，主题切换平滑无闪烁', { timeout: 60_000 }, async () => {
  const fs = await import('node:fs')
  const content = fs.readFileSync(new URL('../src/conversation/MarkdownView.tsx', import.meta.url), 'utf8')
  assert.match(content, /import\s*\{[^}]*getMermaidConfig[^}]*\}\s*from\s*['"]\.\/mermaid-theme(?:\.js)?['"]/)
  assert.match(content, /useHelmStore\(\)/)
  assert.match(content, /getMermaidConfig\(theme\)/)
  assert.match(content, /helm-mermaid-\$\{theme\}-\$\{seq\}-/)
  assert.match(content, /\[code,\s*theme\]/)

  // 主题切换防闪烁断言：仅在 code 变化时清空 svg 并应用 250ms 防抖；纯主题变更不重置 svg 且 0ms 即时渲染
  assert.match(content, /const\s+lastCodeRef\s*=\s*useRef<string\s*\|\s*null>\(null\)/)
  assert.match(content, /const\s+isCodeChanged\s*=\s*lastCodeRef\.current\s*!==\s*code/)
  assert.match(content, /if\s*\(isCodeChanged\)\s*\{[\s\n]*setSvg\(null\)/)
  assert.match(content, /const\s+delay\s*=\s*isCodeChanged\s*\?\s*250\s*:\s*0/)

  // 渲染稳定性断言：components 仅依赖稳定的 setActiveModal 与 conversationId，不依赖整个 store（弹窗开合不重挂载 Mermaid）
  assert.match(content, /const\s+\{\s*setActiveModal\s*\}\s*=\s*useHelmStore\(\)/)
  assert.match(content, /\[conversationId,\s*setActiveModal\]/)
  assert.match(content, /mermaidSvgCache/)
})

test('MermaidPreviewModal 源码契约：全屏画板支持主题重绘、透明图层与 var(--bg) 画布底色', { timeout: 60_000 }, async () => {
  const fs = await import('node:fs')
  const content = fs.readFileSync(new URL('../src/conversation/MermaidPreviewModal.tsx', import.meta.url), 'utf8')
  assert.match(content, /import\s*\{[^}]*getMermaidConfig[^}]*\}\s*from\s*['"]\.\/mermaid-theme(?:\.js)?['"]/)
  assert.match(content, /getMermaidConfig\(theme\)/)

  // 保证画板画布底色为 var(--bg)，与暗黑模式图表节点背景 #1c1f24 形成明晰对比（非 var(--bg-subtle)）
  assert.match(content, /className="mermaid-modal-stage"[\s\S]*?background:\s*['"]var\(--bg\)['"]/)
  assert.doesNotMatch(content, /className="mermaid-modal-stage"[\s\S]*?background:\s*['"]var\(--bg-subtle\)['"]/)

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



