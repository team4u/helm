import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationLive, ConversationSummary } from '@helm/protocol'
import { makeTestStore } from './helpers/store.js'
import {
  CONTAINMENT_INTRINSIC_PX,
  containmentClassName,
  estimateContainmentBucket,
  resolveActiveAnchorIndex,
  resolveContainmentClass,
  supportsTimelineContainment,
  timelineAnchorId,
} from '../src/conversation/timeline-containment-model.js'
import {
  buildTimelineItems,
  type AssistantTurn,
  type DividerItem,
  type HumanInputItem,
  type PluginCardItem,
  type ToolTrace,
} from '../src/conversation/timeline-model.js'
import { ConversationTimeline, type OutlineScrollRequest } from '../src/conversation/ConversationTimeline.js'

try {
  GlobalRegistrator.register()
} catch {
  // 已注册
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { HelmStoreContext } = await import('../src/lib/store-context.js')
const e = React.createElement

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 1. 纯函数：估高分桶
// ---------------------------------------------------------------------------

const div = (id: string): DividerItem => ({ kind: 'divider', key: `divider:${id}`, entryId: id, divider: 'reset' })
const human = (id: string, text: string): HumanInputItem => ({
  kind: 'human', key: `human:${id}`, entryId: id, text, origin: 'human', fallback: false,
})
const tool = (key: string): ToolTrace => ({ key, toolName: 'bash', status: 'done', isError: false })
const turn = (id: string, text: string, extra: AssistantTurn['segments'] = []): AssistantTurn => ({
  kind: 'assistant',
  key: `turn:${id}`,
  entryIds: [id],
  segments: text === '' ? extra : [{ kind: 'text', key: `text:${id}`, text }, ...extra],
  live: false,
})

test('estimateContainmentBucket：按文本规模分桶，divider 最小、插件卡固定中等', { timeout: 60_000 }, () => {
  assert.equal(estimateContainmentBucket(div('9')), 'xs')
  assert.equal(estimateContainmentBucket(human('1', '你好')), 'sm')
  assert.equal(estimateContainmentBucket(human('2', 'x'.repeat(200))), 'sm')
  assert.equal(estimateContainmentBucket(human('3', 'x'.repeat(600))), 'md')
  assert.equal(estimateContainmentBucket(human('4', 'x'.repeat(4000))), 'lg')
  // 附件芯片抬升估高
  assert.equal(estimateContainmentBucket({ ...human('5', '短'), attachments: [{ id: 'a1', name: 'f.png', mimeType: 'image/png', size: 10 }] }), 'sm')
  // assistant：短答 sm、长答 lg；工具行（含折叠组摘要行）计入估高
  assert.equal(estimateContainmentBucket(turn('6', '简短回答')), 'sm')
  assert.equal(estimateContainmentBucket(turn('7', 'x'.repeat(6000))), 'lg')
  assert.equal(
    estimateContainmentBucket(turn('8', '', [{ kind: 'tool', key: 't1', tool: tool('t1') }, { kind: 'step-group', key: 'g', stepCount: 1, steps: [{ kind: 'tool', tool: tool('t2') }] }])),
    'sm',
  )
  // 插件 timeline.renderer 卡片高度不可知：固定中等桶，靠 auto 记忆纠正
  const card: PluginCardItem = {
    kind: 'plugin-card', key: 'card:1', entryId: '1',
    entry: { id: '1', kind: 'custom.card', data: {} },
    renderer: { pluginId: 'builtin:x', spec: {} as PluginCardItem['renderer']['spec'] },
  }
  assert.equal(estimateContainmentBucket(card), 'md')
})

test('containmentClassName 与 CONTAINMENT_INTRINSIC_PX 对应 CSS 分桶类', { timeout: 60_000 }, () => {
  for (const bucket of ['xs', 'sm', 'md', 'lg'] as const) {
    assert.equal(containmentClassName(bucket), `tl-cv-${bucket}`)
    assert.ok(CONTAINMENT_INTRINSIC_PX[bucket] > 0)
  }
})

// ---------------------------------------------------------------------------
// 2. 纯函数：隔离判定与解除
// ---------------------------------------------------------------------------

const noRelease = new Set<string>()

test('resolveContainmentClass：live 回合、排队输入、未结算最新回合、解除目标不隔离', { timeout: 60_000 }, () => {
  // 浏览器不支持：一律正常渲染（空类名）
  assert.equal(resolveContainmentClass(turn('1', '正文'), { releasedEntryIds: noRelease, conversationBusy: false }, false), '')
  // 历史完成行：获得分桶类
  assert.match(resolveContainmentClass(turn('1', '正文'), { releasedEntryIds: noRelease, conversationBusy: false }, true), /^tl-cv-/)
  // live 流式回合不隔离
  assert.equal(resolveContainmentClass({ ...turn('2', '流式'), live: true }, { releasedEntryIds: noRelease, conversationBusy: true }, true), '')
  // 排队输入（尚未生效，仍会变化）不隔离
  assert.equal(
    resolveContainmentClass({ ...human('3', '排队'), queuedMode: 'followUp' }, { releasedEntryIds: noRelease, conversationBusy: true }, true),
    '',
  )
  // 未结算会话的最新回合不隔离；更早的已完成回合照常隔离
  assert.equal(
    resolveContainmentClass(turn('4', '最新'), { releasedEntryIds: noRelease, conversationBusy: true, latestAssistantKey: 'turn:4' }, true),
    '',
  )
  assert.match(
    resolveContainmentClass(turn('5', '更早'), { releasedEntryIds: noRelease, conversationBusy: true, latestAssistantKey: 'turn:4' }, true),
    /^tl-cv-/,
  )
  // 会话空闲后最新回合也隔离
  assert.match(
    resolveContainmentClass(turn('4', '最新'), { releasedEntryIds: noRelease, conversationBusy: false, latestAssistantKey: 'turn:4' }, true),
    /^tl-cv-/,
  )
  // 高亮 / 大纲定位目标行解除隔离（entryId 与 assistant 锚点两种口径）
  assert.equal(resolveContainmentClass(human('6', '目标'), { releasedEntryIds: new Set(['6']), conversationBusy: false }, true), '')
  assert.equal(resolveContainmentClass(turn('7', '目标'), { releasedEntryIds: new Set(['7']), conversationBusy: false }, true), '')
})

test('timelineAnchorId：assistant 回合取首个持久化条目，其余取 entryId', { timeout: 60_000 }, () => {
  assert.equal(timelineAnchorId(turn('2', '正文')), '2')
  assert.equal(timelineAnchorId({ ...turn('2', '正文'), entryIds: [] }), 'turn:2')
  assert.equal(timelineAnchorId(human('1', '文本')), '1')
  assert.equal(timelineAnchorId(div('3')), '3')
})

// ---------------------------------------------------------------------------
// 3. 纯函数：IO 激活锚点决策与支持探测
// ---------------------------------------------------------------------------

test('resolveActiveAnchorIndex：取最后相交锚点，空集回退首锚点，无锚点返回 -1', { timeout: 60_000 }, () => {
  assert.equal(resolveActiveAnchorIndex(new Set(), 0), -1)
  // 全部在基准线下方（未有任何行相交）：回退首个锚点
  assert.equal(resolveActiveAnchorIndex(new Set(), 4), 0)
  // 最后一个越过基准线的锚点 = 最大相交索引
  assert.equal(resolveActiveAnchorIndex(new Set([0, 2]), 5), 2)
  assert.equal(resolveActiveAnchorIndex(new Set([0, 1, 4]), 5), 4)
  // 越界索引防御性忽略
  assert.equal(resolveActiveAnchorIndex(new Set([9]), 5), 0)
})

test('supportsTimelineContainment：happy-dom 环境为 true；CSS 不可用时为 false', { timeout: 60_000 }, () => {
  assert.equal(supportsTimelineContainment(), true)
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS')
  try {
    Object.defineProperty(globalThis, 'CSS', { value: undefined, configurable: true })
    assert.equal(supportsTimelineContainment(), false)
  } finally {
    if (descriptor !== undefined) Object.defineProperty(globalThis, 'CSS', descriptor)
  }
})

// ---------------------------------------------------------------------------
// 4. DOM 交互：渲染隔离类应用 / 解除 / 大纲定位
// ---------------------------------------------------------------------------

function makeConv(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, title: '长会话', profileId: 'assistant', tags: [], ownedBy: 'human', cwd: '/tmp',
    model: 'faux/model', thinkingLevel: '', status: 'idle', stateChangeSeq: 1, completionSeq: 2,
    unread: false, pinned: false, pendingAskCount: 0, createdAt: 1000, updatedAt: 2000, ...overrides,
  }
}

