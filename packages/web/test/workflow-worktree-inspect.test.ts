/**
 * builtin:workflow 插件 client 新增能力测试（真实 esbuild 编译产物）：
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
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConversationSummary, PluginClientContext as PluginClientContextType, ToolViewProps, WorkbenchPanelProps, WorkflowNodeState, WorkflowRunSummary } from '@helm/protocol'
import { PluginClientContext } from '../src/lib/plugin-client-context.js'
import {
  importWorkflowClientModule,
  importWorkflowModels,
  mountSharedPluginNamespaces,
  setWorkflowClientStub,
} from './helpers/workflow-client.js'

const e = React.createElement

GlobalRegistrator.register()
mountSharedPluginNamespaces()
// React 19 act 环境：事件处理器在 act 外静默抑制更新断言；显式开启
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
// 宿主共享 SDK 源文件（如 CopyButton.tsx）在 tsx 下按 classic JSX 编译，
// 引用全局 React；注入同一实例避免 ReferenceError（不产生第二份 React）。
;(globalThis as Record<string, unknown>).React = React
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
    id: 'local:/repo/.helm-worktrees/app-ab12cd34',
    nodeId: 'local',
    path: '/repo/.helm-worktrees/app-ab12cd34',
    branch: 'helm/spawn-ab12cd34',
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
  currentBranch: 'helm/spawn-ab12cd34',
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
  assert.equal(parsed!.worktreeId, 'local:/repo/.helm-worktrees/app-ab12cd34')
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
  // exists 必需 boolean：缺失或非布尔不得默认成 false（会被展示成目录已清理）。
  assert.equal(m.parseWorktreeInspectResult(without('exists')), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, exists: 'yes' }), undefined)
  // dirtyFiles 必需纯 string[]：非数组或混入非字符串不得静默过滤成空清单。
  assert.equal(m.parseWorktreeInspectResult(without('dirtyFiles')), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, dirtyFiles: ['?? a', 42] }), undefined)
  // dirtyFileCount 必需非负安全整数：缺失不得回退数组长度。负数/小数拒绝。
  assert.equal(m.parseWorktreeInspectResult(without('dirtyFileCount')), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, dirtyFileCount: -1 }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, dirtyFileCount: 1.5 }), undefined)
  // 计数一致性：未截断时计数必须等于列表长度；截断时计数必须大于列表长度。
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, dirtyFileCount: 3 }), undefined)
  const truncated = m.parseWorktreeInspectResult({
    ...INSPECT_RAW,
    dirtyFiles: INSPECT_RAW.dirtyFiles.slice(0, 1),
    dirtyFilesTruncated: true,
  })
  assert.ok(truncated !== undefined, '截断时计数(2) > 列表长度(1) 合法')
  assert.equal(truncated!.dirtyFileCount, 2)
  // 截断标记必需 boolean。
  assert.equal(m.parseWorktreeInspectResult(without('dirtyFilesTruncated')), undefined)
  assert.equal(m.parseWorktreeInspectResult(without('diffTruncated')), undefined)
  // diffBase 必需枚举。
  assert.equal(m.parseWorktreeInspectResult(without('diffBase')), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, diffBase: 'main' }), undefined)
  // record 枚举字段非法拒绝；可选字段类型错位拒绝。
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, record: { ...INSPECT_RAW.record, status: 'weird' } }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, record: { ...INSPECT_RAW.record, origin: 'weird' } }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, unavailableReason: 'whatever' }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, commitsAhead: -2 }), undefined)
  assert.equal(m.parseWorktreeInspectResult({ ...INSPECT_RAW, branchChanged: 'yes' }), undefined)
  // baseCommit 允许空串（external 记录无基线，diffBase 退化 HEAD）。
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
  const text = m.buildWorktreeReviewRequest({
    path: '/repo/.helm-worktrees/app-ab12cd34',
    branch: 'helm/spawn-ab12cd34',
    nodeId: 'local',
    baseCommit: '5f1e9c0aaa',
    taskLabel: '修复构建',
    inspect: m.parseWorktreeInspectResult(INSPECT_RAW),
  })
  assert.match(text, /\/repo\/\.helm-worktrees\/app-ab12cd34/)
  assert.match(text, /节点 local/)
  assert.match(text, /helm\/spawn-ab12cd34/)
  assert.match(text, /5f1e9c0aaa\d*/)
  assert.match(text, /未提交修改：2 个文件/)
  assert.match(text, /领先基线提交：1 个/)
  assert.match(text, /只读复核/)

  const mismatched = m.buildWorktreeReviewRequest({
    path: '/w',
    branch: 'helm/spawn-x',
    inspect: m.parseWorktreeInspectResult({ ...INSPECT_RAW, currentBranch: 'main', branchChanged: true }),
  })
  assert.match(mismatched, /当前分支 main 与登记分支不一致/)
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
  if (bad.ok === false) assert.match(bad.error, /合法 JSON/)
})

