import test from 'node:test'
import assert from 'node:assert/strict'
import { getMermaidConfig, MERMAID_FONT_FAMILY } from '../../plugins/src/mermaid/client/mermaid-theme.js'

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
