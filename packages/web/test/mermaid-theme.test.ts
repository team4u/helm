import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync as readFile } from 'node:fs'
import { readHostStyles } from './helpers/host-styles.js'
import { getMermaidConfig, MERMAID_FONT_FAMILY } from '../../kernel/src/builtin-plugins/mermaid/client/mermaid-theme.js'

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

test('MermaidCodeBlock 源码契约：代际守卫与缓存路径（防旧代异步覆盖）', { timeout: 60_000 }, () => {
  const content = readFile(new URL('../../kernel/src/builtin-plugins/mermaid/client/index.tsx', import.meta.url), 'utf8')
  // 缓存命中分支也推进代际（seq 自增），迟到异步结果按代际丢弃
  assert.match(content, /const seq = \+\+seqRef\.current/)
  assert.match(content, /aliveRef\.current && seqRef\.current === seq/)
  // 缓存容量上限与 LRU 淘汰
  assert.match(content, /MERMAID_CACHE_LIMIT/)
  // 错误态保留可复制源码
  assert.match(content, /Mermaid 渲染失败/)
})

test('Mermaid 插件样式契约：图表专属样式在插件 CSS（不进宿主核心）', { timeout: 60_000 }, () => {
  const pluginCss = readFile(new URL('../../kernel/src/builtin-plugins/mermaid/client/styles.css', import.meta.url), 'utf8')
  assert.match(pluginCss, /\.mermaid-body\s*\{[\s\S]*?background:\s*transparent/)
  assert.match(pluginCss, /\.mermaid-svg-layer\s*\{[\s\S]*?background:\s*transparent/)
  assert.match(pluginCss, /\.mermaid-body\s+foreignObject[^}]*overflow:\s*visible\s*!important/)
  assert.match(pluginCss, /\.mermaid-svg-layer\s+foreignObject[^}]*overflow:\s*visible\s*!important/)
  assert.match(pluginCss, /foreignObject\s*>\s*div[^}]*width:\s*100%\s*!important/)
  assert.match(pluginCss, /foreignObject\s*>\s*div[^}]*max-width:\s*100%\s*!important/)
})

test('宿主核心零 jr- 残留：styles.css 与 web src 不再定义/使用 json DSL 类', { timeout: 60_000 }, () => {
  const styles = readHostStyles()
  assert.ok(!styles.includes('.jr-'), '宿主 styles.css 不得含 jr-* 定义')
  // 通用 callout 原语在核心定义（与插件样式无关）
  assert.match(styles, /\.callout\s*\{/)
  assert.match(styles, /\.callout--error\s*\{/)
  assert.match(styles, /\.callout--warning\s*\{/)
  assert.match(styles, /\.callout--success\s*\{/)
})
