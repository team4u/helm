/**
 * 全局并发态势（attention）测试：
 * - 纯函数契约：buildAttentionItems（根树聚合、三桶归属、代表位、诚实摘要、
 *   暴露边界——已归档根树/停用插件托管 Profile 不进态势、sidebarSection 接管的
 *   会话仍纳入；桶内 createdAt 倒序、updatedAt 翻动不引起跳位）、
 *   collectViewedAttentionRootIds / resolveGlobalAttentionIndicator（排除正在
 *   查看的根树、tone 优先级 error > blocked > running > done）、
 *   composeAttentionSummary（只列非零桶）；
 * - 命令面板态势优先排序：selectRecentConversationsForPalette 可选 background
 *   索引（需处理 > 运行中 > 未读完成 > 其余按 updatedAt 倒序）；
 * - Sidebar 渲染与交互：态势平铺分组挂在待审批下方、空时零占位、行内代表位
 *   单灯、点击直达树内最新 blocked 会话、折叠头部收起行、Rail「对话空间」按钮
 *   同源态势微标与 aria 摘要；
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
import type { ConversationSummary, PluginUiContribution, ScreenSpec, SidebarItemSpec, WorkbenchPanelSpec } from '@helmx/protocol'
import { ARCHIVED_TAG } from '../src/shell/sidebar-model.js'
import type { ConversationBackgroundIndex } from '../src/shell/background-activity-model.js'
import {
  buildAttentionItems,
  buildAttentionModel,
  collectViewedConversationIds,
  composeAttentionSummary,
  resolveGlobalAttentionIndicator,
  type AttentionTreeItem,
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

/** 无翻译器调用（英文桥接）时的构建捷径。 */
function buildItems(
  conversations: ConversationSummary[],
  background: ConversationBackgroundIndex = new Map(),
  overrides: {
    profiles?: Array<{ id: string; name?: string; managedByPlugin?: string }>
    plugins?: Array<{ id: string; enabled: boolean }>
    viewedConversationIds?: ReadonlySet<number>
  } = {},
): AttentionTreeItem[] {
  return buildAttentionItems({
    conversations,
    background,
    profiles: overrides.profiles ?? [],
    plugins: overrides.plugins ?? [],
    ...(overrides.viewedConversationIds !== undefined ? { viewedConversationIds: overrides.viewedConversationIds } : {}),
  })
}

