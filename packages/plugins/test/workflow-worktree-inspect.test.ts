/**
 * builtin:workflow 插件 client 工作树检视、重放表单与防重放测试（真实 esbuild 编译产物）：
 * - 纯逻辑（models.ts 编译产物）：parseWorktreeInspectResult（严格边界）/
 *   buildWorktreeSelector / buildWorktreeReviewRequest /
 *   parseSavedWorkflowList（非法条目整体拒绝）/ parseWorkflowArgsInput /
 *   canReplayWorkflowRun；
 * - DOM 交互（index.tsx 编译产物，happy-dom + React act）：
 *   工作流库每行独立 args 草稿（不串行）、completed run（含内联）重放表单
 *   （保留原会话、不覆盖 args、显式 args 严格校验）、工作台双击防重复、
 *   节点卡与独立子代理卡的工作树只读改动概览（精确选择器、不冒泡导航、
 *   diff 边界说明）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary, PluginClientContext as PluginClientContextType, WorkbenchPanelProps } from '@helmx/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  SDK,
  act,
  createRoot,
  importWorkflowClientModule,
  importWorkflowModels,
  mountSharedPluginNamespaces,
  setWorkflowClientStub,
} from './helpers/workflow-client-harness.js'

const e = React.createElement
const { PluginClientContext, resolveLocalizedText } = SDK

mountSharedPluginNamespaces()
const m = await importWorkflowModels()
// happy-dom 已知不派发 React onChange：受控输入统一直接调用元素上挂载的
// __reactProps$.onChange（真实受控更新路径，不依赖事件系统探针）。

function node(partial: Partial<WorkflowNodeState> & { id: string }): WorkflowNodeState {
  return { kind: 'agent', status: 'done', ...partial }
}

function run(partial: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 'wf_test',
    name: '测试工作流',
    conversationId: 1,
    status: 'completed',
    createdAt: 1_000,
    updatedAt: 61_000,
    ...partial,
  }
}

function workbenchConversation(): ConversationSummary {
  return {
    id: 1,
    title: '主会话',
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp/repo',
    model: '',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

// ---------------------------------------------------------------------------
// 纯逻辑：worktree 检视结果解析与选择器
// ---------------------------------------------------------------------------

const INSPECT_RAW = {
  record: {
    id: 'local:/repo/.helmx-worktrees/app-ab12cd34',
    nodeId: 'local',
    path: '/repo/.helmx-worktrees/app-ab12cd34',
    branch: 'helmx/spawn-ab12cd34',
    baseCommit: '5f1e9c0ffffffffffffffffffffffffffffffffff',
    repoRoot: '/repo',
    dirtySource: false,
    parentConversationId: 1,
    conversationId: 7,
    origin: 'native',
    status: 'active',
    createdAt: 123,
  },
  exists: true,
  currentBranch: 'helmx/spawn-ab12cd34',
  currentHead: 'aa11'.repeat(10),
  dirtyFiles: ['?? draft.txt', '?? note.txt'],
  dirtyFileCount: 2,
  dirtyFilesTruncated: false,
  commitsAhead: 1,
  diffStat: ' feature.txt | 1 +',
  diffPreview: '+committed change',
  diffTruncated: false,
  diffBase: 'baseCommit',
}

test('parseWorktreeInspectResult：合法形状完整解析；非法形状返回 undefined 不伪造', { timeout: 60_000 }, () => {
  const parsed = m.parseWorktreeInspectResult(INSPECT_RAW)
  assert.ok(parsed !== undefined)
  assert.equal(parsed!.worktreeId, 'local:/repo/.helmx-worktrees/app-ab12cd34')
  assert.equal(parsed!.dirtyFileCount, 2)
  assert.equal(parsed!.commitsAhead, 1)
  assert.equal(parsed!.diffBase, 'baseCommit')
  assert.equal(parsed!.branchChanged, undefined)

  const changed = m.parseWorktreeInspectResult({
    ...INSPECT_RAW,
    currentBranch: 'main',
    branchChanged: true,
  })
  assert.equal(changed!.branchChanged, true)

  assert.equal(m.parseWorktreeInspectResult(undefined), undefined)
  assert.equal(m.parseWorktreeInspectResult('x'), undefined)
  assert.equal(m.parseWorktreeInspectResult({ exists: true }), undefined, '缺 record 结构必须拒绝')
})

test('parseWorktreeInspectResult：必需字段缺失/类型错位/枚举非法一律拒收，不降级成已清理或无变更', { timeout: 60_000 }, () => {
  const without = (key: string): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...INSPECT_RAW }
    delete copy[key]
    return copy
  }
  assert.equal(m.parseWorktreeInspectResult(without('exists')), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, exists: 'yes' }), undefined)
  assert.equal(m.parseWorktreeInspectResult(without('dirtyFiles')), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, dirtyFiles: ['?? a', 42] }), undefined)
  assert.equal(m.parseWorktreeInspectResult(without('dirtyFileCount')), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, dirtyFileCount: -1 }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, dirtyFileCount: 1.5 }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, dirtyFileCount: 3 }), undefined)
  const truncated = m.parseWorktreeInspectResult({
    ...INSPECT_RAW,
    dirtyFiles: INSPECT_RAW.dirtyFiles.slice(0, 1),
    dirtyFilesTruncated: true,
  })
  assert.ok(truncated !== undefined, '截断时计数(2) > 列表长度(1) 合法')
  assert.equal(truncated!.dirtyFileCount, 2)
  assert.equal(m.parseWorktreeInspectResult(without('dirtyFilesTruncated')), undefined)
  assert.equal(m.parseWorktreeInspectResult(without('diffTruncated')), undefined)
  assert.equal(m.parseWorktreeInspectResult(without('diffBase')), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, diffBase: 'main' }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, record: { ...INSPECT_RAW.record, status: 'weird' } }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, record: { ...INSPECT_RAW.record, origin: 'weird' } }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, unavailableReason: 'whatever' }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, commitsAhead: -2 }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, branchChanged: 'yes' }), undefined)
  const noBase = m.parseWorktreeInspectResult({
    ...INSPECT_RAW,
    record: { ...INSPECT_RAW.record, baseCommit: '' },
    diffBase: 'HEAD',
  })
  assert.ok(noBase !== undefined)
  assert.equal(noBase!.baseCommit, '')
  assert.equal(noBase!.diffBase, 'HEAD')
})

test('buildWorktreeSelector：登记 ID 优先；无 ID 时 path+nodeId 消歧', { timeout: 60_000 }, () => {
  assert.deepEqual(
    m.buildWorktreeSelector({ id: 'local:/a', path: '/a' }, 'local'),
    { worktreeId: 'local:/a' },
  )
  assert.deepEqual(m.buildWorktreeSelector({ path: '/a' }, 'local'), { path: '/a', nodeId: 'local' })
  assert.deepEqual(m.buildWorktreeSelector({ path: '/a' }, undefined), { path: '/a' })
  assert.deepEqual(m.buildWorktreeSelector({ id: '  ', path: '/a' }, 'local'), { path: '/a', nodeId: 'local' }, '空白 ID 视为无 ID')
})

test('buildWorktreeReviewRequest：含坐标与检视统计；分支不一致显式警示', { timeout: 60_000 }, () => {
  const input = {
    path: '/repo/.helmx-worktrees/app-ab12cd34',
    branch: 'helmx/spawn-ab12cd34',
    nodeId: 'local',
    baseCommit: '5f1e9c0aaa',
    taskLabel: '修复构建',
    inspect: m.parseWorktreeInspectResult(INSPECT_RAW),
  }
  const text = m.buildWorktreeReviewRequest(input)
  assert.match(text, /\/repo\/\.helmx-worktrees\/app-ab12cd34/)
  assert.match(text, /\(node local\)/)
  assert.match(text, /helmx\/spawn-ab12cd34/)
  assert.match(text, /5f1e9c0aaa\d*/)
  assert.match(text, /Uncommitted changes: 2 files/)
  assert.match(text, /Commits ahead of base: 1/)
  assert.match(text, /Review read-only first/)

  const zhText = m.buildWorktreeReviewRequest(input, 'zh-CN')
  assert.match(zhText, /节点 local/)
  assert.match(zhText, /未提交修改：2 个文件/)
  assert.match(zhText, /领先基线提交：1 个/)
  assert.match(zhText, /只读复核/)

  const mismatched = m.buildWorktreeReviewRequest({
    path: '/w',
    branch: 'helmx/spawn-x',
    inspect: m.parseWorktreeInspectResult({ ...INSPECT_RAW, currentBranch: 'main', branchChanged: true }),
  })
  assert.match(mismatched, /currently on branch main, which differs from the registered branch/)
  const zhMismatched = m.buildWorktreeReviewRequest({
    path: '/w',
    branch: 'helmx/spawn-x',
    inspect: m.parseWorktreeInspectResult({ ...INSPECT_RAW, currentBranch: 'main', branchChanged: true }),
  }, 'zh-CN')
  assert.match(zhMismatched, /当前分支 main 与登记分支不一致/)
})

