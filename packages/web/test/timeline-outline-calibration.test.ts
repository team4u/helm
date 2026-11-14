import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationSummary } from '@helm/protocol'
import { makeTestStore } from './helpers/store.js'
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
let origScrollIntoView: ((...args: unknown[]) => void) | undefined
let origGBCR: (() => DOMRect) | undefined
let manualRaf: { flush(cycles: number): void; restore(): void } | undefined

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  manualRaf?.restore()
  manualRaf = undefined
  if (origScrollIntoView !== undefined) {
    HTMLElement.prototype.scrollIntoView = origScrollIntoView as never as (...args: unknown[]) => void
    origScrollIntoView = undefined
  }
  if (origGBCR !== undefined) {
    Element.prototype.getBoundingClientRect = origGBCR as never as (() => DOMRect)
    origGBCR = undefined
  }
})

/** 手动 rAF 调度：回调仅在 flush 时执行（happy-dom rAF 无节流，真实时钟不可控）。 */
function installManualRaf(): { flush(cycles: number): void; restore(): void } {
  const origRaf = globalThis.requestAnimationFrame
  const origCancel = globalThis.cancelAnimationFrame
  const queue = new Map<number, FrameRequestCallback>()
  let nextId = 1
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = nextId++
    queue.set(id, cb)
    return id
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number): void => {
    queue.delete(id)
  }) as typeof cancelAnimationFrame
  const handle = {
    flush(cycles: number): void {
      for (let i = 0; i < cycles; i++) {
        if (queue.size === 0) return
        const callbacks = [...queue.values()]
        queue.clear()
        for (const cb of callbacks) cb(performance.now())
      }
    },
    restore(): void {
      globalThis.requestAnimationFrame = origRaf
      globalThis.cancelAnimationFrame = origCancel
      queue.clear()
    },
  }
  manualRaf = handle
  return handle
}

function makeConv(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, title: '校准会话', profileId: 'assistant', tags: [], ownedBy: 'human', cwd: '/tmp',
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

/** 拦截滚动容器 scrollTop（记录写入，模拟校正增量）。 */
function interceptScrollTop(el: HTMLElement): number[] {
  const writes: number[] = []
  let value = 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      value = next
      writes.push(next)
    },
  })
  return writes
}

/**
 * 目标 rect 随 scrollTop 写入联动（top = base - scroller.scrollTop）：校正写入
 * 后偏差归零，与真实浏览器几何一致，防止静态 stub 导致校准器反复重试。
 * 返回可增删的目标表（换会话测试需要为新旧行分别挂不同 base）。
 */
function installDynamicRects(scroller: HTMLElement): Map<Element, () => number> {
  const map = new Map<Element, () => number>()
  const orig = Element.prototype.getBoundingClientRect
  origGBCR = orig as never as (() => DOMRect)
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const getBase = map.get(this)
    if (getBase !== undefined) {
      const top = getBase() - scroller.scrollTop
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    }
    return orig.call(this)
  }
  return map
}

function stubScrollIntoView(): () => number {
  let calls = 0
  const orig = HTMLElement.prototype.scrollIntoView
  origScrollIntoView = orig as never as (...args: unknown[]) => void
  HTMLElement.prototype.scrollIntoView = function () {
    calls += 1
  }
  return () => calls
}

async function renderTimeline(opts: {
  entries: ConversationEntry[]
  convId?: number
  outlineScrollRequest?: OutlineScrollRequest | null
  highlightedEntry?: { conversationId: number; entryId: string } | null
}): Promise<void> {
  const conv = makeConv(opts.convId ?? 10)
  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { [conv.id]: { ...conv, entries: opts.entries } },
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
          ...(opts.outlineScrollRequest !== undefined ? { outlineScrollRequest: opts.outlineScrollRequest } : {}),
        }),
      ),
    )
  })
}

async function rerenderWith(opts: {
  entries: ConversationEntry[]
  convId?: number
  outlineScrollRequest?: OutlineScrollRequest | null
  highlightedEntry?: { conversationId: number; entryId: string } | null
}): Promise<void> {
  const conv = makeConv(opts.convId ?? 10)
  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { [conv.id]: { ...conv, entries: opts.entries } },
    ...(opts.highlightedEntry !== undefined ? { highlightedEntry: opts.highlightedEntry } : {}),
  })
  await act(async () => {
    root!.render(
      e(
        HelmStoreContext.Provider,
        { value: store },
        e(ConversationTimeline, {
          conversation: conv,
          detailEntries: opts.entries,
          onRequestEdit: () => {},
          ...(opts.outlineScrollRequest !== undefined ? { outlineScrollRequest: opts.outlineScrollRequest } : {}),
        }),
      ),
    )
  })
}

