/**
 * 后台结算汇报折叠展示测试（builtin:workflow 真实 client 编译产物 + Web 核心）。
 *
 * 覆盖：
 * 1. 纯解析 model-background-report：string/JSON result（null/false/0/空串不丢）、
 *    failed/aborted、无 execution、runId 不一致/非法终态/损坏输入 → invalid；
 * 2. BackgroundReportCard DOM（复用 ExecutionCard 共用框架 subagent-live-card/
 *    header/trigger/actions/subline）：默认收起（短标题/终态徽章/单行预览，
 *    runId 仅悬浮提示，复制为图标动作），展开挂载完整 result、失败折叠态直接
 *    见错误、复制原文实写入剪贴板、子会话导航不触发折叠、损坏显式
 *    “汇报数据格式异常”且可展开复制原文；
 * 3. 宿主派发：timelineRenderers（helpers/workflow-ui.ts 同步注册）按
 *    matchMeta.renderer 精确接管 helm.input，未标记输入不受影响；
 * 4. 排队中的非人类长文本通用折叠（HumanMessage）：agent 长文折叠可展开/收起、
 *    复制全文入口保留；human 输入与短文本不受影响。
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  TimelineRendererProps,
} from '@helm/protocol'
import { PluginClientContext } from '../src/lib/plugin-client-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { emptyLiveState } from '../src/lib/live-state.js'
import { getSessionDocState, subscribeSessionDoc } from '../src/lib/session-docs.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { buildTimelineItems, queuedAgentTextCollapse } from '../src/conversation/timeline-model.js'
import { workflowUi } from './helpers/workflow-ui.js'
import { importWorkflowClientModule, mountSharedPluginNamespaces } from './helpers/workflow-client.js'
import type {
  BackgroundReportParse,
} from '../../kernel/src/builtin-plugins/workflow/client/model-background-report.ts'

const e = React.createElement

GlobalRegistrator.register()
mountSharedPluginNamespaces()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
// 与现有 SSR 测试一致：为 tsx 的 classic JSX 转换提供 React。
;(globalThis as Record<string, unknown>).React = React

interface Model {
  parseBackgroundReportEntry: (entry: ConversationEntry) => BackgroundReportParse
  backgroundReportPreview: (view: Extract<BackgroundReportParse, { invalid: false }>, maxChars: number) => string
}

let model: Model
let BackgroundReportCard: (props: TimelineRendererProps) => React.ReactElement

before(async () => {
  model = (await importWorkflowClientModule('model-background-report.ts')) as unknown as Model
  const client = await importWorkflowClientModule()
  BackgroundReportCard = client['BackgroundReportCard'] as typeof BackgroundReportCard
}, { timeout: 60_000 })

// ---------------------------------------------------------------------------
// 构造工具
// ---------------------------------------------------------------------------

interface ReportOverrides {
  kind?: 'subagent_report' | 'workflow_report'
  runId?: string
  report?: Record<string, unknown>
  meta?: Record<string, unknown>
  text?: string
}

function makeReportEntry(overrides: ReportOverrides = {}, entryId = '51'): ConversationEntry {
  const runId = overrides.runId ?? 'wf_abc123'
  const kind = overrides.kind ?? 'subagent_report'
  const report = {
    runId,
    status: 'completed',
    otherRunningTasks: [],
    ...overrides.report,
  }
  return {
    id: entryId,
    kind: 'helm.input',
    data: {
      id: `helm:subagent-report:${runId}`,
      text:
        overrides.text ??
        `后台子代理任务已结算。以下为运行 ${runId} 的结果数据（仅代表本次任务；otherRunningTasks 是投递时其余在途运行的快照）：\n${JSON.stringify(report)}`,
      origin: 'agent',
      createdAt: 100,
      meta: { backgroundRunId: runId, kind, renderer: 'workflow:background-report', ...overrides.meta },
    },
  }
}

function drawerSpy(): { ctx: PluginClientContextType; calls: number[] } {
  const calls: number[] = []
  const ctx = {
    pluginId: 'builtin:workflow',
    callAction: async () => ({}),
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: (id: number) => {
      calls.push(id)
    },
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: () => {},
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    conversationId: 1,
    theme: 'dark',
  } as unknown as PluginClientContextType
  return { ctx, calls }
}

async function mountCard(
  entry: ConversationEntry,
  ctx: PluginClientContextType,
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(PluginClientContext.Provider, { value: ctx }, e(BackgroundReportCard, { entry, conversationId: 1 })))
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

function clickButton(host: HTMLElement, label: string): void {
  const btn = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  assert.ok(btn, `应存在 aria-label=${label} 的按钮`)
  act(() => btn.click())
}

/** 捕获 navigator.clipboard.writeText 写入内容（真实 CopyButton → copyToClipboard）。 */
async function withCapturedClipboard(run: (captured: string[]) => Promise<void>): Promise<void> {
  const captured: string[] = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text: string) => { captured.push(text) } } },
    configurable: true,
    writable: true,
  })
  try {
    await run(captured)
  } finally {
    if (original !== undefined) Object.defineProperty(globalThis, 'navigator', original)
  }
}

