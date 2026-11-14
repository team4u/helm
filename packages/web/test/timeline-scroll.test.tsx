import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationLive, ConversationSummary } from '@helm/protocol'
import { makeTestStore } from './helpers/store.js'
import { ConversationTimeline } from '../src/conversation/ConversationTimeline.js'

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
})

/** 手动 rAF 调度：回调仅在 flush 时执行（保证初始贴底窗口的帧循环完全可控、可耗尽）。 */
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
    id,
    title: '滚动测试会话',
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 2,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

function humanEntry(id: string, text: string): ConversationEntry {
  return { id, kind: 'helm.input', data: { id: `in-${id}`, text, origin: 'human' }, createdAt: 1000 }
}

function assistantEntry(id: string, text: string): ConversationEntry {
  return { id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }] }] }
}

interface ClampedScrollMock {
  /** 程序化写入 scrollTop 的记录（浏览器按 scrollHeight-clientHeight 截断）。 */
  writes: number[]
  top(): number
  height(): number
  /** 同帧静默更新位置：scroll 事件尚未派发（模拟真实浏览器的异步 scroll）。 */
  setTopSilent(v: number): void
  setHeight(v: number): void
  /** 视口尺寸变化（Composer 长高/收起）：按浏览器语义 clamp 并派发 scroll。 */
  setClientHeight(v: number): void
}

/**
 * 浏览器一致的滚动语义 mock：scrollTop 写入截断到 [0, scrollHeight-clientHeight]
 * 并派发 scroll；scrollHeight 收缩或 clientHeight 增大（视口变大）使最大可滚位置
 * 下降时，把超界 scrollTop 夹紧到新底部并派发 scroll（布局位移，非程序写入）；
 * 反向变化不产生位移。绝不允许无限 scrollTop 的假语义。
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

async function renderTimeline(conv: ConversationSummary, entries: ConversationEntry[]): Promise<HTMLElement> {
  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { [conv.id]: { ...conv, entries } },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      e(
        HelmStoreContext.Provider,
        { value: store },
        e(ConversationTimeline, {
          conversation: conv,
          detailEntries: entries,
          onRequestEdit: () => {},
        }),
      ),
    )
  })
  return host.querySelector<HTMLElement>('.timeline-scroll')!
}

interface RerenderOpts {
  conv?: ConversationSummary
  entries?: ConversationEntry[]
  live?: ConversationLive
}

/** 同实例换 props/换会话 rerender（不重挂 DOM，滚动容器与 refs 复用）。 */
async function rerenderTimeline(opts: RerenderOpts = {}): Promise<void> {
  const conv = opts.conv ?? makeConv(10, { status: 'working' })
  const entries = opts.entries ?? [humanEntry('1', '问'), assistantEntry('2', '答')]
  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { [conv.id]: { ...conv, entries } },
  })
  await act(async () => {
    root!.render(
      e(
        HelmStoreContext.Provider,
        { value: store },
        e(ConversationTimeline, {
          conversation: conv,
          detailEntries: entries,
          onRequestEdit: () => {},
          ...(opts.live !== undefined ? { live: opts.live } : {}),
        }),
      ),
    )
  })
}

function innerResizeObserver(): FakeResizeObserver {
  const innerRo = FakeResizeObserver.instances.find((inst) =>
    Array.from(inst.targets).some((t) => t.classList.contains('timeline-inner')),
  )
  assert.ok(innerRo !== undefined, '内部容器的 ResizeObserver 必须存在')
  return innerRo!
}

test('已结算静止会话（idle）：用户上滚后 ResizeObserver 触发时绝不强行将 scrollTop 置底', { timeout: 60_000 }, async () => {
  const scroller = await renderTimeline(makeConv(10), [humanEntry('1', '问'), assistantEntry('2', '答')])
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 1200 })

  // 用户上滚意图先以物理输入到达（wheel），再发生实际滚动
  scroller.dispatchEvent(wheelUpEvent())
  mock.setTopSilent(600)
  scroller.dispatchEvent(new Event('scroll'))

  // 内部容器由于 content-visibility 估高测量或折叠展开导致尺寸变化，触发 ResizeObserver
  innerResizeObserver().trigger()

  // 静止会话绝不应产生新的 scrollTop 置底写入
  assert.equal(mock.writes.length, 0, '静止会话在尺寸变化时不应触发置底写入')
  assert.equal(mock.top(), 600, 'scrollTop 应保持在 600，不被弹回底部')
})

