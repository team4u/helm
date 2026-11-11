import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import * as ReactDOMClient from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PluginSummary } from '@helm/protocol'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const e = React.createElement

// 动态导入待测组件（TDD 初始阶段因未实现将失败）
const { PluginCard } = await import('../src/plugins/PluginCard.js')

// ---------------------------------------------------------------------------
// 辅助 Mock 插件数据
// ---------------------------------------------------------------------------

function makePlugin(partial: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'builtin:workflow',
    name: '工作流引擎',
    version: '1.2.0',
    locked: false,
    enabled: true,
    hooks: ['before_turn', 'turn_settled'],
    actions: ['run', 'inspect'],
    tools: ['subagent', 'cleanup_worktree'],
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// 1. SSR 渲染测试：卡片包含图标、名称、版本、锁定标签、Tools/Actions 胶囊徽章
// ---------------------------------------------------------------------------

test('PluginCard：优先展示插件定义自带的 description，不做 ID 特判', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(PluginCard, {
      plugin: makePlugin({
        id: 'builtin:json-render',
        name: 'JSON 卡片渲染',
        description: '聊天 ```ui 代码块渲染：把模型输出的安全 JSON Spec 渲染为交互卡片。',
        tools: [],
        actions: [],
        hooks: [],
      }),
      selected: false,
      onSelect: () => {},
      onToggle: () => {},
    }),
  )
  assert.match(html, /JSON Spec 渲染为交互卡片/)
  assert.doesNotMatch(html, /系统扩展插件组件/)
})

test('PluginCard：未声明 description 时回退能力透视而非 ID 特判', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(PluginCard, {
      plugin: makePlugin({
        id: 'builtin:profile',
        name: '角色与技能底座',
        description: undefined,
        tools: ['load_skill'],
        actions: [],
        hooks: [],
      }),
      selected: false,
      onSelect: () => {},
      onToggle: () => {},
    }),
  )
  // 无后端描述时也不再返回硬编码的 profile 文案，而是能力透视
  assert.match(html, /1 个工具/)
  assert.doesNotMatch(html, /常驻角色与技能底座/)
})

test('PluginCard：SSR 渲染包含图标、名称、版本、常驻标签与能力胶囊徽章', { timeout: 60_000 }, () => {
  const plugin = makePlugin({
    id: 'builtin:workflow',
    name: '工作流引擎',
    version: '1.2.0',
    locked: true,
    enabled: true,
    tools: ['subagent', 'cleanup_worktree'],
    actions: ['run', 'inspect'],
    hooks: ['before_turn'],
  })

  const html = renderToString(
    e(PluginCard, {
      plugin,
      selected: false,
      onSelect: () => {},
      onToggle: () => {},
    }),
  )

  // 1. 卡片主体类名与插件 ID 标记
  assert.match(html, /class="[^"]*plugin-card[^"]*"/)
  assert.match(html, /data-plugin-id="builtin:workflow"/)

  // 2. 名称与 ID
  assert.match(html, /工作流引擎/)
  assert.match(html, /builtin:workflow/)

  // 3. 版本号
  assert.match(html, /v1\.2\.0/)

  // 4. 常驻锁定标签（locked: true）
  assert.match(html, /常驻/)
  assert.match(html, /plugin-card-locked-badge/)

  // 5. 能力胶囊徽章（Tools / Actions / Hooks）
  assert.match(html, /2 Tools/)
  assert.match(html, /2 Actions/)
  assert.match(html, /1 Hooks/)
  assert.match(html, /class="[^"]*plugin-card-pill[^"]*"/)

  // 6. Switch 开关渲染且因 locked 处于禁用态
  assert.match(html, /role="switch"/)
  assert.match(html, /aria-checked="true"/)
  assert.match(html, /is-disabled|disabled/)
})

// ---------------------------------------------------------------------------
// 2. 交互测试：点击卡片主体与键盘导航触发 onSelect
// ---------------------------------------------------------------------------

