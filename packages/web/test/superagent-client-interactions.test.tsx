/**
 * builtin:superagent 插件 client 组件测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * 覆盖六个面板：composerWidget 态势 / composerPill 路由开关 / toolView 派工卡 /
 * timelineRenderer 汇报卡 / screen 图谱 / settingsPanel 托管状态。
 * 数据经 stub 的 usePluginDoc 构造；动作与导航经 spy ctx 断言真实调用。
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  ComposerScopeProps,
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  ScreenProps,
  TimelineRendererProps,
  ToolViewProps,
} from '@helm/protocol'
import { PluginClientContext } from '../src/lib/plugin-client-context.js'
import { importBuiltinClientModule, mountSharedPluginNamespaces, setBuiltinClientStub } from './helpers/builtin-clients.js'

const e = React.createElement

GlobalRegistrator.register()
mountSharedPluginNamespaces()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

interface Components {
  SuperAgentComposerWidget: (p: ComposerScopeProps) => React.ReactElement
  SuperAgentRouterModePill: (p: ComposerScopeProps) => React.ReactElement
  SuperAgentDispatchToolView: (p: Partial<ToolViewProps>) => React.ReactElement
  SuperAgentWorkerReportCard: (p: TimelineRendererProps) => React.ReactElement
  SuperAgentRecallScreen: (p: Partial<ScreenProps>) => React.ReactElement
  SuperAgentSettingsPanel: () => React.ReactElement
}

let components: Components

before(async () => {
  const mod = await importBuiltinClientModule('builtin:superagent')
  components = {
    SuperAgentComposerWidget: mod['SuperAgentComposerWidget'] as Components['SuperAgentComposerWidget'],
    SuperAgentRouterModePill: mod['SuperAgentRouterModePill'] as Components['SuperAgentRouterModePill'],
    SuperAgentDispatchToolView: mod['SuperAgentDispatchToolView'] as Components['SuperAgentDispatchToolView'],
    SuperAgentWorkerReportCard: mod['SuperAgentWorkerReportCard'] as Components['SuperAgentWorkerReportCard'],
    SuperAgentRecallScreen: mod['SuperAgentRecallScreen'] as Components['SuperAgentRecallScreen'],
    SuperAgentSettingsPanel: mod['SuperAgentSettingsPanel'] as Components['SuperAgentSettingsPanel'],
  }
}, { timeout: 60_000 })

interface SpyCtx extends PluginClientContextType {
  screenCalls: string[]
  splitCalls: string[]
  actionCalls: Array<{ actionId: string; input: unknown }>
  artifactCalls: string[]
  notifyCalls: Array<{ message: string; tone?: string }>
}

function makeSpyCtx(overrides: Partial<SpyCtx> = {}): SpyCtx {
  const screenCalls: string[] = []
  const splitCalls: string[] = []
  const actionCalls: Array<{ actionId: string; input: unknown }> = []
  const artifactCalls: string[] = []
  const notifyCalls: Array<{ message: string; tone?: string }> = []
  const base: PluginClientContextType = {
    pluginId: 'builtin:superagent',
    callAction: async (actionId, input) => {
      actionCalls.push({ actionId, input })
      return {}
    },
    submitInput: async () => {},
    openScreen: (t) => {
      screenCalls.push(t)
    },
    openSplitScreen: (t) => {
      splitCalls.push(t)
    },
    openConversationDrawer: () => {},
    openArtifact: (id) => {
      artifactCalls.push(id)
    },
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: (message, tone) => {
      notifyCalls.push({ message, tone })
    },
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    conversationId: 1,
    theme: 'dark',
  }
  return Object.assign(base, { screenCalls, splitCalls, actionCalls, artifactCalls, notifyCalls, ...overrides })
}

async function mount(
  ctx: PluginClientContextType,
  element: React.ReactElement,
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(PluginClientContext.Provider, { value: ctx }, element))
  })
  await act(async () => {})
  return {
    host,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

function composerProps(): ComposerScopeProps {
  const conversation = {
    id: 1, title: '中枢', profileId: 'superagent', tags: [], cwd: '/tmp', model: '', thinkingLevel: '',
    status: 'idle', stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0,
    createdAt: 0, updatedAt: 0,
  } as ConversationSummary
  return { conversation, composer: { draft: '', attachments: [], sending: false, setDraft: () => {}, insertText: () => {}, submit: async () => {} } }
}

const INDEX_DOC = {
  version: 1,
  routerConversationId: 7,
  watchdogConversationId: 8,
  workers: [
    { conversationId: 11, parentConversationId: 7, profileId: 'coder', createdAt: Date.now() },
    { conversationId: 12, parentConversationId: 7, profileId: 'writer', createdAt: Date.now() },
  ],
}

const SUBSCRIPTIONS_DOC = {
  version: 1,
  subscriptions: [{ threadKey: 'ci/main', workerConversationId: 11, createdAt: Date.now() }],
}

const RECALL_DOC = {
  version: 1,
  nodes: [
    { id: '11:1', conversationId: 11, profileId: 'coder', completionSeq: 1, outcome: 'completed', summary: '修复构建并跑通测试', artifacts: [], keywords: [], createdAt: Date.now() },
    { id: '12:1', conversationId: 12, profileId: 'writer', completionSeq: 1, outcome: 'failed', summary: '写作失败：模型拒绝', artifacts: [], keywords: [], createdAt: Date.now() },
  ],
}

before(() => {
  setBuiltinClientStub({
    docs: {
      index: INDEX_DOC,
      subscriptions: SUBSCRIPTIONS_DOC,
      'recall-graph': RECALL_DOC,
      routing: { version: 1, routerMode: true },
    },
  })
})

test('composerWidget：态势计数、Worker 表与打开导航', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(spy, e(components.SuperAgentComposerWidget, composerProps()))
  try {
    assert.match(host.textContent ?? '', /中枢态势/, '标题渲染')
    assert.match(host.textContent ?? '', /活跃 Worker 2 个/, 'Worker 计数')
    assert.match(host.textContent ?? '', /事件订阅 1 条/, '订阅计数')
    assert.match(host.textContent ?? '', /#11/, 'Worker 行 11')
    assert.match(host.textContent ?? '', /#12/, 'Worker 行 12')
    const open = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('打开'))
    assert.ok(open, '行内有打开按钮')
    await act(async () => {
      open!.click()
    })
    assert.deepEqual(spy.screenCalls, ['conversation:11'], '打开动作导航到会话')
  } finally {
    unmount()
  }
})

test('composerWidget：doc 未到达时展示加载态而非空白', { timeout: 60_000 }, async () => {
  setBuiltinClientStub({ docs: { index: undefined, subscriptions: undefined } })
  try {
    const spy = makeSpyCtx()
    const { host, unmount } = await mount(spy, e(components.SuperAgentComposerWidget, composerProps()))
    try {
      assert.match(host.textContent ?? '', /态势读取中/, '加载态展示')
    } finally {
      unmount()
    }
  } finally {
    setBuiltinClientStub({
      docs: { index: INDEX_DOC, subscriptions: SUBSCRIPTIONS_DOC, 'recall-graph': RECALL_DOC, routing: { version: 1, routerMode: true } },
    })
  }
})

test('composerPill：开关渲染当前值并触发 set_router_mode 动作', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(spy, e(components.SuperAgentRouterModePill, composerProps()))
  try {
    const sw = host.querySelector('[role="switch"]') as HTMLElement | null
    assert.ok(sw, '渲染 Switch 原语')
    assert.equal(sw!.getAttribute('aria-checked'), 'true', 'routerMode=true 反映到开关')
    await act(async () => {
      sw!.click()
    })
    assert.deepEqual(
      spy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
      [{ actionId: 'set_router_mode', input: { enabled: false } }],
      '点击触发 set_router_mode(false)',
    )
  } finally {
    unmount()
  }
})

test('toolView：派工卡展示 Worker 表并支持归档动作', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(
    spy,
    e(components.SuperAgentDispatchToolView, {
      callId: 'call-1', toolName: 'dispatch_worker',
      input: { prompt: '去修构建', profileId: 'coder' },
      status: 'done', result: { workerConversationId: 11 }, structuredOutput: { workerConversationId: 11 },
      conversationId: 7,
    }),
  )
  try {
    assert.match(host.textContent ?? '', /后台 Worker 派工/, '标题')
    assert.match(host.textContent ?? '', /已派工 Worker #11/, '派工结果')
    assert.match(host.textContent ?? '', /Profile coder/, '输入摘要')
    const archive = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('归档'))
    assert.ok(archive, '归档按钮存在')
    await act(async () => {
      archive!.click()
    })
    assert.deepEqual(
      spy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
      [{ actionId: 'archive_worker', input: { workerConversationId: 11 } }],
      '归档触发 archive_worker',
    )
  } finally {
    unmount()
  }
})

test('timelineRenderer：汇报卡展示摘要/终态/产物并支持分屏打开', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(
    spy,
    e(components.SuperAgentWorkerReportCard, {
      entry: {
        id: 'entry-1', kind: 'helm.input',
        data: {
          meta: {
            renderer: 'superagent:worker-report', workerId: 11, profileId: 'coder',
            outcome: 'completed', completionSeq: 1, summary: '修复完成，全部测试通过',
            artifacts: [{ id: 'art-1', name: 'report.md', size: 128 }],
          },
        },
      },
      conversationId: 7,
    }),
  )
  try {
    assert.match(host.textContent ?? '', /Worker 汇报/, '徽章')
    assert.match(host.textContent ?? '', /修复完成，全部测试通过/, '摘要文本')
    assert.match(host.textContent ?? '', /completed/, '终态徽章')
    const artifactBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('report.md'))
    assert.ok(artifactBtn, '产物按钮存在')
    await act(async () => {
      artifactBtn!.click()
    })
    assert.deepEqual(spy.artifactCalls, ['art-1'], '产物点击打开预览')
    const splitBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('在右屏并排打开'))
    assert.ok(splitBtn, '分屏按钮存在')
    await act(async () => {
      splitBtn!.click()
    })
    assert.deepEqual(spy.splitCalls, ['conversation:11'], '分屏打开 Worker 会话')
  } finally {
    unmount()
  }
})

test('screen：图谱视图渲染 recall 节点与事件订阅两张表', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  let setParamsCalls = 0
  const { host, unmount } = await mount(
    spy,
    e(components.SuperAgentRecallScreen, {
      pluginId: 'builtin:superagent', screenId: 'recall-graph', isSplit: false, params: {},
      setParams: () => {
        setParamsCalls += 1
      },
    }),
  )
  try {
    assert.match(host.textContent ?? '', /RecallGraph 记忆图谱/, '标题')
    assert.match(host.textContent ?? '', /修复构建并跑通测试/, 'recall 摘要行')
    assert.match(host.textContent ?? '', /写作失败：模型拒绝/, '第二个节点')
    assert.match(host.textContent ?? '', /事件订阅/, '订阅区块标题')
    assert.match(host.textContent ?? '', /ci\/main/, 'threadKey 行')
    assert.match(host.textContent ?? '', /节点 2 · 订阅 1/, '统计')
    const openConv = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('打开会话'))
    assert.ok(openConv, '打开会话按钮')
    await act(async () => {
      openConv!.click()
    })
    assert.deepEqual(spy.screenCalls, ['conversation:11'], '打开 recall 会话')
    const openWorker = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('打开 Worker'))
    await act(async () => {
      openWorker!.click()
    })
    assert.deepEqual(spy.screenCalls, ['conversation:11', 'conversation:11'], '打开订阅 Worker')
    assert.equal(setParamsCalls, 0, '纯展示不写屏参数')
  } finally {
    unmount()
  }
})

test('settingsPanel：只读展示中枢/看门狗托管会话', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(spy, e(components.SuperAgentSettingsPanel, {}))
  try {
    assert.match(host.textContent ?? '', /SuperAgent 中枢/, '标题')
    assert.match(host.textContent ?? '', /中枢会话/, 'KV 键')
    assert.match(host.textContent ?? '', /#7/, '中枢会话值')
    assert.match(host.textContent ?? '', /看门狗会话/, 'KV 键')
    assert.match(host.textContent ?? '', /#8/, '看门狗会话值')
    assert.match(host.textContent ?? '', /只读展示托管状态/, '配置引导文案')
    assert.equal(spy.actionCalls.length, 0, '只读面板不触发动作')
  } finally {
    unmount()
  }
})