test('canReplayWorkflowRun：非 subagent 的 completed run（含内联）可重放；canResume 仍限失败/中止', { timeout: 60_000 }, () => {
  assert.equal(m.canReplayWorkflowRun(run({ status: 'completed', savedName: 'release', kind: 'workflow' })), true)
  assert.equal(m.canReplayWorkflowRun(run({ status: 'completed', kind: 'workflow' })), true, '内联脚本 run 同样可经 resumeFromRunId 重放（沿用原源码）')
  assert.equal(m.canReplayWorkflowRun(run({ status: 'failed', savedName: 'release' })), false)
  assert.equal(m.canReplayWorkflowRun(run({ status: 'running' })), false)
  assert.equal(m.canReplayWorkflowRun(run({ status: 'completed', savedName: 'release', kind: 'subagent' })), false, '后台单子代理不提供重放入口')
  assert.equal(m.canResumeWorkflowRun(run({ status: 'completed', savedName: 'release' })), false, '已完成 run 不走断点恢复按钮')
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed' })), true)
})

// ---------------------------------------------------------------------------
// DOM 交互：编译产物组件（共享宿主 React + PluginClientContext）
// ---------------------------------------------------------------------------

interface RecordingCtx extends PluginClientContextType {
  calls: Array<{ action: string; input: unknown }>
  submissions: Array<{ text: string; options?: Record<string, unknown> }>
  notices: string[]
  drawerCalls: number[]
}

function makeRecordingCtx(actionResults: Record<string, unknown>): RecordingCtx {
  const calls: RecordingCtx['calls'] = []
  const submissions: RecordingCtx['submissions'] = []
  const notices: string[] = []
  const drawerCalls: number[] = []
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
    openScreen: () => {},
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
    calls,
    submissions,
    notices,
    drawerCalls,
  }
}

async function mountClient(
  ctx: PluginClientContextType,
  element: React.ReactElement,
): Promise<{ host: HTMLElement; unmount: () => void }> {
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
    unmount: () => {
      act(() => root?.unmount())
      host.remove()
    },
  }
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const buttons = [...host.querySelectorAll('button')] as HTMLButtonElement[]
  const found = buttons.find((b) => (b.textContent ?? '').includes(text))
  assert.ok(found !== null, `应存在含「${text}」的按钮（实得：${buttons.map((b) => b.textContent).join(' | ')}）`)
  return found!
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

/** 工作流库中指定名称行（含该行的输入与运行按钮）。 */
function libraryRow(host: HTMLElement, name: string): HTMLElement {
  const rows = [...host.querySelectorAll('.workflow-library-item')] as HTMLElement[]
  const row = rows.find((r) => r.querySelector('.workflow-library-name')?.textContent === name)
  assert.ok(row !== undefined, `应存在工作流行 ${name}`)
  return row!
}

