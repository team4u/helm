/**
 * builtin:workflow 插件 client 会话文档响应与后台活动注册测试（零 @helmx/web 依赖）：
 * - usePluginSessionDoc('runs') 快照与增量推送驱动 SubagentToolView / WorkflowToolView；
 * - useToolActivity (`activeToolCallIds`) 精确按真实 subagent summary 状态与
 *   run.running 状态登记 / 释放后台活动，不从静态文本推断；
 * - resume 续接仅最新调用上报活动，旧卡切换或卸载不误删新卡登记，
 *   旧 run.running 不污染最新调用或外部 executionId 续接。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helmx/protocol'
import type { WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  act,
  createWorkflowHostHarness,
  importWorkflowClientModule,
  makeConvSummary,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

const e = React.createElement

mountSharedPluginNamespaces({ realHooks: true })
const mod = await importWorkflowClientModule()
const SubagentToolView = mod['SubagentToolView'] as React.ComponentType<Record<string, unknown>>
const WorkflowToolView = mod['WorkflowToolView'] as React.ComponentType<Record<string, unknown>>

test('真实共享 hooks 消费 runs 会话文档增量：父工具已返回仍登记后台活动，终态释放；点击开抽屉', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1)
  const child = makeConvSummary(11, { parentConversationId: 1, parentToolCallId: 'call-bg' })
  const run: WorkflowRunSummary = {
    id: 'wf_bg',
    kind: 'subagent',
    name: '后台任务',
    conversationId: 1,
    parentToolCallId: 'call-bg',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    nodes: [{ id: 'agent', kind: 'agent', status: 'running', conversationId: 11 }],
  }
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, child],
    runsByConversation: { 1: [run] },
  })
  const view = e(SubagentToolView, {
    callId: 'call-bg',
    toolName: 'subagent',
    input: { prompt: '跑后台测试' },
    result: JSON.stringify({ execution: { conversationId: 11 } }),
    structuredOutput: { execution: { conversationId: 11 } },
    status: 'done',
    conversationId: 1,
    siblingCalls: [],
  })
  const ui = h.mountNode(view)
  try {
    assert.match(ui.container.textContent!, /Running in background/)
    assert.equal(h.log.activeToolCallIds.has('call-bg'), true, 'done 工具关联 running run 必须登记活跃工具')
    assert.deepEqual(h.log.loadDetailCalls, [], '时间线工具视图不得触发 loadConversationDetail')

    act(() => {
      ;(ui.container.querySelector('button.workflow-trace-row-btn') as HTMLElement).click()
    })
    assert.deepEqual(h.log.drawers, [11])
    assert.deepEqual(h.log.screens, [], '不得跳主屏或分屏')
    assert.deepEqual(h.log.workbenchOpens, [], '不得修改工作台开关状态')

    h.setConversations([parent, { ...child, status: 'blocked' }])
    assert.match(ui.container.textContent!, /Awaiting approval/)
    assert.equal(h.log.activeToolCallIds.has('call-bg'), true, 'blocked 子会话仍保持活跃登记')

    h.setConversations([parent, child])
    h.setRuns(1, [{ ...run, status: 'failed', error: 'Gate 命令退出码 1' }])
    ui.rerender(view)
    assert.ok(ui.container.querySelector('button.workflow-trace-row-btn.trace-row-error') !== null, '后台失败在时间线行显式标错')
    assert.match(ui.container.textContent!, /Error/)
    assert.doesNotMatch(ui.container.textContent!, /Running in background/)
    assert.equal(h.log.activeToolCallIds.has('call-bg'), false, '后台终态必须释放活跃登记')

    h.setRuns(1, [{ ...run, status: 'completed' }])
    ui.rerender(view)
    assert.ok(ui.container.querySelector('button.workflow-trace-row-btn.trace-row-error') === null)
    assert.match(ui.container.textContent!, /Done/)
    assert.equal(h.log.activeToolCallIds.has('call-bg'), false)
  } finally {
    ui.unmount()
  }
})

test('真实子会话 working/blocked 独立报告后台活动；静态工具结果不伪造活动', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1)
  const child = makeConvSummary(11, { parentConversationId: 1, parentToolCallId: 'child-call' })
  for (const status of ['working', 'blocked', 'idle', 'done', 'error'] as const) {
    const h = createWorkflowHostHarness({
      conversationId: 1,
      conversations: [parent, { ...child, status }],
      runsByConversation: { 1: [] },
    })
    const ui = h.mountNode(
      e(SubagentToolView, {
        callId: 'child-call',
        toolName: 'subagent',
        input: { prompt: '子任务' },
        result: '已提交',
        status: 'done',
        conversationId: 1,
        siblingCalls: [],
      }),
    )
    try {
      assert.equal(
        h.log.activeToolCallIds.has('child-call'),
        status === 'working' || status === 'blocked',
        `子会话 ${status} 应如实决定 activeToolCallIds 登记`,
      )
    } finally {
      ui.unmount()
    }
  }

  // 没有任何真实 run/child，即使输出字符串含 running，也不把静态文本推断成活动。
  const hStatic = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent],
    runsByConversation: { 1: [] },
  })
  const uiStatic = hStatic.mountNode(
    e(SubagentToolView, {
      callId: 'unknown',
      toolName: 'subagent',
      input: {},
      result: '{"status":"running"}',
      status: 'done',
      conversationId: 1,
      siblingCalls: [],
    }),
  )
  try {
    assert.equal(hStatic.log.activeToolCallIds.has('unknown'), false)
  } finally {
    uiStatic.unmount()
  }
})

test('WorkflowToolView 与无 nativechild 的外部 subagent 按真实 run.running 报告活动，终态与卸载释放', { timeout: 60_000 }, () => {
  const parent = makeConvSummary(1)
  for (const toolName of ['SubagentWorkflow', 'subagent'] as const) {
    const callId = `${toolName}-call`
    const Comp = toolName === 'SubagentWorkflow' ? WorkflowToolView : SubagentToolView
    const run: WorkflowRunSummary = {
      id: `run-${toolName}`,
      kind: toolName === 'subagent' ? 'subagent' : 'workflow',
      name: '真实后台运行',
      conversationId: 1,
      parentToolCallId: callId,
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{ id: 'external', kind: 'agent', status: 'running', executionId: 'pane-42' }],
    }
    const h = createWorkflowHostHarness({
      conversationId: 1,
      conversations: [parent],
      runsByConversation: { 1: [run] },
    })
    const ui = h.mountNode(
      e(Comp, {
        callId,
        toolName,
        input: {},
        result: '已提交',
        status: 'done',
        conversationId: 1,
        siblingCalls: [],
      }),
    )
    try {
      assert.equal(h.log.activeToolCallIds.has(callId), true, `${toolName} done 工具关联 running run 应登记活动`)
      for (const status of ['failed', 'aborted', 'completed'] as const) {
        h.setRuns(1, [{ ...run, status }])
        assert.equal(h.log.activeToolCallIds.has(callId), false, `${toolName} ${status} 必须释放活动`)
      }
      h.setRuns(1, [{ ...run, status: 'running' }])
      assert.equal(h.log.activeToolCallIds.has(callId), true)
    } finally {
      ui.unmount()
    }
    assert.equal(h.log.activeToolCallIds.has(callId), false, `${toolName} 卸载必须释放活动登记`)
  }
})

test('resume 仅最新调用报告活动；旧卡由活跃转历史或卸载不能清除新卡登记', { timeout: 60_000 }, () => {
  const parent = makeConvSummary(1)
  const child = makeConvSummary(11, { status: 'working', parentConversationId: 1, parentToolCallId: 'old-call' })
  const oldRun: WorkflowRunSummary = {
    id: 'old-run',
    kind: 'subagent',
    name: '首次运行',
    conversationId: 1,
    parentToolCallId: 'old-call',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    nodes: [{ id: 'agent', kind: 'agent', status: 'running', conversationId: 11 }],
  }
  const exec11 = { execution: { conversationId: 11 } }
  const oldCallSummary = {
    callId: 'old-call',
    toolName: 'subagent',
    status: 'done' as const,
    input: {},
    result: JSON.stringify(exec11),
    structuredOutput: exec11,
  }
  const newCallSummary = {
    callId: 'new-call',
    toolName: 'subagent',
    status: 'done' as const,
    input: { resume: 11, prompt: '继续任务' },
    result: JSON.stringify(exec11),
    structuredOutput: exec11,
  }

  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, child],
    runsByConversation: { 1: [oldRun] },
  })
  const ui = h.mountNode(
    e(SubagentToolView, {
      ...oldCallSummary,
      conversationId: 1,
      siblingCalls: [oldCallSummary],
    }),
  )
  try {
    assert.deepEqual([...h.log.activeToolCallIds], ['old-call'], '原调用初次挂载时上报活动')

    // 发生 resume：child 迁往 new-call，oldCall 与 newCall 同屏挂载，保留 oldRun.running 验证不被旧 run 污染。
    h.setConversations([parent, { ...child, status: 'working', parentToolCallId: 'new-call' }])
    const siblings = [oldCallSummary, newCallSummary]
    ui.rerender(
      e(
        React.Fragment,
        null,
        e(SubagentToolView, { ...oldCallSummary, conversationId: 1, siblingCalls: siblings }),
        e(SubagentToolView, { ...newCallSummary, conversationId: 1, siblingCalls: siblings }),
      ),
    )
    assert.deepEqual([...h.log.activeToolCallIds], ['new-call'], '续接后仅最新调用 busy')
    const rows = ui.container.querySelectorAll('button.workflow-trace-row-btn')
    assert.equal(rows.length, 2, '前序调用与最新调用各占一行紧凑轨迹')
    assert.match(rows[0]!.textContent ?? '', /Resumed below/)
    assert.doesNotMatch(rows[1]!.textContent ?? '', /Resumed below/)

    // 卸载旧卡不能误删最新调用的活动登记。
    ui.rerender(e(SubagentToolView, { ...newCallSummary, conversationId: 1, siblingCalls: siblings }))
    assert.deepEqual([...h.log.activeToolCallIds], ['new-call'], '移除旧卡不会误删最新调用的登记')

    h.setConversations([parent, { ...child, status: 'blocked', parentToolCallId: 'new-call' }])
    assert.deepEqual([...h.log.activeToolCallIds], ['new-call'])

    h.setConversations([parent, { ...child, status: 'idle', parentToolCallId: 'new-call' }])
    assert.deepEqual([...h.log.activeToolCallIds], [], '新调用终态即释放，旧 run.running 不得污染新调用')
  } finally {
    ui.unmount()
  }
})

test('外部 executionId 续接仅最新调用上报活动，不能编造 nativechild 关联', { timeout: 60_000 }, () => {
  const parent = makeConvSummary(1)
  const oldRun: WorkflowRunSummary = {
    id: 'external-old',
    kind: 'subagent',
    name: '外部任务',
    conversationId: 1,
    parentToolCallId: 'ext-old',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    nodes: [{ id: 'agent', kind: 'agent', status: 'running', executionId: 'pane-42' }],
  }
  const newRun: WorkflowRunSummary = {
    ...oldRun,
    id: 'external-new',
    parentToolCallId: 'ext-new',
    status: 'running',
  }
  const oldCall = {
    callId: 'ext-old',
    toolName: 'subagent',
    status: 'done' as const,
    input: {},
    result: JSON.stringify({ execution: { executionId: 'pane-42' } }),
    structuredOutput: { execution: { executionId: 'pane-42' } },
  }
  const newCall = {
    callId: 'ext-new',
    toolName: 'subagent',
    status: 'done' as const,
    input: { resume: 'pane-42' },
    result: '已提交',
  }
  const siblings = [oldCall, newCall]

  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent],
    runsByConversation: { 1: [oldRun, newRun] },
  })
  const ui = h.mountNode(
    e(
      React.Fragment,
      null,
      e(SubagentToolView, { ...oldCall, conversationId: 1, siblingCalls: siblings }),
      e(SubagentToolView, { ...newCall, conversationId: 1, siblingCalls: siblings }),
    ),
  )
  try {
    assert.deepEqual([...h.log.activeToolCallIds], ['ext-new'])
    assert.equal(ui.container.querySelectorAll('.subagent-card-clickable').length, 0)
    h.setRuns(1, [oldRun, { ...newRun, status: 'completed' }])
    assert.deepEqual([...h.log.activeToolCallIds], [], '旧外部 run.running 不能让已续接完成的旧调用重新 busy')
  } finally {
    ui.unmount()
  }
})
