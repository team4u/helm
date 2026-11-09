import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary, PluginSummary, PluginUiContribution, WorkflowRunSummary } from '@helm/protocol'
import { ConversationTimeline } from '../src/conversation/ConversationTimeline.js'
import { ConversationPane } from '../src/conversation/ConversationPane.js'
import { WorkbenchDrawer } from '../src/conversation/WorkbenchDrawer.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { applySnapshot, applyEventFrame, emptyLiveState } from '../src/lib/live-state.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { seedPluginClientModule, resetPluginClientCache } from '../src/lib/plugin-client.js'
import { importWorkflowClientModule, mountSharedPluginNamespaces } from './helpers/workflow-client.js'
import { makeTestStore } from './helpers/store.js'
import { workflowUi } from './helpers/workflow-ui.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
mountSharedPluginNamespaces({ realHooks: true })
const e = React.createElement
const module = await importWorkflowClientModule()
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; resetPluginClientCache() })

function conversation(id: number, status: ConversationSummary['status'] = 'idle'): ConversationSummary {
  return { id, title: `会话 ${id}`, profileId: 'coder', tags: [], cwd: '/tmp', model: '', thinkingLevel: '', status,
    stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0, createdAt: 1, updatedAt: 2 }
}
const plugin: PluginSummary = { id: 'builtin:workflow', name: '工作流', version: '1', enabled: true, locked: false, hooks: [], actions: [], tools: [] }

function seed() {
  seedPluginClientModule('builtin:workflow', 'index.tsx', module)
  globalThis.fetch = async () => new Response('', { headers: { 'x-helm-client-hash': 'seeded' } })
}

function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  return {
    host,
    render: async (store: HelmStoreValue, content: React.ReactNode) => {
      await act(async () => root.render(e(HelmStoreContext.Provider, { value: store }, content)))
    },
    close: async () => { await act(async () => root.unmount()); host.remove() },
  }
}

test('真实共享 hooks 消费 snapshot/plugin.doc.updated：父工具已返回仍展示后台运行，点击保留工作台', { timeout: 60_000 }, async () => {
  seed()
  const parent = conversation(1)
  const child = { ...conversation(11), parentConversationId: 1, parentToolCallId: 'call-bg' }
  const run: WorkflowRunSummary = { id: 'wf_bg', kind: 'subagent', name: '后台任务', conversationId: 1,
    parentToolCallId: 'call-bg', status: 'running', createdAt: 1, updatedAt: 2,
    nodes: [{ id: 'agent', kind: 'agent', status: 'running', conversationId: 11 }] }
  let state = applySnapshot(emptyLiveState(), { seq: 1, conversations: [parent, child], pendingAsks: [], plugins: [plugin], ui: workflowUi,
    pluginDocs: [{ pluginId: plugin.id, name: 'runs', value: { runs: [run] } }] })
  const entries = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-bg', name: 'subagent', arguments: { prompt: '跑后台测试' } }] }] },
    { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call-bg', toolName: 'subagent', content: [{ type: 'text', text: JSON.stringify({ execution: { conversationId: 11 } }) }] }] },
  ]
  const modals: unknown[] = []
  const navigations: unknown[] = []
  const workbenchChanges: boolean[] = []
  const docs: string[] = []
  const store = () => makeTestStore({ ...state, groupedUi: groupUiContributions(state.uiContributions), workbenchOpen: true,
    conversationDetails: { 11: { ...child, entries: [] } },
    ensurePluginDoc: async (_id, doc) => { docs.push(doc); return undefined },
    setActiveModal: (modal) => { modals.push(modal) }, openTarget: (target) => { navigations.push(target) },
    setWorkbenchOpen: (open) => { workbenchChanges.push(open) },
  })
  const ui = mount()
  const timeline = e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })
  try {
    await ui.render(store(), timeline)
    assert.match(ui.host.textContent!, /后台运行中/)
    assert.deepEqual(docs, [], '首帧已直投文档，SDK 不得重新拉取')
    await act(async () => { (ui.host.querySelector('.subagent-card-clickable') as HTMLElement).click() })
    assert.deepEqual(modals, [{ kind: 'conversation-drawer', conversationId: 11 }])
    assert.deepEqual(navigations, [], '不能跳主屏或打开分屏')
    assert.deepEqual(workbenchChanges, [], '不能收起已有工作台')

    state = applyEventFrame(state, { seq: 2, event: { type: 'conversation.upsert', conversation: { ...child, status: 'blocked' } } })
    await ui.render(store(), timeline)
    assert.match(ui.host.textContent!, /等待审批/)
    state = applyEventFrame(state, { seq: 3, event: { type: 'conversation.upsert', conversation: child } })
    state = applyEventFrame(state, { seq: 4, event: { type: 'plugin.doc.updated', doc: { pluginId: plugin.id, name: 'runs', value: { runs: [{ ...run, status: 'failed', error: 'Gate 命令退出码 1' }] } } } })
    await ui.render(store(), timeline)
    assert.match(ui.host.textContent!, /Gate 命令退出码 1/)
    assert.doesNotMatch(ui.host.textContent!, /后台运行中/)

    state = applyEventFrame(state, { seq: 5, event: { type: 'plugin.changed', plugin: { ...plugin, enabled: false }, ui: [] } })
    await ui.render(store(), timeline)
    assert.equal(ui.host.querySelector('.subagent-card-clickable'), null, '停用必须卸载插件 UI')
    assert.deepEqual(state.pluginDocs, {}, '停用必须清文档')
    state = applyEventFrame(state, { seq: 6, event: { type: 'plugin.changed', plugin, ui: workflowUi } })
    state = applyEventFrame(state, { seq: 7, event: { type: 'plugin.doc.updated', doc: { pluginId: plugin.id, name: 'runs', value: { runs: [{ ...run, status: 'completed' }] } } } })
    await ui.render(store(), timeline)
    assert.equal(ui.host.querySelectorAll('.subagent-card-clickable').length, 1)
    assert.match(ui.host.textContent!, /已完成/)
    assert.doesNotMatch(ui.host.textContent!, /Gate 命令退出码 1/)
  } finally { await ui.close() }
})

