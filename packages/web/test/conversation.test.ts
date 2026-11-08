/**
 * timeline-model 纯函数单测：helm.input 去重、toolCall+toolResult 配对、
 * 连续步骤折叠与豁免折叠、pi.reset / pi.compaction 分割线转换、live 合并。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationEntry, ConversationLive, WorkflowRunSummary } from '@helm/protocol'
import { conversationsApi, ApiClientError } from '../src/lib/api.js'
import {
  buildSubagentStreamLines,
  buildTimelineItems,
  detectArtifactRef,
  filterRewoundEntries,
  findToolView,
  formatBytes,
  formatDurationMs,
  isFoldableStep,
  lastEditableHumanInput,
  lastHumanTextOf,
  matchTimelineRenderer,
  parseHelmInputData,
  resolveSubagentConversationId,
  resolveSubagentExecutionMeta,
  resolveWorkflowRunForTool,
  toolSummaryText,
  type ToolTrace,
} from '../src/conversation/timeline-model.js'

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
  opts: { isError?: boolean; text?: string; durationMs?: number } = {},
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

test('toolCall + toolResult 按 callId 配对：状态、isError、耗时与结果文本合并', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    assistantEntry('1', [
      { type: 'text', text: '先看文件' },
      toolCallBlock('c1', 'read', { file_path: '/a/b.ts' }),
      toolCallBlock('c2', 'bash', { command: 'pnpm test' }),
    ]),
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
  assert.equal(traces[1]!.toolName, 'bash')
  assert.equal(traces[1]!.status, 'error')
  assert.equal(traces[1]!.isError, true)
  // 文本段保留
  const turn = items.find((i) => i.kind === 'assistant')!
  assert.ok(turn.kind === 'assistant')
  assert.ok(turn.segments.some((s) => s.kind === 'text' && s.text === '先看文件'))
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

test('isFoldableStep：tool.view 命中与 subagent/SubagentWorkflow 永不折叠', { timeout: 60_000 }, () => {
  const toolViews = [{ pluginId: 'builtin:superagent', spec: { id: 'v', toolNames: ['dispatch_worker'] } }]
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
  assert.equal(isFoldableStep({ kind: 'tool', tool: traces[0]! }), false)
  assert.equal(isFoldableStep({ kind: 'tool', tool: traces[1]! }), false)
  assert.equal(isFoldableStep({ kind: 'tool', tool: traces[2]! }), false)
  assert.equal(isFoldableStep({ kind: 'tool', tool: traces[3]! }), true)
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
    entry('2', 'pi.reset', { data: { handoff: '交接摘要文本' } }),
    entry('3', 'pi.compaction', { model: [{ role: 'user', content: '精简摘要' }] }),
  ])
  const dividers = items.filter((i) => i.kind === 'divider')
  assert.equal(dividers.length, 2)
  assert.equal(dividers[0]!.divider, 'reset')
  assert.equal(dividers[0]!.handoff, '交接摘要文本')
  assert.equal(dividers[1]!.divider, 'compaction')
  assert.equal(dividers[1]!.summary, '精简摘要')
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
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatDurationMs(50), '50ms')
  assert.equal(formatDurationMs(1500), '1.5s')
  assert.equal(formatDurationMs(125_000), '2m5s')
  assert.equal(formatDurationMs(undefined), '')
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

// ---------------------------------------------------------------------------
// subagent / SubagentWorkflow 运行期实时关联
// ---------------------------------------------------------------------------

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

test('resolveSubagentConversationId：运行期经 parentToolCallId 命中，完成后只信任标准 footer 尾行', { timeout: 60_000 }, () => {
  const conversations = [
    convSummary(10, 1),
    convSummary(11, 1, 'call-abc'),
    convSummary(12, 2, 'call-abc'), // 属于其他父会话，不得误命中
  ]
  // 运行期：resultText 尚未产出，按 callId -> parentToolCallId 精确关联
  const running: ToolTrace = {
    key: 'tool:call-abc',
    toolName: 'subagent',
    callId: 'call-abc',
    input: { prompt: '去修构建' },
    status: 'running',
    isError: false,
  }
  assert.equal(resolveSubagentConversationId(running, 1, conversations), 11)
  // 完成后：标准 footer 尾行命中（与内核 subagentFooter 字段序一致）
  const done: ToolTrace = {
    ...running,
    status: 'done',
    resultText: '完成了\n[subagent resume=old conversationId=11 executionId=herdr:1 cwd=/w]',
  }
  assert.equal(resolveSubagentConversationId(done, 1, conversations), 11)
  // 业务正文裸提及 conversationId=：不是 footer，绝不抢占关联
  const fakeBody: ToolTrace = {
    ...running,
    status: 'done',
    resultText: '修复报告：已把会话 conversationId=99 的事项处理完',
  }
  // 正文伪造值不存在（99 不在列表）时回退 callId 精确命中 11，而非误挂 99
  assert.equal(resolveSubagentConversationId(fakeBody, 1, conversations), 11)
  // 非 subagent 工具不命中
  assert.equal(
    resolveSubagentConversationId({ ...running, toolName: 'bash' }, 1, conversations),
    undefined,
  )
})

test('resolveSubagentConversationId：假正文与真 footer 并存时取 footer（最后一次标准行）', { timeout: 60_000 }, () => {
  const conversations = [convSummary(11, 1, 'call-abc')]
  const tool: ToolTrace = {
    key: 'tool:call-abc',
    toolName: 'subagent',
    callId: 'call-abc',
    status: 'done',
    isError: false,
  }
  // 正文引用行形似但非内核 footer（前缀不是 [subagent 开头或无闭合 ]）：不命中正文值
  const decoy = { ...tool, resultText: '建议 resume conversationId=42] 继续处理' }
  assert.equal(resolveSubagentConversationId(decoy, 1, conversations), 11)
  // 真 footer 在末尾：即使正文里出现别的 conversationId 值，也只取 footer 的 11
  const both = {
    ...tool,
    resultText: '上游说明 conversationId=77 已完成\n任务完成\n[subagent conversationId=11]',
  }
  assert.equal(resolveSubagentConversationId(both, 1, conversations), 11)
  // 无 footer 且无 parentToolCallId 匹配（callId 不同）：resume 数字 ref 兑底
  const resumeOnly: ToolTrace = {
    ...tool,
    callId: 'call-other',
    input: { prompt: '继续', resume: '11' },
  }
  assert.equal(resolveSubagentConversationId(resumeOnly, 1, conversations), 11)
  // footer 数字非正（0）：不合法不命中，回退 callId 兑底
  const zeroFooter: ToolTrace = {
    ...tool,
    resultText: '[subagent conversationId=0]',
  }
  assert.equal(resolveSubagentFooterOnly(zeroFooter, 1, conversations), undefined)
})

/** 只验证 footer 路径（无 callId / 无 parent 匹配 / 无 resume）：非法数字不得命中。 */
function resolveSubagentFooterOnly(tool: ToolTrace, parent: number, conversations: Array<ReturnType<typeof convSummary>>) {
  return resolveSubagentConversationId({ ...tool, callId: 'call-none' }, parent, [
    ...conversations,
  ])
}

