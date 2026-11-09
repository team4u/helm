import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { act, useContext } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationSummary } from '@helm/protocol'
import { compilePluginClientModule } from '../../kernel/src/plugins/client-compiler.js'
import { ToolActivityProvider } from '../src/conversation/ToolActivityProvider.js'
import { ToolActivityContext } from '../src/lib/tool-activity.js'
import { PluginUiView } from '../src/ui/PluginUiView.js'
import { ConversationTimeline } from '../src/conversation/ConversationTimeline.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { resetPluginClientCache, seedPluginClientModule } from '../src/lib/plugin-client.js'
import { makeTestStore } from './helpers/store.js'
import { mountSharedPluginNamespaces } from './helpers/workflow-client.js'
import * as SDK from '../src/lib/plugin-client-context.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
mountSharedPluginNamespaces({ realHooks: true })
const e = React.createElement
const dir = await mkdtemp(join(tmpdir(), 'helm-tool-activity-'))
after(async () => { await rm(dir, { recursive: true, force: true }) })
await writeFile(join(dir, 'client.tsx'), `
  import { useToolActivity, usePluginDoc } from '@helm/plugin-client'
  export const sharedHook = useToolActivity
  export function Reporter(props) {
    useToolActivity(props.callId, props.active)
    if (props.crash) throw new Error('预期的 reporter 渲染失败')
    return <div data-reporter={props.label}>普通后台活动</div>
  }
  export function Quiet() { return <div>没有后台活动</div> }
  export function ToolPanel(props) {
    const activity = usePluginDoc('activity')
    useToolActivity(props.callId, activity?.[props.callId] === true)
    return <div>普通插件工具</div>
  }
`)
const { code } = await compilePluginClientModule('sample:background', dir, 'client.tsx', join(dir, 'cache'))
const compiled = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) as Record<string, unknown>
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; resetPluginClientCache() })

function seed() {
  seedPluginClientModule('sample:background', 'client.tsx', compiled)
  seedPluginClientModule('sample:other', 'client.tsx', compiled)
  seedPluginClientModule('sample:background', 'other.tsx', compiled)
  globalThis.fetch = async () => new Response('', { headers: { 'x-helm-client-hash': 'seeded' } })
}
function view(props: Record<string, unknown>, key: string, exportName = 'Reporter', pluginId = 'sample:background', module = 'client.tsx') {
  return e(PluginUiView, { key, pluginId, spec: { client: { module, export: exportName } }, slotProps: props })
}
function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  return {
    host,
    render: async (content: React.ReactNode, store: HelmStoreValue = makeTestStore()) => {
      await act(async () => root.render(e(HelmStoreContext.Provider, { value: store }, content)))
    },
    close: async () => { await act(async () => root.unmount()); host.remove() },
  }
}

function Probe() {
  const registry = useContext(ToolActivityContext)
  return e('output', { 'data-active': true }, [...(registry?.activeToolCallIds ?? [])].sort().join(','))
}

test('共享 SDK 与真实产物持有同一个 useToolActivity；StrictMode 下同 callId 的多个来源独立释放', { timeout: 60_000 }, async () => {
  seed()
  assert.equal(compiled.sharedHook, SDK.useToolActivity)
  const ui = mount()
  const render = async (first: boolean, second: boolean, active = true, callId: string | undefined = 'same') => {
    await ui.render(e(React.StrictMode, null, e(ToolActivityProvider, null, e(Probe),
      first ? view({ callId, active, label: 'a' }, 'a') : null,
      second ? view({ callId, active, label: 'b' }, 'b') : null)))
  }
  try {
    await render(true, true)
    assert.equal(ui.host.querySelector('output')?.textContent, 'same')
    await ui.render(e(React.StrictMode, null, e(ToolActivityProvider, null, e(Probe),
      view({ callId: 'same', active: false, label: 'a' }, 'a'),
      view({ callId: 'same', active: true, label: 'b' }, 'b'))))
    assert.equal(ui.host.querySelector('output')?.textContent, 'same', '一个来源 active=false 不影响同 callId 的其他来源')
    await render(true, true)
    await render(false, true)
    assert.equal(ui.host.querySelector('output')?.textContent, 'same', '卸载一个来源不得释放另一个活跃来源')
    await render(false, true, true, 'new')
    assert.equal(ui.host.querySelector('output')?.textContent, 'new', 'callId 改变必须释放旧登记')
    await render(false, true, false, 'new')
    assert.equal(ui.host.querySelector('output')?.textContent, '', 'active=false 必须释放')
    await ui.render(e(React.StrictMode, null, e(ToolActivityProvider, null, e(Probe), view({ active: true, label: 'b' }, 'b'))))
    assert.equal(ui.host.querySelector('output')?.textContent, '', '没有 callId 不能创建可关联活动')
    await render(false, true, true, 'new')
    await render(false, false)
    assert.equal(ui.host.querySelector('output')?.textContent, '', '最后来源卸载后释放登记')
  } finally { await ui.close() }
})

