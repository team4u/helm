import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToString } from 'react-dom/server'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))

;(globalThis as Record<string, unknown>).React = React
const { Switch } = await import('../src/ui/Switch.js')
const { Checkbox } = await import('../src/ui/Checkbox.js')

const e = React.createElement

function collectSourceFiles(dir: string, ext: string[]): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const st = statSync(fullPath)
    if (st.isDirectory()) {
      results.push(...collectSourceFiles(fullPath, ext))
    } else if (ext.some((x) => fullPath.endsWith(x))) {
      results.push(fullPath)
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// 1. 全仓静态扫描：0 处原生 <input type="checkbox"
// ---------------------------------------------------------------------------

test('静态扫描契约：packages/web/src 下 0 处原生 <input type="checkbox"', { timeout: 60_000 }, () => {
  const srcDir = join(PKG_ROOT, 'src')
  const files = collectSourceFiles(srcDir, ['.ts', '.tsx', '.html'])
  const violations: string[] = []

  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    if (/type=['"]checkbox['"]/i.test(content)) {
      violations.push(file)
    }
  }

  assert.deepEqual(violations, [], `发现未迁移的原生 checkbox: ${violations.join(', ')}`)
})

// ---------------------------------------------------------------------------
// 2. Switch 组件 SSR 渲染与无障碍契约
// ---------------------------------------------------------------------------

test('Switch：基础状态、受控 checked、WAI-ARIA 属性与零 Emoji', { timeout: 60_000 }, () => {
  // 未激活状态
  const offHtml = renderToString(
    e(Switch, {
      checked: false,
      onChange: () => {},
      label: '网关状态',
      id: 'gateway-switch',
    }),
  )

  assert.match(offHtml, /class="helm-switch-wrap"/)
  assert.match(offHtml, /role="switch"/)
  assert.match(offHtml, /aria-checked="false"/)
  assert.match(offHtml, /id="gateway-switch"/)
  assert.match(offHtml, /class="helm-switch"/)
  assert.match(offHtml, /class="helm-switch-thumb"/)
  assert.match(offHtml, /class="helm-switch-label">网关状态<\/span>/)
  assert.doesNotMatch(offHtml, /is-checked/)
  // 零 Emoji 保证
  assert.doesNotMatch(offHtml, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u)

  // 激活状态
  const onHtml = renderToString(
    e(Switch, {
      checked: true,
      onChange: () => {},
      label: '已开启',
    }),
  )

  assert.match(onHtml, /aria-checked="true"/)
  assert.match(onHtml, /is-checked/)

  // 禁用态
  const disabledHtml = renderToString(
    e(Switch, {
      checked: true,
      disabled: true,
      onChange: () => {},
      label: '只读开关',
    }),
  )

  assert.match(disabledHtml, /class="helm-switch-wrap is-disabled"/)
  assert.match(disabledHtml, /disabled=""/)

  // 无 label 模式直接渲染 switchButton 容器
  const noLabelHtml = renderToString(
    e(Switch, {
      checked: false,
      onChange: () => {},
      'aria-label': '静默开关',
    }),
  )
  assert.match(noLabelHtml, /<span class="helm-switch-wrap">/)
  assert.match(noLabelHtml, /aria-label="静默开关"/)
  assert.doesNotMatch(noLabelHtml, /helm-switch-label/)
})

// ---------------------------------------------------------------------------
// 3. Checkbox 组件 SSR 渲染与半选状态契约
// ---------------------------------------------------------------------------

test('Checkbox：未选、勾选、半选（indeterminate）、无障碍与零 Emoji', { timeout: 60_000 }, () => {
  // 未勾选状态
  const uncheckedHtml = renderToString(
    e(Checkbox, {
      checked: false,
      onChange: () => {},
      label: '多选条目',
      id: 'item-chk',
    }),
  )

  assert.match(uncheckedHtml, /class="helm-checkbox-wrap"/)
  assert.match(uncheckedHtml, /role="checkbox"/)
  assert.match(uncheckedHtml, /aria-checked="false"/)
  assert.match(uncheckedHtml, /id="item-chk"/)
  assert.match(uncheckedHtml, /class="helm-checkbox"/)
  assert.match(uncheckedHtml, /class="helm-checkbox-label">多选条目<\/span>/)
  assert.doesNotMatch(uncheckedHtml, /is-checked/)
  assert.doesNotMatch(uncheckedHtml, /is-indeterminate/)
  assert.doesNotMatch(uncheckedHtml, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u)

  // 勾选状态：显示精细 check 图标
  const checkedHtml = renderToString(
    e(Checkbox, {
      checked: true,
      onChange: () => {},
      label: '强制重装/重试',
    }),
  )

  assert.match(checkedHtml, /aria-checked="true"/)
  assert.match(checkedHtml, /is-checked/)
  assert.match(checkedHtml, /<svg/) // lucide check 图标

  // 半选（indeterminate）状态：显示 minus 图标，aria-checked="mixed"
  const indHtml = renderToString(
    e(Checkbox, {
      checked: false,
      indeterminate: true,
      onChange: () => {},
      label: '全选（部分选中）',
    }),
  )

  assert.match(indHtml, /aria-checked="mixed"/)
  assert.match(indHtml, /is-indeterminate/)
  assert.match(indHtml, /<svg/) // lucide minus 图标

  // 禁用态
  const disabledHtml = renderToString(
    e(Checkbox, {
      checked: true,
      disabled: true,
      onChange: () => {},
      label: '受保护',
    }),
  )

  assert.match(disabledHtml, /class="helm-checkbox-wrap is-disabled"/)
  assert.match(disabledHtml, /disabled=""/)

  // 无 label 模式（例如侧栏批量选择框）
  const noLabelHtml = renderToString(
    e(Checkbox, {
      className: 'sidebar-batch-checkbox',
      checked: true,
      onChange: () => {},
      'aria-label': '选择会话',
    }),
  )
  assert.match(noLabelHtml, /class="helm-checkbox-wrap sidebar-batch-checkbox"/)
  assert.doesNotMatch(noLabelHtml, /helm-checkbox-label/)
})

// ---------------------------------------------------------------------------
// 4. styles.css 设计系统契约测试
// ---------------------------------------------------------------------------

test('设计系统契约：人类消息对称微圆角、状态徽章发丝微圆角、Composer 环境条内嵌与 Switch/Checkbox 样式', { timeout: 60_000 }, () => {
  const cssPath = join(PKG_ROOT, 'src/styles.css')
  const css = readFileSync(cssPath, 'utf-8')

  // 1. 人类消息气泡：去除社交 IM 缺尖角 (14px 14px 4px 14px)，使用统一对称微圆角 var(--radius-md)
  assert.match(css, /\.msg-human-pill\s*\{[^}]*border-radius:\s*var\(--radius-md\);/)
  assert.doesNotMatch(css, /14px\s+14px\s+4px\s+14px/)

  // 2. 状态徽章：从 999px 胶囊改为发丝微圆角 var(--radius-xs)
  assert.match(css, /\.badge\s*\{[^}]*border-radius:\s*var\(--radius-xs\);/)

  // 3. Composer 环境条 Select 与 cwd 等高 28px、等圆角 var(--radius-sm)、内嵌图标
  assert.match(css, /\.composer-env-select \.helm-select-trigger\s*\{[^}]*height:\s*28px;/)
  assert.match(css, /\.composer-env-select \.helm-select-trigger\s*\{[^}]*border-radius:\s*var\(--radius-sm\);/)
  assert.match(css, /\.input\.composer-env-cwd-input\s*\{[^}]*height:\s*28px;/)
  assert.match(css, /\.input\.composer-env-cwd-input\s*\{[^}]*border-radius:\s*var\(--radius-sm\);/)
  assert.match(css, /\.composer-env-cwd-wrap/)
  assert.match(css, /\.composer-env-cwd-icon/)

  // 4. Switch 与 Checkbox 样式定义
  assert.match(css, /\.helm-switch\s*\{/)
  assert.match(css, /\.helm-switch\.is-checked/)
  assert.match(css, /\.helm-switch-thumb\s*\{/)
  assert.match(css, /\.helm-checkbox\s*\{/)
  assert.match(css, /\.helm-checkbox\.is-checked/)
  assert.match(css, /\.helm-checkbox\.is-indeterminate/)
})

// ---------------------------------------------------------------------------
// 5. ProfileDetailDrawer & PluginDetailDrawer 细节契约
// ---------------------------------------------------------------------------

test('ProfileDetailDrawer：技能白名单使用 Switch 与 Checkbox，受保护角色禁止删除', { timeout: 60_000 }, () => {
  const profileDrawerSource = readFileSync(
    join(PKG_ROOT, 'src/profiles/ProfileDetailDrawer.tsx'),
    'utf-8',
  )

  // 1. 技能白名单限制开关使用 Switch
  assert.match(profileDrawerSource, /<Switch[\s\S]*?checked=\{form\.useAllSkills\}/)

  // 2. 技能多选清单使用 Checkbox
  assert.match(profileDrawerSource, /<Checkbox[\s\S]*?checked=\{form\.selectedSkillIds\.includes/)

  // 3. 受保护系统角色禁止删除
  assert.match(profileDrawerSource, /isSystemProfile\(profile\)/)
})

test('PluginDetailDrawer：布尔字段使用 Switch，停用按钮使用低饱和中性按钮', { timeout: 60_000 }, () => {
  const pluginDrawerSource = readFileSync(
    join(PKG_ROOT, 'src/plugins/PluginDetailDrawer.tsx'),
    'utf-8',
  )

  // 1. 布尔字段使用 Switch
  assert.match(pluginDrawerSource, /schema\.type === 'boolean'\s*\?\s*\(\s*<Switch/)

  // 2. 停用按钮从 btn-danger 改为 btn
  assert.match(pluginDrawerSource, /className=\{`btn btn-sm \$\{plugin\.enabled \? 'btn' : 'btn-primary'\}`\}/)
  assert.doesNotMatch(pluginDrawerSource, /plugin\.enabled \? 'btn-danger' : 'btn-primary'/)
})

test('Composer：SessionEnvBar 消除外挂图标套娃，内嵌 folder 图标', { timeout: 60_000 }, () => {
  const composerSource = readFileSync(
    join(PKG_ROOT, 'src/conversation/Composer.tsx'),
    'utf-8',
  )

  // 1. Select 外层没有外挂的 HelmIcon name="network"
  assert.doesNotMatch(composerSource, /<HelmIcon name="network" size=\{12\} \/>\s*<Select/)

  // 2. cwd 输入框使用 composer-env-cwd-wrap 与内嵌 composer-env-cwd-icon
  assert.match(composerSource, /className="composer-env-item composer-env-cwd-wrap"/)
  assert.match(composerSource, /<HelmIcon name="folder" size=\{12\} className="composer-env-cwd-icon" \/>/)
})