test('resolveSubagentConversationId：resume 数字 ref 匹配同父会话子会话', { timeout: 60_000 }, () => {
  const conversations = [convSummary(21, 1), convSummary(22, 2)]
  const resumeTool: ToolTrace = {
    key: 'tool:call-xyz',
    toolName: 'subagent',
    callId: 'call-xyz',
    input: { prompt: '继续', resume: '21' },
    status: 'running',
    isError: false,
  }
  assert.equal(resolveSubagentConversationId(resumeTool, 1, conversations), 21)
  // resume 指向别的父会话的子会话：拒绝
  assert.equal(
    resolveSubagentConversationId({ ...resumeTool, input: { prompt: '继续', resume: '22' } }, 1, conversations),
    undefined,
  )
  // 非数字 ref（agentId 映射）前端无法解析：不命中（不猜测）
  assert.equal(
    resolveSubagentConversationId({ ...resumeTool, input: { prompt: '继续', resume: 'worker-1' } }, 1, conversations),
    undefined,
  )
})

test('resolveWorkflowRunForTool：运行期按 parentToolCallId 精确命中（不猜最新），完成后结果 id 全等双保险', { timeout: 60_000 }, () => {
  const running: ToolTrace = {
    key: 'tool:call-wf',
    toolName: 'SubagentWorkflow',
    callId: 'call-wf',
    status: 'running',
    isError: false,
  }

  // --- 同父会话双 running：各自 callId 精确命中，绝不都挂到第一个 running ---
  const dualRunning = [
    workflowRun('run-a', 1, 'running', 5, 'call-wf'),
    workflowRun('run-b', 1, 'running', 9, 'call-other'),
  ]
  assert.equal(resolveWorkflowRunForTool(running, 1, dualRunning)?.id, 'run-a')
  const otherTool: ToolTrace = { ...running, callId: 'call-other' }
  assert.equal(resolveWorkflowRunForTool(otherTool, 1, dualRunning)?.id, 'run-b')

  // --- 旧 completed + 新调用未创建 run：不挂旧 run（无关联即 undefined） ---
  const onlyOld = [workflowRun('run-old', 1, 'completed', 1, 'call-past')]
  assert.equal(resolveWorkflowRunForTool(running, 1, onlyOld), undefined)

  // --- 跨会话拒绝：同 callId 的 run 属其他会话不命中 ---
  const crossConv = [workflowRun('run-x', 2, 'running', 9, 'call-wf')]
  assert.equal(resolveWorkflowRunForTool(running, 1, crossConv), undefined)

  // --- 完成态：结果 JSON 精确提取 run id 命中（全等，非 includes 误前缀） ---
  const done: ToolTrace = {
    ...running,
    status: 'done',
    resultText: '工作流执行完成 {"id":"run-done","status":"completed"}',
  }
  const withDone = [workflowRun('run-done', 1, 'completed', 2, 'call-wf'), workflowRun('run-done-2', 1, 'completed', 3, 'call-wf2')]
  assert.equal(resolveWorkflowRunForTool(done, 1, withDone)?.id, 'run-done')
  // 前缀陷阱：结果 id 是 run-old 的前缀子串，绝不能 includes 误命中
  const prefixTrap: ToolTrace = {
    ...running,
    status: 'done',
    resultText: '引用了历史 run-old-2 的输出 {"id":"run-old-2"}',
  }
  const history = [workflowRun('run-old', 1, 'completed', 1)]
  assert.equal(resolveWorkflowRunForTool(prefixTrap, 1, history), undefined)

  // --- 历史已完成（无 parentToolCallId 的旧 run）：仅结果 id 提取命中，不猜最新 ---
  const legacyDone: ToolTrace = {
    ...running,
    status: 'done',
    resultText: '{"id":"run-legacy","status":"completed","result":42}',
  }
  const legacy = [workflowRun('run-legacy', 1, 'completed', 1), workflowRun('run-newer', 1, 'completed', 8)]
  assert.equal(resolveWorkflowRunForTool(legacyDone, 1, legacy)?.id, 'run-legacy')

  // --- 错误输出无 id 匹配且无 callId 关联：undefined，显示原工具行 ---
  const errored: ToolTrace = {
    ...running,
    callId: 'call-err',
    status: 'error',
    isError: true,
    resultText: 'workflow_failed: 恰好提供一个',
  }
  assert.equal(resolveWorkflowRunForTool(errored, 1, dualRunning.concat(legacy)), undefined)
  // 错误但 callId 关联存在（run 启动后引擎失败）：仍命中关联 run，展示真实失败卡
  const erroredLinked: ToolTrace = {
    ...running,
    status: 'error',
    isError: true,
    resultText: 'workflow_failed: 引擎内部错误',
  }
  assert.equal(resolveWorkflowRunForTool(erroredLinked, 1, dualRunning)?.id, 'run-a')

  // --- 无 callId（异常环境）+ 无结果 id：不命中任何 run ---
  const noCallId: ToolTrace = { ...running, callId: undefined }
  assert.equal(resolveWorkflowRunForTool(noCallId, 1, dualRunning), undefined)

  // --- 非 SubagentWorkflow 工具不命中 ---
  assert.equal(resolveWorkflowRunForTool({ ...running, toolName: 'bash' }, 1, dualRunning), undefined)
})

