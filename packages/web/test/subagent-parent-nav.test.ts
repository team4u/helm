import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const iconsSource = readFileSync(new URL('../src/lib/icons.tsx', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')
const workbenchSource = readFileSync(new URL('../src/conversation/WorkbenchDrawer.tsx', import.meta.url), 'utf8')
const liveCardSource = readFileSync(new URL('../src/conversation/SubagentLiveCard.tsx', import.meta.url), 'utf8')
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

test('WorkbenchDrawer.tsx 与 SubagentLiveCard.tsx 移除并排按钮，统一由抽屉模态承载', { timeout: 60_000 }, () => {
  // WorkbenchDrawer 复用 SubagentLiveCard 渲染独立子会话（不再自建文字行）
  assert.match(
    workbenchSource,
    /<SubagentLiveCard/,
    'WorkbenchDrawer 独立子会话必须复用 SubagentLiveCard 渲染',
  )
  assert.doesNotMatch(
    workbenchSource,
    /className=["'][^"']*workbench-split-btn[^"']*["']/,
    'WorkbenchDrawer 不得再自建携带 workbench-split-btn 的并排按钮（统一复用 SubagentLiveCard）',
  )

  // SubagentLiveCard 移除并排查看，统一由抽屉承载
  assert.doesNotMatch(
    liveCardSource,
    /并排查看/,
    'SubagentLiveCard 不得再渲染并排查看按钮',
  )
})

test('responsive.css 在 860px 窄屏媒体查询中收敛工作台与时间线卡片的并排按钮', { timeout: 60_000 }, () => {
  const media860 = responsiveCss.slice(responsiveCss.indexOf('@media (max-width: 860px)'))

  assert.match(
    media860,
    /\.workbench-split-btn/,
    '@media (max-width: 860px) 必须包含 .workbench-split-btn 选择器',
  )
  assert.match(
    media860,
    /\.subagent-split-btn/,
    '@media (max-width: 860px) 必须包含 .subagent-split-btn 选择器',
  )
  assert.match(
    media860,
    /\.workbench-split-btn[\s\S]*?display:\s*none\s*!important/,
    '窄屏下必须隐藏 .workbench-split-btn',
  )
  assert.match(
    media860,
    /\.subagent-split-btn[\s\S]*?display:\s*none\s*!important/,
    '窄屏下必须隐藏 .subagent-split-btn',
  )
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