test('主动上滚微小位移（即使在离底 80px 死区内）：物理输入即刻脱离贴底，不被下一次 Resize 弹回到底端', { timeout: 60_000 }, async () => {
  const scroller = await renderTimeline(makeConv(10, { status: 'working' }), [humanEntry('1', '问'), assistantEntry('2', '答')])
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 1200 })

  // 初始在底端（scrollTop = 1200 = max）
  scroller.dispatchEvent(new Event('scroll'))

  // 用户先 wheel 上滚（物理输入同步释放贴底），随后仅向上微滚 15px
  // （scrollTop 变成 1185，距离底部 15px，属于原 <= 80px 死区）
  scroller.dispatchEvent(wheelUpEvent())
  mock.setTopSilent(1185)
  scroller.dispatchEvent(new Event('scroll'))

  // 模拟流式追加或高度变动
  mock.setHeight(2050)
  innerResizeObserver().trigger()

  // 已经脱离贴底，不应被强行写回底部
  assert.equal(mock.writes.length, 0, '主动上滚微调后不应有任何置底写入')
  assert.equal(mock.top(), 1185, '主动上滚微调后已脱离贴底，不应被弹回底部')
})

test('活跃生成态（working）在底端贴底时：随高度变动自动跟随到底端（浏览器一致截断）', { timeout: 60_000 }, async () => {
  const scroller = await renderTimeline(makeConv(10, { status: 'working' }), [humanEntry('1', '问'), assistantEntry('2', '答')])
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 1200 })

  // 保持在底端
  scroller.dispatchEvent(new Event('scroll'))

  // 流式生成新增高度到 2100：RO 贴底写入被浏览器截断到 2100-800=1300
  mock.setHeight(2100)
  innerResizeObserver().trigger()

  assert.equal(mock.top(), 1300, '贴底态且会话处于 working 时，随高度变动自动跟底（截断到最大可滚位置）')
})

test('working 竞态回归：wheel 上滚后 RO 先于 scroll 事件到达时不得把位置贴回底部', { timeout: 60_000 }, async () => {
  const scroller = await renderTimeline(makeConv(10, { status: 'working' }), [humanEntry('1', '问'), assistantEntry('2', '答')])
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 1200 })
  const ro = innerResizeObserver()

  // 竞态时序：同一 JS 任务内 wheel 上滚 -> 位置下移（scroll 事件尚未派发）->
  // 追加 500px 高度 -> RO 立刻触发（仍先于 scroll 事件）
  scroller.dispatchEvent(wheelUpEvent())
  mock.setTopSilent(960)
  mock.setHeight(2500)
  ro.trigger()

  // wheel 监听已同步释放贴底：RO 不得写回底部，gap 保持 2500-960-800=740
  assert.equal(mock.writes.length, 0, 'RO 早于 scroll 到达时不应置底写入')
  assert.equal(mock.top(), 960, '用户已上滚的位置不被 RO 拉回底部')

  // 迟到的 scroll 事件到达后维持不贴底
  scroller.dispatchEvent(new Event('scroll'))
  assert.equal(mock.top(), 960)

  // 用户滚回底部恢复跟随：手动滚到底（写入 1700=2500-800）触发贴底，再增长仍跟随
  scroller.scrollTop = 1700
  assert.equal(mock.top(), 1700, '滚回底部恢复贴底')
  mock.setHeight(2600)
  ro.trigger()
  assert.equal(mock.top(), 1800, '恢复贴底后 working 跟底仍正常（截断到 2600-800）')
})

// ---------------------------------------------------------------------------
// 布局 clamp（scrollHeight 收缩 / clientHeight 增大）与贴底保持（fix/followup-scroll）
// ---------------------------------------------------------------------------

/** 等待一次性初始贴底窗口完全结束（首校正 + 静默现望期收敛），后续跟底只能依赖
 *  贴底状态机与 RO，不能被初始窗口掩盖。 */
async function exhaustInitialWindow(raf: { flush(cycles: number): void }): Promise<void> {
  raf.flush(4)
  raf.flush(60)
}

test('初始窗口结束后：无用户输入的内容收缩被 clamp 到新底部不释放贴底，回涨后 working 继续跟底', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  const conv = makeConv(10, { status: 'working' })
  const scroller = await renderTimeline(conv, [humanEntry('1', '问'), assistantEntry('2', '答')])
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })
  await exhaustInitialWindow(raf)
  assert.deepEqual(mock.writes, [1200], '初始校正一次置底后窗口收敛')

  // 流式回合中临时元素（如折叠/估高纠正）使总高收缩 2000->1800：浏览器把贴底
  // 的 1200 夹紧到新底部 1000 并派发 scroll。该下降是布局位移而非用户手势，
  // 不得据此释放贴底（否则后续流式永不跟随）。
  mock.setHeight(1800)
  assert.equal(mock.top(), 1000, '浏览器 clamp 下调位置到新底部')
  innerResizeObserver().trigger()
  assert.equal(mock.top(), 1000, '仍贴底：写回 scrollHeight 被 clamp 回 1000（no-op）')

  // 内容回涨：RO 必须继续跟底（gap=0）；若 clamp 被误判为用户上翻则永远适不上
  mock.setHeight(2100)
  innerResizeObserver().trigger()
  assert.equal(mock.top(), 1300, '收缩 clamp 后回涨仍跟随（2100-800）')

  // 真实流式 props 继续增长仍跟随
  await rerenderTimeline({
    conv,
    entries: [humanEntry('1', '问'), assistantEntry('2', '答')],
    live: { conversationId: 10, text: '流式回答第一段', tools: [], updatedAt: 5 },
  })
  mock.setHeight(2300)
  innerResizeObserver().trigger()
  assert.equal(mock.top(), 1500, 'live 流式段继续跟底（2300-800）')
})