const HEADING_ENTRIES = [
  humanEntry('1', '问'),
  assistantEntry('2', '# 一级\n正文A\n## 二级目标\n正文B'),
]
const REQUEST: OutlineScrollRequest = { entryId: '2', headingIndex: 1, tick: 1 }
const SETTLE_WAIT_MS = 500

async function waitForSettle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS)) })
}

function correctionWrites(writes: number[]): number[] {
  // 过滤挂载贴底写入（happy-dom scrollHeight=0 → 写入 0）
  return writes.filter((w) => w !== 0)
}

test('平台判定后一次校正：静态残余偏差（回归现场 -49.625px）', { timeout: 60_000 }, async () => {
  stubScrollIntoView()
  await renderTimeline({ entries: HEADING_ENTRIES })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const heading = host!.querySelector<HTMLElement>('[data-entry-id="2"] h2')!
  assert.ok(scroller !== null && heading !== null, '滚动容器与目标标题存在')
  const base = -49.625
  installDynamicRects(scroller).set(heading, () => base)
  const writes = interceptScrollTop(scroller)

  await rerenderWith({ entries: HEADING_ENTRIES, outlineScrollRequest: REQUEST })
  await waitForSettle()
  assert.deepEqual(correctionWrites(writes), [-49.625], '滚动稳定后按残余偏差一次校正并收敛')

  // 收敛后静默期内不再出现新写入
  const countAfter = writes.length
  await waitForSettle()
  assert.equal(writes.length, countAfter, '对齐后不重复校正')
})

test('晚发位移二次校正：首次平台校正后目标再次偏移仍被纠正', { timeout: 60_000 }, async () => {
  stubScrollIntoView()
  await renderTimeline({ entries: HEADING_ENTRIES })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const heading = host!.querySelector<HTMLElement>('[data-entry-id="2"] h2')!
  const writes = interceptScrollTop(scroller)
  // base 先为 -20（首个平台）；首次校正写入 -20 后切到 -49.625，
  // 模拟收敛后估高转真实高度的晚发位移（happy-dom rAF 无节流，
  // 以写入而非真实时钟触发保证确定性）
  let shifted = false
  installDynamicRects(scroller).set(heading, () => {
    if (!shifted && writes.includes(-20)) shifted = true
    return shifted ? -49.625 : -20
  })

  await rerenderWith({ entries: HEADING_ENTRIES, outlineScrollRequest: REQUEST })
  await waitForSettle()
  assert.deepEqual(correctionWrites(writes), [-20, -49.625], '首个平台校正 -20，晚发位移后再次校正到 -49.625')
})

test('用户主动滚动取消：绝不与用户竞争滚动位置', { timeout: 60_000 }, async () => {
  stubScrollIntoView()
  await renderTimeline({ entries: HEADING_ENTRIES })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const heading = host!.querySelector<HTMLElement>('[data-entry-id="2"] h2')!
  const writes = interceptScrollTop(scroller)
  // 偏差逐帧变化（模拟平滑滚动动画进行中）：平台永不出现，校正不会执行
  let drift = 0
  installDynamicRects(scroller).set(heading, () => -20 - (drift += 3))

  await rerenderWith({ entries: HEADING_ENTRIES, outlineScrollRequest: REQUEST })
  act(() => { scroller.dispatchEvent(new Event('wheel', { bubbles: true })) })
  await waitForSettle()
  assert.deepEqual(correctionWrites(writes), [], '用户输入后校准取消，无任何校正写入')
})

test('下一定位请求作废在途校准：仅当前代执行校正', { timeout: 60_000 }, async () => {
  stubScrollIntoView()
  await renderTimeline({ entries: HEADING_ENTRIES })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const heading = host!.querySelector<HTMLElement>('[data-entry-id="2"] h2')!
  installDynamicRects(scroller).set(heading, () => -49.625)
  const writes = interceptScrollTop(scroller)

  await rerenderWith({ entries: HEADING_ENTRIES, outlineScrollRequest: REQUEST })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })
  // 校准在途时新请求到达：旧代作废；新代面对已对齐几何不再写入
  await rerenderWith({ entries: HEADING_ENTRIES, outlineScrollRequest: { ...REQUEST, tick: 2 } })
  await waitForSettle()
  assert.equal(correctionWrites(writes).length, 1, '仅首个代的校准执行一次校正')
})