// ---------------------------------------------------------------------------
// 1. 纯解析：result 语义 / 终态 / 损坏输入
// ---------------------------------------------------------------------------

test('parse: string 与 JSON result 均保留（null/false/0/空串不丢）', { timeout: 60_000 }, () => {
  const cases: Array<{ result: unknown; expect: unknown }> = [
    { result: '纯文本结论', expect: '纯文本结论' },
    { result: { done: true, n: 2 }, expect: { done: true, n: 2 } },
    { result: null, expect: null },
    { result: false, expect: false },
    { result: 0, expect: 0 },
    { result: '', expect: '' },
  ]
  for (const c of cases) {
    const view = model.parseBackgroundReportEntry(makeReportEntry({ report: { result: c.result, status: 'completed' } }))
    assert.equal(view.invalid, false, `result=${JSON.stringify(c.result)} 应解析成功`)
    if (!view.invalid) {
      assert.equal(view.hasResult, true)
      assert.deepEqual(view.result, c.expect)
    }
  }
  // 未携带 result 键：hasResult=false（区别于 result:null）。
  const none = model.parseBackgroundReportEntry(makeReportEntry({ report: {} }))
  assert.equal(none.invalid, false)
  if (!none.invalid) assert.equal(none.hasResult, false)
})

test('parse: failed/aborted 终态、error、execution、otherRunningTasks、meta 一致性', { timeout: 60_000 }, () => {
  const failed = model.parseBackgroundReportEntry(
    makeReportEntry({
      kind: 'workflow_report',
      report: {
        status: 'failed',
        error: 'gate 校验未通过',
        otherRunningTasks: [{ runId: 'wf_x', name: '并行任务', kind: 'workflow' }],
      },
    }),
  )
  assert.equal(failed.invalid, false)
  if (!failed.invalid) {
    assert.equal(failed.kind, 'workflow_report')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error, 'gate 校验未通过')
    assert.equal(failed.executionConversationId, undefined)
    assert.deepEqual(failed.otherRunningTasks, [{ runId: 'wf_x', name: '并行任务', kind: 'workflow' }])
  }

  const aborted = model.parseBackgroundReportEntry(makeReportEntry({ report: { status: 'aborted', error: '被中止' } }))
  assert.equal(aborted.invalid, false)
  if (!aborted.invalid) assert.equal(aborted.status, 'aborted')

  const withExec = model.parseBackgroundReportEntry(
    makeReportEntry({ report: { status: 'completed', execution: { conversationId: 7, executionId: 9 } } }),
  )
  assert.equal(withExec.invalid, false)
  if (!withExec.invalid) assert.equal(withExec.executionConversationId, 7)

  // runId 与 meta 不一致 / 非法终态 / execution.conversationId 非正整数 / 快照项缺字段。
  assert.equal(model.parseBackgroundReportEntry(makeReportEntry({ report: { runId: 'wf_other' } })).invalid, true)
  assert.equal(model.parseBackgroundReportEntry(makeReportEntry({ report: { status: 'running' } })).invalid, true)
  assert.equal(
    model.parseBackgroundReportEntry(makeReportEntry({ report: { execution: { conversationId: 0 } } })).invalid,
    true,
  )
  assert.equal(
    model.parseBackgroundReportEntry(makeReportEntry({ report: { otherRunningTasks: [{ runId: 'wf_x' }] } })).invalid,
    true,
  )
})

