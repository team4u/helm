/**
 * 服务端截断预览组件交互测试（happy-dom）：
 * - bash/generic/read 输出：截断识别（说明 + 展开全文取回）、预览折叠保留、
 *   Artifact 尾标共存；
 * - 点击「展开全文」按 resultEntryId 请求 GET /api/conversations/:id/entries/:entryId，
 *   成功后经 store.backfillConversationEntry 原位回填，重渲染呈现全文（真实时间线重建闭环）；
 * - 失败/响应 id 不一致：错误显式可见、可重试、绝不回填、绝不伪造全文；
 * - 复制语义：截断未取回前所有结果文本复制入口禁用（含 RawToolData 原始输出），
 *   取回全文后才启用；read 的 details 通道内容不受截断约束可正常复制；
 * - 无截断标记时既有展示与复制行为不变。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConversationEntry } from '@helm/protocol'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { buildTimelineItems, type ToolTrace } from '../src/conversation/timeline-model.js'
import { ToolExpandedBody } from '../src/conversation/ToolExpandedBody.js'

const e = React.createElement

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

// ---------------------------------------------------------------------------
// 挂载与数据工具
// ---------------------------------------------------------------------------

interface Mount {
  host: HTMLElement
  render: (element: React.ReactElement) => Promise<void>
  unmount: () => void
}

function createMount(): Mount {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | null = createRoot(container)
  return {
    host: container,
    render: async (element: React.ReactElement) => {
      await act(async () => {
        root?.render(element)
      })
    },
    unmount: () => {
      act(() => {
        root?.unmount()
        root = null
        container.remove()
      })
    },
  }
}

function truncTrace(overrides: Partial<ToolTrace> = {}): ToolTrace {
  return {
    key: 't1',
    toolName: 'bash',
    status: 'done',
    isError: false,
    resultText: '预览第 1 行\n预览第 2 行\n预览第 3 行\n预览第 4 行\n预览第 5 行\n预览第 6 行\n预览第 7 行\n预览第 8 行\n预览第 9 行\n预览第 10 行',
    resultTruncation: { truncated: true, totalChars: 9000, totalLines: 300 },
    resultEntryId: '42',
    ...overrides,
  }
}

const originalFetch = globalThis.fetch

/** fetch 替身：按路径路由响应；记录全部请求；status 可动态求值（失败→成功重试用）。 */
function installFetch(routes: Array<{ match: (path: string) => boolean; reply: () => unknown; status?: number | (() => number) }>): { requests: string[] } {
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input)
    requests.push(path)
    const route = routes.find((item) => item.match(path))
    if (route === undefined) return new Response(JSON.stringify({ error: { code: 'http_500', message: '未预期的请求' } }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    const status = typeof route.status === 'function' ? route.status() : route.status ?? 200
    return new Response(JSON.stringify(route.reply()), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { requests }
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch
}

const FULL_TEXT = Array.from({ length: 40 }, (_, i) => `full-line-${i}`).join('\n')
const FULL_ENTRY: ConversationEntry = {
  id: '42',
  kind: 'pi.tool-result',
  model: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: FULL_TEXT }] }],
}

/** 截断/全文两份 entries -> ToolTrace（真实 buildTimelineItems 闭环，避免手拼视图状态）。 */
function traceFromEntries(entries: ConversationEntry[]): ToolTrace {
  const items = buildTimelineItems(entries)
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const seg of item.segments) {
      if (seg.kind === 'tool') return seg.tool
      if (seg.kind === 'step-group') {
        for (const step of seg.steps) if (step.kind === 'tool') return step.tool
      }
    }
  }
  throw new Error('未生成工具轨迹')
}

function truncatedEntries(): ConversationEntry[] {
  return [
    { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pnpm test' } }] }] },
    {
      id: '42',
      kind: 'pi.tool-result',
      model: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: truncTrace().resultText }], truncated: true, totalChars: 9000, totalLines: 300 }],
    },
  ]
}

function fullEntries(): ConversationEntry[] {
  return [
    truncatedEntries()[0]!,
    FULL_ENTRY,
  ]
}

function makeStore(backfill?: (conversationId: number, entry: ConversationEntry) => void) {
  const store = makeTestStore()
  if (backfill !== undefined) store.backfillConversationEntry = backfill
  else delete store.backfillConversationEntry
  return store
}

function bodyUi(store: ReturnType<typeof makeTestStore>, tool: ToolTrace): React.ReactElement {
  return e(HostStoreProviders, { value: store }, e(ToolExpandedBody, { tool, conversationId: 1 }))
}

function findButton(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined
}

// ---------------------------------------------------------------------------
// 截断识别与预览保留
// ---------------------------------------------------------------------------