test('动态工作台按 scope/order/public-doc badge 渲染，首帧前保留深链、确认不可用后回退首个页签', { timeout: 60_000 }, async () => {
  const requested = 'plugin:sample/queue'
  const selections: string[] = []
  const docs: Array<[string, string]> = []
  const panels: PluginUiContribution[] = [
    { pluginId: 'sample', surface: 'workbench.panel', spec: { id: 'late', label: '后置面板', order: 30, json: { root: 'text', elements: { text: { type: 'Text', props: { text: '后置内容' } } } } } },
    { pluginId: 'sample', surface: 'workbench.panel', spec: { id: 'hidden', label: '其他档案', order: 0, scope: { profileIds: ['other'] }, badge: { doc: 'hidden', countField: 'count' }, json: {} } },
    { pluginId: 'sample', surface: 'workbench.panel', spec: { id: 'queue', label: '动态队列', order: 10, badge: { doc: 'stats', byConversationField: 'byConversation' }, json: { root: 'text', elements: { text: { type: 'Text', props: { text: '队列内容' } } } } } },
  ]
  let store = makeTestStore({ sseConnected: false, workbenchTab: requested, setWorkbenchTab: (tab) => { selections.push(tab) },
    ensurePluginDoc: async (id, doc) => { docs.push([id, doc]); return undefined } })
  const ui = mount()
  try {
    await ui.render(store, e(WorkbenchDrawer, { conversationId: 1 }))
    assert.deepEqual(selections, [], '初始快照前不能覆盖请求的合法深链')
    const conv = conversation(1)
    store = { ...store, sseConnected: true, conversations: [conv], groupedUi: groupUiContributions(panels),
      pluginDocs: { 'sample/stats': { byConversation: { '1': { count: 3, tone: 'warn', footerText: '3 项待处理' } } }, 'sample/hidden': { count: 100 } } }
    await ui.render(store, e(WorkbenchDrawer, { conversationId: 1 }))
    assert.deepEqual(selections, [], '快照到达后有效深链仍然有效')
    const labels = [...ui.host.querySelectorAll('.tab-btn')].map((button) => button.textContent)
    assert.deepEqual(labels, ['动态队列', '产物 (0)', '后置面板'])
    assert.match(ui.host.textContent!, /3 项待处理/)
    assert.doesNotMatch(ui.host.textContent!, /其他档案/)
    assert.ok(!docs.some(([, doc]) => doc === 'hidden'), '不可见面板不应加载角标文档')

    await ui.render(store, e(ConversationPane, { conversationId: 1 }))
    const workbench = [...ui.host.querySelectorAll('button')].find((button) => button.textContent?.includes('工作台'))
    assert.ok(workbench)
    assert.match(workbench.textContent!, /3/)
    assert.doesNotMatch(workbench.textContent!, /103/, '顶栏必须与抽屉使用同一 scope')

    store = { ...store, workbenchTab: 'plugin:sample/removed' }
    await ui.render(store, e(WorkbenchDrawer, { conversationId: 1 }))
    assert.deepEqual(selections, [requested], '不可用页签应回退排序后的首个可用页签，而非硬编码 artifacts')
    assert.match(ui.host.querySelector('.tab-btn-active')?.textContent ?? '', /动态队列/)
    store = { ...store, groupedUi: groupUiContributions([]) }
    await ui.render(store, e(WorkbenchDrawer, { conversationId: 1 }))
    assert.deepEqual(selections, [requested, 'artifacts'])
    assert.doesNotMatch(ui.host.textContent!, /动态队列|3 项待处理/)
  } finally { await ui.close() }
})