function humanEntry(id: string, text: string): ConversationEntry {
  return { id, kind: 'helm.input', data: { id: `in-${id}`, text, origin: 'human' }, createdAt: 1000 }
}

function assistantEntry(id: string, text: string): ConversationEntry {
  return { id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }] }] }
}

function hasCvClass(el: Element | null | undefined): boolean {
  return el !== null && el !== undefined && /\btl-cv-/.test(el.className)
}

interface RenderOptions {
  conversation?: Partial<ConversationSummary>
  entries: ConversationEntry[]
  live?: ConversationLive
  highlightedEntry?: { conversationId: number; entryId: string } | null
  outlineScrollRequest?: OutlineScrollRequest | null
  onActiveEntryChange?: (entryId: string | undefined) => void
}

async function renderTimeline(opts: RenderOptions): Promise<ReturnType<typeof makeTestStore>> {
  const conv = makeConv(10, opts.conversation)
  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { 10: { ...conv, entries: opts.entries } },
    ...(opts.highlightedEntry !== undefined ? { highlightedEntry: opts.highlightedEntry } : {}),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host!)
    root.render(
      e(
        HelmStoreContext.Provider,
        { value: store },
        e(ConversationTimeline, {
          conversation: conv,
          detailEntries: opts.entries,
          onRequestEdit: () => {},
          ...(opts.live !== undefined ? { live: opts.live } : {}),
          ...(opts.outlineScrollRequest !== undefined ? { outlineScrollRequest: opts.outlineScrollRequest } : {}),
          ...(opts.onActiveEntryChange !== undefined ? { onActiveEntryChange: opts.onActiveEntryChange } : {}),
        }),
      ),
    )
  })
  return store
}