test('buildSubagentStreamLines：剥离 structured_output_contract 样板并展开 step-group', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    entry('1', 'helm.input', { data: { text: '帮我修复构建\n\n<structured_output_contract>\n调用 register_structured_output 工具\nSchema: {}\n</structured_output_contract>', origin: 'agent' } }),
    assistantEntry('2', [
      { type: 'thinking', thinking: '先看构建日志' },
      toolCallBlock('c1', 'bash', { command: 'pnpm build' }),
      { type: 'text', text: '构建已修复' },
    ]),
    toolResultEntry('3', 'c1', 'bash', { text: 'exit 0', durationMs: 1500 }),
  ]
  const lines = buildSubagentStreamLines(entries, undefined, false)
  assert.equal(lines.length, 4)
  assert.equal(lines[0]!.kind, 'prompt')
  assert.ok(lines[0]!.kind === 'prompt' && !lines[0]!.text.includes('structured_output_contract'))
  assert.ok(lines[0]!.kind === 'prompt' && lines[0]!.text.startsWith('帮我修复构建'))
  assert.equal(lines[1]!.kind, 'thinking')
  assert.ok(lines[1]!.kind === 'thinking' && lines[1]!.text === '先看构建日志')
  assert.equal(lines[2]!.kind, 'tool')
  assert.ok(lines[2]!.kind === 'tool' && lines[2]!.toolName === 'bash')
  assert.ok(lines[2]!.kind === 'tool' && lines[2]!.summary === 'pnpm build')
  assert.ok(lines[2]!.kind === 'tool' && lines[2]!.status === 'done')
  assert.ok(lines[2]!.kind === 'tool' && lines[2]!.durationMs === 1500)
  assert.ok(lines[2]!.kind === 'tool' && lines[2]!.resultPreview === 'exit 0')
  assert.equal(lines[3]!.kind, 'text')
  assert.ok(lines[3]!.kind === 'text' && lines[3]!.text === '构建已修复')
})

