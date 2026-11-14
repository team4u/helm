import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationLive, ConversationSummary } from '@helm/protocol'
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
let manualRaf: { flush(cycles: number): void; restore(): void } | undefined
let origScrollIntoView: ((...args: unknown[]) => void) | undefined

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  targets = new Set<Element>()
  disconnected = false
  constructor(public callback: (entries: ResizeObserverEntry[]) => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe(target: Element): void {
    this.targets.add(target)
  }
  unobserve(target: Element): void {
    this.targets.delete(target)
  }
  disconnect(): void {
    this.disconnected = true
    this.targets.clear()
  }
  trigger(): void {
    this.callback([])
  }
}

const savedResizeObserver = globalThis.ResizeObserver
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  manualRaf?.restore()
  manualRaf = undefined
  FakeResizeObserver.instances = []
  if (origScrollIntoView !== undefined) {
    HTMLElement.prototype.scrollIntoView = origScrollIntoView as never as (...args: unknown[]) => void
    origScrollIntoView = undefined
  }
})

/** 手动 rAF 调度：回调仅在 flush 时执行（保证初始贴底窗口的帧循环完全可控）。 */
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
    id, title: '初始贴底会话', profileId: 'assistant', tags: [], ownedBy: 'human', cwd: '/tmp',
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

interface ClampedScrollMock {
  writes: number[]
  top(): number
  height(): number
  setTopSilent(v: number): void
  setHeight(v: number): void
  /** 视口尺寸变化（Composer 长高/收起）：按浏览器语义 clamp 并派发 scroll。 */
  setClientHeight(v: number): void
}

/**
 * 浏览器一致的滚动语义 mock：scrollTop 写入截断到 [0, scrollHeight-clientHeight]
 * 并同步派发 scroll（程序写入也会派发）；scrollHeight 收缩或 clientHeight 增大
 * （视口变大）使最大可滚位置下降时，把超界 scrollTop 夹紧到新底部并派发
 * scroll（布局位移），反向变化不产生位移。禁止可无限 scrollTop 的假语义。
 */
function setupClampedScroll(
  el: HTMLElement,
  initial: { scrollHeight: number; clientHeight: number; scrollTop: number },
): ClampedScrollMock {
  const writes: number[] = []
  let { scrollHeight, clientHeight, scrollTop } = initial
  const maxTop = (): number => Math.max(0, scrollHeight - clientHeight)
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
    set: (v: number) => {
      scrollHeight = v
      const clamped = Math.min(scrollTop, maxTop())
      if (clamped !== scrollTop) {
        scrollTop = clamped
        el.dispatchEvent(new Event('scroll'))
      }
    },
  })
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
    set: (v: number) => {
      clientHeight = v
      // 视口变大（如 Composer 收起）使最大可滚位置下降：浏览器夹紧超界
      // scrollTop 到新底部并派发 scroll；视口变小（Composer 长高）无位移。
      const clamped = Math.min(scrollTop, maxTop())
      if (clamped !== scrollTop) {
        scrollTop = clamped
        el.dispatchEvent(new Event('scroll'))
      }
    },
  })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      const next = Math.max(0, Math.min(v, maxTop()))
      if (next === scrollTop) return
      scrollTop = next
      writes.push(next)
      el.dispatchEvent(new Event('scroll'))
    },
  })
  return {
    writes,
    top: () => scrollTop,
    height: () => scrollHeight,
    setTopSilent: (v: number) => {
      scrollTop = Math.max(0, Math.min(v, maxTop()))
    },
    setHeight: (v: number) => {
      Reflect.set(el, 'scrollHeight', v)
    },
    setClientHeight: (v: number) => {
      Reflect.set(el, 'clientHeight', v)
    },
  }
}

function wheelUpEvent(): Event {
  const ev = new Event('wheel', { bubbles: true, cancelable: false })
  Object.defineProperty(ev, 'deltaY', { value: -120 })
  return ev
}

function stubScrollIntoView(): () => HTMLElement[] {
  const calls: HTMLElement[] = []
  const orig = HTMLElement.prototype.scrollIntoView
  origScrollIntoView = orig as never as (...args: unknown[]) => void
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    calls.push(this)
  }
  return () => calls
}

function innerResizeObserver(): FakeResizeObserver {
  const innerRo = FakeResizeObserver.instances.find((inst) =>
    Array.from(inst.targets).some((t) => t.classList.contains('timeline-inner')),
  )
  assert.ok(innerRo !== undefined, '内部容器的 ResizeObserver 必须存在')
  return innerRo!
}

