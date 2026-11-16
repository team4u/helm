/**
 * 服务端截断预览纯函数单测（零 DOM）：
 * - readResultTruncation 边界收窄（truncated 必须 true；totalChars/totalLines 非法丢弃）；
 * - buildTimelineItems 把 marker 随 toolResult 消息归一到 ToolTrace（配对与独立行），
 *   并携带 resultEntryId 精确定位；全文条目重建后截断标记自然消失（回填闭环）；
 * - readBodyData.fromResultText 区分原始输出通道与 details 通道；
 * - truncationPreviewNote 绝不把预览行数冒充全文总量；
 * - conversationsApi.getEntry：数字字符串转正整数入 URL；非法 entryId 显式抛错不发请求。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationEntry } from '@helm/protocol'
import { conversationsApi, ApiClientError } from '../src/lib/api.js'
import {
  buildTimelineItems,
  readResultTruncation,
  type ToolTrace,
} from '../src/conversation/timeline-model.js'
import { readBodyData, truncationPreviewNote } from '../src/conversation/tool-body-model.js'

function entry(id: string, kind: string, extra: { data?: unknown; model?: unknown[] } = {}): ConversationEntry {
  return { id, kind, ...(extra.data !== undefined ? { data: extra.data } : {}), ...(extra.model !== undefined ? { model: extra.model } : {}) }
}

function truncatedResultEntry(id: string, callId: string, preview: string, totals: { totalChars?: number; totalLines?: number } = {}): ConversationEntry {
  return entry(id, 'pi.tool-result', {
    model: [{
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'bash',
      content: [{ type: 'text', text: preview }],
      truncated: true,
      ...(totals.totalChars !== undefined ? { totalChars: totals.totalChars } : {}),
      ...(totals.totalLines !== undefined ? { totalLines: totals.totalLines } : {}),
    }],
  })
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

test('readResultTruncation：truncated 必须 true，totals 仅收窄有限非负数', { timeout: 60_000 }, () => {
  assert.equal(readResultTruncation(null), undefined)
  assert.equal(readResultTruncation('x'), undefined)
  assert.equal(readResultTruncation({}), undefined)
  assert.equal(readResultTruncation({ truncated: false }), undefined, '显式 false = 完整原文')
  assert.deepEqual(readResultTruncation({ truncated: true }), { truncated: true })
  assert.deepEqual(
    readResultTruncation({ truncated: true, totalChars: 2048, totalLines: 64 }),
    { truncated: true, totalChars: 2048, totalLines: 64 },
  )
  assert.deepEqual(
    readResultTruncation({ truncated: true, totalChars: -1, totalLines: Number.POSITIVE_INFINITY }),
    { truncated: true },
    '非法总量丢弃：未知不伪造',
  )
})

test('buildTimelineItems：marker 随 toolResult 消息归一到配对 ToolTrace，携带 entry id', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([
    entry('1', 'helm.input', { data: { text: 'run', origin: 'human' } }),
    entry('2', 'pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pnpm test' } }] }] }),
    truncatedResultEntry('3', 'call-1', '预览输出', { totalChars: 9000, totalLines: 300 }),
  ])
  const traces = collectToolTraces(items)
  assert.equal(traces.length, 1)
  const tool = traces[0]!
  assert.equal(tool.resultText, '预览输出')
  assert.deepEqual(tool.resultTruncation, { truncated: true, totalChars: 9000, totalLines: 300 })
  assert.equal(tool.resultEntryId, '3', '按 ConversationEntry.id 精确定位')
})

test('buildTimelineItems：无配对 toolCall 的独立工具行同样携带 marker 与 entry id', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([truncatedResultEntry('9', 'call-x', '独立结果预览')])
  const traces = collectToolTraces(items)
  assert.equal(traces.length, 1)
  assert.equal(traces[0]!.resultTruncation?.truncated, true)
  assert.equal(traces[0]!.resultEntryId, '9')
})

test('回填闭环：全文条目（无 marker）重建后截断标记消失、resultText 为全文', { timeout: 60_000 }, () => {
  const fullText = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n')
  const fullEntry = entry('3', 'pi.tool-result', {
    model: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: fullText }] }],
  })
  const items = buildTimelineItems([
    entry('2', 'pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }] }] }),
    fullEntry,
  ])
  const tool = collectToolTraces(items)[0]!
  assert.equal(tool.resultTruncation, undefined)
  assert.equal(tool.resultText, fullText)
})

test('readBodyData：structuredOutput.content 优先且不受截断约束；resultText 退回时受约束', { timeout: 60_000 }, () => {
  const structured = readBodyData({
    key: 't', toolName: 'read', status: 'done', isError: false,
    resultText: '预览',
    resultTruncation: { truncated: true, totalLines: 99 },
    structuredOutput: { path: '/a.ts', content: 'details 通道完整内容' },
  })
  assert.equal(structured.content, 'details 通道完整内容')
  assert.equal(structured.fromResultText, false, 'details 通道完整传回，截断标记不适用于该展示文本')

  const raw = readBodyData({
    key: 't', toolName: 'read', status: 'done', isError: false,
    resultText: '预览',
    resultTruncation: { truncated: true, totalLines: 99 },
  })
  assert.equal(raw.content, '预览')
  assert.equal(raw.fromResultText, true)
})

test('truncationPreviewNote：总量未知不伪造，绝不把预览行数当全文', { timeout: 60_000 }, () => {
  assert.equal(truncationPreviewNote({ truncated: true }), '输出超长，服务端仅传回预览')
  assert.equal(truncationPreviewNote({ truncated: true, totalLines: 300 }), '输出超长，服务端仅传回预览（全文 300 行）')
  assert.equal(truncationPreviewNote({ truncated: true, totalChars: 9000 }), '输出超长，服务端仅传回预览（全文 9000 字符）')
})

// ---------------------------------------------------------------------------
// conversationsApi.getEntry
// ---------------------------------------------------------------------------

interface CapturedRequest { path: string }

function stubFetch(t: { after: (fn: () => void) => void }, reply: () => unknown, status = 200): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    captured.push({ path: String(input) })
    return new Response(JSON.stringify(reply()), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })
  return captured
}

test('getEntry 请求 /api/conversations/:id/entries/:entryId，数字字符串转正整数', { timeout: 60_000 }, async (t) => {
  const full = { id: '42', kind: 'pi.tool-result', model: [] }
  const captured = stubFetch(t, () => full)
  const got = await conversationsApi.getEntry(7, '42')
  assert.equal(captured[0]!.path, '/api/conversations/7/entries/42')
  assert.deepEqual(got, full)
})

test('getEntry 对非法 entryId 显式抛错，不发出请求', { timeout: 60_000 }, async () => {
  let fetched = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => { fetched = true; return new Response('{}') }) as typeof fetch
  try {
    for (const bad of ['3oops', ' 3', '-1', '1e2', 3.5, 0, '', String(Number.MAX_SAFE_INTEGER + 1)]) {
      await assert.rejects(async () => conversationsApi.getEntry(7, bad as string), (err: unknown) => {
        assert.ok(err instanceof ApiClientError)
        assert.equal(err.code, 'validation_error')
        assert.equal(err.status, 400)
        return true
      })
    }
    assert.equal(fetched, false, '校验失败绝不发请求')
  } finally {
    globalThis.fetch = originalFetch
  }
})
