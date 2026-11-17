/**
 * timeline-model 纯函数单测：helm.input 去重、toolCall+toolResult 配对、
 * 连续步骤折叠与豁免折叠、pi.reset / pi.compaction 分割线转换、live 合并。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationEntry, ConversationLive, ConversationSummary } from '@helm/protocol'
import { conversationsApi, ApiClientError } from '../src/lib/api.js'
import { buildAncestorChain, collectSubtreeIds, MAX_ANCESTRY_DEPTH } from '../src/conversation/ancestry-model.js'
import {
  archiveBatchNotice,
  patchConversationArchived,
  patchConversationsArchived,
} from '../src/shell/archive-ops.js'
import { ARCHIVED_TAG } from '../src/shell/sidebar-model.js'
import {
  buildTimelineItems,
  collectSiblingCalls,
  detectArtifactRef,
  filterRewoundEntries,
  findToolView,
  isFoldableStep,
  lastEditableHumanInput,
  lastHumanTextOf,
  matchTimelineRenderer,
  parseHelmInputData,
  toolSummaryText,
  type ToolTrace,
} from '../src/conversation/timeline-model.js'
import { formatBytes, formatDurationMs } from '../src/lib/format.js'

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

function collectToolTraces(items: ReturnType<typeof buildTimelineItems>): ToolTrace[] {
  const traces: ToolTrace[] = []
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const seg of item.segments) {
      if (seg.kind === 'tool') traces.push(seg.tool)
      else if (seg.kind === 'step-group') {
        for (const step of seg.steps) if (step.kind === 'tool') traces.push(step.tool)
      }
    }
  }
  return traces
}

// ---------------------------------------------------------------------------

test('helm.input 归一化：以 helm.input 为准，跳过紧随的重复 pi.user', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    entry('1', 'helm.input', {
      data: { id: 'sub-1', text: '帮我修复构建', origin: 'human', attachments: [{ id: 'a1', name: 'err.png', mimeType: 'image/png', size: 120 }] },
    }),
    entry('2', 'pi.user', { model: [{ role: 'user', content: '帮我修复构建' }] }),
    entry('3', 'pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'text', text: '好的' }] }] }),
  ])
  const humans = items.filter((i) => i.kind === 'human')
  assert.equal(humans.length, 1, '重复 pi.user 应被跳过')
  const human = humans[0]!
  assert.equal(human.entryId, '1')
  assert.equal(human.text, '帮我修复构建')
  assert.equal(human.origin, 'human')
  assert.deepEqual(human.attachments?.map((a) => a.name), ['err.png'])
  assert.equal(human.fallback, false)
})

test('裸 pi.user（无前置 helm.input）兜底展示；agent/trigger origin 标记保留', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    entry('1', 'pi.user', { model: [{ role: 'user', content: '历史遗留输入' }] }),
    entry('2', 'helm.input', { data: { text: '来自 Worker 的汇报', origin: 'agent', meta: { renderer: 'noop' } } }),
  ])
  const humans = items.filter((i) => i.kind === 'human')
  assert.equal(humans.length, 2)
  assert.equal(humans[0]!.fallback, true)
  assert.equal(humans[0]!.text, '历史遗留输入')
  assert.equal(humans[1]!.origin, 'agent')
  assert.deepEqual(humans[1]!.meta, { renderer: 'noop' })
})

test('parseHelmInputData：非法形状返回 undefined，不伪造', { timeout: 60_000 }, () => {
  assert.equal(parseHelmInputData(undefined), undefined)
  assert.equal(parseHelmInputData('text'), undefined)
  assert.equal(parseHelmInputData({ text: 42 }), undefined)
  const ok = parseHelmInputData({ text: 'x', origin: 'trigger', attachments: [null, { id: 'b', name: 'n', mimeType: 'a/b', size: 1 }] })
  assert.ok(ok !== undefined)
  assert.equal(ok!.origin, 'trigger')
  assert.equal(ok!.attachments!.length, 1)
})

test('toolCall + toolResult 按 callId 配对：状态、isError、耗时、startedAt 与结果文本合并', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    {
      id: '1',
      kind: 'pi.assistant',
      createdAt: 1_700_000_000_500,
      model: [{ role: 'assistant', content: [
        { type: 'text', text: '先看文件' },
        toolCallBlock('c1', 'read', { file_path: '/a/b.ts' }),
        toolCallBlock('c2', 'bash', { command: 'pnpm test' }),
      ] }],
    },
    toolResultEntry('2', 'c1', 'read', { text: '文件内容', durationMs: 120 }),
    toolResultEntry('3', 'c2', 'bash', { isError: true, text: '退出码 1' }),
  ])
  const traces = collectToolTraces(items)
  assert.equal(traces.length, 2)
  assert.equal(traces[0]!.toolName, 'read')
  assert.equal(traces[0]!.status, 'done')
  assert.equal(traces[0]!.isError, false)
  assert.equal(traces[0]!.resultText, '文件内容')
  assert.equal(traces[0]!.durationMs, 120)
  assert.equal(traces[0]!.startedAt, 1_700_000_000_500, 'assistant.timestamp 应传播为 tool.startedAt')
  assert.equal(traces[0]!.structuredOutput, undefined, '无 details 时不得伪造结构化结果')
  assert.equal(traces[1]!.toolName, 'bash')
  assert.equal(traces[1]!.status, 'error')
  assert.equal(traces[1]!.isError, true)
  // 文本段保留
  const turn = items.find((i) => i.kind === 'assistant')!
  assert.ok(turn.kind === 'assistant')
  assert.ok(turn.segments.some((s) => s.kind === 'text' && s.text === '先看文件'))
})

test('toolResult 消息的 details 映射为结构化结果；非对象值不采纳', { timeout: 60_000 }, () => {
  const editMeta = {
    path: '/abs/a.ts',
    nodeId: 'local',
    replaced: true,
    diff: {
      rows: [{ kind: 'add' as const, newLine: 2, text: 'x' }],
      addedLines: 1,
      removedLines: 0,
      firstChangedLine: 2,
      truncated: false,
    },
  }
  const items = buildTimelineItems([
    assistantEntry('1', [toolCallBlock('c1', 'edit', { path: 'a.ts' })]),
    assistantEntry('2', [toolCallBlock('c2', 'bash', { command: 'ls' })]),
    assistantEntry('3', [toolCallBlock('c3', 'bash', { command: 'pwd' })]),
    toolResultEntry('4', 'c1', 'edit', { text: 'edit_ok', details: editMeta }),
    toolResultEntry('5', 'c2', 'bash', { text: 'ok', details: 'not-an-object' }),
    toolResultEntry('6', 'c3', 'bash', { text: 'ok', details: [{ array: true }] }),
  ])
  const traces = collectToolTraces(items)
  assert.equal(traces.length, 3)
  assert.deepEqual(traces[0]!.structuredOutput, editMeta, 'details 对象进入 ToolTrace.structuredOutput')
  assert.equal(traces[1]!.structuredOutput, undefined, '字符串 details 不采纳')
  assert.equal(traces[2]!.structuredOutput, undefined, '数组 details 不采纳')
})

test('未配对的孤儿 toolResult 生成独立工具行', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([toolResultEntry('1', 'orphan', 'bash', { text: '孤儿结果' })])
  const traces = collectToolTraces(items)
  assert.equal(traces.length, 1)
  assert.equal(traces[0]!.callId, 'orphan')
  assert.equal(traces[0]!.resultText, '孤儿结果')
})

test('连续常规步骤收拢为 step-group；出错工具保留在组内，tool.view / subagent 豁免折叠', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    assistantEntry('1', [
      { type: 'thinking', thinking: '先想一下' },
      toolCallBlock('c1', 'read', { file_path: '/a' }),
      toolCallBlock('c2', 'bash', { command: 'ls' }),
      toolCallBlock('c3', 'bash', { command: 'boom' }),
      { type: 'text', text: '结论' },
    ]),
    toolResultEntry('2', 'c1', 'read', { text: 'ok' }),
    toolResultEntry('3', 'c2', 'bash', { text: 'ok' }),
    toolResultEntry('4', 'c3', 'bash', { isError: true, text: '失败' }),
  ])
  const turn = items.find((i) => i.kind === 'assistant')!
  assert.ok(turn.kind === 'assistant')
  // thinking + 成功 read/bash + 失败 boom bash 均收拢为一个 step-group，不把错误步骤打散出组
  const groups = turn.segments.filter((s) => s.kind === 'step-group') as Array<{ kind: 'step-group'; stepCount: number; steps: Array<{ kind: string; tool?: ToolTrace }> }>
  assert.equal(groups.length, 1, '只有一个可折叠组')
  assert.equal(groups[0]!.stepCount, 4)
  assert.deepEqual(groups[0]!.steps.map((s) => s.kind), ['thinking', 'tool', 'tool', 'tool'])
  assert.equal(groups[0]!.steps[3]!.tool?.callId, 'c3')
  assert.equal(groups[0]!.steps[3]!.tool?.isError, true)
  // 失败工具不独立露出为顶级段
  const exposed = turn.segments.filter((s) => s.kind === 'tool')
  assert.equal(exposed.length, 0)
  // 文本结论保留
  assert.ok(turn.segments.some((s) => s.kind === 'text' && s.text === '结论'))
})

test('isFoldableStep：仅 tool.view 命中豁免折叠（subagent/SubagentWorkflow 由 builtin:workflow 注册 tool.view 接管）', { timeout: 60_000 }, () => {
  const toolViews = [
    { pluginId: 'builtin:superagent', spec: { id: 'v', toolNames: ['dispatch_worker'] } },
    { pluginId: 'builtin:workflow', spec: { id: 'subagent', toolNames: ['subagent', 'SubagentWorkflow'] } },
  ]
  const items = buildTimelineItems(
    [
      assistantEntry('1', [
        toolCallBlock('c1', 'dispatch_worker', { prompt: '去干活' }),
        toolCallBlock('c2', 'subagent', { prompt: '子代理' }),
        toolCallBlock('c3', 'SubagentWorkflow', { script: 'wf' }),
        toolCallBlock('c4', 'read', { file_path: '/x' }),
      ]),
      toolResultEntry('2', 'c1', 'dispatch_worker', { text: '{"workerConversationId":9}' }),
      toolResultEntry('3', 'c2', 'subagent', { text: 'ok' }),
      toolResultEntry('4', 'c3', 'SubagentWorkflow', { text: 'ok' }),
      toolResultEntry('5', 'c4', 'read', { text: 'ok' }),
    ],
    { toolViews },
  )
  const traces = collectToolTraces(items)
  assert.equal(traces.length, 4)
  assert.equal(traces[0]!.toolView?.pluginId, 'builtin:superagent')
  assert.equal(traces[1]!.toolView?.pluginId, 'builtin:workflow')
  assert.equal(isFoldableStep({ kind: 'tool', tool: traces[0]! }), false)
  assert.equal(isFoldableStep({ kind: 'tool', tool: traces[1]! }), false)
  assert.equal(isFoldableStep({ kind: 'tool', tool: traces[2]! }), false)
  assert.equal(isFoldableStep({ kind: 'tool', tool: traces[3]! }), true)
  // 未注册 tool.view 的 subagent 工具（如插件停用）与普通工具一样可折叠：零工具名硬编码。
  const plain = buildTimelineItems(
    [assistantEntry('1', [toolCallBlock('cx', 'subagent', { prompt: 'p' })])],
    {},
  )
  const plainTraces = collectToolTraces(plain)
  assert.equal(plainTraces[0]!.toolView, undefined)
  assert.equal(isFoldableStep({ kind: 'tool', tool: plainTraces[0]! }), true)
  // 命中 tool.view 与业务工具的行独立露出；唯一的普通工具 c4 从第一步起进入分组。
  const turn = items.find((i) => i.kind === 'assistant')!
  assert.ok(turn.kind === 'assistant')
  const exposed = turn.segments.filter((s) => s.kind === 'tool') as Array<{ kind: 'tool'; tool: ToolTrace }>
  assert.equal(exposed.length, 3)
  assert.deepEqual(exposed.map((e) => e.tool.callId), ['c1', 'c2', 'c3'])
  const group = turn.segments.find((s) => s.kind === 'step-group')
  assert.ok(group?.kind === 'step-group')
  assert.deepEqual(group.steps.map((step) => step.kind === 'tool' ? step.tool.callId : undefined), ['c4'])
})

test('findToolView / matchTimelineRenderer 匹配判定', { timeout: 60_000 }, () => {
  const views = [{ pluginId: 'p1', spec: { id: 'tv', toolNames: ['dispatch_worker'] } }]
  assert.equal(findToolView('dispatch_worker', views)?.pluginId, 'p1')
  assert.equal(findToolView('read', views), undefined)

  const renderers = [
    { pluginId: 'p2', spec: { id: 'r', matchMeta: { renderer: 'superagent:worker-report' } } },
  ]
  assert.equal(matchTimelineRenderer(entry('1', 'helm.input', { data: { meta: { renderer: 'superagent:worker-report' } } }), renderers)?.pluginId, 'p2')
  assert.equal(matchTimelineRenderer(entry('2', 'helm.input', { data: { renderer: 'superagent:worker-report' } }), renderers)?.pluginId, 'p2')
  assert.equal(matchTimelineRenderer(entry('3', 'helm.input', { data: { text: '普通' } }), renderers), undefined)
  // kinds AND matchMeta
  const kindRenderers = [{ pluginId: 'p3', spec: { id: 'k', kinds: ['helm.input'], matchMeta: { renderer: 'x' } } }]
  assert.equal(matchTimelineRenderer(entry('4', 'helm.input', { data: { meta: { renderer: 'x' } } }), kindRenderers)?.pluginId, 'p3')
  assert.equal(matchTimelineRenderer(entry('5', 'pi.user', { data: { meta: { renderer: 'x' } } }), kindRenderers), undefined)
})

test('timeline.renderer 命中的 entry 渲染为插件卡片（豁免折叠）', { timeout: 60_000 }, () => {
  const renderers = [{ pluginId: 'p2', spec: { id: 'r', matchMeta: { renderer: 'superagent:worker-report' } } }]
  const items = buildTimelineItems(
    [entry('1', 'helm.input', { data: { text: 'Worker 12 已完成', origin: 'agent', meta: { renderer: 'superagent:worker-report', workerId: 12 } } })],
    { timelineRenderers: renderers },
  )
  assert.equal(items.length, 1)
  assert.equal(items[0]!.kind, 'plugin-card')
  if (items[0]!.kind === 'plugin-card') {
    assert.equal(items[0]!.renderer.pluginId, 'p2')
    assert.equal(items[0]!.entryId, '1')
  }
})

test('pi.reset / pi.compaction 转换为分割线；reset 携带 handoff', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    entry('1', 'pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'text', text: '旧上下文' }] }] }),
    entry('2', 'pi.reset', { data: { handoff: 'Handoff summary文本' } }),
    entry('3', 'pi.compaction', { model: [{ role: 'user', content: 'Compaction summary' }] }),
  ])
  const dividers = items.filter((i) => i.kind === 'divider')
  assert.equal(dividers.length, 2)
  assert.equal(dividers[0]!.divider, 'reset')
  assert.equal(dividers[0]!.handoff, 'Handoff summary文本')
  assert.equal(dividers[1]!.divider, 'compaction')
  assert.equal(dividers[1]!.summary, 'Compaction summary')
  // reset 前的 assistant 回合正常结算
  assert.equal(items[0]!.kind, 'assistant')
})

test('live 合并：running 工具追加、流式文本并入进行中回合', { timeout: 60_000 }, () => {
  const live: ConversationLive = {
    conversationId: 1,
    text: '正在分析',
    tools: [
      { callId: 'c1', toolName: 'bash', input: { command: 'pnpm build' }, status: 'running' },
      { callId: 'c0', toolName: 'read', status: 'done' },
    ],
    updatedAt: 123,
  }
  const items = buildTimelineItems(
    [
      assistantEntry('1', [
        toolCallBlock('c0', 'read', { file_path: '/a' }),
        { type: 'text', text: '第一段' },
      ]),
      toolResultEntry('2', 'c0', 'read', { text: 'ok' }),
    ],
    { live },
  )
  const turn = items.find((i) => i.kind === 'assistant')
  assert.ok(turn !== undefined && turn.kind === 'assistant')
  assert.equal(turn.live, true)
  const traces = collectToolTraces(items)
  assert.equal(traces.length, 2)
  assert.equal(traces[0]!.status, 'done')
  assert.equal(traces[1]!.status, 'running')
  assert.equal(traces[1]!.toolName, 'bash')
  assert.ok(turn.segments.some((s) => s.kind === 'text' && s.text.includes('正在分析')))
})

test('工具摘要与产物引用检测', { timeout: 60_000 }, () => {
  assert.equal(toolSummaryText('bash', { command: 'pnpm test --filter @helm/web' }), 'pnpm test --filter @helm/web')
  const long = 'x'.repeat(80)
  assert.ok(toolSummaryText('bash', { command: long }).endsWith('…'))
  assert.equal(toolSummaryText('bash', { command: 'a\nb' }), 'a')
  assert.equal(toolSummaryText('read', { file_path: '/root/code/helm/x.ts' }), '/root/code/helm/x.ts')

  assert.equal(detectArtifactRef('[Artifact] id=2f8c1a4b-1111 path=artifacts/1/x.txt（调用工具 read_artifact 获取全文）'), '2f8c1a4b-1111')
  assert.equal(detectArtifactRef('输出含 art_abc123 引用'), 'art_abc123')
  assert.equal(detectArtifactRef('普通输出'), undefined)
  assert.equal(detectArtifactRef(undefined), undefined)
})

test('多回合连续文本合并与空 thinking 跳过', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    assistantEntry('1', [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '第一' },
    ]),
    assistantEntry('2', [
      { type: 'text', text: '第二' },
      { type: 'thinking', thinking: '继续' },
    ]),
  ])
  // 空回合文本拼接为一个回合（连续 assistant entry 归并同一 TurnAcc）
  const turns = items.filter((i) => i.kind === 'assistant')
  assert.equal(turns.length, 1)
  const turn = turns[0]!
  assert.ok(turn.kind === 'assistant')
  const texts = turn.segments.filter((s) => s.kind === 'text') as Array<{ kind: 'text'; text: string }>
  assert.equal(texts.length, 1)
  assert.equal(texts[0]!.text, '第一第二')
})

test('工具轨迹保持执行时序，不能被折叠缓冲移到最终回复之后', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    assistantEntry('1', [toolCallBlock('call-1', 'bash', { command: 'pwd' })]),
    toolResultEntry('2', 'call-1', 'bash', { text: '/tmp' }),
    assistantEntry('3', [{ type: 'text', text: '完成' }]),
  ])
  const turn = items[0]
  assert.ok(turn?.kind === 'assistant')
  assert.deepEqual(turn.segments.map((segment) => segment.kind), ['step-group', 'text'])
  const group = turn.segments[0]
  assert.ok(group?.kind === 'step-group')
  const step = group.steps[0]
  assert.ok(step?.kind === 'tool')
  assert.equal(step.tool.callId, 'call-1')
})

test('流式文本已落库而 live 尚未清理时，不重复显示同一段回复', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([assistantEntry('1', [{ type: 'text', text: '这是一条完整回复' }])], {
    live: { conversationId: 1, text: '这是一条完整回复', tools: [], updatedAt: 5 },
  })
  const turn = items[0]
  assert.ok(turn?.kind === 'assistant')
  assert.deepEqual(turn.segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text), ['这是一条完整回复'])
})

test('step-group 在产出正文前保持 active=true 默认展开，产出正文或回合结束后自动收起', { timeout: 60_000 }, () => {
  // 1) 流式思考阶段（尚未产出 text）：step-group active 为 true
  const thinkingItems = buildTimelineItems([], {
    live: { conversationId: 1, text: '', thinking: '正在推理目录结构…', tools: [], updatedAt: 1 },
  })
  const thinkingTurn = thinkingItems[0]
  assert.ok(thinkingTurn?.kind === 'assistant')
  assert.equal(thinkingTurn.live, true)
  const activeGroup = thinkingTurn.segments[0]
  assert.ok(activeGroup?.kind === 'step-group')
  assert.equal(activeGroup.active, true)
  assert.equal(activeGroup.steps.length, 1)

  // 2) 思考 + 工具完成，但下一轮仍在 working 且无 text 输出：active 保持 true
  const midRoundItems = buildTimelineItems(
    [
      assistantEntry('1', [
        { type: 'thinking', thinking: '先列出目录' },
        toolCallBlock('c1', 'bash', { command: 'ls -la' }),
      ]),
      toolResultEntry('2', 'c1', 'bash', { text: 'total 0' }),
    ],
    { working: true },
  )
  const midTurn = midRoundItems[0]
  assert.ok(midTurn?.kind === 'assistant')
  const midGroup = midTurn.segments[0]
  assert.ok(midGroup?.kind === 'step-group')
  assert.equal(midGroup.active, true)

  // 3) 一旦开始流式输出正文 text，前置 step-group 自动变为 active=false（折叠）
  const streamingTextItems = buildTimelineItems(
    [
      assistantEntry('1', [
        { type: 'thinking', thinking: '先列出目录' },
        toolCallBlock('c1', 'bash', { command: 'ls -la' }),
      ]),
      toolResultEntry('2', 'c1', 'bash', { text: 'total 0' }),
    ],
    { live: { conversationId: 1, text: '当前目录如下：', tools: [], updatedAt: 2 }, working: true },
  )
  const streamingTurn = streamingTextItems[0]
  assert.ok(streamingTurn?.kind === 'assistant')
  const collapsedGroup = streamingTurn.segments[0]
  assert.ok(collapsedGroup?.kind === 'step-group')
  assert.equal(collapsedGroup.active, false)

  // 4) 回合结算后（working=false 且无 live），即使无 text 段也自动收起 active=false
  const settledItems = buildTimelineItems([
    assistantEntry('1', [{ type: 'thinking', thinking: '仅思考' }]),
  ])
  const settledTurn = settledItems[0]
  assert.ok(settledTurn?.kind === 'assistant')
  const settledGroup = settledTurn.segments[0]
  assert.ok(settledGroup?.kind === 'step-group')
  assert.equal(settledGroup.active, false)
})

test('多轮工具执行期间 turn.key 恒定不变，且 running 工具保留在同一 step-group 内不跳出', { timeout: 60_000 }, () => {
  const userMsg = entry('10', 'helm.input', { data: { text: '检查目录与配置', origin: 'human' } })

  // 阶段 1：流式思考 + 第一个工具 running
  const s1 = buildTimelineItems([userMsg], {
    live: {
      conversationId: 1,
      text: '',
      thinking: '先看目录',
      tools: [{ callId: 'c1', toolName: 'bash', input: { command: 'ls' }, status: 'running' }],
      updatedAt: 1,
    },
    working: true,
  })
  const t1 = s1.find((i) => i.kind === 'assistant')!
  assert.ok(t1?.kind === 'assistant')
  assert.equal(t1.segments.length, 1, 'thinking 与 running bash 应同属一个 step-group，不拆出组外')
  assert.equal(t1.segments[0]!.kind, 'step-group')

  // 阶段 2：第一轮 assistant + tool-result 落库，第二轮思考 + 第二个工具 running
  const s2 = buildTimelineItems(
    [
      userMsg,
      assistantEntry('11', [
        { type: 'thinking', thinking: '先看目录' },
        toolCallBlock('c1', 'bash', { command: 'ls' }),
      ]),
      toolResultEntry('12', 'c1', 'bash', { text: 'package.json' }),
      assistantEntry('13', [
        { type: 'thinking', thinking: '再读配置' },
        toolCallBlock('c2', 'read', { path: 'package.json' }),
      ]),
    ],
    { working: true },
  )
  const t2 = s2.find((i) => i.kind === 'assistant')!
  assert.ok(t2?.kind === 'assistant')
  assert.equal(t2.key, t1.key, '新 entry 落库不得改变当前回合的 React key（防整棵卸载回跳）')
  assert.equal(t2.segments.length, 1, '多轮思考与执行中工具应保持在同一个展开的 step-group 内')
  const g2 = t2.segments[0]!
  assert.ok(g2.kind === 'step-group')
  assert.equal(g2.active, true)
  assert.equal(g2.steps.length, 4)
})

test('单条工具从执行到完成再追加第二条时，保留同一分组与工具标识', { timeout: 60_000 }, () => {
  const userMsg = entry('1', 'helm.input', { data: { text: '检查目录', origin: 'human' } })
  const call = assistantEntry('2', [toolCallBlock('c1', 'bash', { command: 'ls' })])
  const first = buildTimelineItems([userMsg, call], { working: true })
  const completed = buildTimelineItems([userMsg, call, toolResultEntry('3', 'c1', 'bash', { text: 'package.json' })], { working: true })
  const next = buildTimelineItems([userMsg, call, toolResultEntry('3', 'c1', 'bash', { text: 'package.json' }), assistantEntry('4', [toolCallBlock('c2', 'read', { path: 'package.json' })])], { working: true })

  const groups = [first, completed, next].map((items) => {
    const turn = items.find((item) => item.kind === 'assistant')
    assert.ok(turn?.kind === 'assistant')
    const group = turn.segments[0]
    assert.ok(group?.kind === 'step-group', '第一条工具也应留在分组中，避免第二条加入时重新挂载')
    assert.equal(group.active, true, '工具完成时仍在等待下一轮，应保持展开')
    return group
  })
  assert.equal(groups[0]!.key, groups[1]!.key)
  assert.equal(groups[0]!.key, groups[2]!.key)
  assert.equal(groups[2]!.steps.length, 2)
  const tools = groups.map((group) => {
    const step = group.steps[0]
    assert.ok(step?.kind === 'tool')
    return step.tool
  })
  assert.equal(tools[0]!.key, tools[1]!.key)
  assert.equal(tools[0]!.key, tools[2]!.key)
  assert.deepEqual(tools.map((tool) => tool.status), ['running', 'done', 'done'])
})

test('流式正文更新、落库和结束回合时保留同一正文标识', { timeout: 60_000 }, () => {
  const userMsg = entry('1', 'helm.input', { data: { text: '给我结果', origin: 'human' } })
  const streamed = (text: string, updatedAt: number) => buildTimelineItems([userMsg], {
    working: true,
    live: { conversationId: 1, text, tools: [], updatedAt },
  })
  const committed = [userMsg, assistantEntry('2', [{ type: 'text', text: '检查完成' }])]
  const frames = [streamed('检查', 1), streamed('检查完成', 2), buildTimelineItems(committed, { working: true }), buildTimelineItems(committed)]
  const turns = frames.map((items) => {
    const turn = items.find((item) => item.kind === 'assistant')
    assert.ok(turn?.kind === 'assistant')
    return turn
  })
  assert.equal(new Set(turns.map((turn) => turn.key)).size, 1)
  assert.equal(new Set(turns.map((turn) => turn.segments[0]!.key)).size, 1)
  assert.deepEqual(turns.map((turn) => {
    const text = turn.segments[0]
    assert.ok(text?.kind === 'text')
    return text.text
  }), ['检查', '检查完成', '检查完成', '检查完成'])
})

test('lastHumanTextOf 与格式化工具', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    entry('1', 'helm.input', { data: { text: '第一条', origin: 'human' } }),
    entry('2', 'helm.input', { data: { text: '第二条', origin: 'human' } }),
  ])
  assert.equal(lastHumanTextOf(items), '第二条')
  assert.equal(lastHumanTextOf([]), undefined)

  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KiB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MiB')
  assert.equal(formatDurationMs(50), '50ms')
  assert.equal(formatDurationMs(1500), '1.5s')
  assert.equal(formatDurationMs(125_000), '2m5s')
  assert.equal(formatDurationMs(undefined), '')
  // 进位边界：拆分前先按总秒数四舍五入，绝不产生 60.0s / 1m60s / 59m60s
  assert.equal(formatDurationMs(59_600), '59.6s', '59.6s 未及 60s 保持一位小数秒档')
  assert.equal(formatDurationMs(59_949), '59.9s')
  assert.equal(formatDurationMs(59_950), '1m0s', '59.95s 舍入触达 60s 必须进分档')
  assert.equal(formatDurationMs(60_000), '1m0s')
  assert.equal(formatDurationMs(119_600), '2m0s', '1m59.6s 不得渲染成 1m60s')
  assert.equal(formatDurationMs(3_599_600), '1h0m', '59m59.6s 不得渲染成 59m60s')
  assert.equal(formatDurationMs(3_600_000), '1h0m')
  assert.equal(formatDurationMs(7_323_000), '2h2m', '>=1h 人类可读档位（分钟粒度）')
  assert.equal(formatDurationMs(36_000_000), '10h0m')
  assert.equal(formatDurationMs(-1), '')
  assert.equal(formatDurationMs(Number.NaN), '')
})

// ---------------------------------------------------------------------------
// fork 请求体：entryId 必须转换为正整数（契约 ConversationForkRequest）
// ---------------------------------------------------------------------------

interface CapturedRequest {
  path: string
  body: unknown
}

/** 拦截全局 fetch，捕获 conversationsApi.fork 发出的请求体（测试结束后自动还原）。 */
function stubFetchOnce(t: { after: (fn: () => void) => void }, reply: () => object): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      path: String(input),
      body: init?.body !== undefined ? (JSON.parse(String(init.body)) as unknown) : undefined,
    })
    return new Response(JSON.stringify(reply()), { status: 201, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  return captured
}

test('fork 将字符串 entryId 转换为正整数请求体，不再发送数字字符串', { timeout: 60_000 }, async (t) => {
  const forked = { id: 42, title: '分叉', profileId: 'assistant', tags: [], cwd: '/tmp', model: 'zhipu/glm-4.6', status: 'idle', stateChangeSeq: 1, completionSeq: 1, unread: false, pinned: false, pendingAskCount: 0, createdAt: 1, updatedAt: 1 }
  const captured = stubFetchOnce(t, () => forked)

  // ConversationEntry.id 是数字字符串（如 '3'），旧实现直接透传导致后端 400
  await conversationsApi.fork(7, '3')
  assert.equal(captured.length, 1)
  assert.equal(captured[0]!.path, '/api/conversations/7/fork')
  assert.deepEqual(captured[0]!.body, { entryId: 3 })
  assert.equal(typeof (captured[0]!.body as { entryId: number }).entryId, 'number')

  // number 入参同样合法；title 仅在非空时携带
  await conversationsApi.fork(7, 5, '自定义标题')
  assert.deepEqual(captured[1]!.body, { entryId: 5, title: '自定义标题' })
  await conversationsApi.fork(7, 5, '  ')
  assert.deepEqual(captured[2]!.body, { entryId: 5 })
})

test('fork 对非法 entryId 显式抛错，不发出请求', { timeout: 60_000 }, async (t) => {
  const captured = stubFetchOnce(t, () => ({ ok: true }))
  for (const bad of ['abc', '0', '-3', '', Number.NaN, '3oops', '1.5', '1e2', ' 3', '3 ', String(Number.MAX_SAFE_INTEGER + 1), Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(async () => conversationsApi.fork(7, bad as string), (err: unknown) => {
      assert.ok(err instanceof ApiClientError)
      assert.equal(err.code, 'validation_error')
      assert.equal(err.status, 400)
      return true
    })
  }
  assert.equal(captured.length, 0, '非法 entryId 不得发出任何请求')
})

// ---------------------------------------------------------------------------
// rewind 覆盖过滤与历史编辑
// ---------------------------------------------------------------------------

test('filterRewoundEntries：闭区间 [from, through] 内条目被移除，同批先落的新 input（through < id < marker）保留', { timeout: 60_000 }, () => {
  // 后端原子提交：先落新 input(5)，再追加 rewind marker(6)，同一批保存。
  // marker 声明 [fromEntryId=2, throughEntryId=4]（提交新 input 前的旧 tail）；
  // 新 input id=5 大于 through 但小于 marker id，绝不能被误隐藏。
  const entries: ConversationEntry[] = [
    entry('1', 'helm.input', { data: { text: '最早的问题', origin: 'human' } }),
    entry('2', 'helm.input', { data: { text: '被覆盖的问题', origin: 'human' } }),
    entry('3', 'pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'text', text: '被覆盖的回答' }] }] }),
    toolResultEntry('4', 'c1', 'bash', { text: '被覆盖的工具结果' }),
    entry('5', 'helm.input', { data: { text: '改写后的新问题', origin: 'human' } }),
    entry('6', 'helm.rewind', { data: { fromEntryId: 2, throughEntryId: 4, omittedEntryIds: [2, 3, 4], omittedInputIds: ['in-2'], createdAt: 123 } }),
    entry('7', 'pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'text', text: '新回答' }] }] }),
  ]
  const active = filterRewoundEntries(entries)
  assert.deepEqual(active.map((e) => e.id), ['1', '5', '7'])
})

test('filterRewoundEntries：无效区间不误伤，多次连续 rewind 叠加生效', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    entry('1', 'helm.input', { data: { text: 'A', origin: 'human' } }),
    entry('2', 'helm.input', { data: { text: 'B', origin: 'human' } }),
    entry('3', 'pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'text', text: '答B' }] }] }),
    entry('4', 'helm.rewind', { data: { fromEntryId: 2, throughEntryId: 3, omittedEntryIds: [2, 3], omittedInputIds: [], createdAt: 1 } }),
    entry('5', 'helm.input', { data: { text: 'C', origin: 'human' } }),
    entry('6', 'pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'text', text: '答C' }] }] }),
    // 非法形状：from/through 缺失 / 超前 through → rewind 自身移除但不覆盖任何条目
    entry('7', 'helm.rewind', {}),
    entry('8', 'helm.rewind', { data: { fromEntryId: 2, throughEntryId: 99 } }),
    // 第二次 rewind：闭区间 [5, 8]，第二次改写后的问题与第一次 rewind 全部消失
    entry('9', 'helm.rewind', { data: { fromEntryId: 5, throughEntryId: 8, omittedEntryIds: [5, 6, 7, 8], omittedInputIds: [], createdAt: 2 } }),
    entry('10', 'helm.input', { data: { text: '最终问题', origin: 'human' } }),
  ]
  const active = filterRewoundEntries(entries)
  assert.deepEqual(active.map((e) => e.id), ['1', '10'])
})

test('buildTimelineItems：rewind 后被覆盖的提问/工具/回答不再渲染，同批新 input 保留', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    entry('1', 'helm.input', { data: { text: '最早的问题', origin: 'human' } }),
    entry('2', 'helm.input', { data: { text: '被覆盖的问题', origin: 'human' } }),
    assistantEntry('3', [{ type: 'text', text: '被覆盖的回答' }]),
    toolResultEntry('4', 'c1', 'bash', { text: '被覆盖的工具结果' }),
    entry('5', 'helm.input', { data: { text: '改写后的新问题', origin: 'human' } }),
    entry('6', 'helm.rewind', { data: { fromEntryId: 2, throughEntryId: 4, omittedEntryIds: [2, 3, 4], omittedInputIds: [], createdAt: 1 } }),
    assistantEntry('7', [{ type: 'text', text: '新回答' }]),
  ])
  const humans = items.filter((i) => i.kind === 'human')
  assert.deepEqual(humans.map((h) => (h as { text: string }).text), ['最早的问题', '改写后的新问题'])
  const turns = items.filter((i) => i.kind === 'assistant')
  assert.equal(turns.length, 1, '被覆盖的回答不渲染')
  assert.equal(collectToolTraces(items).length, 0, '被覆盖的工具结果不渲染')
})

test('lastEditableHumanInput：仅返回 origin=human 的可编辑输入，跳过 agent/trigger；含附件与 reset 边界', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    entry('1', 'helm.input', { data: { text: '第一条', origin: 'human' } }),
    entry('2', 'helm.input', {
      data: { text: '第二条', origin: 'human', attachments: [{ id: 'a1', name: '图.png', mimeType: 'image/png', size: 10 }] },
    }),
    entry('3', 'pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'text', text: '回答' }] }] }),
    entry('4', 'helm.rewind', { data: { fromEntryId: 2, throughEntryId: 3, omittedEntryIds: [2, 3], omittedInputIds: [], createdAt: 1 } }),
    entry('5', 'helm.input', { data: { text: '第三条', origin: 'human' } }),
  ]
  const target = lastEditableHumanInput(entries)
  assert.ok(target !== undefined)
  assert.equal(target!.text, '第三条')
  assert.equal(target!.entryId, 5)
  assert.equal(target!.attachments, undefined)

  // 无 rewind 时返回最后一条（含附件）
  const noRewind = lastEditableHumanInput(entries.filter((e) => e.kind !== 'helm.rewind'))
  assert.ok(noRewind !== undefined)
  assert.equal(noRewind!.text, '第三条')
  const withAtt = lastEditableHumanInput(entries.slice(0, 3))
  assert.ok(withAtt !== undefined)
  assert.equal(withAtt!.entryId, 2)
  assert.deepEqual(withAtt!.attachments?.map((a) => a.name), ['图.png'])

  // 最新输入来自 agent / trigger：不是人类编辑对象，继续向前找到上一条人类输入
  const agentLast = lastEditableHumanInput([
    entry('1', 'helm.input', { data: { text: '人类提问', origin: 'human' } }),
    entry('2', 'pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'text', text: '回答' }] }] }),
    entry('3', 'helm.input', { data: { text: 'Worker 已完成', origin: 'agent' } }),
    entry('4', 'helm.input', { data: { text: 'cron 触发', origin: 'trigger' } }),
  ])
  assert.ok(agentLast !== undefined)
  assert.equal(agentLast!.text, '人类提问')
  assert.equal(agentLast!.entryId, 1)

  // 全部为非人类输入：无可编辑对象
  assert.equal(lastEditableHumanInput([entry('3', 'helm.input', { data: { text: '汇报', origin: 'agent' } })]), undefined)

  // pi.reset 边界后无人类输入：不跨边界原地编辑
  const afterReset: ConversationEntry[] = [
    entry('1', 'helm.input', { data: { text: '旧输入', origin: 'human' } }),
    entry('2', 'pi.reset', {}),
  ]
  assert.equal(lastEditableHumanInput(afterReset), undefined)

  // 裸 pi.user 兑底：返回文本与 entryId
  const bare = lastEditableHumanInput([entry('3', 'pi.user', { model: [{ role: 'user', content: '裸消息' }] })])
  assert.ok(bare !== undefined)
  assert.equal(bare!.text, '裸消息')
  assert.equal(bare!.entryId, 3)

  assert.equal(lastEditableHumanInput([]), undefined)
})

test('withdraw 与 submitInput(replaceFromEntryId)：请求体构造与非法 submissionId 校验', { timeout: 60_000 }, async (t) => {
  const captured = stubFetchOnce(t, () => ({ status: 'withdrawn' }))

  await conversationsApi.withdraw(7, '3')
  assert.equal(captured[0]!.path, '/api/conversations/7/withdraw')
  assert.deepEqual(captured[0]!.body, { submissionId: 3 })
  assert.equal(typeof (captured[0]!.body as { submissionId: number }).submissionId, 'number')

  await conversationsApi.withdraw(7, 12)
  assert.deepEqual(captured[1]!.body, { submissionId: 12 })

  // 非法 ID：显式 400，不发请求
  for (const bad of ['abc', '0', '-3', '', '1.5', '1e2', ' 3', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(async () => conversationsApi.withdraw(7, bad as string), (err: unknown) => {
      assert.ok(err instanceof ApiClientError)
      assert.equal(err.code, 'validation_error')
      assert.equal(err.status, 400)
      return true
    })
  }
  assert.equal(captured.length, 2, '非法 submissionId 不得发出任何请求')

  // submitInput 携带 replaceFromEntryId：原样透传；不带时省略
  await conversationsApi.submitInput(7, { text: '改写后', origin: 'human', replaceFromEntryId: 2 })
  assert.equal(captured[2]!.path, '/api/conversations/7/input')
  assert.deepEqual(captured[2]!.body, { text: '改写后', origin: 'human', replaceFromEntryId: 2 })
  await conversationsApi.submitInput(7, { text: '普通', origin: 'human' })
  assert.deepEqual(captured[3]!.body, { text: '普通', origin: 'human' })
})

test('collectSiblingCalls：收集全部工具调用轻量摘要（callId 顺序 / 状态归一 / details 透传 structuredOutput）', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    entry('1', 'helm.input', { data: { text: '开始', origin: 'human' } }),
    assistantEntry('2', [toolCallBlock('call_1', 'subagent', { prompt: '首次派生' })]),
    toolResultEntry('3', 'call_1', 'subagent', { text: '首战告捷', details: { execution: { conversationId: 42 } } }),
    assistantEntry('4', [{ type: 'text', text: '继续深挖' }]),
    entry('5', 'helm.input', { data: { text: '续接 42', origin: 'human' } }),
    assistantEntry('6', [toolCallBlock('call_2', 'subagent', { prompt: '继续', resume: 42 })]),
    toolResultEntry('7', 'call_2', 'subagent', { text: '第二轮完成', details: { execution: { conversationId: 42 } } }),
    entry('8', 'helm.input', { data: { text: '再续接 42 并派生 43', origin: 'human' } }),
    assistantEntry('9', [
      toolCallBlock('call_3', 'subagent', { prompt: '再继续', resume: '42' }),
      toolCallBlock('call_4', 'subagent', { prompt: '新任务' }),
    ]),
    toolResultEntry('10', 'call_3', 'subagent', { text: '第三轮完成', details: { execution: { conversationId: 42 } } }),
    toolResultEntry('11', 'call_4', 'subagent', { text: '新会话完成', details: { execution: { conversationId: 43 } } }),
  ])
  const calls = collectSiblingCalls(items)
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map((c) => c.callId), ['call_1', 'call_2', 'call_3', 'call_4'])
  assert.ok(calls.every((c) => c.toolName === 'subagent'))
  assert.ok(calls.every((c) => c.status === 'done'))
  assert.deepEqual(calls[0]!.structuredOutput, { execution: { conversationId: 42 } })
  assert.deepEqual(calls[2]!.structuredOutput, { execution: { conversationId: 42 } })
  assert.deepEqual(calls[3]!.structuredOutput, { execution: { conversationId: 43 } })
  assert.deepEqual(calls[1]!.input, { prompt: '继续', resume: 42 })
  assert.deepEqual(calls[2]!.input, { prompt: '再继续', resume: '42' })
})

