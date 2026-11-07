/**
 * timeline-model 纯函数单测：helm.input 去重、toolCall+toolResult 配对、
 * 连续步骤折叠与豁免折叠、pi.reset / pi.compaction 分割线转换、live 合并。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationEntry, ConversationLive } from '@helm/protocol'
import {
  buildTimelineItems,
  detectArtifactRef,
  findToolView,
  formatBytes,
  formatDurationMs,
  isFoldableStep,
  lastHumanTextOf,
  matchTimelineRenderer,
  parseHelmInputData,
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

test('连续常规步骤收拢为 step-group；isError / tool.view / subagent 豁免折叠', { timeout: 60_000 }, () => {
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
  // thinking + 成功 read/bash 应收拢为一个 step-group
  const groups = turn.segments.filter((s) => s.kind === 'step-group') as Array<{ kind: 'step-group'; stepCount: number; steps: Array<{ kind: string }> }>
  assert.equal(groups.length, 1, '只有一个可折叠组')
  assert.equal(groups[0]!.stepCount, 3)
  assert.deepEqual(groups[0]!.steps.map((s) => s.kind), ['thinking', 'tool', 'tool'])
  // 失败的 c3 必须独立露出
  const exposed = turn.segments.filter((s) => s.kind === 'tool') as Array<{ kind: 'tool'; tool: ToolTrace }>
  assert.equal(exposed.length, 1)
  assert.equal(exposed[0]!.tool.callId, 'c3')
  assert.equal(exposed[0]!.tool.isError, true)
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
  // 命中 tool.view 的行独立露出；c4 是唯一可折叠步骤（单项不成组，直接静音行展示）
  const turn = items.find((i) => i.kind === 'assistant')!
  assert.ok(turn.kind === 'assistant')
  const exposed = turn.segments.filter((s) => s.kind === 'tool') as Array<{ kind: 'tool'; tool: ToolTrace }>
  assert.equal(exposed.length, 4)
  assert.deepEqual(exposed.map((e) => e.tool.callId), ['c1', 'c2', 'c3', 'c4'])
  assert.equal(turn.segments.filter((s) => s.kind === 'step-group').length, 0)
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
