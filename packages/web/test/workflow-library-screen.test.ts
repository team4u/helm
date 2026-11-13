/**
 * builtin:workflow 工作流库 client 测试（真实 esbuild 编译产物）：
 * - 纯逻辑（models.ts 编译产物）：parseSavedWorkflowList 严格文件事实
 *   （updatedAt/size）/ parseWorkflowDetail / parseWorkflowSaveResult /
 *   canSaveRunAsWorkflow / buildWorkflowEditRequest；
 * - DOM 交互（index.tsx 编译产物，happy-dom + React act）：
 *   WorkflowLibraryScreen 卡片网格与深链参数、详情抽屉只读源码（get 动作、
 *   无任何编辑输入）、删除两步确认（delete 动作 + 刷新 + 参数清理）、
 *   抽屉运行需显式选择目标会话（空会话时禁用）；工作台运行卡「保存为工作流」
 *   仅在适合的 run（非 subagent 且非已保存定义发起）显示并调用 save fromRunId。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConversationSummary, PluginClientContext as PluginClientContextType, ScreenProps, WorkbenchPanelProps, WorkflowRunSummary } from '@helm/protocol'
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
;(globalThis as Record<string, unknown>).React = React
const m = await importWorkflowModels()

// ---------------------------------------------------------------------------
// 纯逻辑：列表/详情/保存结果严格解析、可保存判定、修改请求文案
// ---------------------------------------------------------------------------

const LIST_RAW = {
  workflows: [
    {
      name: 'release',
      description: '发布流程',
      whenToUse: '发版时',
      updatedAt: 1_700_000_000_000,
      size: 4096,
      phases: [{ title: '检查' }, { title: '发布', detail: '执行发布' }],
      path: '/data/workflows/release.js',
    },
    { name: 'broken', updatedAt: 1, size: 2, metadataError: 'meta.name is required' },
  ],
}

test('parseSavedWorkflowList：updatedAt/size 必需非负安全整数，缺失/负数/小数整体拒绝', { timeout: 60_000 }, () => {
  const parsed = m.parseSavedWorkflowList(LIST_RAW)
  assert.ok(parsed !== undefined)
  assert.equal(parsed!.length, 2)
  assert.equal(parsed![0]!.updatedAt, 1_700_000_000_000)
  assert.equal(parsed![0]!.size, 4096)
  assert.equal(parsed![1]!.metadataError, 'meta.name is required')

  const without = (key: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const first = { ...(LIST_RAW.workflows[0] as Record<string, unknown>), ...extra }
    delete first[key]
    return { workflows: [first] }
  }
  assert.equal(m.parseSavedWorkflowList(without('updatedAt')), undefined, '缺 updatedAt 必须整体拒绝')
  assert.equal(m.parseSavedWorkflowList(without('size')), undefined, '缺 size 必须整体拒绝')
  assert.equal(m.parseSavedWorkflowList(without('updatedAt', { updatedAt: -1 })), undefined)
  assert.equal(m.parseSavedWorkflowList(without('size', { size: 1.5 })), undefined)
  assert.equal(m.parseSavedWorkflowList(without('size', { size: '4096' })), undefined)
})

test('parseWorkflowDetail：合法详情解析；缺 script / 空 script / 条目非法拒绝', { timeout: 60_000 }, () => {
  const detail = m.parseWorkflowDetail({
    workflow: { ...(LIST_RAW.workflows[0] as Record<string, unknown>), script: 'export const meta = {}\nreturn 1' },
  })
  assert.ok(detail !== undefined)
  assert.equal(detail!.script, 'export const meta = {}\nreturn 1')
  assert.equal(detail!.name, 'release')

  const entry = LIST_RAW.workflows[0] as Record<string, unknown>
  assert.equal(m.parseWorkflowDetail({ workflow: entry }), undefined, '缺 script 拒绝')
  assert.equal(m.parseWorkflowDetail({ workflow: { ...entry, script: '' } }), undefined, '空 script 拒绝')
  assert.equal(m.parseWorkflowDetail({ workflow: 42 }), undefined)
  assert.equal(m.parseWorkflowDetail(undefined), undefined)
})

test('parseWorkflowSaveResult：created 必需 boolean，workflow 必需合法摘要', { timeout: 60_000 }, () => {
  const ok = m.parseWorkflowSaveResult({ created: true, workflow: LIST_RAW.workflows[0] })
  assert.ok(ok !== undefined)
  assert.equal(ok!.created, true)
  assert.equal(ok!.workflow.name, 'release')

  assert.equal(m.parseWorkflowSaveResult({ workflow: LIST_RAW.workflows[0] }), undefined)
  assert.equal(m.parseWorkflowSaveResult({ created: 'yes', workflow: LIST_RAW.workflows[0] }), undefined)
  assert.equal(m.parseWorkflowSaveResult({ created: true }), undefined)
})

test('canSaveRunAsWorkflow：非 subagent 且无 savedName 才可保存；已保存定义/子代理/后台不显示', { timeout: 60_000 }, () => {
  const base = { id: 'wf_1', name: 'n', conversationId: 1, status: 'completed', createdAt: 1, updatedAt: 2 } as WorkflowRunSummary
  assert.equal(m.canSaveRunAsWorkflow(base), true, '内联 DSL run 可一键保存')
  assert.equal(m.canSaveRunAsWorkflow({ ...base, savedName: 'release' } satisfies WorkflowRunSummary), false, '已保存定义发起的 run 不再提供保存入口')
  assert.equal(m.canSaveRunAsWorkflow({ ...base, kind: 'subagent' } satisfies WorkflowRunSummary), false)
  assert.equal(m.canSaveRunAsWorkflow({ ...base, kind: 'workflow' } satisfies WorkflowRunSummary), true)
})

test('buildWorkflowEditRequest：含名称与 get/save 能力指引，不伪造 Web 编辑', { timeout: 60_000 }, () => {
  const text = m.buildWorkflowEditRequest('release', { description: '发布流程' })
  assert.match(text, /release/)
  assert.match(text, /workflows get/)
  assert.match(text, /workflows save/)
  assert.match(text, /overwrite/)
  assert.match(text, /发布流程/)
})

// ---------------------------------------------------------------------------
// DOM 交互：编译产物组件（共享宿主 React + PluginClientContext）
// ---------------------------------------------------------------------------

interface RecordingCtx extends PluginClientContextType {
  calls: Array<{ action: string; input: unknown }>
  notices: Array<{ message: string; tone?: string }>
  screenTargets: string[]
}

function makeRecordingCtx(actionResults: Record<string, unknown>): RecordingCtx {
  const calls: RecordingCtx['calls'] = []
  const notices: RecordingCtx['notices'] = []
  const screenTargets: string[] = []
  return {
    pluginId: 'builtin:workflow',
    callAction: async (action: string, input?: unknown) => {
      calls.push({ action, input })
      if (action in actionResults) return actionResults[action]!
      return undefined
    },
    submitInput: async () => {},
    openScreen: (target: string) => {
      screenTargets.push(target)
    },
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: (message: string, tone?: 'info' | 'warning' | 'error') => {
      notices.push({ message, tone })
    },
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark',
    calls,
    notices,
    screenTargets,
  }
}

function screenProps(initial: Record<string, string> = {}): ScreenProps & { setParamsCalls: Array<Record<string, string | undefined>> } {
  const params: Record<string, string> = { ...initial }
  const setParamsCalls: Array<Record<string, string | undefined>> = []
  return {
    pluginId: 'builtin:workflow',
    screenId: 'library',
    isSplit: false,
    get params() {
      return { ...params }
    },
    setParams: (patch) => {
      setParamsCalls.push(patch)
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete params[key]
        else params[key] = value
      }
    },
    setParamsCalls,
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

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const buttons = [...scope.querySelectorAll('button')] as HTMLButtonElement[]
  const found = buttons.find((b) => (b.textContent ?? '').includes(text))
  assert.ok(found !== null, `应存在含「${text}」的按钮（实得：${buttons.map((b) => b.textContent).join(' | ')}）`)
  return found!
}

const LIST_RESULT = {
  workflows: [
    {
      name: 'release',
      description: '发布流程：检查并发布',
      updatedAt: 1_700_000_123_456,
      size: 4096,
      phases: [{ title: '检查' }, { title: '发布' }],
      path: '/data/workflows/release.js',
    },
    { name: 'audit', description: '审计流程', updatedAt: 1_700_000_000_000, size: 1024 },
    { name: 'broken', updatedAt: 1, size: 2, metadataError: 'meta.name is required' },
  ],
}

const GET_RESULT = {
  workflow: {
    name: 'release',
    description: '发布流程：检查并发布',
    updatedAt: 1_700_000_123_456,
    size: 4096,
    script: 'export const meta = { name: "release", description: "发布" }\nreturn 1',
  },
}

test('工作流库 Screen：卡片网格渲染文件事实与元数据诊断；点卡片回写 wf 深链参数', { timeout: 60_000 }, async () => {
  setWorkflowClientStub({
    docValue: { runs: [] },
    conversations: [],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const ctx = makeRecordingCtx({ list: LIST_RESULT })
  const mod = await importWorkflowClientModule('index.tsx')
  const Screen = mod['WorkflowLibraryScreen'] as (p: ScreenProps) => React.ReactElement
  const props = screenProps()
  const { host, unmount } = await mountClient(ctx, e(Screen, props))
  try {
    assert.match(host.textContent!, /工作流库/)
    assert.equal(host.querySelectorAll('.workflow-lib-card').length, 3)
    assert.match(host.textContent!, /发布流程/)
    assert.match(host.textContent!, /元数据校验失败/, 'metadataError 条目必须如实展示诊断')
    // 无选中项时不渲染抽屉。
    assert.equal(document.body.querySelector('.workflow-lib-drawer'), null)

    await act(async () => {
      ;([...host.querySelectorAll('.workflow-lib-card')] as HTMLElement[])[0]!.click()
    })
    assert.deepEqual(
      props.setParamsCalls.filter((p) => 'wf' in p),
      [{ wf: 'release' }],
      '点击卡片经 setParams 唯一导航机制回写 wf 参数',
    )
  } finally {
    unmount()
  }
})

test('详情抽屉：深链 wf 参数直开；get 只读源码渲染、无编辑输入；删除两步确认后刷新并清理参数', { timeout: 60_000 }, async () => {
  setWorkflowClientStub({
    docValue: { runs: [] },
    conversations: [],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const ctx = makeRecordingCtx({ list: LIST_RESULT, get: GET_RESULT, delete: { deleted: true, name: 'release', path: '/data/workflows/release.js' } })
  const mod = await importWorkflowClientModule('index.tsx')
  const Screen = mod['WorkflowLibraryScreen'] as (p: ScreenProps & { inlineDrawer?: boolean }) => React.ReactElement
  const props = screenProps({ wf: 'release' })
  const { host, unmount } = await mountClient(ctx, e(Screen, { ...props, inlineDrawer: true }))
  try {
    const drawer = document.body.querySelector('.workflow-lib-drawer')
    assert.ok(drawer !== null, 'wf 深链参数直接打开详情抽屉')
    // get 动作按名精确调用；源码只读渲染（pre/code），无任何 textarea/编辑输入。
    assert.deepEqual(ctx.calls.find((c) => c.action === 'get')!.input, { name: 'release' })
    assert.match(drawer.textContent!, /export const meta = \{ name: "release"/)
    assert.equal(drawer.querySelectorAll('textarea').length, 0, '抽屉不得提供源码编辑器')
    assert.match(drawer.textContent!, /不提供源码编辑器/, '必须明示创建与修改由 AI / CLI 完成')
    assert.match(drawer.textContent!, /让 AI 修改/)

    // 运行区：无可用会话时禁用运行按钮（不伪造目标）。
    const runButton = [...drawer.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '运行')
    assert.ok(runButton !== null, '抽屉应提供运行按钮')
    assert.equal(runButton!.disabled, true, '未选择目标会话前运行按钮必须禁用')

    // 删除两步确认：第一步仅出现确认文案，确认后调用 delete、刷新 list、清理 wf 参数。
    await act(async () => {
      buttonByText(drawer, '删除').click()
    })
    assert.match(drawer.textContent!, /确认删除工作流定义 release/)
    assert.equal(ctx.calls.filter((c) => c.action === 'delete').length, 0, '第一步不得直接删除')
    await act(async () => {
      buttonByText(drawer, '确认删除').click()
    })
    assert.deepEqual(ctx.calls.find((c) => c.action === 'delete')!.input, { name: 'release' })
    assert.ok(ctx.notices.some((n) => n.message.includes('已删除工作流定义 release')))
    assert.equal(ctx.calls.filter((c) => c.action === 'list').length >= 2, true, '删除后重新读取目录')
    assert.ok(props.setParamsCalls.some((p) => p['wf'] === undefined), '删除后清理 wf 深链参数')
    void host
  } finally {
    unmount()
  }
})

test('运行卡「保存为工作流」：内联 run 显示并调用 save fromRunId；已保存定义与 subagent 不显示', { timeout: 60_000 }, async () => {
  const inlineRun: WorkflowRunSummary = {
    id: 'wf_inline',
    name: '内联任务',
    conversationId: 1,
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    parentToolCallId: 'wf_call',
    nodes: [],
  }
  const savedRun: WorkflowRunSummary = { ...inlineRun, id: 'wf_saved', savedName: 'release' }
  const subagentRun: WorkflowRunSummary = { ...inlineRun, id: 'wf_bg', kind: 'subagent', status: 'running' }
  setWorkflowClientStub({
    docValue: { runs: [inlineRun, savedRun, subagentRun] },
    conversations: [],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const ctx = makeRecordingCtx({
    save: { created: true, workflow: { name: 'inline-task', updatedAt: 1, size: 10, description: 'd' } },
  })
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const conversation: ConversationSummary = {
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
  const { host, unmount } = await mountClient(ctx, e(Panel, { conversation }))
  try {
    const saveButtons = [...host.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes('保存为工作流'))
    assert.equal(saveButtons.length, 1, '只有内联 run 提供保存入口（已保存定义与 subagent 不显示）')
    await act(async () => {
      saveButtons[0]!.click()
    })
    assert.deepEqual(ctx.calls.find((c) => c.action === 'save')!.input, { fromRunId: 'wf_inline' })
    assert.ok(ctx.notices.some((n) => n.message.includes('已保存为工作流定义 inline-task')), '保存成功通知携带真实名称')
  } finally {
    unmount()
  }
})