interface RenderOpts {
  conv?: ConversationSummary
  entries?: ConversationEntry[]
  /** 会话实时流式增量（真实 stream props 路径，非写入计数）。 */
  live?: ConversationLive
  /** store 是否携带 conversationDetails（false = 历史尚未就绪的 loading mount）。 */
  detailsReady?: boolean
  nextCursor?: string
  highlightedEntry?: { conversationId: number; entryId: string } | null
  outlineScrollRequest?: OutlineScrollRequest | null
  strict?: boolean
}

async function renderTimeline(opts: RenderOpts = {}): Promise<void> {
  const conv = opts.conv ?? makeConv(10)
  const entries = opts.entries ?? [humanEntry('1', '问'), assistantEntry('2', '答')]
  const store = makeTestStore({
    conversations: [conv],
    ...(opts.detailsReady === false ? {} : { conversationDetails: { [conv.id]: { ...conv, entries, ...(opts.nextCursor ? { nextCursor: opts.nextCursor } : {}) } } }),
    ...(opts.highlightedEntry !== undefined ? { highlightedEntry: opts.highlightedEntry } : {}),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  const timeline = e(
    ConversationTimeline,
    {
      conversation: conv,
      detailEntries: entries,
      onRequestEdit: () => {},
      ...(opts.live !== undefined ? { live: opts.live } : {}),
      ...(opts.outlineScrollRequest !== undefined ? { outlineScrollRequest: opts.outlineScrollRequest } : {}),
    },
  )
  const wrapped = e(HelmStoreContext.Provider, { value: store }, timeline)
  await act(async () => {
    root = createRoot(host!)
    root.render(opts.strict === true ? e(React.StrictMode, null, wrapped) : wrapped)
  })
}

async function rerenderTimeline(opts: RenderOpts): Promise<void> {
  const conv = opts.conv ?? makeConv(10)
  const entries = opts.entries ?? [humanEntry('1', '问'), assistantEntry('2', '答')]
  const store = makeTestStore({
    conversations: [conv],
    ...(opts.detailsReady === false ? {} : { conversationDetails: { [conv.id]: { ...conv, entries, ...(opts.nextCursor ? { nextCursor: opts.nextCursor } : {}) } } }),
    ...(opts.highlightedEntry !== undefined ? { highlightedEntry: opts.highlightedEntry } : {}),
  })
  const timeline = e(
    ConversationTimeline,
    {
      conversation: conv,
      detailEntries: entries,
      onRequestEdit: () => {},
      ...(opts.live !== undefined ? { live: opts.live } : {}),
      ...(opts.outlineScrollRequest !== undefined ? { outlineScrollRequest: opts.outlineScrollRequest } : {}),
    },
  )
  const wrapped = e(HelmStoreContext.Provider, { value: store }, timeline)
  await act(async () => {
    root!.render(opts.strict === true ? e(React.StrictMode, null, wrapped) : wrapped)
  })
}

// ---------------------------------------------------------------------------
// 初始贴底校准窗口
// ---------------------------------------------------------------------------

test('idle 会话初始多次高度增长：一次性窗口真正跟底（StrictMode 重演不吞窗口）', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  await renderTimeline({ strict: true })

  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  assert.ok(scroller !== null, '滚动容器存在')
  // 估高转真实布局：初始总高 2000，视口 800（真实贴底位置 1200）
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })

  // 首个平台：窗口把初始位置校正到真实底部
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200], '初始校正到 scrollHeight-clientHeight')

  // 第一次增长（估高纠正 +200）→ 窗口继续追赶
  mock.setHeight(2200)
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200, 1400], '第一次增长后跟底到 1400')

  // 第二次增长 → 仍能继续追赶（连续高度变化不使窗口失效）
  mock.setHeight(2400)
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200, 1400, 1600], '第二次增长后跟底到 1600')
  assert.equal(mock.top(), 1600, '最终停在真实底部')
})

test('数据延迟就绪：loading mount 不启动窗口（不空转耗尽），就绪后正常启动', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  await renderTimeline({ detailsReady: false, entries: [] })

  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })

  // loading 期 flush 超过窗口总帧数硬上界（300）：若窗口在空白 mount 已启动，
  // 此刻必已耗尽死亡；就绪后的真实校准将永不发生（回归哨兵）。
  raf.flush(320)
  assert.equal(mock.writes.length, 0, 'loading mount 阶段无任何贴底写入')

  // 历史就绪：fingerprint/detailsReady 变化驱动 effect 重启，窗口此时才启动
  await rerenderTimeline({ entries: [humanEntry('1', '问'), assistantEntry('2', '答')] })
  assert.deepEqual(mock.writes, [1200], '就绪后初始置底（fingerprint effect 直写，浏览器截断）')

  mock.setHeight(2200)
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200, 1400], '就绪后启动的窗口继续跟底')
})

