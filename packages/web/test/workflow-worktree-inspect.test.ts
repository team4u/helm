/**
 * builtin:workflow 插件 client 新增能力测试（真实 esbuild 编译产物）：
 * - 纯逻辑（models.ts 编译产物）：parseWorktreeInspectResult /
 *   buildWorktreeInspectSelector / buildWorktreeReviewRequest /
 *   parseSavedWorkflowList / parseWorkflowArgsInput / canRerunWorkflowRun；
 * - DOM 交互（index.tsx 编译产物，happy-dom + React act）：
 *   工作流库渲染与运行（args 严格解析，非法 JSON 不提交）、
 *   节点卡工作树只读改动概览（inspect_worktree 调用 + diff 预览渲染 +
 *   「让主会话审阅并合入」submitInput 审阅请求）、已完成 run 重跑按钮语义。
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
// 注：本环境下 React 19 对 happy-dom 派发的 input/change 事件不触发
// onChange（独立探针验证），args 输入的严格解析由纯函数测试覆盖；DOM
// 用例只验证空 args 路径与渲染。

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

test('buildWorktreeInspectSelector：登记 ID 优先；无 ID 时 path+nodeId 消歧', { timeout: 60_000 }, () => {
  assert.deepEqual(
    m.buildWorktreeInspectSelector({ id: 'local:/a', path: '/a' }, 'local'),
    { worktreeId: 'local:/a' },
  )
  assert.deepEqual(m.buildWorktreeInspectSelector({ path: '/a' }, 'local'), { path: '/a', nodeId: 'local' })
  assert.deepEqual(m.buildWorktreeInspectSelector({ path: '/a' }, undefined), { path: '/a' })
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

test('parseSavedWorkflowList：合法列表解析（含 metadataError 条目）；非法形状 undefined', { timeout: 60_000 }, () => {
  const parsed = m.parseSavedWorkflowList({
    workflows: [
      { name: 'release', description: '发布流程', whenToUse: '发版时', phases: [{ title: '检查' }, { title: '发布', detail: '执行发布' }] },
      { name: 'broken', metadataError: 'meta.name is required' },
    ],
  })
  assert.ok(parsed !== undefined)
  assert.equal(parsed!.length, 2)
  assert.equal(parsed![0]!.name, 'release')
  assert.deepEqual(parsed![0]!.phases!.map((p) => p.title), ['检查', '发布'])
  assert.equal(parsed![1]!.metadataError, 'meta.name is required')

  assert.equal(m.parseSavedWorkflowList(undefined), undefined)
  assert.equal(m.parseSavedWorkflowList({ workflows: 'nope' }), undefined)
  const withJunk = m.parseSavedWorkflowList({ workflows: [{ name: 'ok' }, 42, { noName: true }] })
  assert.equal(withJunk!.length, 1, '非法条目跳过，合法条目保留')
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

test('canRerunWorkflowRun：仅已完成 + 已保存定义的 DSL run 可重跑；canResume 仍限失败/中止', { timeout: 60_000 }, () => {
  assert.equal(m.canRerunWorkflowRun(run({ status: 'completed', savedName: 'release', kind: 'workflow' })), true)
  assert.equal(m.canRerunWorkflowRun(run({ status: 'completed', kind: 'workflow' })), false, '内联脚本 run 无 savedName 不给重跑入口')
  assert.equal(m.canRerunWorkflowRun(run({ status: 'failed', savedName: 'release' })), false)
  assert.equal(m.canRerunWorkflowRun(run({ status: 'completed', savedName: 'release', kind: 'subagent' })), false)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'completed', savedName: 'release' })), false, '已完成 run 绝不提供断点恢复')
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed' })), true)
})

// ---------------------------------------------------------------------------
// DOM 交互：编译产物组件（共享宿主 React + PluginClientContext）
// ---------------------------------------------------------------------------

interface RecordingCtx extends PluginClientContextType {
  calls: Array<{ action: string; input: unknown }>
  submissions: Array<{ text: string; options?: Record<string, unknown> }>
  notices: string[]
}

function makeRecordingCtx(actionResults: Record<string, unknown>): RecordingCtx {
  const calls: RecordingCtx['calls'] = []
  const submissions: RecordingCtx['submissions'] = []
  const notices: string[] = []
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
    openConversationDrawer: () => {},
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

test('工作流库：渲染已保存定义与元数据；空 args 按名运行到当前会话', { timeout: 60_000 }, async () => {
  setWorkflowClientStub({
    docValue: { runs: [] },
    conversations: [],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const ctx = makeRecordingCtx({
    list: {
      workflows: [
        { name: 'release', description: '发布流程：检查并发布', whenToUse: '发版时', phases: [{ title: '检查' }, { title: '发布' }] },
        { name: 'broken', metadataError: 'meta.name is required' },
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
    assert.ok(host.querySelector('.workflow-library-args') !== null, 'args JSON 输入应存在')

    // 空 args：按名运行到当前会话（args 缺省不携带，沿用脚本缺省）。
    await act(async () => {
      buttonByText(host, '运行').click()
    })
    const runCalls = ctx.calls.filter((c) => c.action === 'run')
    assert.equal(runCalls.length, 1)
    assert.deepEqual(runCalls[0]!.input, { name: 'release', conversationId: 1 })
  } finally {
    unmount()
  }
})

test('节点卡改动概览：inspect_worktree 精确选择器拉取并渲染 diff；审阅请求走 submitInput', { timeout: 60_000 }, async () => {
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
    // 已完成 + 已保存定义：重跑可见、断点恢复不可见（不误用 resumeFromRunId）。
    assert.ok(host.textContent!.includes('重跑'), '已完成已保存 run 应提供重跑入口')
    assert.ok(!host.textContent!.includes('断点恢复'), '已完成 run 不得提供断点恢复')
    await act(async () => {
      buttonByText(host, '重跑').click()
    })
    const runCalls = ctx.calls.filter((c) => c.action === 'run')
    assert.equal(runCalls.length, 1)
    assert.deepEqual(runCalls[0]!.input, { name: 'release' }, '重跑 = 按保存定义全新运行，不携带 resumeFromRunId')

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
