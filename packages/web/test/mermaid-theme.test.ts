import test from 'node:test'
import assert from 'node:assert/strict'
import { getMermaidConfig } from '../src/conversation/mermaid-theme.js'

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

test('MarkdownView 源码契约：MermaidBlock 依赖 theme 并使用 getMermaidConfig', { timeout: 60_000 }, async () => {
  const fs = await import('node:fs')
  const content = fs.readFileSync(new URL('../src/conversation/MarkdownView.tsx', import.meta.url), 'utf8')
  assert.match(content, /import\s*\{[^}]*getMermaidConfig[^}]*\}\s*from\s*['"]\.\/mermaid-theme(?:\.js)?['"]/)
  assert.match(content, /useHelmStore\(\)/)
  assert.match(content, /getMermaidConfig\(theme\)/)
  assert.match(content, /helm-mermaid-\$\{theme\}-\$\{seq\}-/)
  assert.match(content, /\[code,\s*theme\]/)
})

