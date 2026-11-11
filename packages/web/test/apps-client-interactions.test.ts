/**
 * builtin:apps 应用中心 client 组件测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * 覆盖 AppCenterScreen：应用合并规则（外部插件 + Screen，内置视图不混入）、
 * 分类 Tab / 关键字过滤、统计徽章、打开应用 / 分屏打开的导航调用与
 * setParams 深链回写、置顶元数据（catalog 文档）叠加、空态提示。
 * 数据经 stub 的 usePluginDoc / usePlugins 构造；导航经 spy ctx 断言真实调用。
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PluginClientContext as PluginClientContextType, ScreenProps } from '@helm/protocol'
import { PluginClientContext } from '../src/lib/plugin-client-context.js'
import { importBuiltinClientModule, mountSharedPluginNamespaces, setBuiltinClientStub } from './helpers/builtin-clients.js'

const e = React.createElement

GlobalRegistrator.register()
mountSharedPluginNamespaces()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
// 宿主共享 SDK（icons.tsx 等 .tsx 组件）经 tsx 运行时编译需要全局 React
;(globalThis as Record<string, unknown>).React = React

let AppCenterScreen: (p: ScreenProps) => React.ReactElement
let usePluginsResult: { plugins: Array<Record<string, unknown>>; screens: Array<{ pluginId: string; spec: Record<string, unknown> }> }
let setParamsCalls: Array<{ patch: Record<string, string | undefined> }>

before(async () => {
  const mod = await importBuiltinClientModule('builtin:apps')
  AppCenterScreen = mod['AppCenterScreen'] as (p: ScreenProps) => React.ReactElement
}, { timeout: 60_000 })

interface SpyCtx extends PluginClientContextType {
  screenCalls: string[]
  splitCalls: string[]
}

function makeSpyCtx(): SpyCtx {
  const screenCalls: string[] = []
  const splitCalls: string[] = []
  const base: PluginClientContextType = {
    pluginId: 'builtin:apps',
    callAction: async () => ({}),
    submitInput: async () => {},
    openScreen: (t) => {
      screenCalls.push(t)
    },
    openSplitScreen: (t) => {
      splitCalls.push(t)
    },
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: () => {},
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark',
  }
  return Object.assign(base, { screenCalls, splitCalls })
}

function stubStore(plugins: Array<Record<string, unknown>>, screens: Array<{ pluginId: string; spec: Record<string, unknown> }>, catalog?: unknown): void {
  usePluginsResult = { plugins, screens }
  setBuiltinClientStub({
    docs: catalog !== undefined ? { catalog } : {},
  })
  // 直接替换共享命名空间中的 usePlugins（编译产物持有该对象引用）
  const ns = (globalThis as Record<string, unknown>)['__helm_shared_plugin_client'] as Record<string, unknown>
  ns['usePlugins'] = () => usePluginsResult
}

function plugin(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    version: '1.0.0',
    locked: false,
    enabled: true,
    hooks: [],
    actions: [],
    tools: [],
    ...overrides,
  }
}

function screen(pluginId: string, screenId: string, label: string): { pluginId: string; spec: Record<string, unknown> } {
  return { pluginId, spec: { id: screenId, label, client: { module: 'index.tsx', export: 'Main' } } }
}

/** 可变参数容器：模拟宿主 setScreenParams → 状态更新 → 重新渲染链路。 */
function mutableScreenProps(initial: Record<string, string> = {}): { props: ScreenProps } {
  const params: Record<string, string> = { ...initial }
  const props: ScreenProps = {
    pluginId: 'builtin:apps',
    screenId: 'center',
    isSplit: false,
    get params() {
      return { ...params }
    },
    setParams: (patch) => {
      setParamsCalls.push({ patch })
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete params[key]
        else params[key] = value
      }
    },
  }
  return { props }
}

/** 静态参数（深链恢复断言用；不随 setParams 变化）。 */
function screenProps(params: Record<string, string> = {}): ScreenProps {
  return {
    pluginId: 'builtin:apps',
    screenId: 'center',
    isSplit: false,
    params,
    setParams: (patch) => {
      setParamsCalls.push({ patch })
    },
  }
}

/**
 * 挂载并返回（host/unmount/reRender）：reRender 以同一可变 params 容器重渲染，
 * 模拟宿主 setScreenParams 后的状态更新（组件唯一参数源是 props.params）。
 */
async function mount(
  ctx: PluginClientContextType,
  props: ScreenProps,
): Promise<{ host: HTMLElement; unmount: () => void; reRender: () => Promise<void> }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = () => {
    root.render(e(PluginClientContext.Provider, { value: ctx }, e(AppCenterScreen, props)))
  }
  await act(async () => {
    render()
  })
  return {
    host,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
    reRender: async () => {
      await act(async () => {
        render()
      })
    },
  }
}

/** 搜索输入受控回显（q 参数即唯一真相源；happy-dom 下编译产物 input 事件不达 React onChange，不驱动 DOM 输入）。 */

before(() => {
  setParamsCalls = []
})