test('用户 wheel 上滚脱离后：布局收缩 clamp 到新底部不得自动恢复贴底，随后增长不跟随；idle 保护持续', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  const scroller = await renderTimeline(makeConv(10, { status: 'working' }), [humanEntry('1', '问'), assistantEntry('2', '答')])
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })
  await exhaustInitialWindow(raf)
  assert.deepEqual(mock.writes, [1200])

  // 用户轻微上滚 50px 脱离贴底（wheel 物理输入同步释放）
  scroller.dispatchEvent(wheelUpEvent())
  mock.setTopSilent(1150)
  scroller.dispatchEvent(new Event('scroll'))
  assert.equal(mock.writes.length, 1, '用户接管后无任何程序写入')

  // 内容收缩 2000->1900：浏览器把 1150 夹紧到新底部 1100（距底 0）。即使被
  // clamp 到底部，也不得自动恢复贴底（距底 <=1 的下降只保留既有意图）。
  mock.setHeight(1900)
  assert.equal(mock.top(), 1100, '浏览器 clamp 到新底部')

  // 随后增长（初始窗口已结束）：不吸回底部，gap 保留给用户
  mock.setHeight(2400)
  innerResizeObserver().trigger()
  assert.equal(mock.writes.length, 1, '脱离后的 clamp 与增长均不产生置底写入')
  assert.equal(mock.top(), 1100, 'gap=500 保留给用户')

  // 会话结算 idle：同样的尺寸扰动仍不吸回（窗口结束后的 idle 保护持续有效）
  await rerenderTimeline({
    conv: makeConv(10, { status: 'idle' }),
    entries: [humanEntry('1', '问'), assistantEntry('2', '答'), assistantEntry('3', '完整回答')],
  })
  mock.setHeight(2600)
  innerResizeObserver().trigger()
  assert.equal(mock.writes.length, 1, 'idle 会话不产生置底写入')
  assert.equal(mock.top(), 1100, '历史阅读位置保持，gap=700')
})

test('跟底 RO 观察滚动容器自身：working 贴底时视口缩小维持贴底，idle/用户脱离时同样 resize 不吸回', { timeout: 60_000 }, async () => {
  const raf = installManualRaf()
  const conv = makeConv(10, { status: 'working' })
  const scroller = await renderTimeline(conv, [humanEntry('1', '问'), assistantEntry('2', '答')])
  const mock = setupClampedScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 })
  await exhaustInitialWindow(raf)
  assert.deepEqual(mock.writes, [1200])

  const ro = innerResizeObserver()
  assert.ok(ro.targets.has(scroller), '跟底 RO 必须同时观察滚动容器（Composer 只改视口尺寸，inner 不变）')

  // Composer 多行使视口缩小 800->500：inner 尺寸不变，只能由 scroller RO 感知并维持贴底
  mock.setClientHeight(500)
  ro.trigger()
  assert.equal(mock.top(), 1500, 'working 贴底时视口缩小仍维持贴底（2000-500）')

  // 会话结算 idle（仍处贴底态）：同样的视口变化不吸回
  await rerenderTimeline({
    conv: makeConv(10, { status: 'idle' }),
    entries: [humanEntry('1', '问'), assistantEntry('2', '答'), assistantEntry('3', '完整回答')],
  })
  mock.setClientHeight(800)
  assert.equal(mock.top(), 1200, 'Composer 收起 clamp 到 1200（距底 0）')
  mock.setClientHeight(500)
  innerResizeObserver().trigger()
  assert.equal(mock.top(), 1200, 'idle 时同样的视口缩小不吸回（gap=300 保留）')

  // 重新 working 后用户 wheel 脱离：同样的视口变化仍不吸回
  await rerenderTimeline({ conv, entries: [humanEntry('1', '问'), assistantEntry('2', '答')] })
  scroller.dispatchEvent(wheelUpEvent())
  mock.setTopSilent(1400)
  scroller.dispatchEvent(new Event('scroll'))
  mock.setClientHeight(800)
  assert.equal(mock.top(), 1200, 'Composer 收起 clamp 1400->1200（距底 0）')
  mock.setClientHeight(500)
  innerResizeObserver().trigger()
  assert.equal(mock.top(), 1200, '用户脱离后同样的视口缩小不吸回')
})
