/**
 * entry-projection unit test (pure function, without IO):
 * - pi.system filter; signature strip (embed set/array/sharing reference do not change write input);
 * - security pure text tool-result truncate: head tail keep, message level truncated/totalChars/
 *   totalLines mark record,[Artifact] id= tail mark keep,details original pass-through do not exemption truncate;
 * - exemption: can parse JSON message seal (subagent/SubagentWorkflow structure result),
 *   threshold or fewer, non- pure text content;
 * - pageVisibleEntries:pi.system in page loop inside treated as invisible,limit = visible count.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationEntry } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
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

test('pi.system filter; the rest kind original through out', { timeout: 60_000 }, () => {
  const system: ConversationEntry = { id: '1', kind: 'pi.system', data: { pos: 1 } }
  assert.equal(projectDetailEntry(system), undefined)
  const input: ConversationEntry = { id: '2', kind: 'helm.input', data: { id: 'i', text: 'hi' } }
  assert.deepEqual(projectDetailEntry(input), input)
})

test('signature strip:thinkingSignature/textSignature/thoughtSignature deep remove, the rest keep', { timeout: 60_000 }, () => {
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
  // data is plugin/helm business JSON, may legal carry same name segment: signature strip only limit model payload
  assert.deepEqual((projected!.data as any).nested.deep[0], { textSignature: 'sig-4', keep: 1 })
  // input do not by change write (SSE/database sharing the same record)
  assert.deepEqual(entry, frozen)
  // original message the rest field keep
  assert.equal((content[2] as { name?: string }).name, 'bash')
})

test('stripEntrySignatures without signature when zero copy return original object', { timeout: 60_000 }, () => {
  const entry: ConversationEntry = { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant' }] }
  assert.equal(stripEntrySignatures(entry), entry)
})

test('pure text over limit truncate: head tail keep + message level mark record + tail part content keep', { timeout: 60_000 }, () => {
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
  assert.ok(out.startsWith(head), 'header keep')
  assert.ok(out.endsWith(tail), 'tail part keep')
  assert.ok(out.includes('helm truncate'), 'omit mark record self description')
  assert.ok(out.length < text.length, 'throw shadow after more short')
  // threshold or fewer do not truncate
  const small = projectDetailEntry(toolResultEntry('x'.repeat(TOOL_RESULT_TRUNCATE_THRESHOLD_CHARS)))
  assert.equal((small!.model![0] as Record<string, unknown>)['truncated'], undefined)
})

test('spill preview text (contains [Artifact] id= all text entry) exemption: never stack add second truncate', { timeout: 60_000 }, () => {
  const spillText =
    `${'S'.repeat(4200)}\n\n...[output over long, already truncate. complete result 50000 byte already write artifact]...\n\n` +
    `--- tail part summary ---\n${'E'.repeat(200)}\n\n` +
    `[Artifact] id=0e4f0c8a-1111 name=tool-spill-x.txt path=a/b(invoke tool read_artifact get all text)`
  const projected = projectDetailEntry(toolResultEntry(spillText))!
  const msg = projected.model![0] as Record<string, unknown>
  assert.equal(msg['truncated'], undefined, 'spill semantics archive artifacts layer, this layer no longer mark record')
  assert.equal(((msg['content'] as Array<{ text: string }>)[0]!.text), spillText, 'original text original through out')
})

test('details store in still truncate pure text content(details original pass-through)', { timeout: 60_000 }, () => {
  const text = `${'H'.repeat(TOOL_RESULT_HEAD_CHARS)}${'M'.repeat(2000)}${'T'.repeat(TOOL_RESULT_TAIL_CHARS)}`
  const entry = toolResultEntry(text, { details: { ui: 'meta', thinkingSignature: 'business-value' }, durationMs: 12 })
  const projected = projectDetailEntry(entry)!
  const msg = projected.model![0] as Record<string, unknown>
  assert.equal(msg['truncated'], true)
  // details is plugin structure JSON: even if carry signature same name key also original keep (strip only limit assistant content chunk)
  assert.deepEqual(msg['details'], { ui: 'meta', thinkingSignature: 'business-value' })
  assert.equal(msg['durationMs'], 12)
})

test('can parse JSON message seal exemption (subagent/SubagentWorkflow structure result)', { timeout: 60_000 }, () => {
  const json = JSON.stringify({ ok: true, runId: 'r1', result: 'x'.repeat(4000) })
  const projected = projectDetailEntry(toolResultEntry(json))!
  const msg = projected.model![0] as Record<string, unknown>
  assert.equal(msg['truncated'], undefined)
  assert.equal(((msg['content'] as Array<{ text: string }>)[0]!.text), json)
  // JSON + tail part [subagent ...] footer row: same exemption (footer strip after body can parse)
  const withFooter = `${json}\n[subagent complete: background handle runId=r1 already register]`
  const footerProjected = projectDetailEntry(toolResultEntry(withFooter))!
  assert.equal((footerProjected.model![0] as Record<string, unknown>)['truncated'], undefined)
  // non- JSON large text still truncate
  const plain = `${json}\nafter continue ordinary text output${'z'.repeat(4000)}`
  const truncated = projectDetailEntry(toolResultEntry(plain))!
  assert.equal((truncated.model![0] as Record<string, unknown>)['truncated'], true)
})

test('string content and non- pure text content: before truncate, after original', { timeout: 60_000 }, () => {
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

test('pageVisibleEntries:pi.system in loop inside invisible,limit = visible count', { timeout: 60_000 }, async () => {
  // drop order original item:9=pi.system, 8=visible, 7=pi.system, 6=visible, 5=visible, 4=pi.system, 3=visible
  const items = [
    { id: 9, kind: 'pi.system' },
    { id: 8, kind: 'pi.assistant' },
    { id: 7, kind: 'pi.system' },
    { id: 6, kind: 'pi.tool-result' },
    { id: 5, kind: 'helm.input' },
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
      throw new HelmError('not_found', 'unreachable', 404)
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
    'collect 3 visible item (skip pi.system, continue take more old page)',
  )
  assert.notEqual(nextCursor, undefined, 'still has more old item when return cursor')
})
