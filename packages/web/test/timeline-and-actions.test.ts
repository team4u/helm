/**
 * 时间线渲染裁决、真实 entry 锚点与三类微插槽行为测试（合并自 p2-entry-anchor + p2-micro-slots）：
 * 1. timeline.renderer / tool.view 的 priority 降序稳定裁决；
 * 2. PluginDetailDrawer 同插件多 settings.panel 全量按 order 渲染；
 * 3. 三类微插槽（conversation.header.action / conversation.row.action /
 *    timeline.entry.action）宿主挂载渲染与 Action 触发闭环；
 * 4. timeline.entry.action 真实 entry 锚点（非占位拼合、排除 tool-result/queued/live/rewind）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  PluginSummary,
  PluginUiContribution,
  SettingsPanelSpec,
  UiActionSpec,
} from '@helm/protocol'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()

const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')
const { groupUiContributions } = await import('../src/lib/types.js')
const {
  buildMicroActionInput,
  isActionOnlyActionSpec,
  matchConversationActions,
  matchTimelineEntryActions,
  microActionPluginId,
  splitConversationHeaderActions,
  timelineEntryActionContextOf,
} = await import('../src/conversation/action-model.js')
const {
  findToolView,
  humanItemEntryKind,
  matchTimelineRenderer,
  sortByPriorityDescStable,
} = await import('../src/conversation/timeline-model.js')
const { makeTestStore } = await import('./helpers/store.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { pluginsApi } = await import('../src/lib/api.js')

const e = React.createElement

// client 轨组件种子：渲染真实 entry 数据，供锚点断言。
seedPluginClientModule('p', 'entry-badge.tsx', {
  EntryBadge: (props: Record<string, unknown>) => {
    const item = (props['entry'] ?? {}) as { id?: string; kind?: string; data?: { ref?: string } }
    return e('span', null, `${item.id ?? ''}:${item.kind ?? ''}:${item.data?.ref ?? ''}`)
  },
})

const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')
const { ConversationRowActionsMenu } = await import('../src/ui/ConversationRowActionsMenu.js')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const { PluginMicroAction } = await import('../src/ui/PluginMicroAction.js')
const { PluginDetailDrawer } = await import('../src/plugins/PluginDetailDrawer.js')

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

const humanConv = conv({ id: 10 })
const workerConv = conv({ id: 20, tags: ['worker'], ownedBy: 'bot' })
const botConv = conv({ id: 21, ownedBy: 'bot' })

function entry(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return { id, kind, ...extra } as Parameters<typeof matchTimelineRenderer>[0]
}

const entryBadgeAction = (id: string, label: string, extra: Record<string, unknown> = {}): PluginUiContribution => ({
  pluginId: 'p',
  surface: 'timeline.entry.action',
  spec: {
    id,
    label,
    actionId: 'act',
    client: { module: 'entry-badge.tsx', export: 'EntryBadge' },
    ...extra,
  },
})

const headerActionContribution = (spec: Omit<UiActionSpec, 'target'>): PluginUiContribution => ({
  pluginId: 'builtin:superagent',
  surface: 'conversation.header.action',
  spec: { ...spec, target: 'conversation:header' },
})

function renderTimelineHtml(
  entries: ConversationEntry[],
  contributions: PluginUiContribution[],
  conversation: ConversationSummary = humanConv,
  live?: ConversationLive,
): string {
  const store = makeTestStore({
    conversations: [conversation],
    groupedUi: groupUiContributions(contributions),
  })
  return renderToString(
    e(
      HostStoreProviders,
      { value: store },
      e(ConversationTimeline, {
        conversation,
        detailEntries: entries,
        ...(live !== undefined ? { live } : {}),
        onRequestEdit: () => {},
      }),
    ),
  )
}

// ---------------------------------------------------------------------------
// 1. priority 降序稳定裁决
// ---------------------------------------------------------------------------

test('sortByPriorityDescStable：priority 降序，同优先级保持贡献顺序', { timeout: 60_000 }, () => {
  const items = [
    { pluginId: 'a', spec: { id: 'a1', priority: 0 } },
    { pluginId: 'b', spec: { id: 'b1', priority: 10 } },
    { pluginId: 'c', spec: { id: 'c1' } },
    { pluginId: 'd', spec: { id: 'd1', priority: 10 } },
    { pluginId: 'e', spec: { id: 'e1', priority: -5 } },
  ]
  const sorted = sortByPriorityDescStable(items)
  assert.deepEqual(sorted.map((i) => i.pluginId), ['b', 'd', 'a', 'c', 'e'])
  assert.deepEqual(items.map((i) => i.pluginId), ['a', 'b', 'c', 'd', 'e'])
})

test('findToolView：priority 高者胜，同优先级先注册先命中', { timeout: 60_000 }, () => {
  const views = [
    { pluginId: 'plugin-a', spec: { id: 'va', toolNames: ['bash'], priority: 0 } },
    { pluginId: 'plugin-b', spec: { id: 'vb', toolNames: ['bash'], priority: 10 } },
  ]
  assert.equal(findToolView('bash', views)?.pluginId, 'plugin-b')
  const withoutB = views.filter((v) => v.pluginId !== 'plugin-b')
  assert.equal(findToolView('bash', withoutB)?.pluginId, 'plugin-a')
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
  const narrowed = [
    { pluginId: 'low', spec: { id: 'r0', matchMeta: { renderer: 'x' }, priority: 0 } },
    { pluginId: 'high', spec: { id: 'r1', kinds: ['pi.user'], matchMeta: { renderer: 'x' }, priority: 5 } },
  ]
  assert.equal(
    matchTimelineRenderer(entry('2', 'helm.input', { data: { meta: { renderer: 'x' } } }), narrowed)?.pluginId,
    'low',
  )
  assert.equal(matchTimelineRenderer(entry('3', 'helm.input', { data: { text: '普通' } }), renderers), undefined)
})

// ---------------------------------------------------------------------------
// 2. action-model 纯函数
// ---------------------------------------------------------------------------

test('timelineEntryActionContextOf：真实 kind + 文本条目附角色，其余无角色', { timeout: 60_000 }, () => {
  assert.deepEqual(timelineEntryActionContextOf({ id: '1', kind: 'helm.input' }), { kind: 'helm.input', role: 'user' })
  assert.deepEqual(timelineEntryActionContextOf({ id: '1', kind: 'pi.user' }), { kind: 'pi.user', role: 'user' })
  assert.deepEqual(timelineEntryActionContextOf({ id: '1', kind: 'pi.assistant' }), { kind: 'pi.assistant', role: 'assistant' })
  assert.deepEqual(timelineEntryActionContextOf({ id: '9', kind: 'superagent:worker-report' }), { kind: 'superagent:worker-report' })
  assert.deepEqual(timelineEntryActionContextOf({ id: '3', kind: 'pi.tool-result' }), { kind: 'pi.tool-result' })
})

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

test('matchTimelineEntryActions：kinds / roles 过滤正确', { timeout: 60_000 }, () => {
  const actions = [
    { pluginId: 'p1', target: 'timeline:entry', spec: { id: 'e1', label: '仅用户消息', actionId: 'a', roles: ['user'] } },
    { pluginId: 'p2', target: 'timeline:entry', spec: { id: 'e2', label: '仅助手消息', actionId: 'a', roles: ['assistant'] } },
    { pluginId: 'p3', target: 'timeline:entry', spec: { id: 'e3', label: '仅 helm.input kind', actionId: 'a', kinds: ['helm.input'] } },
    { pluginId: 'p4', target: 'timeline:entry', spec: { id: 'e4', label: '任意条目', actionId: 'a' } },
    { pluginId: 'p5', target: 'timeline:entry', spec: { id: 'e5', label: 'scope 过滤', actionId: 'a', scope: { tags: ['worker'] } } },
  ] as Array<{ pluginId: string; target: 'timeline:entry'; spec: UiActionSpec }>

  const userMsg = matchTimelineEntryActions(actions, humanConv, { kind: 'helm.input', role: 'user' })
  assert.deepEqual(userMsg.map((a) => a.spec.id), ['e1', 'e3', 'e4'])
  const aiMsg = matchTimelineEntryActions(actions, humanConv, { kind: 'pi.assistant', role: 'assistant' })
  assert.deepEqual(aiMsg.map((a) => a.spec.id), ['e2', 'e4'])
  const fallbackUser = matchTimelineEntryActions(actions, humanConv, { kind: 'pi.user', role: 'user' })
  assert.deepEqual(fallbackUser.map((a) => a.spec.id), ['e1', 'e4'])
  const noRole = matchTimelineEntryActions(actions, humanConv, { kind: 'pi.reset' })
  assert.deepEqual(noRole.map((a) => a.spec.id), ['e4'])
  const scoped = matchTimelineEntryActions(actions, workerConv, { kind: 'helm.input', role: 'user' })
  assert.deepEqual(scoped.map((a) => a.spec.id), ['e1', 'e3', 'e4', 'e5'])
  assert.deepEqual(matchTimelineEntryActions(actions, undefined, { kind: 'pi.user' }), [])
})

test('buildMicroActionInput：实际上下文强制覆盖 spec.input 同名字段', { timeout: 60_000 }, () => {
  const input = buildMicroActionInput(
    { input: { conversationId: 999, entryId: 'forged', extra: 'keep' } },
    { conversationId: 42, entryId: 'real-entry' },
  )
  assert.equal(input.conversationId, 42)
  assert.equal(input.entryId, 'real-entry')
  assert.equal(input.extra, 'keep')
  const convOnly = buildMicroActionInput({ input: { entryId: 'forged' } }, { conversationId: 42 })
  assert.equal('entryId' in convOnly, false)
  assert.equal(convOnly.conversationId, 42)
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

test('groupedUi.settingsPanels 排序与 PluginDetailDrawer 多面板全量渲染', { timeout: 60_000 }, async () => {
  const contributions: PluginUiContribution[] = [
    { pluginId: 'plugin-c', surface: 'settings.panel', spec: { id: 'p2', label: '第二面板', order: 20 } satisfies SettingsPanelSpec },
    { pluginId: 'plugin-c', surface: 'settings.panel', spec: { id: 'p1', label: '第一面板', order: 10 } satisfies SettingsPanelSpec },
    { pluginId: 'plugin-c', surface: 'settings.panel', spec: { id: 'p0', label: '缺省顺序' } satisfies SettingsPanelSpec },
    { pluginId: 'plugin-d', surface: 'settings.panel', spec: { id: 'other', label: '其他插件' } satisfies SettingsPanelSpec },
  ]
  const grouped = groupUiContributions(contributions)
  const pluginCPanels = grouped.settingsPanels.filter((p) => p.pluginId === 'plugin-c')
  assert.deepEqual(pluginCPanels.map((p) => p.spec.id), ['p1', 'p2', 'p0'])
  assert.equal(grouped.settingsPanels.filter((p) => p.pluginId === 'plugin-d').length, 1)

  const originalGetConfig = pluginsApi.getConfig
  pluginsApi.getConfig = async () => ({ values: {}, schema: {} })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const plugin: PluginSummary = {
    id: 'plugin-c',
    name: '多面板测试插件',
    version: '1.0.0',
    locked: false,
    enabled: true,
    hooks: [],
    actions: [],
    tools: [],
  }
  const store = makeTestStore({ groupedUi: grouped })
  try {
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e(PluginDetailDrawer, {
            plugin,
            open: true,
            inline: true,
            onClose: () => {},
            onToggleEnabled: async () => {},
            toggling: false,
          }),
        ),
      )
    })
    const text = host.textContent ?? ''
    const idx1 = text.indexOf('第一面板')
    const idx2 = text.indexOf('第二面板')
    const idx0 = text.indexOf('缺省顺序')
    assert.ok(idx1 >= 0 && idx2 > idx1 && idx0 > idx2, '同插件多个 settings.panel 应按 order 升序全部渲染')
    assert.ok(!text.includes('其他插件'), '不渲染其他插件的 settings.panel')
  } finally {
    act(() => root.unmount())
    host.remove()
    pluginsApi.getConfig = originalGetConfig
  }
})

// ---------------------------------------------------------------------------
// 4. PluginMicroAction 渲染与触发闭环（真实 DOM 交互）
// ---------------------------------------------------------------------------

test('PluginMicroAction action-only：渲染图标按钮，点击调用 actionPluginId 并强制实际上下文载荷', { timeout: 60_000 }, async () => {
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
          HostStoreProviders,
          { value: store },
          e(PluginMicroAction, { action, variant: 'toolbar', conversationId: 42 }),
        ),
      )
    })
    const btn = host.querySelector('button') as HTMLButtonElement
    assert.ok(btn !== null)
    assert.match(btn.getAttribute('title')!, /归档/)
    let outerClicked = false
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e('div', { onClick: () => { outerClicked = true } },
            e(PluginMicroAction, { action, variant: 'toolbar', conversationId: 42 })),
        ),
      )
    })
    const btn2 = host.querySelector('button') as HTMLButtonElement
    await act(async () => { btn2.click() })
    assert.equal(outerClicked, false, '点击不得冒泡触发宿主容器 React onClick')
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
      root.render(e(HostStoreProviders, { value: store },
        e(PluginMicroAction, { action, variant: 'hover', conversationId: 20, entryId: '33' })))
    })
    const btn = host.querySelector('button') as HTMLButtonElement
    await act(async () => { btn.click() })
    assert.equal(btn.disabled, true)
    await act(async () => { btn.click() })
    assert.equal(calls.length, 1)
    await act(async () => { release?.() })
    assert.equal(calls.length, 1)
    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.level, 'error')
    assert.match(notices[0]!.title, /执行失败：中止/)
    assert.match(notices[0]!.body!, /后端拒绝/)
    assert.equal(btn.disabled, false)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('PluginMicroAction menu 形态：popover-item 菜单项 + onInvoked 关闭菜单回调', { timeout: 60_000 }, async () => {
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
      root.render(e(HostStoreProviders, { value: store },
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
  seedPluginClientModule('p', 'card.tsx', { CardAction: () => e('div', null, '面板内容 XYZ') })
  const origFetch = globalThis.fetch
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
  const element = e(HostStoreProviders, { value: store },
    e(PluginMicroAction, { action, variant: 'toolbar', conversationId: 1, slotProps: { conversationId: 1 } }))
  const first = createRoot(host)
  let root = first
  try {
    await act(async () => { first.render(element) })
    act(() => { first.unmount() })
    root = createRoot(host)
    await act(async () => { root.render(element) })
    assert.match(host.textContent!, /面板内容 XYZ/)
    assert.ok(host.querySelector('button') === null, '声明 client 轨时不渲染标准按钮')
  } finally {
    act(() => root.unmount())
    host.remove()
    globalThis.fetch = origFetch
  }
})

// ---------------------------------------------------------------------------
// 5. 宿主挂载 SSR：三类微插槽（entry / row / header）
// ---------------------------------------------------------------------------

test('ConversationTimeline：timeline.entry.action 仅在匹配 kind/role 的消息 hover 栏渲染', { timeout: 60_000 }, () => {
  const contributions: PluginUiContribution[] = [
    { pluginId: 'builtin:superagent', surface: 'timeline.entry.action', spec: { target: 'timeline:entry', id: 'user-only', label: '引用用户消息', actionId: 'quote', roles: ['user'] } satisfies UiActionSpec },
    { pluginId: 'builtin:superagent', surface: 'timeline.entry.action', spec: { target: 'timeline:entry', id: 'ai-only', label: '引用回复', actionId: 'cite', roles: ['assistant'] } satisfies UiActionSpec },
    { pluginId: 'builtin:superagent', surface: 'timeline.entry.action', spec: { target: 'timeline:entry', id: 'scoped', label: '仅Worker', actionId: 'w', scope: { tags: ['worker'] } } satisfies UiActionSpec },
  ]
  const html = renderTimelineHtml(
    [
      { id: '1', kind: 'helm.input', data: { text: '帮我检查', origin: 'human' } },
      { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '检查完成' }] }] },
    ],
    contributions,
  )
  assert.match(html, /引用用户消息/)
  assert.match(html, /引用回复/)
  assert.doesNotMatch(html, /仅Worker/)
  assert.match(html, /从此处分叉新会话/)
})

test('ConversationRowActionsMenu：仅在该会话 scope 命中或人类自有根会话时渲染菜单入口', { timeout: 60_000 }, () => {
  const contributions: PluginUiContribution[] = [
    { pluginId: 'p', surface: 'conversation.row.action', spec: { id: 'row', label: '归档该会话', actionId: 'archive', scope: { tags: ['worker'] } } },
  ]
  const scopedStore = makeTestStore({ conversations: [workerConv], groupedUi: groupUiContributions(contributions) })
  const html = renderToString(
    e(HostStoreProviders, { value: scopedStore }, e(ConversationRowActionsMenu, { conversation: workerConv })),
  )
  assert.match(html, /插件会话操作/)

  const humanStore = makeTestStore({ conversations: [humanConv], groupedUi: groupUiContributions(contributions) })
  const humanHtml = renderToString(
    e(HostStoreProviders, { value: humanStore }, e(ConversationRowActionsMenu, { conversation: humanConv })),
  )
  assert.match(humanHtml, /会话操作/)

  const botStore = makeTestStore({ conversations: [botConv], groupedUi: groupUiContributions(contributions) })
  const emptyHtml = renderToString(
    e(HostStoreProviders, { value: botStore }, e(ConversationRowActionsMenu, { conversation: botConv })),
  )
  assert.equal(emptyHtml, '', '无可渲染动作时零渲染、零视觉残留')
})

test('ConversationPane SSR：placement=toolbar 直出顶栏，menu 动作不占顶栏', { timeout: 60_000 }, () => {
  const contributions: PluginUiContribution[] = [
    { pluginId: 'p1', surface: 'conversation.header.action', spec: { target: 'conversation:header', id: 'tb', label: '巡查', icon: 'activity', actionId: 'patrol', placement: 'toolbar' } satisfies UiActionSpec },
    { pluginId: 'p2', surface: 'conversation.header.action', spec: { target: 'conversation:header', id: 'mn', label: '归档汇报', actionId: 'archive', placement: 'menu' } satisfies UiActionSpec },
    { pluginId: 'p3', surface: 'conversation.header.action', spec: { target: 'conversation:header', id: 'no', label: '别处会话', actionId: 'x', placement: 'toolbar', scope: { tags: ['worker'] } } satisfies UiActionSpec },
  ]
  const store = makeTestStore({
    conversations: [humanConv],
    conversationDetails: { 10: { ...humanConv, entries: [] } },
    groupedUi: groupUiContributions(contributions),
  })
  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(ConversationPane, { conversationId: 10 })),
  )
  assert.match(html, /巡查/)
  assert.doesNotMatch(html, /归档汇报/)
  assert.doesNotMatch(html, /别处会话/)
  assert.match(html, /更多会话操作/)
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
  const entryActions = grouped.uiActions.filter((a) => a.target === 'timeline:entry')
  assert.deepEqual(header.map((a) => a.spec.id), ['h1', 'h2'], 'header 按 order 升序')
  assert.deepEqual(row.map((a) => a.spec.id), ['r1'])
  assert.deepEqual(entryActions.map((a) => a.spec.id), ['t1'])
})

// ---------------------------------------------------------------------------
// 6. timeline.entry.action 真实 entry 锚点（非占位拼合）
// ---------------------------------------------------------------------------

test('人类消息 entry action：读到真实 entry.data（非占位拼合）', { timeout: 60_000 }, () => {
  const html = renderTimelineHtml(
    [{ id: '5', kind: 'helm.input', data: { text: '帮我检查', origin: 'human', ref: 'REF-HUMAN-5' } }],
    [entryBadgeAction('quote', '引用')],
  )
  assert.match(html, /5:helm\.input:REF-HUMAN-5/)
})

test('kind 精确过滤：声明 kinds 不含真实 kind 的动作不渲染', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '5', kind: 'helm.input', data: { text: '帮我检查', origin: 'human', ref: 'R5' } },
  ]
  const hit = renderTimelineHtml(entries, [entryBadgeAction('hit', '命中', { kinds: ['helm.input'] })])
  assert.match(hit, /5:helm\.input:R5/)
  const miss = renderTimelineHtml(entries, [entryBadgeAction('miss', '不命中', { kinds: ['pi.assistant'] })])
  assert.doesNotMatch(miss, /R5/)
  const bareEntries: ConversationEntry[] = [{ id: '6', kind: 'pi.user', model: [{ role: 'user', content: '裸输入' }], data: { ref: 'R6' } }]
  assert.match(renderTimelineHtml(bareEntries, [entryBadgeAction('u', '用户兜底', { kinds: ['pi.user'] })]), /6:pi\.user:R6/)
  assert.doesNotMatch(renderTimelineHtml(bareEntries, [entryBadgeAction('h', '错 kind', { kinds: ['helm.input'] })]), /R6/)
})

test('queued 人类消息（无持久锚点）不渲染 entry action', { timeout: 60_000 }, () => {
  const html = renderTimelineHtml(
    [{ id: '1', kind: 'helm.input', data: { text: '第一问', origin: 'human' } }],
    [entryBadgeAction('quote', '引用')],
    humanConv,
    {
      conversationId: 10,
      text: '',
      tools: [],
      updatedAt: 1,
      queuedInputs: [
        { id: 'q1', submissionId: 'sub-1', text: '排队中的追问', mode: 'followUp', origin: 'human', createdAt: 1 },
      ],
    },
  )
  assert.match(html, /1:helm\.input:/)
  const queuedWrap = html.split('data-entry-id="queued:sub-1"')[1] ?? ''
  const queuedHover = queuedWrap.split('</span></div></div>')[0] ?? ''
  assert.doesNotMatch(queuedHover, /引用/)
  assert.doesNotMatch(queuedHover, /:helm\.input:/)
  assert.doesNotMatch(queuedHover, /:queued:/)
  assert.match(html, /排队中 · 待当前回合结束后发送/)
})

test('assistant 回合 entry action：锚点是带 assistant 正文的真实条目，非 tool-result', { timeout: 60_000 }, () => {
  const html = renderTimelineHtml(
    [
      { id: '1', kind: 'helm.input', data: { text: '查一下', origin: 'human' } },
      {
        id: '2',
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} }] }],
      },
      { id: '3', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: 'ok' }] },
      {
        id: '4',
        kind: 'pi.assistant',
        data: { ref: 'REF-AI-4' },
        model: [{ role: 'assistant', content: [{ type: 'text', text: '检查完成' }] }],
      },
    ],
    [entryBadgeAction('cite', '引用回复')],
  )
  assert.match(html, /4:pi\.assistant:REF-AI-4/)
  assert.doesNotMatch(html, /3:pi\.assistant:/)
  assert.doesNotMatch(html, /3:pi\.tool-result:/)
})

test('assistant 锚点回退：无 assistant 正文时退回最后一个纯 toolCall 的 pi.assistant 条目', { timeout: 60_000 }, () => {
  const html = renderTimelineHtml(
    [
      {
        id: '7',
        kind: 'pi.assistant',
        data: { ref: 'REF-ONLY' },
        model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'bash', arguments: {} }] }],
      },
      { id: '8', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: 'ok' }] },
    ],
    [entryBadgeAction('cite', '引用回复')],
  )
  assert.match(html, /7:pi\.assistant:REF-ONLY/)
})

test('live 回合无持久锚点：不渲染 entry action，宿主分叉按钮亦隐藏', { timeout: 60_000 }, () => {
  const working = conv({ id: 11, status: 'working' })
  const html = renderTimelineHtml(
    [
      { id: '1', kind: 'helm.input', data: { text: '跑起来', origin: 'human' } },
      {
        id: '2',
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }] }],
      },
    ],
    [entryBadgeAction('cite', '引用回复')],
    working,
    { conversationId: 11, text: '流式输出中', tools: [{ callId: 'c1', toolName: 'bash', status: 'running' }], updatedAt: 9 },
  )
  assert.match(html, /1:helm\.input:/)
  assert.doesNotMatch(html, /引用回复/)
  assert.doesNotMatch(html, /从此处分叉新会话/)
})

test('live 快照合并进已有持久 pi.assistant 回合：busy 期间不渲染，也不伪造锚点', { timeout: 60_000 }, () => {
  const working = conv({ id: 11, status: 'working' })
  const html = renderTimelineHtml(
    [
      { id: '1', kind: 'helm.input', data: { text: '继续', origin: 'human' } },
      {
        id: '2',
        kind: 'pi.assistant',
        data: { ref: 'REF-LIVE-2' },
        model: [{ role: 'assistant', content: [{ type: 'text', text: '开始' }] }],
      },
    ],
    [entryBadgeAction('cite', '引用回复')],
    working,
    { conversationId: 11, text: '开始流式', tools: [], updatedAt: 9 },
  )
  assert.doesNotMatch(html, /引用回复/)
  assert.doesNotMatch(html, /turn:/)
})

test('插件 timeline.renderer 自定义条目：entry action 按真实 kind 过滤并透出真实 entry', { timeout: 60_000 }, () => {
  const contributions: PluginUiContribution[] = [
    {
      pluginId: 'p',
      surface: 'timeline.renderer',
      spec: { id: 'r', matchMeta: { renderer: 'worker-report' } },
    },
    entryBadgeAction('generic', '卡片操作'),
    entryBadgeAction('kind-limited', '限kind', { kinds: ['superagent:worker-report'] }),
    entryBadgeAction('kind-miss', '错kind', { kinds: ['helm.input'] }),
    entryBadgeAction('role-limited', '限角色', { roles: ['user'] }),
  ]
  const html = renderTimelineHtml(
    [{ id: '8', kind: 'superagent:worker-report', data: { renderer: 'worker-report', ref: 'REF-CARD-8' } }],
    contributions,
  )
  assert.match(html, /8:superagent:worker-report:REF-CARD-8/)
  assert.doesNotMatch(html, /错kind/)
  assert.doesNotMatch(html, /限角色/)
})

test('action-only entry action 点击：载荷 entryId 为真实 entry.id，kind 过滤仍生效', { timeout: 60_000 }, async () => {
  const calls: Array<{ pluginId: string; actionId: string; input: Record<string, unknown>; conversationId?: number }> = []
  const store = makeTestStore({
    conversations: [humanConv],
    groupedUi: groupUiContributions([
      {
        pluginId: 'p',
        surface: 'timeline.entry.action',
        spec: { target: 'timeline:entry', id: 'pin', label: '置顶该消息', actionId: 'pin_entry', kinds: ['helm.input'] } satisfies UiActionSpec,
      },
      {
        pluginId: 'p',
        surface: 'timeline.entry.action',
        spec: { target: 'timeline:entry', id: 'wrong-kind', label: '错误kind动作', actionId: 'x', kinds: ['pi.assistant'] } satisfies UiActionSpec,
      },
    ]),
    invokePluginAction: async (pluginId, actionId, input, conversationId) => {
      calls.push({ pluginId, actionId, input: input as Record<string, unknown>, conversationId })
      return { ok: true }
    },
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e(ConversationTimeline, {
            conversation: humanConv,
            detailEntries: [{ id: '42', kind: 'helm.input', data: { text: '真实锚点', origin: 'human' } }],
            onRequestEdit: () => {},
          }),
        ),
      )
    })
    const btn = host.querySelector<HTMLButtonElement>('button[aria-label="置顶该消息"]')
    assert.ok(btn !== null, 'action-only 渲染标准图标按钮')
    assert.ok(host.querySelector('button[aria-label="错误kind动作"]') === null, 'kind 不匹配不渲染')
    await act(async () => { btn.click() })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.pluginId, 'p')
    assert.equal(calls[0]!.actionId, 'pin_entry')
    assert.deepEqual(calls[0]!.input, { conversationId: 10, entryId: '42' })
    assert.equal(calls[0]!.conversationId, 10)
    const hover = btn.closest('.msg-hover-bar')
    assert.ok(hover !== null)
    assert.equal(hover.querySelectorAll('button').length >= 3, true, '复制/编辑/分叉仍在 hover 条内')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('rewind 覆盖的人类条目不渲染 entry action（不复活已覆盖锚点）', { timeout: 60_000 }, () => {
  const html = renderTimelineHtml(
    [
      { id: '1', kind: 'helm.input', data: { text: '旧问题', origin: 'human', ref: 'OLD' } },
      { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '旧回答' }] }] },
      { id: '3', kind: 'helm.rewind', data: { fromEntryId: 1, throughEntryId: 2 } },
      { id: '4', kind: 'helm.input', data: { text: '新问题', origin: 'human', ref: 'NEW' } },
    ],
    [entryBadgeAction('quote', '引用')],
  )
  assert.doesNotMatch(html, /OLD/)
  assert.match(html, /4:helm\.input:NEW/)
})