/** 无翻译器调用（英文桥接）时的成对模型构建捷径。 */
function buildModel(
  conversations: ConversationSummary[],
  viewedConversationIds: ReadonlySet<number>,
  background: ConversationBackgroundIndex = new Map(),
) {
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

test('bucket assignment: blocked/pendingAsk/error trees need attention; working/background trees run; done+unread root is unread_done; silent trees are absent', { timeout: 60_000 }, () => {
  const items = buildItems([
    conv({ id: 1, status: 'blocked' }),
    conv({ id: 2, status: 'error', lastError: 'model_error: boom' }),
    conv({ id: 3, status: 'working' }),
    conv({ id: 4, status: 'done', unread: true }),
    conv({ id: 5, status: 'idle' }),
    conv({ id: 6, status: 'done', unread: false }),
  ])
  assert.deepEqual(
    items.map((item) => [item.root.id, item.bucket]),
    [
      [2, 'needs_attention'],
      [1, 'needs_attention'],
      [3, 'running'],
      [4, 'unread_done'],
    ],
    'bucket order needs_attention > running > unread_done; idle and read-done trees never appear',
  )
  assert.deepEqual(
    items.map((item) => item.tone),
    ['error', 'blocked', 'running', 'done'],
    'tone maps the bucket with error outranking blocked inside needs_attention',
  )
})

test('tree aggregation: descendants roll up to the root tree; pendingAskCount counts as waiting; working child outranks the unread-done root', { timeout: 60_000 }, () => {
  const items = buildItems([
    conv({ id: 1, status: 'done', unread: true, createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 11, parentConversationId: 1, status: 'blocked', updatedAt: 9100 }),
    conv({ id: 12, parentConversationId: 11, status: 'idle' }),
    conv({ id: 2, status: 'idle', createdAt: 8000 }),
    conv({ id: 21, parentConversationId: 2, pendingAskCount: 1, status: 'idle' }),
  ])
  assert.equal(items.length, 2, 'both roots keep exactly one aggregated item each')
  const first = items[0]!
  assert.equal(first.root.id, 1)
  assert.equal(first.bucket, 'needs_attention', 'a blocked descendant needs attention even under an unread-done root')
  assert.equal(first.representative.id, 11, 'the representative is the highest-priority member (blocked outranks done)')
  assert.equal(first.targetConversationId, 11, 'click jumps straight to the blocked descendant (the approval spot)')
  assert.equal(first.activeDescendantCount, 1, 'the blocked descendant counts; idle ones do not')
  const second = items[1]!
  assert.equal(second.bucket, 'needs_attention', 'pendingAskCount > 0 counts as waiting for human')
  assert.equal(second.targetConversationId, 21, 'the pending-ask member is the direct target')
})

test('exposure boundaries: archived roots and disabled-plugin-managed profiles stay out; sidebarSection-tagged active conversations stay in', { timeout: 60_000 }, () => {
  const archived = buildItems([
    conv({ id: 1, tags: [ARCHIVED_TAG], status: 'working' }),
    conv({ id: 11, parentConversationId: 1, status: 'blocked' }),
  ])
  assert.equal(archived.length, 0, 'an archived root tree never enters attention even with active descendants')

  const hiddenByPlugin = buildItems(
    [conv({ id: 2, status: 'working' })],
    new Map(),
    {
      profiles: [{ id: 'assistant', name: '个人助理', managedByPlugin: 'builtin:off' }],
      plugins: [{ id: 'builtin:off', enabled: false }],
    },
  )
  assert.equal(hiddenByPlugin.length, 0, 'a profile hidden behind a disabled plugin hides its tree')

  const shownByPlugin = buildItems(
    [conv({ id: 3, status: 'working' })],
    new Map(),
    {
      profiles: [{ id: 'assistant', name: '个人助理', managedByPlugin: 'builtin:on' }],
      plugins: [{ id: 'builtin:on', enabled: true }],
    },
  )
  assert.equal(shownByPlugin[0]?.profileLabel, '个人助理', 'an enabled managed profile keeps its tree with the profile display name')

  const sectionTagged = buildItems([conv({ id: 4, tags: ['task'], status: 'working' })])
  assert.equal(sectionTagged.length, 1, 'conversations taken over by sidebar sections still surface in attention')

  const orphanProfile = buildItems([conv({ id: 5, status: 'working', profileId: 'ghost' })], new Map(), {
    profiles: [{ id: 'assistant', name: '个人助理' }],
  })
  assert.equal(orphanProfile[0]?.profileLabel, 'ghost', 'an unknown profile falls back to the raw profileId, never fabricated')
})

test('ordering: buckets first, then root.createdAt descending; updatedAt churn never reorders rows', { timeout: 60_000 }, () => {
  const base = [
    conv({ id: 1, status: 'working', createdAt: 1000, updatedAt: 1000 }),
    conv({ id: 2, status: 'working', createdAt: 2000, updatedAt: 2000 }),
    conv({ id: 3, status: 'blocked', createdAt: 3000, updatedAt: 3000 }),
  ]
  const before = buildItems(base).map((item) => item.root.id)
  const churned = buildItems(base.map((c) => (c.id === 1 ? { ...c, updatedAt: 99999 } : c))).map((item) => item.root.id)
  assert.deepEqual(before, [3, 2, 1], 'needs_attention bucket precedes running; within a bucket createdAt descending')
  assert.deepEqual(churned, before, 'updatedAt churn (streaming output) must never jump rows')
})

test('honest summaries: lastError / doing / background summary / descendant count, in that priority; nothing is fabricated', { timeout: 60_000 }, () => {
  const errorTree = buildItems([conv({ id: 1, status: 'error', lastError: 'model_error: boom' })])
  assert.equal(errorTree[0]?.summaryText, 'model_error: boom')

  const workingTree = buildItems([conv({ id: 2, status: 'working', doing: '正在重构解析器' })])
  assert.equal(workingTree[0]?.summaryText, '正在重构解析器')

  const background = new Map([[3, { active: true, summary: '2 Running' }]] as const)
  const backgroundTree = buildItems([conv({ id: 3, status: 'idle' })], background)
  assert.equal(backgroundTree[0]?.bucket, 'running')
  assert.equal(backgroundTree[0]?.backgroundActive, true)
  assert.equal(backgroundTree[0]?.backgroundSummary, '2 Running')
  assert.equal(backgroundTree[0]?.summaryText, '2 Running', 'an idle tree with background work honestly surfaces the badge footer')

  const silentActiveTree = buildItems([
    conv({ id: 4, status: 'idle', createdAt: 9000 }),
    conv({ id: 41, parentConversationId: 4, status: 'working', createdAt: 9100, updatedAt: 9100 }),
  ])
  assert.equal(silentActiveTree[0]?.summaryText, '1 sub-conversations active', 'a working descendant with no doing text falls back to the honest descendant count')

  const unreadTree = buildItems([conv({ id: 5, status: 'done', unread: true })])
  assert.equal(unreadTree[0]?.summaryText, '', 'an unread completion fabricates no progress text')
})

test('representative and target selection are deterministic on recency ties', { timeout: 60_000 }, () => {
  const items = buildItems([
    conv({ id: 1, status: 'idle', createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 11, parentConversationId: 1, status: 'blocked', createdAt: 9100, updatedAt: 9500 }),
    conv({ id: 12, parentConversationId: 1, status: 'blocked', createdAt: 9200, updatedAt: 9500 }),
  ])
  const item = items[0]!
  assert.equal(item.representative.id, 12, 'equal updatedAt keeps the higher id (deterministic)')
  assert.equal(item.targetConversationId, 12, 'the most recently updated blocked conversation is the direct jump target')
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
  const items = buildItems([
    conv({ id: 1, status: 'error' }),
    conv({ id: 2, status: 'blocked' }),
    conv({ id: 3, status: 'working' }),
    conv({ id: 4, status: 'done', unread: true }),
  ])
  const full = resolveGlobalAttentionIndicator(items)
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
  const siblingWaiting = buildModel(conversations, new Set([11]))
  assert.equal(siblingWaiting.items.length, 1, 'the flat item still renders (display is never excluded)')
  assert.equal(siblingWaiting.indicator.needsAttentionCount, 1, 'the sibling blocked ask keeps the badge counting')
  assert.equal(siblingWaiting.indicator.tone, 'blocked')
  // Viewing the only waiting member: the tree's whole signal sits on the viewed conversation -> silent.
  const allViewed = buildModel(conversations, new Set([11, 12]))
  assert.equal(allViewed.indicator.totalCount, 0, 'no self-alerting when every signal is on the viewed conversation')
  assert.equal(allViewed.indicator.tone, null)
  // Viewed root with an un-viewed working child: the running fact still counts.
  const rootViewed = buildModel(
    [
      conv({ id: 2, status: 'idle', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 21, parentConversationId: 2, status: 'working', createdAt: 8100, updatedAt: 8100 }),
    ],
    new Set([2]),
  )
  assert.equal(rootViewed.indicator.runningCount, 1, 'viewing the root does not erase the running descendant')
  // Viewed unread-done root: read-on-view honestly silences only that tree.
  const unreadRoot = buildModel([conv({ id: 3, status: 'done', unread: true })], new Set([3]))
  assert.equal(unreadRoot.indicator.totalCount, 0, 'viewing the unread completion drops it from the badge')
  assert.equal(unreadRoot.items.length, 1, 'but the flat item still renders until marked read')
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
// Sidebar 渲染：态势平铺分组与 Rail 微标
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

test('Sidebar renders the attention group between the pending asks panel and agent standings, with honest rows', { timeout: 60_000 }, () => {
  const html = renderSidebar(attentionScenarioStore())
  const groupIdx = html.indexOf('sidebar-attention-group')
  const asksIdx = html.indexOf('pending-asks-group')
  const standingsIdx = html.indexOf('agent-standing-group')
  assert.ok(groupIdx > 0, 'the attention group renders')
  assert.ok(asksIdx === -1 || asksIdx < groupIdx, 'attention mounts below the pending asks panel (which is absent when empty)')
  assert.ok(standingsIdx > groupIdx, 'attention mounts above the agent standings group')

  assert.ok(html.includes('>Attention</span>'), 'the bilingual group title renders (en default)')
  const rows = html.match(/class="nav-item nav-item-sub attention-row/g) ?? []
  assert.equal(rows.length, 2, 'one row per root tree: the error tree and the running tree')
  assert.ok(html.includes('class="status-dot status-dot-error"'), 'the error tree row carries the representative error light')
  assert.ok(html.includes('class="status-dot status-dot-working"'), 'the running tree row carries the working light')
  assert.ok(html.includes('个人助理 · model_error: boom'), 'the sub-line states the profile label plus the real lastError, never fabricated progress')
  assert.ok(html.includes('编码专员 · 正在检索文档'), 'the running row sub-line states the real doing text')
  assert.ok(html.includes('title="Open conversation 12"'), 'the error tree row jumps straight to the newest blocked descendant (the approval spot)')

  // Rail badge：与移动端汉堡同源 indicator（排除正在查看的 50 号树——本就无信号）。
  assert.ok(
    html.includes('class="rail-attention-badge" data-tone="error"') || html.includes('rail-attention-badge'),
    'the conversations-space rail button carries the same-source attention badge',
  )
  assert.ok(
    html.includes('aria-label="Conversations space · 1 need attention · 1 running"'),
    'the rail button aria-label appends the honest attention summary',
  )
})

test('Sidebar renders no attention group and no badge when nothing needs attention', { timeout: 60_000 }, () => {
  const html = renderSidebar(
    sidebarStore({
      conversations: [
        conv({ id: 50, title: '当前查看', profileId: 'coder', status: 'idle' }),
        conv({ id: 51, title: '安静', profileId: 'coder', status: 'done', unread: false }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
    }),
  )
  assert.ok(!html.includes('sidebar-attention-group'), 'zero visual residue when no tree qualifies')
  assert.ok(!html.includes('rail-attention-badge'), 'no badge when the indicator is silent')
})

test('interaction: clicking an attention row opens the direct target; the header collapses the rows', { timeout: 60_000 }, async () => {
  const store = attentionScenarioStore()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
    })
    const row = container.querySelectorAll('.attention-row')[0]
    assert.ok(row !== undefined, 'two rows render')
    await act(async () => {
      row.querySelector<HTMLButtonElement>('.nav-item-main')?.click()
    })
    const primary = store.getPrimaryTarget()
    assert.ok(
      primary.kind === 'conversation' && primary.conversationId === 12,
      'clicking the error tree jumps straight to the newest blocked descendant (the approval spot)',
    )
    const header = container.querySelector<HTMLButtonElement>('.sidebar-attention-group .sidebar-group-header-toggle')
    assert.ok(header !== null, 'the collapsible header renders')
    assert.ok(header.getAttribute('aria-expanded') === 'true', 'expanded by default')
    await act(async () => {
      header.click()
    })
    assert.equal(container.querySelectorAll('.attention-row').length, 0, 'collapsing hides the rows')
    assert.ok(header.getAttribute('aria-expanded') === 'false', 'aria-expanded flips honestly')
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
// 移动端抽屉：任何空间都能看到态势平铺区（拉开汉堡即可一键行动）
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

test('mobile drawer shows the attention group in every space; desktop non-conversation spaces stay clean', { timeout: 60_000 }, () => {
  const htmlByViewport = (mobile: boolean): string => {
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
  assert.ok(htmlByViewport(true).includes('sidebar-attention-group'), 'mobile: pulling the drawer open in the views space still shows the attention group')
  assert.ok(!htmlByViewport(false).includes('sidebar-attention-group'), 'desktop: the views space stays clean (rail badge carries the signal)')
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