test('工作流库：渲染已保存定义与元数据；每行独立 args 草稿不串行', { timeout: 60_000 }, async () => {
  setWorkflowClientStub({
    docValue: { runs: [] },
    conversations: [],
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
    run: { run: { id: 'wf_new' } },
  })
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const { host, unmount } = await mountClient(ctx, e(Panel, { conversation: workbenchConversation() }))
  try {
    assert.match(host.textContent!, /工作流库/)
    assert.match(host.textContent!, /release/)
    assert.match(host.textContent!, /发布流程/)
    assert.match(host.textContent!, /2 阶段：检查 \/ 发布/)
    assert.match(host.textContent!, /元数据校验失败/, 'metadataError 条目必须如实展示诊断')
    assert.equal(host.querySelectorAll('.workflow-library-args').length, 3, '每行一个 args 输入')

    // 空 args：按名运行到当前会话（args 缺省不携带，沿用脚本缺省）。
    await act(async () => {
      buttonByText(libraryRow(host, 'release'), '运行').click()
    })
    assert.deepEqual(ctx.calls.find((c) => c.action === 'run')!.input, { name: 'release', conversationId: 1 })

    // 每行独立草稿：release 行填 {"a":1}，audit 行填 {"b":2}，各自携带各自 args。
    const releaseInput = libraryRow(host, 'release').querySelector('.workflow-library-args') as HTMLInputElement
    const auditInput = libraryRow(host, 'audit').querySelector('.workflow-library-args') as HTMLInputElement
    await act(async () => {
      setControlledValue(releaseInput, '{"a":1}')
    })
    assert.equal(releaseInput.value, '{"a":1}')
    assert.equal(auditInput.value, '', '另一行草稿不受影响')
    await act(async () => {
      buttonByText(libraryRow(host, 'release'), '运行').click()
    })
    assert.deepEqual(
      ctx.calls.filter((c) => c.action === 'run').at(-1)!.input,
      { name: 'release', conversationId: 1, args: { a: 1 } },
    )
    await act(async () => {
      setControlledValue(auditInput, '{"b":2}')
    })
    await act(async () => {
      buttonByText(libraryRow(host, 'audit'), '运行').click()
    })
    assert.deepEqual(
      ctx.calls.filter((c) => c.action === 'run').at(-1)!.input,
      { name: 'audit', conversationId: 1, args: { b: 2 } },
      '第二行携带自己的 args，不串第一行草稿',
    )

    // 每行独立错误：release 行填非法 JSON，错误只出现在该行，audit 行仍可运行。
    await act(async () => {
      setControlledValue(releaseInput, '{oops}')
    })
    await act(async () => {
      buttonByText(libraryRow(host, 'release'), '运行').click()
    })
    assert.match(libraryRow(host, 'release').textContent!, /合法 JSON/)
    assert.equal(libraryRow(host, 'audit').querySelector('.callout'), null, '解析错误不得串到其他行')
    assert.equal(
      ctx.calls.filter((c) => c.action === 'run').length,
      3,
      '非法 JSON 不得提交 run 动作',
    )
  } finally {
    unmount()
  }
})

