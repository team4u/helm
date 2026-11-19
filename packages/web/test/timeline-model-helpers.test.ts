/**
 * timeline-model 视图纯函数单测（自 ConversationTimeline.tsx 迁入的纯逻辑）：
 * - toolStatusIcon：运行中/失败/完成/其他四态图标名；
 * - buildToolViewProps：tool.view 标准 Props 构造（状态映射、可选字段省略、透传）；
 * - buildActiveEntryIndex：rewind 覆盖过滤后的真实条目索引；
 * - resolveAssistantAnchorEntry：assistant 回合 action 锚点解析（正文载体优先，
 *   纯 toolCall 载体兜底，绝不拿 pi.tool-result 伪造）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversationEntry } from '@helmx/protocol'
import {
  buildActiveEntryIndex,
  buildToolViewProps,
  resolveAssistantAnchorEntry,
  toolStatusIcon,
  type ToolTrace,
} from '../src/conversation/timeline-model.js'

const trace = (overrides?: Partial<ToolTrace>): ToolTrace => ({
  key: 'tool:1',
  toolName: 'bash',
  status: 'done',
  isError: false,
  ...overrides,
})

test('toolStatusIcon：运行中 loader、失败 x、完成 check、其他 circle（优先级递减）', { timeout: 60_000 }, () => {
  assert.equal(toolStatusIcon(trace({ status: 'running' })), 'loader')
  // isError 优先于 done：失败的工具即使状态残留 done 也显示 x
  assert.equal(toolStatusIcon(trace({ status: 'done', isError: true })), 'x')
  assert.equal(toolStatusIcon(trace({ status: 'done' })), 'check')
  assert.equal(toolStatusIcon(trace({ status: 'unknown' })), 'circle')
  // error 状态但未标记 isError（防御）：不伪称完成，落 circle
  assert.equal(toolStatusIcon(trace({ status: 'error', isError: false })), 'circle')
})

test('buildToolViewProps：状态三值映射，可选字段缺省时键完全不出现', { timeout: 60_000 }, () => {
  const minimal = buildToolViewProps(trace(), 7, [])
  assert.deepEqual(minimal, {
    callId: '',
    toolName: 'bash',
    status: 'done',
    isError: false,
    conversationId: 7,
    siblingCalls: [],
  })
  assert.ok(!('input' in minimal))
  assert.ok(!('result' in minimal))
  assert.ok(!('durationMs' in minimal))
})

test('buildToolViewProps：running/error 映射 running/error，可选字段全量携带', { timeout: 60_000 }, () => {
  assert.equal(buildToolViewProps(trace({ status: 'running' }), 1, []).status, 'running')
  assert.equal(buildToolViewProps(trace({ status: 'error', isError: true }), 1, []).status, 'error')
  assert.equal(buildToolViewProps(trace({ status: 'unknown' }), 1, []).status, 'done')

  const full = buildToolViewProps(
    trace({
      callId: 'call_1',
      input: { cmd: 'ls' },
      resultText: '预览',
      resultTruncation: { truncated: true, totalChars: 9000, totalLines: 300 },
      structuredOutput: { files: 2 },
      startedAt: 123,
      durationMs: 456,
      artifactRef: 'art_x',
    }),
    9,
    [{ callId: 'call_1', toolName: 'bash', status: 'done' }],
  )
  assert.equal(full.callId, 'call_1')
  assert.deepEqual(full.input, { cmd: 'ls' })
  assert.equal(full.result, '预览')
  assert.deepEqual(full.resultTruncation, { truncated: true, totalChars: 9000, totalLines: 300 })
  assert.deepEqual(full.structuredOutput, { files: 2 })
  assert.equal(full.startedAt, 123)
  assert.equal(full.durationMs, 456)
  assert.equal(full.artifactRef, 'art_x')
  assert.equal(full.conversationId, 9)
  assert.deepEqual(full.siblingCalls, [{ callId: 'call_1', toolName: 'bash', status: 'done' }])
})

const entry = (id: string, kind: string, extra?: Partial<ConversationEntry>): ConversationEntry => ({
  id,
  kind,
  ...extra,
})

test('buildActiveEntryIndex：rewind 覆盖区间与 marker 自身都被排除，其余按 id 索引', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    entry('1', 'helmx.input', { data: { text: 'a', origin: 'human' } }),
    entry('2', 'pi.assistant'),
    entry('3', 'pi.assistant'),
    entry('9', 'helmx.rewind', { data: { fromEntryId: 2, throughEntryId: 3 } }),
  ]
  const index = buildActiveEntryIndex(entries)
  assert.deepEqual([...index.keys()], ['1'])
})

test('buildActiveEntryIndex：无 rewind marker 时原样全量索引（含未知 kind）', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [entry('1', 'pi.assistant'), entry('2', 'pi.tool-result')]
  assert.deepEqual([...buildActiveEntryIndex(entries).keys()], ['1', '2'])
})

const assistantEntry = (id: string, text?: string): ConversationEntry =>
  entry(id, 'pi.assistant', {
    ...(text !== undefined
      ? { model: [{ role: 'assistant', content: [{ type: 'text', text }] }] }
      : {}),
  })

test('resolveAssistantAnchorEntry：优先最后一个携带正文文本的 pi.assistant', { timeout: 60_000 }, () => {
  const a1 = assistantEntry('1', '第一段回答')
  const a2 = assistantEntry('2') // 纯 toolCall 载体
  const a3 = assistantEntry('3', '收尾回答')
  const index = new Map([['1', a1], ['2', a2], ['3', a3]])
  assert.equal(resolveAssistantAnchorEntry(['1', '2', '3'], index), a3)
})

test('resolveAssistantAnchorEntry：全无正文时退回最后一个 pi.assistant（含纯 toolCall 载体）', { timeout: 60_000 }, () => {
  const a1 = assistantEntry('1')
  const a2 = assistantEntry('2')
  const index = new Map([['1', a1], ['2', a2], ['3', entry('3', 'pi.tool-result')]])
  assert.equal(resolveAssistantAnchorEntry(['1', '2', '3'], index), a2)
})

test('resolveAssistantAnchorEntry：空正文文本块不构成正文载体；仅工具条目时 undefined', { timeout: 60_000 }, () => {
  const emptyText = entry('1', 'pi.assistant', {
    model: [{ role: 'assistant', content: [{ type: 'text', text: '' }] }],
  })
  assert.equal(resolveAssistantAnchorEntry(['1'], new Map([['1', emptyText]])), emptyText)

  const toolResult = entry('3', 'pi.tool-result')
  assert.equal(resolveAssistantAnchorEntry(['3'], new Map([['3', toolResult]])), undefined)
  assert.equal(resolveAssistantAnchorEntry(['404'], new Map()), undefined)
})
