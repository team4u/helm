import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationSummary, PluginSummary, PluginUiContribution, WorkflowRunSummary } from '@helm/protocol'
import { ConversationTimeline } from '../src/conversation/ConversationTimeline.js'
import { ConversationPane } from '../src/conversation/ConversationPane.js'
import { WorkbenchDrawer } from '../src/conversation/WorkbenchDrawer.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { applySnapshot, applyEventFrame, emptyLiveState } from '../src/lib/live-state.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { seedPluginClientModule, resetPluginClientCache } from '../src/lib/plugin-client.js'
import { resetSessionDocSubscriptions } from '../src/lib/session-docs.js'
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

/**
 * mock 会话文档订阅（runs 分片）：初始 GET 返回 runs，SSE 事件流提供空挂起流
 * （不推送增量；测试经重渲染注入新快照）。
 */
function seedSessionRuns(runs: () => unknown): void {
  seedPluginClientModule('builtin:workflow', 'index.tsx', module)
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/docs/runs?conversationId=')) {
      return new Response(JSON.stringify({ pluginId: 'builtin:workflow', name: 'runs', conversationId: 1, value: { runs: runs() } }),
        { headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/docs/runs/events?conversationId=')) {
      return new Response(new ReadableStream({ start() { /* 挂起空流：不推送帧 */ } }),
        { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('', { headers: { 'x-helm-client-hash': 'seeded' } })
  }
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
  let runsValue: unknown = []
  seedSessionRuns(() => runsValue)
  const parent = conversation(1)
  const child = { ...conversation(11), parentConversationId: 1, parentToolCallId: 'call-bg' }
  const run: WorkflowRunSummary = { id: 'wf_bg', kind: 'subagent', name: '后台任务', conversationId: 1,
    parentToolCallId: 'call-bg', status: 'running', createdAt: 1, updatedAt: 2,
    nodes: [{ id: 'agent', kind: 'agent', status: 'running', conversationId: 11 }] }
  runsValue = [run]
  let state = applySnapshot(emptyLiveState(), { seq: 1, conversations: [parent, child], pendingAsks: [], plugins: [plugin], ui: workflowUi })
  const entries = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-bg', name: 'subagent', arguments: { prompt: '跑后台测试' } }] }] },
    { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call-bg', toolName: 'subagent', content: [{ type: 'text', text: JSON.stringify({ execution: { conversationId: 11 } }) }] }] },
    { id: '3', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '后台任务已提交' }], stopReason: 'stop' }] },
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
    assert.ok(ui.host.querySelector('.msg-ai-block .msg-hover-bar') === null, 'done 工具的 run.running 仍隐藏复制/分叉')
    assert.deepEqual(docs, [], '首帧已直投文档，SDK 不得重新拉取')
    await act(async () => { (ui.host.querySelector('.subagent-card-clickable') as HTMLElement).click() })
    assert.deepEqual(modals, [{ kind: 'conversation-drawer', conversationId: 11 }])
    assert.deepEqual(navigations, [], '不能跳主屏或打开分屏')
    assert.deepEqual(workbenchChanges, [], '不能收起已有工作台')

    state = applyEventFrame(state, { seq: 2, event: { type: 'conversation.upsert', conversation: { ...child, status: 'blocked' } } })
    await ui.render(store(), timeline)
    assert.match(ui.host.textContent!, /等待审批/)
    assert.ok(ui.host.querySelector('.msg-ai-block .msg-hover-bar') === null, 'blocked 子会话仍隐藏复制/分叉')
    state = applyEventFrame(state, { seq: 3, event: { type: 'conversation.upsert', conversation: child } })
    // runs 已改会话分片：终态经 seedSessionRuns 注入的新值到达（下次订阅拉取）。
    runsValue = [{ ...run, status: 'failed', error: 'Gate 命令退出码 1' }]
    await act(async () => { resetSessionDocSubscriptions() })
    await ui.render(store(), timeline)
    assert.match(ui.host.textContent!, /Gate 命令退出码 1/)
    assert.doesNotMatch(ui.host.textContent!, /后台运行中/)
    assert.ok(ui.host.querySelector('.msg-ai-block .msg-hover-bar'), '后台终态后恢复复制/分叉')

    state = applyEventFrame(state, { seq: 4, event: { type: 'plugin.changed', plugin: { ...plugin, enabled: false }, ui: [] } })
    await ui.render(store(), timeline)
    assert.equal(ui.host.querySelector('.subagent-card-clickable'), null, '停用必须卸载插件 UI')
    assert.deepEqual(state.pluginDocs, {}, '停用必须清文档')
    state = applyEventFrame(state, { seq: 5, event: { type: 'plugin.changed', plugin, ui: workflowUi } })
    // 重启用后经会话分片到达 completed 终态。
    runsValue = [{ ...run, status: 'completed' }]
    await act(async () => { resetSessionDocSubscriptions() })
    await ui.render(store(), timeline)
    assert.equal(ui.host.querySelectorAll('.subagent-card-clickable').length, 1)
    assert.match(ui.host.textContent!, /已完成/)
    assert.doesNotMatch(ui.host.textContent!, /Gate 命令退出码 1/)
  } finally { await ui.close() }
})

