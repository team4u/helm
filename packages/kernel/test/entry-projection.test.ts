/**
 * Unit tests for entry-projection (pure functions, zero I/O):
 * - filters pi.system; strips signatures (nested objects/arrays/shared references never mutate input);
 * - safe plaintext tool-result truncation: keeps head/tail, adds message-level truncated/totalChars/
 *   totalLines markers, preserves trailing `[Artifact] id=...` tags, passes `details` through without
 *   exempting content truncation;
 * - exemptions: parseable JSON envelopes (subagent/SubagentWorkflow structured results), within
 *   threshold, or non-plaintext content;
 * - pageVisibleEntries: treats pi.system as invisible inside paging loop so limit counts visible items.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationEntry } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import {
  projectDetailEntry,
  stripEntrySignatures,
  TOOL_RESULT_HEAD_CHARS,
  TOOL_RESULT_TAIL_CHARS,
  TOOL_RESULT_TRUNCATE_THRESHOLD_CHARS,
} from '../src/runtime/entry-projection.js'
import { ConversationDetailService } from '../src/runtime/conversation-detail.js'

function toolResultEntry(text: string, extra: Record<string, unknown> = {}): ConversationEntry {
  return {
    id: '5',
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text }],
        ...extra,
      },
    ],
  }
}

test('filters pi.system and passes other kinds through intact', { timeout: 60_000 }, () => {
  const system: ConversationEntry = { id: '1', kind: 'pi.system', data: { pos: 1 } }
  assert.equal(projectDetailEntry(system), undefined)
  const input: ConversationEntry = { id: '2', kind: 'helmx.input', data: { id: 'i', text: 'hi' } }
  assert.deepEqual(projectDetailEntry(input), input)
})

test('signature stripping: deep-removes thinkingSignature/textSignature/thoughtSignature while keeping everything else', { timeout: 60_000 }, () => {
  const entry: ConversationEntry = {
    id: '3',
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '...', thinkingSignature: 'sig-1' },
          { type: 'text', text: 'hi', textSignature: 'sig-2' },
          { type: 'toolCall', id: 't', name: 'bash', arguments: {}, thoughtSignature: 'sig-3' },
        ],
      },
    ],
    data: { nested: { deep: [{ textSignature: 'sig-4', keep: 1 }] } },
  }
  const frozen = JSON.parse(JSON.stringify(entry))
  const projected = projectDetailEntry(entry)
  assert.equal(projected!.kind, 'pi.assistant')
  const content = (projected!.model![0] as { content: Array<Record<string, unknown>> }).content
  assert.equal('thinkingSignature' in content[0]!, false)
  assert.equal('textSignature' in content[1]!, false)
  assert.equal('thoughtSignature' in content[2]!, false)
  // entry.data carries plugin/helmx business JSON that may legitimately reuse those field names: strip only targets model payload.
  assert.deepEqual((projected!.data as any).nested.deep[0], { textSignature: 'sig-4', keep: 1 })
  // Input object must remain unmutated (shared across SSE/DB).
  assert.deepEqual(entry, frozen)
  // Other fields on original messages remain intact.
  assert.equal((content[2] as { name?: string }).name, 'bash')
})

test('stripEntrySignatures returns original object with zero copy when no signatures exist', { timeout: 60_000 }, () => {
  const entry: ConversationEntry = { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant' }] }
  assert.equal(stripEntrySignatures(entry), entry)
})

test('truncates oversized plaintext: keeps head/tail, adds message-level markers, preserves trailing excerpt', { timeout: 60_000 }, () => {
  const head = 'H'.repeat(TOOL_RESULT_HEAD_CHARS)
  const mid = 'M'.repeat(3000)
  const tail = 'T'.repeat(200)
  const text = `${head}${mid}${tail}`
  const entry = toolResultEntry(text)
  const projected = projectDetailEntry(entry)!
  const msg = projected.model![0] as Record<string, unknown>
  assert.equal(msg['truncated'], true)
  assert.equal(msg['totalChars'], text.length)
  assert.equal(msg['totalLines'], text.split('\n').length)
  const out = ((msg['content'] as Array<{ type: string; text: string }>)[0]!.text)
  assert.ok(out.startsWith(head), 'preserves head')
  assert.ok(out.endsWith(tail), 'preserves tail')
  assert.ok(out.includes('helmx truncate'), 'omission marker describes itself')
  assert.ok(out.length < text.length, 'projected output is shorter than raw text')
  // Does not truncate at or below threshold.
  const small = projectDetailEntry(toolResultEntry('x'.repeat(TOOL_RESULT_TRUNCATE_THRESHOLD_CHARS)))
  assert.equal((small!.model![0] as Record<string, unknown>)['truncated'], undefined)
})

test('exempts spill preview text (containing [Artifact] id=): never applies double truncation', { timeout: 60_000 }, () => {
  const spillText =
    `${'S'.repeat(4200)}\n\n...[output truncated; full result of 50000 bytes written to artifact]...\n\n` +
    `--- trailing summary ---\n${'E'.repeat(200)}\n\n` +
    `[Artifact] id=0e4f0c8a-1111 name=tool-spill-x.txt path=a/b (call read_artifact to inspect full text)`
  const projected = projectDetailEntry(toolResultEntry(spillText))!
  const msg = projected.model![0] as Record<string, unknown>
  assert.equal(msg['truncated'], undefined, 'spill semantics belong to artifacts layer; projection adds no duplicate marker')
  assert.equal(((msg['content'] as Array<{ text: string }>)[0]!.text), spillText, 'passes raw spill preview through untouched')
})

test('still truncates plaintext content even when details exist (passes details through intact)', { timeout: 60_000 }, () => {
  const text = `${'H'.repeat(TOOL_RESULT_HEAD_CHARS)}${'M'.repeat(2000)}${'T'.repeat(TOOL_RESULT_TAIL_CHARS)}`
  const entry = toolResultEntry(text, { details: { ui: 'meta', thinkingSignature: 'business-value' }, durationMs: 12 })
  const projected = projectDetailEntry(entry)!
  const msg = projected.model![0] as Record<string, unknown>
  assert.equal(msg['truncated'], true)
  // details is structured plugin JSON: matching signature key names are kept intact (stripping applies only to assistant content blocks).
  assert.deepEqual(msg['details'], { ui: 'meta', thinkingSignature: 'business-value' })
  assert.equal(msg['durationMs'], 12)
})

test('exempts parseable JSON envelopes (subagent/SubagentWorkflow structured results)', { timeout: 60_000 }, () => {
  const json = JSON.stringify({ ok: true, runId: 'r1', result: 'x'.repeat(4000) })
  const projected = projectDetailEntry(toolResultEntry(json))!
  const msg = projected.model![0] as Record<string, unknown>
  assert.equal(msg['truncated'], undefined)
  assert.equal(((msg['content'] as Array<{ text: string }>)[0]!.text), json)
  // JSON + trailing [subagent ...] footer line: also exempt (body parses after stripping footer).
  const withFooter = `${json}\n[subagent complete: background runId=r1 registered]`
  const footerProjected = projectDetailEntry(toolResultEntry(withFooter))!
  assert.equal((footerProjected.model![0] as Record<string, unknown>)['truncated'], undefined)
  // Large non-JSON plaintext is still truncated.
  const plain = `${json}\nfollowed by regular text output ${'z'.repeat(4000)}`
  const truncated = projectDetailEntry(toolResultEntry(plain))!
  assert.equal((truncated.model![0] as Record<string, unknown>)['truncated'], true)
})

test('string content vs non-plaintext content: truncates strings, leaves non-plaintext untouched', { timeout: 60_000 }, () => {
  const entry: ConversationEntry = {
    id: '6',
    kind: 'pi.tool-result',
    model: [{ role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: 'z'.repeat(4000) }],
  }
  const projected = projectDetailEntry(entry)!
  const msg = projected.model![0] as Record<string, unknown>
  assert.equal(msg['truncated'], true)
  assert.equal(typeof msg['content'], 'string')
  assert.ok((msg['content'] as string).length < 4000)

  const binary: ConversationEntry = {
    id: '7',
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: 'c',
        toolName: 'x',
        content: [{ type: 'image', data: 'a'.repeat(4000), mimeType: 'image/png' }],
      },
    ],
  }
  assert.equal(projectDetailEntry(binary), binary)
})

test('pageVisibleEntries: hides pi.system inside paging loop so limit counts visible entries', { timeout: 60_000 }, async () => {
  // Descending source entries: 9=pi.system, 8=visible, 7=pi.system, 6=visible, 5=visible, 4=pi.system, 3=visible.
  const items = [
    { id: 9, kind: 'pi.system' },
    { id: 8, kind: 'pi.assistant' },
    { id: 7, kind: 'pi.system' },
    { id: 6, kind: 'pi.tool-result' },
    { id: 5, kind: 'helmx.input' },
    { id: 4, kind: 'pi.system' },
    { id: 3, kind: 'pi.assistant' },
  ]
  const pages: Array<{ items: Array<{ id: number; kind: string }>; next?: unknown }> = [
    { items: items.slice(0, 3), next: { after: 7 } },
    { items: items.slice(3, 6), next: { after: 4 } },
    { items: items.slice(6), next: undefined },
  ]
  let call = 0
  const fauxConversation = {
    entries: async (_opts: unknown, limit: number, _cursor: unknown) => {
      const page = pages[Math.min(call, pages.length - 1)]!
      call += 1
      return { items: page.items.slice(0, limit) as never, ...(page.next !== undefined ? { next: page.next } : {}) }
    },
  }
  const service = new ConversationDetailService({
    harness: {} as never,
    store: {} as never,
    stash: {} as never,
    getConversation: () => {
      throw new HelmxError('not_found', 'unreachable', 404)
    },
    collectRewindIntervals: async () => [],
    ensureContextUsage: async () => {},
  })
  const { collected, nextCursor } = await service.pageVisibleEntries(
    fauxConversation as never,
    1,
    3,
    undefined,
    [],
  )
  assert.deepEqual(
    collected.map((e) => e.id),
    [8, 6, 5],
    'collects 3 visible items (skips pi.system and pulls older pages as needed)',
  )
  assert.notEqual(nextCursor, undefined, 'returns cursor when older entries remain')
})
