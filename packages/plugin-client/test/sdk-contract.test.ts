/**
 * @helm/plugin-client 独立包契约测试（不依赖任何 web/kernel 实现）：
 * 1. 导出符号与 protocol PLUGIN_CLIENT_SHARED_EXPORTS 双向锁定
 *    （清单内全部符号运行时真实存在；插件面向符号不为 undefined）；
 * 2. 宿主端口 Provider 契约：usePluginDoc / usePluginSessionDoc / useConversations /
 *    useConversation / usePlugins / usePluginContext 全部经 PluginClientHostContext
 *    注入的端口取数，无端口时显式报错（绝不静默降级）；
 * 3. createPluginClientContext 端口转发契约：callAction 跨插件寻址、submitInput
 *    origin=agent 载荷、导航/通知/文档方法逐项转发真实端口实现；
 * 4. PluginSlot 端口契约：短名拼全限定、single 首项、fallback、环检测显式告警；
 * 5. MarkdownView / CodeBlockView 端口委托：渲染宿主注入实现。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { PLUGIN_CLIENT_SHARED_EXPORTS } from '@helm/protocol'
import * as SDK from '../src/index.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// 1. 导出清单双向锁定
// ---------------------------------------------------------------------------

test('PLUGIN_CLIENT_SHARED_EXPORTS 清单内全部符号在本包运行时命名空间真实存在', { timeout: 60_000 }, () => {
  const exportedNames = new Set(Object.keys(SDK))
  for (const name of PLUGIN_CLIENT_SHARED_EXPORTS) {
    assert.ok(exportedNames.has(name), `@helm/plugin-client 缺少清单符号 ${name}（PLUGIN_CLIENT_SHARED_EXPORTS 与实现漂移）`)
    assert.ok((SDK as Record<string, unknown>)[name] !== undefined, `符号 ${name} 不得为 undefined`)
  }
})

test('宿主面向符号（端口 / 上下文 / 工厂 / 显式寻址 hooks）真实导出', { timeout: 60_000 }, () => {
  for (const name of [
    'PluginClientHostContext',
    'usePluginClientHost',
    'PluginClientContext',
    'usePluginContext',
    'createPluginClientContext',
    'usePluginDocValue',
    'usePluginSessionDocState',
    'usePluginSessionDocValue',
    'ToolActivityContext',
    'useToolActivity',
  ] as const) {
    assert.ok(name in SDK, `宿主面向符号 ${name} 必须导出`)
    assert.ok((SDK as Record<string, unknown>)[name] !== undefined, `宿主面向符号 ${name} 不得为 undefined`)
  }
})

// ---------------------------------------------------------------------------
// 测试端口（行为真实的最小替身：记录调用并返回确定数据）
// ---------------------------------------------------------------------------

interface PortLog {
  actions: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }>
  inputs: Array<{ conversationId: number; text: string; origin: string; whenBusy?: string }>
  targets: Array<{ target: string; split?: boolean }>
  drawers: number[]
  artifacts: Array<{ artifactId: string; conversationId?: number }>
  workbench: Array<boolean | string>
  notices: Array<{ message: string; tone: string; conversationId?: number }>
  docs: Array<{ pluginId: string; docName: string; conversationId?: number }>
}

function makePort(log: PortLog, overrides: Partial<SDK.PluginClientHostPort> = {}): SDK.PluginClientHostPort {
  const slotRender = (item: SDK.PluginSlotPortItem, options: { slotProps?: Record<string, unknown>; label: string }): React.ReactNode =>
    e('div', { 'data-slot': `${item.pluginId}/${item.contributionId}`, 'data-label': options.label }, JSON.stringify(options.slotProps ?? null))
  return {
    authenticated: true,
    theme: 'dark',
    conversations: [{ id: 7, title: 'c7', tags: [], profileId: 'p' } as unknown as SDK.PluginClientHostPort['conversations'][number]],
    conversationDetails: {},
    conversationLives: {},
    pendingAsks: [],
    loadErrors: {},
    plugins: [],
    screens: [],
    pluginDocs: { 'p1/state': { ok: 1 } },
    ensurePluginDoc: (pluginId, docName) => {
      log.docs.push({ pluginId, docName })
      return Promise.resolve({ ok: 1 })
    },
    getPluginSessionDoc: (pluginId, docName, conversationId) => {
      log.docs.push({ pluginId, docName, conversationId })
      return Promise.resolve({ session: true })
    },
    subscribeSessionDoc: () => () => {},
    getSessionDocState: (key) => ({
      hasValue: true,
      deleted: false,
      connected: true,
      value: { key: `${key.pluginId}/${key.docName}/${key.conversationId}` },
    }),
    invokePluginAction: (pluginId, actionId, input, conversationId) => {
      log.actions.push({ pluginId, actionId, input, conversationId })
      return Promise.resolve({ done: true })
    },
    submitConversationInput: (conversationId, input) => {
      log.inputs.push({ conversationId, ...input, origin: input.origin, whenBusy: input.whenBusy })
      return Promise.resolve()
    },
    openTarget: (target, options) => {
      log.targets.push({ target, split: options?.split })
    },
    openConversationDrawer: (conversationId) => {
      log.drawers.push(conversationId)
    },
    openArtifactPreview: (artifactId, conversationId) => {
      log.artifacts.push({ artifactId, conversationId })
    },
    setWorkbenchOpen: (open) => {
      log.workbench.push(open)
    },
    setWorkbenchTab: (tab) => {
      log.workbench.push(tab)
    },
    notify: (message, tone, conversationId) => {
      log.notices.push({ message, tone, conversationId })
    },
    loadConversationDetail: () => Promise.resolve(undefined),
    slots: {
      collectItems: (qualifiedName) =>
        qualifiedName === 'owner/zone'
          ? [
              { pluginId: 'p2', contributionId: 'badge', spec: { id: 'badge', target: 'owner/zone' } },
              { pluginId: 'p3', contributionId: 'extra', spec: { id: 'extra', target: 'owner/zone' } },
            ]
          : [],
      renderItem: slotRender,
    },
    markdown: {
      view: ({ text }) => e('div', { 'data-md': 'host' }, text),
      codeBlock: ({ code, language }) => e('pre', { 'data-code': 'host', 'data-lang': language }, code),
    },
    ...overrides,
  }
}

function mount(tree: React.ReactNode): { host: HTMLElement; root: Root } {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(tree))
  return { host, root }
}

// ---------------------------------------------------------------------------
// 2. hooks 端口取数与无端口显式报错
// ---------------------------------------------------------------------------

test('usePluginDoc / useConversations / usePlugins 经端口取数；首次自动 ensurePluginDoc', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  let docValue: unknown = 'unset'
  let conversations: unknown[] | undefined
  let screens: unknown[] | undefined
  function Probe(): React.ReactNode {
    docValue = SDK.usePluginDoc('state', 'p1')
    conversations = SDK.useConversations()
    screens = SDK.usePlugins().screens
    return e('div', null, 'probe')
  }
  const { host, root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(Probe))),
  )
  assert.deepEqual(docValue, { ok: 1 }, '公开文档取自端口 pluginDocs')
  assert.equal(conversations?.length, 1, '会话摘要取自端口 conversations')
  assert.deepEqual(screens, [], 'screens 取自端口')
  act(() => { void root.unmount() })
  void host
})

test('usePluginDoc 缺失键时自动发起 ensurePluginDoc（端口转发）', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  function Probe(): React.ReactNode {
    const value = SDK.usePluginDoc('missing')
    return e('div', null, String(value))
  }
  const { root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(Probe))),
  )
  assert.equal(log.docs.length, 1, '缺失文档经端口发起一次 ensurePluginDoc')
  assert.deepEqual(log.docs[0], { pluginId: 'p1', docName: 'missing' })
  act(() => { void root.unmount() })
})

test('usePluginSessionDoc：继承 ctx 会话；显式覆写优先；无会话返回 undefined', { timeout: 60_000 }, () => {
  const seen: string[] = []
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const states = new Map<string, unknown>()
  port.getSessionDocState = (key) => {
    seen.push(`${key.pluginId}/${key.docName}/${key.conversationId}`)
    const cacheKey = `${key.pluginId}/${key.docName}/${key.conversationId}`
    // 快照引用稳定（与真实宿主缓存一致）：useSyncExternalStore 以 Object.is 判等
    let snapshot = states.get(cacheKey)
    if (snapshot === undefined) {
      snapshot = { hasValue: true, deleted: false, connected: true, value: 42 }
      states.set(cacheKey, snapshot)
    }
    return snapshot as SDK.PluginSessionDocState
  }
  let inherited: unknown = 'unset'
  let overridden: unknown = 'unset'
  let none: unknown = 'unset'
  // 三个探测分别在不同上下文 Provider 下渲染（同一组件内不条件调用 hooks）
  function InheritedProbe(): React.ReactNode {
    inherited = SDK.usePluginSessionDoc('runs')
    return e('div', null, 'probe')
  }
  function OverriddenProbe(): React.ReactNode {
    overridden = SDK.usePluginSessionDoc('runs', { conversationId: 9, pluginId: 'other' })
    return e('div', null, 'probe')
  }
  function NoneProbe(): React.ReactNode {
    none = SDK.usePluginSessionDoc('runs')
    return e('div', null, 'probe')
  }
  mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(InheritedProbe)),
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(OverriddenProbe)),
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', undefined) },
        e(NoneProbe))),
  )
  assert.equal(inherited, 42, '继承 ctx.conversationId=7 的订阅值')
  assert.equal(overridden, 42, '显式覆写 conversationId=9 / pluginId=other')
  assert.equal(none, undefined, '无会话上下文不开流返回 undefined')
  assert.deepEqual([...new Set(seen)], ['p1/runs/7', 'other/runs/9'], '订阅元组按继承与覆写解析（无会话上下文不产生元组）')
})

test('无宿主端口时 hooks 显式报错（绝不静默降级）', { timeout: 60_000 }, () => {
  function Probe(): React.ReactNode {
    SDK.useConversations()
    return e('div', null, 'probe')
  }
  assert.throws(
    () => renderToString(e(Probe)),
    /usePluginClientHost 必须在 <PluginClientHostContext.Provider> 内调用/,
    'useConversations 在端口缺失时显式抛错',
  )
})

// ---------------------------------------------------------------------------
// 3. createPluginClientContext 端口转发
// ---------------------------------------------------------------------------

test('createPluginClientContext：动作 / 输入 / 导航 / 通知 / 文档逐项转发端口', { timeout: 60_000 }, async () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const ctx = SDK.createPluginClientContext(port, 'p1', 7, { draft: '', attachments: [], sending: false, setDraft() {}, insertText() {}, submit: () => Promise.resolve() })
  assert.equal(ctx.pluginId, 'p1')
  assert.equal(ctx.conversationId, 7)
  assert.equal(ctx.theme, 'dark')
  assert.ok(ctx.composer !== undefined, '显式提供的 composer 透传')

  await ctx.callAction('reload', { x: 1 })
  await ctx.callAction('reload', { x: 2 }, { pluginId: 'p2', conversationId: 9 })
  assert.deepEqual(log.actions, [
    { pluginId: 'p1', actionId: 'reload', input: { x: 1 }, conversationId: 7 },
    { pluginId: 'p2', actionId: 'reload', input: { x: 2 }, conversationId: 9 },
  ], 'callAction 缺省继承当前插件与会话，显式参数优先')

  await ctx.submitInput('hello', { whenBusy: 'followUp' })
  assert.deepEqual(log.inputs, [{ conversationId: 7, text: 'hello', origin: 'agent', whenBusy: 'followUp' }], 'submitInput 以 origin=agent 经端口提交')

  ctx.openScreen('conversation:1')
  ctx.openSplitScreen('screen:builtin:herdr/overview')
  assert.deepEqual(log.targets, [
    { target: 'conversation:1', split: undefined },
    { target: 'screen:builtin:herdr/overview', split: true },
  ], 'openScreen / openSplitScreen 经端口 openTarget')

  ctx.openConversationDrawer(3)
  ctx.openArtifact('art-1')
  ctx.openWorkbench('plugin:builtin:memory/main')
  ctx.closeWorkbench()
  assert.deepEqual(log.drawers, [3])
  assert.deepEqual(log.artifacts, [{ artifactId: 'art-1', conversationId: 7 }], '产物预览继承当前会话')
  assert.deepEqual(log.workbench, [true, 'plugin:builtin:memory/main', false])

  ctx.notify('boom', 'error')
  assert.deepEqual(log.notices, [{ message: 'boom', tone: 'error', conversationId: 7 }])

  await ctx.getPluginDoc('state')
  await ctx.getPluginDoc('state', 'p2')
  await ctx.getPluginSessionDoc('runs', { conversationId: 8 })
  assert.deepEqual(log.docs, [
    { pluginId: 'p1', docName: 'state' },
    { pluginId: 'p2', docName: 'state' },
    { pluginId: 'p1', docName: 'runs', conversationId: 8 },
  ], '文档读取经端口（跨插件与显式会话优先）')
})

test('createPluginClientContext：submitInput 无会话上下文显式 reject；非法会话 ID 显式报错', { timeout: 60_000 }, async () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const ctx = SDK.createPluginClientContext(port, 'p1', undefined)
  await assert.rejects(() => ctx.submitInput('x'), /submitInput 无目标会话/, '无会话时不静默丢弃')
  assert.throws(() => { void ctx.callAction('a', 1, { conversationId: 0 }) }, /正整数/, '非法会话 ID 同步拒绝')
  await assert.rejects(() => ctx.getPluginSessionDoc('runs'), /getPluginSessionDoc 无目标会话/)
})

// ---------------------------------------------------------------------------
// 4. PluginSlot 端口契约
// ---------------------------------------------------------------------------

test('PluginSlot：短名拼全限定、list 全量渲染、single 首项、无命中 fallback、无 owner 告警', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const tree = (name: string, extra: Record<string, unknown> = {}, fallback?: React.ReactNode) =>
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'owner', undefined) },
        e(SDK.PluginSlot, { name, ...extra, ...(fallback !== undefined ? { fallback } : {}) })))

  const all = mount(tree('zone', { slotProps: { z: 1 } }))
  assert.equal(all.host.querySelectorAll('[data-slot]').length, 2, 'list 模式渲染全部命中项')
  assert.equal(all.host.querySelector('[data-slot="p2/badge"]')?.getAttribute('data-label'), '插槽 owner/zone/badge', '渲染标签携带全限定名')
  assert.equal(all.host.querySelector('[data-slot="p2/badge"]')?.textContent, '{"z":1}', 'slotProps 透传给宿主渲染')
  act(() => { void all.root.unmount() })

  const single = mount(tree('zone', { mode: 'single' }))
  assert.equal(single.host.querySelectorAll('[data-slot]').length, 1, 'single 模式仅渲染首项')
  act(() => { void single.root.unmount() })

  const empty = mount(tree('nope', {}, e('div', null, 'fallback-here')))
  assert.equal(empty.host.textContent, 'fallback-here', '无命中渲染 fallback')
  act(() => { void empty.root.unmount() })

  const noOwner = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port }, e(SDK.PluginSlot, { name: 'zone' })))
  assert.match(noOwner.host.textContent ?? '', /无宿主插件上下文/, '无 owner 显式告警')
  act(() => { void noOwner.root.unmount() })
})

test('PluginSlot：渲染链同一贡献项再次出现时显式环告警且不死循环', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  // 宿主渲染实现里再次渲染同插槽（等价贡献项组件内嵌套同名插槽的真实环）
  port.slots = {
    collectItems: (qualifiedName) =>
      qualifiedName === 'owner/loop'
        ? [{ pluginId: 'p2', contributionId: 'cycle', spec: { id: 'cycle', target: 'owner/loop' } }]
        : [],
    renderItem: (item) =>
      e(SDK.PluginClientHostContext.Provider, { value: port },
        e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, item.pluginId, undefined) },
          e(SDK.PluginSlot, { name: 'owner/loop' }))),
  }
  const { host, root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'owner', undefined) },
        e(SDK.PluginSlot, { name: 'loop' }))))
  assert.match(host.textContent ?? '', /循环嵌套/, '环链显式告警而非栈溢出')
  act(() => { void root.unmount() })
})

// ---------------------------------------------------------------------------
// 5. MarkdownView / CodeBlockView 端口委托
// ---------------------------------------------------------------------------

test('MarkdownView / CodeBlockView 渲染宿主端口注入的实现（SSR 安全）', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const html = renderToString(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e('div', null,
        e(SDK.MarkdownView, { text: '# hi' }),
        e(SDK.CodeBlockView, { code: 'let x = 1', language: 'ts' }))))
  assert.match(html, /data-md="host"/, 'MarkdownView 委托宿主 view')
  assert.match(html, /# hi/)
  assert.match(html, /data-code="host"/, 'CodeBlockView 委托宿主 codeBlock')
  assert.match(html, /data-lang="ts"/)
})
