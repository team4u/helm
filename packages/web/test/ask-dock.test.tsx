import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { AskSpec, ConversationSummary } from '@helm/protocol'
import type { ActiveModal, HelmStoreValue } from '../src/lib/types.js'

/**
 * AskDock 后代会话审批聚合回归：
 * - 当前会话显示自身 + 全部后代会话的 pending asks（无关会话不显示）；
 * - 后代 ask 标注来源会话，点击可打开对应子会话抽屉；
 * - answer/cancel 仍走原 asksApi（含 expectedStateSeq CAS 水位线），不改变审批链路。
 */
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { AskDock } = await import('../src/conversation/AskDock.js')
const { makeTestStore, TestStoreProvider } = await import('./helpers/store.js')
const e = React.createElement
const originalFetch = globalThis.fetch
let root: Root | undefined
let host: HTMLElement | undefined
let activeModal: ActiveModal = null
let posts: Array<{ url: string; body: Record<string, unknown> }> = []

function summary(id: number, parentConversationId?: number): ConversationSummary {
  return {
    id,
    title: `会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: id,
    updatedAt: id,
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
  }
}

// 祖谱：1 ← 11 ← 111（两层派生）；9 为无关根会话。
const conversations = [summary(1), summary(11, 1), summary(111, 11), summary(9)]

function ask(id: string, conversationId: number, expectedStateSeq?: number): AskSpec {
  return {
    id,
    conversationId,
    title: `审批 ${id}`,
    fields: [{ name: 'word', label: '词语', type: 'text', required: true }],
    status: 'pending',
    createdAt: Number(conversationId) * 100,
    ...(expectedStateSeq !== undefined ? { expectedStateSeq } : {}),
  }
}

const pendingAsks = [
  ask('ask-root', 1, 7),
  ask('ask-child', 11, 42),
  ask('ask-grand', 111),
  ask('ask-other', 9),
]

function makeStore(overrides: Partial<HelmStoreValue> = {}): HelmStoreValue {
  return makeTestStore({
    conversations,
    pendingAsks,
    setActiveModal: (modal: ActiveModal) => { activeModal = modal },
    ...overrides,
  })
}

function installFetch(status = 200): void {
  posts = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const request = init
    if ((request?.method ?? 'GET') === 'POST') {
      const raw = typeof request?.body === 'string' ? request.body : '{}'
      posts.push({ url, body: JSON.parse(raw) as Record<string, unknown> })
      return new Response(JSON.stringify({ ok: true }), { status, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

async function renderAskDock(store: HelmStoreValue, conversationId: number): Promise<void> {
  // 同一测试内多次渲染（切换视角）时先收起上一棵树，避免旧卡片残留 DOM。
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host!)
    root.render(e(TestStoreProvider, { value: store }, e(AskDock, { conversationId })))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
}

/** React 受控输入需绕过原生 value setter 才能触发 onChange。 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function cardTitles(): string[] {
  return [...document.querySelectorAll('.ask-dock-title')].map((node) => node.textContent ?? '')
}

function sourceButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.ask-dock-source-btn')]
}

function reset(): void {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  activeModal = null
  posts = []
}

afterEach(reset)

test('AskDock 聚合当前会话与全部后代的 pending asks，无关会话不显示', { timeout: 60_000 }, async () => {
  installFetch()
  await renderAskDock(makeStore(), 1)
  assert.deepEqual(cardTitles(), ['审批 ask-root', '审批 ask-child', '审批 ask-grand'], '应显示自身 + 子 + 孙会话的 asks')
  assert.equal(cardTitles().includes('审批 ask-other'), false, '无关会话 #9 的 ask 不得显示')
  // 孙会话（#111）视角：只看自身，不再向父/兄弟扩散
  await renderAskDock(makeStore(), 111)
  assert.deepEqual(cardTitles(), ['审批 ask-grand'], '后代视角只聚合自身子树')
})

test('后代 ask 标注来源会话；当前会话自身卡片不标注', { timeout: 60_000 }, async () => {
  installFetch()
  await renderAskDock(makeStore(), 1)
  const labels = sourceButtons().map((b) => b.textContent ?? '')
  assert.deepEqual(labels.sort(), ['来自 #11', '来自 #111'], '两张后代卡片均应标注来源会话')
  const titled = sourceButtons().find((b) => b.textContent === '来自 #11')
  assert.ok(titled, '子会话卡片应有来源按钮')
  assert.equal((titled!.getAttribute('title') ?? '').includes('会话 11'), true, '来源按钮 tooltip 含来源会话标题')
})

test('点击来源标注打开对应子会话抽屉', { timeout: 60_000 }, async () => {
  installFetch()
  await renderAskDock(makeStore(), 1)
  const btn = sourceButtons().find((b) => b.textContent === '来自 #11')
  assert.ok(btn)
  await act(async () => { btn!.click() })
  assert.deepEqual(activeModal, { kind: 'conversation-drawer', conversationId: 11 }, '应打开子会话 #11 抽屉')
})

test('提交后代 ask 答案走原 asksApi 并携带 CAS 水位线', { timeout: 60_000 }, async () => {
  installFetch()
  await renderAskDock(makeStore(), 1)
  // 第二张卡是 #11 子会话的 ask-child（expectedStateSeq = 42）
  const cards = [...document.querySelectorAll('.ask-dock')]
  assert.equal(cards.length, 3)
  const childCard = cards[1]
  assert.ok(childCard, '应存在子会话 ask 卡片')
  const childInput = childCard.querySelector<HTMLInputElement>('input.input')
  assert.ok(childInput, '子会话 ask 应渲染输入框')
  await act(async () => { setInputValue(childInput!, 'yes') })
  const submit = [...childCard.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('提交'))
  assert.ok(submit)
  await act(async () => { submit!.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  assert.equal(posts.length, 1, '应恰好发出一次 answer 请求')
  const answerPost = posts[0]
  assert.ok(answerPost, '应存在 answer 请求')
  assert.equal(answerPost.url, '/api/asks/ask-child/answer')
  assert.deepEqual(answerPost.body, { answers: { word: 'yes' }, expectedStateSeq: 42 }, 'CAS 水位线必须随答案回传')
})

test('取消后代 ask 走原 asksApi cancel', { timeout: 60_000 }, async () => {
  installFetch()
  await renderAskDock(makeStore(), 1)
  const cards = [...document.querySelectorAll('.ask-dock')]
  const grandCard = cards[2]
  assert.ok(grandCard, '应存在孙会话 ask 卡片')
  const cancel = [...grandCard.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '取消')
  assert.ok(cancel)
  await act(async () => { cancel!.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  assert.equal(posts.length, 1)
  const cancelPost = posts[0]
  assert.ok(cancelPost)
  assert.equal(cancelPost.url, '/api/asks/ask-grand/cancel', '取消孙会话 ask 应命中其会话级 askId')
})

test('祖先面板与子会话抽屉同时呈现同一审批时表单标签不串实例', { timeout: 60_000 }, async () => {
  installFetch()
  const store = makeStore({ pendingAsks: [ask('shared-ask', 11, 42)] })
  await renderAskDock(store, 1)
  await act(async () => {
    root?.render(e(TestStoreProvider, { value: store },
      e(React.Fragment, null, e(AskDock, { conversationId: 1 }), e(AskDock, { conversationId: 11 })),
    ))
  })
  const inputs = [...document.querySelectorAll<HTMLInputElement>('.ask-dock input')]
  assert.equal(inputs.length, 2)
  assert.notEqual(inputs[0]!.id, inputs[1]!.id, '同一 AskDoc 的不同表单实例必须有独立 DOM id')
  for (const card of document.querySelectorAll('.ask-dock')) {
    assert.equal(card.querySelector('label')?.htmlFor, card.querySelector('input')?.id)
  }
})

test('ask 解除 pending 后卡片即时消失', { timeout: 60_000 }, async () => {
  installFetch()
  const store = makeStore()
  await renderAskDock(store, 1)
  assert.equal(cardTitles().length, 3)
  // ask-child 被 answered：pendingAsks 移除后 AskDock 不再渲染该卡
  await act(async () => {
    root?.render(e(TestStoreProvider, {
      value: makeStore({ pendingAsks: pendingAsks.filter((a) => a.id !== 'ask-child') }),
    }, e(AskDock, { conversationId: 1 })))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  assert.deepEqual(cardTitles(), ['审批 ask-root', '审批 ask-grand'])
})
