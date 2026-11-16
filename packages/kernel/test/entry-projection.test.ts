/**
 * entry-projection 单元测试（纯函数，无 IO）：
 * - pi.system 过滤；签名剥离（嵌套/数组/共享引用不改写输入）；
 * - 安全纯文本 tool-result 截断：头尾保留、消息级 truncated/totalChars/
 *   totalLines 标记、[Artifact] id= 尾标保留、details 原样透传不豁免截断；
 * - 豁免：可解析 JSON 信封（subagent/SubagentWorkflow 结构化结果）、
 *   阈值以下、非纯文本内容；
 * - pageVisibleEntries：pi.system 在分页循环内视为不可见，limit = 可见条数。
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

test('pi.system 过滤；其余 kind 原样透出', () => {
  const system: ConversationEntry = { id: '1', kind: 'pi.system', data: { pos: 1 } }
  assert.equal(projectDetailEntry(system), undefined)
  const input: ConversationEntry = { id: '2', kind: 'helm.input', data: { id: 'i', text: 'hi' } }
  assert.deepEqual(projectDetailEntry(input), input)
})

test('签名剥离：thinkingSignature/textSignature/thoughtSignature 深度移除，其余保留', () => {
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
  // data 是插件/helm 业务 JSON，可能合法携带同名字段：签名剥离仅限 model 载荷
  assert.deepEqual((projected!.data as any).nested.deep[0], { textSignature: 'sig-4', keep: 1 })
  // 输入不被改写（SSE/数据库共享同一记录）
  assert.deepEqual(entry, frozen)
  // 原消息其余字段保留
  assert.equal((content[2] as { name?: string }).name, 'bash')
})

test('stripEntrySignatures 无签名时零拷贝返回原对象', () => {
  const entry: ConversationEntry = { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant' }] }
  assert.equal(stripEntrySignatures(entry), entry)
})

test('纯文本超限截断：头尾保留 + 消息级标记 + 尾部内容保留', () => {
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
  assert.ok(out.startsWith(head), '头部保留')
  assert.ok(out.endsWith(tail), '尾部保留')
  assert.ok(out.includes('helm 截断'), '省略标记自描述')
  assert.ok(out.length < text.length, '投影后更短')
  // 阈值以下不截断
  const small = projectDetailEntry(toolResultEntry('x'.repeat(TOOL_RESULT_TRUNCATE_THRESHOLD_CHARS)))
  assert.equal((small!.model![0] as Record<string, unknown>)['truncated'], undefined)
})

test('spill 预览文本（含 [Artifact] id= 全文入口）豁免：绝不叠加二次截断', () => {
  const spillText =
    `${'S'.repeat(4200)}\n\n…[输出超长，已截断。完整结果 50000 字节已写入产物]…\n\n` +
    `--- 尾部摘要 ---\n${'E'.repeat(200)}\n\n` +
    `[Artifact] id=0e4f0c8a-1111 name=tool-spill-x.txt path=a/b（调用工具 read_artifact 获取全文）`
  const projected = projectDetailEntry(toolResultEntry(spillText))!
  const msg = projected.model![0] as Record<string, unknown>
  assert.equal(msg['truncated'], undefined, 'spill 语义归 artifacts 层，本层不再标记')
  assert.equal(((msg['content'] as Array<{ text: string }>)[0]!.text), spillText, '原文原样透出')
})

test('details 存在仍截断纯文本 content（details 原样透传）', () => {
  const text = `${'H'.repeat(TOOL_RESULT_HEAD_CHARS)}${'M'.repeat(2000)}${'T'.repeat(TOOL_RESULT_TAIL_CHARS)}`
  const entry = toolResultEntry(text, { details: { ui: 'meta', thinkingSignature: 'business-value' }, durationMs: 12 })
  const projected = projectDetailEntry(entry)!
  const msg = projected.model![0] as Record<string, unknown>
  assert.equal(msg['truncated'], true)
  // details 是插件结构化 JSON：即使携带签名同名键也原样保留（剥离仅限 assistant content 块）
  assert.deepEqual(msg['details'], { ui: 'meta', thinkingSignature: 'business-value' })
  assert.equal(msg['durationMs'], 12)
})

test('可解析 JSON 信封豁免（subagent/SubagentWorkflow 结构化结果）', () => {
  const json = JSON.stringify({ ok: true, runId: 'r1', result: 'x'.repeat(4000) })
  const projected = projectDetailEntry(toolResultEntry(json))!
  const msg = projected.model![0] as Record<string, unknown>
  assert.equal(msg['truncated'], undefined)
  assert.equal(((msg['content'] as Array<{ text: string }>)[0]!.text), json)
  // JSON + 尾部 [subagent ...] footer 行：同样豁免（footer 剥离后主体可解析）
  const withFooter = `${json}\n[subagent 完成：后台句柄 runId=r1 已登记]`
  const footerProjected = projectDetailEntry(toolResultEntry(withFooter))!
  assert.equal((footerProjected.model![0] as Record<string, unknown>)['truncated'], undefined)
  // 非 JSON 大文本仍截断
  const plain = `${json}\n后续普通文本输出${'z'.repeat(4000)}`
  const truncated = projectDetailEntry(toolResultEntry(plain))!
  assert.equal((truncated.model![0] as Record<string, unknown>)['truncated'], true)
})

test('字符串 content 与非纯文本 content：前者截断、后者原样', () => {
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

test('pageVisibleEntries：pi.system 在循环内不可见，limit = 可见条数', { timeout: 60_000 }, async () => {
  // 降序原始条目：9=pi.system, 8=可见, 7=pi.system, 6=可见, 5=可见, 4=pi.system, 3=可见
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
    '收集 3 条可见条目（跳过 pi.system，继续取更旧页）',
  )
  assert.notEqual(nextCursor, undefined, '仍有更旧条目时返回游标')
})
