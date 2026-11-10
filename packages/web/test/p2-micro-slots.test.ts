/**
 * P2 界面增强测试：
 * 1. timeline.renderer / tool.view 的 priority 降序稳定裁决（replaceRow 语义不变）；
 * 2. PluginDetailDrawer 同插件多 settings.panel 全量按 order 渲染；
 * 3. 三类微插槽（conversation.header.action / conversation.row.action /
 *    timeline.entry.action）宿主挂载渲染与 Action 触发闭环：
 *    - scope 按实际会话过滤、entry kinds/roles 过滤；
 *    - action-only 渲染标准图标按钮 / 菜单项（零 Emoji，lucide 图标）；
 *    - 调用 actionPluginId ?? pluginId，载荷实际上下文强制覆盖 spec.input；
 *    - invokePluginAction 第四参传实际 conversationId；
 *    - pending 禁重复提交、异常显式通知不吞；
 *    - 点击不冒泡（不切换会话 / 不干扰复制分叉）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type {
  UiActionSpec,
  ConversationSummary,
  PluginUiContribution,
  SettingsPanelSpec,
  } from '@helm/protocol'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import {
  buildMicroActionInput,
  isActionOnlyActionSpec,
  matchConversationActions,
  matchTimelineEntryActions,
  microActionPluginId,
  splitConversationHeaderActions,
} from '../src/conversation/action-model.js'
import {
  findToolView,
  humanItemEntryKind,
  matchTimelineRenderer,
  sortByPriorityDescStable,
} from '../src/conversation/timeline-model.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function conv(partial: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${partial.id}`,
    profileId: 'coder',
    tags: [],
    cwd: '/tmp',
    model: 'zhipu/glm-4.6',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: partial.id * 1000,
    updatedAt: partial.id * 1000,
    ...partial,
  }
}

const workerConv = conv({ id: 20, tags: ['worker'], ownedBy: 'bot' })
const humanConv = conv({ id: 10 })

function entry(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return { id, kind, ...extra } as Parameters<typeof matchTimelineRenderer>[0]
}

// ---------------------------------------------------------------------------
// 1. priority 降序稳定裁决
// ---------------------------------------------------------------------------

test('sortByPriorityDescStable：priority 降序，同优先级保持贡献顺序', { timeout: 60_000 }, () => {
  const items = [
    { pluginId: 'a', spec: { id: 'a1', priority: 0 } },
    { pluginId: 'b', spec: { id: 'b1', priority: 10 } },
    { pluginId: 'c', spec: { id: 'c1' } }, // 缺省 0
    { pluginId: 'd', spec: { id: 'd1', priority: 10 } },
    { pluginId: 'e', spec: { id: 'e1', priority: -5 } },
  ]
  const sorted = sortByPriorityDescStable(items)
  assert.deepEqual(
    sorted.map((i) => i.pluginId),
    ['b', 'd', 'a', 'c', 'e'],
  )
  // 原数组不被修改
  assert.deepEqual(
    items.map((i) => i.pluginId),
    ['a', 'b', 'c', 'd', 'e'],
  )
})

test('findToolView：priority 高者胜，同优先级先注册先命中（T6）', { timeout: 60_000 }, () => {
  const views = [
    { pluginId: 'plugin-a', spec: { id: 'va', toolNames: ['bash'], priority: 0 } },
    { pluginId: 'plugin-b', spec: { id: 'vb', toolNames: ['bash'], priority: 10 } },
  ]
  assert.equal(findToolView('bash', views)?.pluginId, 'plugin-b')
  // 停用 plugin-b（列表移除）后自动回退命中 plugin-a：纯函数按传入列表裁决
  const withoutB = views.filter((v) => v.pluginId !== 'plugin-b')
  assert.equal(findToolView('bash', withoutB)?.pluginId, 'plugin-a')
  // 同优先级：先注册先命中
  const samePriority = [
    { pluginId: 'first', spec: { id: 'f', toolNames: ['bash'] } },
    { pluginId: 'second', spec: { id: 's', toolNames: ['bash'], priority: 0 } },
  ]
  assert.equal(findToolView('bash', samePriority)?.pluginId, 'first')
  assert.equal(findToolView('read', views), undefined)
})

test('findToolView：replaceRow 语义随命中 spec 透传，匹配层不做干预', { timeout: 60_000 }, () => {
  const views = [
    { pluginId: 'inline', spec: { id: 'v1', toolNames: ['bash'], priority: 0, replaceRow: true } },
    { pluginId: 'wrap', spec: { id: 'v2', toolNames: ['bash'], priority: -1 } },
  ]
  const hit = findToolView('bash', views)
  assert.equal(hit?.pluginId, 'inline')
  assert.equal(hit?.spec.replaceRow, true)
})

test('matchTimelineRenderer：priority 降序 + kinds/matchMeta 组合裁决', { timeout: 60_000 }, () => {
  const renderers = [
    { pluginId: 'low', spec: { id: 'r0', matchMeta: { renderer: 'x' }, priority: 0 } },
    { pluginId: 'high', spec: { id: 'r1', matchMeta: { renderer: 'x' }, priority: 5 } },
  ]
  assert.equal(
    matchTimelineRenderer(entry('1', 'helm.input', { data: { meta: { renderer: 'x' } } }), renderers)?.pluginId,
    'high',
  )
  // 高优先级插件 kinds 不匹配时不接管，回退低优先级命中
  const narrowed = [
    { pluginId: 'low', spec: { id: 'r0', matchMeta: { renderer: 'x' }, priority: 0 } },
    { pluginId: 'high', spec: { id: 'r1', kinds: ['pi.user'], matchMeta: { renderer: 'x' }, priority: 5 } },
  ]
  assert.equal(
    matchTimelineRenderer(entry('2', 'helm.input', { data: { meta: { renderer: 'x' } } }), narrowed)?.pluginId,
    'low',
  )
  // 未命中任何 renderer
  assert.equal(matchTimelineRenderer(entry('3', 'helm.input', { data: { text: '普通' } }), renderers), undefined)
})

// ---------------------------------------------------------------------------
// 2. action-model 纯函数
// ---------------------------------------------------------------------------

test('matchConversationActions：按 scope 与执行轨过滤，无会话上下文返回空', { timeout: 60_000 }, () => {
  const actions = [
    { pluginId: 'p1', target: 'conversation:header', spec: { id: 'a1', label: '归档 Worker', actionId: 'archive', scope: { tags: ['worker'] } } },
    { pluginId: 'p2', target: 'conversation:header', spec: { id: 'a2', label: '全局动作', actionId: 'ping' } },
    { pluginId: 'p3', target: 'conversation:header', spec: { id: 'a3', label: '无执行轨', scope: { tags: ['worker'] } } },
  ] as Array<{ pluginId: string; target: 'conversation:header'; spec: UiActionSpec }>
  const matchedWorker = matchConversationActions(actions, 'conversation:header', workerConv)
  assert.deepEqual(matchedWorker.map((a) => a.spec.id), ['a1', 'a2'])
  const matchedHuman = matchConversationActions(actions, 'conversation:header', humanConv)
  assert.deepEqual(matchedHuman.map((a) => a.spec.id), ['a2'])
  assert.deepEqual(matchConversationActions(actions, 'conversation:header', undefined), [])
})

test('splitConversationHeaderActions：toolbar 直出、menu（缺省）收纳', { timeout: 60_000 }, () => {
  const actions = [
    { pluginId: 'p1', target: 'conversation:header', spec: { id: 't1', label: '工具栏', actionId: 'x', placement: 'toolbar' } },
    { pluginId: 'p2', target: 'conversation:header', spec: { id: 'm1', label: '菜单项', actionId: 'y' } },
    { pluginId: 'p3', target: 'conversation:header', spec: { id: 'm2', label: '显式菜单', actionId: 'z', placement: 'menu' } },
  ] as Array<{ pluginId: string; target: 'conversation:header'; spec: UiActionSpec }>
  const { toolbar, menu } = splitConversationHeaderActions(actions)
  assert.deepEqual(toolbar.map((a) => a.spec.id), ['t1'])
  assert.deepEqual(menu.map((a) => a.spec.id), ['m1', 'm2'])
})

test('matchTimelineEntryActions：kinds / roles 过滤正确（T7 语义）', { timeout: 60_000 }, () => {
  const actions = [
    { pluginId: 'p1', target: 'timeline:entry', spec: { id: 'e1', label: '仅用户消息', actionId: 'a', roles: ['user'] } },
    { pluginId: 'p2', target: 'timeline:entry', spec: { id: 'e2', label: '仅助手消息', actionId: 'a', roles: ['assistant'] } },
    { pluginId: 'p3', target: 'timeline:entry', spec: { id: 'e3', label: '仅 helm.input kind', actionId: 'a', kinds: ['helm.input'] } },
    { pluginId: 'p4', target: 'timeline:entry', spec: { id: 'e4', label: '任意条目', actionId: 'a' } },
    { pluginId: 'p5', target: 'timeline:entry', spec: { id: 'e5', label: 'scope 过滤', actionId: 'a', scope: { tags: ['worker'] } } },
  ] as Array<{ pluginId: string; target: 'timeline:entry'; spec: UiActionSpec }>

  // 用户文本消息（helm.input，role=user）
  const userMsg = matchTimelineEntryActions(actions, humanConv, { kind: 'helm.input', role: 'user' })
  assert.deepEqual(userMsg.map((a) => a.spec.id), ['e1', 'e3', 'e4'])
  // 助手消息
  const aiMsg = matchTimelineEntryActions(actions, humanConv, { kind: 'pi.assistant', role: 'assistant' })
  assert.deepEqual(aiMsg.map((a) => a.spec.id), ['e2', 'e4'])
  // 兜底 pi.user kind 不命中 e3
  const fallbackUser = matchTimelineEntryActions(actions, humanConv, { kind: 'pi.user', role: 'user' })
  assert.deepEqual(fallbackUser.map((a) => a.spec.id), ['e1', 'e4'])
  // roles 声明后无角色条目不命中
  const noRole = matchTimelineEntryActions(actions, humanConv, { kind: 'pi.reset' })
  assert.deepEqual(noRole.map((a) => a.spec.id), ['e4'])
  // scope 未命中（humanConv 无 worker tag）
  const scoped = matchTimelineEntryActions(actions, workerConv, { kind: 'helm.input', role: 'user' })
  assert.deepEqual(scoped.map((a) => a.spec.id), ['e1', 'e3', 'e4', 'e5'])
  assert.deepEqual(matchTimelineEntryActions(actions, undefined, { kind: 'pi.user' }), [])
})

test('buildMicroActionInput：实际上下文强制覆盖 spec.input 同名字段', { timeout: 60_000 }, () => {
  // spec.input 伪造 conversationId / entryId：一律被实际上下文覆盖
  const input = buildMicroActionInput(
    { input: { conversationId: 999, entryId: 'forged', extra: 'keep' } },
    { conversationId: 42, entryId: 'real-entry' },
  )
  assert.equal(input.conversationId, 42)
  assert.equal(input.entryId, 'real-entry')
  assert.equal(input.extra, 'keep')
  // 无 entryId 上下文（会话级动作）：载荷不含 entryId，spec.input 伪造值同样被剔除
  const convOnly = buildMicroActionInput({ input: { entryId: 'forged' } }, { conversationId: 42 })
  assert.equal('entryId' in convOnly, false)
  assert.equal(convOnly.conversationId, 42)
  // 无 spec.input：仍注入实际上下文
  assert.deepEqual(buildMicroActionInput({}, { conversationId: 7 }), { conversationId: 7 })
})

test('microActionPluginId：actionPluginId 覆写，缺省贡献插件自身', { timeout: 60_000 }, () => {
  assert.equal(microActionPluginId({ actionPluginId: 'other' }, 'contributor'), 'other')
  assert.equal(microActionPluginId({}, 'contributor'), 'contributor')
})

test('isActionOnlyActionSpec：仅 actionId 且无 client', { timeout: 60_000 }, () => {
  assert.equal(isActionOnlyActionSpec({ id: 'a', target: 'conversation:header', label: 'x', actionId: 'act' }), true)
  assert.equal(isActionOnlyActionSpec({ id: 'a', target: 'conversation:header', label: 'x', actionId: 'act', client: { module: 'index.tsx', export: 'C' } }), false)
})

test('humanItemEntryKind：helm.input 归一化优先，兜底 pi.user', { timeout: 60_000 }, () => {
  assert.equal(humanItemEntryKind({ kind: 'human', key: 'k', entryId: '1', text: 't', origin: 'human', fallback: false }), 'helm.input')
  assert.equal(humanItemEntryKind({ kind: 'human', key: 'k', entryId: '1', text: 't', origin: 'human', fallback: true }), 'pi.user')
})

// ---------------------------------------------------------------------------
// 3. PluginDetailDrawer：同插件多 settings.panel 全量按 order 渲染
// ---------------------------------------------------------------------------

function pluginDetailDrawerSource(): string {
  return readFileSync(new URL('../src/plugins/PluginDetailDrawer.tsx', import.meta.url), 'utf8')
}

test('PluginDetailDrawer 源码契约：filter 全量渲染同插件面板，不再 find 首个', { timeout: 60_000 }, () => {
  const src = pluginDetailDrawerSource()
  assert.match(src, /filter\(\(p\) => p\.pluginId === plugin\?\.id\)/)
  assert.doesNotMatch(src, /settingsPanels\.find\(/)
  // 逐面板独立 PluginUiView 挂载（key 稳定）
  assert.match(src, /settingsPanels\.map\(\(panel\) =>/)
  assert.match(src, /key=\{`\$\{panel\.pluginId\}\/\$\{panel\.spec\.id\}`\}/)
})

test('groupedUi.settingsPanels 排序：order 升序稳定，缺省 100；同插件多面板全量保留', { timeout: 60_000 }, () => {
  const contributions: PluginUiContribution[] = [
    { pluginId: 'plugin-c', surface: 'settings.panel', spec: { id: 'p2', label: '第二面板', order: 20 } satisfies SettingsPanelSpec },
    { pluginId: 'plugin-c', surface: 'settings.panel', spec: { id: 'p1', label: '第一面板', order: 10 } satisfies SettingsPanelSpec },
    { pluginId: 'plugin-c', surface: 'settings.panel', spec: { id: 'p0', label: '缺省顺序' } satisfies SettingsPanelSpec },
    { pluginId: 'plugin-d', surface: 'settings.panel', spec: { id: 'other', label: '其他插件' } satisfies SettingsPanelSpec },
  ]
  const grouped = groupUiContributions(contributions)
  const pluginCPanels = grouped.settingsPanels.filter((p) => p.pluginId === 'plugin-c')
  assert.deepEqual(pluginCPanels.map((p) => p.spec.id), ['p1', 'p2', 'p0'])
  // 消费方 filter 后不丢面板
  assert.equal(grouped.settingsPanels.filter((p) => p.pluginId === 'plugin-d').length, 1)
})

// ---------------------------------------------------------------------------
// 4. PluginMicroAction 渲染与触发闭环（真实 DOM 交互）
// ---------------------------------------------------------------------------

async function setupMicroActionDom() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  try {
    GlobalRegistrator.register()
  } catch {
    // 同文件多 test 复用：已注册则跳过（happy-dom 全局单例）
  }
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { HelmStoreContext } = await import('../src/lib/store-context.js')
  const { makeTestStore } = await import('./helpers/store.js')
  const { PluginMicroAction } = await import('../src/ui/PluginMicroAction.js')
  return { act, createRoot, HelmStoreContext, makeTestStore, PluginMicroAction }
}

test('PluginMicroAction action-only：渲染图标按钮，点击调用 actionPluginId 并强制实际上下文载荷', { timeout: 60_000 }, async () => {
  const { act, createRoot, HelmStoreContext, makeTestStore, PluginMicroAction } = await setupMicroActionDom()
  const calls: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }> = []
  const notices: Array<{ level: string; title: string }> = []
  const store = makeTestStore({
    invokePluginAction: async (pluginId, actionId, input, conversationId) => {
      calls.push({ pluginId, actionId, input, conversationId })
      return { ok: true }
    },
    pushNotice: (n) => notices.push({ level: n.level, title: n.title }),
  })
  const action = {
    pluginId: 'contributor',
    spec: {
      target: 'conversation:header',
      id: 'archive',
      label: '归档',
      icon: 'archive',
      actionId: 'archive_worker',
      actionPluginId: 'builtin:superagent',
      input: { conversationId: 999, reason: 'done' },
    } satisfies UiActionSpec,
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        e(
          HelmStoreContext.Provider,
          { value: store },
          e(PluginMicroAction, { action, variant: 'toolbar', conversationId: 42 }),
        ),
      )
    })
    const btn = host.querySelector('button') as HTMLButtonElement
    assert.ok(btn !== null)
    assert.match(btn.getAttribute('title')!, /归档/)
    // 点击不冒泡：外层 React onClick（宿主行点击切换会话等）不收到事件
    let outerClicked = false
    await act(async () => {
      root.render(
        e(
          HelmStoreContext.Provider,
          { value: store },
          e('div', { onClick: () => { outerClicked = true } },
            e(PluginMicroAction, { action, variant: 'toolbar', conversationId: 42 })),
        ),
      )
    })
    const btn2 = host.querySelector('button') as HTMLButtonElement
    await act(async () => { btn2.click() })
    assert.equal(outerClicked, false, '点击不得冒泡触发宿主容器 React onClick')
    // 调用寻址 actionPluginId ?? pluginId；实际上下文覆盖伪造载荷；第四参传实际会话
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.pluginId, 'builtin:superagent')
    assert.equal(calls[0]!.actionId, 'archive_worker')
    assert.deepEqual(calls[0]!.input, { reason: 'done', conversationId: 42 })
    assert.equal(calls[0]!.conversationId, 42)
    assert.deepEqual(notices.map((n) => n.level), ['info'])
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('PluginMicroAction：pending 期间禁用防重复提交，失败显式通知不吞', { timeout: 60_000 }, async () => {
  const { act, createRoot, HelmStoreContext, makeTestStore, PluginMicroAction } = await setupMicroActionDom()
  let release: (() => void) | undefined
  const calls: number[] = []
  const notices: Array<{ level: string; title: string; body?: string }> = []
  const store = makeTestStore({
    invokePluginAction: async () => {
      calls.push(calls.length)
      await new Promise<void>((resolve) => { release = resolve })
      throw new Error('后端拒绝：worker 仍在运行')
    },
    pushNotice: (n) => notices.push({ level: n.level, title: n.title, body: n.body }),
  })
  const action = {
    pluginId: 'p',
    spec: { target: 'timeline:entry', id: 'kill', label: '中止', actionId: 'kill_worker' } satisfies UiActionSpec,
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(e(HelmStoreContext.Provider, { value: store },
        e(PluginMicroAction, { action, variant: 'hover', conversationId: 20, entryId: '33' })))
    })
    const btn = host.querySelector('button') as HTMLButtonElement
    await act(async () => { btn.click() })
    // pending：按钮禁用，重复点击不再发起
    assert.equal(btn.disabled, true)
    await act(async () => { btn.click() })
    assert.equal(calls.length, 1)
    // 释放：失败通知必须携带错误信息（不静默吞）
    await act(async () => { release?.() })
    assert.equal(calls.length, 1)
    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.level, 'error')
    assert.match(notices[0]!.title, /执行失败：中止/)
    assert.match(notices[0]!.body!, /后端拒绝/)
    // 失败后恢复可点击
    assert.equal(btn.disabled, false)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('PluginMicroAction menu 形态：popover-item 菜单项 + onInvoked 关闭菜单回调', { timeout: 60_000 }, async () => {
  const { act, createRoot, HelmStoreContext, makeTestStore, PluginMicroAction } = await setupMicroActionDom()
  let invoked = 0
  const store = makeTestStore({ invokePluginAction: async () => undefined })
  const action = {
    pluginId: 'p',
    spec: { target: 'conversation:header', id: 'm', label: '菜单动作', actionId: 'act' } satisfies UiActionSpec,
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(e(HelmStoreContext.Provider, { value: store },
        e(PluginMicroAction, { action, variant: 'menu', conversationId: 1, onInvoked: () => { invoked++ } })))
    })
    const item = host.querySelector('button.popover-item') as HTMLButtonElement
    assert.ok(item !== null, 'menu 形态渲染 popover-item 菜单项')
    await act(async () => { item.click() })
    assert.equal(invoked, 1, '点击后触发 onInvoked（关闭所在菜单）')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('PluginMicroAction 声明 client：内联 PluginUiView 渲染组件内容（不渲染按钮）', { timeout: 60_000 }, async () => {
  const { act, createRoot, HelmStoreContext, makeTestStore, PluginMicroAction } = await setupMicroActionDom()
  const { seedPluginClientModule } = await import('../src/lib/plugin-client.js')
  seedPluginClientModule('p', 'card.tsx', { CardAction: () => e('div', null, '面板内容 XYZ') })
  // 相对 URL fetch 需要 location 上下文：指向 127.0.0.1（请求本身因 seed 缓存
  // 同步命中而不必成功；此 stub 仅避免 Invalid URL 异常遮蔽真实断言）。
  const origFetch = globalThis.fetch
  // 返回同 contentHash（seeded）：loadPluginClientModule 命中 seed 缓存复用模块命名空间。
  globalThis.fetch = (async () =>
    new Response('// seeded cache hit', { status: 200, headers: { 'x-helm-client-hash': 'seeded' } })) as typeof fetch
  const store = makeTestStore()
  const action = {
    pluginId: 'p',
    target: 'conversation:header',
    spec: {
      target: 'conversation:header',
      id: 'card',
      label: '卡片动作',
      actionId: 'unused',
      client: { module: 'card.tsx', export: 'CardAction' },
    } satisfies UiActionSpec,
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const element = e(HelmStoreContext.Provider, { value: store },
    e(PluginMicroAction, { action, variant: 'toolbar', conversationId: 1, slotProps: { conversationId: 1 } }))
  const first = createRoot(host)
  let root = first
  try {
    // 首挂触发异步加载（测试环境 fetch 不可用，失败态不缓存）；重挂新实例
    // 后同步命中 seed 缓存（getCachedClientComponent 快路径）。
    await act(async () => { first.render(element) })
    act(() => { first.unmount() })
    root = createRoot(host)
    await act(async () => { root.render(element) })
    assert.match(host.textContent!, /面板内容 XYZ/)
    assert.equal(host.querySelector('button'), null, '声明 client 轨时不渲染标准按钮')
  } finally {
    act(() => root.unmount())
    host.remove()
    globalThis.fetch = origFetch
  }
})

// ---------------------------------------------------------------------------
// 5. 宿主挂载 SSR：三类微插槽只在该出现的会话/条目上渲染（T7）
// ---------------------------------------------------------------------------

async function loadHostComponents() {
  const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')
  const { ConversationRowActionsMenu } = await import('../src/ui/ConversationRowActionsMenu.js')
  return { ConversationTimeline, ConversationRowActionsMenu }
}

const headerActionContribution = (spec: Omit<UiActionSpec, 'target'>): PluginUiContribution => ({
  pluginId: 'builtin:superagent',
  surface: 'conversation.header.action',
  spec: { ...spec, target: 'conversation:header' },
})

test('ConversationTimeline：timeline.entry.action 仅在匹配 kind/role 的消息 hover 栏渲染（T7）', { timeout: 60_000 }, async () => {
  const { ConversationTimeline } = await loadHostComponents()
  const { makeTestStore } = await import('./helpers/store.js')
  const { HelmStoreContext } = await import('../src/lib/store-context.js')
  const contributions: PluginUiContribution[] = [
    { pluginId: 'builtin:superagent', surface: 'timeline.entry.action', spec: { target: 'timeline:entry',  id: 'user-only', label: '引用用户消息', actionId: 'quote', roles: ['user'] } satisfies UiActionSpec },
    { pluginId: 'builtin:superagent', surface: 'timeline.entry.action', spec: { target: 'timeline:entry',  id: 'ai-only', label: '引用回复', actionId: 'cite', roles: ['assistant'] } satisfies UiActionSpec },
    { pluginId: 'builtin:superagent', surface: 'timeline.entry.action', spec: { target: 'timeline:entry', id: 'scoped', label: '仅Worker', actionId: 'w', scope: { tags: ['worker'] } } satisfies UiActionSpec },
  ]
  const store = makeTestStore({
    conversations: [humanConv],
    groupedUi: groupUiContributions(contributions),
  })
  const entries = [
    { id: '1', kind: 'helm.input', data: { text: '帮我检查', origin: 'human' } },
    { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '检查完成' }] }] },
  ]
  const html = renderToString(
    e(
      HelmStoreContext.Provider,
      { value: store },
      e(ConversationTimeline, { conversation: humanConv, detailEntries: entries, onRequestEdit: () => {} }),
    ),
  )
  // 用户消息命中 user-only；助手回合命中 ai-only；scoped 未命中（humanConv 无 worker tag）
  assert.match(html, /引用用户消息/)
  assert.match(html, /引用回复/)
  assert.doesNotMatch(html, /仅Worker/)
  // 宿主原有复制 / 分叉能力不受干扰
  assert.match(html, /从此处分叉新会话/)
})

test('ConversationRowActionsMenu：仅在该会话 scope 命中时渲染菜单入口', { timeout: 60_000 }, async () => {
  const { ConversationRowActionsMenu } = await loadHostComponents()
  const { makeTestStore } = await import('./helpers/store.js')
  const { HelmStoreContext } = await import('../src/lib/store-context.js')
  const contributions: PluginUiContribution[] = [
    { pluginId: 'p', surface: 'conversation.row.action', spec: { id: 'row', label: '归档该会话', actionId: 'archive', scope: { tags: ['worker'] } } },
  ]
  const scopedStore = makeTestStore({ conversations: [workerConv], groupedUi: groupUiContributions(contributions) })
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: scopedStore },
      e(ConversationRowActionsMenu, { conversation: workerConv })),
  )
  assert.match(html, /插件会话操作/)

  const humanStore = makeTestStore({ conversations: [humanConv], groupedUi: groupUiContributions(contributions) })
  const emptyHtml = renderToString(
    e(HelmStoreContext.Provider, { value: humanStore },
      e(ConversationRowActionsMenu, { conversation: humanConv })),
  )
  assert.equal(emptyHtml, '', 'scope 未命中时零渲染、零视觉残留')
})

test('ConversationPane 源码契约：顶栏消费 conversation.header.action（toolbar 直出 + menu 收纳）', { timeout: 60_000 }, () => {
  const src = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')
  assert.match(src, /matchConversationActions\(store\.groupedUi\.uiActions, 'conversation:header', conversation\)/)
  assert.match(src, /splitConversationHeaderActions\(headerActions\)/)
  assert.match(src, /variant="toolbar"/)
  assert.match(src, /variant="menu"/)
})

test('ConversationPane SSR：placement=toolbar 的插件动作直出顶栏，menu 动作不占顶栏（点开菜单才渲染）', { timeout: 60_000 }, async () => {
  const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
  const { makeTestStore } = await import('./helpers/store.js')
  const { HelmStoreContext } = await import('../src/lib/store-context.js')
  const contributions: PluginUiContribution[] = [
    { pluginId: 'p1', surface: 'conversation.header.action', spec: { target: 'conversation:header',  id: 'tb', label: '巡查', icon: 'activity', actionId: 'patrol', placement: 'toolbar' } satisfies UiActionSpec },
    { pluginId: 'p2', surface: 'conversation.header.action', spec: { target: 'conversation:header',  id: 'mn', label: '归档汇报', actionId: 'archive', placement: 'menu' } satisfies UiActionSpec },
    { pluginId: 'p3', surface: 'conversation.header.action', spec: { target: 'conversation:header', id: 'no', label: '别处会话', actionId: 'x', placement: 'toolbar', scope: { tags: ['worker'] } } satisfies UiActionSpec },
  ]
  const store = makeTestStore({
    conversations: [humanConv],
    conversationDetails: { 10: { ...humanConv, entries: [] } },
    groupedUi: groupUiContributions(contributions),
  })
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store },
      e(ConversationPane, { conversationId: 10 })),
  )
  // toolbar 动作直出顶栏（含标签与图标按钮）
  assert.match(html, /巡查/)
  // menu 动作收纳进「更多操作」下拉：SSR 静态快照不展开菜单，不占顶栏
  assert.doesNotMatch(html, /归档汇报/)
  // scope 未命中的 toolbar 动作不渲染
  assert.doesNotMatch(html, /别处会话/)
  // 宿主顶栏原有能力不受影响
  assert.match(html, /更多会话操作/)
})

test('Sidebar 源码契约：会话行消费 conversation.row.action，不干扰宿主行点击', { timeout: 60_000 }, () => {
  const src = readFileSync(new URL('../src/shell/Sidebar.tsx', import.meta.url), 'utf8')
  // 两类会话行（Agent 二级行 + 插件 section 行）均挂载菜单
  const matches = src.match(/<ConversationRowActionsMenu conversation=\{conv\} \/>/g) ?? []
  assert.ok(matches.length >= 2, `至少 Agent 二级行与插件 section 行挂载菜单，实际 ${matches.length}`)
})

test('groupedUi 微插槽分组：surface 正确归组并按 order 排序', { timeout: 60_000 }, () => {
  const contributions: PluginUiContribution[] = [
    headerActionContribution({ id: 'h2', label: '二', actionId: 'a', order: 20 }),
    headerActionContribution({ id: 'h1', label: '一', actionId: 'a', order: 10 }),
    { pluginId: 'p', surface: 'conversation.row.action', spec: { target: 'conversation:row', id: 'r1', label: '行', actionId: 'a' } },
    { pluginId: 'p', surface: 'timeline.entry.action', spec: { target: 'timeline:entry', id: 't1', label: '条目', actionId: 'a' } },
  ]
  const grouped = groupUiContributions(contributions)
  const header = grouped.uiActions.filter((a) => a.target === 'conversation:header')
  const row = grouped.uiActions.filter((a) => a.target === 'conversation:row')
  const entry = grouped.uiActions.filter((a) => a.target === 'timeline:entry')
  assert.deepEqual(header.map((a) => a.spec.id), ['h1', 'h2'], 'header 按 order 升序')
  assert.deepEqual(row.map((a) => a.spec.id), ['r1'])
  assert.deepEqual(entry.map((a) => a.spec.id), ['t1'])
})
