/**
 * 全局并发态势（attention）测试：
 * - 纯函数契约：aggregateAttentionTrees（根树聚合、三桶归属、代表位与直达
 *   目标、暴露边界——已归档根树/停用插件托管 Profile 不进态势、sidebarSection
 *   接管的会话仍纳入）、buildAttentionModel（indicator 成员级排除）、
 *   collectViewedConversationIds / resolveGlobalAttentionIndicator（排除正在
 *   查看的根树、tone 优先级 error > blocked > running > done）、
 *   composeHonestTreeSummary / composeAttentionSummary（只列非零桶）；
 * - 命令面板态势优先排序：selectRecentConversationsForPalette 可选 background
 *   索引（需处理 > 运行中 > 未读完成 > 其余按 updatedAt 倒序）；
 * - Sidebar 渲染与交互：会话总览脉冲入口挂在待审批下方、智能体站位上方，
 *   同源 tone 灯点与真实摘要副文、全安静时零灯零副文、点击直达 #/overview、
 *   分屏按钮钉右分屏、Rail「会话总览」按钮同源态势微标与 aria 摘要；
 * - 挂载路径：useGlobalAttention 自洽发现并按需加载 workbench badge doc
 *   （移动端合着抽屉也不漏后台任务）；
 * - 命令面板渲染：会话行（最近 + 匹配）行首灯槽对齐展示 ConversationStatusDot。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConversationSummary, PluginUiContribution, ScreenSpec, SidebarItemBadgeSpec, SidebarItemSpec, WorkbenchPanelSpec } from '@helmx/protocol'
import { ARCHIVED_TAG, type SidebarViewItem } from '../src/shell/sidebar-model.js'
import type { ConversationBackgroundIndex } from '../src/shell/background-activity-model.js'
import {
  aggregateAttentionTrees,
  buildAttentionModel,
  collectViewedConversationIds,
  composeAttentionSummary,
  composeHonestTreeSummary,
  resolveGlobalAttentionIndicator,
  type GlobalAttentionIndicator,
} from '../src/shell/attention-model.js'
import { selectRecentConversationsForPalette } from '../src/shell/shortcuts-model.js'
import { makeTestStore, HelmxExternalStoreContext, type TestStoreOverrides } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { Sidebar } = await import('../src/shell/Sidebar.js')
const { CommandPaletteModal } = await import('../src/modals/CommandPaletteModal.js')

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

/** 无翻译器调用（英文桥接）时的根树聚合捷径。 */
function aggregate(
  conversations: ConversationSummary[],
  background: ConversationBackgroundIndex = new Map(),
  overrides: {
    profiles?: Array<{ id: string; name?: string; managedByPlugin?: string }>
    plugins?: Array<{ id: string; enabled: boolean }>
  } = {},
) {
  return aggregateAttentionTrees({
    conversations,
    background,
    profiles: overrides.profiles ?? [],
    plugins: overrides.plugins ?? [],
  })
}

/** 无翻译器调用（英文桥接）时的微标构建捷径（成员级排除语义）。 */
function buildIndicator(
  conversations: ConversationSummary[],
  viewedConversationIds: ReadonlySet<number>,
  background: ConversationBackgroundIndex = new Map(),
): GlobalAttentionIndicator {
  return buildAttentionModel({
    conversations,
    background,
    profiles: [],
    plugins: [],
    viewedConversationIds,
  })
}

// ---------------------------------------------------------------------------
// 纯函数：三桶归属与根树聚合
// ---------------------------------------------------------------------------

test('tree aggregation: descendants roll up to the root tree; pendingAskCount counts as waiting; working child outranks the unread-done root', { timeout: 60_000 }, () => {
  const trees = aggregate([
    conv({ id: 1, status: 'done', unread: true, createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 11, parentConversationId: 1, status: 'blocked', updatedAt: 9100 }),
    conv({ id: 12, parentConversationId: 11, status: 'idle' }),
    conv({ id: 2, status: 'idle', createdAt: 8000 }),
    conv({ id: 21, parentConversationId: 2, pendingAskCount: 1, status: 'idle' }),
  ])
  assert.equal(trees.length, 2, 'both roots keep exactly one aggregated tree each (grandchildren roll up too)')
  const first = trees[0]!
  assert.equal(first.root.id, 1)
  assert.equal(first.hasError, false)
  assert.equal(first.bucket, 'needs_attention', 'a blocked descendant needs attention even under an unread-done root')
  assert.equal(first.representative.id, 11, 'the representative is the highest-priority member (blocked outranks done)')
  assert.equal(first.targetConversationId, 11, 'click jumps straight to the blocked descendant (the approval spot)')
  assert.equal(first.activeDescendantCount, 1, 'the blocked descendant counts; idle ones do not')
  const second = trees[1]!
  assert.equal(second.bucket, 'needs_attention', 'pendingAskCount > 0 counts as waiting for human')
  assert.equal(second.targetConversationId, 21, 'the pending-ask member is the direct target')
  // 安静树（bucket === null）也产出：总览「全部」视图需要，绝不失明。
  const quiet = aggregate([conv({ id: 3, status: 'idle' }), conv({ id: 4, status: 'done', unread: false })])
  assert.deepEqual(quiet.map((tree) => tree.bucket), [null, null], 'silent trees surface with a null bucket for the overview')
})

