import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary } from '@helmx/protocol'
import { hangingEventStream } from './helpers/sse-stream.js'
import type { ResolvedTarget, ActiveModal } from '../src/lib/types.js'

/**
 * 子会话抽屉（conversation-drawer）导航闭环回归：
 * - 全站不再渲染祖先回退按钮（抽屉/主屏/分屏顶栏均无面包屑）；
 * - 普通关闭与浏览器后退只关抽屉，工作台保留；
 * - 抽屉会话与主会话工作台功能对齐：抽屉顶栏工作台按钮打开的工作台绑定
 *   抽屉会话（插件面板按其 scope 解析），抬升于抽屉之上；打开抽屉时收起
 *   旧工作台，深链组合态可精确还原。
 */
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const { ConversationDrawer } = await import('../src/conversation/ConversationDrawer.js')
const { HelmxStoreProvider } = await import('../src/lib/HelmxStoreProvider.js')
const { useHelmxStore } = await import('../src/lib/store-context.js')
const { App: RealApp } = await import('../src/App.js')
const e = React.createElement
const originalFetch = globalThis.fetch
let root: Root | undefined
let host: HTMLElement | undefined
let observed: {
  primary: ResolvedTarget
  split: ResolvedTarget | null
  workbenchOpen: boolean
  workbenchTab: string
  modal: ActiveModal
} | undefined