test('parse: 损坏正文（无换行/非法 JSON/meta 缺失）返回 invalid 且保留原文', { timeout: 60_000 }, () => {
  const noNewline = model.parseBackgroundReportEntry(
    makeReportEntry({ text: '只有引导语没有 JSON' }),
  )
  assert.equal(noNewline.invalid, true)
  if (noNewline.invalid) assert.equal(noNewline.rawText, '只有引导语没有 JSON')

  const badJson = model.parseBackgroundReportEntry(
    makeReportEntry({ text: '引导语\n{不是 JSON' }),
  )
  assert.equal(badJson.invalid, true)
  if (badJson.invalid) assert.ok(badJson.rawText.includes('{不是 JSON'))

  assert.equal(model.parseBackgroundReportEntry(makeReportEntry({ meta: { kind: 'other' } })).invalid, true)
})

test('preview: 完成看结果首行；失败优先错误且截断', { timeout: 60_000 }, () => {
  const done = model.parseBackgroundReportEntry(makeReportEntry({ report: { result: 'abcdefgh\nsecond' } }))
  if (!done.invalid) {
    assert.equal(model.backgroundReportPreview(done, 120), 'abcdefgh')
    assert.equal(model.backgroundReportPreview(done, 4), 'abcd…')
  }
  const failed = model.parseBackgroundReportEntry(makeReportEntry({ report: { status: 'failed', error: 'boom' } }))
  if (!failed.invalid) assert.equal(model.backgroundReportPreview(failed, 120), 'boom')
})

// ---------------------------------------------------------------------------
// 2. BackgroundReportCard DOM：默认收起 / 展开 / 复制 / 导航 / 损坏
//    （复用 ExecutionCard 框架：subagent-live-card/header/trigger/actions/subline）
// ---------------------------------------------------------------------------

