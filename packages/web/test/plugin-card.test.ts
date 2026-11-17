import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import type { PluginSummary } from '@helm/protocol'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()
const ReactDOMClient = await import('react-dom/client')
const e = React.createElement

// 动态导入待测组件（TDD 初始阶段因未实现将失败）
const { PluginCard } = await import('../src/plugins/PluginCard.js')
const {
  getPluginDescription,
  pluginErrorStageLabel,
  resolvePluginIcon,
  DEFAULT_PLUGIN_ICON,
} = await import('../src/plugins/plugin-card-model.js')
const { createWebTranslator } = await import('../src/i18n/catalog.js')
const { HelmStoreContext, makeTestStore } = await import('./helpers/store.js')

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
  assert.doesNotMatch(html, /系统扩展Plugin component/)
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
  assert.match(html, /1 Agent Tools/)
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
  assert.match(html, /Resident/)
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

test('PluginCard：渲染输出全程 0 Emoji', { timeout: 60_000 }, () => {
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u

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
  assert.match(html, /<span>Error<\/span>/)

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
  assert.match(switchBtn.title || '', /Plugin failed to load/)

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

test('resolvePluginIcon：纯属性驱动零硬编码推测——自声明 icon 优先，未提供统一回退默认占位（puzzle）', { timeout: 60_000 }, () => {
  assert.equal(DEFAULT_PLUGIN_ICON, 'puzzle')

  // 1. 显式提供自定义矢量图标名称（优先使用插件自己定义的 icon）
  assert.equal(resolvePluginIcon({ icon: 'workflow' }), 'workflow')
  assert.equal(resolvePluginIcon({ icon: 'zap' }), 'zap')
  assert.equal(resolvePluginIcon({ icon: 'globe' }), 'globe')
  assert.equal(resolvePluginIcon({ icon: ' sparkles ' }), 'sparkles')

  // 2. 未声明 icon 时彻底杜绝任何 ID 字符串猜测，统一使用默认图标占位
  assert.equal(resolvePluginIcon({}), 'puzzle')
  assert.equal(resolvePluginIcon({ icon: undefined }), 'puzzle')
  assert.equal(resolvePluginIcon({ icon: '' }), 'puzzle')
  assert.equal(resolvePluginIcon({ icon: '   ' }), 'puzzle')
  assert.equal(resolvePluginIcon(null), 'puzzle')
  assert.equal(resolvePluginIcon(undefined), 'puzzle')
})

test('PluginCard：完全不渲染卡片图标容器，名称与 ID 靠左对齐', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(PluginCard, {
      plugin: makePlugin({ id: 'test:no-icon', name: '无图标插件' }),
      selected: false,
      onSelect: () => {},
      onToggle: () => {},
    }),
  )
  assert.doesNotMatch(html, /plugin-card-icon-wrap/)
  assert.match(html, /无图标插件/)
  assert.match(html, /test:no-icon/)
})

// ---------------------------------------------------------------------------
// 3. LocalizedText 显示元数据：name/description 按 store 权威 locale 解析
// ---------------------------------------------------------------------------

test('getPluginDescription：LocalizedText 地图按 locale 解析，纯字符串透传，未声明回退能力透视', { timeout: 60_000 }, () => {
  const localized = makePlugin({
    name: { en: 'Workflow Engine', 'zh-CN': '工作流引擎' },
    description: { en: 'Orchestrates sub-agents.', 'zh-CN': '编排子代理执行任务。' },
    tools: ['subagent'],
    actions: [],
    hooks: [],
  })
  assert.equal(getPluginDescription(localized, 'zh-CN'), '编排子代理执行任务。')
  assert.equal(getPluginDescription(localized, 'en'), 'Orchestrates sub-agents.')
  // 地图缺当前语言键时回落 en（协议 resolveLocalizedText 语义）
  assert.equal(getPluginDescription(makePlugin({ description: { en: 'English only.' } }), 'zh-CN'), 'English only.')
  // 纯字符串描述（向后兼容）在任意 locale 下原样返回
  assert.equal(getPluginDescription(makePlugin({ description: '纯字符串描述' }), 'zh-CN'), '纯字符串描述')
  // 未声明描述回退能力透视文案（保持既有行为）
  assert.match(
    getPluginDescription(
      makePlugin({ description: undefined, tools: ['subagent'], actions: [], hooks: [] }),
      'en',
    ),
    /Provides 1 tools capabilities\./,
  )
})

