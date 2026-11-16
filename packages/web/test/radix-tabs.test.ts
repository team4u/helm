import test from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const { Tabs, TabsList, TabsTrigger, TabsContent, SegmentedControl } = await import('@helm/plugin-client')

// ---------------------------------------------------------------------------
// 1. SSR 渲染与数据属性（data-state="active"）契约测试
// ---------------------------------------------------------------------------

test('SSR：Tabs 默认渲染下划线选项卡（tabs-bar 与 tab-btn），包含 WAI-ARIA 语义与 data-state', { timeout: 60_000 }, () => {
  const html = renderToString(
    React.createElement(
      Tabs,
      { value: 'tab1' },
      React.createElement(
        TabsList,
        { 'aria-label': '主导航' },
        React.createElement(TabsTrigger, { value: 'tab1' }, '选项卡一'),
        React.createElement(TabsTrigger, { value: 'tab2' }, '选项卡二'),
      ),
      React.createElement(TabsContent, { value: 'tab1' }, '内容一'),
      React.createElement(TabsContent, { value: 'tab2' }, '内容二'),
    ),
  )

  // 1. WAI-ARIA 语义
  assert.match(html, /role="tablist"/, 'TabsList 应渲染 role="tablist"')
  assert.match(html, /role="tab"/, 'TabsTrigger 应渲染 role="tab"')
  assert.match(html, /role="tabpanel"/, 'TabsContent 应渲染 role="tabpanel"')

  // 2. 下划线选项卡类名契约
  assert.match(html, /class="[^"]*tabs-bar[^"]*"/, '默认 List 类名应包含 tabs-bar')
  assert.match(html, /class="[^"]*tab-btn[^"]*tab-btn-active[^"]*"/, '激活项应包含 tab-btn 与 tab-btn-active')

  // 3. 数据属性状态
  assert.match(html, /data-state="active"/, '激活项必须带有 data-state="active"')
  assert.match(html, /data-state="inactive"/, '未激活项必须带有 data-state="inactive"')
  assert.match(html, /aria-selected="true"/, '激活项应具备 aria-selected="true"')
  assert.match(html, /aria-selected="false"/, '未激活项应具备 aria-selected="false"')
  assert.match(html, /内容一/, '激活的内容区域应被渲染')
})

test('SSR：Tabs variant="segmented" 渲染分段控制器（segmented-control 与 segmented-control-btn）', { timeout: 60_000 }, () => {
  const html = renderToString(
    React.createElement(
      Tabs,
      { value: 'rich', variant: 'segmented' },
      React.createElement(
        TabsList,
        { 'aria-label': '视图模式' },
        React.createElement(TabsTrigger, { value: 'rich' }, '富文本'),
        React.createElement(TabsTrigger, { value: 'source' }, '源码'),
      ),
    ),
  )

  assert.match(html, /class="[^"]*segmented-control[^"]*"/, 'List 类名应包含 segmented-control')
  assert.match(html, /class="[^"]*segmented-control-btn[^"]*is-active[^"]*"/, '激活按钮应包含 is-active')
  assert.match(html, /data-state="active"/, '激活项带有 data-state="active"')
})

test('SSR：SegmentedControl 语义化封装组件渲染与属性传递', { timeout: 60_000 }, () => {
  const html = renderToString(
    React.createElement(SegmentedControl, {
      value: 'all',
      'aria-label': '状态筛选',
      className: 'provider-filters',
      items: [
        { value: 'all', label: '全部', title: '查看全部供应商' },
        { value: 'configured', label: '已配置', disabled: true },
        { value: 'unconfigured', label: '待配置' },
      ],
    }),
  )

  assert.match(html, /class="[^"]*segmented-control[^"]*provider-filters[^"]*"/, '应合并外部 className')
  assert.match(html, /data-state="active"/, '激活项应具备 data-state="active"')
  assert.match(html, /title="查看全部供应商"/, '应透传 item title')
  assert.match(html, /disabled=""/, '禁用项应带有 disabled 属性')
  assert.match(html, /data-disabled=""/, '禁用项应带有 data-disabled 数据属性')
})

// ---------------------------------------------------------------------------
// 2. DOM 交互与 onValueChange 回调测试
// ---------------------------------------------------------------------------

test('DOM：SegmentedControl 受控模式点击项触发 onValueChange 回调', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  let currentValue = 'rich'
  const changes: string[] = []

  await act(async () => {
    root.render(
      React.createElement(SegmentedControl, {
        value: currentValue,
        onValueChange: (val: string) => {
          changes.push(val)
          currentValue = val
        },
        items: [
          { value: 'rich', label: '富文本' },
          { value: 'source', label: '源码' },
        ],
      }),
    )
  })

  const buttons = host.querySelectorAll('button')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0]?.getAttribute('data-state'), 'active')
  assert.equal(buttons[1]?.getAttribute('data-state'), 'inactive')

  // 点击源码按钮
  await act(async () => {
    buttons[1]?.click()
  })

  assert.deepEqual(changes, ['source'], '点击非激活项应触发 onValueChange')

  root.unmount()
  host.remove()
})

test('DOM：SegmentedControl 禁用项点击不触发 onValueChange 回调', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  const changes: string[] = []

  await act(async () => {
    root.render(
      React.createElement(SegmentedControl, {
        value: 'a',
        onValueChange: (val: string) => changes.push(val),
        items: [
          { value: 'a', label: '选项 A' },
          { value: 'b', label: '选项 B (禁用)', disabled: true },
        ],
      }),
    )
  })

  const buttons = host.querySelectorAll('button')
  assert.equal(buttons[1]?.disabled, true)

  await act(async () => {
    buttons[1]?.click()
  })

  assert.deepEqual(changes, [], '禁用项点击不应触发 onValueChange 回调')

  root.unmount()
  host.remove()
})