function summary(id: number, parentConversationId?: number, title = `会话 ${id}`): ConversationSummary {
  return {
    id,
    title,
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

// 祖谱：1 ← 11 ← 111（两层派生）；999 为无关根会话。
const conversations = [summary(1), summary(11, 1), summary(111, 11), summary(999)]

/** 挂载后的真实 store 引用（openTarget/setActiveModal 直调，测 P0 收抽屉语义）。 */
let storeHandle: ReturnType<typeof useHelmxStore> | undefined

interface FetchFixture {
  list?: ConversationSummary[]
  detailMap?: Record<number, ConversationSummary>
  /** SSE 快照携带的插件 UI 贡献（默认空）。 */
  ui?: unknown[]
}

function installFetch(fixture: FetchFixture = {}): void {
  const list = fixture.list ?? conversations
  const detailMap = fixture.detailMap ?? {}
  const ui = fixture.ui ?? []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200 })
    }
    if (url === '/api/profiles') {
      return new Response(JSON.stringify([{ id: 'assistant', name: 'Assistant' }]), { status: 200 })
    }
    if (url === '/api/events') {
      return new Response(hangingEventStream((send) => {
        send(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({
          bootId: 'test-boot',
          seq: 1,
          conversations: list,
          pendingAsks: [],
          plugins: [],
          ui,
        })}\n\n`))
      }, { signal: init?.signal }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const artifactMatch = /^\/api\/conversations\/(\d+)\/artifacts$/.exec(url)
    if (artifactMatch) return new Response(JSON.stringify([]), { status: 200 })
    const detailMatch = /^\/api\/conversations\/(\d+)/.exec(url)
    if (detailMatch && (init?.method ?? 'GET') === 'GET') {
      const id = Number(detailMatch[1])
      const found = detailMap[id] ?? list.find((item) => item.id === id)
      return new Response(JSON.stringify({ ...(found ?? summary(id)), entries: [] }), { status: 200 })
    }
    if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

function App(): React.ReactNode {
  const store = useHelmxStore()
  observed = {
    primary: store.primaryTarget,
    split: store.splitTarget,
    workbenchOpen: store.workbenchOpen,
    workbenchTab: store.workbenchTab,
    modal: store.activeModal,
  }
  storeHandle = store
  const primary = store.primaryTarget.kind === 'conversation' ? store.primaryTarget : null
  const split = store.splitTarget?.kind === 'conversation' ? store.splitTarget : null
  return e(React.Fragment, null,
    e('div', { className: 'helmx-panes' },
      primary !== null
        ? e(ConversationPane, { key: `primary:${primary.conversationId}`, conversationId: primary.conversationId })
        : null,
      split !== null
        ? e('div', { className: 'helmx-split-pane' },
            e(ConversationPane, {
              key: `split:${split.conversationId}`,
              conversationId: split.conversationId,
              isSplit: true,
              onCloseSplit: () => store.closeSplit(),
            }))
        : null,
    ),
    store.activeModal?.kind === 'conversation-drawer'
      ? e(ConversationDrawer, {
          conversationId: store.activeModal.conversationId,
          onClose: () => store.setActiveModal(null),
        })
      : null,
  )
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
}

async function mount(hash: string, fixture?: FetchFixture): Promise<void> {
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch(fixture)
  await act(async () => {
    root = createRoot(host!)
    root.render(e(HelmxStoreProvider, null, e(App)))
  })
  await settle()
}

/** 真实 App（含工作台绑定派生与叠层）黑盒挂载：断言全部走 DOM 与地址栏。 */
async function mountReal(hash: string, fixture?: FetchFixture): Promise<void> {
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch(fixture)
  await act(async () => {
    root = createRoot(host!)
    root.render(e(RealApp))
  })
  await settle()
}

function ancestorButtons(scope: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`${scope} .pane-parent-nav-btn`)]
}

function reset(): void {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  observed = undefined
  storeHandle = undefined
}

afterEach(reset)

test('全站不再渲染祖先回退按钮：抽屉/主屏/分屏顶栏均无面包屑', { timeout: 60_000 }, async () => {
  await mount('#/c/999?split=c/111&wb=artifacts&modal=drawer&id=111')
  assert.equal(observed?.primary.kind === 'conversation' ? observed.primary.conversationId : undefined, 999)
  assert.deepEqual(observed?.split, { kind: 'conversation', conversationId: 111 })
  assert.equal(observed?.modal?.kind, 'conversation-drawer')
  assert.ok(observed?.workbenchOpen)
  // 抽屉（子会话 #111）、主屏（根 #999）、分屏（子会话 #111）均不渲染祖先回退按钮
  assert.equal(ancestorButtons('.conversation-drawer').length, 0, '抽屉不应渲染祖先回退按钮')
  assert.equal(ancestorButtons('.helmx-panes > .helmx-pane').length, 0, '主屏不应渲染祖先回退按钮')
  assert.equal(ancestorButtons('.helmx-split-pane').length, 0, '分屏不应渲染祖先回退按钮')
  assert.ok(document.querySelector('.conversation-drawer .conversation-drawer-close-btn'), '抽屉仍有关闭按钮')
})

test('子会话抽屉普通关闭只关抽屉，不影响工作台', { timeout: 60_000 }, async () => {
  // 直接以「工作台 + 抽屉」深链模拟用户从工作台点开子代理卡后的位置，
  // 验证「关闭」仅关抽屉、不动工作台（收口只发生在导航主屏时）。
  await mount('#/c/1?wb=artifacts&modal=drawer&id=11')
  assert.ok(observed?.workbenchOpen)
  await act(async () => {
    const closeBtn = [...document.querySelectorAll<HTMLButtonElement>('.conversation-drawer-close-btn')]
      .find((b) => (b.getAttribute('aria-label') ?? '') !== '')
    assert.ok(closeBtn, '抽屉应有关闭按钮')
    closeBtn!.click()
  })
  await settle()
  assert.equal(observed?.modal, null, '抽屉关闭')
  assert.equal(observed?.workbenchOpen, true, '普通关闭不动工作台（仍保留）')
})

test('浏览器后退可单独关闭抽屉并保留工作台', { timeout: 60_000 }, async () => {
  // 工作台打开 → push 打开抽屉 → 后退：回到工作台态（浏览器语义不经过 openTarget）。
  await mount('#/c/1?wb=artifacts')
  assert.ok(observed?.workbenchOpen)
  await act(async () => {
    window.history.pushState(null, '', '#/c/1?wb=artifacts&modal=drawer&id=11')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  await settle()
  assert.equal(observed?.modal?.kind, 'conversation-drawer')
  await act(async () => { window.history.back() })
  await settle()
  assert.equal(observed?.modal, null, '后退应关闭抽屉')
  assert.ok(observed?.workbenchOpen, '后退应保留工作台')
})

test('抽屉标题与 aria-label 展示有意义的会话标题，占位标题与空白回退默认文案', { timeout: 60_000 }, async () => {
  await mount('#/c/1?modal=drawer&id=11', {
    list: [summary(1), summary(11, 1, '排查构建失败')],
  })
  const drawerDialog = document.querySelector('.conversation-drawer')
  assert.ok(drawerDialog, '应渲染抽屉 dialog')
  assert.equal(
    drawerDialog!.getAttribute('aria-label'),
    'Child conversation #11 · 排查构建失败 drawer',
    '有意义标题应带入抽屉 aria-label',
  )
  assert.equal(
    drawerDialog!.querySelector('h2')?.textContent,
    'Child conversation #11 · 排查构建失败 drawer',
    'DialogTitle 应包含会话标题',
  )

  reset()
  for (const [id, placeholder] of [
    [12, 'subagent 12'],
    [13, '子代理 13'],
    [14, '子会话 14'],
    [15, '   '],
  ] as const) {
    await mount(`#/c/1?modal=drawer&id=${id}`, {
      list: [summary(1), summary(id, 1, placeholder)],
    })
    const dlg = document.querySelector('.conversation-drawer')
    assert.ok(dlg, `应渲染占位测试 #${id} 抽屉`)
    assert.equal(
      dlg!.getAttribute('aria-label'),
      `Child conversation #${id} drawer`,
      `占位标题 "${placeholder}" 应回退默认抽屉标题`,
    )
    assert.equal(
      dlg!.querySelector('h2')?.textContent,
      `Child conversation #${id} drawer`,
      `DialogTitle 对占位标题 "${placeholder}" 应回退默认文案`,
    )
    reset()
  }

  // 不在摘要列表时回退 detail 标题
  await mount('#/c/1?modal=drawer&id=20', {
    list: [summary(1)],
    detailMap: { 20: summary(20, 1, '详情兜底标题') },
  })
  const fallbackDlg = document.querySelector('.conversation-drawer')
  assert.ok(fallbackDlg, '应渲染 detail 回退抽屉')
  assert.equal(
    fallbackDlg!.getAttribute('aria-label'),
    'Child conversation #20 · 详情兜底标题 drawer',
    '摘要缺失时应使用 detail 标题',
  )
})

