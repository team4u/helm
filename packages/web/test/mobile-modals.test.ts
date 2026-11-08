import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const mermaidSource = readFileSync(new URL('../src/conversation/MermaidPreviewModal.tsx', import.meta.url), 'utf8')
const pluginSettingsSource = readFileSync(new URL('../src/modals/PluginSettingsModal.tsx', import.meta.url), 'utf8')
const providerCatalogSource = readFileSync(new URL('../src/modals/ProviderCatalog.tsx', import.meta.url), 'utf8')
const commandPaletteSource = readFileSync(new URL('../src/modals/CommandPaletteModal.tsx', import.meta.url), 'utf8')
const providerAuthCss = readFileSync(new URL('../src/modals/provider-auth.css', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')

test('Mermaid 预览弹窗：头部标题自适应截断、操作组折行且关闭按钮始终可见', { timeout: 60_000 }, () => {
  // 标题必须具备防止折成单字竖排的样式：minWidth: 0, flex: 1, whiteSpace: nowrap, overflow: hidden, textOverflow: ellipsis
  assert.match(mermaidSource, /className="modal-title mermaid-modal-title"/)
  assert.match(mermaidSource, /minWidth:\s*0/)
  assert.match(mermaidSource, /flex:\s*1/)
  assert.match(mermaidSource, /whiteSpace:\s*['"]nowrap['"]/)
  assert.match(mermaidSource, /overflow:\s*['"]hidden['"]/)
  assert.match(mermaidSource, /textOverflow:\s*['"]ellipsis['"]/)

  // 独立关闭按钮与操作组分离
  assert.match(mermaidSource, /className="mermaid-modal-actions"/)
  assert.match(mermaidSource, /className="btn btn-ghost btn-sm mermaid-modal-close"/)

  // responsive.css 中小屏媒体查询确保关闭按钮在首排右上角、操作组换行
  const mobileMermaid = responsiveCss.slice(responsiveCss.indexOf('.mermaid-modal-header'))
  assert.match(mobileMermaid, /@media\s*\(max-width:\s*680px\)/)
  assert.match(mobileMermaid, /\.mermaid-modal-header\s*\{[^}]*flex-wrap:\s*wrap/)
  assert.match(mobileMermaid, /\.mermaid-modal-title\s*\{[^}]*order:\s*1/)
  assert.match(mobileMermaid, /\.mermaid-modal-close\s*\{[^}]*order:\s*2/)
  assert.match(mobileMermaid, /\.mermaid-modal-close\s*\{[^}]*margin-left:\s*auto/)
  assert.match(mobileMermaid, /\.mermaid-modal-actions\s*\{[^}]*order:\s*3/)
  assert.match(mobileMermaid, /\.mermaid-modal-actions\s*\{[^}]*flex-wrap:\s*wrap/)
})

test('插件设置弹窗：卡片头部支持 flex-wrap 且标题与状态标签不被挤压重叠', { timeout: 60_000 }, () => {
  // 卡片头部和元数据容器支持 flexWrap: 'wrap'
  assert.match(pluginSettingsSource, /className="plugin-card-header"/)
  assert.match(pluginSettingsSource, /flexWrap:\s*['"]wrap['"]/)
  assert.match(pluginSettingsSource, /className="plugin-card-meta"/)

  // 标题防止竖排折字
  assert.match(pluginSettingsSource, /fontWeight:\s*600,\s*fontSize:\s*13,\s*whiteSpace:\s*['"]nowrap['"]/)

  // 锁定核心插件标签设置 whiteSpace: nowrap，停用按钮设置 flexShrink: 0
  assert.match(pluginSettingsSource, /常驻核心插件，不可停用/)
  assert.match(pluginSettingsSource, /style=\{\{\s*whiteSpace:\s*['"]nowrap['"]\s*\}\}>\s*<HelmIcon name="lock"/)
  assert.match(pluginSettingsSource, /style=\{\{\s*flexShrink:\s*0\s*\}\}\s*disabled=\{plugin\.locked/)
})

test('供应商配置：消除小屏双层滚动陷阱，选中后切换视图并提供返回按钮', { timeout: 60_000 }, () => {
  // ProviderCatalog 绑定 has-selection 状态与 onBack 回调
  assert.match(providerCatalogSource, /const hasSelection = Boolean\(manual \|\| selected\)/)
  assert.match(providerCatalogSource, /className=\{`provider-catalog\$\{hasSelection \? ' has-selection' : ''\}`\}/)
  assert.match(providerCatalogSource, /onBack=\{\(\) => \{\s*setSelectedId\(null\)\s*setManual\(false\)\s*\}\}/)

  // ProviderDetail 渲染返回列表按钮
  assert.match(providerCatalogSource, /className="btn btn-ghost btn-sm provider-mobile-back"/)
  assert.match(providerCatalogSource, /返回供应商列表/)

  // provider-auth.css 规则：桌面端隐藏返回按钮，小屏下单视图排版消除双重滚动
  assert.match(providerAuthCss, /\.provider-mobile-back\s*\{\s*display:\s*none;\s*\}/)
  const mobileCatalog = providerAuthCss.slice(providerAuthCss.indexOf('@media (max-width: 680px)'))
  assert.match(mobileCatalog, /\.provider-catalog\.has-selection \.provider-sidebar\s*\{\s*display:\s*none;\s*\}/)
  assert.match(mobileCatalog, /\.provider-catalog:not\(\.has-selection\) \.provider-detail-scroll\s*\{\s*display:\s*none;\s*\}/)
  assert.match(mobileCatalog, /\.provider-mobile-back\s*\{[^}]*display:\s*inline-flex/)
  // 确保旧有的上下双层网格高度已被废除
  assert.doesNotMatch(mobileCatalog, /grid-template-rows:\s*minmax\(180px,\s*38%\)/)
})

test('命令面板：根据屏幕尺寸/触屏设备自适应切换 Esc 与关闭文案', { timeout: 60_000 }, () => {
  // 渲染 palette-close-btn 包含桌面端和移动端两种提示
  assert.match(commandPaletteSource, /className="btn btn-ghost btn-sm palette-close-btn"/)
  assert.match(commandPaletteSource, /className="palette-close-desktop badge badge-neutral">Esc 关闭<\/span>/)
  assert.match(commandPaletteSource, /className="palette-close-mobile"/)
  assert.match(commandPaletteSource, /<span style=\{\{\s*fontSize:\s*11\.5\s*\}\}>关闭<\/span>/)

  // responsive.css 在移动端或触屏下隐藏 Esc 提示并展示通用关闭按钮
  const paletteRule = responsiveCss.slice(responsiveCss.indexOf('.palette-close-btn'))
  assert.match(paletteRule, /@media\s*\(max-width:\s*680px\),\s*\(pointer:\s*coarse\)/)
  assert.match(paletteRule, /\.palette-close-desktop\s*\{\s*display:\s*none\s*!important;\s*\}/)
  assert.match(paletteRule, /\.palette-close-mobile\s*\{\s*display:\s*inline-flex\s*!important;\s*\}/)
})
