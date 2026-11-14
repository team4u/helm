import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationSummary } from '@helm/protocol'
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
  FakeResizeObserver.instances = []
})

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
}

/**
 * 浏览器一致的滚动语义 mock：scrollTop 写入截断到 [0, scrollHeight-clientHeight]
 * 并派发 scroll；scrollHeight 收缩时下调超界 scrollTop 并派发 scroll（布局位移，
 * 非程序写入），增长时不触发。绝不允许无限 scrollTop 的假语义。
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
      el.scrollHeight = v
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