test('openTarget 主屏导航自动收起会话抽屉，分屏导航不收（修复抽屉内深链被自身遮挡）', { timeout: 60_000 }, async () => {
  // 抽屉内徽标/通知等经 openTarget 跳主屏目标：若不收抽屉，全高抽屉挡住新
  // 目标表现为「点击无反应」。分屏导航本就不遮挡，不应误收。
  // （取值走函数防 assert.equal(x, null) 的 asserts 窄化污染后续同路径读取。）
  const modalOf = (): ActiveModal | null => (observed ?? undefined)?.modal ?? null
  await mount('#/c/1?modal=drawer&id=11')
  const before = modalOf()
  assert.ok(before !== null && before.kind === 'conversation-drawer', '前置：抽屉应打开')
  await act(async () => {
    storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 })
  })
  await settle()
  const afterPrimary = observed?.primary
  assert.ok(afterPrimary !== undefined && afterPrimary.kind === 'conversation', '主屏应切到目标会话')
  assert.ok(modalOf() === null, '主屏导航应自动收起会话抽屉')

  // 重开抽屉后走分屏：抽屉保留（分屏与抽屉可叠放，互不遮挡）
  await act(async () => {
    storeHandle!.setActiveModal({ kind: 'conversation-drawer', conversationId: 11 })
  })
  await settle()
  assert.ok(modalOf()?.kind === 'conversation-drawer', '重开抽屉前置成立')
  await act(async () => {
    storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }, { split: true })
  })
  await settle()
  assert.ok(modalOf()?.kind === 'conversation-drawer', '分屏导航不应收起会话抽屉')
  const afterSplit = observed?.split
  assert.ok(afterSplit !== null && afterSplit?.kind === 'conversation', '分屏应切到目标会话')
})

// ---------------------------------------------------------------------------
// 抽屉会话工作台对齐（真实 App 黑盒回归）
// ---------------------------------------------------------------------------

/** 仅匹配 #11（tags 含 drawer-tagged）的插件工作台面板：用于证明工作台绑定抽屉会话。 */
const DRAWER_ONLY_PANEL = {
  pluginId: 'sample',
  surface: 'workbench.panel',
  spec: {
    id: 'drawer-only',
    label: '抽屉专属面板',
    order: 5,
    scope: { tags: ['drawer-tagged'] },
  },
}

function drawerWorkbenchFixture(): FetchFixture {
  return {
    list: [summary(1), { ...summary(11, 1), tags: ['drawer-tagged'] }],
    ui: [DRAWER_ONLY_PANEL],
  }
}

function workbenchTabTexts(): string[] {
  return [...document.querySelectorAll('.helmx-workbench .tabs-bar .tab-btn')].map(
    (el) => el.textContent ?? '',
  )
}