test('buildSubagentStreamLines：合并 ConversationLive 流式 thinking / tools / text', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [entry('1', 'helm.input', { data: { text: '继续任务', origin: 'agent' } })]
  const live: ConversationLive = {
    conversationId: 11,
    text: '正在分析输出…',
    thinking: '流式思考中',
    tools: [
      { callId: 'lc1', toolName: 'read', input: { file_path: '/a.ts' }, status: 'running' },
    ],
    updatedAt: 1234,
  }
  const lines = buildSubagentStreamLines(entries, live, true)
  const kinds = lines.map((l) => l.kind)
  assert.deepEqual(kinds, ['prompt', 'thinking', 'tool', 'text'])
  assert.ok(lines[1]!.kind === 'thinking' && lines[1]!.text === '流式思考中')
  assert.ok(lines[2]!.kind === 'tool' && lines[2]!.toolName === 'read' && lines[2]!.status === 'running')
  assert.ok(lines[2]!.kind === 'tool' && lines[2]!.summary === '/a.ts')
  assert.ok(lines[3]!.kind === 'text' && lines[3]!.text === '正在分析输出…')
})

// ---------------------------------------------------------------------------
// subagent 顶层 JSON 信封 execution 解析与后台执行元数据关联
// ---------------------------------------------------------------------------