// ---------------------------------------------------------------------------
// 纯逻辑：工作流库与 args 严格解析、重跑判定
// ---------------------------------------------------------------------------

test('parseSavedWorkflowList：合法列表解析（含 metadataError 条目）；非法条目整体拒绝不静默丢弃', { timeout: 60_000 }, () => {
  const parsed = m.parseSavedWorkflowList({
    workflows: [
      { name: 'release', updatedAt: 1, size: 2, description: '发布流程', whenToUse: '发版时', phases: [{ title: '检查' }, { title: '发布', detail: '执行发布' }] },
      { name: 'broken', updatedAt: 1, size: 2, metadataError: 'meta.name is required' },
    ],
  })
  assert.ok(parsed !== undefined)
  assert.equal(parsed!.length, 2)
  assert.equal(parsed![0]!.name, 'release')
  assert.deepEqual(parsed![0]!.phases!.map((p) => p.title), ['检查', '发布'])
  assert.equal(parsed![1]!.metadataError, 'meta.name is required')

  assert.equal(m.parseSavedWorkflowList(undefined), undefined)
  assert.equal(m.parseSavedWorkflowList({ workflows: 'nope' }), undefined)
  assert.equal(m.parseSavedWorkflowList({ workflows: [{ name: 'ok', updatedAt: 1, size: 1 }, 42] }), undefined, '含非对象条目必须整体拒绝')
  assert.equal(m.parseSavedWorkflowList({ workflows: [{ noName: true }] }), undefined, '缺 name 必须整体拒绝')
  assert.equal(m.parseSavedWorkflowList({ workflows: [{ name: 'x', phases: 'bad' }] }), undefined, 'phases 非数组必须整体拒绝')
  assert.equal(m.parseSavedWorkflowList({ workflows: [{ name: 'x', phases: [{ noTitle: 1 }] }] }), undefined, '含非法阶段项必须整体拒绝')
})