test('collectSiblingCalls：无 callId 的调用跳过，step-group 内工具同样收集', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    assistantEntry('1', [
      toolCallBlock('c-fold-1', 'bash', { command: 'ls' }),
      toolCallBlock('c-fold-2', 'read', { file_path: '/x' }),
    ]),
    toolResultEntry('2', 'c-fold-1', 'bash', { text: 'ok' }),
    toolResultEntry('3', 'c-fold-2', 'read', { text: '内容' }),
  ])
  const calls = collectSiblingCalls(items)
  assert.deepEqual(calls.map((c) => c.callId), ['c-fold-1', 'c-fold-2'])
})

// ---------------------------------------------------------------------------
// 精简进行中（pending compaction divider）时间线排列
// ---------------------------------------------------------------------------

test('buildTimelineItems：compacting=true 时在回合之后、queuedInputs 之前插入 pending compaction 分割线', { timeout: 60_000 }, () => {
  const items = buildTimelineItems(
    [
      entry('1', 'helm.input', { data: { text: '历史提问', origin: 'human' } }),
      assistantEntry('2', [{ type: 'text', text: '历史回答' }]),
    ],
    {
      compacting: true,
      live: {
        conversationId: 1,
        text: '',
        tools: [],
        updatedAt: 100,
        queuedInputs: [
          {
            submissionId: '9',
            id: 'q-after-compact',
            text: '精简后继续分析',
            mode: 'followUp',
            origin: 'human',
            createdAt: 200,
          },
        ],
      },
      working: false,
    },
  )

  assert.deepEqual(
    items.map((item) => item.kind),
    ['human', 'assistant', 'divider', 'human'],
    'pending compaction 分割线必须位于已提交/live 回合之后、queuedInputs 之前',
  )
  const divider = items[2]
  assert.ok(divider?.kind === 'divider')
  assert.equal(divider.key, 'divider:compacting')
  assert.equal(divider.entryId, 'compacting:live')
  assert.equal(divider.divider, 'compaction')
  assert.equal(divider.pending, true)
  const queued = items[3]
  assert.ok(queued?.kind === 'human')
  assert.equal(queued.queuedMode, 'followUp')
  assert.equal(queued.text, '精简后继续分析')
})

