/**
 * 后台结算汇报折叠展示测试（builtin:workflow 真实 client 编译产物 + @helmx/plugin-client）：
 * 1. 纯解析 model-background-report：直接读取 meta.report（string/JSON result 含 null/false/0/空串、
 *    failed/aborted、execution.conversationId、otherRunningTasks）；缺失/损坏 meta.report 返回 invalid
 *    并保留 rawText，绝不做正文换行/正则解析；
 * 2. BackgroundReportCard DOM（与宿主 .trace-row 同构的单行回执 + 原地展开面板）：
 *    完成态默认收起，失败/异常默认展开；复制原文实写入剪贴板、子会话导航不触发折叠、损坏显式
 *    「Malformed report」且可展开复制原文。
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import type { PluginClientHostPort } from '@helmx/plugin-client'
import type { ConversationEntry, PluginClientContext as PluginClientContextType, TimelineRendererProps } from '@helmx/protocol'
import type { BackgroundReportParse } from '../src/workflow/client/model-background-report.ts'
import {
  React,
  SDK,
  act,
  createRoot,
  importWorkflowClientModule,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

const e = React.createElement
mountSharedPluginNamespaces({ realHooks: true })

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

interface ReportOverrides {
  kind?: 'subagent_report' | 'workflow_report'
  runId?: string
  report?: Record<string, unknown>
  omitReport?: boolean
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
    kind: 'helmx.input',
    data: {
      id: `helmx:subagent-report:${runId}`,
      text:
        overrides.text ??
        `后台子代理任务已结算。以下为运行 ${runId} 的结果数据（仅代表本次任务；otherRunningTasks 是投递时其余在途运行的快照）：\n${JSON.stringify(report)}`,
      origin: 'agent',
      createdAt: 100,
      meta: {
        backgroundRunId: runId,
        kind,
        renderer: 'workflow:background-report',
        ...(overrides.omitReport === true ? {} : { report }),
        ...overrides.meta,
      },
    },
  }
}

function drawerSpy(): {
  port: PluginClientHostPort
  ctx: PluginClientContextType
  calls: number[]
} {
  const calls: number[] = []
  const port: PluginClientHostPort = {
    authenticated: true,
    theme: 'dark',
    locale: 'en',
    conversations: [],
    conversationDetails: {},
    conversationLives: {},
    pendingAsks: [],
    loadErrors: {},
    plugins: [],
    screens: [],
    pluginDocs: {},
    ensurePluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    subscribeSessionDoc: () => () => {},
    getSessionDocState: () => ({ hasValue: false, deleted: false, connected: false, value: undefined }),
    invokePluginAction: async () => ({}),
    submitConversationInput: async () => undefined,
    openTarget: () => {},
    openConversationDrawer: (id) => {
      calls.push(id)
    },
    openArtifactPreview: () => {},
    setWorkbenchOpen: () => {},
    setWorkbenchTab: () => {},
    notify: () => {},
    loadConversationDetail: () => {},
    slots: { collectItems: () => [], renderItem: () => null },
    markdown: {
      view: ({ text }) => e('div', { 'data-testid': 'markdown-view' }, text),
      codeBlock: ({ code }) => e('pre', null, code),
    },
  }
  const ctx = SDK.createPluginClientContext(port, 'builtin:workflow', 1)
  return { port, ctx, calls }
}

async function mountCard(
  entry: ConversationEntry,
  spy: { port: PluginClientHostPort; ctx: PluginClientContextType },
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      e(
        SDK.PluginClientHostContext.Provider,
        { value: spy.port },
        e(
          SDK.PluginClientContext.Provider,
          { value: spy.ctx },
          e(BackgroundReportCard, { entry, conversationId: 1 }),
        ),
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

function clickButton(host: HTMLElement, label: string): void {
  const btn = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  assert.ok(btn, `应存在 aria-label=${label} 的按钮`)
  act(() => btn.click())
}

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
// 1. 纯解析：meta.report 直读、result 语义、终态与损坏输入
// ---------------------------------------------------------------------------

test('parse: string 与 JSON result 均保留（null/false/0/空串不丢），直读 meta.report 不刮文本', { timeout: 60_000 }, () => {
  const cases: Array<{ result: unknown; expect: unknown }> = [
    { result: '纯文本结论', expect: '纯文本结论' },
    { result: { done: true, n: 2 }, expect: { done: true, n: 2 } },
    { result: null, expect: null },
    { result: false, expect: false },
    { result: 0, expect: 0 },
    { result: '', expect: '' },
  ]
  for (const c of cases) {
    const view = model.parseBackgroundReportEntry(
      makeReportEntry({ text: '纯人类可读说明，无任何 JSON 尾行', report: { result: c.result, status: 'completed' } }),
    )
    assert.equal(view.invalid, false, `result=${JSON.stringify(c.result)} 应从 meta.report 直接解析成功`)
    if (!view.invalid) {
      assert.equal(view.hasResult, true)
      assert.deepEqual(view.result, c.expect)
      assert.equal(view.rawText, '纯人类可读说明，无任何 JSON 尾行')
    }
  }
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

test('parse: 缺失或损坏 meta.report / meta.kind 返回 invalid 且保留原文（不回退正文 JSON 刮取）', { timeout: 60_000 }, () => {
  // 即使正文带换行与合法 JSON，若缺少结构化 meta.report 也必须显式判定 invalid（绝不正则/文本刮取）。
  const missingReport = model.parseBackgroundReportEntry(
    makeReportEntry({ omitReport: true }),
  )
  assert.equal(missingReport.invalid, true)
  if (missingReport.invalid) assert.ok(missingReport.rawText.includes('wf_abc123'))

  const nonObjectReport = model.parseBackgroundReportEntry(
    makeReportEntry({ meta: { report: 'not-an-object' }, text: '损坏汇报原文' }),
  )
  assert.equal(nonObjectReport.invalid, true)
  if (nonObjectReport.invalid) assert.equal(nonObjectReport.rawText, '损坏汇报原文')

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
// ---------------------------------------------------------------------------

test('card: 默认收起（与宿主 .trace-row 同构单行），完整结果未挂载；展开后挂载并可收起', { timeout: 60_000 }, async () => {
  const spy = drawerSpy()
  const entry = makeReportEntry({ report: { result: '首行结论\n\n详细正文第二段' } })
  const { host, unmount } = await mountCard(entry, spy)

  const traceEntry = host.querySelector('.trace-entry')
  assert.ok(traceEntry !== null, '渲染宿主同构 .trace-entry 容器')
  const row = host.querySelector('.trace-row')
  assert.ok(row !== null, '渲染 .trace-row 单行回执')
  assert.equal(row.classList.contains('trace-row-error'), false, '正常完成态不带错误高亮')
  assert.match(row.querySelector('.trace-tool-name')?.textContent ?? '', /^Subagent report$/)
  assert.match(row.querySelector('.trace-row-right')?.textContent ?? '', /Completed/)
  assert.equal(row.textContent?.includes('wf_abc123'), false, '收起态不常驻 runId')
  assert.equal(row.querySelector('.trace-tool-summary')?.textContent, '首行结论')

  const toggle = host.querySelector<HTMLButtonElement>('button.workflow-trace-toggle')
  assert.ok(toggle, '折叠开关存在（左侧内容触发区兼任）')
  assert.equal(toggle!.getAttribute('aria-expanded'), 'false')
  assert.equal(toggle!.getAttribute('aria-label'), 'Expand Subagent report details')
  const bodyId = toggle!.getAttribute('aria-controls')!
  assert.ok(document.getElementById(bodyId), '收起时 aria-controls 仍指向真实区域')
  const duplicate = await mountCard(entry, spy)
  const duplicateBodyId = duplicate.host.querySelector('button[aria-controls]')!.getAttribute('aria-controls')
  assert.notEqual(duplicateBodyId, bodyId, '同一消息同时在分屏展示时控件 ID 不重复')
  duplicate.unmount()

  assert.equal(host.textContent?.includes('详细正文第二段'), false)
  assert.ok(host.querySelector('.workflow-report-expanded') === null)
  const copyBtn = row.querySelector('button[aria-label="Copy"]')
  assert.ok(copyBtn !== null, '复制原文图标动作在右侧动作区')
  assert.equal(copyBtn!.textContent?.includes('复制原文'), false, '不得常驻文字按钮')

  await act(async () => { toggle!.focus() })
  act(() => toggle!.click())
  assert.equal(toggle!.getAttribute('aria-expanded'), 'true')
  const expanded = host.querySelector('.workflow-report-expanded')
  assert.ok(expanded !== null, '展开后挂载详情面板')
  assert.equal(expanded.textContent?.includes('wf_abc123'), true, '展开后展示完整 runId')
  assert.equal(expanded.textContent?.includes('详细正文第二段'), true)
  assert.match(expanded.textContent ?? '', /Result body/)
  assert.ok(document.activeElement === toggle, '展开时折叠控件保留焦点与同一节点')

  act(() => toggle!.click())
  assert.equal(toggle!.getAttribute('aria-expanded'), 'false')
  assert.ok(host.querySelector('.workflow-report-expanded') === null)
  unmount()
})

test('card: 复制原文实写入完整正文到剪贴板，不触发折叠开关', { timeout: 60_000 }, async () => {
  const spy = drawerSpy()
  const entry = makeReportEntry({ report: { result: '首行结论\n\n详细正文第二段' } })
  const { host, unmount } = await mountCard(entry, spy)
  await withCapturedClipboard(async (captured) => {
    const btn = host.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')
    assert.ok(btn)
    await act(async () => { btn!.click() })
    assert.equal(captured.length, 1, '实际写入剪贴板一次')
    assert.equal(captured[0], (entry.data as { text: string }).text, '复制的是完整正文原文')
  })
  assert.equal(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'), 'false', '复制不得触发折叠开关')
  unmount()
})

test('card: JSON result 缩进代码块；失败默认展开直见错误；工作流标题与在途快照', { timeout: 60_000 }, async () => {
  const spy = drawerSpy()
  const jsonEntry = makeReportEntry({ kind: 'workflow_report', report: { result: { done: true } } })
  const jsonMount = await mountCard(jsonEntry, spy)
  assert.match(jsonMount.host.textContent ?? '', /Workflow report/)
  clickButton(jsonMount.host, 'Expand Workflow report details')
  const code = jsonMount.host.querySelector('.workflow-report-expanded pre code')
  assert.ok(code, 'JSON result 渲染代码块')
  assert.match(code!.textContent ?? '', /"done": true/)
  jsonMount.unmount()

  const failEntry = makeReportEntry({
    kind: 'workflow_report',
    report: { status: 'failed', error: '工具执行失败：退出码 1' },
  })
  const failMount = await mountCard(failEntry, spy)
  assert.match(failMount.host.textContent ?? '', /Failed/)
  assert.ok(failMount.host.querySelector('.trace-row.trace-row-error'), '失败态行带 trace-row-error 类')
  const failSummary = failMount.host.querySelector('.trace-tool-summary.workflow-trace-error')
  assert.ok(failSummary, '失败态摘要带 workflow-trace-error 类')
  assert.match(failSummary?.textContent ?? '', /工具执行失败：退出码 1/)
  assert.equal(failMount.host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'), 'true', '失败态默认自动展开')
  assert.match(failMount.host.querySelector('.workflow-report-expanded')?.textContent ?? '', /工具执行失败：退出码 1/)
  clickButton(failMount.host, 'Collapse Workflow report details')
  assert.equal(failMount.host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'), 'false')
  failMount.unmount()

  const snapEntry = makeReportEntry({
    report: { status: 'completed', result: 'ok', otherRunningTasks: [{ runId: 'wf_x', name: '并行任务', kind: 'subagent' }] },
  })
  const snapMount = await mountCard(snapEntry, spy)
  clickButton(snapMount.host, 'Expand Subagent report details')
  assert.match(snapMount.host.textContent ?? '', /Other in-flight tasks at delivery \(snapshot\)/)
  const chip = snapMount.host.querySelector('.execution-report-tasks .workflow-report-task-item')
  assert.ok(chip, '在途任务渲染快照徽章')
  assert.match(chip!.textContent ?? '', /并行任务/)
  assert.match(chip!.textContent ?? '', /wf_x/)
  assert.match(chip!.textContent ?? '', /Background subagent/)
  snapMount.unmount()
})

test('card: execution.conversationId 才给子会话入口（图标动作打开抽屉，不触发折叠）', { timeout: 60_000 }, async () => {
  const spy = drawerSpy()
  const plain = await mountCard(makeReportEntry({ report: { result: 'ok' } }), spy)
  assert.ok(plain.host.querySelector('button[aria-label^="Open subagent #"]') === null)
  assert.equal(plain.host.textContent?.includes('Open subagent'), false)
  plain.unmount()

  const entry = makeReportEntry({ report: { result: 'ok', execution: { conversationId: 7 } } })
  const { host, unmount } = await mountCard(entry, spy)
  assert.match(host.querySelector('.trace-row .trace-tool-name')?.textContent ?? '', /Subagent report #7/, '无 name 历史记录保持 Subagent report #7')
  const nav = host.querySelector<HTMLButtonElement>('button[aria-label="Open subagent #7"]')
  assert.ok(nav, '有真实 execution 时渲染子会话图标入口')
  act(() => nav!.click())
  assert.deepEqual(spy.calls, [7])
  assert.equal(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'), 'false', '导航不得触发折叠开关')
  unmount()

  // 携带 name：收起态主标题显示「Subagent report · <name>」+ 次级 #7；展开态 kv-grid 含 Task name 与 `<name> (#7)` 按钮
  const namedEntry = makeReportEntry({
    report: { name: '修复登录超时', result: 'ok', execution: { conversationId: 7 } },
  })
  const namedMount = await mountCard(namedEntry, spy)
  assert.equal(namedMount.host.querySelector('.trace-row .trace-tool-name')?.textContent, 'Subagent report · 修复登录超时')
  assert.equal(namedMount.host.querySelector('.trace-row .workflow-trace-id')?.textContent, '#7')
  clickButton(namedMount.host, 'Expand Subagent report · 修复登录超时 details')
  const expanded = namedMount.host.querySelector('.workflow-report-expanded')
  assert.ok(expanded !== null)
  assert.ok(expanded.textContent?.includes('Task name') && expanded.textContent?.includes('修复登录超时'))
  const subBtn = [...expanded.querySelectorAll('button')].find((b) => b.textContent?.includes('修复登录超时 (#7)'))
  assert.ok(subBtn !== undefined, '展开态子会话按钮应显示 `<name> (#7)`')
  act(() => { subBtn.click() })
  assert.deepEqual(spy.calls, [7, 7])
  namedMount.unmount()

  // workflow_report 携带 name
  const namedWfEntry = makeReportEntry({
    kind: 'workflow_report',
    report: { name: '发布前检查', result: 'ok' },
  })
  const namedWfMount = await mountCard(namedWfEntry, spy)
  assert.equal(namedWfMount.host.querySelector('.trace-row .trace-tool-name')?.textContent, 'Workflow report · 发布前检查')
  namedWfMount.unmount()
})

test('card: 损坏数据显式“汇报数据格式异常”并默认展开，可收起并复制原文（不伪造成功）', { timeout: 60_000 }, async () => {
  const spy = drawerSpy()
  const entry = makeReportEntry({
    text: '引导语\n{坏 JSON',
    omitReport: true,
    meta: { backgroundRunId: 'wf_bad', kind: 'subagent_report' },
  })
  const { host, unmount } = await mountCard(entry, spy)
  assert.ok(host.querySelector('.trace-row.trace-row-error'), '损坏数据行带错误高亮')
  assert.match(host.textContent ?? '', /Malformed report/)
  assert.equal(host.textContent?.includes('Completed'), false, '损坏数据不得显示成功徽章')
  assert.ok(host.querySelector('button[aria-label="Copy"]'), '复制原文入口保留')
  assert.equal(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'), 'true', '损坏报文默认自动展开')
  const expanded = host.querySelector('.workflow-report-expanded')
  assert.ok(expanded, '展开后可见原文')
  assert.match(expanded!.textContent ?? '', /\{坏 JSON/)
  clickButton(host, 'Collapse Background report details')
  assert.equal(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'), 'false')
  clickButton(host, 'Expand Background report details')
  assert.match(host.querySelector('.workflow-report-expanded')?.textContent ?? '', /\{坏 JSON/)
  unmount()
})