test('物理输入先于 scroll 到达：初始窗口立即取消并释放贴底，RO 不得拉回；rerender 不重启', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  await renderTimeline({ conv: makeConv(10, { status: 'working' }) })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200], '窗口已就位底部')

  // 用户 wheel 上滚（scroll 事件尚未派发）→ 窗口同步取消、贴底同步释放
  scroller.dispatchEvent(wheelUpEvent())
  mock.setTopSilent(960)
  mock.setHeight(2500)
  // working 会话 RO 跟底先于 scroll 到达：不得把已上滚的位置贴回底部
  innerResizeObserver().trigger()
  raf.flush(10)
  assert.equal(mock.top(), 960, '用户上滚位置保持，gap=740 不被清零')
  assert.deepEqual(mock.writes, [1200], '取消后无任何追底写入')

  // 状态变化 rerender（追加结算回答）不重启已消费的窗口
  await rerenderTimeline({
    conv: makeConv(10, { status: 'working' }),
    entries: [humanEntry('1', '问'), assistantEntry('2', '答'), assistantEntry('3', '新答案')],
  })
  mock.setHeight(3000)
  raf.flush(10)
  assert.deepEqual(mock.writes, [1200], 'rerender/加载/状态变化均不重启已消费窗口')
  assert.equal(mock.top(), 960, '位置保持用户上滚处')
})

test('布局收缩（浏览器 clamp 下调 scrollTop + scroll 事件）不误取消初始跟底，随后增长仍被追赶', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  await renderTimeline()
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200])

  // 总高收缩 2000→1800：浏览器把贴底的 scrollTop 下调到 1000 并派发 scroll。
  // 该 top 下降是布局位移而非用户手势，窗口期内不得据此释放贴底。
  mock.setHeight(1800)
  assert.equal(mock.top(), 1000, '浏览器 clamp 下调位置')
  raf.flush(3)
  assert.equal(mock.top(), 1000, '距底为 0，无需校正也不被放弃')

  // 随后增长重新拉开 gap：仍处于贴底语义的窗口继续追赶
  mock.setHeight(2000)
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200, 1200], '增长后窗口仍把位置追回底部')
  assert.equal(mock.top(), 1200)
})

test('窗口稳定收敛后：idle 会话恢复原有保护，不再追底（RO 亦不写入）', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  await renderTimeline()
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200])

  // 静默现望期结束（>48 个稳定帧）：窗口自然收敛
  raf.flush(60)
  assert.equal(mock.top(), 1200)

  // 收敛后再增长（用户可能已开始阅读历史）：窗口已消费、idle RO 保护生效
  mock.setHeight(3000)
  raf.flush(20)
  assert.deepEqual(mock.writes, [1200], '窗口结束后不再追底')
  innerResizeObserver().trigger()
  assert.deepEqual(mock.writes, [1200], 'idle RO 保护不受影响')
  assert.equal(mock.top(), 1200, '位置保持，gap=1000 保留给用户')
})

test('硬上界：连续高度增长的校正次数封顶，不无限 rAF', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  await renderTimeline()
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })
  raf.flush(4)
  assert.equal(mock.writes.length, 1, '首次校正')

  // 持续增长 12 轮（每轮 5 帧一个平台）：校正总数封顶 8 次后窗口结束
  for (let i = 1; i <= 12; i++) {
    mock.setHeight(2000 + 200 * i)
    raf.flush(5)
  }
  assert.equal(mock.writes.length, 8, '校正次数硬上界 8（含首次）')

  // 封顶结束后继续增长：不再有任何写入
  mock.setHeight(6000)
  raf.flush(10)
  assert.equal(mock.writes.length, 8, '上界耗尽后窗口不再动作')
})

test('合法空会话：窗口正常收敛退出，无写入、不空转', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  await renderTimeline({ entries: [], detailsReady: true })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 500, clientHeight: 800, scrollTop: 0 })

  raf.flush(80)
  assert.equal(mock.writes.length, 0, '无可滚内容，无任何写入')
  assert.equal(mock.top(), 0)
  // 窗口已自然结束：后续高度变化不触发追底
  mock.setHeight(900)
  raf.flush(10)
  assert.equal(mock.writes.length, 0)
})

// ---------------------------------------------------------------------------
// 显式定位优先（含首次已有 human entry 与 StrictMode）
// ---------------------------------------------------------------------------

