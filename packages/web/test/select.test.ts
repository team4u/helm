import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { readHostStyles } from './helpers/host-styles.js'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import * as ReactDOMClient from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { findNextSelectableIndex, type SelectOption, type SelectChangeEvent } from '../src/ui/select-model.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
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

test('Select：空字符串作为合法选项值（如跟随全局默认）正常呈现与选中', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [
    { value: '', label: '跟随全局默认节点' },
    { value: 'node-worker', label: 'node-worker' },
  ]
  const html = renderToString(
    e(Select, {
      value: '',
      options,
      onChange: () => {},
      placeholder: '请选择节点',
    }),
  )

  assert.match(html, /<span class="helm-select-label">跟随全局默认节点<\/span>/)
  assert.doesNotMatch(html, /helm-select-placeholder/)
})

// ---------------------------------------------------------------------------
// 3. Radix UI 无障碍属性、状态机与 DOM 交互契约测试
// ---------------------------------------------------------------------------

test('Select：无障碍角色（role="combobox" / role="listbox"）与状态机契约', { timeout: 60_000 }, () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const options: SelectOption<string>[] = [
    { value: 'node-local', label: '本机环境', icon: 'monitor' },
    { value: 'node-gpu', label: 'GPU 计算节点', icon: 'network', meta: '在线' },
    { value: 'node-offline', label: '离线节点', disabled: true },
  ]

  act(() => {
    root.render(
      e(Select, {
        value: 'node-local',
        options,
        open: true,
        inline: true,
        onChange: () => {},
        'aria-label': '目标执行节点',
      }),
    )
  })

  // 1. Trigger role="combobox" 与无障碍关联
  const trigger = container.querySelector('[role="combobox"]')
  assert.ok(trigger, 'Trigger 必须具备 role="combobox"')
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox')
  assert.equal(trigger.getAttribute('aria-label'), '目标执行节点')

  // 2. Content role="listbox" 与选项 role="option"
  const listbox = container.querySelector('[role="listbox"]')
  assert.ok(listbox, '下拉浮层必须具备 role="listbox"')
  assert.equal(listbox.getAttribute('data-state'), 'open')

  const optionElements = container.querySelectorAll('[role="option"]')
  assert.equal(optionElements.length, 3, '应渲染全部 3 个选项')

  // 3. 激活态与勾选指示符
  const selectedOptionEl = optionElements[0]
  assert.equal(selectedOptionEl?.getAttribute('data-state'), 'checked')
  assert.ok(selectedOptionEl?.querySelector('.helm-select-check'), '选中项应渲染 check 勾选指示器')

  const unselectedOptionEl = optionElements[1]
  assert.equal(unselectedOptionEl?.getAttribute('data-state'), 'unchecked')
  assert.equal(unselectedOptionEl?.querySelector('.helm-select-check'), null, '未选中项不应渲染勾选')

  // 4. 禁用态选项
  const disabledOptionEl = optionElements[2]
  assert.ok(disabledOptionEl?.hasAttribute('data-disabled'), '禁用项应带有 data-disabled')

  act(() => {
    root.unmount()
  })
  container.remove()
})