test('plugin/module/export 身份替换与 error boundary 卸载真实插件时均释放原登记', { timeout: 60_000 }, async () => {
  seed()
  const ui = mount()
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args) => { errors.push(args) }
  const render = async (node: React.ReactNode) => { await ui.render(e(ToolActivityProvider, null, e(Probe), node)) }
  try {
    for (const [exportName, pluginId, module] of [
      ['Quiet', 'sample:background', 'client.tsx'],
      ['Quiet', 'sample:other', 'client.tsx'],
      ['Quiet', 'sample:background', 'other.tsx'],
    ] as const) {
      await render(view({ callId: 'old', active: true }, 'slot'))
      assert.equal(ui.host.querySelector('output')?.textContent, 'old')
      await render(view({}, 'slot', exportName, pluginId, module))
      assert.equal(ui.host.querySelector('output')?.textContent, '', '新身份不能继承旧来源')
    }
    await render(view({ callId: 'error', active: true }, 'slot'))
    assert.equal(ui.host.querySelector('output')?.textContent, 'error')
    await render(view({ callId: 'error', active: true, crash: true }, 'slot'))
    assert.equal(ui.host.querySelector('output')?.textContent, '')
    assert.match(ui.host.textContent!, /预期的 reporter 渲染失败/)
    assert.ok(errors.length > 0, '真实 React error boundary 应捕获组件异常')
  } finally { console.error = originalError; await ui.close() }
})

test('没有 timeline provider 的组件不登记全局活动，独立回合 Provider 互不干扰', { timeout: 60_000 }, async () => {
  seed()
  const ui = mount()
  try {
    await ui.render(e(React.Fragment, null,
      view({ callId: 'same', active: true }, 'workbench'),
      e(ToolActivityProvider, null, e('section', { 'data-turn': 'first' }, e(Probe), view({ callId: 'same', active: true }, 'timeline'))),
      e(ToolActivityProvider, null, e('section', { 'data-turn': 'second' }, e(Probe))),
    ))
    assert.equal(ui.host.querySelector('[data-turn="first"] output')?.textContent, 'same')
    assert.equal(ui.host.querySelector('[data-turn="second"] output')?.textContent, '')
    await ui.render(e(React.Fragment, null, view({ callId: 'same', active: true }, 'workbench'), e(ToolActivityProvider, null, e(Probe))))
    assert.equal(ui.host.querySelector('output')?.textContent, '', '工作台活动不能遗留到后续时间线 Provider')
  } finally { await ui.close() }
})

const conversation: ConversationSummary = {
  id: 1, title: '通用插件活动', profileId: 'default', tags: [], cwd: '/tmp', model: '', thinkingLevel: '', status: 'idle',
  stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0, createdAt: 1, updatedAt: 2,
}
function entries(callId: string, start: number): ConversationEntry[] {
  return [
    { id: String(start), kind: 'helm.input', data: { text: '启动后台任务', origin: 'human' } },
    { id: String(start + 1), kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'background_job', arguments: {} }] }] },
    { id: String(start + 2), kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: callId, toolName: 'background_job', content: [{ type: 'text', text: '已启动' }] }] },
    { id: String(start + 3), kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '已提交后台执行' }], stopReason: 'stop' }] },
  ]
}

test('非 workflow 插件真实编译产物报告活动：done 工具仍隐藏本回合复制/分叉，重复 SSE 不循环，终态/停用释放', { timeout: 60_000 }, async () => {
  seed()
  const ui = mount()
  const groupedUi = groupUiContributions([{ pluginId: 'sample:background', surface: 'tool.view', spec: {
    id: 'background', toolNames: ['background_job'], replaceRow: true, client: { module: 'client.tsx', export: 'ToolPanel' },
  } }])
  const timeline = e(ConversationTimeline, { conversation, detailEntries: [...entries('call-a', 1), ...entries('call-b', 5)], onRequestEdit: () => {} })
  const store = (activity: Record<string, boolean>, enabled = true) => makeTestStore({
    conversations: [conversation], groupedUi: enabled ? groupedUi : groupUiContributions([]),
    pluginDocs: { 'sample:background/activity': activity },
  })
  const bars = () => [...ui.host.querySelectorAll('.msg-ai-block')].map((turn) => turn.querySelector('.msg-hover-bar') !== null)
  try {
    await ui.render(timeline, store({ 'call-a': true, 'call-b': false }))
    assert.deepEqual(bars(), [false, true], '后台工具 done 后，只有报告活动的回合仍隐藏操作条')
    for (let n = 0; n < 5; n++) await ui.render(timeline, store({ 'call-a': true, 'call-b': false }))
    assert.deepEqual(bars(), [false, true], '相同 SSE 业务值不应清掉或重复累积登记')
    await ui.render(timeline, store({ 'call-a': false, 'call-b': false }))
    assert.deepEqual(bars(), [true, true], '真实终态后恢复复制与分叉')
    await ui.render(timeline, store({ 'call-a': true, 'call-b': true }))
    assert.deepEqual(bars(), [false, false])
    await ui.render(timeline, store({ 'call-a': true, 'call-b': true }, false))
    assert.deepEqual(bars(), [true, true], '插件停用卸载 renderer 后必须释放活动')
    await ui.render(timeline, store({ 'call-a': false, 'call-b': false }))
    assert.deepEqual(bars(), [true, true], '恢复插件不能留下旧活动来源')
  } finally { await ui.close() }
})