test('抽屉会话顶栏工作台按钮打开绑定抽屉会话的完整工作台，抬升于抽屉之上且关闭互不影响', { timeout: 60_000 }, async () => {
  await mountReal('#/c/1?modal=drawer&id=11', drawerWorkbenchFixture())
  const drawer = document.querySelector<HTMLElement>('.conversation-drawer')
  assert.ok(drawer, '应渲染会话抽屉')
  assert.ok(document.querySelector('.helmx-workbench') === null, '初始工作台应关闭')

  const workbenchBtn = document.querySelector<HTMLButtonElement>(
    '.conversation-drawer .pane-actions button[aria-label="Workbench"]',
  )
  assert.ok(workbenchBtn, '抽屉顶栏应有与主会话一致的工作台按钮')

  await act(async () => { workbenchBtn!.click() })
  await settle()
  assert.ok(document.querySelector('.helmx-workbench'), '点击后应打开工作台')
  assert.match(window.location.hash, /wb=/, '工作台状态应写入地址栏')
  const tabs = workbenchTabTexts()
  assert.ok(tabs.some((text) => text.includes('抽屉专属面板')), `工作台应绑定抽屉会话 #11（scope 命中的插件面板须出现），实际页签: ${JSON.stringify(tabs)}`)
  assert.ok(tabs.some((text) => text.includes('Artifacts')), '内置产物页签应保留')

  // 叠层：后开的工作台须高于抽屉（overlay-stack 按打开时序分配 z-index）
  const workbenchEl = document.querySelector<HTMLElement>('.helmx-workbench')
  const drawerZ = Number(drawer!.style.zIndex || 0)
  const workbenchZ = Number(workbenchEl!.style.zIndex || 0)
  assert.ok(workbenchZ > drawerZ, `工作台应抬升于抽屉之上（workbench=${workbenchZ}, drawer=${drawerZ}）`)

  // 关闭工作台只收工作台，不动抽屉
  const closeBtn = document.querySelector<HTMLButtonElement>('.helmx-workbench .workbench-close-btn')
  assert.ok(closeBtn, '工作台应有关闭按钮')
  await act(async () => { closeBtn!.click() })
  await settle()
  assert.ok(document.querySelector('.helmx-workbench') === null, '关闭后工作台应收起')
  assert.ok(document.querySelector('.conversation-drawer'), '抽屉应保持打开')
  assert.match(window.location.hash, /modal=drawer&id=11/, '地址栏应保留抽屉态')
  assert.doesNotMatch(window.location.hash, /wb=/, '地址栏应收起工作台参数')
})

test('工作台打开时经总览卡片打开会话抽屉：旧工作台自动收起，抽屉内可重新打开', { timeout: 60_000 }, async () => {
  await mountReal('#/overview?wb=artifacts', {
    list: [summary(1), { ...summary(11, 1), tags: ['drawer-tagged'] }],
    ui: [DRAWER_ONLY_PANEL],
  })
  assert.ok(document.querySelector('.helmx-workbench'), '初始工作台应打开')

  // 点根会话卡的后代芯片 #11 打开抽屉（#11 命中 scoped 面板，抽屉顶栏工作台按钮可见）
  const chip = document.querySelector<HTMLButtonElement>('.overview-card .overview-chip')
  assert.ok(chip, '总览卡片应渲染后代会话芯片')
  await act(async () => { chip!.click() })
  await settle()
  assert.ok(document.querySelector('.conversation-drawer'), '点击芯片应打开会话抽屉')
  assert.ok(document.querySelector('.helmx-workbench') === null, '打开抽屉应收起旧工作台（离开抬升态）')

  const workbenchBtn = document.querySelector<HTMLButtonElement>(
    '.conversation-drawer .pane-actions button[aria-label="Workbench"]',
  )
  assert.ok(workbenchBtn, '抽屉顶栏应有工作台按钮')
  await act(async () => { workbenchBtn!.click() })
  await settle()
  assert.ok(document.querySelector('.helmx-workbench'), '抽屉内应能重新打开工作台')
})

test('深链组合态还原抽屉会话的抬升工作台（wb + modal=drawer）', { timeout: 60_000 }, async () => {
  await mountReal('#/c/1?wb=artifacts&modal=drawer&id=11', drawerWorkbenchFixture())
  assert.ok(document.querySelector('.conversation-drawer'), '应渲染抽屉')
  assert.ok(document.querySelector('.helmx-workbench'), '深链应直接还原工作台')
  const tabs = workbenchTabTexts()
  assert.ok(
    tabs.some((text) => text.includes('抽屉专属面板')),
    `深链工作台应绑定抽屉会话 #11，实际页签: ${JSON.stringify(tabs)}`,
  )
})

test('抽屉会话一律不渲染「新话题」按钮：主屏与分屏保留入口', { timeout: 60_000 }, async () => {
  // 抽屉是叠加在主语境之上的检视面（任务会话 / 子代理轨迹 / 总览直达共用），
  // 「新话题」会把底下主屏导航走——不管抽屉里是什么类型的会话都不该出现。
  await mount('#/c/999?split=c/111&modal=drawer&id=111')
  const newTopicButtons = (scope: string): HTMLButtonElement[] =>
    [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)]
      .filter((b) => b.getAttribute('aria-label') === 'New topic')
  assert.equal(newTopicButtons('.conversation-drawer').length, 0, '抽屉内不得渲染新话题按钮')
  assert.equal(newTopicButtons('.helmx-panes > .helmx-pane').length, 1, '主屏保留新话题入口')
  assert.equal(newTopicButtons('.helmx-split-pane').length, 1, '分屏保留新话题入口')
})