test('exposure boundaries: archived roots and disabled-plugin-managed profiles stay out; sidebarSection-tagged active conversations stay in', { timeout: 60_000 }, () => {
  const archived = aggregate([
    conv({ id: 1, tags: [ARCHIVED_TAG], status: 'working' }),
    conv({ id: 11, parentConversationId: 1, status: 'blocked' }),
  ])
  assert.equal(archived.length, 0, 'an archived root tree never enters attention even with active descendants')

  const hiddenByPlugin = aggregate(
    [conv({ id: 2, status: 'working' })],
    new Map(),
    {
      profiles: [{ id: 'assistant', name: '个人助理', managedByPlugin: 'builtin:off' }],
      plugins: [{ id: 'builtin:off', enabled: false }],
    },
  )
  assert.equal(hiddenByPlugin.length, 0, 'a profile hidden behind a disabled plugin hides its tree')

  const shownByPlugin = aggregate(
    [conv({ id: 3, status: 'working' })],
    new Map(),
    {
      profiles: [{ id: 'assistant', name: '个人助理', managedByPlugin: 'builtin:on' }],
      plugins: [{ id: 'builtin:on', enabled: true }],
    },
  )
  assert.equal(shownByPlugin.length, 1, 'an enabled managed profile keeps its tree visible')

  const sectionTagged = aggregate([conv({ id: 4, tags: ['task'], status: 'working' })])
  assert.equal(sectionTagged.length, 1, 'conversations taken over by sidebar sections still surface in attention')
})

test('honest summaries: lastError / doing / background summary / descendant count, in that priority; nothing is fabricated', { timeout: 60_000 }, () => {
  const summarize = (partial: Partial<ConversationSummary> & { id: number }): string =>
    composeHonestTreeSummary({
      representative: conv(partial),
      backgroundActive: false,
      backgroundSummary: '',
      activeDescendantCount: 0,
    })
  assert.equal(summarize({ id: 1, status: 'error', lastError: 'model_error: boom' }), 'model_error: boom')
  assert.equal(summarize({ id: 2, status: 'working', doing: '正在重构解析器' }), '正在重构解析器')
  assert.equal(summarize({ id: 5, status: 'done', unread: true }), '', 'an unread completion fabricates no progress text')

  // 后台摘要：代表位安静且后台在途时如实呈现 badge footer。
  assert.equal(
    composeHonestTreeSummary({
      representative: conv({ id: 3, status: 'idle' }),
      backgroundActive: true,
      backgroundSummary: '2 Running',
      activeDescendantCount: 0,
    }),
    '2 Running',
  )
  // 后代运行计数：无 doing 文本的工作后代回退到真实计数（英文桥接文案）。
  assert.equal(
    composeHonestTreeSummary({
      representative: conv({ id: 4, status: 'idle' }),
      backgroundActive: false,
      backgroundSummary: '',
      activeDescendantCount: 2,
    }),
    '2 sub-conversations active',
  )
  // 聚合链路：idle 根 + 后台在途后代 → bucket=running 且摘要取后台事实。
  const background = new Map([[3, { active: true, summary: '2 Running' }]] as const)
  const backgroundTree = aggregate([conv({ id: 3, status: 'idle' })], background)[0]!
  assert.equal(backgroundTree.bucket, 'running')
  assert.equal(backgroundTree.backgroundActive, true)
  assert.equal(backgroundTree.backgroundSummary, '2 Running')
})

test('representative and target selection are deterministic on recency ties', { timeout: 60_000 }, () => {
  const trees = aggregate([
    conv({ id: 1, status: 'idle', createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 11, parentConversationId: 1, status: 'blocked', createdAt: 9100, updatedAt: 9500 }),
    conv({ id: 12, parentConversationId: 1, status: 'blocked', createdAt: 9200, updatedAt: 9500 }),
  ])
  const tree = trees[0]!
  assert.equal(tree.representative.id, 12, 'equal updatedAt keeps the higher id (deterministic)')
  assert.equal(tree.targetConversationId, 12, 'the most recently updated blocked conversation is the direct jump target')
})

// ---------------------------------------------------------------------------
// 纯函数：indicator（微标聚合）与摘要
// ---------------------------------------------------------------------------

test('collectViewedConversationIds: exact main/split conversation ids (member-level, no root rollup)', { timeout: 60_000 }, () => {
  const viewed = collectViewedConversationIds({
    primaryTarget: { kind: 'conversation', conversationId: 11 },
    splitTarget: { kind: 'conversation', conversationId: 2 },
  })
  assert.deepEqual([...viewed].sort((a, b) => a - b), [2, 11], 'only the exact viewed conversations are excluded, never the whole root tree')
  const nonConversation = collectViewedConversationIds({
    primaryTarget: { kind: 'agent', profileId: 'assistant' },
    splitTarget: null,
  })
  assert.equal(nonConversation.size, 0, 'agent/screen targets exclude nothing')
})

test('resolveGlobalAttentionIndicator: aggregate-all counting with tone priority error > blocked > running > done', { timeout: 60_000 }, () => {
  const entries = [
    { bucket: 'needs_attention' as const, tone: 'error' as const },
    { bucket: 'needs_attention' as const, tone: 'blocked' as const },
    { bucket: 'running' as const, tone: 'running' as const },
    { bucket: 'unread_done' as const, tone: 'done' as const },
  ]
  const full = resolveGlobalAttentionIndicator(entries)
  assert.deepEqual(
    [full.needsAttentionCount, full.runningCount, full.unreadDoneCount, full.totalCount, full.tone],
    [2, 1, 1, 4, 'error'],
    'error outranks every other tone',
  )
  assert.equal(resolveGlobalAttentionIndicator([]).tone, null)
})