test('parseWorkflowArgsInput：空串无 args；合法 JSON 透传；非法 JSON 显式报错', { timeout: 60_000 }, () => {
  assert.deepEqual(m.parseWorkflowArgsInput(''), { ok: true })
  assert.deepEqual(m.parseWorkflowArgsInput('   '), { ok: true })
  assert.deepEqual(m.parseWorkflowArgsInput('{"a":1}'), { ok: true, args: { a: 1 } })
  assert.deepEqual(m.parseWorkflowArgsInput('[1,2]'), { ok: true, args: [1, 2] })
  assert.deepEqual(m.parseWorkflowArgsInput('"文本"'), { ok: true, args: '文本' })
  const bad = m.parseWorkflowArgsInput('{a:1}')
  assert.equal(bad.ok, false)
  if (bad.ok === false) assert.match(bad.error, /must be valid JSON/)
  const badZh = m.parseWorkflowArgsInput('{a:1}', 'zh-CN')
  assert.equal(badZh.ok, false)
  if (badZh.ok === false) assert.match(badZh.error, /合法 JSON/)
})

test('canReplayWorkflowRun：非 subagent 的 completed run（含内联）可重放；canResume 仍限失败/中止', { timeout: 60_000 }, () => {
  assert.equal(m.canReplayWorkflowRun(run({ status: 'completed', savedName: 'release', kind: 'workflow' })), true)
  assert.equal(m.canReplayWorkflowRun(run({ status: 'completed', kind: 'workflow' })), true, '内联脚本 run 同样可经 resumeFromRunId 重放（沿用原源码）')
  assert.equal(m.canReplayWorkflowRun(run({ status: 'failed', savedName: 'release' })), false)
  assert.equal(m.canReplayWorkflowRun(run({ status: 'running' })), false)
  assert.equal(m.canReplayWorkflowRun(run({ status: 'completed', savedName: 'release', kind: 'subagent' })), false, '后台单子代理不提供重放入口')
  assert.equal(m.canResumeWorkflowRun(run({ status: 'completed', savedName: 'release' })), false, '已完成 run 不走断点恢复按钮')
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', resumable: true })), true)
})