test('搜索高亮优先（StrictMode）：重挂后继续居中校准，普通 rerender 不重复定位', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  const scrollIntoViewCalls = stubScrollIntoView()
  await renderTimeline({
    strict: true,
    highlightedEntry: { conversationId: 10, entryId: '2' },
  })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })

  const calls = scrollIntoViewCalls()
  assert.ok(calls.length >= 2, 'StrictMode 重挂重新武装已被 cleanup 取消的搜索校准')
  assert.equal(calls[0]!.dataset.entryId, '2')
  assert.equal(mock.writes.length, 0, '首次 human 记录不抢走定位')

  const row = host!.querySelector<HTMLElement>('[data-entry-id="2"]')!
  scroller.getBoundingClientRect = () => ({ top: 0, height: 800 } as DOMRect)
  row.getBoundingClientRect = () => ({ top: 500 - mock.top(), height: 200 } as DOMRect)
  raf.flush(4)
  assert.equal(mock.top(), 200, '重挂后仍运行校准，将目标中心对齐视口中心')
  assert.deepEqual(mock.writes, [200], '只做目标对齐，不写入底部 1200')
  raf.flush(60)

  const callCount = calls.length
  await rerenderTimeline({ strict: true, highlightedEntry: { conversationId: 10, entryId: '2' } })
  assert.equal(calls.length, callCount, '同一定位目标的普通 rerender 不重复定位')
  mock.setHeight(2500)
  raf.flush(10)
  assert.deepEqual(mock.writes, [200], '显式定位已消费初始窗口，不再追底')
  assert.match(row.className, /entry-highlighted/, '高亮类存在')
})

test('大纲定位优先（StrictMode）：定位目的地不被初始贴底抢走，窗口不启动', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  const scrollIntoViewCalls = stubScrollIntoView()
  await renderTimeline({
    strict: true,
    entries: [humanEntry('1', '问'), assistantEntry('2', '# 一级\n正文A\n## 二级目标\n正文B')],
    outlineScrollRequest: { entryId: '2', headingIndex: 1, tick: 1 },
  })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })

  const calls = scrollIntoViewCalls()
  assert.ok(calls.length >= 1, '大纲定位触发 scrollIntoView')
  const last = calls[calls.length - 1]!
  assert.equal(last.tagName.toLowerCase(), 'h2', '定位到 headingIndex=1 的二级标题')
  assert.match(last.textContent ?? '', /二级目标/)

  assert.equal(mock.writes.length, 0, '无任何初始置底写入抢走大纲定位')
  raf.flush(30)
  mock.setHeight(2500)
  raf.flush(10)
  assert.equal(mock.writes.length, 0, '窗口未启动：后续高度变化不追底')
  assert.equal(mock.top(), 0)
})

test('键盘激活加载更早消息：主动取消初始校准，历史补偿完成后不再被拉回', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  await renderTimeline({ nextCursor: 'older' })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })
  raf.flush(4)
  mock.setTopSilent(300)

  const button = Array.from(scroller.querySelectorAll('button')).find((el) => el.textContent === '加载更早的消息')!
  assert.ok(button, '历史分页按钮存在')
  await act(async () => {
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    button.click()
  })
  raf.flush(2)
  assert.equal(mock.top(), 300, '分页后的历史位置补偿保留阅读位置')
  mock.setHeight(2600)
  raf.flush(20)
  assert.equal(mock.top(), 300, '无 pointerdown 的键盘激活也能取消初始 rAF 追底')
})

test('空会话首次发送：即使曾向上滚轮，新增 human 输入仍恢复工作态跟底', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  await renderTimeline({ entries: [] })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 500, clientHeight: 800, scrollTop: 0 })
  scroller.dispatchEvent(wheelUpEvent())
  mock.setHeight(2000)
  await rerenderTimeline({ conv: makeConv(10, { status: 'working' }) })
  assert.equal(mock.top(), 1200, '历史已就绪后的首条 human 是新增输入，重新贴底')
  mock.setHeight(2200)
  innerResizeObserver().trigger()
  raf.flush(10)
  assert.equal(mock.top(), 1400, '工作态后续增长继续跟随')
})

// ---------------------------------------------------------------------------
// 生命周期清理与换会话
// ---------------------------------------------------------------------------

test('卸载取消 rAF 与监听：卸载后 flush 无任何残留写入', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  await renderTimeline()
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200])

  act(() => root!.unmount())
  root = undefined
  mock.setHeight(3000)
  raf.flush(10)
  assert.deepEqual(mock.writes, [1200], '卸载后窗口 rAF 已取消，无残留写入')
})