test('目标尚未加载时不消费 tick：请求保留，目标加载 commit 后处理', { timeout: 60_000 }, async () => {
  const calls = stubScrollIntoView()
  const partial = [humanEntry('1', '问')]
  await renderTimeline({ entries: partial, outlineScrollRequest: REQUEST })
  assert.equal(calls(), 0, '目标不存在时不滚动')
  assert.equal(host!.querySelector('.entry-highlighted'), null, '目标不存在时不高亮')

  // 同一 tick 请求保留：历史分页加载出目标条目后处理
  await rerenderWith({ entries: HEADING_ENTRIES, outlineScrollRequest: REQUEST })
  assert.equal(calls(), 1, '目标加载 commit 后执行定位')
  assert.match(host!.querySelector<HTMLElement>('[data-entry-id="2"]')!.className, /entry-highlighted/)

  // 处理完成后 tick 已消费：重复渲染不再次滚动
  await rerenderWith({ entries: HEADING_ENTRIES, outlineScrollRequest: REQUEST })
  assert.equal(calls(), 1, 'tick 消费后不重复处理')
})

test('搜索高亮定位复用校准：按目标中心线对容器中心一次校正', { timeout: 60_000 }, async () => {
  stubScrollIntoView()
  await renderTimeline({ entries: HEADING_ENTRIES })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const targetRow = host!.querySelector<HTMLElement>('[data-entry-id="1"]')!
  assert.ok(scroller !== null && targetRow !== null, '滚动容器与搜索目标行存在')
  // 目标行 top=-60 height=40（中心 -40）；容器 top=0 height=800（中心 400）→ 偏差 -440
  const orig = Element.prototype.getBoundingClientRect
  origGBCR = orig as never as (() => DOMRect)
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this === targetRow) {
      const top = -60 - scroller.scrollTop
      return { top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    }
    if (this === scroller) {
      return { top: 0, bottom: 800, left: 0, right: 0, width: 0, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    }
    return orig.call(this)
  }
  const writes = interceptScrollTop(scroller)

  await rerenderWith({ entries: HEADING_ENTRIES, highlightedEntry: { conversationId: 10, entryId: '1' } })
  await waitForSettle()
  assert.deepEqual(correctionWrites(writes), [-440], '居中对齐按目标中心线偏差一次校正')
})

test('初始挂载即携带搜索高亮：校准不被生命周期 effect 误杀，晚发位移仍被校正', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  stubScrollIntoView()
  // 挂载时 store.highlightedEntry 已有值：ref callback 在 commit 阶段先于
  // passive effects 启动校准，随后的 [conversation.id] effect 不得将其取消
  await renderTimeline({ entries: HEADING_ENTRIES, highlightedEntry: { conversationId: 10, entryId: '2' } })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const row = host!.querySelector<HTMLElement>('[data-entry-id="2"]')!
  assert.ok(scroller !== null && row !== null, '滚动容器与目标行存在')
  const writes = interceptScrollTop(scroller)
  let shifted = false
  installDynamicRects(scroller).set(row, () => {
    if (!shifted && writes.includes(-20)) shifted = true
    return shifted ? -49.625 : -20
  })

  raf.flush(4)
  assert.deepEqual(correctionWrites(writes), [-20], '首个平台校正 -20（初始校准存活）')
  raf.flush(6)
  assert.deepEqual(correctionWrites(writes), [-20, -49.625], '晚发位移后再次校正到 -49.625')
  const settled = writes.length
  raf.flush(80)
  assert.equal(writes.length, settled, '对齐后静默期内不再写入')
})

test('换会话：旧会话在途校准被取消，新会话 ref 启动的校准不被误杀', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  stubScrollIntoView()
  await renderTimeline({ entries: HEADING_ENTRIES, highlightedEntry: { conversationId: 10, entryId: '2' } })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const row = host!.querySelector<HTMLElement>('[data-entry-id="2"]')!
  const writes = interceptScrollTop(scroller)
  // 旧会话目标：静态未对齐；若未被取消，后续 flush 必然写出 -30
  const rects = installDynamicRects(scroller)
  rects.set(row, () => -30)
  raf.flush(2)
  assert.deepEqual(correctionWrites(writes), [], '旧校准在途（未到平台，未写入）')

  // 换会话：commit 阶段新 ref 先启动校准 B，随后旧 [conversation.id] cleanup
  // 只取消属于旧会话的校准 A（不误杀 B）
  await rerenderWith({
    convId: 11,
    entries: HEADING_ENTRIES,
    highlightedEntry: { conversationId: 11, entryId: '2' },
  })
  const newRow = host!.querySelector<HTMLElement>('[data-entry-id="2"]')!
  rects.set(newRow, () => -49.625)
  raf.flush(8)
  assert.deepEqual(correctionWrites(writes), [-49.625], '仅新会话校准执行校正；旧会话校准已被立即取消（无 -30 写入）')
  const settled = writes.length
  raf.flush(80)
  assert.equal(writes.length, settled, '新校准对齐后静默，不再写入')
})