function settledEntries(callId: string, toolName: string, start = 1, input: unknown = {}, result = '已提交'): ConversationEntry[] {
  return [
    { id: String(start), kind: 'helm.input', data: { text: '执行任务', origin: 'human' } },
    { id: String(start + 1), kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: toolName, arguments: input }] }] },
    { id: String(start + 2), kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: callId, toolName, content: [{ type: 'text', text: result }] }] },
    { id: String(start + 3), kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '任务已提交，可等待后台完成' }], stopReason: 'stop' }] },
  ]
}

test('真实子会话 working/blocked 独立报告后台活动；静态工具结果不伪造活动', { timeout: 60_000 }, async () => {
  seed()
  const ui = mount()
  const parent = conversation(1)
  const child = { ...conversation(11), parentConversationId: 1, parentToolCallId: 'child-call' }
  const timeline = e(ConversationTimeline, { conversation: parent, detailEntries: settledEntries('child-call', 'subagent'), onRequestEdit: () => {} })
  try {
    for (const status of ['working', 'blocked', 'idle', 'done', 'error'] as const) {
      await ui.render(makeTestStore({ conversations: [parent, { ...child, status }],
        conversationDetails: { 11: { ...child, entries: [] } }, groupedUi: groupUiContributions(workflowUi),
        pluginDocs: { 'builtin:workflow/runs': { runs: [] } },
      }), timeline)
      assert.equal(ui.host.querySelector('.msg-ai-block .msg-hover-bar') === null, status === 'working' || status === 'blocked', `子会话 ${status} 应如实决定复制/分叉状态`)
    }
    // 没有任何真实 run/child，即使输出字符串含 running，也不把静态文本推断成活动。
    await ui.render(makeTestStore({ conversations: [parent], groupedUi: groupUiContributions(workflowUi), pluginDocs: { 'builtin:workflow/runs': { runs: [] } } }),
      e(ConversationTimeline, { conversation: parent, detailEntries: settledEntries('unknown', 'subagent', 1, {}, '{"status":"running"}'), onRequestEdit: () => {} }))
    assert.ok(ui.host.querySelector('.msg-ai-block .msg-hover-bar'))
  } finally { await ui.close() }
})

test('WorkflowToolView 与无 nativechild 的外部 subagent 按真实 run.running 报告活动，终态和停用释放', { timeout: 60_000 }, async () => {
  seed()
  const ui = mount()
  const parent = conversation(1)
  try {
    for (const toolName of ['SubagentWorkflow', 'subagent']) {
      const callId = `${toolName}-call`
      const run: WorkflowRunSummary = { id: `run-${toolName}`, kind: toolName === 'subagent' ? 'subagent' : 'workflow',
        name: '真实后台运行', conversationId: 1, parentToolCallId: callId, status: 'running', createdAt: 1, updatedAt: 2,
        nodes: [{ id: 'external', kind: 'agent', status: 'running', executionId: 'pane-42' }],
      }
      const timeline = e(ConversationTimeline, { conversation: parent, detailEntries: settledEntries(callId, toolName), onRequestEdit: () => {} })
      let shardStatus: WorkflowRunSummary['status'] = 'running'
      seedSessionRuns(() => [{ ...run, status: shardStatus }])
      const store = (status: WorkflowRunSummary['status'], enabled = true) => {
        shardStatus = status
        return makeTestStore({ conversations: [parent], groupedUi: groupUiContributions(enabled ? workflowUi : []) })
      }
      await ui.render(store('running'), timeline)
      assert.ok(ui.host.querySelector('.msg-ai-block .msg-hover-bar') === null, `${toolName} done 工具仍有后台活动`)
      for (const status of ['failed', 'aborted', 'completed'] as const) {
        await ui.render(store(status), timeline)
        await act(async () => { resetSessionDocSubscriptions() })
        await ui.render(store(status), timeline)
        assert.ok(ui.host.querySelector('.msg-ai-block .msg-hover-bar'), `${toolName} ${status} 必须释放活动`)
      }
      await ui.render(store('running'), timeline)
      await act(async () => { resetSessionDocSubscriptions() })
      await ui.render(store('running'), timeline)
      assert.ok(ui.host.querySelector('.msg-ai-block .msg-hover-bar') === null)
      await ui.render(store('running', false), timeline)
      assert.ok(ui.host.querySelector('.msg-ai-block .msg-hover-bar'), '停用 renderer 必须释放正在运行的来源')
      await ui.render(store('completed'), timeline)
      assert.ok(ui.host.querySelector('.msg-ai-block .msg-hover-bar'), '重启插件不保留旧 busy')
    }
  } finally { await ui.close() }
})

