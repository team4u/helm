/**
 * 版本横幅移动端可点击性回归（结构/样式静态断言，与 composer-layout.test.ts 同约定）：
 * 真实手机 WebView 无法在 Node/happy-dom 中复现，这里锁定保证「立即刷新」按钮
 * 可被触达的结构性事实——按钮是真实 type=button 且直连手动刷新动作、文案区
 * flex:1 而按钮不被挤压、无 pointer-events 遮断、触控无 300ms 延迟、移动端
 * 汉堡按钮固定在左上不覆盖右侧刷新按钮、应用壳根节点不注册 touch 手势处理
 * 器（旧边缘滑动手势已移除，点击事件直达按钮）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const responsiveSource = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('版本横幅：真实按钮 type=button 且直连手动刷新动作（reloadNow 不被自动闸门短路）', { timeout: 60_000 }, () => {
  assert.match(appSource, /<div className="version-banner" role="status">/)
  assert.match(
    appSource,
    /<button type="button" className="btn btn-sm" onClick=\{versionWatch\.reloadNow\}>/,
    '「立即刷新」必须是显式按钮并直连手动刷新动作',
  )
  assert.match(appSource, /立即刷新/)
})

test('版本横幅布局：文案区 flex:1 收缩、按钮 flex-shrink:0 不被挤压出屏', { timeout: 60_000 }, () => {
  assert.match(responsiveSource, /\.version-banner-text \{ flex: 1; min-width: 0; \}/)
  assert.match(responsiveSource, /\.version-banner \.btn \{ flex-shrink: 0; \}/)
})

test('版本横幅无点击遮断：横幅规则不含 pointer-events: none', { timeout: 60_000 }, () => {
  const bannerRules = responsiveSource.match(/\.version-banner[^{]*\{[^}]*\}/g) ?? []
  assert.ok(bannerRules.length > 0, '能解析到 .version-banner 规则')
  for (const rule of bannerRules) {
    assert.ok(!rule.includes('pointer-events'), `横幅规则不得禁用指针事件: ${rule}`)
  }
})

test('按钮触控无延迟：全局 touch-action: manipulation 覆盖 button（消除 300ms 点击等待）', { timeout: 60_000 }, () => {
  assert.match(responsiveSource, /button, a, input, select, textarea \{ touch-action: manipulation; \}/)
})

test('移动端汉堡按钮锚定左上（left 定位、36px 宽）：不覆盖横幅行末尾的刷新按钮', { timeout: 60_000 }, () => {
  const toggleRule = responsiveSource.match(/\.mobile-nav-toggle \{[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.ok(toggleRule.length > 0, '能解析到 .mobile-nav-toggle 规则')
  assert.match(toggleRule, /left:/, '汉堡按钮固定在左侧')
  assert.ok(!toggleRule.includes('right:'), '汉堡按钮不锚定右侧（不与右侧刷新按钮重叠）')
  assert.match(toggleRule, /width: 36px;/)
  // 横幅内文案区 flex:1 占据左侧剩余空间，按钮作为行末元素位于最右，
  // 与左上 36px 的汉堡按钮在几何上不相交。
  assert.match(responsiveSource, /\.version-banner \{ display: flex;[^}]*\}/)
})

test('应用壳根节点不注册 touch 手势处理器：横幅按钮点击直达，无手势轴锁抢占路径', { timeout: 60_000 }, () => {
  // 当前移动端导航是汉堡按钮 + 遮罩（旧边缘滑动手势已移除）：根节点不再挂接
  // onTouch* 处理器，点击事件没有可被 preventDefault/轴锁截胡的中间层。
  assert.ok(
    !/onTouch(Start|Move|End|Cancel)=/.test(appSource),
    'App 根组件不得注册 touch 手势处理器（如需恢复手势须同步更新本回归）',
  )
})