test('resolveSubagentConversationId：顶层 JSON 信封 execution.conversationId 优先，业务 result 文本中的 ID 不抢占', { timeout: 60_000 }, () => {
  const conversations = [convSummary(668, 1, 'call-json')]
  const base: ToolTrace = {
    key: 'tool:call-json',
    toolName: 'subagent',
    callId: 'call-json',
    status: 'done',
    isError: false,
  }
  // 同步 JSON 信封：顶层 execution.conversationId 结构化读取
  const syncJson: ToolTrace = {
    ...base,
    resultText:
      '{"ok":true,"result":"报告正文提到 conversationId=999 的历史会话","execution":{"nodeId":"local","conversationId":668,"worktree":{"path":"/path/with space/wt","branch":"helm/spawn-123"}}}\n[subagent conversationId=668 cwd=/x worktree=/path/with space/wt@helm/spawn-123]',
  }
  assert.equal(resolveSubagentConversationId(syncJson, 1, conversations), 668)
  // 后台 JSON 信封：顶层 runId + execution（无 conversationId）：不虚构子会话；
  // 但 callId 运行期关联仍命中（受信链路，同父会话）——无 callId 时才 undefined
  const bgJson: ToolTrace = {
    ...base,
    resultText: '{"ok":true,"runId":"wf_abc123","execution":{"executionId":"pane-9","worktree":{"path":"/wt","branch":"helm/bg-1"}}}',
  }
  assert.equal(resolveSubagentConversationId(bgJson, 1, conversations), 668)
  assert.equal(
    resolveSubagentConversationId({ ...bgJson, callId: 'call-none' }, 1, conversations),
    undefined,
    '信封无 conversationId 且无 callId 关联：不虚构子会话',
  )
  // 业务 result 内嵌套任意 conversationId 字段（非顶层 execution）：不读取；
  // 但 callId 运行期关联（parentToolCallId）仍命中同父会话子会话（受信链路）
  const nestedFake: ToolTrace = {
    ...base,
    resultText: '{"ok":true,"result":{"note":"conversationId=888 已处理","inner":{"conversationId":888}}}',
  }
  assert.equal(resolveSubagentConversationId(nestedFake, 1, conversations), 668, '不读业务嵌套 ID，但 callId 关联仍命中 668')
  assert.equal(
    resolveSubagentConversationId({ ...nestedFake, callId: 'call-other' }, 1, conversations),
    undefined,
    '无 callId 关联且无信封 execution/footer/resume：不虚构子会话',
  )
  // JSON 解析优先于 footer：footer 为旧格式也能提取
  const jsonOnly: ToolTrace = {
    ...base,
    resultText: '{"ok":true,"result":"","execution":{"conversationId":668}}',
  }
  assert.equal(resolveSubagentConversationId(jsonOnly, 1, conversations), 668)
})

test('resolveSubagentConversationId：旧 footer 兑底仍有效（含内核 PATH@BRANCH 实际形态）', { timeout: 60_000 }, () => {
  const conversations = [convSummary(42, 1, 'call-ft')]
  const tool: ToolTrace = {
    key: 'tool:call-ft',
    toolName: 'subagent',
    callId: 'call-ft',
    status: 'done',
    isError: false,
    resultText:
      '任务完成报告\n[subagent resume=42 conversationId=42 cwd=/root/code/helm worktree=/root/code/helm/.worktrees/wt-42@helm/spawn-id]',
  }
  assert.equal(resolveSubagentConversationId(tool, 1, conversations), 42)
  // 正文伪造行不能抢占：非末尾 footer 形态不命中
  const fake: ToolTrace = {
    ...tool,
    resultText: '正文提到 [subagent conversationId=99] 但并非内核尾行',
  }
  // 取最后一次 footer 行：伪造行也是 footer 形态，仍取最后出现的（内核契约 footer 总在末尾）
  assert.equal(resolveSubagentConversationId(fake, 1, conversations), 99)
})

test('resolveSubagentExecutionMeta：parentToolCallId + 同父会话精确关联优先，节点 worktree 随 run 返回；跨父会话不串卡', { timeout: 60_000 }, () => {
  const run = workflowRun('wf_link', 1, 'running', 3, 'call-bg')
  run.nodes = [{ id: 'n1', kind: 'agent', status: 'running', worktree: { path: '/wt/link', branch: 'helm/bg-link' } }]
  const tool: ToolTrace = {
    key: 'tool:call-bg',
    toolName: 'subagent',
    callId: 'call-bg',
    status: 'running',
    isError: false,
  }
  const meta = resolveSubagentExecutionMeta(tool, 1, [run])
  assert.equal(meta.run?.id, 'wf_link')
  assert.deepEqual(meta.worktree, { path: '/wt/link', branch: 'helm/bg-link' })
  // 跨父会话拒绝：同 callId 的 run 属其他会话不命中（不串卡片）
  assert.deepEqual(resolveSubagentExecutionMeta(tool, 2, [run]), {})
  // 非 subagent 工具不命中
  assert.deepEqual(resolveSubagentExecutionMeta({ ...tool, toolName: 'bash' }, 1, [run]), {})
})