test('历史完成行按分桶获得渲染隔离类，divider 最小桶；DOM 全部保留', { timeout: 60_000 }, async () => {
  await renderTimeline({
    entries: [
      humanEntry('1', '短消息'),
      assistantEntry('2', '# 标题\n\n正文'),
      humanEntry('3', 'x'.repeat(600)),
      { id: '4', kind: 'pi.reset', data: {} },
    ],
  })
  const rows = [...host!.querySelectorAll<HTMLElement>('[data-entry-id]')]
  assert.equal(rows.length, 4, '全部条目 DOM 保留（不裁剪历史）')
  assert.match(rows[0]!.className, /\btl-cv-sm\b/, '短人类消息 → sm 桶')
  assert.match(rows[1]!.className, /\btl-cv-sm\b/, '短助手回合 → sm 桶')
  assert.match(rows[2]!.className, /\btl-cv-md\b/, '600 字符人类消息 → md 桶')
  assert.match(rows[3]!.className, /\btl-cv-xs\b/, '分割线 → xs 桶')
})

test('live 流式回合与排队输入不隔离，历史人类行照常隔离；搜索高亮目标行解除隔离', { timeout: 60_000 }, async () => {
  const live: ConversationLive = {
    conversationId: 10,
    text: '正在生成的流式正文',
    tools: [],
    updatedAt: 5,
    queuedInputs: [{ id: 'q1', submissionId: 's1', text: '排队消息', mode: 'followUp', origin: 'human', createdAt: 1 }],
  }
  await renderTimeline({
    conversation: { status: 'working' },
    entries: [humanEntry('1', '第一问'), assistantEntry('2', '第一答')],
    live,
  })
  const liveTurn = host!.querySelector<HTMLElement>('[data-entry-id="2"]')
  assert.ok(liveTurn, 'live 回合行存在')
  assert.equal(hasCvClass(liveTurn), false, 'live 流式回合不隔离')
  const queued = host!.querySelector<HTMLElement>('[data-entry-id="queued:s1"]')
  assert.ok(queued, '排队输入行存在')
  assert.equal(hasCvClass(queued), false, '排队输入行不隔离')
  const historical = host!.querySelector<HTMLElement>('[data-entry-id="1"]')
  assert.equal(hasCvClass(historical), true, '历史人类行照常隔离')

  // 搜索高亮（store.highlightedEntry）目标行解除隔离并滚动定位
  const scrolled: HTMLElement[] = []
  const origScrollIntoView = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this) }
  try {
    await renderTimeline({
      conversation: { status: 'working' },
      entries: [humanEntry('1', '第一问'), assistantEntry('2', '第一答')],
      live,
      highlightedEntry: { conversationId: 10, entryId: '1' },
    })
    const highlighted = host!.querySelector<HTMLElement>('[data-entry-id="1"]')
    assert.equal(hasCvClass(highlighted), false, '高亮目标行解除隔离')
    assert.ok(scrolled.some((el) => el === highlighted), '高亮目标行触发 scrollIntoView')
  } finally {
    HTMLElement.prototype.scrollIntoView = origScrollIntoView
  }
})

