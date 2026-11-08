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
    /target\.closest\(['"]\.sidebar-footer button['"]\)/,
    'App.tsx 点击底栏工具按钮时关闭移动侧栏抽屉',
  )

  assert.match(
    appSource,
    /<Sidebar\s+onClose=\{\(\)\s*=>\s*setSidebarOpen\(false\)\}\s*\/>/,
    'App.tsx 必须向 Sidebar 注入 onClose 关闭回调',
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
    /\.mobile-nav-toggle\s*\{[^}]*top:\s*max\(9px,\s*env\(safe-area-inset-top\)\)/,
    '.mobile-nav-toggle 必须支持 top safe-area-inset-top',
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
  assert.match(
    responsiveCss,
    /\.sidebar-footer\s+\.btn\s*\{[^}]*min-width:\s*32px;[^}]*min-height:\s*32px;/,
    '侧边栏底栏工具项触控热区至少 32x32px',
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