test('DOM：Tabs.Root / Tabs.List / Tabs.Trigger 复合组件语法与激活态切换', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  let selected = 'basic'
  const changes: string[] = []

  await act(async () => {
    root.render(
      React.createElement(
        Tabs,
        {
          value: selected,
          onValueChange: (val) => {
            changes.push(val)
            selected = val
          },
          variant: 'underline',
        },
        React.createElement(
          TabsList,
          null,
          React.createElement(TabsTrigger, { value: 'basic' }, '基础信息'),
          React.createElement(TabsTrigger, { value: 'system' }, 'SYSTEM.md'),
          React.createElement(TabsTrigger, { value: 'memory' }, 'MEMORY.md'),
        ),
      ),
    )
  })

  const triggers = host.querySelectorAll('button')
  assert.equal(triggers.length, 3)
  assert.equal(triggers[0]?.getAttribute('data-state'), 'active')
  assert.ok(triggers[0]?.classList.contains('tab-btn-active'))

  // 点击第二个 trigger
  await act(async () => {
    triggers[1]?.click()
  })

  assert.deepEqual(changes, ['system'])

  root.unmount()
  host.remove()
})

// ---------------------------------------------------------------------------
// 3. 键盘导航合规性测试（WAI-ARIA Tabs）
// ---------------------------------------------------------------------------

test('键盘导航：ArrowRight / ArrowLeft 箭头键移动焦点与自动激活，支持回环', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  let currentTab = 'tab1'
  const changes: string[] = []

  await act(async () => {
    root.render(
      React.createElement(
        Tabs,
        {
          defaultValue: 'tab1',
          onValueChange: (val) => {
            changes.push(val)
            currentTab = val
          },
        },
        React.createElement(
          TabsList,
          null,
          React.createElement(TabsTrigger, { value: 'tab1' }, '选项 1'),
          React.createElement(TabsTrigger, { value: 'tab2' }, '选项 2'),
          React.createElement(TabsTrigger, { value: 'tab3' }, '选项 3'),
        ),
      ),
    )
  })

  const triggers = host.querySelectorAll('button')
  assert.equal(triggers.length, 3)

  // 1. 初始焦点位于 tab1，触发 ArrowRight
  await act(async () => {
    triggers[0]?.focus()
    triggers[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
  })

  assert.equal(currentTab, 'tab2', 'ArrowRight 导航至下一个 tab 并激活')

  // 2. 再次触发 ArrowRight
  await act(async () => {
    const active = document.activeElement as HTMLElement
    active?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
  })

  assert.equal(currentTab, 'tab3', 'ArrowRight 再次导航至第三个 tab 并激活')

  // 3. 触发 ArrowLeft 回到 tab2
  await act(async () => {
    const active = document.activeElement as HTMLElement
    active?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
  })

  assert.equal(currentTab, 'tab2', 'ArrowLeft 导航回前一个 tab 并激活')

  root.unmount()
  host.remove()
})

test('键盘导航：Enter 与 Space 键激活聚焦的 Trigger 项', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  let currentTab = 'first'
  const changes: string[] = []

  await act(async () => {
    root.render(
      React.createElement(
        Tabs,
        {
          defaultValue: 'first',
          activationMode: 'manual',
          onValueChange: (val) => {
            changes.push(val)
            currentTab = val
          },
        },
        React.createElement(
          TabsList,
          null,
          React.createElement(TabsTrigger, { value: 'first' }, 'First'),
          React.createElement(TabsTrigger, { value: 'second' }, 'Second'),
        ),
      ),
    )
  })

  const triggers = host.querySelectorAll('button')

  // 在 manual 模式下，Enter 键激活
  await act(async () => {
    triggers[1]?.focus()
    triggers[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })

  assert.equal(currentTab, 'second', 'Enter 键成功激活 second tab')

  // Space 键激活 first
  await act(async () => {
    triggers[0]?.focus()
    triggers[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  })

  assert.equal(currentTab, 'first', 'Space 键成功激活 first tab')

  root.unmount()
  host.remove()
})

test('键盘导航：Roving tabindex 确保当前选项卡 tabindex=0，非激活项 tabindex=-1', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  await act(async () => {
    root.render(
      React.createElement(
        Tabs,
        { defaultValue: 't2' },
        React.createElement(
          TabsList,
          null,
          React.createElement(TabsTrigger, { value: 't1' }, 'T1'),
          React.createElement(TabsTrigger, { value: 't2' }, 'T2'),
          React.createElement(TabsTrigger, { value: 't3' }, 'T3'),
        ),
      ),
    )
  })

  const triggers = host.querySelectorAll('button')
  await act(async () => {
    triggers[1]?.focus()
  })

  assert.equal(triggers[0]?.getAttribute('tabindex'), '-1', '非激活项 tabIndex 应为 -1')
  assert.equal(triggers[1]?.getAttribute('tabindex'), '0', '激活项 tabIndex 应为 0（Tab 键焦点直接落入）')
  assert.equal(triggers[2]?.getAttribute('tabindex'), '-1', '非激活项 tabIndex 应为 -1')

  root.unmount()
  host.remove()
})
