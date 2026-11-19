import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { AskSpec, ConversationSummary } from '@helmx/protocol'
import type { HelmxLocale } from '@helmx/protocol/browser'
import type { ActiveModal, HelmxStoreValue } from '../src/lib/types.js'

/**
 * AskDock descendant-approval aggregation regression:
 * - the current conversation shows its own + all descendant conversations' pending
 *   asks (unrelated conversations never appear);
 * - descendant asks carry a source badge; clicking opens that child conversation's drawer;
 * - answer/cancel still go through the original asksApi (with the expectedStateSeq
 *   CAS watermark); the approval chain is unchanged.
 */
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { AskDock } = await import('../src/conversation/AskDock.js')
const { makeTestStore } = await import('./helpers/store.js')
type HelmxExternalStore = import('../src/lib/helmx-store.js').HelmxExternalStore
const { TestStoreProvider } = await import('./helpers/host-store.js')
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

// Ancestry: 1 <- 11 <- 111 (two levels); 9 is an unrelated root conversation.
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

function makeStore(overrides: Partial<HelmxStoreValue> = {}): HelmxExternalStore {
  const store = makeTestStore({
    conversations,
    pendingAsks,
    ...overrides,
  })
  ;(store.actions as unknown as { setActiveModal: (modal: ActiveModal) => void }).setActiveModal = (modal) => { activeModal = modal }
  return store
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

async function renderAskDock(store: HelmxExternalStore, conversationId: number): Promise<void> {
  // When rendering multiple times in one test (switching viewpoints), tear down the
  // previous tree first so no stale card DOM lingers.
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

/** React controlled inputs need to bypass the native value setter to trigger onChange. */
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

test('AskDock aggregates pending asks of the current conversation and all descendants; unrelated ones never show', { timeout: 60_000 }, async () => {
  installFetch()
  await renderAskDock(makeStore(), 1)
  assert.deepEqual(cardTitles(), ['审批 ask-root', '审批 ask-child', '审批 ask-grand'], 'shows own + child + grandchild asks')
  assert.equal(cardTitles().includes('审批 ask-other'), false, 'the ask of unrelated conversation #9 must not show')
  // Card main status: one blocked status light with a visible label (no icon-only hover dependency)
  const lights = [...document.querySelectorAll('.ask-dock-header .helmx-status-light')]
  assert.equal(lights.length, 3, 'each ask card renders exactly one status light')
  for (const light of lights) {
    assert.equal(light.getAttribute('data-tone'), 'blocked')
    assert.equal((light.textContent ?? '').length > 0, true, 'status light carries a visible label')
  }
  // Grandchild (#111) viewpoint: itself only, no propagation to parents/siblings
  await renderAskDock(makeStore(), 111)
  assert.deepEqual(cardTitles(), ['审批 ask-grand'], 'a descendant viewpoint aggregates only its own subtree')
})

test('descendant asks carry a source badge; the current conversation own card carries none', { timeout: 60_000 }, async () => {
  installFetch()
  await renderAskDock(makeStore(), 1)
  const labels = sourceButtons().map((b) => b.textContent ?? '')
  assert.deepEqual(labels.sort(), ['From #11', 'From #111'], 'both descendant cards carry a source badge')
  const titled = sourceButtons().find((b) => b.textContent === 'From #11')
  assert.ok(titled, 'the child card must have a source button')
  assert.equal((titled!.getAttribute('title') ?? '').includes('会话 11'), true, 'the source button tooltip contains the source conversation title')
})

test('清亮化：seq / owner 插件不再是常驻徽章，改为 info 入口 + 可访问 Popover（CAS 提交与来源导航不变）', { timeout: 60_000 }, async () => {
  installFetch()
  const ownerAsks = [
    { ...ask('ask-meta', 1, 7), ownerPluginId: 'builtin:triggers' },
  ]
  await renderAskDock(makeStore({ pendingAsks: ownerAsks }), 1)
  const header = document.querySelector('.ask-dock-header') as HTMLElement | null
  assert.ok(header !== null)
  // 常驻徽章移除：头部不再出现 seq N 文本与 owner 插件徽章。
  assert.equal((header.textContent ?? '').includes('seq'), false, 'seq 不再常驻外露')
  assert.equal((header.textContent ?? '').includes('builtin:triggers'), false, 'owner 插件不再常驻外露')
  assert.equal(header.querySelector('.badge-warn') === null, true, 'owner 不再渲染警示徽章')
  // info 入口为真实按钮。
  const infoBtn = header.querySelector('button.ask-dock-meta-btn') as HTMLButtonElement | null
  assert.ok(infoBtn !== null, '元数据 info 入口为真实按钮')
  // 打开 Popover 后 owner / seq 可见（不依赖 title）。
  await act(async () => { infoBtn.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  const popoverText = [...document.querySelectorAll('[data-radix-popper-content-wrapper], .ask-dock-meta-popover')]
    .map((el) => el.textContent ?? '')
    .join('\n')
  assert.ok(popoverText.includes('builtin:triggers'), 'Popover 展示 owner 插件')
  assert.ok(popoverText.includes('7'), 'Popover 展示 CAS seq')
})

test('clicking the source badge opens the corresponding child conversation drawer', { timeout: 60_000 }, async () => {
  installFetch()
  await renderAskDock(makeStore(), 1)
  const btn = sourceButtons().find((b) => b.textContent === 'From #11')
  assert.ok(btn)
  await act(async () => { btn!.click() })
  assert.deepEqual(activeModal, { kind: 'conversation-drawer', conversationId: 11 }, 'child conversation #11 drawer opens')
})

test('submitting a descendant ask answer goes through the original asksApi with the CAS watermark', { timeout: 60_000 }, async () => {
  installFetch()
  await renderAskDock(makeStore(), 1)
  // The second card is #11 child conversation's ask-child (expectedStateSeq = 42)
  const cards = [...document.querySelectorAll('.ask-dock')]
  assert.equal(cards.length, 3)
  const childCard = cards[1]
  assert.ok(childCard, 'the child ask card must exist')
  const childInput = childCard.querySelector<HTMLInputElement>('input.input')
  assert.ok(childInput, 'the child ask must render an input')
  await act(async () => { setInputValue(childInput!, 'yes') })
  const submit = [...childCard.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Submit'))
  assert.ok(submit)
  await act(async () => { submit!.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  assert.equal(posts.length, 1, 'exactly one answer request is sent')
  const answerPost = posts[0]
  assert.ok(answerPost, 'the answer request must exist')
  assert.equal(answerPost.url, '/api/asks/ask-child/answer')
  assert.deepEqual(answerPost.body, { answers: { word: 'yes' }, expectedStateSeq: 42 }, 'the CAS watermark rides along with the answer')
})

test('cancelling a descendant ask goes through the original asksApi cancel', { timeout: 60_000 }, async () => {
  installFetch()
  await renderAskDock(makeStore(), 1)
  const cards = [...document.querySelectorAll('.ask-dock')]
  const grandCard = cards[2]
  assert.ok(grandCard, 'the grandchild ask card must exist')
  const cancel = [...grandCard.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Cancel')
  assert.ok(cancel)
  await act(async () => { cancel!.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  assert.equal(posts.length, 1)
  const cancelPost = posts[0]
  assert.ok(cancelPost)
  assert.equal(cancelPost.url, '/api/asks/ask-grand/cancel', 'cancelling the grandchild ask targets its conversation-scoped askId')
})

test('the same approval in an ancestor panel and a child drawer keeps form labels per instance', { timeout: 60_000 }, async () => {
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
  assert.notEqual(inputs[0]!.id, inputs[1]!.id, 'different form instances of the same AskDoc need distinct DOM ids')
  for (const card of document.querySelectorAll('.ask-dock')) {
    assert.equal(card.querySelector('label')?.htmlFor, card.querySelector('input')?.id)
  }
})

test('a card disappears immediately once its ask leaves the pending state', { timeout: 60_000 }, async () => {
  installFetch()
  const store = makeStore()
  await renderAskDock(store, 1)
  assert.equal(cardTitles().length, 3)
  // ask-child answered: once pendingAsks drops it, AskDock no longer renders the card
  await act(async () => {
    root?.render(e(TestStoreProvider, {
      value: makeStore({ pendingAsks: pendingAsks.filter((a) => a.id !== 'ask-child') }),
    }, e(AskDock, { conversationId: 1 })))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  assert.deepEqual(cardTitles(), ['审批 ask-root', '审批 ask-grand'])
})

test('zh-CN locale: AskDock renders the Chinese catalog copy', { timeout: 60_000 }, async () => {
  installFetch()
  await renderAskDock(makeStore({ locale: 'zh-CN' }), 1)
  const buttons = [...document.querySelectorAll('.ask-dock-actions button')].map((b) => b.textContent)
  assert.ok(buttons.includes('取消'), 'the cancel button shows the zh-CN copy')
  assert.ok(buttons.includes('提交'), 'the submit button shows the zh-CN copy')
  const badges = sourceButtons().map((b) => b.textContent)
  assert.ok(badges.some((text) => text === '来自 #11'), 'the source badge shows the zh-CN copy')
})

test('setLocale switches AskDock copy en -> zh-CN -> en immediately in place', { timeout: 60_000 }, async () => {
  installFetch()
  const host2 = document.createElement('div')
  document.body.appendChild(host2)
  let committedLocale: HelmxLocale = 'en'
  function Harness(): React.JSX.Element {
    const [locale, setLocale] = React.useState<HelmxLocale>('en')
    committedLocale = locale
    const store = React.useMemo(() => makeStore({ locale, setLocale }), [locale])
    return e(TestStoreProvider, { value: store },
      e(AskDock, { conversationId: 1 }),
      e('button', { type: 'button', onClick: () => setLocale(locale === 'en' ? 'zh-CN' : 'en') }, 'switch-locale'))
  }
  const harnessRoot = createRoot(host2)
  try {
    await act(async () => { harnessRoot.render(e(Harness)) })
    const submitEn = [...host2.querySelectorAll('.ask-dock-actions button')].map((b) => b.textContent)
    assert.ok(submitEn.includes('Submit'), 'renders the en catalog copy by default')

    const switchBtn = [...host2.querySelectorAll('button')].find((b) => b.textContent === 'switch-locale') as HTMLButtonElement
    await act(async () => { switchBtn.click() })
    assert.equal(committedLocale, 'zh-CN')
    const submitZh = [...host2.querySelectorAll('.ask-dock-actions button')].map((b) => b.textContent)
    assert.ok(submitZh.includes('提交'), 'locale switch re-renders AskDock in place with zh-CN copy')
    assert.ok(submitZh.includes('取消'), 'the cancel button switched too')

    await act(async () => { switchBtn.click() })
    assert.equal(committedLocale, 'en')
    const submitBack = [...host2.querySelectorAll('.ask-dock-actions button')].map((b) => b.textContent)
    assert.ok(submitBack.includes('Submit'), 'switching back to en restores English immediately')
  } finally {
    await act(async () => { harnessRoot.unmount() })
    host2.remove()
  }
})