test('bash 截断：单一全文入口（主展开按钮即取回），预览折叠事实保留，Artifact 尾标共存', { timeout: 60_000 }, async (t) => {
  const store = makeStore()
  const m = createMount()
  t.after(() => { m.unmount(); restoreFetch() })
  await m.render(bodyUi(store, truncTrace({ artifactRef: 'art_demo-1' })))
  const text = m.host.textContent ?? ''
  assert.match(text, /服务端仅传回预览（全文 300 行）/, '截断说明携带服务端计数')
  assert.match(text, /条目仅存 Spill 预览，完整原文见下方产物入口/, 'spill 场景不声称单条 endpoint 还原原文')
  assert.ok(findButton(m.host, '展开全文（全文 300 行）'), '展开全文=主展开按钮，直接取回')
  assert.ok(findButton(m.host, '展开预览') === undefined, '不出现第二个相近的预览展开入口')
  assert.match(text, /已折叠前 2 行/, '预览折叠事实如实（尾 8 行）')
  assert.ok(findButton(m.host, '打开完整产物'), 'Artifact 尾标不受截断影响')
})

test('无截断标记：既有展示与复制完全不变', { timeout: 60_000 }, async (t) => {
  const store = makeStore()
  const m = createMount()
  t.after(() => { m.unmount(); restoreFetch() })
  const tool = truncTrace()
  delete tool.resultTruncation
  delete tool.resultEntryId
  await m.render(bodyUi(store, tool))
  assert.doesNotMatch(m.host.textContent ?? '', /服务端仅传回预览/)
  assert.ok(findButton(m.host, '展开全部（共 10 行）'), '本地折叠标签不变')
  assert.ok(findButton(m.host, '展开全文') === undefined, '无取回入口')
})

// ---------------------------------------------------------------------------
// 复制门禁
// ---------------------------------------------------------------------------

test('RawToolData 原始输出复制在截断未取回前禁用，不静默复制预览', { timeout: 60_000 }, async (t) => {
  const store = makeStore()
  const m = createMount()
  t.after(() => { m.unmount(); restoreFetch() })
  await m.render(bodyUi(store, truncTrace()))
  await act(async () => { findButton(m.host, '原始数据')?.click() })
  const gate = findButton(m.host, '复制原始输出')
  assert.ok(gate, '原始输出复制入口存在')
  assert.equal(gate!.disabled, true, '截断未取回前禁用')
  assert.match(gate!.title ?? '', /截断预览/)
  assert.match(m.host.textContent ?? '', /服务端仅传回预览/, '原始数据区同样呈现截断事实')
})

test('Artifact Spill 原始输出是产物预览，禁用复制并保留完整产物入口', { timeout: 60_000 }, async (t) => {
  const store = makeStore()
  const m = createMount()
  t.after(() => { m.unmount(); restoreFetch() })
  await m.render(bodyUi(store, truncTrace({ resultTruncation: undefined, artifactRef: 'art_demo-1' })))
  await act(async () => { findButton(m.host, '原始数据')?.click() })
  const copy = findButton(m.host, '复制原始输出')
  assert.ok(copy)
  assert.equal(copy!.disabled, true, 'spill entry 仅有预览，不能把它当全文复制')
  assert.match(copy!.title ?? '', /完整产物/)
  assert.ok(findButton(m.host, '打开完整产物'), '完整原文仍由 Artifact 入口提供')
})

test('read：原始输出通道截断时复制内容被门禁；details 通道完整则不受约束', { timeout: 60_000 }, async (t) => {
  const store = makeStore()
  const m = createMount()
  t.after(() => { m.unmount(); restoreFetch() })

  await m.render(bodyUi(store, truncTrace({ toolName: 'read', structuredOutput: { path: '/a.ts', content: 'details 完整内容' } })))
  assert.doesNotMatch(m.host.textContent ?? '', /服务端仅传回预览/, 'details 通道内容完整，不提示截断')
  assert.equal(findButton(m.host, '复制内容')?.disabled, false, 'details 内容可复制')

  await m.render(bodyUi(store, truncTrace({ toolName: 'read' })))
  const gate = findButton(m.host, '复制内容')
  assert.ok(gate, '原始输出通道的复制入口存在')
  assert.equal(gate!.disabled, true, '原始输出为截断预览时禁用复制')
})

// ---------------------------------------------------------------------------
// 按需取回：成功回填 / 失败可见 / 响应不一致拒绝
// ---------------------------------------------------------------------------

test('点击展开全文：按 entry id 请求，成功后回填并在重渲染中呈现全文（闭环）', { timeout: 60_000 }, async (t) => {
  const backfilled: Array<{ conversationId: number; entry: ConversationEntry }> = []
  const store = makeStore((conversationId, entry) => backfilled.push({ conversationId, entry }))
  const fetches = installFetch([
    {
      match: (path) => path === '/api/conversations/1/entries/42',
      reply: () => FULL_ENTRY,
    },
  ])
  const m = createMount()
  t.after(() => { m.unmount(); restoreFetch() })

  const truncatedTool = traceFromEntries(truncatedEntries())
  await m.render(bodyUi(store, truncatedTool))
  await act(async () => { findButton(m.host, '展开全文')?.click() })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })

  assert.deepEqual(fetches.requests, ['/api/conversations/1/entries/42'], '按 ConversationEntry.id 精确请求且仅一次')
  assert.equal(backfilled.length, 1)
  assert.equal(backfilled[0]!.conversationId, 1)
  assert.deepEqual(backfilled[0]!.entry, FULL_ENTRY, '回填的是服务端完整条目')

  // 模拟上层状态流转：store 回填后 ConversationPane 以全文 entries 重建时间线并重渲染
  const fullTool = traceFromEntries(fullEntries())
  assert.equal(fullTool.resultTruncation, undefined, '全文条目重建后截断标记消失')
  await m.render(bodyUi(store, fullTool))
  assert.match(m.host.textContent ?? '', /full-line-39/, '展示全文')
  assert.doesNotMatch(m.host.textContent ?? '', /服务端仅传回预览/)
  assert.ok(findButton(m.host, '展开全部'), '回到本地折叠语义（真实总量）')
  await act(async () => { findButton(m.host, '原始数据')?.click() })
  const copy = findButton(m.host, '复制原始输出')
  assert.ok(copy)
  assert.equal(copy!.disabled, false, '取回全文后复制启用')
  assert.equal(copy!.title, '复制', '恢复标准复制语义')
})

