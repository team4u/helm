/**
 * 会话总览（#/overview 只读宿主视图）测试：
 * - 纯函数契约：buildOverviewCards（含安静树、桶序 + createdAt 倒序、后代
 *   芯片信号优先与截断计数、暴露边界继承态势口径、诚实摘要复用）、
 *   filterOverviewCards（桶/角色/节点 AND 组合、quiet 仅在 all、本机节点归一）、
 *   overviewProfileOptions / overviewNodeOptions 去重；
 * - URL：#/overview 解析/序列化往返、hashHasPrimaryTarget、对话空间归属；
 * - 交互：卡片网格渲染与筛选切换、卡面点击复用既有会话抽屉（conversation-drawer
 *   模态进 store 导航态）、后代芯片直达、Rail 总览按钮一键直达与 tone 灯点。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import type { ConversationSummary } from '@helmx/protocol'
import { ARCHIVED_TAG } from '../src/shell/sidebar-model.js'
import type { ConversationBackgroundIndex } from '../src/shell/background-activity-model.js'
import {
  buildOverviewCards,
  filterOverviewCards,
  overviewNodeKey,
  overviewNodeOptions,
  overviewProfileOptions,
  OVERVIEW_DESCENDANT_LIMIT,
} from '../src/overview/overview-model.js'
import { formatLocationHash, hashHasPrimaryTarget, parseLocationHash } from '../src/lib/url-hash-model.js'
import { spaceForTarget } from '../src/lib/types.js'
import { makeTestStore, HelmxExternalStoreContext, type TestStoreOverrides } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { ConversationOverview } = await import('../src/overview/ConversationOverview.js')
const { Sidebar } = await import('../src/shell/Sidebar.js')

function conv(partial: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${partial.id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'zhipu/glm-4.6',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: partial.id * 1000,
    updatedAt: partial.id * 1000,
    ...partial,
  }
}

function buildCards(
  conversations: ConversationSummary[],
  background: ConversationBackgroundIndex = new Map(),
  overrides: { profiles?: Array<{ id: string; name?: string; managedByPlugin?: string }>; plugins?: Array<{ id: string; enabled: boolean }> } = {},
) {
  return buildOverviewCards({
    conversations,
    background,
    profiles: overrides.profiles ?? [],
    plugins: overrides.plugins ?? [],
  })
}

// ---------------------------------------------------------------------------
// 纯函数：卡片构建与排序
// ---------------------------------------------------------------------------

test('buildOverviewCards: attention trees lead, quiet trees follow; bucket order then createdAt descending', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 1, status: 'blocked' }),
    conv({ id: 2, status: 'working' }),
    conv({ id: 3, status: 'done', unread: true }),
    conv({ id: 4, status: 'idle' }),
    conv({ id: 5, status: 'done', unread: false }),
  ])
  assert.deepEqual(
    cards.map((card) => [card.root.id, card.bucket]),
    [
      [1, 'needs_attention'],
      [2, 'running'],
      [3, 'unread_done'],
      [5, 'quiet'],
      [4, 'quiet'],
    ],
    'quiet trees only appear in the overview (never in the attention flat group), still createdAt-descending inside their bucket',
  )
})

test('buildOverviewCards: descendants render signal-first, cap at the limit, hidden count stays honest', { timeout: 60_000 }, () => {
  const members = [
    conv({ id: 1, createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 11, parentConversationId: 1, status: 'idle', createdAt: 9100 }),
    conv({ id: 12, parentConversationId: 1, status: 'blocked', createdAt: 9200 }),
    conv({ id: 13, parentConversationId: 1, status: 'working', createdAt: 9300 }),
    conv({ id: 14, parentConversationId: 1, status: 'idle', createdAt: 9400 }),
    conv({ id: 15, parentConversationId: 1, status: 'idle', createdAt: 9500 }),
    conv({ id: 16, parentConversationId: 1, status: 'idle', createdAt: 9600 }),
    conv({ id: 17, parentConversationId: 1, status: 'idle', createdAt: 9700 }),
  ]
  const cards = buildCards(members)
  assert.equal(cards.length, 1)
  const card = cards[0]!
  assert.equal(card.descendants.length, OVERVIEW_DESCENDANT_LIMIT)
  assert.equal(card.descendants[0]!.conv.id, 13, 'signal descendants (blocked/working) lead; within signals createdAt descending')
  assert.equal(card.descendants[1]!.conv.id, 12)
  assert.equal(card.hiddenDescendantCount, members.length - 1 - OVERVIEW_DESCENDANT_LIMIT)
  assert.equal(card.targetConversationId, 12, 'the direct target is the newest waiting descendant')
  assert.equal(card.summaryText, '2 sub-conversations active', 'honest summary falls back to the active descendant count')
})

test('buildOverviewCards inherits the attention exposure boundaries', { timeout: 60_000 }, () => {
  const archived = buildCards([conv({ id: 1, tags: [ARCHIVED_TAG], status: 'working' })])
  assert.equal(archived.length, 0, 'archived root trees never enter the overview')
  const hidden = buildCards([conv({ id: 2, status: 'working' })], new Map(), {
    profiles: [{ id: 'assistant', managedByPlugin: 'builtin:off' }],
    plugins: [{ id: 'builtin:off', enabled: false }],
  })
  assert.equal(hidden.length, 0, 'trees of profiles hidden behind disabled plugins stay out')
  const named = buildCards(
    [conv({ id: 3, status: 'working', profileId: 'coder' })],
    new Map(),
    { profiles: [{ id: 'coder', name: '编码专员' }] },
  )
  assert.equal(named[0]!.profileLabel, '编码专员')
})

// ---------------------------------------------------------------------------
// 纯函数：筛选
// ---------------------------------------------------------------------------

test('filterOverviewCards: bucket/profile/node AND combos; quiet only in all; local node normalization', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 1, status: 'blocked', profileId: 'assistant' }),
    conv({ id: 2, status: 'working', profileId: 'coder', nodeId: 'remote-1' }),
    conv({ id: 3, status: 'idle', profileId: 'coder' }),
  ])
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'all', profileId: '', nodeId: '' }).map((c) => c.root.id),
    [1, 2, 3],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'needs_attention', profileId: '', nodeId: '' }).map((c) => c.root.id),
    [1],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'all', profileId: 'coder', nodeId: '' }).map((c) => c.root.id),
    [2, 3],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'running', profileId: 'coder', nodeId: 'remote-1' }).map((c) => c.root.id),
    [2],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'running', profileId: 'coder', nodeId: 'local' }).map((c) => c.root.id),
    [],
    'nodeId local aggregates unset node ids; remote trees do not match',
  )
  assert.equal(overviewNodeKey({ nodeId: undefined }), 'local')
  assert.equal(overviewNodeKey({ nodeId: 'remote-1' }), 'remote-1')
  assert.deepEqual(overviewProfileOptions(cards).map((option) => option.id), ['assistant', 'coder'])
  assert.deepEqual(overviewNodeOptions(cards).sort(), ['local', 'remote-1'])
})

// ---------------------------------------------------------------------------
// URL：#/overview 解析与序列化
// ---------------------------------------------------------------------------

test('#/overview parses and serializes round-trip; belongs to the conversations space', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/overview')
  assert.deepEqual(parsed.primaryTarget, { kind: 'overview' })
  assert.equal(hashHasPrimaryTarget('#/overview'), true)
  assert.equal(formatLocationHash({ ...parsed, splitTarget: null, workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null }), '#/overview')
  assert.equal(spaceForTarget({ kind: 'overview' }), 'conversations', 'the overview is a conversations-space host stage')
  const splitParsed = parseLocationHash('#/overview?split=overview')
  assert.deepEqual(splitParsed.splitTarget, { kind: 'overview' }, 'the overview can ride the split pane (same canonical path via the split param)')
})

// ---------------------------------------------------------------------------
// 交互：总览渲染、筛选、抽屉直达与 Rail 入口
// ---------------------------------------------------------------------------

const BASE_PROFILES = [
  { id: 'assistant', name: '个人助理' },
  { id: 'coder', name: '编码专员' },
]

function overviewStore(overrides: TestStoreOverrides = {}): HelmxExternalStore {
  return makeTestStore({ profiles: BASE_PROFILES, ...overrides })
}

function overviewScenarioStore(): HelmxExternalStore {
  return overviewStore({
    conversations: [
      conv({ id: 1, title: '出错的重构', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 11, parentConversationId: 1, title: '待审批子任务', status: 'blocked', createdAt: 9100, updatedAt: 9200 }),
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', doing: '正在检索文档', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 3, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
    ],
    primaryTarget: { kind: 'overview' },
  })
}

test('ConversationOverview renders the card grid with honest facts and reuses the conversation drawer on click', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(ConversationOverview)))
    })
    const cards = container.querySelectorAll('.overview-card')
    assert.equal(cards.length, 3, 'attention trees first, quiet tree last (all filter)')
    assert.ok(cards[0]!.textContent?.includes('出错的重构'), 'the needs-attention tree leads')
    assert.ok(cards[0]!.querySelector('.status-dot-blocked') !== null, 'the representative blocked light renders')
    assert.ok(cards[0]!.textContent?.includes('待审批子任务'), 'the waiting descendant renders as a chip')
    assert.ok(cards[1]!.textContent?.includes('正在检索文档'), 'the running card states the real doing text')
    assert.ok(container.textContent?.includes('3 trees'), 'the stats line counts visible cards')

    await act(async () => {
      ;(cards[0] as HTMLElement).click()
    })
    const modal = store.getNavSlice().activeModal
    assert.deepEqual(
      modal,
      { kind: 'conversation-drawer', conversationId: 11 },
      'clicking the card opens the existing conversation drawer straight at the waiting descendant',
    )

    const chip = container.querySelector<HTMLButtonElement>('.overview-chip')
    assert.ok(chip !== null)
    await act(async () => {
      chip.click()
    })
    assert.deepEqual(
      store.getNavSlice().activeModal,
      { kind: 'conversation-drawer', conversationId: 11 },
      'the descendant chip opens the same real-conversation drawer',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('ConversationOverview hides the unread completion light as soon as the conversation becomes viewed', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    conversations: [
      conv({ id: 8, status: 'done', unread: true }),
      conv({ id: 9, status: 'done', unread: false }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(ConversationOverview)))
    })
    const unreadCard = [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) => card.textContent?.includes('#8'))
    const readCard = [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) => card.textContent?.includes('#9'))
    assert.ok(unreadCard?.querySelector('.status-dot-done'), 'unread completed card has a done light')
    assert.ok(readCard?.querySelector('.status-dot-done') === null, 'read completed card has no unread light')
    await act(async () => store.openTarget({ kind: 'conversation', conversationId: 8 }))
    assert.ok(unreadCard?.querySelector('.status-dot-done') === null, 'opening the conversation hides its light immediately before the PATCH response')
  } finally {
    await act(async () => root?.unmount())
    container.remove()
  }
})

test('ConversationOverview bucket filter narrows the grid (segmented control)', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(ConversationOverview)))
    })
    assert.equal(container.querySelectorAll('.overview-card').length, 3)
    const runningTab = [...container.querySelectorAll('.segmented-control-btn')].find((btn) =>
      btn.textContent?.includes('Running'),
    ) as HTMLElement | undefined
    assert.ok(runningTab !== undefined, 'the segmented bucket filter renders')
    await act(async () => {
      runningTab.click()
    })
    const cards = container.querySelectorAll('.overview-card')
    assert.equal(cards.length, 1)
    assert.ok(cards[0]!.textContent?.includes('在跑的调研'), 'only the running tree stays visible')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('Sidebar rail: the overview button opens #/overview and carries the same-source tone dot', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    conversations: [
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 50, title: '当前查看', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
    })
    const overviewBtn = container.querySelector<HTMLButtonElement>('.rail-overview-btn')
    assert.ok(overviewBtn !== null, 'the host overview entry renders in the rail')
    assert.ok(
      overviewBtn.getAttribute('aria-label')?.includes('Conversation overview'),
      'the tooltip label states the overview',
    )
    assert.ok(overviewBtn.querySelector('.rail-overview-dot[data-tone="running"]') !== null, 'the same-source attention tone dot rides the button')
    await act(async () => {
      overviewBtn.click()
    })
    const primary = store.getPrimaryTarget()
    assert.ok(primary.kind === 'overview', 'clicking navigates to the overview stage')

    // 无信号时灯点不渲染（诚实：无信号不装忙）
    const quiet = overviewStore({
      conversations: [conv({ id: 50, title: '安静', profileId: 'coder' })],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
    })
    const html = renderToString(e(HelmxExternalStoreContext.Provider, { value: quiet }, e(Sidebar)))
    assert.ok(html.includes('rail-overview-btn'), 'the overview button always renders')
    assert.ok(!html.includes('rail-overview-dot'), 'no tone dot without any signal')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// #58 修订：移动端免开汉堡一键直达（根挂载快捷导航簇）与总览数据就绪门
// ---------------------------------------------------------------------------

const { MobileQuickNav } = await import('../src/shell/MobileQuickNav.js')

function stubMatchMedia(matches: boolean): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false
    },
  })) as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}

test('MobileQuickNav: one-tap direct navigation with the shared tone dot; entries hide when their view is already on stage', { timeout: 60_000 }, async () => {
  const restoreMobile = stubMatchMedia(true)
  const store = overviewStore({
    conversations: [
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 2 },
  })
  const quickEntry = {
    key: 'builtin:tasks/task-board',
    pluginId: 'builtin:tasks',
    label: 'Task Board',
    icon: 'check-square',
    order: 5,
    target: { kind: 'screen', pluginId: 'builtin:tasks', screenId: 'board' } as const,
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(
        e(
          HelmxExternalStoreContext.Provider,
          { value: store },
          e(MobileQuickNav, {
            indicator: { needsAttentionCount: 0, runningCount: 1, unreadDoneCount: 0, totalCount: 1, tone: 'running' },
            quickEntry,
          }),
        ),
      )
    })
    const buttons = container.querySelectorAll('.mobile-quick-btn')
    assert.equal(buttons.length, 2, 'quick entry + overview render side by side without opening the drawer')
    assert.ok(buttons[0]!.getAttribute('aria-label') === 'Task Board', 'the quick entry keeps the plugin-provided label')
    const overviewBtn = container.querySelector<HTMLButtonElement>('.mobile-quick-overview-btn')
    assert.ok(overviewBtn !== null)
    assert.ok(
      overviewBtn.getAttribute('aria-label')?.includes('Conversation overview'),
      'the overview button aria states the destination',
    )
    assert.ok(
      overviewBtn.getAttribute('aria-label')?.includes('1 running'),
      'the attention summary rides the overview button aria for screen readers',
    )
    assert.ok(overviewBtn.querySelector('.rail-overview-dot[data-tone="running"]') !== null, 'the tone dot rides the overview button (same as the PC rail, no count badge)')

    const quickBtn = buttons[0] as HTMLElement
    await act(async () => {
      quickBtn.click()
    })
    let primary = store.getPrimaryTarget()
    assert.ok(primary.kind === 'screen' && primary.screenId === 'board', 'one tap enters the first quickEntry view')

    await act(async () => {
      overviewBtn.click()
    })
    primary = store.getPrimaryTarget()
    assert.ok(primary.kind === 'overview', 'one tap on the badge button opens the conversation overview')

    // 无 quickEntry 时只渲染总览按钮；无信号时灯点不渲染（诚实）。
    const quiet = overviewStore({
      conversations: [conv({ id: 50, title: '安静', profileId: 'coder' })],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
    })
    await act(async () => {
      root!.render(
        e(
          HelmxExternalStoreContext.Provider,
          { value: quiet },
          e(MobileQuickNav, {
            indicator: { needsAttentionCount: 0, runningCount: 0, unreadDoneCount: 0, totalCount: 0, tone: null },
            quickEntry: null,
          }),
        ),
      )
    })
    assert.equal(container.querySelectorAll('.mobile-quick-btn').length, 1, 'overview-only cluster without any quickEntry')
    assert.ok(container.querySelector('.rail-overview-dot') === null, 'no tone dot without any signal')

    // 主屏已停在入口目标时对应按钮就地隐藏：总览页只留 quickEntry，
    // quickEntry 视图只留总览；两钮皆隐时整簇不渲染（零占位残留）。
    const renderNav = (store: ReturnType<typeof overviewStore>, entry: typeof quickEntry | null): void => {
      root!.render(
        e(
          HelmxExternalStoreContext.Provider,
          { value: store },
          e(MobileQuickNav, {
            indicator: { needsAttentionCount: 0, runningCount: 1, unreadDoneCount: 0, totalCount: 1, tone: 'running' },
            quickEntry: entry,
          }),
        ),
      )
    }
    await act(async () => {
      renderNav(
        overviewStore({
          conversations: [conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 })],
          primaryTarget: { kind: 'overview' },
        }),
        quickEntry,
      )
    })
    assert.equal(container.querySelectorAll('.mobile-quick-btn').length, 1, 'on the overview screen only the quick entry remains')
    assert.ok(container.querySelector('.mobile-quick-overview-btn') === null, 'the overview button hides when the overview is already on stage')

    await act(async () => {
      renderNav(
        overviewStore({
          conversations: [conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 })],
          primaryTarget: { kind: 'screen', pluginId: 'builtin:tasks', screenId: 'board' },
        }),
        quickEntry,
      )
    })
    assert.equal(container.querySelectorAll('.mobile-quick-btn').length, 1, 'on the quick-entry view only the overview button remains')
    assert.ok(container.querySelector('.mobile-quick-btn')?.getAttribute('aria-label')?.includes('Conversation overview') === true, 'the remaining button is the overview entry')

    await act(async () => {
      renderNav(overviewStore({ primaryTarget: { kind: 'overview' } }), null)
    })
    assert.ok(container.querySelector('.mobile-quick-nav') === null, 'no quickEntry and already on the overview: the whole cluster unmounts')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
    restoreMobile()
  }
})

test('MobileQuickNav renders nothing on desktop viewports (the collapsed rail carries the same entries)', { timeout: 60_000 }, () => {
  const restoreDesktop = stubMatchMedia(false)
  try {
    const html = renderToString(
      e(
        HelmxExternalStoreContext.Provider,
        { value: overviewStore() },
        e(MobileQuickNav, {
          indicator: { needsAttentionCount: 1, runningCount: 0, unreadDoneCount: 0, totalCount: 1, tone: 'blocked' },
          quickEntry: null,
        }),
      ),
    )
    assert.ok(!html.includes('mobile-quick-nav'), 'desktop keeps the root chrome clean')
  } finally {
    restoreDesktop()
  }
})

test('ConversationOverview data-ready gate: loading state before the first snapshot, honest empty only when truly synced', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    // 快照未到（0 会话）且资产/SSE 未就绪：加载态，绝不伪报空。
    const loading = overviewStore({
      conversations: [],
      profilesLoaded: false,
      assetsLoaded: false,
      sseConnected: false,
      primaryTarget: { kind: 'overview' },
    })
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: loading }, e(ConversationOverview)))
    })
    assert.ok(container.textContent?.includes('Loading conversations'), 'pre-snapshot renders the loading state')
    assert.ok(!container.textContent?.includes('No conversations match'), 'never misreports unloaded as empty')

    // 资产 + SSE 双就绪且真实无会话：如实空态（不永久挂加载）。
    const empty = overviewStore({
      conversations: [],
      primaryTarget: { kind: 'overview' },
    })
    await act(async () => {
      root!.render(e(HelmxExternalStoreContext.Provider, { value: empty }, e(ConversationOverview)))
    })
    assert.ok(container.textContent?.includes('No conversations match'), 'a genuinely empty synced workspace shows the honest empty state')
    assert.ok(!container.textContent?.includes('Loading conversations'), 'loading never sticks once data is ready')

    // 有会话即卡片（即使 SSE 瞬时断连也保留快照，不闪加载）。
    const stale = overviewScenarioStore()
    await act(async () => {
      root!.render(e(HelmxExternalStoreContext.Provider, { value: stale }, e(ConversationOverview)))
    })
    assert.ok(container.querySelectorAll('.overview-card').length > 0, 'cards render from the kept snapshot')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})
