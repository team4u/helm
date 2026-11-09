import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { findNextSelectableIndex, type SelectOption } from '../src/ui/select-model.js'

;(globalThis as Record<string, unknown>).React = React
const { Select } = await import('../src/ui/Select.js')

const e = React.createElement

// ---------------------------------------------------------------------------
// 1. 纯函数测试：findNextSelectableIndex
// ---------------------------------------------------------------------------

test('findNextSelectableIndex：正常在可用项间上下移动并跳过禁用项', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [
    { value: '1', label: 'Item 1' },
    { value: '2', label: 'Item 2', disabled: true },
    { value: '3', label: 'Item 3' },
  ]
  // 从 0 向下，跳过 1（disabled），到达 2
  assert.equal(findNextSelectableIndex(options, 0, 1), 2)
  // 从 2 向上，跳过 1（disabled），到达 0
  assert.equal(findNextSelectableIndex(options, 2, -1), 0)
  // 越界保护：到达顶部再向上保持当前
  assert.equal(findNextSelectableIndex(options, 0, -1), 0)
  // 越界保护：到达底部再向下保持当前
  assert.equal(findNextSelectableIndex(options, 2, 1), 2)
})

// ---------------------------------------------------------------------------
// 2. SSR 渲染与 DOM 契约测试
// ---------------------------------------------------------------------------

test('Select：基础触发器渲染符合无障碍与项目极简视觉规范', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [
    { value: 'local', label: 'local (本机)', icon: 'monitor' },
    { value: 'node-1', label: 'node-1', icon: 'network', meta: '在线' },
  ]

  const html = renderToString(
    e(Select, {
      value: 'local',
      options,
      onChange: () => {},
      'aria-label': '会话执行节点',
      className: 'composer-env-select',
    }),
  )

  // 1. 结构与容器类名
  assert.match(html, /class="helm-select composer-env-select"/)
  assert.match(html, /class="helm-select-trigger"/)

  // 2. 无障碍属性
  assert.match(html, /aria-label="会话执行节点"/)
  assert.match(html, /aria-haspopup="listbox"/)
  assert.match(html, /aria-expanded="false"/)

  // 3. 选中文案与 Lucide 旋转折叠图标
  assert.match(html, /<span class="helm-select-label">local \(本机\)<\/span>/)
  assert.match(html, /helm-select-chevron/)

  // 4. 严禁包含 Emoji
  assert.equal(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(html), false)
})

test('Select：支持前缀图标与禁用态', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [{ value: 'a', label: '选项 A' }]
  const html = renderToString(
    e(Select, {
      value: 'a',
      options,
      onChange: () => {},
      prefixIcon: 'network',
      disabled: true,
    }),
  )

  assert.match(html, /disabled=""/)
  assert.match(html, /helm-select-prefix/)
})

test('Select：支持 placeholder 与自定义 size 类名', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [{ value: 'a', label: '选项 A' }]
  const html = renderToString(
    e(Select, {
      value: 'unmatched',
      placeholder: '请选择节点…',
      options,
      onChange: () => {},
      size: 'sm',
    }),
  )

  assert.match(html, /class="helm-select helm-select-sm"/)
  assert.match(html, /<span class="helm-select-label helm-select-placeholder">请选择节点…<\/span>/)
})

test('契约：packages/web/src 下全部原生 select 已替换为公共 Select 组件', { timeout: 60_000 }, () => {
  const srcDir = new URL('../src/', import.meta.url)
  const files: string[] = []

  function walk(dir: URL) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
      if (entry.isDirectory()) {
        walk(child)
      } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
        files.push(fileURLToPath(child))
      }
    }
  }

  walk(srcDir)
  assert.ok(files.length > 0)

  const violations: string[] = []
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf8')
    if (content.includes('<select')) {
      violations.push(filePath)
    }
  }

  assert.deepEqual(violations, [], 'packages/web/src 下不得存在任何原生 <select> 标签')
})

test('契约：ProfileEditorModal 中的模型与节点选择均采用公共 Select，且高度与字号契约对齐', { timeout: 60_000 }, () => {
  const profileEditorSource = readFileSync(new URL('../src/modals/ProfileEditorModal.tsx', import.meta.url), 'utf8')
  const stylesSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

  // 1. Profile 中的模型、思考等级、节点均使用 <Select>
  assert.match(profileEditorSource, /<Select[\s\S]*?id="helm-profile-model"/)
  assert.match(profileEditorSource, /<Select[\s\S]*?id="helm-profile-thinking"/)
  assert.match(profileEditorSource, /<Select[\s\S]*?id="helm-profile-node"/)
  assert.match(profileEditorSource, /<Select[\s\S]*?id="helm-runtime-node"/)

  // 2. 模型下拉不强制 mono，避免中文（如“跟随全局默认模型”）字体被等宽扭曲
  assert.doesNotMatch(profileEditorSource, /id="helm-profile-model"[\s\S]*?className="mono"/)

  // 3. 样式契约：.input 与 .helm-select-trigger 严格等高（32px）与相同边框圆角规范
  assert.match(stylesSource, /\.input,\s*\.select\s*\{[\s\S]*?height:\s*32px;/)
  assert.match(stylesSource, /\.helm-select-trigger\s*\{[\s\S]*?height:\s*32px;/)
  assert.match(stylesSource, /\.helm-select-trigger\s*\{[\s\S]*?font-size:\s*13px;/)
})