test('取回失败：错误显式可见、可重试、预览保留且复制仍禁用', { timeout: 60_000 }, async (t) => {
  const backfilled: ConversationEntry[] = []
  const store = makeStore((_id, entry) => backfilled.push(entry))
  let fail = true
  const fetches = installFetch([
    {
      match: (path) => path === '/api/conversations/1/entries/42',
      reply: () => (fail ? { error: { code: 'http_503', message: '服务暂不可用' } } : FULL_ENTRY),
      status: () => (fail ? 503 : 200),
    },
  ])
  const m = createMount()
  t.after(() => { m.unmount(); restoreFetch() })

  await m.render(bodyUi(store, truncTrace()))
  await act(async () => { findButton(m.host, '展开全文')?.click() })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })

  assert.equal(backfilled.length, 0, '失败绝不回填')
  const text = m.host.textContent ?? ''
  assert.match(text, /取回全文失败：服务暂不可用/, '错误信息可见')
  assert.match(text, /仍为服务端预览，不代表完整输出/, '明确预览性质，不伪造全文')
  assert.match(text, /预览第 10 行/, '预览内容保留')
  assert.ok(findButton(m.host, '重试取回'), '可重试')
  await act(async () => { findButton(m.host, '原始数据')?.click() })
  assert.equal(findButton(m.host, '复制原始输出')?.disabled, true, '失败后复制依旧禁用')

  fail = false
  await act(async () => { findButton(m.host, '重试取回')?.click() })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  assert.equal(backfilled.length, 1, '重试成功后回填')
  assert.equal(fetches.requests.length, 2, '失败后可再次发起请求')
})

test('响应条目 id 与请求不一致：拒绝回填并显式报错', { timeout: 60_000 }, async (t) => {
  const backfilled: ConversationEntry[] = []
  const store = makeStore((_id, entry) => backfilled.push(entry))
  installFetch([
    {
      match: (path) => path === '/api/conversations/1/entries/42',
      reply: () => ({ id: '43', kind: 'pi.tool-result', model: [] }),
    },
  ])
  const m = createMount()
  t.after(() => { m.unmount(); restoreFetch() })
  await m.render(bodyUi(store, truncTrace()))
  await act(async () => { findButton(m.host, '展开全文')?.click() })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  assert.equal(backfilled.length, 0)
  assert.match(m.host.textContent ?? '', /条目形状或 id 与请求不一致/)
})

test('宿主 store 缺少回填方法：显式失败，不静默降级', { timeout: 60_000 }, async (t) => {
  const store = makeStore()
  delete store.backfillConversationEntry
  const m = createMount()
  t.after(() => { m.unmount(); restoreFetch() })
  await m.render(bodyUi(store, truncTrace()))
  await act(async () => { findButton(m.host, '展开全文')?.click() })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  assert.match(m.host.textContent ?? '', /当前宿主不支持条目回填/)
})

test('canonical entry id：请求 042 与返回 42 视为同一条目，不误判失败', { timeout: 60_000 }, async (t) => {
  const backfilled: ConversationEntry[] = []
  const store = makeStore((_id, entry) => backfilled.push(entry))
  installFetch([
    {
      match: (path) => path === '/api/conversations/1/entries/42',
      reply: () => ({ id: '42', kind: 'pi.tool-result', model: FULL_ENTRY.model }),
    },
  ])
  const m = createMount()
  t.after(() => { m.unmount(); restoreFetch() })
  await m.render(bodyUi(store, truncTrace({ resultEntryId: '042' })))
  await act(async () => { findButton(m.host, '展开全文')?.click() })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  assert.equal(backfilled.length, 1, '前导零差异不构成失败')
  assert.doesNotMatch(m.host.textContent ?? '', /与请求不一致/)
})

test('generic 工具输出：截断同样提供取回入口与失败呈现', { timeout: 60_000 }, async (t) => {
  const store = makeStore()
  const m = createMount()
  t.after(() => { m.unmount(); restoreFetch() })
  await m.render(bodyUi(store, truncTrace({ toolName: 'some_tool' })))
  assert.match(m.host.textContent ?? '', /服务端仅传回预览/)
  assert.ok(findButton(m.host, '展开全文'))
})