// ---------------------------------------------------------------------------
// DOM 交互：编译产物组件（共享宿主 React + PluginClientContext）
// ---------------------------------------------------------------------------

interface RecordingCtx extends PluginClientContextType {
  calls: Array<{ action: string; input: unknown }>
  submissions: Array<{ text: string; options?: Record<string, unknown> }>
  notices: string[]
  drawerCalls: number[]
  screenCalls: string[]
}

function makeRecordingCtx(actionResults: Record<string, unknown>): RecordingCtx {
  const calls: RecordingCtx['calls'] = []
  const submissions: RecordingCtx['submissions'] = []
  const notices: string[] = []
  const drawerCalls: number[] = []
  const screenCalls: string[] = []
  return {
    pluginId: 'builtin:workflow',
    callAction: async (action: string, input?: unknown) => {
      calls.push({ action, input })
      if (action in actionResults) return actionResults[action]
      return undefined
    },
    submitInput: async (text: string, options?: { conversationId?: number; whenBusy?: string }) => {
      submissions.push({ text, options })
    },
    openScreen: (target: string) => {
      screenCalls.push(target)
    },
    openConversationDrawer: (id: number) => {
      drawerCalls.push(id)
    },
    openSplitScreen: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: (message: string) => {
      notices.push(message)
    },
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    conversationId: 1,
    theme: 'dark',
    locale: 'en' as const,
    translate: (text) => resolveLocalizedText(text, 'en'),
    calls,
    submissions,
    notices,
    drawerCalls,
    screenCalls,
  }
}

async function mountClient(
  ctx: PluginClientContextType,
  element: React.ReactElement,
): Promise<{ host: HTMLElement; rerender: (element: React.ReactElement) => Promise<void>; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: ReturnType<typeof createRoot> | undefined
  await act(async () => {
    root = createRoot(host)
    root.render(e(PluginClientContext.Provider, { value: ctx }, element))
  })
  await act(async () => {})
  return {
    host,
    rerender: async (next) => {
      await act(async () => { root?.render(e(PluginClientContext.Provider, { value: ctx }, next)) })
    },
    unmount: () => {
      act(() => root?.unmount())
      host.remove()
    },
  }
}

function buttonByText(host: ParentNode, text: string): HTMLButtonElement {
  const buttons = [...host.querySelectorAll('button')] as HTMLButtonElement[]
  const found = buttons.find((b) => (b.textContent ?? '').includes(text))
  assert.ok(found !== undefined, `应存在含「${text}」的按钮（实得：${buttons.map((b) => b.textContent).join(' | ')}）`)
  return found
}

function openMoreMenu(host: HTMLElement): void {
  const more = host.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')
  assert.ok(more !== null, '工作流卡应存在 ··· 更多操作按钮')
  more.click()
}

/**
 * 受控输入写入：happy-dom 不派发 React onChange，直接调用元素挂载的
 * __reactProps$.onChange（共享 React 实例的真实受控更新路径）。
 */
function setControlledValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
  setter?.call(input, value)
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps$'))
  assert.ok(key !== undefined, '受控输入应挂载 __reactProps$（共享 React 实例）')
  const props = (input as unknown as Record<string, Record<string, unknown>>)[key!]!
  const onChange = props['onChange']
  assert.ok(typeof onChange === 'function', '受控输入应携带 onChange 处理器')
  ;(onChange as (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void)({
    target: input,
    currentTarget: input,
  })
}