test('buildTimelineItems：compacting 未开启时不插入 pending compaction 分割线', { timeout: 60_000 }, () => {
  const withoutFlag = buildTimelineItems([
    entry('1', 'helm.input', { data: { text: '提问', origin: 'human' } }),
    assistantEntry('2', [{ type: 'text', text: '回答' }]),
  ])
  assert.equal(withoutFlag.some((item) => item.kind === 'divider' && item.pending === true), false)

  const falseFlag = buildTimelineItems(
    [
      entry('1', 'helm.input', { data: { text: '提问', origin: 'human' } }),
      assistantEntry('2', [{ type: 'text', text: '回答' }]),
    ],
    { compacting: false },
  )
  assert.equal(falseFlag.some((item) => item.kind === 'divider' && item.pending === true), false)
})

// ---------------------------------------------------------------------------
// 祖先链与后代收集（原 ancestry-model.test.ts 合并）
// ---------------------------------------------------------------------------

function ancestrySummary(id: number, parentConversationId?: number): ConversationSummary {
  return {
    id,
    title: `会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: id,
    updatedAt: id,
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
  }
}

test('buildAncestorChain 返回根在前的任意深度祖先链', { timeout: 60_000 }, () => {
  const conversations = [ancestrySummary(1), ancestrySummary(11, 1), ancestrySummary(111, 11), ancestrySummary(1111, 111)]
  assert.deepEqual(buildAncestorChain(conversations, 1111), [1, 11, 111])
  assert.deepEqual(buildAncestorChain(conversations, 11), [1])
  assert.deepEqual(buildAncestorChain(conversations, 1), [], '根会话无祖先链')
})

test('buildAncestorChain 对环与缺失摘要安全截断', { timeout: 60_000 }, () => {
  const cyclic = [ancestrySummary(1, 2), ancestrySummary(2, 1), ancestrySummary(3, 2)]
  assert.deepEqual(buildAncestorChain(cyclic, 3), [1, 2])
  const missing = [ancestrySummary(5, 99)]
  assert.deepEqual(buildAncestorChain(missing, 5), [99])
  const deep: ConversationSummary[] = [ancestrySummary(0)]
  for (let i = 1; i <= MAX_ANCESTRY_DEPTH + 10; i++) deep.push(ancestrySummary(i, i - 1))
  const chain = buildAncestorChain(deep, MAX_ANCESTRY_DEPTH + 10)
  assert.equal(chain.length, MAX_ANCESTRY_DEPTH)
  assert.equal(chain[0], 10, '超深截断时保留最靠近根的 MAX_ANCESTRY_DEPTH 级（根在前）')
  assert.equal(chain[chain.length - 1], MAX_ANCESTRY_DEPTH + 9, '链尾是最近祖先')
})

test('collectSubtreeIds 收集含自身的全部后代且防环', { timeout: 60_000 }, () => {
  const conversations = [ancestrySummary(1), ancestrySummary(11, 1), ancestrySummary(12, 1), ancestrySummary(111, 11), ancestrySummary(9)]
  assert.deepEqual([...collectSubtreeIds(conversations, 1)].sort((a, b) => a - b), [1, 11, 12, 111])
  assert.deepEqual([...collectSubtreeIds(conversations, 11)], [11, 111])
  assert.deepEqual([...collectSubtreeIds(conversations, 9)], [9])
  const cyclic = [ancestrySummary(1, 11), ancestrySummary(11, 1), ancestrySummary(111, 11)]
  assert.deepEqual([...collectSubtreeIds(cyclic, 1)].sort((a, b) => a - b), [1, 11, 111])
})

// ---------------------------------------------------------------------------
// 归档操作与批量错误汇总（原 archive-ops.test.ts 合并）
// ---------------------------------------------------------------------------

function archiveConv(id: number, tags: string[] = []): Pick<ConversationSummary, 'id' | 'tags'> {
  return { id, tags }
}

test('patchConversationArchived 保留其他 tags 并发送归档/恢复 PATCH', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    return new Response(JSON.stringify({ id: 7, tags: ['keep', ARCHIVED_TAG] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await patchConversationArchived(archiveConv(7, ['keep']), true)
    await patchConversationArchived(archiveConv(7, ['keep', ARCHIVED_TAG]), false)
    assert.deepEqual(requests, [
      { url: '/api/conversations/7', method: 'PATCH', body: { tags: ['keep', ARCHIVED_TAG] } },
      { url: '/api/conversations/7', method: 'PATCH', body: { tags: ['keep'] } },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('patchConversationsArchived 汇总批量部分失败，archiveBatchNotice 如实报告', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/2')) {
      return new Response(JSON.stringify({ error: { code: 'conflict', message: '会话正在更新' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const outcome = await patchConversationsArchived([archiveConv(1), archiveConv(2)], true)
    assert.deepEqual(outcome, {
      attempted: 2,
      fulfilled: 1,
      rejected: 1,
      firstError: '会话正在更新',
    })
    assert.deepEqual(archiveBatchNotice(true, outcome), {
      type: 'notification',
      level: 'warning',
      title: 'Bulk Archive partially failed',
      body: '1 succeeded, 1 failed: 会话正在更新',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