test('大纲定位：先解除目标行隔离，commit 后按 heading 序数精确滚动到对应标题', { timeout: 60_000 }, async () => {
  const entries = [
    humanEntry('1', '问'),
    assistantEntry('2', '# 一级\n正文A\n## 二级目标\n正文B\n### 三级\n正文C'),
  ]
  // 第一阶段：无定位请求，目标回合行正常隔离
  await renderTimeline({ entries })
  const wrapperBefore = host!.querySelector<HTMLElement>('[data-entry-id="2"]')
  assert.equal(hasCvClass(wrapperBefore), true, '请求前目标行处于隔离态')

  // 第二阶段：带 headingIndex 的定位请求 → 解除隔离后滚动到精确 <h2>
  const scrolled: Array<{ el: HTMLElement; wrapperClass: string }> = []
  const activeCalls: Array<string | undefined> = []
  const origScrollIntoView = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function () {
    const wrapper = this.closest('[data-entry-id]')
    scrolled.push({ el: this, wrapperClass: wrapper?.className ?? '' })
  }
  try {
    await renderTimeline({
      entries,
      outlineScrollRequest: { entryId: '2', headingIndex: 1, tick: 1 },
      onActiveEntryChange: (id) => activeCalls.push(id),
    })
    assert.ok(scrolled.length > 0, '大纲定位触发 scrollIntoView')
    const last = scrolled[scrolled.length - 1]!
    assert.equal(last.el.tagName.toLowerCase(), 'h2', 'headingIndex=1 精确滚动到第二个标题（DOM 顺序保真）')
    assert.match(last.el.textContent ?? '', /二级目标/)
    assert.equal(/\btl-cv-/.test(last.wrapperClass), false, '滚动发生时目标行已解除渲染隔离（真实布局测量）')
    const wrapper = host!.querySelector<HTMLElement>('[data-entry-id="2"]')
    assert.match(wrapper?.className ?? '', /entry-highlighted/, '目标回合触发闪烁高亮')
    assert.ok(activeCalls.includes('2'), '定位后同步通知当前激活锚点')
  } finally {
    HTMLElement.prototype.scrollIntoView = origScrollIntoView
  }
})

// ---------------------------------------------------------------------------
// 5. DOM 交互：IntersectionObserver 阅读锚点追踪（无整列 rect 扫描）
// ---------------------------------------------------------------------------

interface FakeIO {
  callback: (entries: unknown[], observer: unknown) => void
  root: Element | null
  rootMargin: string
  targets: Set<Element>
  disconnected: boolean
  deliver(entries: Array<{ target: Element; isIntersecting: boolean }>): void
}

class FakeIntersectionObserver {
  static instances: FakeIO[] = []
  private readonly cb: (entries: unknown[], observer: unknown) => void
  readonly root: Element | null
  readonly rootMargin: string
  readonly targets = new Set<Element>()
  disconnected = false
  constructor(callback: (entries: unknown[], observer: unknown) => void, options?: IntersectionObserverInit) {
    this.cb = callback
    this.root = (options?.root ?? null) as Element | null
    this.rootMargin = options?.rootMargin ?? '0px'
    FakeIntersectionObserver.instances.push(this as unknown as FakeIO)
  }
  observe(target: Element): void { this.targets.add(target) }
  unobserve(target: Element): void { this.targets.delete(target) }
  disconnect(): void { this.disconnected = true; this.targets.clear() }
  deliver(entries: Array<{ target: Element; isIntersecting: boolean }>): void {
    this.cb(
      entries.map((entry) => ({ ...entry, intersectionRatio: entry.isIntersecting ? 1 : 0 })),
      this,
    )
  }
}