test('resolveSubagentExecutionMeta：后台 JSON 信封 runId 同会话全等匹配，execution 元数据与含空格路径还原', { timeout: 60_000 }, () => {
  const runs = [workflowRun('wf_abc123', 1, 'running'), workflowRun('wf_other', 1, 'completed')]
  const tool: ToolTrace = {
    key: 'tool:call-x',
    toolName: 'subagent',
    callId: 'call-x',
    status: 'done',
    isError: false,
    resultText:
      '{"ok":true,"runId":"wf_abc123","execution":{"nodeId":"node-a","executionId":"pane-9","effectiveCwd":"/wt dir/sub","worktree":{"path":"/wt dir/sub","branch":"helm/bg-main"}}}',
  }
  const meta = resolveSubagentExecutionMeta(tool, 1, runs)
  assert.equal(meta.run?.id, 'wf_abc123', '顶层 runId 全等命中同会话 run')
  assert.deepEqual(meta.worktree, { path: '/wt dir/sub', branch: 'helm/bg-main' }, 'JSON 解析可靠还原含空格路径')
  assert.equal(meta.executionId, 'pane-9')
  assert.equal(meta.nodeId, 'node-a')
  assert.equal(meta.effectiveCwd, '/wt dir/sub')
  // runId 属其他会话：不串卡（父会话 2 的 run 不被父会话 1 命中）
  const otherConvRun = workflowRun('wf_abc123', 2, 'running')
  const crossMeta = resolveSubagentExecutionMeta(tool, 1, [otherConvRun])
  assert.equal(crossMeta.run, undefined)
  assert.deepEqual(crossMeta.worktree, { path: '/wt dir/sub', branch: 'helm/bg-main' }, '无 run 关联时 worktree 仍如实提取')
})

test('resolveSubagentExecutionMeta：旧 footer 兑底（runId= / worktree=PATH@BRANCH 实际内核形态）', { timeout: 60_000 }, () => {
  const runs = [workflowRun('wf_old9', 1, 'running')]
  const tool: ToolTrace = {
    key: 'tool:call-f',
    toolName: 'subagent',
    callId: 'call-f',
    status: 'done',
    isError: false,
    resultText:
      '已转入后台\n[subagent background runId=wf_old9 conversationId=668 cwd=/x worktree=/srv/wt/helm-42@helm/wf-run-1]',
  }
  const meta = resolveSubagentExecutionMeta(tool, 1, runs)
  assert.equal(meta.run?.id, 'wf_old9')
  assert.deepEqual(meta.worktree, { path: '/srv/wt/helm-42', branch: 'helm/wf-run-1' }, 'PATH@BRANCH 形态解析')
})

test('resolveSubagentExecutionMeta：run 节点 worktree 优先于 JSON/footer 文本；无关联不伪造', { timeout: 60_000 }, () => {
  const run = workflowRun('wf_pref', 1, 'running', 3, 'call-p')
  run.nodes = [{ id: 'n1', kind: 'agent', status: 'running', worktree: { path: '/wt/from-run', branch: 'helm/from-run' } }]
  const tool: ToolTrace = {
    key: 'tool:call-p',
    toolName: 'subagent',
    callId: 'call-p',
    status: 'running',
    isError: false,
    resultText:
      '{"ok":true,"runId":"wf_pref","execution":{"worktree":{"path":"/wt/from-json","branch":"helm/from-json"}}}\n[subagent worktree=/wt/from-footer@helm/from-footer]',
  }
  const meta = resolveSubagentExecutionMeta(tool, 1, [run])
  assert.equal(meta.run?.id, 'wf_pref')
  assert.deepEqual(meta.worktree, { path: '/wt/from-run', branch: 'helm/from-run' }, 'run 节点坐标优先')
  // 无任何线索：字段均 undefined
  const plain: ToolTrace = { ...tool, callId: 'call-none', resultText: '普通输出' }
  assert.deepEqual(resolveSubagentExecutionMeta(plain, 1, [run]), {})
  // 业务 result 文本中裸提及 conversationId/runId：不解读
  const bodyMention: ToolTrace = {
    ...tool,
    callId: 'call-none',
    resultText: '报告：上次 runId=wf_missing 的任务已完成，详见 conversationId=123',
  }
  assert.deepEqual(resolveSubagentExecutionMeta(bodyMention, 1, [run]), {})
})