test('member-level exclusion: viewing one descendant never erases a sibling ask in the same root tree', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, status: 'idle', createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 11, parentConversationId: 1, status: 'blocked', createdAt: 9100, updatedAt: 9100 }),
    conv({ id: 12, parentConversationId: 1, status: 'blocked', createdAt: 9200, updatedAt: 9200 }),
  ]
  // Viewing descendant 11 (main) while sibling 12 still waits: the badge must keep alerting.
  const siblingWaiting = buildIndicator(conversations, new Set([11]))
  assert.equal(siblingWaiting.needsAttentionCount, 1, 'the sibling blocked ask keeps the badge counting')
  assert.equal(siblingWaiting.tone, 'blocked')
  // Viewing the only waiting member: the tree's whole signal sits on the viewed conversation -> silent.
  const allViewed = buildIndicator(conversations, new Set([11, 12]))
  assert.equal(allViewed.totalCount, 0, 'no self-alerting when every signal is on the viewed conversation')
  assert.equal(allViewed.tone, null)
  // Viewed root with an un-viewed working child: the running fact still counts.
  const rootViewed = buildIndicator(
    [
      conv({ id: 2, status: 'idle', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 21, parentConversationId: 2, status: 'working', createdAt: 8100, updatedAt: 8100 }),
    ],
    new Set([2]),
  )
  assert.equal(rootViewed.runningCount, 1, 'viewing the root does not erase the running descendant')
  // Viewed unread-done root: read-on-view honestly silences only that tree.
  const unreadRoot = buildIndicator([conv({ id: 3, status: 'done', unread: true })], new Set([3]))
  assert.equal(unreadRoot.totalCount, 0, 'viewing the unread completion drops it from the badge')
  // error 树在 waiting 树之上有最高 tone 优先级（error > blocked）。
  const errorTree = buildIndicator([conv({ id: 4, status: 'error', lastError: 'boom' }), conv({ id: 5, status: 'blocked' })], new Set())
  assert.equal(errorTree.tone, 'error', 'an error tree outranks blocked trees in the aggregate tone')
})

test('composeAttentionSummary lists only non-zero buckets', { timeout: 60_000 }, () => {
  assert.equal(composeAttentionSummary({ needsAttentionCount: 2, runningCount: 0, unreadDoneCount: 3, totalCount: 5, tone: 'error' }), '2 need attention · 3 unread completed')
  assert.equal(composeAttentionSummary({ needsAttentionCount: 0, runningCount: 0, unreadDoneCount: 0, totalCount: 0, tone: null }), '')
})

// ---------------------------------------------------------------------------
// 命令面板态势优先排序（纯函数）
// ---------------------------------------------------------------------------

test('selectRecentConversationsForPalette: attention tiers first (error/blocked > working/background > done+unread), the rest stay updatedAt-descending', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, status: 'idle', updatedAt: 9000 }),
    conv({ id: 2, status: 'done', unread: true, updatedAt: 8900 }),
    conv({ id: 3, status: 'working', updatedAt: 8800 }),
    conv({ id: 4, status: 'idle', updatedAt: 8700 }),
    conv({ id: 5, status: 'blocked', updatedAt: 8600 }),
    conv({ id: 6, status: 'error', updatedAt: 8500 }),
    conv({ id: 7, status: 'idle', updatedAt: 8400 }),
  ]
  const background = new Map([[1, { active: true, summary: '1 Running' }]] as const)
  const ordered = selectRecentConversationsForPalette(conversations, undefined, 10, background)
  assert.deepEqual(
    ordered.map((c) => c.id),
    [5, 6, 1, 3, 2, 4, 7],
    'error and blocked lead (recency within the tier), then background-in-flight and working, then unread completion, then plain recency',
  )
  const withoutBackground = selectRecentConversationsForPalette(conversations, undefined, 10)
  assert.deepEqual(
    withoutBackground.map((c) => c.id),
    [5, 6, 3, 2, 1, 4, 7],
    'without a background index the idle conversation falls back to plain recency (compatible signature)',
  )
  const excluded = selectRecentConversationsForPalette(conversations, 6, 3, background)
  assert.deepEqual(
    excluded.map((c) => c.id),
    [5, 1, 3],
    'the active conversation is excluded and the limit applies after ordering',
  )
})

// ---------------------------------------------------------------------------
// Sidebar 渲染：会话总览脉冲入口与 Rail 微标
// ---------------------------------------------------------------------------

const BASE_PROFILES = [
  { id: 'assistant', name: '个人助理' },
  { id: 'coder', name: '编码专员' },
]

function sidebarStore(overrides: TestStoreOverrides = {}): HelmxExternalStore {
  return makeTestStore({ profiles: BASE_PROFILES, ...overrides })
}