test('换会话（同实例复用）：旧窗口取消，新会话获得全新的一次性窗口', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  await renderTimeline({ conv: makeConv(10) })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200])

  // 切换到会话 11（App 按 id 重挂载；此处同实例复用路径亦须正确）。
  // fingerprint 直写与当前位置相同（1200=最大可滚）时浏览器不发 scroll，
  // mock 与浏览器一致地不记录无变化写入。
  await rerenderTimeline({
    conv: makeConv(11),
    entries: [humanEntry('11', '问11'), assistantEntry('12', '答11')],
  })
  assert.deepEqual(mock.writes, [1200], '新会话初始置底写入为 no-op（位置已在底部）')

  // 新会话窗口在途：增长被追赶（若旧 cleanup 误消费一次性资格，此处失败）
  mock.setHeight(2400)
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200, 1600], '新会话窗口正常跟底')
  assert.equal(mock.top(), 1600)
})

// ---------------------------------------------------------------------------
// 续聊跟底回归（fix/followup-scroll）：初始窗口结束后的 clamp 与流式跟随
// ---------------------------------------------------------------------------

test('A/B/A 换会话且初始窗口结束后续聊：新增 human 恢复跟底，Composer 收起的 clamp 下调不释放贴底，流式 live 继续跟随', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  const entriesA = [humanEntry('1', '问'), assistantEntry('2', '答')]
  await renderTimeline({ conv: makeConv(10), entries: entriesA })
  const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })
  raf.flush(4)
  assert.deepEqual(mock.writes, [1200], '会话 A 初始置底')
  raf.flush(60)

  // A/B/A：切到 B 再切回 A（App 按 key 重挂的等价同实例路径），每次窗口均自然收敛
  await rerenderTimeline({ conv: makeConv(11), entries: [humanEntry('11', '问11'), assistantEntry('12', '答11')] })
  raf.flush(4)
  raf.flush(60)
  await rerenderTimeline({ conv: makeConv(10), entries: entriesA })
  raf.flush(4)
  raf.flush(60)
  // A 的窗口也已结束：后续跟底只能依赖贴底状态机（lastHuman 恢复）与 RO，
  // 不能靠一次性初始窗口掩盖。

  // 用户上滚脱离：证明后续贴底确由新增 human 恢复，而非残留状态
  scroller.dispatchEvent(wheelUpEvent())
  mock.setTopSilent(1000)
  scroller.dispatchEvent(new Event('scroll'))
  assert.equal(mock.writes.length, 1, '用户接管后无程序写入')

  // Composer 多行使视口缩小 800->500（无位移、无 scroll）
  mock.setClientHeight(500)

  // 新增 human 输入且 working：lastHuman 变化恢复贴底，写入被 clamp 到 1500
  await rerenderTimeline({
    conv: makeConv(10, { status: 'working' }),
    entries: [...entriesA, humanEntry('3', '追问')],
  })
  assert.equal(mock.top(), 1500, '新增 human 恢复贴底（2000-500）')

  // Composer 清空收起使视口恢复 500->800：浏览器把 1500 clamp 到 1200 并派发
  // scroll（先于任何 RO 回调）。该下降是布局位移，不得释放贴底。
  mock.setClientHeight(800)
  assert.equal(mock.top(), 1200, 'clamp 到 1200（距底 0）')

  // 下一回合首 token：内容增长（此步无 rerender/fingerprint 变化）只能依赖 RO
  // 跟底；若 clamp 被误判为用户上翻则从此永远追不上
  mock.setHeight(2600)
  innerResizeObserver().trigger()
  assert.equal(mock.top(), 1800, 'clamp 下调后贴底保留，RO 继续跟底（2600-800）')

  // 后续流式分段（真实 live props）持续跟随
  await rerenderTimeline({
    conv: makeConv(10, { status: 'working' }),
    entries: [...entriesA, humanEntry('3', '追问')],
    live: { conversationId: 10, text: '流式回答第一段', tools: [], updatedAt: 5 },
  })
  mock.setHeight(2800)
  innerResizeObserver().trigger()
  assert.equal(mock.top(), 2000, 'live 流式第一段跟底（2800-800）')

  await rerenderTimeline({
    conv: makeConv(10, { status: 'working' }),
    entries: [...entriesA, humanEntry('3', '追问')],
    live: { conversationId: 10, text: '流式回答第一段，继续输出更多内容', tools: [], updatedAt: 6 },
  })
  mock.setHeight(3000)
  innerResizeObserver().trigger()
  assert.equal(mock.top(), 2200, 'live 流式后续段持续贴底（3000-800，gap=0）')
})
