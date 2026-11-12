import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const authGateSource = readFileSync(new URL('../src/shell/AuthGate.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../src/shell/Sidebar.tsx', import.meta.url), 'utf8')
const workbenchSource = readFileSync(new URL('../src/conversation/WorkbenchDrawer.tsx', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')

test('index.html viewport 配置包含 viewport-fit=cover', { timeout: 60_000 }, () => {
  assert.match(
    indexHtml,
    /<meta\s+name=["']viewport["']\s+content=["'][^"']*viewport-fit=cover[^"']*["']\s*\/?>/i,
    'index.html 必须声明 viewport-fit=cover 以适配移动端全面屏安全区',
  )
})

test('满屏容器高度升级为 100dvh 支持移动端动态地址栏', { timeout: 60_000 }, () => {
  assert.match(
    appSource,
    /height:\s*['"]100dvh['"]/,
    'App.tsx 加载屏容器必须使用 100dvh',
  )
  assert.doesNotMatch(
    appSource,
    /height:\s*['"]100vh['"]/,
    'App.tsx 不得保留 100vh 满屏高度',
  )

  assert.match(
    authGateSource,
    /height:\s*['"]100dvh['"]/,
    'AuthGate.tsx 容器必须使用 100dvh',
  )
  assert.doesNotMatch(
    authGateSource,
    /height:\s*['"]100vh['"]/,
    'AuthGate.tsx 不得保留 100vh 满屏高度',
  )
})

test('App.tsx 在 Modal 激活或底栏工具触发时自动关闭移动端侧边栏', { timeout: 60_000 }, () => {
  assert.match(
    appSource,
    /useEffect\(\(\)\s*=>\s*\{[\s\S]*?store\.activeModal\s*!==\s*null[\s\S]*?setSidebarOpen\(false\)/,
    'App.tsx 必须在 activeModal 打开时自动关闭移动侧栏抽屉',
  )

  assert.match(
    appSource,
    /target\.closest\(['"]\.nav-item['"]\)/,
    'App.tsx 点击导航项时关闭移动侧栏抽屉',
  )

  assert.doesNotMatch(
    appSource,
    /target\.closest\(['"]\.sidebar-header button['"]\)/,
    'App.tsx 绝不得盲目拦截 .sidebar-header button，否则会误关新建对话下拉菜单',
  )

  assert.match(
    appSource,
    /<Sidebar\s+onClose=\{\(\)\s*=>\s*setSidebarOpen\(false\)\}\s*\/>/,
    'App.tsx 必须向 Sidebar 注入 onClose 关闭回调',
  )
})

test('Sidebar.tsx 智能体站位结构取代旧新建下拉：站位新建入口与移动端安全关闭', { timeout: 60_000 }, () => {
  // 旧 NewConversationControl（+▾ 选 Profile 下拉）与「我的对话」大杂烩分组已移除。
  assert.doesNotMatch(
    sidebarSource,
    /NewConversationControl|new-conversation-dropdown/,
    '不得保留旧的新建对话下拉控制',
  )
  assert.doesNotMatch(sidebarSource, /MyConversationsGroup|我的对话/)
  // 新：Agent 站位 + 新建对话按钮（agent-new-conv-btn）。
  assert.match(
    sidebarSource,
    /<AgentStandingsGroup\s+store=\{store\}\s+onNavigate=\{onClose\}\s*\/>/,
    'Sidebar 必须将 onClose 传递给 AgentStandingsGroup 作为导航后关闭回调',
  )
  assert.match(
    sidebarSource,
    /className=["'][^"']*agent-new-conv-btn[^"']*["']/,
    'Agent 站位新建对话按钮必须具备专用标识类名',
  )
  assert.match(
    sidebarSource,
    /agent-conversations-list/,
    'Agent 名下二级历史会话子列表必须具备 agent-conversations-list 类名',
  )
})

test('Sidebar.tsx 点击 Agent 站位主区域在移动端导航后关闭抽屉', { timeout: 60_000 }, () => {
  assert.match(
    sidebarSource,
    /onNavigate\?\.\(\)/,
    'Agent 站位打开主会话后必须调用 onNavigate 关闭移动端抽屉',
  )
  assert.match(
    sidebarSource,
    /nav-item/,
    '侧栏导航项保留 nav-item 结构供 App.tsx 点击关闭抽屉',
  )
})

test('App.tsx 在 workbench 打开时渲染移动端遮罩层并支持点击关闭', { timeout: 60_000 }, () => {
  assert.match(
    appSource,
    /store\.workbenchOpen\s*&&\s*\([\s\S]*?<button[\s\S]*?className=["'][^"']*workbench-backdrop[^"']*["'][\s\S]*?onClick=\{\(\)\s*=>\s*store\.setWorkbenchOpen\(false\)\}/,
    'App.tsx 必须在 workbenchOpen 时渲染 workbench-backdrop 遮罩',
  )
})

test('Sidebar.tsx 在移动端头部渲染显式关闭按钮', { timeout: 60_000 }, () => {
  assert.match(
    sidebarSource,
    /className=["'][^"']*mobile-sidebar-close[^"']*["']/,
    'Sidebar.tsx 必须包含 mobile-sidebar-close 关闭按钮',
  )
  assert.match(
    sidebarSource,
    /aria-label=["']关闭导航栏["']/,
    '移动端关闭按钮必须具备明确的无障碍描述',
  )
  assert.match(
    sidebarSource,
    /<HelmIcon\s+name=["']x["']\s+size=\{14\}\s*\/>/,
    '移动端关闭按钮使用 x 图标',
  )
})

test('WorkbenchDrawer.tsx 在 tabs-bar 右侧渲染显式关闭按钮', { timeout: 60_000 }, () => {
  assert.match(
    workbenchSource,
    /<div\s+className=["']tabs-bar["']>[\s\S]*?<button[\s\S]*?aria-label=["']关闭工作台["'][\s\S]*?onClick=\{\(\)\s*=>\s*store\.setWorkbenchOpen\(false\)\}[\s\S]*?<HelmIcon\s+name=["']x["']\s+size=\{14\}\s*\/>[\s\S]*?<\/button>/,
    'WorkbenchDrawer 必须在 tabs-bar 增加关闭工作台按钮',
  )
})

test('responsive.css 适配移动端视口安全区、触控热区与遮罩层级', { timeout: 60_000 }, () => {
  // 安全区 inset
  assert.match(
    responsiveCss,
    /\.mobile-nav-toggle\s*\{[^}]*top:\s*calc\(max\(5px,\s*env\(safe-area-inset-top\)\)\)/,
    '.mobile-nav-toggle 须与 46px 会话顶栏垂直居中并叠加 safe-area-inset-top',
  )
  assert.match(
    responsiveCss,
    /\.mobile-nav-toggle\s*\{[^}]*left:\s*max\(8px,\s*env\(safe-area-inset-left\)\)/,
    '.mobile-nav-toggle 必须支持 left safe-area-inset-left',
  )
  assert.match(
    responsiveCss,
    /\.helm-sidebar\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\);[^}]*padding-bottom:\s*env\(safe-area-inset-bottom\);/,
    '.helm-sidebar 必须包含上下安全区内边距',
  )

  // 触控热区
  assert.match(
    responsiveCss,
    /\.mobile-nav-toggle\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/,
    '.mobile-nav-toggle 触控热区提升至 36x36px',
  )

  // 遮罩层级与样式
  assert.match(
    responsiveCss,
    /\.workbench-backdrop\s*\{[^}]*z-index:\s*59;[^}]*background:\s*var\(--bg-backdrop\);/,
    '.workbench-backdrop 必须设置 z-index: 59 与 var(--bg-backdrop)',
  )
  assert.match(
    responsiveCss,
    /\.sidebar-open\s+\.sidebar-backdrop\s*\{[^}]*z-index:\s*71;[^}]*background:\s*var\(--bg-backdrop\);/,
    '.sidebar-backdrop 必须在侧栏展开时覆盖且 z-index: 71',
  )
})

const conversationPaneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')

test('ConversationPane.tsx 分屏顶栏：isSplit 时渲染显式关闭按钮，激活态分屏按钮可关闭', { timeout: 60_000 }, () => {
  // 共用关闭组件也用于加载中、加载失败分支；实际渲染行为见 subagent-live-card.test.ts。
  assert.match(
    conversationPaneSource,
    /isSplit && onCloseSplit !== undefined \? \(\s*<CloseSplitButton onCloseSplit=\{onCloseSplit\} \/>/,
    'ConversationPane 必须在 isSplit 顶栏渲染共用关闭按钮',
  )
  // 主屏顶栏：分屏开启时按钮带 split-active 激活态类（窄屏保留可见可点）
  assert.match(
    conversationPaneSource,
    /className=\{`btn btn-sm split-toggle-btn\$\{store\.splitTarget !== null \? ' btn-primary split-active' : ''\}`\}/,
    '主屏 split-toggle-btn 在分屏开启时必须携带 split-active 激活态',
  )
})

test('responsive.css 窄屏仅隐藏未激活的开启分屏按钮，保留关闭入口', { timeout: 60_000 }, () => {
  assert.match(
    responsiveCss,
    /\.split-toggle-btn:not\(\.split-active\)\s*,\s*\n?\s*\.sidebar-split-action/,
    '860px 断点必须只隐藏 .split-toggle-btn:not(.split-active)（未开启分屏的入口）',
  )
  assert.doesNotMatch(
    responsiveCss,
    /\.split-close-btn\s*\{[^}]*display:\s*none/,
    '窄屏不得隐藏 .split-close-btn 关闭按钮',
  )
  assert.doesNotMatch(
    responsiveCss,
    /\.split-toggle-btn\.split-active\s*\{[^}]*display:\s*none/,
    '窄屏不得隐藏已激活的 .split-toggle-btn.split-active',
  )
})

test('工作台不因插件抽屉导航而自动收起，窄屏同样保留排查上下文', { timeout: 60_000 }, () => {
  assert.doesNotMatch(workbenchSource, /maybeCollapseWorkbench|onNavigate/)
  assert.match(workbenchSource, /<PluginUiView/)
  assert.match(workbenchSource, /onClick=\{\(\) => store\.setWorkbenchOpen\(false\)\}/, '仅显式关闭按钮收起工作台')
})