test('Select：键盘首字母跳转（Typeahead Search）与 Enter 键选择触发 onChange', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let changedEvent: SelectChangeEvent<string> | null = null

  const options: SelectOption<string>[] = [
    { value: 'apple', label: 'Apple' },
    { value: 'banana', label: 'Banana' },
    { value: 'cherry', label: 'Cherry' },
  ]

  act(() => {
    root.render(
      e(Select, {
        value: 'apple',
        name: 'fruitSelect',
        options,
        open: true,
        inline: true,
        onChange: (event: SelectChangeEvent<string>) => {
          changedEvent = event
        },
      }),
    )
  })

  const listbox = container.querySelector('[role="listbox"]')
  assert.ok(listbox, '浮层必须展开')

  // 1. 模拟在 listbox 上键入 'b'，应触发首字母跳转（Typeahead Search）
  await act(async () => {
    listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))
  })

  const optionElements = Array.from(container.querySelectorAll('[role="option"]'))
  const bananaOption = optionElements.find((el) => el.textContent?.includes('Banana'))
  assert.ok(bananaOption, '应找到 Banana 选项')
  assert.ok(bananaOption.hasAttribute('data-highlighted'), '输入 b 之后 Banana 选项应被高亮（data-highlighted）')

  // 2. 模拟回车确认选中
  await act(async () => {
    bananaOption.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })

  // 3. 校验 onChange 事件与 SelectChangeEvent 数据结构（包括 name）
  assert.ok(changedEvent, '回车后必须触发 onChange 回调')
  assert.equal((changedEvent as SelectChangeEvent<string>).target.value, 'banana')
  assert.equal((changedEvent as SelectChangeEvent<string>).target.name, 'fruitSelect')

  act(() => {
    root.unmount()
  })
  container.remove()
})

test('Select multiple: 渲染多选触发器、全选与清空操作栏及复选框，且零 Emoji', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [
    { value: 'm1', label: 'Model 1', meta: '200K' },
    { value: 'm2', label: 'Model 2', meta: '128K' },
    { value: 'm3', label: 'Model 3' },
  ]

  const html = renderToString(
    e(Select, {
      multiple: true,
      value: ['m1', 'm2'],
      options,
      onChange: () => {},
      inline: true,
      'aria-label': '模型多选',
    }),
  )

  // 1. 结构与多选类名
  assert.match(html, /class="[^"]*helm-select-multi[^"]*"/)
  assert.match(html, /已选择[\s\S]*?2[\s\S]*?项/)
  assert.match(html, /aria-label="模型多选"/)

  // 2. 快捷全选与清空按钮
  assert.match(html, /全选/)
  assert.match(html, /清空/)

  // 3. 复选框与选项呈现
  assert.match(html, /role="checkbox"/)
  assert.match(html, /Model 1/)
  assert.match(html, /Model 2/)
  assert.match(html, /200K/)

  // 4. 零 Emoji
  assert.equal(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(html), false)
})

test('Select multiple: 全选时触发器显示已全选摘要文案', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [
    { value: 'm1', label: 'Model 1' },
    { value: 'm2', label: 'Model 2' },
  ]

  const html = renderToString(
    e(Select, {
      multiple: true,
      value: ['m1', 'm2'],
      options,
      onChange: () => {},
    }),
  )

  assert.match(html, /已全选[\s\S]*?\(2\)/)
})

// ---------------------------------------------------------------------------
// 4. 架构规范与项目契约测试
// ---------------------------------------------------------------------------

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

test('契约：ProfileDetailDrawer 中的模型选择采用公共 Select，且高度与字号契约对齐', { timeout: 60_000 }, () => {
  const profileDrawerSource = readFileSync(new URL('../src/profiles/ProfileDetailDrawer.tsx', import.meta.url), 'utf8')
  const stylesSource = readHostStyles()

  // 1. Profile 中的默认模型使用 <Select>
  assert.match(profileDrawerSource, /import\s*\{[^}]*Select[^}]*\}\s*from\s*['"]\.\.\/ui\/Select(?:\.js)?['"]/)
  assert.match(profileDrawerSource, /<Select[\s\S]*?options=\{modelOptions\}/)

  // 2. 样式契约：.input 与 .helm-select-trigger 严格等高（27px）与相同边框圆角规范
  assert.match(stylesSource, /\.input,\s*\.select\s*\{[^}]*height:\s*27px;/)
  assert.match(stylesSource, /\.helm-select-trigger\s*\{[^}]*height:\s*27px;/)
  assert.match(stylesSource, /\.helm-select-trigger\s*\{[^}]*font-size:\s*12\.5px;/)
})