test('resume 仅最新调用报告活动；旧卡由活跃转历史或卸载不能清除新卡登记', { timeout: 60_000 }, async () => {
  seed()
  const ui = mount()
  const parent = conversation(1)
  const child = { ...conversation(11, 'working'), parentConversationId: 1, parentToolCallId: 'old-call' }
  const oldRun: WorkflowRunSummary = { id: 'old-run', kind: 'subagent', name: '首次运行', conversationId: 1,
    parentToolCallId: 'old-call', status: 'running', createdAt: 1, updatedAt: 2, nodes: [{ id: 'agent', kind: 'agent', status: 'running', conversationId: 11 }],
  }
  const oldEntries = settledEntries('old-call', 'subagent', 1, {}, JSON.stringify({ execution: { conversationId: 11 } }))
  const newEntries = settledEntries('new-call', 'subagent', 5, { resume: 11, prompt: '继续任务' }, JSON.stringify({ execution: { conversationId: 11 } }))
  const store = (resumed: boolean, status: ConversationSummary['status'] = 'working') => makeTestStore({
    conversations: [parent, { ...child, status, parentToolCallId: resumed ? 'new-call' : 'old-call' }],
    groupedUi: groupUiContributions(workflowUi), conversationDetails: { 11: { ...child, entries: [] } },
    // 保留旧 run.running 验证最新调用不会被旧 run 污染。
    pluginDocs: { 'builtin:workflow/runs': { runs: [oldRun] } },
  })
  const timeline = (entries: ConversationEntry[]) => e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })
  const bars = () => [...ui.host.querySelectorAll('.msg-ai-block')].map((turn) => turn.querySelector('.msg-hover-bar') !== null)
  try {
    await ui.render(store(false), timeline(oldEntries))
    assert.deepEqual(bars(), [false], '原调用初次挂载时确实上报活动')
    await ui.render(store(true), timeline([...oldEntries, ...newEntries]))
    assert.deepEqual(bars(), [true, false], '续接后仅最新调用 busy；历史回合恢复操作条')
    assert.equal(ui.host.querySelectorAll('.subagent-card-clickable').length, 1)
    assert.match(ui.host.textContent!, /已在下文续接/)
    await ui.render(store(true), timeline(newEntries))
    assert.deepEqual(bars(), [false], '移除旧卡不会误删最新调用的登记')
    await ui.render(store(true, 'blocked'), timeline(newEntries))
    assert.deepEqual(bars(), [false])
    await ui.render(store(true, 'idle'), timeline(newEntries))
    assert.deepEqual(bars(), [true], '新调用终态即释放，旧 run.running 不得污染新调用')
  } finally { await ui.close() }
})

test('外部 executionId 续接仅最新调用上报活动，不能编造 nativechild 关联', { timeout: 60_000 }, async () => {
  seed()
  const ui = mount()
  const parent = conversation(1)
  const run: WorkflowRunSummary = { id: 'external-old', kind: 'subagent', name: '外部任务', conversationId: 1,
    parentToolCallId: 'ext-old', status: 'running', createdAt: 1, updatedAt: 2,
    nodes: [{ id: 'agent', kind: 'agent', status: 'running', executionId: 'pane-42' }],
  }
  const oldEntries = settledEntries('ext-old', 'subagent', 1, {}, JSON.stringify({ execution: { executionId: 'pane-42' } }))
  const newEntries = settledEntries('ext-new', 'subagent', 5, { resume: 'pane-42' })
  const timeline = e(ConversationTimeline, { conversation: parent, detailEntries: [...oldEntries, ...newEntries], onRequestEdit: () => {} })
  try {
    let extStatus: WorkflowRunSummary['status'] = 'running'
    seedSessionRuns(() => [run, { ...run, id: 'external-new', parentToolCallId: 'ext-new', status: extStatus }])
    const store = (status: WorkflowRunSummary['status']) => {
      extStatus = status
      return makeTestStore({ conversations: [parent], groupedUi: groupUiContributions(workflowUi) })
    }
    await ui.render(store('running'), timeline)
    const bars = () => [...ui.host.querySelectorAll('.msg-ai-block')].map((turn) => turn.querySelector('.msg-hover-bar') !== null)
    assert.deepEqual(bars(), [true, false])
    assert.equal(ui.host.querySelectorAll('.subagent-card-clickable').length, 0)
    await ui.render(store('completed'), timeline)
    await act(async () => { resetSessionDocSubscriptions() })
    await ui.render(store('completed'), timeline)
    assert.deepEqual(bars(), [true, true], '旧外部 run.running 不能让已续接完成的旧调用重新 busy')
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