test('应用合并：仅非 builtin 且有 Screen 的外部插件进入列表，统计徽章如实', { timeout: 60_000 }, async () => {
  stubStore(
    [
      plugin('todo-app', { name: '待办应用', description: '记账与待办' }),
      plugin('tracker-app', { name: '追踪应用', enabled: false }),
      plugin('community:plain', { name: '无视图插件' }),
      plugin('builtin:superagent', { name: 'SuperAgent' }),
    ],
    [screen('todo-app', 'main', '待办台'), screen('tracker-app', 'main', '看板'), screen('builtin:superagent', 'recall-graph', '图谱')],
  )
  const { host, unmount } = await mount(makeSpyCtx(), screenProps())
  assert.match(host.textContent ?? '', /共 2 个应用 · 1 个已就绪/)
  assert.equal(host.querySelectorAll('.app-card').length, 2)
  assert.ok(host.querySelector('[data-app-id="todo-app"]'))
  assert.ok(host.querySelector('[data-app-id="tracker-app"]'))
  assert.ok(!host.querySelector('[data-app-id="community:plain"]'))
  assert.ok(!host.querySelector('[data-app-id="builtin:superagent"]'))
  unmount()
})

test('打开应用与分屏打开：分别调用 ctx.openScreen / openSplitScreen（声明式目标字符串）', { timeout: 60_000 }, async () => {
  stubStore([plugin('todo-app', { name: '待办应用' })], [screen('todo-app', 'main', '待办台')])
  const ctx = makeSpyCtx()
  const { host, unmount } = await mount(ctx, screenProps())

  const openBtn = host.querySelector<HTMLButtonElement>('[data-app-id="todo-app"] .btn:not(.btn-icon-xs)')
  assert.ok(openBtn, '应存在「打开应用」按钮')
  await act(async () => {
    openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(ctx.screenCalls, ['screen:todo-app/main'], '打开应用走声明式目标字符串')

  const splitBtn = host.querySelector<HTMLButtonElement>('[data-app-id="todo-app"] .btn-icon-xs')
  assert.ok(splitBtn, '应存在分屏打开按钮')
  await act(async () => {
    splitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(ctx.splitCalls, ['screen:todo-app/main'])
  unmount()
})

test('停用应用：卡片标记 is-disabled，打开按钮不出现（无虚构视图）', { timeout: 60_000 }, async () => {
  // 停用但宿主仍返回其 Screen 贡献的场景（防御：按贡献渲染但打开入口要求 enabled）
  stubStore([plugin('tracker-app', { enabled: false })], [screen('tracker-app', 'main', '看板')])
  const { host, unmount } = await mount(makeSpyCtx(), screenProps())
  const card = host.querySelector('[data-app-id="tracker-app"]')
  assert.ok(card?.classList.contains('is-disabled'))
  const openBtn = Array.from(card?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('打开应用'))
  assert.equal(openBtn, undefined, '停用应用不得提供打开应用入口（提供插件中心启用）')
  unmount()
})

test('分类 Tab 与搜索过滤：点击药丸切换 Tab 并经 setParams 回写深链参数；q 参数过滤列表', { timeout: 60_000 }, async () => {
  stubStore(
    [
      plugin('todo-app', { name: '待办应用' }),
      plugin('tracker-app', { name: '追踪应用', enabled: false }),
    ],
    [screen('todo-app', 'main', '待办台'), screen('tracker-app', 'main', '看板')],
    { apps: { 'todo-app': { pluginId: 'todo-app', pinned: true } } },
  )
  setParamsCalls = []
  const { props } = mutableScreenProps()
  const { host, unmount, reRender } = await mount(makeSpyCtx(), props)
  assert.equal(host.querySelectorAll('.app-card').length, 2, '初始全部 Tab 展示两个应用')

  // 置顶 Tab：仅 catalog 登记 pinned 的应用（setParams 后模拟宿主重渲染）
  const pills = Array.from(host.querySelectorAll('.apps-category-pill'))
  const pinnedPill = pills.find((p) => p.textContent?.includes('已置顶'))
  assert.ok(pinnedPill)
  await act(async () => {
    pinnedPill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await reRender()
  assert.equal(host.querySelectorAll('.app-card').length, 1)
  assert.equal(host.querySelector('.app-card')?.getAttribute('data-app-id'), 'todo-app')
  assert.deepEqual(
    setParamsCalls.filter((c) => 'tab' in c.patch),
    [{ patch: { tab: 'pinned' } }],
    '切换 Tab 经 setParams 回写（all 归位删除键）',
  )

  // 搜索过滤经深链 q 参数驱动（宿主 setScreenParams 回写后重渲染；
  // happy-dom 下编译产物 input 事件不达 React onChange，不驱动 DOM 输入）
  const { host: host2, unmount: unmount2 } = await mount(makeSpyCtx(), screenProps({ q: '追踪' }))
  assert.equal(host2.querySelectorAll('.app-card').length, 1)
  assert.equal(host2.querySelector('.app-card')?.getAttribute('data-app-id'), 'tracker-app', 'q 参数过滤命中追踪应用')
  unmount2()

  unmount()
})

test('深链参数恢复：params.tab / params.q 初始即生效（sp.* 命名空间恢复）', { timeout: 60_000 }, async () => {
  stubStore(
    [plugin('todo-app', { name: '待办应用' }), plugin('tracker-app', { name: '追踪应用', enabled: false })],
    [screen('todo-app', 'main', '待办台'), screen('tracker-app', 'main', '看板')],
    { apps: { 'todo-app': { pluginId: 'todo-app', pinned: true, category: 'productivity' } } },
  )
  const { host, unmount } = await mount(makeSpyCtx(), screenProps({ tab: 'pinned', q: '待办' }))
  const active = host.querySelector('.apps-category-pill.is-active')
  assert.ok(active?.textContent?.includes('已置顶'), 'params.tab 恢复激活 Tab')
  assert.equal(host.querySelectorAll('.app-card').length, 1)
  assert.equal(host.querySelector('.app-card')?.getAttribute('data-app-id'), 'todo-app')
  const search = host.querySelector<HTMLInputElement>('.apps-search-box input')
  assert.equal(search?.value, '待办', 'params.q 恢复搜索词')
  unmount()
})

test('业务分类 Tab：category:* 参数过滤对应 catalog 分类应用', { timeout: 60_000 }, async () => {
  stubStore(
    [
      plugin('todo-app', { name: '待办应用' }),
      plugin('bill-app', { name: '账单看板' }),
    ],
    [screen('todo-app', 'main', '待办台'), screen('bill-app', 'main', '看板')],
    {
      apps: {
        'todo-app': { pluginId: 'todo-app', category: 'productivity' },
        'bill-app': { pluginId: 'bill-app', category: 'finance' },
      },
    },
  )
  // 未登记分类的应用归入 other；点击「效率工具」仅显示 productivity 应用
  const { props } = mutableScreenProps()
  const { host, unmount, reRender } = await mount(makeSpyCtx(), props)
  const pills = Array.from(host.querySelectorAll('.apps-category-pill'))
  const productivityPill = pills.find((p) => p.textContent?.includes('效率工具'))
  assert.ok(productivityPill, '应存在业务分类药丸')
  await act(async () => {
    productivityPill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await reRender()
  assert.equal(host.querySelectorAll('.app-card').length, 1)
  assert.equal(host.querySelector('.app-card')?.getAttribute('data-app-id'), 'todo-app')
  assert.ok(setParamsCalls.some((c) => c.patch['tab'] === 'category:productivity'), '分类 Tab 回写 category:<name> 参数')
  unmount()
})

test('空态：无任何应用时如实提示让 AI 创建，不编造数据', { timeout: 60_000 }, async () => {
  stubStore([plugin('builtin:superagent')], [screen('builtin:superagent', 'recall-graph', '图谱')])
  const { host, unmount } = await mount(makeSpyCtx(), screenProps())
  assert.match(host.textContent ?? '', /还没有全栈应用/)
  assert.match(host.textContent ?? '', /让 AI 生成/)
  assert.equal(host.querySelectorAll('.app-card').length, 0)
  unmount()
})

test('停用 catalog 应用：screens 为空仍显示停用卡片，提供插件中心启用入口，不虚构视图', { timeout: 60_000 }, async () => {
  const disabledApp = plugin('tracker-app', { name: '追踪应用', enabled: false })
  stubStore(
    [disabledApp],
    [], // 停用插件 Screen 贡献已被宿主移除（groupedUi 只含已启用插件）
    { apps: { 'tracker-app': { pluginId: 'tracker-app', pinned: true } } },
  )
  const ctx = makeSpyCtx()
  const { host, unmount } = await mount(ctx, screenProps())

  const card = host.querySelector('[data-app-id="tracker-app"]')
  assert.ok(card, 'catalog 登记的停用应用必须保留卡片（可重新启用）')
  assert.ok(card.classList.contains('is-disabled'))
  assert.match(card.textContent ?? '', /已停用/)
  assert.doesNotMatch(card.textContent ?? '', /打开应用|分屏打开/, '停用且无视图不得提供打开入口')

  const enableBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.includes('插件中心启用'))
  assert.ok(enableBtn, '应提供插件中心启用入口')
  await act(async () => {
    enableBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(ctx.screenCalls, ['plugins:tracker-app'], '启用入口以声明式 plugins:<id> 目标打开插件中心详情抽屉')
  unmount()
})

test('未登记 catalog 且无 Screen 的外部插件：不进入应用列表', { timeout: 60_000 }, async () => {
  stubStore([plugin('community:plain')], [])
  const { host, unmount } = await mount(makeSpyCtx(), screenProps())
  assert.equal(host.querySelectorAll('.app-card').length, 0)
  assert.match(host.textContent ?? '', /还没有全栈应用/)
  unmount()
})

test('渲染输出零 Emoji', { timeout: 60_000 }, async () => {
  stubStore([plugin('todo-app')], [screen('todo-app', 'main', '待办台')])
  const { host, unmount } = await mount(makeSpyCtx(), screenProps())
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u
  assert.doesNotMatch(host.textContent ?? '', emojiRegex)
  unmount()
})
