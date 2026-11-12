import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const stylesCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')

test('CSS Token 契约：--bg-inset 变量在亮色与暗色模式均声明为 var(--bg-subtle)', { timeout: 60_000 }, () => {
  assert.match(
    stylesCss,
    /:root,\s*\n?:root\[data-theme='light'\]\s*\{[\s\S]*?--bg-inset:\s*var\(--bg-subtle\);/,
    '亮色模式必须声明 --bg-inset: var(--bg-subtle);',
  )
  assert.match(
    stylesCss,
    /:root\[data-theme='dark'\]\s*\{[\s\S]*?--bg-inset:\s*var\(--bg-subtle\);/,
    '暗色模式必须声明 --bg-inset: var(--bg-subtle);',
  )
})

test('基础按钮与尺寸阶梯：.btn 标称 32px，.btn-sm 为 28px，.btn-xs 为 22px', { timeout: 60_000 }, () => {
  assert.match(
    stylesCss,
    /\.btn\s*\{[^}]*height:\s*32px;/,
    '.btn 默认高度必须为 32px',
  )
  assert.match(
    stylesCss,
    /\.btn-sm\s*\{[^}]*height:\s*28px;/,
    '.btn-sm 高度必须为 28px',
  )
  assert.match(
    stylesCss,
    /\.btn-xs\s*\{[^}]*height:\s*22px;/,
    '.btn-xs 高度必须为 22px',
  )
})

test('纯图标按钮原语：.btn-icon(32px), .btn-icon-sm(28px), .btn-icon-xs(22px) 严格正方形且 padding: 0 !important', { timeout: 60_000 }, () => {
  assert.match(
    stylesCss,
    /\.btn-icon\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*padding:\s*0\s*!important;/,
    '.btn-icon 必须定义 32x32 正方形尺寸与 padding: 0 !important',
  )
  assert.match(
    stylesCss,
    /\.btn-icon-sm\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*padding:\s*0\s*!important;/,
    '.btn-icon-sm 必须定义 28x28 正方形尺寸与 padding: 0 !important',
  )
  assert.match(
    stylesCss,
    /\.btn-icon-xs\s*\{[^}]*width:\s*22px;[^}]*height:\s*22px;[^}]*padding:\s*0\s*!important;/,
    '.btn-icon-xs 必须定义 22x22 正方形尺寸与 padding: 0 !important',
  )
})