function renderSidebar(store: HelmxExternalStore): string {
  return renderToString(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
}

function attentionScenarioStore(): HelmxExternalStore {
  return sidebarStore({
    conversations: [
      conv({ id: 1, title: '出错的重构', profileId: 'assistant', status: 'idle', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 11, parentConversationId: 1, title: '子任务', status: 'error', lastError: 'model_error: boom', createdAt: 9100, updatedAt: 9100 }),
      conv({ id: 12, parentConversationId: 1, title: '待审批子任务', status: 'blocked', createdAt: 9150, updatedAt: 9200 }),
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', doing: '正在检索文档', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 50, title: '当前查看', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
  })
}

test('Sidebar header keeps the overview icon button next to the command palette search, with the same-source count badge', { timeout: 60_000 }, () => {
  const html = renderSidebar(attentionScenarioStore())
  const btnIdx = html.indexOf('sidebar-overview-open-btn')
  const headerIdx = html.indexOf('sidebar-header')
  const scrollIdx = html.indexOf('sidebar-scroll')
  const searchIdx = html.indexOf('aria-label="Open Cmd K global search')
  assert.ok(searchIdx > 0, 'the command palette search button renders')
  assert.ok(btnIdx > 0, 'the overview header button renders')
  assert.ok(headerIdx > 0 && btnIdx > headerIdx && (scrollIdx < 0 || btnIdx < scrollIdx), 'the button lives in the sidebar header, not the list body')
  assert.ok(btnIdx > searchIdx && btnIdx - searchIdx < 900, 'the button sits right after the command palette search button')
  const btn = html.match(/<button[^>]*class="[^"]*sidebar-overview-open-btn[^"]*"[^>]*>/)?.[0] ?? ''
  assert.ok(btn !== '', 'the button carries its stable class hook')
  // 同源计数徽标：有信号时随钮渲染（overview-count-badge 同一词汇与事实
  // 源，计数 = 有信号的树数）；全安静时零徽标（不装忙）。
  const btnEnd = html.indexOf('</button>', btnIdx)
  const btnInner = html.slice(btnIdx, btnEnd < 0 ? undefined : btnEnd)
  assert.ok(btnInner.includes('overview-count-badge'), 'the same-source count badge rides the header button when a tree has a signal')
  assert.ok(btnInner.includes('data-tone="error"'), 'the badge states the honest top tone (error leads the scenario)')
  assert.ok(btnInner.includes('>2<'), 'the badge states the honest signal-tree count (error tree + working tree)')
  const quietHtml = renderSidebar(
    sidebarStore({
      conversations: [
        conv({ id: 50, title: '当前查看', profileId: 'coder', status: 'idle' }),
        conv({ id: 51, title: '安静', profileId: 'coder', status: 'done', unread: false }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
    }),
  )
  const quietBtnStart = quietHtml.indexOf('sidebar-overview-open-btn')
  const quietBtnEnd = quietHtml.indexOf('</button>', quietBtnStart)
  const quietInner = quietHtml.slice(quietBtnStart, quietBtnEnd < 0 ? undefined : quietBtnEnd)
  assert.ok(quietBtnStart > 0 && !quietInner.includes('overview-count-badge'), 'no count badge without any signal (honest quiet)')
  assert.ok(!html.includes('sidebar-overview-entry'), 'the pulse entry row is gone for good')
  assert.ok(!html.includes('sidebar-attention-group'), 'the legacy flat attention group is gone for good')
  assert.ok(!html.includes('attention-row'), 'no legacy attention row residue')
})

test('interaction: clicking the header overview button opens #/overview and lights the button active', { timeout: 60_000 }, async () => {
  const store = attentionScenarioStore()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
    })
    const btn = container.querySelector<HTMLButtonElement>('.sidebar-overview-open-btn')
    assert.ok(btn !== null, 'the header overview button renders')
    // 主屏不在总览：无激活态（不点亮、无 aria-current）。
    assert.ok(btn.classList.contains('is-active') === false, 'the button stays inert outside the overview stage')
    assert.ok(btn.getAttribute('aria-current') === null, 'no aria-current outside the overview stage')
    await act(async () => {
      btn.click()
    })
    const primary = store.getPrimaryTarget()
    assert.ok(primary.kind === 'overview', 'clicking the header button navigates to the overview stage')
    // 主屏停在总览：入口点亮（is-active + aria-current="page"），用户在大堂时
    // 一眼知道自己在大堂。
    const btnAfter = container.querySelector<HTMLButtonElement>('.sidebar-overview-open-btn')
    assert.ok(btnAfter !== null)
    assert.ok(btnAfter.classList.contains('is-active') === true, 'the button lights up while the overview is the primary stage')
    assert.ok(btnAfter.getAttribute('aria-current') === 'page', 'the active button carries aria-current="page"')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 挂载路径：useGlobalAttention 自洽发现并按需加载 badge doc
// ---------------------------------------------------------------------------

test('Sidebar mount path: the attention hook discovers workbench badge docs and loads them on demand', { timeout: 60_000 }, async () => {
  const WORKFLOW_PANEL_SPEC: WorkbenchPanelSpec = {
    id: 'tasks',
    label: '工作流与子代理',
    badge: { doc: 'run-badges', byConversationField: 'byConversation' },
  }
  const contribution: PluginUiContribution = {
    pluginId: 'builtin:workflow',
    surface: 'workbench.panel',
    spec: WORKFLOW_PANEL_SPEC,
  }
  const docUrls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    docUrls.push(url)
    return new Response(JSON.stringify({ key: 'stub', value: { byConversation: {} } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const store = sidebarStore({
    plugins: [{ id: 'builtin:workflow', name: 'Workflow', version: '0.0.0', enabled: true, locked: false, hooks: [], actions: [], tools: [] }],
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [contribution],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
    })
    assert.deepEqual(docUrls, ['/api/plugins/builtin%3Aworkflow/docs/run-badges'], 'the hook loads the needed badge doc itself (drawer-independent)')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 命令面板渲染：会话行行首灯槽对齐展示状态点
// ---------------------------------------------------------------------------

test('CommandPaletteModal: recent conversation rows render the status dot in the leading light slot and order attention first', { timeout: 60_000 }, async () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '报错的会话', profileId: 'assistant', status: 'error', lastError: 'model_error: boom', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 8000, updatedAt: 9500 }),
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
      root.render(
        e(HelmxExternalStoreContext.Provider, { value: store }, e(CommandPaletteModal, { onClose: () => {} })),
      )
    })
    const recentRows = [...document.body.querySelectorAll('.modal .nav-item')].filter((row) =>
      row.textContent?.includes('Recent conversation #'),
    )
    assert.ok(recentRows.length >= 2, 'both recent rows render inside the dialog portal')
    const first = recentRows[0]!
    const second = recentRows[1]!
    assert.ok(first.textContent?.includes('Recent conversation #1'), 'the error conversation leads regardless of the newer updatedAt on the idle one')
    assert.ok(second.textContent?.includes('Recent conversation #2'))
    assert.ok(
      first.querySelector('.nav-status-slot .status-dot-error') !== null,
      'the row-leading light slot aligns the error status dot',
    )
    assert.ok(
      second.querySelector('.nav-status-slot .status-dot') === null,
      'an idle conversation without background work keeps its empty light slot (no fabricated light)',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 插件全局快捷入口（sidebar.item quickEntry → Activity Rail）
// ---------------------------------------------------------------------------

const { extractRailQuickEntries } = await import('../src/shell/sidebar-model.js')

function sidebarItemContribution(overrides: { pluginId?: string; spec?: Record<string, unknown> } = {}): PluginUiContribution {
  return {
    pluginId: overrides.pluginId ?? 'builtin:tasks',
    surface: 'sidebar.item',
    spec: {
      id: 'task-board',
      label: { en: 'Task Board', 'zh-CN': '任务看板' },
      icon: 'check-square',
      target: 'screen:builtin:tasks/board',
      order: 5,
      quickEntry: true,
      ...overrides.spec,
    },
  }
}

function screenContribution(overrides: { pluginId?: string; spec?: Record<string, unknown> } = {}): PluginUiContribution {
  return {
    pluginId: overrides.pluginId ?? 'builtin:tasks',
    surface: 'screen',
    spec: { id: 'board', label: { en: 'Task Board', 'zh-CN': '任务看板' }, icon: 'check-square', ...overrides.spec },
  }
}

test('extractRailQuickEntries: only screen-backed quickEntry items pass; missing screens and non-quick items never leak', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 })]
  const items = [
    sidebarItemContribution(),
    sidebarItemContribution({
      pluginId: 'other',
      spec: { id: 'plain', label: { en: 'Plain' }, target: 'screen:other/view', quickEntry: false },
    }),
    sidebarItemContribution({ spec: { id: 'no-target', label: { en: 'No Target' }, quickEntry: false } }),
    sidebarItemContribution({ spec: { id: 'conv-target', label: { en: 'Conv' }, target: 'conversation:1', quickEntry: false } }),
    sidebarItemContribution({ spec: { id: 'ghost-screen', label: { en: 'Ghost' }, target: 'screen:builtin:tasks/ghost', quickEntry: false } }),
  ]
  const screens = [screenContribution(), screenContribution({ pluginId: 'other', spec: { id: 'view', label: { en: 'Other View' } } })]
  const qualifiedItems = items.map((item) => ({ pluginId: item.pluginId, spec: item.spec as SidebarItemSpec }))
  const qualifiedScreens = screens.map((item) => ({ pluginId: item.pluginId, spec: item.spec as ScreenSpec }))
  const entries = extractRailQuickEntries(qualifiedItems, qualifiedScreens, conversations, 'en')
  assert.equal(entries.length, 1, 'only the screen-backed quickEntry item surfaces (non-quick screen items and quick items without a real screen never leak)')
  assert.equal(entries[0]!.label, 'Task Board')
  assert.equal(entries[0]!.icon, 'check-square')
  assert.equal(entries[0]!.order, 5)
  assert.equal(entries[0]!.target.kind, 'screen')
  const zhEntries = extractRailQuickEntries(qualifiedItems, qualifiedScreens, conversations, 'zh-CN')
  assert.equal(zhEntries[0]!.label, '任务看板', 'labels resolve per locale')
})

test('Sidebar renders rail quick entries and disables with the plugin contributions (store.live SSE path)', { timeout: 60_000 }, async () => {
  const store = sidebarStore({
    plugins: [{ id: 'builtin:tasks', name: 'Tasks', version: '0.0.0', enabled: true, locked: false, hooks: [], actions: [], tools: [] }],
    conversations: [conv({ id: 50, title: '当前查看', profileId: 'coder' })],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [sidebarItemContribution(), screenContribution()],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
    })
    const quickBtn = container.querySelector<HTMLButtonElement>('.rail-quick-btn')
    assert.ok(quickBtn !== null, 'the quick entry renders in the activity rail')
    assert.ok(quickBtn.getAttribute('aria-label') === 'Task Board', 'the entry uses the plugin-provided localized label')
    await act(async () => {
      quickBtn.click()
    })
    const primary = store.getPrimaryTarget()
    assert.ok(primary.kind === 'screen' && primary.pluginId === 'builtin:tasks' && primary.screenId === 'board', 'clicking navigates via the standard store routing')

    // Simulate the SSE path of a disabled plugin: contributions vanish from the live state -> zero residue.
    await act(async () => {
      store.updateLive((state) => ({ ...state, uiContributions: [] }))
    })
    assert.equal(container.querySelectorAll('.rail-quick-btn').length, 0, 'a disabled plugin leaves no phantom quick entry')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 移动端抽屉：对话空间顶部保留总览脉冲入口（拉开汉堡即可一键行动）
// ---------------------------------------------------------------------------

function stubMobileMatchMedia(): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: query.includes('680'),
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

test('the overview entry mounts only in the conversations space (mobile drawer included)', { timeout: 60_000 }, () => {
  const htmlInViewsSpace = (mobile: boolean): string => {
    const restore = mobile ? stubMobileMatchMedia() : undefined
    try {
      return renderSidebar(
        sidebarStore({
          conversations: [
            conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
            conv({ id: 50, title: '当前查看', profileId: 'coder', status: 'idle' }),
          ],
          primaryTarget: { kind: 'screen', pluginId: 'builtin:tasks', screenId: 'board' },
        }),
      )
    } finally {
      restore?.()
    }
  }
  assert.ok(!htmlInViewsSpace(true).includes('sidebar-overview-open-btn'), 'mobile: the views space keeps its own header without the overview button')
  assert.ok(!htmlInViewsSpace(false).includes('sidebar-overview-open-btn'), 'desktop: the views space stays clean')
  const restoreMobile = stubMobileMatchMedia()
  try {
    const html = renderSidebar(
      sidebarStore({
        conversations: [conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 })],
        primaryTarget: { kind: 'conversation', conversationId: 2 },
      }),
    )
    assert.ok(html.includes('sidebar-overview-open-btn'), 'the conversations space (mobile drawer included) still shows the overview header button')
  } finally {
    restoreMobile()
  }
})

// ---------------------------------------------------------------------------
// 命令面板：全部插件视图可搜、可直达
// ---------------------------------------------------------------------------

test('CommandPaletteModal: all plugin views are searchable rows and open via the standard routing', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const store = sidebarStore({
    plugins: [{ id: 'builtin:tasks', name: { en: 'Tasks', 'zh-CN': '任务' }, version: '0.0.0', enabled: true, locked: false, hooks: [], actions: [], tools: [] }],
    conversations: [conv({ id: 50, title: '当前查看', profileId: 'coder' })],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [sidebarItemContribution(), screenContribution()],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(CommandPaletteModal, { onClose: () => {} })))
    })
    let viewRow = [...document.body.querySelectorAll('.modal .nav-item')].find((row) => row.textContent?.includes('Task Board'))
    assert.ok(viewRow !== undefined, 'the plugin view row renders in the empty-query palette')
    assert.ok(viewRow.textContent?.includes('Tasks'), 'the row hints the owning plugin display name')

    // Search narrows to the view row (Cmd+K finds every plugin view).
    const input = document.body.querySelector<HTMLInputElement>('.modal .search-box input')
    assert.ok(input !== null)
    await act(async () => {
      input.value = 'board'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    viewRow = [...document.body.querySelectorAll('.modal .nav-item')].find((row) => row.textContent?.includes('Task Board'))
    assert.ok(viewRow !== undefined, 'typing the view name keeps the view row visible')

    const rowElement = viewRow as HTMLElement
    await act(async () => {
      rowElement.click()
    })
    const primary = store.getPrimaryTarget()
    assert.ok(primary.kind === 'screen' && primary.screenId === 'board', 'selecting the view row navigates to the screen')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 插件 SDK 共享宿主后台在途快照（useConversationBackground 经真实桥）
// ---------------------------------------------------------------------------

const { HostStoreProviders } = await import('./helpers/host-store.js')
const { useConversationBackground } = await import('@helmx/plugin-client')

test('useConversationBackground via the real host bridge: badge docs hydrate entries; missing docs report unknown', { timeout: 60_000 }, () => {
  const WORKFLOW_PANEL_SPEC2: WorkbenchPanelSpec = {
    id: 'tasks',
    label: '工作流与子代理',
    badge: { doc: 'run-badges', byConversationField: 'byConversation' },
  }
  const panelContribution2: PluginUiContribution = {
    pluginId: 'builtin:workflow',
    surface: 'workbench.panel',
    spec: WORKFLOW_PANEL_SPEC2,
  }
  const plugins = [{ id: 'builtin:workflow', name: 'Workflow', version: '0.0.0', enabled: true, locked: false, hooks: [], actions: [], tools: [] }]
  const conversations = [conv({ id: 1, title: '主会话', profileId: 'assistant' })]
  const captured: Array<{ unknown: boolean; active: boolean | undefined; summary: string | undefined }> = []

  function Probe(): React.ReactNode {
    const snapshot = useConversationBackground()
    const entry = snapshot.byConversation.get(1)
    captured.push({ unknown: snapshot.unknown, active: entry?.active, summary: entry?.summary })
    return null
  }

  const unloaded = makeTestStore({ plugins, conversations, uiContributions: [panelContribution2] })
  renderToString(e(HostStoreProviders, { value: unloaded }, e(Probe)))
  assert.ok(captured.at(-1)!.unknown === true, 'badge doc not yet loaded: facts are unknown, never "no background work"')
  assert.ok(captured.at(-1)!.active === undefined)

  const loaded = makeTestStore({
    plugins,
    conversations,
    uiContributions: [panelContribution2],
    pluginDocs: { 'builtin:workflow/run-badges': { byConversation: { '1': { count: 2, tone: 'accent', footerText: '2 Running' } } } },
  })
  renderToString(e(HostStoreProviders, { value: loaded }, e(Probe)))
  const last = captured.at(-1)!
  assert.ok(last.unknown === false, 'hydrated badge docs flip the snapshot to known')
  assert.ok(last.active === true && last.summary === '2 Running', 'the entry carries the host-standard aggregation verdict')
})

// ---------------------------------------------------------------------------
// 侧栏视图徽标（sidebar.item badge 声明：纯函数 + Activity Rail / 视图行渲染）
// ---------------------------------------------------------------------------

const {
  collectSidebarBadgeDocs,
  composeSidebarBadgeLabel,
  resolveSidebarItemBadge,
  sidebarBadgeCountLabel,
  sidebarBadgeToneClass,
} = await import('../src/shell/sidebar-model.js')

const TASK_BADGE_SPEC: SidebarItemBadgeSpec = {
  doc: 'task-board',
  countField: 'attentionCount',
  toneField: 'badgeTone',
  dotField: 'hasRunning',
  summaryField: 'badgeSummary',
}

function viewItem(overrides: Partial<SidebarViewItem> = {}): SidebarViewItem {
  return {
    key: 'builtin:tasks/task-board',
    pluginId: 'builtin:tasks',
    label: 'Task Board',
    icon: 'check-square',
    order: 5,
    target: { kind: 'screen', pluginId: 'builtin:tasks', screenId: 'board' },
    badge: TASK_BADGE_SPEC,
    ...overrides,
  }
}

test('resolveSidebarItemBadge: count badge, tone fallback, quiet dot, LocalizedText summary, zero-noise null', { timeout: 60_000 }, () => {
  // 计数 > 0：count 徽标，tone 用 doc 提供的合法值
  assert.deepEqual(resolveSidebarItemBadge(TASK_BADGE_SPEC, { attentionCount: 3, badgeTone: 'error', badgeSummary: '2 awaiting review' }, 'en'), {
    count: 3,
    tone: 'error',
    dot: false,
    summary: '2 awaiting review',
  })
  // tone 非法/缺省回落 warn；summary 缺省为空串；小数计数向下取整
  assert.deepEqual(resolveSidebarItemBadge(TASK_BADGE_SPEC, { attentionCount: 2.9, badgeTone: 'bogus' }, 'en'), {
    count: 2,
    tone: 'warn',
    dot: false,
    summary: '',
  })
  // LocalizedText summary 按 locale 解析
  assert.deepEqual(
    resolveSidebarItemBadge(TASK_BADGE_SPEC, { attentionCount: 1, badgeSummary: { en: '1 needs you', 'zh-CN': '1 待处理' } }, 'zh-CN'),
    { count: 1, tone: 'warn', dot: false, summary: '1 待处理' },
  )
  // count 为 0 且 dotField 为 true：静默灯点（tone 回落 accent）
  assert.deepEqual(resolveSidebarItemBadge(TASK_BADGE_SPEC, { attentionCount: 0, hasRunning: true }, 'en'), {
    count: 0,
    tone: 'accent',
    dot: true,
    summary: '',
  })
  // dot 模式下 doc 提供合法 tone 时尊重之
  assert.deepEqual(resolveSidebarItemBadge(TASK_BADGE_SPEC, { attentionCount: 0, hasRunning: true, badgeTone: 'ok' }, 'en'), {
    count: 0,
    tone: 'ok',
    dot: true,
    summary: '',
  })
  // 全部无信号：null（含 doc 未加载 undefined、空对象、非对象、数组、负数/NaN 计数、dotField false）
  for (const docValue of [undefined, null, {}, [], 5, 'text', { attentionCount: 0 }, { attentionCount: -1 }, { attentionCount: Number.NaN }, { hasRunning: false }, { attentionCount: '3' }]) {
    assert.equal(
      resolveSidebarItemBadge(TASK_BADGE_SPEC, docValue, 'en'),
      null,
      `docValue=${JSON.stringify(docValue) ?? String(docValue)}`,
    )
  }
  // 未声明 dotField 时 count 为 0 一律 null（无灯点通道）
  assert.equal(resolveSidebarItemBadge({ doc: 'd', countField: 'c' }, { c: 0, d: true }, 'en'), null)
  // 未声明 toneField/summaryField 时只读计数
  assert.deepEqual(resolveSidebarItemBadge({ doc: 'd', countField: 'c' }, { c: 4 }, 'en'), { count: 4, tone: 'warn', dot: false, summary: '' })
  // 99+ 上限折叠为文本标签（纯展示层，不造假计数）
  assert.equal(sidebarBadgeCountLabel(99), '99')
  assert.equal(sidebarBadgeCountLabel(100), '99+')
  assert.equal(sidebarBadgeCountLabel(1000), '99+')
  // tone -> badge 语义类映射
  assert.equal(sidebarBadgeToneClass('error'), 'badge-err')
  assert.equal(sidebarBadgeToneClass('warn'), 'badge-warn')
  assert.equal(sidebarBadgeToneClass('accent'), 'badge-accent')
  assert.equal(sidebarBadgeToneClass('ok'), 'badge-ok')
  assert.equal(sidebarBadgeToneClass('neutral'), 'badge-neutral')
  // label 与 summary 合成（summary 为空原样返回）
  assert.equal(composeSidebarBadgeLabel('Task Board', { count: 2, tone: 'warn', dot: false, summary: '2 to review' }), 'Task Board · 2 to review')
  assert.equal(composeSidebarBadgeLabel('Task Board', null), 'Task Board')
  assert.equal(composeSidebarBadgeLabel('Task Board', { count: 0, tone: 'accent', dot: true, summary: '' }), 'Task Board')
})

test('collectSidebarBadgeDocs: dedupes plugin/doc refs and skips badge-less items', { timeout: 60_000 }, () => {
  const refs = collectSidebarBadgeDocs([
    viewItem(),
    viewItem({ key: 'builtin:tasks/task-board-2' }), // 同插件同 doc：去重
    viewItem({ key: 'other/view', pluginId: 'other' }),
    viewItem({ key: 'plain/view', badge: undefined }),
  ])
  assert.deepEqual(
    refs.map((r) => `${r.pluginId}/${r.doc}`),
    ['builtin:tasks/task-board', 'other/task-board'],
  )
})

function badgeScenarioStore(overrides: { doc?: Record<string, unknown>; specBadge?: Record<string, unknown> | null } = {}): HelmxExternalStore {
  const spec: Record<string, unknown> = {}
  if (overrides.specBadge !== null) {
    spec.badge = overrides.specBadge ?? {
      doc: 'task-board',
      countField: 'attentionCount',
      toneField: 'badgeTone',
      dotField: 'hasRunning',
      summaryField: 'badgeSummary',
    }
  }
  return sidebarStore({
    plugins: [{ id: 'builtin:tasks', name: 'Tasks', version: '0.0.0', enabled: true, locked: false, hooks: [], actions: [], tools: [] }],
    conversations: [conv({ id: 50, title: '当前查看', profileId: 'coder' })],
    primaryTarget: { kind: 'screen', pluginId: 'builtin:tasks', screenId: 'board' },
    uiContributions: [sidebarItemContribution({ spec }), screenContribution()],
    pluginDocs: overrides.doc !== undefined ? { 'builtin:tasks/task-board': overrides.doc } : {},
  })
}

test('Sidebar renders sidebar.item badge on the rail quick entry and the views row with honest summary', { timeout: 60_000 }, () => {
  const html = renderSidebar(
    badgeScenarioStore({ doc: { attentionCount: 3, badgeTone: 'error', badgeSummary: '2 awaiting review · 1 needs attention' } }),
  )
  // Rail 快捷入口：计数徽标 + tone + summary 进 aria/tooltip
  const quickBtn = html.match(/<button[^>]*class="rail-btn rail-quick-btn[^"]*"[^>]*>/)?.[0] ?? ''
  assert.ok(quickBtn.includes('aria-label="Task Board · 2 awaiting review · 1 needs attention"'), `rail quick button carries the badge summary (got: ${quickBtn})`)
  assert.ok(
    html.includes('class="rail-quick-badge" data-tone="error"') && html.includes('>3</span>'),
    'the rail quick entry renders the count badge with the doc-provided tone',
  )
  // 视图行（views 空间）：紧凑语义徽标 + summary aria
  const viewBtn = html.match(/<button[^>]*class="nav-item-main nav-open"[^>]*title="Task Board[^"]*"[^>]*>/)?.[0] ?? ''
  assert.ok(viewBtn.includes('aria-label="Task Board · 2 awaiting review · 1 needs attention"'), `the views row button carries the badge summary (got: ${viewBtn})`)
  assert.ok(html.includes('badge badge-err tabular-nums sidebar-view-badge'), 'the views row renders the compact semantic badge pill')
})

test('Sidebar renders the quiet dot when the count is zero and hasRunning is true; zero noise when the badge is silent', { timeout: 60_000 }, () => {
  const dotHtml = renderSidebar(badgeScenarioStore({ doc: { attentionCount: 0, hasRunning: true, badgeTone: 'accent' } }))
  assert.ok(dotHtml.includes('class="rail-quick-dot" data-tone="accent"'), 'the rail quick entry renders the quiet dot')
  assert.ok(dotHtml.includes('class="sidebar-view-badge-dot" data-tone="accent"'), 'the views row renders the quiet dot')
  assert.ok(!dotHtml.includes('rail-quick-badge" data-tone'), 'no count badge when the count is zero')

  const silentHtml = renderSidebar(badgeScenarioStore({ doc: { attentionCount: 0, hasRunning: false } }))
  assert.ok(!silentHtml.includes('rail-quick-dot'), 'no dot when the doc is silent')
  assert.ok(!silentHtml.includes('sidebar-view-badge'), 'no badge pill when the doc is silent')
  assert.ok(!silentHtml.includes('rail-quick-badge'), 'no rail badge when the doc is silent')

  // 无 badge 声明的项：完全零徽标渲染
  const noBadgeHtml = renderSidebar(badgeScenarioStore({ specBadge: null }))
  assert.ok(!noBadgeHtml.includes('sidebar-view-badge'), 'a badge-less item renders no badge residue')
})

test('useSidebarBadges discovers and loads the badge doc itself; plugin disable zeroes the residue', { timeout: 60_000 }, async () => {
  const docUrls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    docUrls.push(url)
    return new Response(JSON.stringify({ key: 'stub', value: { attentionCount: 2, badgeTone: 'warn' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const store = badgeScenarioStore({ doc: undefined }) // doc 未预置：Hook 需自行发现并加载
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
    })
    assert.deepEqual(docUrls, ['/api/plugins/builtin%3Atasks/docs/task-board'], 'the sidebar hook loads the declared badge doc on demand')
    assert.ok(container.querySelector('.rail-quick-badge') !== null, 'the fetched doc drives the rendered badge')

    // Simulate the SSE path of a disabled plugin: contributions vanish -> badge residue zeroed.
    await act(async () => {
      store.updateLive((state) => ({ ...state, uiContributions: [] }))
    })
    assert.equal(container.querySelectorAll('.rail-quick-badge').length, 0, 'a disabled plugin leaves no phantom badge')
    assert.equal(container.querySelectorAll('.sidebar-view-badge').length, 0, 'a disabled plugin leaves no phantom view badge')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})