test('PluginCard：插件名与描述按 store locale 解析，切换 en -> zh-CN 即时重渲染', { timeout: 60_000 }, () => {
  const plugin = makePlugin({
    id: 'community:glossary',
    name: { en: 'Glossary', 'zh-CN': '术语表' },
    description: { en: 'Bilingual glossary cards.', 'zh-CN': '双语术语卡片。' },
  })

  let committedLocale: 'en' | 'zh-CN' = 'en'
  function LocaleHarness(): React.JSX.Element {
    const [locale, setLocale] = React.useState<'en' | 'zh-CN'>('en')
    committedLocale = locale
    const store = React.useMemo(
      () => makeTestStore({ locale, setLocale: (next) => setLocale(next) }),
      [locale],
    )
    return e(
      HelmStoreContext.Provider,
      { value: store },
      e(PluginCard, { plugin, selected: false, onSelect: () => {}, onToggle: () => {} }),
      e('button', { type: 'button', onClick: () => setLocale(locale === 'en' ? 'zh-CN' : 'en') }, 'switch-locale'),
    )
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  try {
    act(() => {
      root.render(e(LocaleHarness))
    })
    assert.match(container.textContent, /Glossary/)
    assert.match(container.textContent, /Bilingual glossary cards\./)
    assert.ok(!container.textContent!.includes('术语表'), 'en 下不得渲染 zh-CN 文案')

    const switchBtn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'switch-locale',
    ) as HTMLButtonElement
    act(() => {
      switchBtn.click()
    })
    assert.equal(committedLocale, 'zh-CN')
    assert.match(container.textContent, /术语表/)
    assert.match(container.textContent, /双语术语卡片。/)
    assert.ok(!container.textContent!.includes('Glossary'), 'zh-CN 下不得残留 en 文案')

    act(() => {
      switchBtn.click()
    })
    assert.equal(committedLocale, 'en')
    assert.match(container.textContent, /Glossary/, '切回 en 立即恢复英文展示名')
  } finally {
    act(() => {
      root.unmount()
    })
    container.remove()
  }
})

test('plugin-card-model & PluginCard：en / zh-CN 双语描述、故障阶段标签与卡片 UI 切换', { timeout: 60_000 }, async () => {
  const en = createWebTranslator('en')
  const zh = createWebTranslator('zh-CN')

  const capabilityOnly = makePlugin({
    description: undefined,
    tools: ['t1', 't2'],
    actions: ['a1'],
    hooks: [],
  })
  assert.equal(getPluginDescription(capabilityOnly, 'en', en), 'Provides 2 tools, 1 actions capabilities.')
  assert.equal(getPluginDescription(capabilityOnly, 'zh-CN', zh), '提供 2 个工具、1 个动作能力支持。')

  const emptyPlugin = makePlugin({ description: undefined, tools: [], actions: [], hooks: [] })
  assert.equal(getPluginDescription(emptyPlugin, 'en', en), 'System extension plugin component.')
  assert.equal(getPluginDescription(emptyPlugin, 'zh-CN', zh), '系统扩展插件组件。')

  assert.equal(pluginErrorStageLabel('load', en), 'Module loading (load)')
  assert.equal(pluginErrorStageLabel('load', zh), '模块加载（load）')
  assert.equal(pluginErrorStageLabel('other', zh), '未知阶段')

  const plugin = makePlugin({
    id: 'community:glossary',
    name: { en: 'Glossary', 'zh-CN': '术语表' },
    description: undefined,
    locked: true,
    enabled: false,
    status: 'failed',
    error: { code: 'plugin_enable_failed', message: 'boom', stage: 'enable' },
    tools: ['lookup'],
    actions: [],
    hooks: [],
  })

  const zhStore = makeTestStore({ locale: 'zh-CN' })
  const zhHtml = renderToString(
    e(HelmStoreContext.Provider, { value: zhStore },
      e(PluginCard, { plugin, selected: false, onSelect: () => {}, onToggle: () => {} }),
    ),
  )
  assert.match(zhHtml, /术语表/)
  assert.match(zhHtml, /常驻/)
  assert.match(zhHtml, /异常/)
  assert.match(zhHtml, /提供 1 个工具能力支持。/)
  assert.match(zhHtml, /常驻插件不可停用/)
  assert.doesNotMatch(zhHtml, /<span>Resident<\/span>/)
  assert.doesNotMatch(zhHtml, /<span>Error<\/span>/)
})