test('分段控制器原语：.segmented-control 与 .segmented-control-btn 规则与激活态存在', { timeout: 60_000 }, () => {
  assert.match(
    stylesCss,
    /\.segmented-control\s*\{/,
    '必须声明 .segmented-control 容器原语',
  )
  assert.match(
    stylesCss,
    /\.segmented-control-btn\s*\{/,
    '必须声明 .segmented-control-btn 原语',
  )
  assert.match(
    stylesCss,
    /\.segmented-control-btn(\.is-active|\[aria-pressed=['"]true['"]\])/,
    '必须包含 .segmented-control-btn 激活态样式',
  )
})

test('左右分栏模态弹窗：.modal-body-split 与 .asset-modal-body 水平伸缩，.modal-sidebar 与 .asset-modal-list 默认宽度 240px', { timeout: 60_000 }, () => {
  assert.match(
    stylesCss,
    /(\.modal-body-split|\.asset-modal-body)[^{]*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*row;/,
    '必须包含 .modal-body-split / .asset-modal-body 水平分栏布局规则',
  )
  assert.match(
    stylesCss,
    /(\.modal-sidebar|\.asset-modal-list)[^{]*\{[^}]*width:\s*240px;/,
    '必须声明 .modal-sidebar / .asset-modal-list 默认宽度 240px',
  )
  assert.match(
    responsiveCss,
    /(\.modal-body-split|\.asset-modal-body)[^{]*\{[^}]*flex-direction:\s*column\s*!important;/,
    'responsive.css 必须在窄屏下支持 .modal-body-split / .asset-modal-body 切换为垂直单列',
  )
  assert.match(
    responsiveCss,
    /(\.modal-sidebar|\.asset-modal-list)[^{]*\{[^}]*width:\s*100%\s*!important;/,
    'responsive.css 必须在窄屏下支持 .modal-sidebar / .asset-modal-list 展开为 100% 宽度',
  )
})

test('列表导航项原语：.list-item-btn 支持 hover、.is-active 与 [aria-pressed="true"]，选中背景使用 --nav-active-bg', { timeout: 60_000 }, () => {
  assert.match(
    stylesCss,
    /\.list-item-btn\s*\{/,
    '必须声明 .list-item-btn 列表项原语',
  )
  assert.match(
    stylesCss,
    /\.list-item-btn(\.is-active|\[aria-pressed=['"]true['"]\])[^{]*\{[^}]*background:\s*var\(--nav-active-bg\)/,
    '.list-item-btn 激活态必须采用 --nav-active-bg 背景色',
  )
})

test('表单网格原语：.form-grid 定义 130px 1fr 布局与对齐，响应式下切换单列', { timeout: 60_000 }, () => {
  assert.match(
    stylesCss,
    /\.form-grid\s*\{[^}]*grid-template-columns:\s*130px\s+1fr;/,
    '.form-grid 必须定义 grid-template-columns: 130px 1fr',
  )
  assert.match(
    stylesCss,
    /\.form-grid-label\s*\{/,
    '必须包含 .form-grid-label 标签原语',
  )
  assert.match(
    stylesCss,
    /\.form-grid-align-start\s*\{[^}]*align-items:\s*start;/,
    '必须包含 .form-grid-align-start 顶部对齐原语',
  )
  assert.match(
    responsiveCss,
    /\.form-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*!important;/,
    'responsive.css 必须在窄屏下将 .form-grid 切换为单列',
  )
})

test('静音容器与空状态原语：.section-flat, .search-box, .empty-state 族系规范', { timeout: 60_000 }, () => {
  assert.match(
    stylesCss,
    /\.section-flat\s*\{/,
    '必须包含 .section-flat 规则',
  )
  assert.match(
    stylesCss,
    /\.search-box\s*\{/,
    '必须包含 .search-box 规则',
  )
  assert.match(
    stylesCss,
    /\.empty-state\s*\{/,
    '必须包含 .empty-state 容器规则',
  )
  assert.match(
    stylesCss,
    /\.empty-state-icon\s*\{/,
    '必须包含 .empty-state-icon 规则',
  )
  assert.match(
    stylesCss,
    /\.empty-state-title\s*\{/,
    '必须包含 .empty-state-title 规则',
  )
})

test('既有测试契约不受破坏：.btn-send, .pane-parent-nav-btn, .msg-hover-bar .btn', { timeout: 60_000 }, () => {
  assert.match(
    stylesCss,
    /\.btn-send\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*border-radius:\s*50%/,
    '.btn-send 必须保持 32x32 50% 圆形',
  )
  assert.match(
    stylesCss,
    /\.pane-parent-nav-btn\s*\{[^}]*border-radius:\s*999px;/,
    '.pane-parent-nav-btn 必须保持 999px 胶囊圆角',
  )
  assert.match(
    stylesCss,
    /\.pane-parent-nav-btn\s*\{[^}]*flex-shrink:\s*0;/,
    '.pane-parent-nav-btn 必须保持 flex-shrink: 0',
  )
  assert.match(
    stylesCss,
    /\.msg-hover-bar\s+\.btn\s*\{[^}]*background:\s*transparent/,
    '.msg-hover-bar .btn 必须保持透明背景',
  )
  assert.match(
    stylesCss,
    /\.msg-hover-bar\s+\.btn\s*\{[^}]*border:\s*none/,
    '.msg-hover-bar .btn 必须保持无边框',
  )
})

test('文本选择与复制契约：html/body/#root 默认允许 user-select: text，按钮原语保持 user-select: none', { timeout: 60_000 }, () => {
  assert.match(
    stylesCss,
    /html,\s*\nbody,\s*\n#root\s*\{[\s\S]*?user-select:\s*text;/,
    'html, body, #root 必须声明 user-select: text 以允许页面自由复制',
  )
  assert.match(
    stylesCss,
    /button,\s*\n\[role="button"\],\s*\n\[role="tab"\]\s*\{[\s\S]*?user-select:\s*none;/,
    '交互按钮必须声明 user-select: none 防止误触全选高亮',
  )
})

test('全平台设计系统原语契约：主框架统一提供表格、Screen 页面、KV、Callout 与加载态，杜绝插件私有拷贝', { timeout: 60_000 }, () => {
  assert.match(
    stylesCss,
    /\.helm-table-wrap[\s\S]*?\{/,
    '主框架必须提供 .helm-table-wrap 表格容器原语',
  )
  assert.match(
    stylesCss,
    /\.table-wrap[\s\S]*?\{/,
    '主框架必须提供 .table-wrap 表格容器原语',
  )
  assert.match(
    stylesCss,
    /\.helm-table[\s\S]*?\{/,
    '主框架必须提供 .helm-table 表格本体原语',
  )
  assert.match(
    stylesCss,
    /\.screen-container[\s\S]*?\{/,
    '主框架必须提供 .screen-container 页面容器原语',
  )
  assert.match(
    stylesCss,
    /\.helm-kv-grid[\s\S]*?\{/,
    '主框架必须提供 .helm-kv-grid 与 .kv-grid 键值列表原语',
  )
  assert.match(
    stylesCss,
    /\.helm-callout[\s\S]*?\{/,
    '主框架必须提供 .helm-callout 与 .callout 横幅通知原语',
  )
  assert.match(
    stylesCss,
    /\.loading-state[\s\S]*?\{/,
    '主框架必须提供 .loading-state 加载中原语',
  )
})
