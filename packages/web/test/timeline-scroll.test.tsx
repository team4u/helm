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

interface MockScrollElement {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  writes: number[]
}

function setupMockScroll(el: HTMLElement, initial: { scrollHeight: number; clientHeight: number; scrollTop: number }): MockScrollElement {
  const writes: number[] = []
  let { scrollHeight, clientHeight, scrollTop } = initial

  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
    set: (v: number) => { scrollHeight = v },
  })
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
    set: (v: number) => { clientHeight = v },
  })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v
      writes.push(v)
    },
  })

  return {
    get scrollHeight() { return scrollHeight },
    set scrollHeight(v: number) { scrollHeight = v },
    get clientHeight() { return clientHeight },
    set clientHeight(v: number) { clientHeight = v },
    get scrollTop() { return scrollTop },
    set scrollTop(v: number) { scrollTop = v },
    writes,
  }
}

test('已结算静止会话（idle）：ResizeObserver 触发时绝不强行将 scrollTop 置底', { timeout: 60_000 }, async () => {
  const conv = makeConv(10, { status: 'idle' })
  const entries = [humanEntry('1', '问'), assistantEntry('2', '答')]
  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { 10: { ...conv, entries } },
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

  const scroller = host.querySelector<HTMLElement>('.timeline-scroll')!
  assert.ok(scroller !== null, '时间线滚动容器存在')
  const mock = setupMockScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 1200 })

  // 模拟上滚到 scrollTop = 600
  mock.scrollTop = 600
  scroller.dispatchEvent(new Event('scroll'))

  // 内部容器由于 content-visibility 估高测量或折叠展开导致尺寸变化，触发 ResizeObserver
  const innerRo = FakeResizeObserver.instances.find((inst) =>
    Array.from(inst.targets).some((t) => t.classList.contains('timeline-inner')),
  )
  assert.ok(innerRo !== undefined, '内部容器的 ResizeObserver 必须存在')

  const writesBefore = mock.writes.length
  innerRo!.trigger()

  // 静止会话绝不应产生新的 scrollTop 置底写入
  assert.equal(mock.writes.length, writesBefore, '静止会话在尺寸变化时不应触发置底写入')
  assert.equal(mock.scrollTop, 600, 'scrollTop 应保持在 600，不被弹回底部')
})

test('主动上滚微小位移（即使在离底 80px 死区内）：即刻脱离贴底，不被下一次 Resize 弹回到底端', { timeout: 60_000 }, async () => {
  const conv = makeConv(10, { status: 'working' })
  const entries = [humanEntry('1', '问'), assistantEntry('2', '答')]
  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { 10: { ...conv, entries } },
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

  const scroller = host.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupMockScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 1200 })

  // 初始在底端（scrollTop = 1200, distanceFromBottom = 0）
  scroller.dispatchEvent(new Event('scroll'))

  // 用户仅向上微滚 15px（scrollTop 变成 1185，距离底部 15px，属于原 <= 80px 死区）
  mock.scrollTop = 1185
  scroller.dispatchEvent(new Event('scroll'))

  // 寻找 inner ResizeObserver
  const innerRo = FakeResizeObserver.instances.find((inst) =>
    Array.from(inst.targets).some((t) => t.classList.contains('timeline-inner')),
  )!
  assert.ok(innerRo !== undefined)

  // 模拟流式追加或高度变动
  mock.scrollHeight = 2050
  innerRo.trigger()

  // 已经脱离贴底，不应被强行写回 2050
  assert.equal(mock.scrollTop, 1185, '主动上滚微调后已脱离贴底，不应被弹回底部')
})

test('活跃生成态（working）在底端贴底时：随高度变动自动跟随到底端', { timeout: 60_000 }, async () => {
  const conv = makeConv(10, { status: 'working' })
  const entries = [humanEntry('1', '问'), assistantEntry('2', '答')]
  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { 10: { ...conv, entries } },
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

  const scroller = host.querySelector<HTMLElement>('.timeline-scroll')!
  const mock = setupMockScroll(scroller, { scrollHeight: 2000, clientHeight: 800, scrollTop: 1200 })

  // 保持在底端
  scroller.dispatchEvent(new Event('scroll'))

  const innerRo = FakeResizeObserver.instances.find((inst) =>
    Array.from(inst.targets).some((t) => t.classList.contains('timeline-inner')),
  )!

  // 流式生成新增高度到 2100
  mock.scrollHeight = 2100
  innerRo.trigger()

  assert.equal(mock.scrollTop, 2100, '贴底态且会话处于 working 时，随高度变动自动跟底')
})