test('IO 路径：仅相交行参与激活计算，scroll 不触发任何 getBoundingClientRect', { timeout: 60_000 }, async () => {
  const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver
  try {
    const activeCalls: Array<string | undefined> = []
    await renderTimeline({
      entries: [humanEntry('1', '一'), humanEntry('2', '二'), humanEntry('3', '三'), humanEntry('4', '四')],
      onActiveEntryChange: (id) => activeCalls.push(id),
    })
    const io = FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1]
    assert.ok(io, '渲染后建立阅读锚点观察器')
    assert.ok(io.root?.classList.contains('timeline-scroll'), '以时间线滚动容器为 root')
    assert.match(io.rootMargin, /^0px 0px -\d+px 0px$/, '观察区域下缘收窄到激活基准线')
    assert.equal(io.targets.size, 4, '全部锚点行注册观察')

    const anchors = [...host!.querySelectorAll<HTMLElement>('[data-entry-id]')]
    // 前三行越过基准线 → 激活最后一个越过者（对齐 resolveActiveOutlineEntryId 语义）
    io.deliver([
      { target: anchors[0]!, isIntersecting: true },
      { target: anchors[1]!, isIntersecting: true },
      { target: anchors[2]!, isIntersecting: true },
      { target: anchors[3]!, isIntersecting: false },
    ])
    assert.equal(activeCalls[activeCalls.length - 1], '3')
    // 第四行也越过 → 激活推进
    io.deliver([{ target: anchors[3]!, isIntersecting: true }])
    assert.equal(activeCalls[activeCalls.length - 1], '4')
    // 上滚：第四行离开 → 激活回退
    io.deliver([{ target: anchors[3]!, isIntersecting: false }])
    assert.equal(activeCalls[activeCalls.length - 1], '3')

    // 滚动事件不得触发整列 rect 测量（IO 路径零 getBoundingClientRect）
    const origGBCR = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      throw new Error('IO 路径不应触发 getBoundingClientRect')
    }
    try {
      host!.querySelector('.timeline-scroll')!.dispatchEvent(new Event('scroll'))
    } finally {
      Element.prototype.getBoundingClientRect = origGBCR
    }
  } finally {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
  }
})

test('IO 路径：锚点集合变化（加载更早历史）时重绑观察器且旧实例断开', { timeout: 60_000 }, async () => {
  const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver
  try {
    const entries = [humanEntry('1', '一'), humanEntry('2', '二')]
    await renderTimeline({ entries })
    assert.equal(FakeIntersectionObserver.instances.length, 1)
    const first = FakeIntersectionObserver.instances[0]!

    // 模拟分页加载更早历史：锚点序列变化 → 重建观察器
    const conv = makeConv(10)
    const store = makeTestStore({
      conversations: [conv],
      conversationDetails: { 10: { ...conv, entries: [humanEntry('0', '更早'), ...entries] } },
    })
    const renderWith = (detailEntries: ConversationEntry[]): Promise<void> =>
      act(async () => {
        root!.render(
          e(
            HelmStoreContext.Provider,
            { value: store },
            e(ConversationTimeline, {
              conversation: conv,
              detailEntries,
              onRequestEdit: () => {},
              onActiveEntryChange: () => {},
            }),
          ),
        )
      })
    await renderWith([humanEntry('0', '更早'), ...entries])
    assert.equal(first.disconnected, true, '旧观察器已断开')
    const second = FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1]
    assert.notEqual(second, first)
    assert.equal(second!.targets.size, 3, '新观察器注册全部锚点')

    // 流式内容增长（锚点集合不变）不重绑：同锚点序列重渲染
    const before = FakeIntersectionObserver.instances.length
    await renderWith([humanEntry('0', '更早'), ...entries])
    assert.equal(FakeIntersectionObserver.instances.length, before, '锚点签名未变化时不重建观察器')
  } finally {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
  }
})

test('无 IO 环境退化路径：rAF 节流整列测量，语义同 resolveActiveOutlineEntryId', { timeout: 60_000 }, async () => {
  const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined
  const activeCalls: Array<string | undefined> = []
  try {
    await renderTimeline({
      entries: [humanEntry('1', '一'), humanEntry('2', '二'), humanEntry('3', '三')],
      onActiveEntryChange: (id) => activeCalls.push(id),
    })
    // happy-dom 中所有 rect top=0（均未越过基准线下方）→ 激活最后一个锚点
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    assert.equal(activeCalls[activeCalls.length - 1], '3')
    // 滚动事件再触发一次测量：结果不变（去重，不重复上报）
    const callsBefore = activeCalls.length
    host!.querySelector('.timeline-scroll')!.dispatchEvent(new Event('scroll'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    assert.equal(activeCalls.length, callsBefore)
  } finally {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
  }
})

// ---------------------------------------------------------------------------
// 6. 时间线归一化回归：隔离不改变 items 构建契约
// ---------------------------------------------------------------------------

test('buildTimelineItems 回归：隔离启用前后 items 锚点序列一致（大纲/搜索不受影响）', { timeout: 60_000 }, () => {
  const entries = [
    humanEntry('1', '第一问'),
    assistantEntry('2', '# A\n\n正文\n\n## B\n\n正文'),
    humanEntry('3', '第二问'),
    assistantEntry('4', '回答'),
  ]
  const items = buildTimelineItems(entries)
  assert.deepEqual(
    items.map((item) => timelineAnchorId(item)),
    ['1', '2', '3', '4'],
  )
})
