import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { makeTestStore, TestStoreProvider } from './helpers/store.js'
import { importWorkflowClientModule, mountSharedPluginNamespaces } from './helpers/workflow-client.js'

const iconsSource = readFileSync(new URL('../src/lib/icons.tsx', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')
const ancestrySource = readFileSync(new URL('../src/conversation/ancestry-model.ts', import.meta.url), 'utf8')
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

test('ConversationPane.tsx 渲染任意深度祖先面包屑并复用 pane-parent-nav-btn 胶囊', { timeout: 60_000 }, () => {
  // 面包屑链由 ancestry-model 从 store.conversations 推导（无平行路由）
  assert.match(paneSource, /import \{ buildAncestorChain \} from '\.\/ancestry-model\.js'/)
  assert.match(paneSource, /buildAncestorChain\(store\.conversations, conversationId/)

  // 必须在 .pane-title-group 内部且在标题前条件渲染（ancestors.length > 0）
  assert.match(
    paneSource,
    /<div\s+className=["']pane-title-group["']>\s*\{ancestors\.length > 0 \?[\s\S]*?pane-breadcrumb[\s\S]*?\{renaming\s*\?/,
    '必须在 pane-title-group 内部标题前渲染祖先面包屑',
  )

  // 按钮类名与无障碍属性
  assert.match(
    paneSource,
    /className=["'][^"']*pane-parent-nav-btn[^"']*["']/,
    '祖先胶囊必须携带 pane-parent-nav-btn 类名',
  )
  assert.match(
    paneSource,
    /aria-label=\{`前往祖先会话 #\$\{ancestorId\}`\}/,
    '祖先胶囊必须具备无障碍 aria-label 属性',
  )

  // 图标与标识文案：首个胶囊带返回箭头，均渲染 # 前缀的等宽 ID
  assert.match(
    paneSource,
    /<HelmIcon\s+name=["']arrow-left["']\s+size=\{12\}\s*\/>/,
    '首个祖先胶囊必须使用 arrow-left 12px 图标',
  )
  assert.match(
    paneSource,
    /<span\s+className=["']pane-parent-nav-label["']>\{label\}<\/span>/,
    '必须渲染带有 # 前缀的祖先会话 ID 胶囊标签',
  )

  // 导航逻辑契约：抽屉内不顶掉主屏（在屏则收抽屉，否则抽屉原位切换）；
  // 主屏/分屏内仍通过 store.openTarget 导航
  assert.match(
    paneSource,
    /store\.setActiveModal\(\{ kind: 'conversation-drawer', conversationId: ancestorId \}\)/,
    '抽屉内点击非在屏祖先必须原位切换抽屉，不得改变主屏',
  )
  assert.match(
    paneSource,
    /store\.openTarget\(\s*\{\s*kind:\s*['"]conversation['"],\s*conversationId:\s*ancestorId\s*\}/,
    '主屏/分屏内点击必须通过 store.openTarget 导航至祖先会话',
  )

  // 祖谱纯函数契约：防环、防超深截断
  assert.match(ancestrySource, /MAX_ANCESTRY_DEPTH = 32/)
  assert.match(ancestrySource, /visited\.has\(parentId\)/)
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

test('styles.css 与 responsive.css 规范祖先面包屑胶囊排版与窄屏微调', { timeout: 60_000 }, () => {
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
  assert.match(
    stylesCss,
    /\.pane-breadcrumb\s*\{[^}]*overflow:\s*hidden;/,
    'pane-breadcrumb 必须允许深链溢出裁剪',
  )

  // 极窄容器查询微调：隐藏分隔符只留紧凑 ID 胶囊
  const container450 = responsiveCss.slice(responsiveCss.indexOf('@container (max-width: 450px)'))
  assert.match(
    container450,
    /\.pane-parent-nav-btn/,
    '@container (max-width: 450px) 下对胶囊按钮尺寸与间距进行微调',
  )
  assert.match(
    container450,
    /\.pane-breadcrumb-sep\s*\{[^}]*display:\s*none;/,
    '@container (max-width: 450px) 下隐藏面包屑分隔符',
  )
})