test('PluginCard：点击卡片主体及按键触发 onSelect 回调', { timeout: 60_000 }, () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let selectCount = 0
  const plugin = makePlugin({ id: 'builtin:herdr', name: 'Herdr 节点协同' })

  act(() => {
    root.render(
      e(PluginCard, {
        plugin,
        selected: false,
        onSelect: () => {
          selectCount++
        },
        onToggle: () => {},
      }),
    )
  })

  const cardEl = container.querySelector('.plugin-card') as HTMLElement
  assert.ok(cardEl, '必须渲染 .plugin-card 容器')

  // 点击主体
  act(() => {
    cardEl.click()
  })
  assert.equal(selectCount, 1, '点击卡片应触发 onSelect')

  // 键盘 Enter / Space 触发
  act(() => {
    cardEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  assert.equal(selectCount, 2, '按 Enter 应触发 onSelect')

  act(() => {
    cardEl.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  })
  assert.equal(selectCount, 3, '按 Space 应触发 onSelect')

  act(() => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// 3. 交互测试：Switch 启停切换与点击防冒泡
// ---------------------------------------------------------------------------

test('PluginCard：切换 Switch 开关触发 onToggle 且阻止冒泡到 onSelect', { timeout: 60_000 }, () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let selectCount = 0
  let toggledValue: boolean | null = null

  const plugin = makePlugin({
    id: 'builtin:workflow',
    name: '工作流引擎',
    locked: false,
    enabled: true,
  })

  act(() => {
    root.render(
      e(PluginCard, {
        plugin,
        selected: false,
        onSelect: () => {
          selectCount++
        },
        onToggle: (enabled: boolean) => {
          toggledValue = enabled
        },
      }),
    )
  })

  const switchBtn = container.querySelector('[role="switch"]') as HTMLElement
  assert.ok(switchBtn, '必须渲染 Switch 开关按钮')

  act(() => {
    switchBtn.click()
  })

  assert.equal(toggledValue, false, '开启状态点击 Switch 应触发 onToggle(false)')
  assert.equal(selectCount, 0, '点击 Switch 不应冒泡触发卡片的 onSelect')

  act(() => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// 4. 锁定插件与 toggling 约束
// ---------------------------------------------------------------------------

test('PluginCard：常驻锁定插件（locked: true）与 toggling 态禁用 Switch', { timeout: 60_000 }, () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let toggleTriggered = false
  const lockedPlugin = makePlugin({
    id: 'builtin:profile',
    name: '个人助理',
    locked: true,
    enabled: true,
  })

  act(() => {
    root.render(
      e(PluginCard, {
        plugin: lockedPlugin,
        selected: false,
        onSelect: () => {},
        onToggle: () => {
          toggleTriggered = true
        },
      }),
    )
  })

  const switchBtn = container.querySelector('[role="switch"]') as HTMLButtonElement
  assert.ok(switchBtn, '必须渲染 Switch 开关')
  assert.equal(switchBtn.disabled, true, '常驻插件的 Switch 必须处于禁用状态')

  act(() => {
    switchBtn.click()
  })
  assert.equal(toggleTriggered, false, '常驻插件禁用 Switch 点击不应触发 onToggle')

  // 测试 toggling 态
  const normalPlugin = makePlugin({ locked: false, enabled: false })
  act(() => {
    root.render(
      e(PluginCard, {
        plugin: normalPlugin,
        selected: false,
        toggling: true,
        onSelect: () => {},
        onToggle: () => {},
      }),
    )
  })

  const togglingSwitchBtn = container.querySelector('[role="switch"]') as HTMLButtonElement
  assert.equal(togglingSwitchBtn.disabled, true, 'toggling: true 时 Switch 应处于禁用状态')

  act(() => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// 5. 选中状态与停用状态样式类
// ---------------------------------------------------------------------------

test('PluginCard：selected 与 enabled 状态正交映射到样式类', { timeout: 60_000 }, () => {
  // 1. selected: true
  const selectedHtml = renderToString(
    e(PluginCard, {
      plugin: makePlugin({ enabled: true }),
      selected: true,
      onSelect: () => {},
      onToggle: () => {},
    }),
  )
  assert.match(selectedHtml, /class="[^"]*is-selected[^"]*"/)
  assert.match(selectedHtml, /aria-selected="true"/)

  // 2. enabled: false
  const disabledHtml = renderToString(
    e(PluginCard, {
      plugin: makePlugin({ enabled: false }),
      selected: false,
      onSelect: () => {},
      onToggle: () => {},
    }),
  )
  assert.match(disabledHtml, /class="[^"]*is-disabled[^"]*"/)
  assert.match(disabledHtml, /aria-selected="false"/)
})

// ---------------------------------------------------------------------------
// 6. 静态源码与渲染输出零 Emoji 契约
// ---------------------------------------------------------------------------

test('PluginCard：源码与渲染输出全程 0 Emoji', { timeout: 60_000 }, () => {
  const componentPath = join(PKG_ROOT, 'src/plugins/PluginCard.tsx')
  const src = readFileSync(componentPath, 'utf-8')
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u

  assert.doesNotMatch(src, emojiRegex, 'PluginCard.tsx 源码中严禁含有任何 Emoji')

  const html = renderToString(
    e(PluginCard, {
      plugin: makePlugin({ locked: true }),
      selected: true,
      onSelect: () => {},
      onToggle: () => {},
    }),
  )
  assert.doesNotMatch(html, emojiRegex, 'PluginCard 渲染输出中严禁含有任何 Emoji')
})

// ---------------------------------------------------------------------------
// 7. 样式契约：styles.css 包含卡片与网格流类名
// ---------------------------------------------------------------------------

test('PluginCard 样式契约：styles.css 包含 .plugin-center-grid、.plugin-card、.plugin-card-pill', { timeout: 60_000 }, () => {
  const cssPath = join(PKG_ROOT, 'src/styles.css')
  const css = readFileSync(cssPath, 'utf-8')

  assert.match(css, /\.plugin-center-grid/, 'styles.css 必须包含 .plugin-center-grid 样式')
  assert.match(css, /\.plugin-card/, 'styles.css 必须包含 .plugin-card 样式')
  assert.match(css, /\.plugin-card-pill/, 'styles.css 必须包含 .plugin-card-pill 胶囊徽章样式')
  assert.match(css, /var\(--border\)/, '卡片样式必须遵循发丝边框变量规范')
})

// ---------------------------------------------------------------------------
// 8. 故障态（failed）展示：异常徽章、错误摘要与快捷开关禁用
// ---------------------------------------------------------------------------

test('PluginCard：status === failed 时渲染异常徽章与错误摘要并标记 is-failed', { timeout: 60_000 }, () => {
  const plugin = makePlugin({
    id: 'external:broken',
    name: '损坏插件',
    enabled: false,
    status: 'failed',
    error: {
      code: 'plugin_load_failed',
      message: '入口文件 index.ts 缺失',
      stage: 'load',
    },
  })

  const html = renderToString(
    e(PluginCard, {
      plugin,
      selected: false,
      onSelect: () => {},
      onToggle: () => {},
    }),
  )

  // 1. 卡片容器追加 is-failed 故障态类名
  assert.match(html, /class="[^"]*plugin-card[^"]*is-failed[^"]*"/)

  // 2. 标题行渲染异常徽章（含 title 错误摘要）
  assert.match(html, /class="[^"]*badge badge-err[^"]*"/)
  assert.match(html, /title="入口文件 index\.ts 缺失"/)
  assert.match(html, /<span>异常<\/span>/)

  // 3. 描述区域附带错误摘要
  assert.match(html, /plugin-card-error-summary/)
})

test('PluginCard：scan/load 阶段失败禁用快捷开关并提示查看错误详情', { timeout: 60_000 }, () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const plugin = makePlugin({
    id: 'external:bad-json',
    enabled: false,
    status: 'failed',
    error: {
      code: 'plugin_scan_failed',
      message: 'plugin.json 语法损坏',
      stage: 'scan',
    },
  })

  act(() => {
    root.render(
      e(PluginCard, {
        plugin,
        selected: false,
        onSelect: () => {},
        onToggle: () => {},
      }),
    )
  })

  const switchBtn = container.querySelector('[role="switch"]') as HTMLButtonElement
  assert.ok(switchBtn, '必须渲染 Switch 开关')
  assert.equal(switchBtn.disabled, true, 'scan/load 阶段失败的插件快捷开关必须禁用')
  assert.match(switchBtn.title || '', /插件加载失败/)

  act(() => {
    root.unmount()
  })
  container.remove()
})

test('PluginCard：enable/define 阶段失败不禁用快捷开关（模块已加载可重试）', { timeout: 60_000 }, () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const plugin = makePlugin({
    id: 'external:enable-fail',
    enabled: false,
    status: 'failed',
    error: {
      code: 'plugin_enable_failed',
      message: '服务启动超时',
      stage: 'enable',
    },
  })

  let toggled: boolean | null = null
  act(() => {
    root.render(
      e(PluginCard, {
        plugin,
        selected: false,
        onSelect: () => {},
        onToggle: (enabled: boolean) => {
          toggled = enabled
        },
      }),
    )
  })

  const switchBtn = container.querySelector('[role="switch"]') as HTMLButtonElement
  assert.equal(switchBtn.disabled, false, 'enable 阶段失败仍允许重试启用')

  act(() => {
    switchBtn.click()
  })
  assert.equal(toggled, true, '点击禁用态之外的开关应触发 onToggle(true)')

  act(() => {
    root.unmount()
  })
  container.remove()
})