test('工作台去重工作流库仅留跳转入口；独立工作流库切换条目保持 args 草稿/错误隔离', { timeout: 60_000 }, async () => {
  setWorkflowClientStub({
    docValue: { runs: [] },
    conversations: [workbenchConversation()],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const ctx = makeRecordingCtx({
    list: {
      workflows: [
        { name: 'release', description: '发布流程：检查并发布', whenToUse: '发版时', updatedAt: 1_700_000_000_000, size: 4096, phases: [{ title: '检查' }, { title: '发布' }] },
        { name: 'audit', description: '审计流程', updatedAt: 1_700_000_000_000, size: 1024 },
        { name: 'broken', metadataError: 'meta.name is required', updatedAt: 1, size: 2 },
      ],
    },
    get: {
      workflow: {
        name: 'release',
        description: '发布流程：检查并发布',
        updatedAt: 1_700_000_000_000,
        size: 4096,
        script: 'export const meta = { name: "release" }\nreturn 1',
      },
    },
    run: { run: { id: 'wf_new' } },
  })
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const LibraryScreen = mod['WorkflowLibraryScreen'] as (p: Record<string, unknown>) => React.ReactElement

  // 1. 工作台已去重：不内嵌定义列表、不重复请求 list，仅保留右上角「工作流库」跳转按钮。
  const wb = await mountClient(ctx, e(Panel, { conversation: workbenchConversation() }))
  try {
    assert.ok(wb.host.querySelector('.workflow-library-item') === null, '工作台不得再内嵌重复工作流库行')
    assert.ok(wb.host.querySelector('.workflow-library-args') === null)
    assert.equal(ctx.calls.filter((c) => c.action === 'list').length, 0, '工作台挂载不发起多余 list 请求')
    await act(async () => {
      buttonByText(wb.host, 'Workflow library').click()
    })
    assert.deepEqual(ctx.screenCalls, ['screen:builtin:workflow/library'])
  } finally {
    wb.unmount()
  }

  // 2. 独立工作流库全屏页（inlineDrawer）：渲染卡片与元数据诊断，切换选中工作流重置 args 草稿与错误。
  const params: Record<string, string> = { wf: 'release' }
  const setParams = (patch: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete params[k]
      else params[k] = v
    }
  }
  const lib = await mountClient(
    ctx,
    e(LibraryScreen, { pluginId: 'builtin:workflow', screenId: 'library', isSplit: false, params, setParams, inlineDrawer: true }),
  )
  try {
    assert.match(lib.host.textContent!, /Workflow library/)
    assert.match(lib.host.textContent!, /release/)
    assert.match(lib.host.textContent!, /发布流程/)
    assert.match(lib.host.textContent!, /audit/)
    assert.match(lib.host.textContent!, /Metadata validation failed/, 'metadataError 条目必须如实展示诊断')

    const drawer = lib.host.querySelector('.workflow-lib-drawer') as HTMLElement | null
    assert.ok(drawer !== null, '选中 release 时内联抽屉挂载')
    const argsInput = drawer.querySelector('.workflow-library-args') as HTMLInputElement
    assert.ok(argsInput !== null)
    await act(async () => {
      setControlledValue(argsInput, '{oops}')
    })
    assert.equal(argsInput.value, '{oops}')

    // 切换到 audit：抽屉参数草稿自动清空，不串 release 草稿。
    await lib.rerender(
      e(LibraryScreen, { pluginId: 'builtin:workflow', screenId: 'library', isSplit: false, params: { wf: 'audit' }, setParams, inlineDrawer: true }),
    )
    const auditInput = lib.host.querySelector('.workflow-lib-drawer .workflow-library-args') as HTMLInputElement
    assert.equal(auditInput.value, '', '切换工作流后 args 草稿清空不串行')
  } finally {
    lib.unmount()
  }
})

test('节点卡改动概览：检视渲染与审阅；completed run 提供「重放」表单（空白沿用原 args）', { timeout: 60_000 }, async () => {
  const wtNode = node({
    id: 'c1',
    status: 'done',
    label: '实现者',
    worktree: {
      path: '/repo/.helmx-worktrees/app-ab12cd34',
      branch: 'helmx/spawn-ab12cd34',
      id: 'local:/repo/.helmx-worktrees/app-ab12cd34',
      baseCommit: '5f1e9c0aaa',
    },
  })
  const completedRun = run({
    id: 'wf_done',
    status: 'completed',
    savedName: 'release',
    parentToolCallId: 'wf_call',
    nodes: [wtNode],
  })
  setWorkflowClientStub({
    docValue: { runs: [completedRun] },
    conversations: [],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const ctx = makeRecordingCtx({
    inspect_worktree: INSPECT_RAW,
    run: { run: { id: 'wf_new' } },
  })
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(Panel, { conversation: workbenchConversation() }),
  )
  try {
    assert.ok(!host.textContent!.includes('Resume from checkpoint'), '已完成 run 不得提供断点恢复')
    act(() => {
      openMoreMenu(host)
    })
    assert.ok(host.textContent!.includes('Replay'), '已完成 run 更多操作菜单应提供重放入口')
    await act(async () => {
      buttonByText(host, 'Replay').click()
    })
    assert.match(host.textContent!, /wf_done/)
    assert.match(host.textContent!, /saved definition release executes the latest file content/)
    assert.match(host.textContent!, /The cache only reuses prefix nodes whose call payloads match exactly/, '必须如实说明缓存边界，不承诺改参必命中')
    const submitReplay = host.querySelector<HTMLButtonElement>('button[aria-label="Start replay"]')
    assert.ok(submitReplay !== null)
    await act(async () => {
      submitReplay!.click()
    })
    const runCalls = ctx.calls.filter((c) => c.action === 'run')
    assert.equal(runCalls.length, 1)
    assert.deepEqual(
      runCalls[0]!.input,
      { resumeFromRunId: 'wf_done', conversationId: 1 },
      '重放走 resumeFromRunId，新 run 保留原会话；空白 args 不携带覆盖',
    )

    // 展开改动概览：精确 worktreeId 选择器 + 真实渲染检视数据。
    await act(async () => {
      buttonByText(host, 'Change overview').click()
    })
    const inspectCalls = ctx.calls.filter((c) => c.action === 'inspect_worktree')
    assert.equal(inspectCalls.length, 1)
    assert.deepEqual(inspectCalls[0]!.input, { worktreeId: 'local:/repo/.helmx-worktrees/app-ab12cd34' })
    assert.match(host.textContent!, /Uncommitted changes/)
    assert.match(host.textContent!, /2 files/)
    assert.match(host.textContent!, /Commits ahead of base/)
    assert.match(host.textContent!, /\+committed change/, 'diff 预览必须渲染真实检视内容')
    assert.match(host.textContent!, /The diff covers tracked files only; untracked files are in the status list/, '必须明确 diff 不含未跟踪文件')

    await act(async () => {
      buttonByText(host, 'Ask the main conversation to review and merge').click()
    })
    assert.equal(ctx.submissions.length, 1)
    assert.equal(ctx.submissions[0]!.options?.conversationId, 1)
    assert.equal(ctx.submissions[0]!.options?.whenBusy, 'steer')
    assert.match(ctx.submissions[0]!.text, /\/repo\/\.helmx-worktrees\/app-ab12cd34/)
    assert.match(ctx.submissions[0]!.text, /Review read-only first/)
  } finally {
    unmount()
  }
})

test('检视失败显式呈现：错误可见且可重试，绝不伪造空统计', { timeout: 60_000 }, async () => {
  const wtNode = node({
    id: 'c1',
    status: 'done',
    worktree: { path: '/repo/.helmx-worktrees/gone', branch: 'helmx/spawn-gone', id: 'local:/repo/.helmx-worktrees/gone' },
  })
  const failedRun = run({ id: 'wf_fail', status: 'failed', resumable: true, parentToolCallId: 'wf_call2', nodes: [wtNode] })
  setWorkflowClientStub({
    docValue: { runs: [failedRun] },
    conversations: [],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const ctx = makeRecordingCtx({})
  ctx.callAction = async (action: string, input?: unknown) => {
    ctx.calls.push({ action, input })
    throw new Error('node offline: 探测失败')
  }
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(Panel, { conversation: workbenchConversation() }),
  )
  try {
    assert.ok(host.textContent!.includes('Resume from checkpoint'), '失败 run 应提供断点恢复')
    await act(async () => {
      buttonByText(host, 'Change overview').click()
    })
    assert.match(host.textContent!, /Read-only inspection failed/)
    assert.match(host.textContent!, /node offline/)
    assert.ok(host.textContent!.includes('Retry'), '错误态必须提供重试入口')
  } finally {
    unmount()
  }
})

test('重放表单：内联 run 可重放且显式 args 覆盖；非法 JSON 不提交', { timeout: 60_000 }, async () => {
  const inlineRun = run({
    id: 'wf_inline',
    status: 'completed',
    parentToolCallId: 'wf_call3',
    nodes: [],
  })
  setWorkflowClientStub({
    docValue: { runs: [inlineRun] },
    conversations: [],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const ctx = makeRecordingCtx({ run: { run: { id: 'wf_replay' } } })
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(Panel, { conversation: workbenchConversation() }),
  )
  try {
    act(() => {
      openMoreMenu(host)
    })
    await act(async () => {
      buttonByText(host, 'Replay').click()
    })
    assert.match(host.textContent!, /inline script keeps its original source/, '内联 run 重放须说明沿用原源码')
    const argsInput = host.querySelector('.workflow-replay-args') as HTMLInputElement
    await act(async () => {
      setControlledValue(argsInput, '{"target":"prod"}')
    })
    const submitReplay = host.querySelector<HTMLButtonElement>('button[aria-label="Start replay"]')
    assert.ok(submitReplay !== null)
    await act(async () => {
      submitReplay!.click()
    })
    let runCalls = ctx.calls.filter((c) => c.action === 'run')
    assert.equal(runCalls.length, 1)
    assert.deepEqual(runCalls[0]!.input, {
      resumeFromRunId: 'wf_inline',
      conversationId: 1,
      args: { target: 'prod' },
    }, '内联 run 重放保留原会话，显式 args 覆盖原 args')

    await act(async () => {
      setControlledValue(argsInput, '{oops}')
    })
    await act(async () => {
      submitReplay!.click()
    })
    runCalls = ctx.calls.filter((c) => c.action === 'run')
    assert.equal(runCalls.length, 1, '非法 args 不得提交重放')
    assert.match(host.textContent!, /args must be valid JSON/)
  } finally {
    unmount()
  }
})

test('工作台重放双击防重复：在途 ref 拦截，同拍连点只发一次请求', { timeout: 60_000 }, async () => {
  const completedRun = run({ id: 'wf_done2', status: 'completed', parentToolCallId: 'call-x', nodes: [] })
  setWorkflowClientStub({
    docValue: { runs: [completedRun] },
    conversations: [],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  let resolveRun: ((value: unknown) => void) | undefined
  const ctx = makeRecordingCtx({})
  ctx.callAction = async (action: string, input?: unknown) => {
    ctx.calls.push({ action, input })
    if (action === 'run') await new Promise((resolve) => { resolveRun = resolve })
    return undefined
  }
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const { host, unmount } = await mountClient(ctx, e(Panel, { conversation: workbenchConversation() }))
  try {
    act(() => {
      openMoreMenu(host)
    })
    await act(async () => {
      buttonByText(host, 'Replay').click()
    })
    const submit = host.querySelector('[aria-label="Start replay"]') as HTMLButtonElement
    assert.ok(submit !== null)
    await act(async () => {
      submit.click()
      submit.click()
    })
    assert.equal(ctx.calls.filter((c) => c.action === 'run').length, 1, '在途双击只发一次重放请求')
    await act(async () => {
      resolveRun?.({ run: { id: 'wf_new' } })
    })
  } finally {
    unmount()
  }
})

test('独立子代理卡检视：有工作树时提供入口；点击不触发整卡导航；清理/检视用精确选择器', { timeout: 60_000 }, async () => {
  const child = { ...workbenchConversation(), id: 11, title: '子会话 11', parentConversationId: 1, parentToolCallId: 'call-bg', cwd: '/wt' }
  const bgRun = run({
    id: 'wf_bg',
    kind: 'subagent',
    name: '后台任务',
    status: 'running',
    parentToolCallId: 'call-bg',
    createdAt: 1,
    updatedAt: 2,
    nodes: [{ id: 'n1', kind: 'agent', status: 'running', conversationId: 11, worktree: { path: '/wt/x', branch: 'helmx/x', id: 'local:/wt/x' } }],
  })
  setWorkflowClientStub({
    docValue: { runs: [bgRun] },
    conversations: [child],
    conversation: (id) =>
      id === 11
        ? { summary: child, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const ctx = makeRecordingCtx({ inspect_worktree: INSPECT_RAW })
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(Panel, { conversation: workbenchConversation() }),
  )
  try {
    const sections = host.querySelectorAll('.worktree-inspect')
    assert.equal(sections.length, 1, '独立子代理卡提供且仅提供一个检视节')
    const toggle = sections[0]!.querySelector('button') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    assert.deepEqual(ctx.calls.find((c) => c.action === 'inspect_worktree')!.input, { worktreeId: 'local:/wt/x' })
    assert.deepEqual(ctx.drawerCalls, [], '展开检视不得触发整卡打开抽屉')

    await act(async () => {
      buttonByText(host, 'Clean up worktree').click()
    })
    assert.deepEqual(ctx.calls.find((c) => c.action === 'cleanup_worktree')!.input, { worktreeId: 'local:/wt/x' })
    assert.deepEqual(ctx.drawerCalls, [], '动作按钮点击不得触发整卡导航')
  } finally {
    unmount()
  }
})

test('独立子代理卡检视：无登记 ID 时用 path+子会话节点消歧；审阅提交到真实父会话', { timeout: 60_000 }, async () => {
  const child = {
    ...workbenchConversation(),
    id: 12,
    title: '子会话 12',
    parentConversationId: 1,
    parentToolCallId: 'call-bg2',
    nodeId: 'remote-1',
    cwd: '/wt',
  }
  const bgRun = run({
    id: 'wf_bg2',
    kind: 'subagent',
    name: '远端后台任务',
    status: 'completed',
    parentToolCallId: 'call-bg2',
    createdAt: 1,
    updatedAt: 2,
    nodes: [{ id: 'n1', kind: 'agent', status: 'done', conversationId: 12, worktree: { path: '/shared/wt', branch: 'helmx/wt' } }],
  })
  setWorkflowClientStub({
    docValue: { runs: [bgRun] },
    conversations: [child],
    conversation: (id) =>
      id === 12
        ? { summary: child, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const ctx = makeRecordingCtx({ inspect_worktree: INSPECT_RAW })
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(Panel, { conversation: workbenchConversation() }),
  )
  try {
    const toggle = host.querySelector('.worktree-inspect button') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    assert.deepEqual(ctx.calls.find((c) => c.action === 'inspect_worktree')!.input, { path: '/shared/wt', nodeId: 'remote-1' })
    await act(async () => {
      buttonByText(host, 'Ask the main conversation to review and merge').click()
    })
    assert.equal(ctx.submissions.length, 1)
    assert.equal(ctx.submissions[0]!.options?.conversationId, 1)
  } finally {
    unmount()
  }
})

test('工作流节点卡不重复渲染检视节：节点外层一处，子代理卡内不再一处', { timeout: 60_000 }, async () => {
  const wtNode = node({
    id: 'c1',
    status: 'done',
    conversationId: 12,
    label: '实现者',
    worktree: { path: '/repo/w', branch: 'helmx/w', id: 'local:/repo/w' },
  })
  const dslRun = run({ id: 'wf_dsl', status: 'completed', parentToolCallId: 'wf_call4', nodes: [wtNode] })
  const child = { ...workbenchConversation(), id: 12, title: '子会话 12', parentConversationId: 1, cwd: '/repo' }
  setWorkflowClientStub({
    docValue: { runs: [dslRun] },
    conversations: [child],
    conversation: (id) =>
      id === 12
        ? { summary: child, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const ctx = makeRecordingCtx({})
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(Panel, { conversation: workbenchConversation() }),
  )
  try {
    assert.equal(host.querySelectorAll('.worktree-inspect').length, 1, 'workflow 节点卡只在外层渲染检视节，避免重复')
  } finally {
    unmount()
  }
})