test('节点卡改动概览：检视渲染与审阅；completed run 提供「重放」表单（空白沿用原 args）', { timeout: 60_000 }, async () => {
  const wtNode = node({
    id: 'c1',
    status: 'done',
    label: '实现者',
    worktree: {
      path: '/repo/.helm-worktrees/app-ab12cd34',
      branch: 'helm/spawn-ab12cd34',
      id: 'local:/repo/.helm-worktrees/app-ab12cd34',
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
  const ToolView = mod['WorkflowToolView'] as (p: Partial<ToolViewProps>) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(ToolView, {
      callId: 'wf_call', toolName: 'SubagentWorkflow', input: { name: 'release' },
      status: 'done', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    // 已完成 DSL run：提供「重放」入口，不提供断点恢复。
    assert.ok(host.textContent!.includes('重放'), '已完成 run 应提供重放入口')
    assert.ok(!host.textContent!.includes('断点恢复'), '已完成 run 不得提供断点恢复')
    await act(async () => {
      buttonByText(host, '重放').click()
    })
    // 表单展示源 run 标识与缓存语义说明；空白 args 不覆盖原 args。
    assert.match(host.textContent!, /wf_done/)
    assert.match(host.textContent!, /已保存定义 release 按最新文件内容执行/)
    assert.match(host.textContent!, /缓存仅复用调用载荷完全相同的前缀节点/, '必须如实说明缓存边界，不承诺改参必命中')
    await act(async () => {
      buttonByText(host, '发起重放').click()
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
      buttonByText(host, '改动概览').click()
    })
    const inspectCalls = ctx.calls.filter((c) => c.action === 'inspect_worktree')
    assert.equal(inspectCalls.length, 1)
    assert.deepEqual(inspectCalls[0]!.input, { worktreeId: 'local:/repo/.helm-worktrees/app-ab12cd34' })
    assert.match(host.textContent!, /未提交修改/)
    assert.match(host.textContent!, /2 个文件/)
    assert.match(host.textContent!, /领先基线提交/)
    assert.match(host.textContent!, /\+committed change/, 'diff 预览必须渲染真实检视内容')
    assert.match(host.textContent!, /Diff 仅包含已跟踪文件；未跟踪文件见状态列表/, '必须明确 diff 不含未跟踪文件')

    // 审阅请求：走官方 submitInput（目标父会话 1，followUp 不打断在途回合）。
    await act(async () => {
      buttonByText(host, '让主会话审阅并合入').click()
    })
    assert.equal(ctx.submissions.length, 1)
    assert.equal(ctx.submissions[0]!.options?.conversationId, 1)
    assert.equal(ctx.submissions[0]!.options?.whenBusy, 'followUp')
    assert.match(ctx.submissions[0]!.text, /\/repo\/\.helm-worktrees\/app-ab12cd34/)
    assert.match(ctx.submissions[0]!.text, /只读复核/)
  } finally {
    unmount()
  }
})

test('检视失败显式呈现：错误可见且可重试，绝不伪造空统计', { timeout: 60_000 }, async () => {
  const wtNode = node({
    id: 'c1',
    status: 'done',
    worktree: { path: '/repo/.helm-worktrees/gone', branch: 'helm/spawn-gone', id: 'local:/repo/.helm-worktrees/gone' },
  })
  const failedRun = run({ id: 'wf_fail', status: 'failed', parentToolCallId: 'wf_call2', nodes: [wtNode] })
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
  const ToolView = mod['WorkflowToolView'] as (p: Partial<ToolViewProps>) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(ToolView, {
      callId: 'wf_call2', toolName: 'SubagentWorkflow', input: { script: 'x' },
      status: 'error', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    assert.ok(host.textContent!.includes('断点恢复'), '失败 run 应提供断点恢复')
    await act(async () => {
      buttonByText(host, '改动概览').click()
    })
    assert.match(host.textContent!, /只读检视失败/)
    assert.match(host.textContent!, /node offline/)
    assert.ok(host.textContent!.includes('重试'), '错误态必须提供重试入口')
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
  const ToolView = mod['WorkflowToolView'] as (p: Partial<ToolViewProps>) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(ToolView, {
      callId: 'wf_call3', toolName: 'SubagentWorkflow', input: { script: 'x' },
      status: 'done', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    await act(async () => {
      buttonByText(host, '重放').click()
    })
    assert.match(host.textContent!, /内联脚本沿用原源码/, '内联 run 重放须说明沿用原源码')
    // 显式 args：严格解析后作为覆盖提交。
    const argsInput = host.querySelector('.workflow-replay-args') as HTMLInputElement
    await act(async () => {
      setControlledValue(argsInput, '{"target":"prod"}')
    })
    await act(async () => {
      buttonByText(host, '发起重放').click()
    })
    let runCalls = ctx.calls.filter((c) => c.action === 'run')
    assert.equal(runCalls.length, 1)
    assert.deepEqual(runCalls[0]!.input, {
      resumeFromRunId: 'wf_inline',
      conversationId: 1,
      args: { target: 'prod' },
    }, '内联 run 重放保留原会话，显式 args 覆盖原 args')

    // 非法 JSON：行内显式报错，不提交。
    await act(async () => {
      setControlledValue(argsInput, '{oops}')
    })
    await act(async () => {
      buttonByText(host, '发起重放').click()
    })
    runCalls = ctx.calls.filter((c) => c.action === 'run')
    assert.equal(runCalls.length, 1, '非法 args 不得提交重放')
    assert.match(host.textContent!, /args 需为合法 JSON/)
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
    await act(async () => {
      buttonByText(host, '重放').click()
    })
    const submit = host.querySelector('[aria-label="发起重放"]') as HTMLButtonElement
    assert.ok(submit !== null)
    // 同拍双击：渲染尚未刷新（busy 状态未落盘）时靠同步 ref 拦截第二次。
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
    nodes: [{ id: 'n1', kind: 'agent', status: 'running', conversationId: 11, worktree: { path: '/wt/x', branch: 'helm/x', id: 'local:/wt/x' } }],
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
  const SubagentToolView = mod['SubagentToolView'] as (p: Partial<ToolViewProps>) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(SubagentToolView, {
      callId: 'call-bg', toolName: 'subagent', input: { prompt: '后台任务' },
      status: 'done', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    // 独立子代理卡内嵌检视入口；展开用登记 ID 精确选择器。
    const sections = host.querySelectorAll('.worktree-inspect')
    assert.equal(sections.length, 1, '独立子代理卡提供且仅提供一个检视节')
    const toggle = sections[0]!.querySelector('button') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    assert.deepEqual(ctx.calls.find((c) => c.action === 'inspect_worktree')!.input, { worktreeId: 'local:/wt/x' })
    assert.deepEqual(ctx.drawerCalls, [], '展开检视不得触发整卡打开抽屉')

    // 清理：同样优先登记 ID。
    await act(async () => {
      buttonByText(host, '清理工作树').click()
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
    nodes: [{ id: 'n1', kind: 'agent', status: 'done', conversationId: 12, worktree: { path: '/shared/wt', branch: 'helm/wt' } }],
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
  const SubagentToolView = mod['SubagentToolView'] as (p: Partial<ToolViewProps>) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(SubagentToolView, {
      callId: 'call-bg2', toolName: 'subagent', input: { prompt: '远端任务' },
      status: 'done', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    const toggle = host.querySelector('.worktree-inspect button') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    // 无登记 ID：path + 子会话绑定节点消歧（避免跨节点同路径误满）。
    assert.deepEqual(ctx.calls.find((c) => c.action === 'inspect_worktree')!.input, { path: '/shared/wt', nodeId: 'remote-1' })
    // 审阅请求提交到调用处真实父会话（非子会话）。
    await act(async () => {
      buttonByText(host, '让主会话审阅并合入').click()
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
    worktree: { path: '/repo/w', branch: 'helm/w', id: 'local:/repo/w' },
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
  const ToolView = mod['WorkflowToolView'] as (p: Partial<ToolViewProps>) => React.ReactElement
  const { host, unmount } = await mountClient(
    ctx,
    e(ToolView, {
      callId: 'wf_call4', toolName: 'SubagentWorkflow', input: { script: 'x' },
      status: 'done', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    assert.equal(host.querySelectorAll('.worktree-inspect').length, 1, 'workflow 节点卡只在外层渲染检视节，避免重复')
  } finally {
    unmount()
  }
})