test('card: 默认收起（共用紧凑头部+单行副栏），完整结果未挂载；展开后挂载并可收起', { timeout: 60_000 }, async () => {
  const { ctx } = drawerSpy()
  const entry = makeReportEntry({ report: { result: '首行结论\n\n详细正文第二段' } })
  const { host, unmount } = await mountCard(entry, ctx)

  // 共用框架：与子代理实时卡同一套容器/头部/副栏结构与字号样式。
  assert.ok(host.querySelector('.subagent-live-card'), '复用 subagent-live-card 容器')
  assert.equal(host.querySelector('.subagent-card-clickable'), null, '汇报卡不做整卡点击导航')
  const bar = host.querySelector('.subagent-live-header')
  assert.ok(bar, '紧凑头部存在')
  assert.match(bar!.textContent ?? '', /子代理汇报/)
  assert.match(bar!.textContent ?? '', /已完成/)
  assert.equal(bar!.textContent?.includes('wf_abc123'), false, '收起态不常驻 runId')
  assert.equal(host.querySelector('.subagent-live-title')?.getAttribute('title'), '运行 wf_abc123', 'runId 放悬浮提示')
  assert.equal(host.querySelector('.subagent-live-subline .subagent-live-subline-text')?.textContent, '首行结论')

  const toggle = host.querySelector<HTMLButtonElement>('button.subagent-live-toggleable')
  assert.ok(toggle, '折叠开关存在（头部触发区兼任）')
  assert.equal(toggle!.getAttribute('aria-expanded'), 'false')
  const bodyId = toggle!.getAttribute('aria-controls')!
  assert.ok(document.getElementById(bodyId), '收起时 aria-controls 仍指向真实区域')
  const duplicate = await mountCard(entry, ctx)
  const duplicateBodyId = duplicate.host.querySelector('button[aria-controls]')!.getAttribute('aria-controls')
  assert.notEqual(duplicateBodyId, bodyId, '同一消息同时在分屏展示时控件 ID 不重复')
  duplicate.unmount()

  // 收起态不挂载完整正文；复制为图标动作（aria-label 明确，不常驻文字）。
  assert.equal(host.textContent?.includes('详细正文第二段'), false)
  assert.equal(host.querySelector('.subagent-live-stream'), null)
  const copyBtn = bar!.querySelector('button[aria-label="复制"]')
  assert.ok(copyBtn, '复制原文图标动作在头部')
  assert.equal(copyBtn!.textContent?.includes('复制原文'), false, '不得常驻文字按钮')

  await act(async () => { toggle!.focus() })
  act(() => toggle!.click())
  assert.equal(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'), 'true')
  assert.ok(host.querySelector('.subagent-live-stream'), '展开后挂载正文')
  assert.equal(host.textContent?.includes('详细正文第二段'), true)
  assert.match(host.textContent ?? '', /结果/)
  assert.equal(document.activeElement, toggle, '展开时折叠控件保留焦点与同一节点')

  act(() => toggle!.click())
  assert.equal(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'), 'false')
  assert.equal(host.querySelector('.subagent-live-stream'), null)
  unmount()
})

test('card: 复制原文实写入完整正文到剪贴板，不触发折叠开关', { timeout: 60_000 }, async () => {
  const { ctx } = drawerSpy()
  const entry = makeReportEntry({ report: { result: '首行结论\n\n详细正文第二段' } })
  const { host, unmount } = await mountCard(entry, ctx)
  await withCapturedClipboard(async (captured) => {
    const btn = host.querySelector<HTMLButtonElement>('button[aria-label="复制"]')
    assert.ok(btn)
    await act(async () => { btn!.click() })
    assert.equal(captured.length, 1, '实际写入剪贴板一次')
    assert.equal(captured[0], (entry.data as { text: string }).text, '复制的是完整正文原文（引导语+JSON）')
  })
  assert.equal(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'), 'false', '复制不得触发折叠开关')
  unmount()
})

test('card: JSON result 缩进代码块；失败折叠态错误直见；工作流标题与在途快照', { timeout: 60_000 }, async () => {
  const { ctx } = drawerSpy()
  // JSON result：展开渲染缩进代码块。
  const jsonEntry = makeReportEntry({ kind: 'workflow_report', report: { result: { done: true } } })
  const jsonMount = await mountCard(jsonEntry, ctx)
  assert.match(jsonMount.host.textContent ?? '', /工作流汇报/)
  clickButton(jsonMount.host, '展开后台任务汇报详情')
  const code = jsonMount.host.querySelector('.subagent-live-stream pre code')
  assert.ok(code, 'JSON result 渲染代码块')
  assert.match(code!.textContent ?? '', /"done": true/)
  jsonMount.unmount()

  // 失败：折叠态错误预览直接可见（副栏错误强调）。
  const failEntry = makeReportEntry({
    kind: 'workflow_report',
    report: { status: 'failed', error: '工具执行失败：退出码 1' },
  })
  const failMount = await mountCard(failEntry, ctx)
  assert.match(failMount.host.textContent ?? '', /失败/)
  const failSubline = failMount.host.querySelector('.subagent-live-subline.execution-report-subline-error')
  assert.ok(failSubline, '失败态副栏带错误强调类')
  assert.match(failSubline?.textContent ?? '', /工具执行失败：退出码 1/)
  clickButton(failMount.host, '展开后台任务汇报详情')
  assert.match(failMount.host.querySelector('.subagent-live-stream')?.textContent ?? '', /工具执行失败：退出码 1/)
  failMount.unmount()

  // 在途快照：展开显示“投递时快照”标注与徽章。
  const snapEntry = makeReportEntry({
    report: { status: 'completed', result: 'ok', otherRunningTasks: [{ runId: 'wf_x', name: '并行任务', kind: 'subagent' }] },
  })
  const snapMount = await mountCard(snapEntry, ctx)
  clickButton(snapMount.host, '展开后台任务汇报详情')
  assert.match(snapMount.host.textContent ?? '', /投递时其余在途任务（快照）/)
  const chip = snapMount.host.querySelector('.execution-report-tasks .badge')
  assert.ok(chip, '在途任务渲染徽章')
  assert.equal(chip!.textContent, '并行任务')
  assert.equal(chip!.getAttribute('title'), 'wf_x · subagent')
  snapMount.unmount()
})

test('card: execution.conversationId 才给子会话入口（图标动作打开抽屉，不触发折叠）', { timeout: 60_000 }, async () => {
  const spy = drawerSpy()
  // 无 execution：不渲染导航按钮。
  const plain = await mountCard(makeReportEntry({ report: { result: 'ok' } }), spy.ctx)
  assert.equal(plain.host.querySelector('button[aria-label^="打开子会话 #"]'), null)
  assert.equal(plain.host.textContent?.includes('打开子会话'), false)
  plain.unmount()

  const entry = makeReportEntry({ report: { result: 'ok', execution: { conversationId: 7 } } })
  const { host, unmount } = await mountCard(entry, spy.ctx)
  assert.match(host.querySelector('.subagent-live-header')?.textContent ?? '', /子会话 #7/, '头部显示子会话 ID')
  const nav = host.querySelector<HTMLButtonElement>('button[aria-label="打开子会话 #7"]')
  assert.ok(nav, '有真实 execution 时渲染子会话图标入口')
  act(() => nav!.click())
  assert.deepEqual(spy.calls, [7])
  assert.equal(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'), 'false', '导航不得触发折叠开关')
  unmount()
})

test('card: 损坏数据显式“汇报数据格式异常”，可展开复制原文（不伪造成功）', { timeout: 60_000 }, async () => {
  const { ctx } = drawerSpy()
  const entry = makeReportEntry({ text: '引导语\n{坏 JSON', meta: { backgroundRunId: 'wf_bad', kind: 'subagent_report' } })
  const { host, unmount } = await mountCard(entry, ctx)
  assert.match(host.textContent ?? '', /汇报数据格式异常/)
  assert.equal(host.textContent?.includes('已完成'), false, '损坏数据不得显示成功徽章')
  assert.ok(host.querySelector('button[aria-label="复制"]'), '复制原文入口保留')
  clickButton(host, '展开后台任务汇报详情')
  assert.ok(host.querySelector('.subagent-live-stream'), '展开后可见原文')
  assert.match(host.querySelector('.subagent-live-stream')?.textContent ?? '', /\{坏 JSON/)
  unmount()
})

// ---------------------------------------------------------------------------
// 3. 宿主派发：matchMeta.renderer 精确接管（helpers/workflow-ui.ts 同步注册）
// ---------------------------------------------------------------------------

test('宿主派发: renderer 标记的 helm.input 接管为插件卡，未标记输入不受影响', { timeout: 60_000 }, () => {
  const renderers = groupUiContributions(workflowUi).timelineRenderers
  assert.equal(renderers.length, 1)
  assert.equal(renderers[0]!.pluginId, 'builtin:workflow')

  const items = buildTimelineItems(
    [makeReportEntry(), { id: '52', kind: 'helm.input', data: { text: '普通输入', origin: 'human' } }],
    { timelineRenderers: renderers },
  )
  assert.equal(items[0]!.kind, 'plugin-card')
  if (items[0]!.kind === 'plugin-card') {
    assert.equal(items[0]!.renderer.pluginId, 'builtin:workflow')
    assert.equal(items[0]!.entryId, '51')
  }
  assert.equal(items[1]!.kind, 'human', '未标记 renderer 的 helm.input 仍走通用人类消息渲染')
})

// ---------------------------------------------------------------------------
// 4. 排队中的非人类长文本通用折叠（HumanMessage）
// ---------------------------------------------------------------------------

test('queuedAgentTextCollapse: 阈值判定与预览截断', { timeout: 60_000 }, () => {
  assert.equal(queuedAgentTextCollapse('短文本').collapsed, false)
  assert.equal(queuedAgentTextCollapse('a'.repeat(600)).collapsed, false, '不超 600 字符不折叠')
  const long = queuedAgentTextCollapse(`引导语\n${'a'.repeat(700)}`)
  assert.equal(long.collapsed, true)
  assert.ok(long.preview.endsWith('…'))
  const manyLines = queuedAgentTextCollapse(Array.from({ length: 10 }, (_, i) => `行${i}`).join('\n'))
  assert.equal(manyLines.collapsed, true, '超过 8 行即折叠')
})

function makeStore(live: ConversationLive | undefined, entries: ConversationEntry[]): HelmStoreValue {
  const conversation: ConversationSummary = {
    id: 1, title: '测试会话', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux/faux-1', thinkingLevel: 'off', status: live !== undefined ? 'working' : 'idle',
    stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0,
    createdAt: 1, updatedAt: 1,
  }
  const noop = () => {}
  const asyncNoop = async () => undefined
  return {
    ...emptyLiveState(),
    conversations: [conversation], conversationDetails: { 1: { ...conversation, entries } },
    conversationArtifacts: {}, groupedUi: groupUiContributions([]),
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark', themePreference: 'dark',
    profiles: [], assetsLoaded: true, models: [], providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null, notices: [],
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, refreshNodes: async () => undefined,
    loadConversationDetail: async () => undefined, loadEarlierEntries: asyncNoop, loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setScreenParams: noop, setWorkbenchOpen: noop,
    setWorkbenchTab: noop, openSpace: noop, setActiveModal: noop, dismissNotice: noop, pushNotice: noop,
    invokePluginAction: asyncNoop,
    subscribeSessionDoc,
    getSessionDocState,
    getPluginSessionDoc: asyncNoop,
    retrySessionDoc: noop,
  }
}

async function mountTimeline(
  live: ConversationLive | undefined,
  entries: ConversationEntry[],
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const store = makeStore(live, entries)
  const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      e(
        HelmStoreContext.Provider,
        { value: store },
        e(ConversationTimeline, { conversation: store.conversations[0]!, detailEntries: entries, ...(live ? { live } : {}), onRequestEdit: () => {} }),
      ),
    )
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

test('HumanMessage: 排队 agent 长文折叠可展开收起，复制入口保留；human 不折叠', { timeout: 60_000 }, async () => {
  const reportText = `后台子代理任务已结算。\n${JSON.stringify({ runId: 'wf_q', status: 'completed', result: 'x'.repeat(700), otherRunningTasks: [] })}`
  const live: ConversationLive = {
    conversationId: 1,
    text: '',
    tools: [],
    updatedAt: 9,
    queuedInputs: [
      { id: 'fu-agent', submissionId: '30', text: reportText, mode: 'followUp', origin: 'agent', createdAt: 5 },
      { id: 'fu-human', submissionId: '31', text: `人类排队长文：${'人'.repeat(700)}`, mode: 'followUp', origin: 'human', createdAt: 6 },
    ],
  }
  const { host, unmount } = await mountTimeline(live, [])

  const agentPill = host.querySelector('.msg-human-pill-collapsible')
  assert.ok(agentPill, '排队 agent 长文折叠展示')
  assert.match(agentPill!.querySelector('.msg-human-collapsed-text')?.textContent ?? '', /后台子代理任务已结算/)
  // 折叠态只见预览，不见全文。
  assert.equal(agentPill!.textContent?.includes('otherRunningTasks'), false)
  const expand = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('展开全文'))
  assert.ok(expand, '展开按钮存在')
  assert.equal(expand!.getAttribute('aria-expanded'), 'false')
  assert.ok(document.getElementById(expand!.getAttribute('aria-controls')!), '折叠状态控件目标存在')
  expand!.focus()

  act(() => expand!.click())
  assert.equal(expand!.isConnected, true, '展开时保留同一个按钮')
  assert.equal(document.activeElement, expand, '展开时保留键盘焦点')
  const openPill = host.querySelector('.msg-human-pill-collapsible')
  assert.ok(openPill!.textContent?.includes('otherRunningTasks'), '展开后可见全文')
  assert.equal(openPill!.textContent?.includes('展开全文'), false)
  const collapse = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '收起')
  assert.ok(collapse, '收起按钮存在')
  assert.equal(collapse!.getAttribute('aria-expanded'), 'true')
  act(() => collapse!.click())
  assert.equal(document.activeElement, expand, '收起时保留键盘焦点')
  assert.equal(host.querySelector('.msg-human-pill-collapsible')?.textContent?.includes('otherRunningTasks'), false)

  // 人类排队长文与正式消息不折叠。
  const humanPills = Array.from(host.querySelectorAll('.msg-human-pill')).filter((p) => p.textContent?.includes('人类排队长文'))
  assert.equal(humanPills.length, 1)
  assert.equal(humanPills[0]!.classList.contains('msg-human-pill-collapsible'), false, 'human 输入不折叠')
  assert.ok(humanPills[0]!.textContent?.includes('人人人'), 'human 长文直接全文展示')
  unmount()
})
