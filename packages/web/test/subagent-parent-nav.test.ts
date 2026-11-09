import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { makeTestStore, TestStoreProvider } from './helpers/store.js'
import { importWorkflowClientModule, mountSharedPluginNamespaces } from './helpers/workflow-client.js'

const iconsSource = readFileSync(new URL('../src/lib/icons.tsx', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')
const workbenchSource = readFileSync(new URL('../src/conversation/WorkbenchDrawer.tsx', import.meta.url), 'utf8')
mountSharedPluginNamespaces({ realHooks: true })
const stylesCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')

test('icons.tsx 支持 arrow-left 与 chevron-left 矢量图标', { timeout: 60_000 }, () => {
  assert.match(iconsSource, /ArrowLeft/)
  assert.match(iconsSource, /'arrow-left':\s*ArrowLeft/)
  assert.match(iconsSource, /ChevronLeft/)
  assert.match(iconsSource, /'chevron-left':\s*ChevronLeft/)
})

test('ConversationPane.tsx 在存在 parentConversationId 时渲染父级回退胶囊按钮', { timeout: 60_000 }, () => {
  // 必须在 .pane-title-group 内部且在标题前条件渲染
  assert.match(
    paneSource,
    /<div\s+className=["']pane-title-group["']>[\s\S]*?conversation\.parentConversationId\s*!==\s*undefined[\s\S]*?pane-parent-nav-btn[\s\S]*?\{renaming\s*\?/,
    '必须在 pane-title-group 内部标题前渲染父级返回按钮',
  )

  // 按钮类名与无障碍属性
  assert.match(
    paneSource,
    /className=["'][^"']*pane-parent-nav-btn[^"']*["']/,
    '返回按钮必须携带 pane-parent-nav-btn 类名',
  )
  assert.match(
    paneSource,
    /title=\{`返回父会话\s*#\$\{conversation\.parentConversationId\}`\}/,
    '返回按钮必须具备清晰的 title 属性',
  )
  assert.match(
    paneSource,
    /aria-label=\{`返回父会话\s*#\$\{conversation\.parentConversationId\}`\}/,
    '返回按钮必须具备无障碍 aria-label 属性',
  )

  // 图标与标识文案
  assert.match(
    paneSource,
    /<HelmIcon\s+name=["']arrow-left["']\s+size=\{12\}\s*\/>/,
    '必须使用 arrow-left 12px 图标',
  )
  assert.match(
    paneSource,
    /<span\s+className=["']pane-parent-nav-label["']>#\{conversation\.parentConversationId\}<\/span>/,
    '必须渲染带有 # 前缀的父会话 ID 胶囊标签',
  )

  // 导航逻辑契约：调用 store.openTarget 导航至父会话
  assert.match(
    paneSource,
    /store\.openTarget\(\s*\{\s*kind:\s*['"]conversation['"],\s*conversationId:\s*conversation\.parentConversationId!?\s*\}/,
    '点击必须通过 store.openTarget 导航至父会话',
  )
})

test('宿主工作台仅挂载通用面板；真实编译子代理卡统一由抽屉承载且无并排按钮', { timeout: 60_000 }, async () => {
  assert.match(workbenchSource, /<PluginUiView/)
  assert.doesNotMatch(workbenchSource, /SubagentLiveCard|workflowRuns/)
  const mod = await importWorkflowClientModule()
  const Card = mod.SubagentLiveCard as React.ComponentType<Record<string, unknown>>
  const html = renderToString(React.createElement(TestStoreProvider, { value: makeTestStore() },
    React.createElement(Card, { childConversationId: 11, toolStatus: 'done' })))
  assert.match(html, /subagent-card-clickable/)
  assert.match(html, /打开子会话 #11 抽屉/)
  assert.doesNotMatch(html, /并排查看|subagent-split-btn|workbench-split-btn/)
})

test('响应式样式不保留已删除的工作台/子代理并排按钮选择器', { timeout: 60_000 }, () => {
  assert.doesNotMatch(responsiveCss, /\.workbench-split-btn|\.subagent-split-btn/)
})

test('styles.css 与 responsive.css 规范父会话胶囊按钮排版与窄屏微调', { timeout: 60_000 }, () => {
  // 胶囊结构与 hover 反馈
  assert.match(
    stylesCss,
    /\.pane-parent-nav-btn\s*\{[^}]*border-radius:\s*999px;/,
    'pane-parent-nav-btn 必须采用 999px 胶囊圆角',
  )
  assert.match(
    stylesCss,
    /\.pane-parent-nav-btn\s*\{[^}]*flex-shrink:\s*0;/,
    'pane-parent-nav-btn 必须防挤压 flex-shrink: 0',
  )
  assert.match(
    stylesCss,
    /\.pane-parent-nav-label\s*\{[^}]*font-family:\s*var\(--font-mono/,
    'pane-parent-nav-label 必须采用等宽字体排版 ID',
  )

  // 极窄容器查询微调
  const container450 = responsiveCss.slice(responsiveCss.indexOf('@container (max-width: 450px)'))
  assert.match(
    container450,
    /\.pane-parent-nav-btn/,
    '@container (max-width: 450px) 下对胶囊按钮尺寸与间距进行微调',
  )
})
