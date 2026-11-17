/**
 * builtin:workflow subagent / SubagentWorkflow 运行期关联与实时流模型测试：
 * - resolveSubagentConversationId（structuredOutput.execution > callId/parentToolCallId > numeric resume，绝不正则刮取 [subagent ...] 尾行）；
 * - resolveWorkflowRunForTool（parentToolCallId + structuredOutput.summary.id / runId 精确命中，绝不猜测最新）；
 * - resolveSubagentExecutionMeta（run 节点 worktree 优先于 structuredOutput，跨父会话不串卡）；
 * - isLatestSubagentCallForTarget（siblingCalls 读取 structuredOutput.execution）；
 * - buildSubagentStreamLines（剥离 structured_output_contract 样板并合并 ConversationLive）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationEntry, ConversationLive } from '@helm/protocol'
import type { WorkflowRunSummary } from '../src/contracts.js'
import {
  importWorkflowModels,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

mountSharedPluginNamespaces()
const m = await importWorkflowModels()

function convSummary(id: number, parentConversationId?: number, parentToolCallId?: string) {
  return {
    id,
    title: `会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
  }
}

function workflowRun(
  id: string,
  conversationId: number,
  status: 'running' | 'completed' | 'failed' | 'aborted',
  updatedAt = 1,
  parentToolCallId?: string,
): WorkflowRunSummary {
  return {
    id,
    name: `run ${id}`,
    conversationId,
    status,
    createdAt: 1,
    updatedAt,
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
  }
}

function entry(id: string, kind: string, extra: { data?: unknown; model?: unknown[] } = {}): ConversationEntry {
  return { id, kind, ...(extra.data !== undefined ? { data: extra.data } : {}), ...(extra.model !== undefined ? { model: extra.model } : {}) }
}

function assistantEntry(id: string, blocks: unknown[]): ConversationEntry {
  return entry(id, 'pi.assistant', { model: [{ role: 'assistant', content: blocks }] })
}

function toolResultEntry(
  id: string,
  callId: string,
  toolName: string,
  opts: { isError?: boolean; text?: string; durationMs?: number; details?: unknown } = {},
): ConversationEntry {
  return entry(id, 'pi.tool-result', {
    model: [
      {
        role: 'toolResult',
        toolCallId: callId,
        toolName,
        content: opts.text !== undefined ? [{ type: 'text', text: opts.text }] : [],
        isError: opts.isError === true,
        ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
        ...(opts.details !== undefined ? { details: opts.details } : {}),
      },
    ],
  })
}

function toolCallBlock(callId: string, name: string, input: Record<string, unknown>): unknown {
  return { type: 'toolCall', id: callId, name, arguments: input }
}

test('resolveSubagentConversationId：structuredOutput.execution 优先，其次 callId/parentToolCallId；绝不正则刮取 [subagent ...] 文本', { timeout: 60_000 }, () => {
  const conversations = [
    convSummary(10, 1),
    convSummary(11, 1, 'call-abc'),
    convSummary(12, 2, 'call-abc'), // 属其他父会话，不得误命中
  ]
  const running = {
    callId: 'call-abc',
    input: { prompt: '去修构建' },
  }
  assert.equal(m.resolveSubagentConversationId(running, 1, conversations), 11)

  // structuredOutput.execution.conversationId 优先（即使 result 为普通非 JSON 文本）
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-none',
        input: { prompt: '任务' },
        structuredOutput: { ok: true, result: 'conversationId=99', execution: { conversationId: 11, executionId: 'herdr:1' } },
        result: '纯文本摘要（非 JSON）',
      },
      1,
      conversations,
    ),
    11,
  )

  // 正文或旧式 [subagent ...] 文本均不做正则刮取（无 callId/structuredOutput/resume 时返回 undefined）
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-none',
        input: {},
        result: '任务完成\n[subagent conversationId=11]',
      },
      1,
      conversations,
    ),
    undefined,
    '不得通过正则刮取 [subagent ...] 尾行关联子会话',
  )

  // 非法正整数 conversationId 不采纳
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-none',
        input: {},
        structuredOutput: { ok: true, execution: { conversationId: 0 } },
      },
      1,
      conversations,
    ),
    undefined,
  )
})

test('resolveSubagentConversationId：顶层 JSON result 兑底与嵌套业务字段防伪造', { timeout: 60_000 }, () => {
  const conversations = [convSummary(668, 1, 'call-json')]
  // 顶层 JSON 信封（无 structuredOutput 时兑底）
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-none',
        input: {},
        result: '{"ok":true,"result":"正文提到 conversationId=999","execution":{"nodeId":"local","conversationId":668}}',
      },
      1,
      conversations,
    ),
    668,
  )
  // 业务 result 内嵌套 conversationId 不读取；无 callId 关联则返回 undefined
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-other',
        input: {},
        result: '{"ok":true,"result":{"note":"conversationId=888","inner":{"conversationId":888}}}',
      },
      1,
      conversations,
    ),
    undefined,
  )
  // 外部 executionId 后台句柄：无 conversationId 且无 callId 时不虚构子会话
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-none',
        input: {},
        structuredOutput: { ok: true, runId: 'wf_abc123', execution: { executionId: 'pane-9' } },
      },
      1,
      conversations,
    ),
    undefined,
  )
})

test('resolveSubagentConversationId：resume 数字与字符串 ref 匹配同父会话，跨父或非正整数拒绝', { timeout: 60_000 }, () => {
  const conversations = [convSummary(21, 1), convSummary(22, 2)]
  assert.equal(
    m.resolveSubagentConversationId({ callId: 'call-xyz', input: { prompt: '继续', resume: '21' } }, 1, conversations),
    21,
  )
  assert.equal(
    m.resolveSubagentConversationId({ callId: 'call-xyz', input: { prompt: '继续', resume: 21 } }, 1, conversations),
    21,
  )
  // 跨父会话 / 非正整数 / 非数字 ref：拒绝
  for (const bad of ['22', 'worker-1', 0, -21, 1.5, 99]) {
    assert.equal(
      m.resolveSubagentConversationId({ callId: 'call-none', input: { resume: bad } }, 1, conversations),
      undefined,
      `resume=${String(bad)} 不得误命中`,
    )
  }
})

test('isLatestSubagentCallForTarget：通过 siblingCalls[].structuredOutput 精确识别后续 resume（无 footer 刮取）', { timeout: 60_000 }, () => {
  const conversations = [convSummary(42, 1)]
  const siblingCalls = [
    {
      callId: 'call_1',
      toolName: 'subagent',
      input: { prompt: '首轮' },
      status: 'done' as const,
      result: '首轮完成文本（无 footer）',
      structuredOutput: { ok: true, result: '首轮完成', execution: { conversationId: 42 } },
    },
    {
      callId: 'call_2',
      toolName: 'subagent',
      input: { prompt: '续接', resume: 42 },
      status: 'done' as const,
      result: '二轮完成',
      structuredOutput: { ok: true, result: '二轮完成', execution: { conversationId: 42 } },
    },
  ]
  assert.equal(
    m.isLatestSubagentCallForTarget(
      {
        callId: 'call_1',
        input: siblingCalls[0]!.input,
        result: siblingCalls[0]!.result,
        structuredOutput: siblingCalls[0]!.structuredOutput,
        siblingCalls,
        conversationId: 1,
      },
      42,
      conversations,
    ),
    false,
    'call_1 已被后续 call_2 续接',
  )
  assert.equal(
    m.isLatestSubagentCallForTarget(
      {
        callId: 'call_2',
        input: siblingCalls[1]!.input,
        result: siblingCalls[1]!.result,
        structuredOutput: siblingCalls[1]!.structuredOutput,
        siblingCalls,
        conversationId: 1,
      },
      42,
      conversations,
    ),
    true,
  )

  // 外部 executionId 同样通过 siblingCalls[].structuredOutput.execution.executionId 判定最新调用
  const extSiblings = [
    {
      callId: 'ext_1',
      toolName: 'subagent',
      input: { prompt: '外部首轮' },
      status: 'done' as const,
      result: '无 footer 文本',
      structuredOutput: { ok: true, execution: { executionId: 'pane-42' } },
    },
    {
      callId: 'ext_2',
      toolName: 'subagent',
      input: { prompt: '外部续接', resume: 'pane-42' },
      status: 'running' as const,
    },
  ]
  assert.equal(
    m.isLatestSubagentCallForTarget(
      {
        callId: 'ext_1',
        input: extSiblings[0]!.input,
        result: extSiblings[0]!.result,
        structuredOutput: extSiblings[0]!.structuredOutput,
        siblingCalls: extSiblings,
        conversationId: 1,
      },
      undefined,
      [],
      'pane-42',
    ),
    false,
  )
})

test('resolveWorkflowRunForTool：按 parentToolCallId 精确命中，完成后从 structuredOutput / JSON 信封精确提取 id', { timeout: 60_000 }, () => {
  const dualRunning = [
    workflowRun('run-a', 1, 'running', 5, 'call-wf'),
    workflowRun('run-b', 1, 'running', 9, 'call-other'),
  ]
  assert.equal(m.resolveWorkflowRunForTool({ callId: 'call-wf' }, 1, dualRunning)?.id, 'run-a')
  assert.equal(m.resolveWorkflowRunForTool({ callId: 'call-other' }, 1, dualRunning)?.id, 'run-b')

  // 旧 completed + 新调用未创建 run：不猜旧 run
  assert.equal(
    m.resolveWorkflowRunForTool({ callId: 'call-wf' }, 1, [workflowRun('run-old', 1, 'completed', 1, 'call-past')]),
    undefined,
  )
  // 跨会话拒绝
  assert.equal(
    m.resolveWorkflowRunForTool({ callId: 'call-wf' }, 1, [workflowRun('run-x', 2, 'running', 9, 'call-wf')]),
    undefined,
  )

  // structuredOutput.summary.id 精确命中（即使 result 文本为空或非 JSON）
  const history = [
    workflowRun('run-legacy', 1, 'completed', 1),
    workflowRun('run-newer', 1, 'completed', 8),
    workflowRun('run-old', 1, 'completed', 1),
  ]
  assert.equal(
    m.resolveWorkflowRunForTool(
      { callId: 'call-missing', structuredOutput: { ok: true, summary: { id: 'run-legacy', status: 'completed' } } },
      1,
      history,
    )?.id,
    'run-legacy',
  )
  // JSON 字符串兜底
  assert.equal(
    m.resolveWorkflowRunForTool(
      { callId: 'call-missing', result: '{"id":"run-legacy","status":"completed","result":42}' },
      1,
      history,
    )?.id,
    'run-legacy',
  )
  // 前缀陷阱 / 非 JSON 正文提及 id：绝不正则刮取
  assert.equal(
    m.resolveWorkflowRunForTool(
      { callId: 'call-missing', result: '引用了历史 run-old 的输出 {"id":"run-old"}' },
      1,
      history,
    ),
    undefined,
  )
  // 错误但 callId 关联存在：仍命中真实失败 run
  assert.equal(
    m.resolveWorkflowRunForTool({ callId: 'call-wf', result: 'workflow_failed: 引擎内部错误' }, 1, dualRunning)?.id,
    'run-a',
  )
  // 无 callId + 无结构化 id：undefined
  assert.equal(m.resolveWorkflowRunForTool({ callId: undefined }, 1, dualRunning), undefined)
})

test('resolveSubagentExecutionMeta：parentToolCallId 与 structuredOutput 精确提取；run 节点 worktree 优先；零 footer 刮取', { timeout: 60_000 }, () => {
  const run = workflowRun('wf_link', 1, 'running', 3, 'call-bg')
  run.nodes = [{ id: 'n1', kind: 'agent', status: 'running', worktree: { path: '/wt/link', branch: 'helm/bg-link' } }]
  const meta = m.resolveSubagentExecutionMeta({ callId: 'call-bg' }, 1, [run])
  assert.equal(meta.run?.id, 'wf_link')
  assert.deepEqual(meta.worktree, { path: '/wt/link', branch: 'helm/bg-link' })
  assert.deepEqual(m.resolveSubagentExecutionMeta({ callId: 'call-bg' }, 2, [run]), {})

  // structuredOutput 携带完整 execution + runId（含空格路径）
  const runs = [workflowRun('wf_abc123', 1, 'running'), workflowRun('wf_other', 1, 'completed')]
  const structuredMeta = m.resolveSubagentExecutionMeta(
    {
      callId: 'call-x',
      structuredOutput: {
        ok: true,
        runId: 'wf_abc123',
        execution: {
          nodeId: 'node-a',
          executionId: 'pane-9',
          effectiveCwd: '/wt dir/sub',
          worktree: { path: '/wt dir/sub', branch: 'helm/bg-main' },
        },
      },
    },
    1,
    runs,
  )
  assert.equal(structuredMeta.run?.id, 'wf_abc123')
  assert.deepEqual(structuredMeta.worktree, { path: '/wt dir/sub', branch: 'helm/bg-main' })
  assert.equal(structuredMeta.executionId, 'pane-9')
  assert.equal(structuredMeta.nodeId, 'node-a')
  assert.equal(structuredMeta.effectiveCwd, '/wt dir/sub')

  // run 节点 worktree 优先于 structuredOutput
  const prefRun = workflowRun('wf_pref', 1, 'running', 3, 'call-p')
  prefRun.nodes = [{ id: 'n1', kind: 'agent', status: 'running', worktree: { path: '/wt/from-run', branch: 'helm/from-run' } }]
  const prefMeta = m.resolveSubagentExecutionMeta(
    {
      callId: 'call-p',
      structuredOutput: { ok: true, runId: 'wf_pref', execution: { worktree: { path: '/wt/from-json', branch: 'helm/from-json' } } },
    },
    1,
    [prefRun],
  )
  assert.deepEqual(prefMeta.worktree, { path: '/wt/from-run', branch: 'helm/from-run' })

  // 旧式 [subagent ...] 尾行或普通正文文本：绝不刮取
  assert.deepEqual(
    m.resolveSubagentExecutionMeta(
      {
        callId: 'call-none',
        result: '已转入后台\n[subagent background runId=wf_abc123 worktree=/srv/wt/helm-42@helm/wf-run-1]',
      },
      1,
      runs,
    ),
    {},
  )
})

test('buildSubagentStreamLines：剥离 structured_output_contract 样板并合并 ConversationLive', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    entry('1', 'helm.input', {
      data: {
        text: '帮我修复构建\n\n<structured_output_contract>\n调用 register_structured_output 工具\nSchema: {}\n</structured_output_contract>',
        origin: 'agent',
      },
    }),
    assistantEntry('2', [
      { type: 'thinking', thinking: '先看构建日志' },
      toolCallBlock('c1', 'bash', { command: 'pnpm build' }),
      { type: 'text', text: '构建已修复' },
    ]),
    toolResultEntry('3', 'c1', 'bash', { text: 'exit 0', durationMs: 1500 }),
  ]
  const lines = m.buildSubagentStreamLines(entries, undefined, false)
  assert.equal(lines.length, 4)
  assert.equal(lines[0]!.kind, 'prompt')
  assert.ok(lines[0]!.kind === 'prompt' && !lines[0]!.text.includes('structured_output_contract'))
  assert.ok(lines[0]!.kind === 'prompt' && lines[0]!.text.startsWith('帮我修复构建'))
  assert.equal(lines[1]!.kind, 'thinking')
  assert.equal(lines[2]!.kind, 'tool')
  assert.ok(lines[2]!.kind === 'tool' && lines[2]!.durationMs === 1500 && lines[2]!.resultPreview === 'exit 0')
  assert.equal(lines[3]!.kind, 'text')

  const live: ConversationLive = {
    conversationId: 11,
    text: '正在分析输出…',
    thinking: '流式思考中',
    tools: [{ callId: 'lc1', toolName: 'read', input: { file_path: '/a.ts' }, status: 'running' }],
    updatedAt: 1234,
  }
  const liveLines = m.buildSubagentStreamLines([entry('1', 'helm.input', { data: { text: '继续任务', origin: 'agent' } })], live, true)
  assert.deepEqual(liveLines.map((l) => l.kind), ['prompt', 'thinking', 'tool', 'text'])
})
